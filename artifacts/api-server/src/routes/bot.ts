import { Router } from "express";
import { createHash, createHmac, randomUUID } from "crypto";
import type { Request, Response } from "express";
import { getBotConfig, getOverrideHistory, setConfigOverrides, resetConfigOverrides } from "../lib/botConfig";
import {
  BOT_MODES, type BotModeId, type BulkOrderItem, type BulkOrderResult, type BulkExecutionSummary,
  TokenBucket, setActiveModeId, getActiveModeId, getActiveModePreset, clearActiveMode,
} from "../lib/botModes";
import { exportAllOutcomes, getEngine, getTelemetryStats } from "../lib/telemetryStore";
import { AdaptiveEngine, type BtcRegime, type ClusterKey, type PositionSide, type TradeOutcome } from "../lib/adaptiveEngine";
import { computeAllCandleEdges, computeCandleEdge, type CandleEdge, type CandleInterval } from "../lib/candleEdge";
import { estimateExecutionCosts, feeDragRejectReason, maxCorrelatedBulkOrders } from "../lib/executionRisk";
import {
  getQuantBrainIntelligence,
  evaluateQuantBrainEdge,
  getCurrentQuantBrainDriftPolicy,
  getQuantBrainQueueStats,
  quantBrainGateMode,
  type QuantBrainEdgeInput,
  type QuantBrainEdgeResult,
  type QuantBrainIntelligence,
} from "../lib/quantBrainClient";
import { recordPredictionExecutionAge } from "../lib/runtimeMetrics";
import { getMarketSentiment, getMarketSentimentBulk, type SentimentResult } from "../lib/sentimentEngine";
import {
  buildAttachedProtection,
  candleConfirmationRejects,
  recentPerformanceRejects,
  summarizeRecentPerformance,
} from "../lib/entryProtection";
import {
  registerLiveEntry,
  updateWatcherCreds,
  getLiveWatcherStats,
} from "../lib/livePositionWatcher";
import {
  assertLiveExecutionAllowed,
  endpointForCredentials,
  requireAdminAuthorization,
  type ExecutionCredentials,
} from "../lib/executionSecurity";
import {
  claimMarketEventExecution,
  getMarketDataQualityStatus,
  releaseMarketEventExecution,
} from "../lib/marketDataQuality";
import {
  buildSymbolRotationReport,
  rotationRankBySymbol,
  type SymbolOpenCounts,
} from "../lib/symbolRotation";
import {
  calculatePositionSizing,
  getPositionSizingConfig,
  recentSizingStats,
  summarizeSizingStatus,
  type PositionSizingDecision,
  type PositionSizingOpenPosition,
  type PositionRiskTier,
} from "../lib/positionSizing";
import { getServiceState } from "../lib/serviceState";
import { buildTelemetryState } from "./telemetry";
import {
  applyAggressionToConfig,
  evaluateAggression,
  getAggressionStatus,
  recordAggressionCycleImpact,
  type AggressionCandidate,
} from "../lib/aggressionController";
import {
  applyKillSwitchToConfig,
  evaluateKillSwitch,
  recordKillSwitchExecutionAttempt,
  type KillSwitchDecision,
} from "../lib/killSwitch";
import {
  buildLiveReadinessStatus,
  evaluateLiveReadinessForOrder,
  type LiveReadinessStatus,
  type PromotionState,
} from "../lib/live_readiness";
import { loadClosedTrades } from "../lib/demoTradeStore";
import { getPolicyStatus } from "../lib/policyManifest";
import { armLimitOrderExpiry } from "../lib/exhaustionTriggerManager";

const router = Router();

const BINGX_BASE = "https://open-api.bingx.com";

type ProtectionBuildResult = {
  orderParams: Record<string, string | number>;
  protectionAttached: boolean;
  riskMode: "TP_SL_PROTECTED" | "UNPROTECTED_HIGH_RISK";
  protectionStopPrice?: number;
  protectionTakeProfitPrice?: number;
};

function withEntryProtection(
  orderParams: Record<string, string | number>,
  referencePrice: number,
  positionSide: "LONG" | "SHORT",
  config: ReturnType<typeof getBotConfig>,
): ProtectionBuildResult {
  const protection = buildAttachedProtection(referencePrice, positionSide, config);
  if (!protection) {
    return {
      orderParams,
      protectionAttached: false,
      riskMode: "UNPROTECTED_HIGH_RISK",
    };
  }

  return {
    orderParams: {
      ...orderParams,
      stopLoss: protection.stopLoss,
      takeProfit: protection.takeProfit,
    },
    protectionAttached: true,
    riskMode: "TP_SL_PROTECTED",
    protectionStopPrice: protection.stopPrice,
    protectionTakeProfitPrice: protection.takeProfitPrice,
  };
}

function driftAdjustedStackLimit(config: ReturnType<typeof getBotConfig>): number {
  const base = config.positionStackingEnabled ? config.maxPositionsPerSymbol : 1;
  const policy = getCurrentQuantBrainDriftPolicy();
  if (!policy.newEntriesAllowed) return 0;
  if (policy.stackingMultiplier <= 0) return 1;
  return Math.max(1, Math.floor(base * policy.stackingMultiplier));
}

function openCountsBySymbolFromCapital(capitalCtx: CapitalContext | null | undefined): Map<string, SymbolOpenCounts> {
  const counts = new Map<string, SymbolOpenCounts>();
  if (!capitalCtx) return counts;
  for (const [symbol, bySide] of capitalCtx.countsBySide.entries()) {
    counts.set(symbol.toUpperCase(), { LONG: bySide.LONG, SHORT: bySide.SHORT });
  }
  return counts;
}

function liveEntryPolicyProvenance() {
  const policy = getPolicyStatus();
  return {
    configVersion: policy.currentConfigHash,
    policyVersion: policy.activePolicyVersion,
    strategyVersion: policy.effectiveSnapshot.strategyVersion,
    scoreCalibrationVersion: policy.effectiveSnapshot.scoreCalibrationVersion,
    sizingPolicyVersion: policy.effectiveSnapshot.sizingPolicyVersion,
    rotationPolicyVersion: policy.effectiveSnapshot.rotationPolicyVersion,
    playbookVersion: policy.effectiveSnapshot.playbookVersion,
    modelVersion: policy.quantBrain.modelVersion ?? undefined,
    labelVersion: policy.quantBrain.labelVersion ?? "live-outcome-v1",
  };
}

let readinessCache: {
  key: string;
  expiresAt: number;
  status: LiveReadinessStatus;
} | null = null;

async function getCachedLiveReadinessStatus(config: ReturnType<typeof getBotConfig>): Promise<LiveReadinessStatus> {
  const key = getPolicyStatus().currentConfigHash;
  const now = Date.now();
  if (readinessCache && readinessCache.key === key && readinessCache.expiresAt > now) {
    return readinessCache.status;
  }
  const status = buildLiveReadinessStatus({
    outcomes: exportAllOutcomes(),
    closedDemoTrades: await loadClosedTrades(5_000),
    config,
  });
  readinessCache = {
    key,
    expiresAt: now + Math.max(1_000, Number(process.env["LIVE_READINESS_CACHE_TTL_MS"] ?? 5_000)),
    status,
  };
  return status;
}

function evaluateLiveKillSwitch(input: {
  config: ReturnType<typeof getBotConfig>;
  btcRegime?: BtcRegime | "HIGH_VOLATILITY_CHAOS" | "LOW_LIQUIDITY" | "NEUTRAL";
  btcChangePct?: number;
  capitalCtx?: CapitalContext | null;
  maxSessionLossRemaining?: number | null;
  dataFresh?: boolean;
  integrityOk?: boolean;
  scoreCalibrationHealthy?: boolean;
  symbolRotationHealthy?: boolean;
}): KillSwitchDecision {
  const quality = getMarketDataQualityStatus();
  const watcher = getLiveWatcherStats();
  const lastClosedAt = watcher.lastClosedAt ?? 0;
  return evaluateKillSwitch({
    outcomes: exportAllOutcomes().filter((outcome) => !isDemoOutcome(outcome)),
    config: input.config,
    serviceState: getServiceState(),
    marketRegime: input.btcRegime,
    btcChangePct: input.btcChangePct,
    dataQuality: {
      stale: quality.metrics.stale,
      invalid: quality.metrics.invalid,
      missing: quality.metrics.missing,
      duplicates: quality.metrics.duplicates,
      incidents: quality.incidents,
      activeExecutionClaims: quality.activeExecutionClaims,
    },
    pipeline: {
      dataFresh: input.dataFresh ?? true,
      integrityOk: input.integrityOk ?? true,
      scoreCalibrationHealthy: input.scoreCalibrationHealthy,
      symbolRotationHealthy: input.symbolRotationHealthy,
      openPositionRisk: input.capitalCtx?.marginUtilization,
      exitMonitorDelayMs: lastClosedAt > 0 ? Math.max(0, Date.now() - lastClosedAt) : 0,
    },
    openPositionsCount: input.capitalCtx?.openPositionsCount,
    maxOpenPositions: input.config.maxConcurrentPositions,
    maxSessionLossRemaining: input.maxSessionLossRemaining,
  });
}

function killSwitchReject(
  item: Pick<BulkOrderItem, "symbol" | "side">,
  index: number,
  decision: KillSwitchDecision,
  startedAt: number,
): BulkOrderResult {
  return {
    index,
    symbol: item.symbol,
    side: item.side,
    placed: false,
    orderId: null,
    quantity: null,
    gateRejects: [`KILL_SWITCH_${decision.state}: ${decision.reason}`],
    observationMode: false,
    message: `Kill switch blocks new entries: ${decision.recommendedAction}`,
    durationMs: Date.now() - startedAt,
  };
}

router.get("/bot/market-data-quality", (_req: Request, res: Response) => {
  res.json(getMarketDataQualityStatus());
});

router.get("/market-data/integrity", (_req: Request, res: Response) => {
  const quality = getMarketDataQualityStatus();
  const incidents = quality.incidents.slice(-100);
  res.json({
    staleSymbols: incidents.filter((incident) => incident.type === "STALE").map((incident) => incident.symbol),
    invalidCandles: incidents.filter((incident) => incident.type === "INVALID_VALUE" || incident.type === "TIMESTAMP_VIOLATION"),
    incompleteCandlesRejected: quality.metrics.incomplete,
    dataAgeMsBySource: {
      backendCandleQuality: null,
      quantBrainSnapshot: null,
    },
    spreadAnomalies: incidents.filter((incident) => /spread/i.test(incident.detail ?? "")),
    duplicateMarketEvents: {
      duplicateCandles: quality.metrics.duplicates,
      duplicateExecutions: quality.metrics.duplicateExecutions,
      activeExecutionClaims: quality.activeExecutionClaims,
      activeExecutionClaimKeys: quality.activeExecutionClaimKeys,
    },
    canonicalSnapshotAvailable: false,
    recommendedActions: [
      ...(quality.metrics.stale > 0 ? ["Investigate stale candle sources before enabling live entries."] : []),
      ...(quality.metrics.incomplete > 0 ? ["Keep INCOMPLETE_CANDLE_REJECT enforced for live candidates."] : []),
      ...(quality.activeExecutionClaims > 0 ? ["Run exchange reconciliation before clearing active execution claims."] : []),
      "Use Quant Brain /market/snapshots as the canonical bid/ask/spread source until backend snapshots are implemented.",
    ],
  });
});

router.get("/sniper/signal-freshness/status", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const creds = getCredentials(req);
  const [capitalCtx, sentiment, closedDemoTrades] = await Promise.all([
    creds ? fetchCapitalContext(creds).catch(() => null) : Promise.resolve(null),
    config.allowedSymbols[0] ? getMarketSentiment(config.allowedSymbols[0]).catch(() => null) : Promise.resolve(null),
    loadClosedTrades(5_000).catch(() => []),
  ]);
  const readiness = buildLiveReadinessStatus({
    outcomes: exportAllOutcomes(),
    closedDemoTrades,
    config,
  });
  const watcher = getLiveWatcherStats();
  const policy = getPolicyStatus();
  const now = Date.now();
  res.json({
    blockedLiveCandidates: getMarketDataQualityStatus().metrics.duplicateExecutions,
    btcRegimeAgeMs: null,
    sentimentAgeMs: sentiment ? 0 : null,
    scoreCalibrationAgeMs: null,
    playbookAgeMs: null,
    rotationReportAgeMs: null,
    capitalContextAgeMs: capitalCtx ? 0 : null,
    backendQuantSnapshotDelta: null,
    priceDriftScanToOrder: null,
    watcherLagMs: watcher.lastPollAt ? now - watcher.lastPollAt : null,
    activeExecutionClaims: getMarketDataQualityStatus().activeExecutionClaims,
    readinessGeneratedAt: readiness.generatedAt,
    currentConfigHash: policy.currentConfigHash,
    freshnessGaps: [
      "btcRegimeTimestamp is not persisted on live candidates yet.",
      "backend canonical market snapshot is not implemented; use Quant Brain /market/snapshots for canonical freshness.",
      "score/playbook/rotation age is inferred from current status, not persisted per candidate.",
    ],
    recommendedActions: [
      "Persist btcRegimeTimestamp, scoreCalibrationTimestamp, playbookTimestamp and scanPrice on every candidate snapshot.",
      "Block live entries when watcherLagMs exceeds three poll intervals.",
      "Compare scan referencePrice against order-time mark price before POSTing a live order.",
    ],
  });
});

router.get("/position-sizing/status", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const creds = getCredentials(req);
  const capitalCtx = creds ? await fetchCapitalContext(creds).catch(() => null) : null;
  const outcomes = exportAllOutcomes();
  const fallbackEquity = config.marginPerTrade / 0.005;
  res.json(summarizeSizingStatus({
    equity: capitalCtx?.equity ?? fallbackEquity,
    outcomes,
    openPositions: capitalPositionsForSizing(capitalCtx),
    config,
  }));
});

router.get("/aggression/status", (_req: Request, res: Response) => {
  res.json(getAggressionStatus());
});

router.get("/symbol-rotation/status", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const symbols = config.allowedSymbols.length > 0 ? config.allowedSymbols : [];
  if (symbols.length === 0) {
    res.json({
      generatedAt: Date.now(),
      activeSymbols: [],
      reducedSymbols: [],
      pausedSymbols: [],
      hotSymbols: [],
      recoverySymbols: [],
      ranking: [],
    });
    return;
  }

  const btcChangePct = req.query.btcChangePct !== undefined
    ? parseFloat(String(req.query.btcChangePct))
    : 0;
  const btcRegime: BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";
  const creds = getCredentials(req);
  const capitalCtx = creds
    ? await fetchCapitalContext(creds).catch(() => null)
    : null;

  const report = await buildSymbolRotationReport({
    symbols,
    engine: getEngine(),
    config,
    btcRegime,
    hourUtc: new Date().getUTCHours(),
    openCountsBySymbol: openCountsBySymbolFromCapital(capitalCtx),
  });

  res.json(report);
});

type TelemetrySourceFilter = "all" | "demo" | "live";

function normalizeTelemetrySource(value: unknown): TelemetrySourceFilter {
  const raw = String(value ?? "all").trim().toLowerCase();
  return raw === "demo" || raw === "live" ? raw : "all";
}

function isDemoOutcome(outcome: TradeOutcome): boolean {
  return outcome.isDemo === true || outcome.source === "bingx-vst";
}

function getTelemetryEngineForSource(source: TelemetrySourceFilter): AdaptiveEngine {
  if (source === "all") return getEngine();
  const outcomes = exportAllOutcomes().filter((outcome) => (
    source === "demo" ? isDemoOutcome(outcome) : !isDemoOutcome(outcome)
  ));
  const engine = new AdaptiveEngine(outcomes);
  engine.stopAutoSave();
  return engine;
}

function sign(params: Record<string, string | number | undefined>, secretKey: string): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secretKey).update(query).digest("hex");
}

function deterministicClientOrderId(input: {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  side: "BUY" | "SELL";
  marketEventId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.symbol.toUpperCase()}|${input.positionSide}|${input.side}|${input.marketEventId}`)
    .digest("hex")
    .slice(0, 24);
  return `sniper_${digest}`;
}

const BINGX_REQUEST_TIMEOUT_MS = Number(process.env["BINGX_REQUEST_TIMEOUT_MS"] ?? 8_000);

async function bingxPost(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-BX-APIKEY": apiKey },
    signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function bingxGet(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    headers: { "X-BX-APIKEY": apiKey },
    signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

function getCredentials(req: Request): ExecutionCredentials | null {
  const credentials = req.session.liveCredentials;
  if (!credentials) return null;
  endpointForCredentials(credentials, "live");
  return credentials;
}

// ── Capital Context — shared across bulk/autopilot cycles ─────────────────────
// Pre-fetch once per cycle to avoid N×2 BingX calls in mass execution paths.

interface CapitalContext {
  openPositions: Record<string, unknown>[];
  openPositionsCount: number;
  marginUtilization: number;
  equity: number;
  usedMargin: number;
  availableMargin: number;
  // counts[symbol][side] = number of open positions on that side
  countsBySide: Map<string, { LONG: number; SHORT: number }>;
  fetchedAt: number;
}

async function fetchCapitalContext(
  creds: { apiKey: string; secretKey: string },
): Promise<CapitalContext> {
  const [posData, balData] = await Promise.all([
    bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey).catch(() => null),
    bingxGet("/openApi/swap/v2/user/balance", {}, creds.apiKey, creds.secretKey).catch(() => null),
  ]);

  let openPositions: Record<string, unknown>[] = [];
  let equity = 1;
  let usedMargin = 0;
  let availableMargin = 0;

  if (posData?.code === 0) {
    openPositions = ((posData.data as unknown[]) ?? []) as Record<string, unknown>[];
    openPositions = openPositions.filter((p) => parseFloat(String(p.positionAmt ?? "0")) !== 0);
  }
  if (balData?.code === 0) {
    const bal = ((balData.data as Record<string, unknown>)?.balance ?? {}) as Record<string, string>;
    usedMargin = parseFloat(bal.usedMargin ?? "0");
    equity = parseFloat(bal.equity ?? "1") || 1;
    availableMargin = parseFloat(bal.availableMargin ?? bal.availableBalance ?? "0") || Math.max(0, equity - usedMargin);
  }

  const countsBySide = new Map<string, { LONG: number; SHORT: number }>();
  for (const p of openPositions) {
    const sym = String(p.symbol ?? "").toUpperCase();
    const side = String(p.positionSide ?? "").toUpperCase() as "LONG" | "SHORT";
    if (!countsBySide.has(sym)) countsBySide.set(sym, { LONG: 0, SHORT: 0 });
    const entry = countsBySide.get(sym)!;
    if (side === "LONG") entry.LONG++;
    else if (side === "SHORT") entry.SHORT++;
  }

  return {
    openPositions,
    openPositionsCount: openPositions.length,
    marginUtilization: equity > 0 ? usedMargin / equity : 0,
    equity,
    usedMargin,
    availableMargin,
    countsBySide,
    fetchedAt: Date.now(),
  };
}

function capitalPositionsForSizing(capitalCtx: CapitalContext | null | undefined): PositionSizingOpenPosition[] {
  if (!capitalCtx) return [];
  return capitalCtx.openPositions.map((position) => {
    const symbol = String(position.symbol ?? "").toUpperCase();
    const entryPrice = Math.abs(parseFloat(String(position.avgPrice ?? position.entryPrice ?? "0")));
    const qty = Math.abs(parseFloat(String(position.positionAmt ?? "0")));
    const leverage = Math.max(1, parseFloat(String(position.leverage ?? "1")) || 1);
    const reportedMargin = Math.abs(parseFloat(String(position.initialMargin ?? position.margin ?? "0")));
    const marginUsed = reportedMargin > 0 ? reportedMargin : entryPrice > 0 ? (entryPrice * qty) / leverage : 0;
    const rawSide = String(position.positionSide ?? "").toUpperCase();
    const positionSide: "LONG" | "SHORT" | undefined =
      rawSide === "LONG" || rawSide === "SHORT" ? rawSide : undefined;
    return {
      symbol,
      positionSide,
      marginUsed,
      leverage,
    };
  }).filter((position) => position.symbol && position.marginUsed > 0);
}

function riskEnvNum(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function portfolioRiskRejectsForOrder(input: {
  ctx: CapitalContext;
  config: ReturnType<typeof getBotConfig>;
  symbol: string;
  positionSide: PositionSide;
  margin: number;
  leverage: number;
  playbook?: string;
  btcChangePct?: number;
  sizing?: PositionSizingDecision;
}): string[] {
  const { ctx, config, symbol, positionSide, margin, leverage, sizing } = input;
  const equity = Math.max(0, ctx.equity);
  const stopLossPct = Math.max(0.01, config.stopLossPct);
  const newRisk = sizing?.maxLossIfStop ?? margin * leverage * (stopLossPct / 100);
  const newNotional = sizing?.notional ?? margin * leverage;
  const positions = capitalPositionsForSizing(ctx);
  const openRisk = positions.reduce((sum, pos) => sum + pos.marginUsed * pos.leverage * (stopLossPct / 100), 0);
  const openNotional = positions.reduce((sum, pos) => sum + pos.marginUsed * pos.leverage, 0);
  const symbolRisk = positions
    .filter((pos) => pos.symbol.toUpperCase() === symbol.toUpperCase())
    .reduce((sum, pos) => sum + pos.marginUsed * pos.leverage * (stopLossPct / 100), 0) + newRisk;
  const sideRisk = positions
    .filter((pos) => pos.positionSide === positionSide)
    .reduce((sum, pos) => sum + pos.marginUsed * pos.leverage * (stopLossPct / 100), 0) + newRisk;
  const sizingCfg = getPositionSizingConfig(config);
  const maxTotalRiskPct = riskEnvNum("MAX_TOTAL_RISK_PCT", sizingCfg.maxTotalRiskPct);
  const maxSymbolRiskPct = riskEnvNum("MAX_SYMBOL_RISK_PCT", sizingCfg.maxSymbolRiskPct);
  const maxSideRiskPct = riskEnvNum("MAX_SIDE_RISK_PCT", maxTotalRiskPct * 0.75);
  const maxTotalNotionalPct = riskEnvNum("MAX_TOTAL_NOTIONAL_PCT", config.maxMarginUtilization * config.leverage);
  const minFreeMarginAfterOrder = riskEnvNum("MIN_FREE_MARGIN_AFTER_ORDER", Math.max(config.marginPerTrade, equity * 0.02));
  const rejects: string[] = [];

  if (equity <= 0) rejects.push("PORTFOLIO_RISK_REJECT: equity unavailable");
  if (equity > 0 && (openRisk + newRisk) / equity > maxTotalRiskPct) {
    rejects.push(`PORTFOLIO_TOTAL_RISK_REJECT: riskIfStop ${(((openRisk + newRisk) / equity) * 100).toFixed(2)}% > ${(maxTotalRiskPct * 100).toFixed(2)}%`);
  }
  if (equity > 0 && symbolRisk / equity > maxSymbolRiskPct) {
    rejects.push(`PORTFOLIO_SYMBOL_RISK_REJECT: ${symbol} risk ${(symbolRisk / equity * 100).toFixed(2)}% > ${(maxSymbolRiskPct * 100).toFixed(2)}%`);
  }
  if (equity > 0 && sideRisk / equity > maxSideRiskPct) {
    rejects.push(`PORTFOLIO_SIDE_RISK_REJECT: ${positionSide} risk ${(sideRisk / equity * 100).toFixed(2)}% > ${(maxSideRiskPct * 100).toFixed(2)}%`);
  }
  if (equity > 0 && (openNotional + newNotional) / equity > maxTotalNotionalPct) {
    rejects.push(`PORTFOLIO_NOTIONAL_REJECT: notional/equity ${(((openNotional + newNotional) / equity) * 100).toFixed(1)}% > ${(maxTotalNotionalPct * 100).toFixed(1)}%`);
  }
  if (ctx.availableMargin - margin < minFreeMarginAfterOrder) {
    rejects.push(`PORTFOLIO_FREE_MARGIN_REJECT: freeMarginAfter ${(ctx.availableMargin - margin).toFixed(4)} < ${minFreeMarginAfterOrder.toFixed(4)}`);
  }
  return rejects;
}

function projectOrderIntoCapitalContext(
  ctx: CapitalContext | null | undefined,
  input: { symbol: string; positionSide: PositionSide; margin: number; leverage: number },
): void {
  if (!ctx) return;
  const symbol = input.symbol.toUpperCase();
  ctx.openPositions.push({
    symbol,
    positionSide: input.positionSide,
    positionAmt: "1",
    avgPrice: String(input.margin * input.leverage),
    leverage: String(input.leverage),
    initialMargin: String(input.margin),
  });
  ctx.openPositionsCount += 1;
  ctx.usedMargin += input.margin;
  ctx.availableMargin = Math.max(0, ctx.availableMargin - input.margin);
  ctx.marginUtilization = ctx.equity > 0 ? ctx.usedMargin / ctx.equity : 1;
  const counts = ctx.countsBySide.get(symbol) ?? { LONG: 0, SHORT: 0 };
  counts[input.positionSide] += 1;
  ctx.countsBySide.set(symbol, counts);
}

// ── Sniper Autopilot — server-side autonomous execution loop ──────────────────

interface AutopilotCycleSummary {
  cycle: number;
  startedAt: number;
  durationMs: number;
  candidates: number;
  attempted: number;
  placed: number;
  rejected: number;
  btcChangePct: number;
  aggressionState?: string;
  aggressionReason?: string;
}

interface AutopilotState {
  running: boolean;
  startedAt: number | null;
  creds: ExecutionCredentials | null;
  handle: NodeJS.Timeout | null;
  totalCycles: number;
  totalPlaced: number;
  sessionLossUsd: number;
  lastCycle: AutopilotCycleSummary | null;
  history: AutopilotCycleSummary[];
  stopReason: string | null;
}

const autopilot: AutopilotState = {
  running: false,
  startedAt: null,
  creds: null,
  handle: null,
  totalCycles: 0,
  totalPlaced: 0,
  sessionLossUsd: 0,
  lastCycle: null,
  history: [],
  stopReason: null,
};
let autopilotCycleInFlight = false;
let autopilotSkippedOverlaps = 0;

async function runAutopilotCycleLocked(): Promise<void> {
  if (autopilotCycleInFlight) {
    autopilotSkippedOverlaps++;
    return;
  }
  autopilotCycleInFlight = true;
  try {
    await runAutopilotCycle();
  } finally {
    autopilotCycleInFlight = false;
  }
}

function stopAutopilot(reason: string): void {
  if (autopilot.handle) {
    clearInterval(autopilot.handle);
    autopilot.handle = null;
  }
  autopilot.running = false;
  autopilot.creds = null;
  autopilot.stopReason = reason;
}

async function runAutopilotCycle(): Promise<void> {
  if (!autopilot.running || !autopilot.creds) return;

  let config = getBotConfig();
  const engine = getEngine();
  const t0 = Date.now();
  const cycleNum = ++autopilot.totalCycles;

  // Fetch BTC regime + capital in parallel
  let btcChangePct = 0;
  const btcUrl = `${BINGX_PUBLIC_BASE}/openApi/swap/v2/quote/ticker?symbol=BTC-USDT&timestamp=${Date.now()}`;
  const [btcResp, capitalCtx] = await Promise.all([
    fetch(btcUrl, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json() as Promise<Record<string, unknown>>)
      .catch(() => null),
    fetchCapitalContext(autopilot.creds).catch(() => null),
  ]);

  if (btcResp?.code === 0) {
    const d = (btcResp.data as Record<string, string>) ?? {};
    btcChangePct = parseFloat(d.priceChangePercent ?? "0");
  }

  if (!capitalCtx) {
    return; // Skip cycle — cannot verify capital
  }

  const killSwitch = evaluateLiveKillSwitch({
    config,
    btcChangePct,
    capitalCtx,
    maxSessionLossRemaining: config.maxSessionLoss > 0 ? config.maxSessionLoss - autopilot.sessionLossUsd : null,
    integrityOk: true,
  });
  if (!killSwitch.entryAllowed) {
    const summary: AutopilotCycleSummary = {
      cycle: cycleNum,
      startedAt: t0,
      durationMs: Date.now() - t0,
      candidates: 0,
      attempted: 0,
      placed: 0,
      rejected: 0,
      btcChangePct,
      aggressionState: killSwitch.state,
      aggressionReason: killSwitch.reason,
    };
    autopilot.lastCycle = summary;
    autopilot.history.push(summary);
    if (autopilot.history.length > 100) autopilot.history.shift();
    return;
  }
  config = applyKillSwitchToConfig(config, killSwitch);

  // Session loss circuit-breaker
  if (config.maxSessionLoss > 0 && autopilot.sessionLossUsd >= config.maxSessionLoss) {
    stopAutopilot(`SESSION_LOSS_LIMIT: ${autopilot.sessionLossUsd.toFixed(2)} USD >= ${config.maxSessionLoss} USD`);
    return;
  }

  // No room for more positions
  if (capitalCtx.openPositionsCount >= config.maxConcurrentPositions) return;
  if (capitalCtx.marginUtilization > config.maxMarginUtilization) return;

  const symbols = config.allowedSymbols;
  if (symbols.length === 0) return;

  const btcRegime: import("../lib/adaptiveEngine").BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";
  const hourUtc = new Date().getUTCHours();

  if (config.hourBlacklist.includes(hourUtc)) return;

  // Fetch candle edges for all symbols in parallel
  const candleEdges = await computeAllCandleEdges(symbols, "5m").catch(() =>
    symbols.map((sym) => ({ symbol: sym, longScore: 0, shortScore: 0, error: "fetch failed" }))
  );
  const rotation = await buildSymbolRotationReport({
    symbols,
    engine,
    config,
    btcRegime,
    hourUtc,
    candleEdges: candleEdges as CandleEdge[],
    openCountsBySymbol: openCountsBySymbolFromCapital(capitalCtx),
  });
  const rotationBySymbol = rotationRankBySymbol(rotation);

  // Score candidates
  const candidates: Array<{
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    combinedScore: number;
    rotationScore: number;
    currentEv: number;
    btcChangePct: number;
  }> = [];
  const aggressionCandidates: AggressionCandidate[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const candle = (candleEdges[i] as { longScore?: number; shortScore?: number; volumeRatio?: number; error?: string | null } | undefined);
    if (!candle || (candle as { error?: string | null }).error) continue;

    for (const ps of ["LONG", "SHORT"] as const) {
      const clusterKey = { symbol: sym, positionSide: ps, hourUtc, btcRegime };
      const combined = engine.combinedEdgeScore(
        clusterKey,
        engine.clusterProfile(clusterKey)?.ev ?? engine.symbolProfile(sym)?.ev ?? 0,
        ps === "LONG" ? (candle.longScore ?? 0) : (candle.shortScore ?? 0),
      );

      if (combined < config.sniperMinCombinedScore) continue;

      // Check position stacking limit
      const symCounts = capitalCtx.countsBySide.get(sym) ?? { LONG: 0, SHORT: 0 };
      const currentCount = symCounts[ps];
      const limit = driftAdjustedStackLimit(config);
      if (currentCount >= limit) continue;

      // Check hedging constraint
      const oppSide = ps === "LONG" ? "SHORT" : "LONG";
      if (config.preventHedgedPositions && symCounts[oppSide] > 0) continue;

      const profile = engine.symbolProfile(sym);
      if (profile?.isToxic) continue;
      const rotationRank = rotationBySymbol.get(sym.toUpperCase());
      if (rotationRank?.state === "PAUSED") continue;
      const rotationLimit = rotationRank?.maxPositions ?? limit;
      if (symCounts.LONG + symCounts.SHORT >= rotationLimit) continue;
      const sideFactor =
        !rotationRank || rotationRank.sideBias === "NEUTRAL" || rotationRank.sideBias === ps ? 1 : 0.72;
      const rotationAdjustedScore = combined * (rotationRank?.rotationScore ?? 0.5) * sideFactor;

      aggressionCandidates.push({
        symbol: sym,
        positionSide: ps,
        score: rotationAdjustedScore,
        candleScore: ps === "LONG" ? (candle.longScore ?? 0) : (candle.shortScore ?? 0),
        rankingScore: rotationRank?.rotationScore,
        volumeRatio: candle.volumeRatio,
      });

      candidates.push({
        symbol: sym,
        side: ps === "LONG" ? "BUY" : "SELL",
        positionSide: ps,
        combinedScore: rotationAdjustedScore,
        rotationScore: rotationRank?.rotationScore ?? 0.5,
        currentEv: engine.clusterProfile(clusterKey)?.ev ?? 0,
        btcChangePct,
      });
    }
  }

  const aggression = evaluateAggression({
    config,
    outcomes: exportAllOutcomes().filter((outcome) => !isDemoOutcome(outcome)),
    serviceState: getServiceState(),
    candidates: aggressionCandidates,
    btcRegime,
    btcChangePct,
    openPositionsCount: capitalCtx.openPositionsCount,
    maxOpenPositions: config.maxConcurrentPositions,
    dataFresh: true,
    apiHealthy: true,
    executionHealthy: true,
    source: "live",
  });
  if (aggression.aggressionState === "PAUSED") {
    const summary: AutopilotCycleSummary = {
      cycle: cycleNum,
      startedAt: t0,
      durationMs: Date.now() - t0,
      candidates: candidates.length,
      attempted: 0,
      placed: 0,
      rejected: 0,
      btcChangePct,
      aggressionState: aggression.aggressionState,
      aggressionReason: aggression.reason,
    };
    autopilot.lastCycle = summary;
    autopilot.history.push(summary);
    if (autopilot.history.length > 100) autopilot.history.shift();
    return;
  }
  const aggressiveConfig = applyAggressionToConfig(config, aggression);

  // Sort by adaptive rotation-adjusted score, take top N
  candidates.sort((a, b) => b.combinedScore - a.combinedScore);
  const selectedBySymbol = new Map<string, number>();
  const toFire: typeof candidates = [];
  for (const candidate of candidates) {
    if (toFire.length >= aggression.maxCandidatesThisCycle) break;
    if (candidate.combinedScore < aggression.minAggressiveScore) continue;
    const rank = rotationBySymbol.get(candidate.symbol.toUpperCase());
    const maxPositions = Math.min(
      rank?.maxPositions ?? driftAdjustedStackLimit(aggressiveConfig),
      aggression.symbolConcentrationLimit,
    );
    const openCounts = capitalCtx.countsBySide.get(candidate.symbol.toUpperCase()) ?? { LONG: 0, SHORT: 0 };
    const selectedForSymbol = selectedBySymbol.get(candidate.symbol.toUpperCase()) ?? 0;
    if (openCounts.LONG + openCounts.SHORT + selectedForSymbol >= maxPositions) continue;
    selectedBySymbol.set(candidate.symbol.toUpperCase(), selectedForSymbol + 1);
    toFire.push(candidate);
  }

  // Respect max concurrent positions headroom
  const headroom = config.maxConcurrentPositions - capitalCtx.openPositionsCount;
  const firing = toFire.slice(0, Math.max(0, Math.min(headroom, aggression.maxPositionsThisCycle)));

  let placed = 0;
  let rejected = 0;

  for (const c of firing) {
    const rank = rotationBySymbol.get(c.symbol.toUpperCase());
    const allocationMultiplier = rank
      ? Math.max(0.25, Math.min(1.75, rank.allocationWeight * Math.max(1, rotation.ranking.length)))
      : 1;
    const stateMultiplier =
      rank?.state === "HOT" ? allocationMultiplier :
      rank?.state === "ACTIVE" ? Math.min(1.25, allocationMultiplier) :
      rank?.state === "REDUCED" ? Math.min(0.50, allocationMultiplier) :
      rank?.state === "RECOVERY" ? Math.min(0.35, allocationMultiplier) :
      0;
    const orderConfig = rank
      ? {
          ...aggressiveConfig,
          marginPerTrade: Math.max(0.1, aggressiveConfig.marginPerTrade * stateMultiplier),
          maxPositionsPerSymbol: Math.max(1, rank.maxPositions),
          positionStackingEnabled: aggressiveConfig.positionStackingEnabled && rank.maxPositions > 1,
        }
      : aggressiveConfig;
    const result = await executeSingleOrder(
      { symbol: c.symbol, side: c.side, positionSide: c.positionSide, currentEv: c.currentEv, btcChangePct: c.btcChangePct },
      0,
      autopilot.creds!,
      orderConfig,
      [],
      capitalCtx,
    );
    if (result.placed) placed++;
    else rejected++;
  }

  autopilot.totalPlaced += placed;
  recordAggressionCycleImpact(firing.length, placed);

  const summary: AutopilotCycleSummary = {
    cycle: cycleNum,
    startedAt: t0,
    durationMs: Date.now() - t0,
    candidates: candidates.length,
    attempted: firing.length,
    placed,
    rejected,
    btcChangePct,
    aggressionState: aggression.aggressionState,
    aggressionReason: aggression.reason,
  };
  autopilot.lastCycle = summary;
  autopilot.history.push(summary);
  if (autopilot.history.length > 100) autopilot.history.shift();
}

/** GET /api/bot/config — current bot configuration from ENV */
router.get("/bot/config", (_req: Request, res: Response) => {
  res.json(getBotConfig());
});

router.get("/bot/config/audit", requireAdminAuthorization, (_req: Request, res: Response) => {
  res.json({
    entries: getOverrideHistory().map((entry) => ({
      timestamp: entry.timestamp,
      changedKeys: Object.keys(entry.patch),
    })),
  });
});

/** PATCH /api/bot/config/override — apply runtime overrides (in-memory) */
router.patch("/bot/config/override", requireAdminAuthorization, (req: Request, res: Response) => {
  const patch = req.body as Record<string, unknown>;
  const allowed = [
    "leverage", "marginPerTrade", "maxConcurrentPositions", "maxMarginUtilization",
    "takeProfitPct", "stopLossPct", "evMinThreshold", "winRateMin", "profitFactorMin",
    "btcRegimeRequired", "allowCounterRegimeScalp", "btcRegimeThresholdPct", "allowedSymbols", "hourBlacklist",
    "orderType", "marginType", "allowExecution", "maxSessionLoss",
    "maxPositionsPerSymbol", "positionStackingEnabled",
    "sniperAutopilotIntervalSec", "sniperMaxCandidatesPerCycle", "sniperMinCombinedScore",
    "preventHedgedPositions",
  ];
  const safe: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in patch) safe[key] = patch[key];
  }
  setConfigOverrides(safe);
  req.log.info({ overrides: safe }, "bot config override applied");
  res.json(getBotConfig());
});

/** POST /api/bot/config/override/reset — clear all runtime overrides */
router.post("/bot/config/override/reset", requireAdminAuthorization, (_req: Request, res: Response) => {
  resetConfigOverrides();
  res.json(getBotConfig());
});

/** POST /api/bot/order — place scalp entry order with all gate checks */
router.post("/bot/order", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected. Please provide your API credentials." });
    return;
  }

  let config = getBotConfig();
  let orderMargin = config.marginPerTrade;
  let orderLeverage = config.leverage;
  let readinessScopeId: string | undefined;
  let promotionState: PromotionState | undefined;
  let marketEventClaimed = false;
  const {
    symbol,
    side,
    positionSide,
    quantity,
    currentEv,
    currentWinRate,
    currentProfitFactor,
    btcChangePct,
  } = req.body as {
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    quantity?: number;
    currentEv?: number;
    currentWinRate?: number;
    currentProfitFactor?: number;
    btcChangePct?: number;
  };

  if (!symbol || !side || !positionSide) {
    res.status(400).json({ error: "symbol, side, and positionSide are required" });
    return;
  }

  // ── Gate evaluation pipeline ────────────────────────────────────────────────
  const gateRejects: string[] = [];
  const currentHour = new Date().getUTCHours();
  const recentPerformance = summarizeRecentPerformance(
    getEngine().rawOutcomes().filter((outcome) => !isDemoOutcome(outcome)),
    config,
  );
  gateRejects.push(...recentPerformanceRejects(recentPerformance, config));
  const candle = await computeCandleEdge(symbol, "5m");
  gateRejects.push(...candleConfirmationRejects(candle, positionSide, config));
  const killSwitch = evaluateLiveKillSwitch({
    config,
    btcChangePct,
    maxSessionLossRemaining: config.maxSessionLoss,
    integrityOk: true,
  });
  if (!killSwitch.entryAllowed) {
    gateRejects.push(`KILL_SWITCH_${killSwitch.state}: ${killSwitch.reason}`);
  } else {
    config = applyKillSwitchToConfig(config, killSwitch);
  }

  // Gate 1: master kill switch
  if (!config.allowExecution) {
    // observation mode — evaluate all gates but never send
  }

  // Gate 2: symbol allowlist
  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(symbol)) {
    gateRejects.push(`SYMBOL_REJECT: ${symbol} not in allowlist [${config.allowedSymbols.join(",")}]`);
  }

  // Gate 3: hour blacklist
  if (config.hourBlacklist.includes(currentHour)) {
    gateRejects.push(`HOUR_REJECT: UTC hour ${currentHour} is blacklisted`);
  }

  // BTC regime is telemetry only. Entry direction is enforced by candle/edge gates.

  // Gate 5: EV gate
  if (config.evMinThreshold > 0 && currentEv !== undefined) {
    if (currentEv < config.evMinThreshold) {
      gateRejects.push(
        `EV_REJECT: EV ${currentEv.toFixed(4)} < threshold ${config.evMinThreshold.toFixed(4)}`,
      );
    }
  }

  const feeDragReject = feeDragRejectReason(currentEv, config.marginPerTrade, config);
  if (feeDragReject) {
    gateRejects.push(feeDragReject);
  }

  // Gate 6: win rate gate
  if (config.winRateMin > 0 && currentWinRate !== undefined) {
    if (currentWinRate < config.winRateMin) {
      gateRejects.push(
        `WR_REJECT: WR ${(currentWinRate * 100).toFixed(1)}% < min ${(config.winRateMin * 100).toFixed(1)}%`,
      );
    }
  }

  // Gate 7: profit factor gate
  if (config.profitFactorMin > 0 && currentProfitFactor !== undefined) {
    if (currentProfitFactor < config.profitFactorMin) {
      gateRejects.push(
        `PF_REJECT: PF ${currentProfitFactor.toFixed(2)}x < min ${config.profitFactorMin.toFixed(2)}x`,
      );
    }
  }

  // Gate 8: capital gate + QB edge evaluation + sentiment (all in parallel)
  let openPositionsCount = 0;
  let marginUtilization = 0;
  let openPositions: Record<string, unknown>[] = [];
  let capitalCtx: CapitalContext | null = null;
  let qbShadowRejects: string[] = [];
  let qbOrderResult: QuantBrainEdgeResult | null = null;
  let sizingDecision: PositionSizingDecision | null = null;
  let sizingWarning: string | undefined;

  const [capitalData, sentimentForQb] = await Promise.all([
    fetchCapitalContext(creds).catch(() => null),
    getMarketSentiment(symbol).catch(() => null),
  ]);

  if (capitalData) {
    capitalCtx = capitalData;
    openPositions = capitalData.openPositions;
    openPositionsCount = capitalData.openPositionsCount;
    marginUtilization = capitalData.marginUtilization;
  } else if (config.allowExecution) {
    gateRejects.push("CAPITAL_CONTEXT_REJECT: live capital snapshot unavailable");
  }

  // QB edge gate — called after capital gate (sentiment already fetched in parallel above)
  try {
    const qbInput: QuantBrainEdgeInput = {
      symbol, side, positionSide,
      hourUtc: currentHour,
      btcChangePct,
      currentEv,
      currentWinRate,
      currentProfitFactor,
      config,
      costModel: estimateExecutionCosts(
        orderMargin,
        orderLeverage,
        config.takerFeeBps / 10_000,
        undefined,
        undefined,
        {
          takeProfitPct: config.takeProfitPct,
          stopLossPct: config.stopLossPct,
          grossEv: currentEv,
          expectedWinRate: currentWinRate,
          slippageBpsPerSide: config.slippageBpsPerSide,
          fundingCostPct: config.estimatedFundingCostPct,
          minEdgeOverCostPct: config.minEdgeOverCostPct,
        },
      ),
      sentimentContext: sentimentForQb ? {
        direction: sentimentForQb.direction,
        confidence: sentimentForQb.confidence,
        biasRatio: sentimentForQb.biasRatio,
        dominantSide: sentimentForQb.dominantSide,
        vwapDeviation: sentimentForQb.indicators.vwapDeviation,
        volumeDelta: sentimentForQb.indicators.volumeDelta,
        momentum24h: sentimentForQb.indicators.momentum24h,
      } : undefined,
      marketEventId: candle.marketEventId,
      featureVersion: "candle-edge-v1",
      featureTimestampMs: candle.candleCloseTimeMs,
      candleIsComplete: candle.candleIsComplete,
      marketDataSource: "bingx",
      referencePrice: candle.lastClose,
    };
    const qbMode = quantBrainGateMode();
    const qbResult = await Promise.race([
      evaluateQuantBrainEdge(qbInput),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("QB_ORDER_TIMEOUT")), QB_ORDER_TIMEOUT_MS),
      ),
    ]);
    qbOrderResult = qbResult;
    if (qbMode === "enforce" && !qbResult.allow) {
      // Enforce mode: QB rejects block the trade
      gateRejects.push(...qbResult.gateRejects.map((r) => `QB_${r}`));
    } else if (qbResult.gateRejects.length > 0) {
      // Shadow mode: QB rejects are observational only — log for calibration
      qbShadowRejects = qbResult.gateRejects;
      req.log.info({ symbol, positionSide, qbShadowRejects }, "QB shadow rejects (not blocking)");
    }
  } catch (err) {
    if (quantBrainGateMode() === "enforce") {
      gateRejects.push(`QB_TIMEOUT_REJECT: ${err instanceof Error ? err.message : "Quant Brain timed out"}`);
    } else {
      req.log.debug({ err }, "QB edge evaluation skipped - not blocking");
    }
  }

  if (openPositionsCount >= config.maxConcurrentPositions) {
    gateRejects.push(
      `CAPITAL_REJECT: ${openPositionsCount} open positions >= max ${config.maxConcurrentPositions}`,
    );
  }

  // Position stacking / hedging gate
  {
    const symUpper = symbol.toUpperCase();
    const symPositions = openPositions.filter(
      (p) => String(p.symbol ?? "").toUpperCase() === symUpper,
    );
    // Count per side
    const sameSideCount = symPositions.filter(
      (p) => String(p.positionSide ?? "").toUpperCase() === positionSide,
    ).length;
    const oppSideCount = symPositions.filter(
      (p) => String(p.positionSide ?? "").toUpperCase() !== positionSide,
    ).length;

    // Hedging block: existing opposite position
    if (config.preventHedgedPositions && oppSideCount > 0) {
      gateRejects.push(
        `HEDGE_REJECT: ${symbol} already has ${oppSideCount} open ${positionSide === "LONG" ? "SHORT" : "LONG"} position(s)`,
      );
    }

    // Stacking limit
    const stackLimit = driftAdjustedStackLimit(config);
    if (stackLimit === 0) {
      gateRejects.push("DRIFT_PAUSED_REJECT: drift policy blocks new entries");
    }
    if (sameSideCount >= stackLimit) {
      gateRejects.push(
        `STACK_REJECT: ${symbol} ${positionSide} already has ${sameSideCount}/${stackLimit} position(s)`,
      );
    }
  }

  if (marginUtilization > config.maxMarginUtilization) {
    gateRejects.push(
      `MARGIN_REJECT: margin utilization ${(marginUtilization * 100).toFixed(1)}% > max ${(config.maxMarginUtilization * 100).toFixed(0)}%`,
    );
  }

  if (getPositionSizingConfig(config).enabled) {
    try {
      const sameSideOpen = openPositions.filter(
        (p) => String(p.symbol ?? "").toUpperCase() === symbol.toUpperCase()
          && String(p.positionSide ?? "").toUpperCase() === positionSide,
      );
      const sizingStats = recentSizingStats(exportAllOutcomes(), symbol, positionSide);
      sizingDecision = calculatePositionSizing({
        symbol,
        positionSide,
        accountEquity: capitalCtx?.equity ?? config.marginPerTrade / 0.005,
        availableMargin: capitalCtx?.availableMargin ?? Number.POSITIVE_INFINITY,
        aggressiveScore: Math.max(0, Math.min(1, currentEv ?? 0.62)),
        calibratedScore: qbOrderResult?.calibratedScore ?? qbOrderResult?.score ?? undefined,
        calibratedProbability: qbOrderResult?.calibratedProbability ?? null,
        expectedValuePct: qbOrderResult?.economics?.mlEconomicGate?.expectedValuePct ?? null,
        optimalThreshold: qbOrderResult?.economics?.mlEconomicGate?.optimalThreshold ?? null,
        profitabilityVerified: qbOrderResult?.economics?.mlEconomicGate?.profitabilityVerified ?? undefined,
        kellyFraction: qbOrderResult?.economics?.kellyFraction ?? null,
        mlSizingMultiplier: qbOrderResult?.economics?.mlEconomicGate?.sizingMultiplier
          ?? qbOrderResult?.economics?.mlEconomicSizeMultiplier
          ?? null,
        btcRegime: btcChangePct === undefined
          ? undefined
          : btcChangePct >= config.btcRegimeThresholdPct
            ? "BULL"
            : btcChangePct <= -config.btcRegimeThresholdPct
              ? "BEAR"
              : "NEUTRAL",
        recentPnl: sizingStats.recentPnl,
        recentWinRate: sizingStats.recentWinRate,
        profitFactor: sizingStats.profitFactor,
        drawdown: sizingStats.drawdown,
        executionSlippageBps: sizingStats.executionSlippageBps,
        campaignDepth: sameSideOpen.length + 1,
        previousEntryMargin: sameSideOpen.length > 0 ? orderMargin : undefined,
        currentOpenPositions: capitalPositionsForSizing(capitalCtx),
        sideContextWinRate: sizingStats.sideContextWinRate,
        sideContextProfitFactor: sizingStats.sideContextProfitFactor,
        baseMarginFallback: config.marginPerTrade,
        leverageFallback: config.leverage,
        stopLossPct: config.stopLossPct,
        takeProfitPct: config.takeProfitPct,
      });
      if (sizingDecision.approved) {
        orderMargin = sizingDecision.recommendedMargin;
        orderLeverage = sizingDecision.recommendedLeverage;
      } else if (config.allowExecution) {
        gateRejects.push(...sizingDecision.gateRejects);
      } else {
        sizingWarning = sizingDecision.gateRejects[0] ?? sizingDecision.reason;
      }
    } catch (err) {
      sizingWarning = err instanceof Error ? err.message : "position sizing failed";
      req.log.warn({ err, symbol, positionSide }, "position sizing failed; using configured margin");
    }
  }

  // ── Observation mode ────────────────────────────────────────────────────────
  if (!config.allowExecution) {
    req.log.info({ symbol, side, positionSide, gateRejects, observationMode: true }, "bot order observation");
    res.status(200).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: quantity ?? null,
      gateRejects,
      qbShadowRejects,
      observationMode: true,
      riskTier: sizingDecision?.riskTier,
      recommendedMargin: sizingDecision?.recommendedMargin,
      recommendedLeverage: sizingDecision?.recommendedLeverage,
      maxMarginApplied: orderMargin,
      sizingReason: sizingDecision?.reason,
      sizingWarning,
      message: gateRejects.length > 0
        ? `BLOCKED by ${gateRejects.length} gate(s). Also observation mode (SCALP_ALLOW_EXECUTION=false).`
        : "All gates pass. Observation mode active — set SCALP_ALLOW_EXECUTION=true to execute.",
    });
    return;
  }

  // ── Gate blocked ────────────────────────────────────────────────────────────
  try {
    assertLiveExecutionAllowed(creds);
  } catch (err) {
    res.status(403).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: quantity ?? null,
      gateRejects: ["LIVE_ENVIRONMENT_REJECT"],
      observationMode: false,
      riskTier: sizingDecision?.riskTier,
      recommendedMargin: sizingDecision?.recommendedMargin,
      recommendedLeverage: sizingDecision?.recommendedLeverage,
      maxMarginApplied: orderMargin,
      sizingReason: sizingDecision?.reason,
      sizingWarning,
      message: err instanceof Error ? err.message : "Real-money execution refused.",
    });
    return;
  }

  {
    const sameSideOpen = openPositions.filter(
      (p) => String(p.symbol ?? "").toUpperCase() === symbol.toUpperCase()
        && String(p.positionSide ?? "").toUpperCase() === positionSide,
    ).length;
    const btcRegimeForReadiness: BtcRegime | null = btcChangePct === undefined
      ? null
      : btcChangePct >= config.btcRegimeThresholdPct
        ? "BULL"
        : btcChangePct <= -config.btcRegimeThresholdPct
          ? "BEAR"
          : "NEUTRAL";
    const readinessStatus = await getCachedLiveReadinessStatus(config);
    const readiness = evaluateLiveReadinessForOrder({
      status: readinessStatus,
      order: {
        symbol,
        side,
        positionSide,
        playbook: "MOMENTUM_BREAKOUT_SCALP",
        btcRegime: btcRegimeForReadiness,
        score: currentEv,
      },
      config,
      openSameSidePositions: sameSideOpen,
    });
    readinessScopeId = readiness.readinessScopeId ?? undefined;
    promotionState = readiness.promotionState;
    if (!readiness.allowed) {
      gateRejects.push(...readiness.gateRejects);
    } else {
      orderMargin = Math.min(orderMargin, readiness.maxMargin);
    }
  }

  if (capitalCtx) {
    gateRejects.push(...portfolioRiskRejectsForOrder({
      ctx: capitalCtx,
      config,
      symbol,
      positionSide,
      margin: orderMargin,
      leverage: orderLeverage,
      btcChangePct,
      sizing: sizingDecision ?? undefined,
    }));
  }

  if (gateRejects.length > 0) {
    req.log.info({ symbol, side, positionSide, gateRejects }, "bot order gate reject");
    res.status(403).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: quantity ?? null,
      gateRejects,
      qbShadowRejects,
      observationMode: false,
      riskTier: sizingDecision?.riskTier,
      recommendedMargin: sizingDecision?.recommendedMargin,
      recommendedLeverage: sizingDecision?.recommendedLeverage,
      maxMarginApplied: orderMargin,
      sizingReason: sizingDecision?.reason,
      sizingWarning,
      message: `REJECTED by ${gateRejects.length} gate(s): ${gateRejects[0]}`,
    });
    return;
  }

  // ── Compute quantity if not provided ────────────────────────────────────────
  let qty = quantity;
  let referencePrice = 0;
  if (!qty) {
    // Fetch mark price to compute qty = (marginPerTrade × leverage) / markPrice
    try {
      const timestamp = Date.now();
      const url = `${BINGX_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}&timestamp=${timestamp}`;
      const tickerData = (await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()) as Record<string, unknown>;
      if (tickerData.code === 0) {
        const t = (tickerData.data as Record<string, string>) ?? {};
        const markPrice = parseFloat(t.lastPrice ?? "0");
        if (markPrice > 0) {
          referencePrice = markPrice;
          qty = (orderMargin * orderLeverage) / markPrice;
          // Round to reasonable precision
          qty = Math.floor(qty * 1000) / 1000;
        }
      }
    } catch {
      // use fallback
    }
  }

  if (referencePrice <= 0) {
    try {
      const timestamp = Date.now();
      const url = `${BINGX_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}&timestamp=${timestamp}`;
      const tickerData = (await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()) as Record<string, unknown>;
      if (tickerData.code === 0) {
        const t = (tickerData.data as Record<string, string>) ?? {};
        referencePrice = parseFloat(t.lastPrice ?? "0");
      }
    } catch {
      // Protection will be marked high risk if no usable reference price is available.
    }
  }

  if (!qty || qty <= 0) {
    res.status(400).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: null,
      gateRejects: ["QTY_REJECT: could not compute valid quantity"],
      observationMode: false,
      riskTier: sizingDecision?.riskTier,
      recommendedMargin: sizingDecision?.recommendedMargin,
      recommendedLeverage: sizingDecision?.recommendedLeverage,
      maxMarginApplied: orderMargin,
      sizingReason: sizingDecision?.reason,
      sizingWarning,
      message: "Could not determine order quantity. Provide quantity explicitly.",
    });
    return;
  }

  const manualMarketEventId = candle.marketEventId;
  if (!manualMarketEventId) {
    res.status(409).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: qty,
      gateRejects: ["MARKET_EVENT_REJECT: canonical completed candle event is unavailable"],
      observationMode: false,
      riskTier: sizingDecision?.riskTier,
      recommendedMargin: sizingDecision?.recommendedMargin,
      recommendedLeverage: sizingDecision?.recommendedLeverage,
      maxMarginApplied: orderMargin,
      sizingReason: sizingDecision?.reason,
      sizingWarning,
      message: "Canonical market event is required for live manual execution.",
    });
    return;
  }
  const clientOrderId = deterministicClientOrderId({
    symbol,
    side,
    positionSide,
    marketEventId: manualMarketEventId,
  });
  if (!claimMarketEventExecution(manualMarketEventId, positionSide)) {
    res.status(409).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: qty,
      gateRejects: ["DUPLICATE_EXECUTION_REJECT: candle event already executed"],
      observationMode: false,
      riskTier: sizingDecision?.riskTier,
      recommendedMargin: sizingDecision?.recommendedMargin,
      recommendedLeverage: sizingDecision?.recommendedLeverage,
      maxMarginApplied: orderMargin,
      sizingReason: sizingDecision?.reason,
      sizingWarning,
      message: "Duplicate candle execution rejected.",
    });
    return;
  }
  marketEventClaimed = true;

  // ── Execute order ────────────────────────────────────────────────────────────
  try {
    const orderRequestedAt = Date.now();
    const orderSentAt = orderRequestedAt;
    const baseOrderParams: Record<string, string | number> = {
      symbol,
      side,
      positionSide,
      type: config.orderType,
      quantity: qty,
      leverage: orderLeverage,
      clientOrderID: clientOrderId,
    };
    const protection = withEntryProtection(baseOrderParams, referencePrice, positionSide, config);

    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      protection.orderParams,
      creds.apiKey,
      creds.secretKey,
    );

    if (data.code !== 0) {
      releaseMarketEventExecution(manualMarketEventId, positionSide);
      marketEventClaimed = false;
      req.log.error({ data }, "BingX order error");
      res.status(500).json({
        placed: false,
        orderId: null,
        symbol,
        side,
        quantity: qty,
        gateRejects: [],
        observationMode: false,
        riskTier: sizingDecision?.riskTier,
        recommendedMargin: sizingDecision?.recommendedMargin,
        recommendedLeverage: sizingDecision?.recommendedLeverage,
        maxMarginApplied: orderMargin,
        sizingReason: sizingDecision?.reason,
        sizingWarning,
        message: `BingX error: ${(data.msg as string) ?? "unknown"}`,
      });
      return;
    }

    const orderAckAt = Date.now();
    const order = (data.data as Record<string, unknown>)?.order as Record<string, unknown>;
    const placedOrderId = String(order?.orderId ?? "");
    const executedPrice = Number(order?.avgPrice ?? order?.price ?? 0);
    req.log.info({ symbol, side, positionSide, qty, orderId: order?.orderId }, "bot order placed");

    if (!placedOrderId) {
      req.log.error({ data, symbol, side, positionSide, qty }, "BingX order ACK missing orderId");
      res.status(502).json({
        placed: false,
        orderId: null,
        symbol,
        side,
        quantity: qty,
        gateRejects: ["ORDER_ACK_AMBIGUOUS: BingX accepted request but did not return orderId"],
        observationMode: false,
        riskTier: sizingDecision?.riskTier,
        recommendedMargin: sizingDecision?.recommendedMargin,
        recommendedLeverage: sizingDecision?.recommendedLeverage,
        maxMarginApplied: orderMargin,
        sizingReason: sizingDecision?.reason,
        sizingWarning,
        message: "BingX order acknowledgement was ambiguous; do not retry until exchange state is reconciled.",
      });
      return;
    }

    if (placedOrderId) {
      updateWatcherCreds(creds);
      const btcRegimeForEntry: BtcRegime =
        btcChangePct === undefined
          ? "NEUTRAL"
          : btcChangePct >= config.btcRegimeThresholdPct
            ? "BULL"
            : btcChangePct <= -config.btcRegimeThresholdPct
              ? "BEAR"
              : "NEUTRAL";
      registerLiveEntry({
        entryOrderId: placedOrderId,
        symbol,
        positionSide,
        side,
        expectedEntryPrice: executedPrice > 0 ? executedPrice : candle.lastClose,
        qty,
        leverage: orderLeverage,
        marginUsed: orderMargin,
        btcRegime: btcRegimeForEntry,
        hourUtc: currentHour,
        entryTime: orderAckAt,
        expectedTpProfit: orderMargin * orderLeverage * (config.takeProfitPct / 100),
        takeProfitPct: config.takeProfitPct,
        stopLossPct: config.stopLossPct,
        signalId: randomUUID(),
        marketEventId: manualMarketEventId,
        clientOrderId,
        featureVersion: "candle-edge-v1",
        ...liveEntryPolicyProvenance(),
        signalCreatedAt: orderRequestedAt,
        orderRequestedAt,
        orderSentAt,
        orderAckAt,
        positionConfirmedAt: orderAckAt,
        protectionAttachedAt: protection.protectionAttached ? orderAckAt : undefined,
        orderType: config.orderType,
        playbook: "MOMENTUM_BREAKOUT_SCALP",
        readinessScopeId,
        promotionState,
        riskTier: sizingDecision?.riskTier === "NO_TRADE" ? undefined : sizingDecision?.riskTier,
        sizeMultiplier: sizingDecision?.sizeMultiplier,
        sizeReason: sizingDecision?.reason,
        recommendedMargin: sizingDecision?.recommendedMargin,
        recommendedLeverage: sizingDecision?.recommendedLeverage,
        maxLossIfStop: sizingDecision?.maxLossIfStop,
        notional: sizingDecision?.notional,
        exitPolicy: protection.riskMode,
      });
    }

    res.json({
      placed: true,
      orderId: placedOrderId,
      symbol,
      side,
      quantity: qty,
      gateRejects: [],
      observationMode: false,
      message: `Order placed: ${side} ${qty} ${symbol} @ MARKET`,
      readinessScopeId,
      promotionState,
      riskTier: sizingDecision?.riskTier,
      recommendedMargin: sizingDecision?.recommendedMargin,
      recommendedLeverage: sizingDecision?.recommendedLeverage,
      maxMarginApplied: orderMargin,
      sizingReason: sizingDecision?.reason,
      sizingWarning,
      protectionAttached: protection.protectionAttached,
      riskMode: protection.riskMode,
      protectionStopPrice: protection.protectionStopPrice,
      protectionTakeProfitPrice: protection.protectionTakeProfitPrice,
    });
  } catch (err) {
    req.log.error({ err }, "bot order execution error");
    res.status(500).json({
      error: "Order execution failed",
      clientOrderID: clientOrderId,
      marketEventId: manualMarketEventId,
      message: marketEventClaimed
        ? "Execution failed after the exchange call may have been sent; the market event remains claimed until reconciliation."
        : "Order execution failed before exchange acknowledgement.",
    });
  }
});

/** POST /api/bot/close — close an open position */
router.post("/bot/close", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected." });
    return;
  }

  const config = getBotConfig();
  const { symbol, positionSide, quantity } = req.body as {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    quantity: string;
  };

  if (!symbol || !positionSide || !quantity) {
    res.status(400).json({ error: "symbol, positionSide, and quantity are required" });
    return;
  }

  // Closing a LONG = SELL; closing a SHORT = BUY
  const closeSide = positionSide === "LONG" ? "SELL" : "BUY";

  try {
    assertLiveExecutionAllowed(creds);
    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      {
        symbol,
        side: closeSide,
        positionSide,
        type: "MARKET",
        quantity: parseFloat(quantity),
      },
      creds.apiKey,
      creds.secretKey,
    );

    if (data.code !== 0) {
      res.status(500).json({
        placed: false,
        orderId: null,
        symbol,
        side: closeSide,
        quantity: parseFloat(quantity),
        gateRejects: [],
        observationMode: false,
        message: `BingX error: ${(data.msg as string) ?? "unknown"}`,
      });
      return;
    }

    const order = (data.data as Record<string, unknown>)?.order as Record<string, unknown>;
    res.json({
      placed: true,
      orderId: String(order?.orderId ?? ""),
      symbol,
      side: closeSide,
      quantity: parseFloat(quantity),
      gateRejects: [],
      observationMode: false,
      message: `Close order placed: ${closeSide} ${quantity} ${symbol}`,
    });
  } catch (err) {
    req.log.error({ err }, "bot close error");
    res.status(500).json({ error: "Close order failed" });
  }
});


const BINGX_PUBLIC_BASE = "https://open-api.bingx.com";
const BINGX_RATE_LIMIT = 10; // max orders/second

function bulkCorrelationKey(order: BulkOrderItem): string {
  const regime =
    order.btcChangePct === undefined ? "UNKNOWN" :
    order.btcChangePct > 0 ? "BTC_BULL" :
    order.btcChangePct < 0 ? "BTC_BEAR" :
    "BTC_NEUTRAL";
  return `${regime}:${order.positionSide}`;
}

function buildBulkCorrelationRejects(orders: BulkOrderItem[], maxPerCluster: number): Map<number, string[]> {
  const seenByCluster = new Map<string, number>();
  const rejects = new Map<number, string[]>();

  orders.forEach((order, index) => {
    const key = bulkCorrelationKey(order);
    const seen = seenByCluster.get(key) ?? 0;
    if (seen >= maxPerCluster) {
      rejects.set(index, [
        `CORRELATION_REJECT: bulk cluster ${key} already has ${maxPerCluster} active orders`,
      ]);
      return;
    }
    seenByCluster.set(key, seen + 1);
  });

  return rejects;
}

function capitalContextFromRequest(raw: unknown): CapitalContext | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const equity = Number(data.equity ?? 0);
  const usedMargin = Number(data.usedMargin ?? 0);
  const availableMargin = Number(data.availableMargin ?? Math.max(0, equity - usedMargin));
  const openPositions = Array.isArray(data.openPositions)
    ? data.openPositions as Record<string, unknown>[]
    : [];
  if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(availableMargin)) return null;
  const countsBySide = new Map<string, { LONG: number; SHORT: number }>();
  for (const p of openPositions) {
    const sym = String(p.symbol ?? "").toUpperCase();
    const side = String(p.positionSide ?? "").toUpperCase() as "LONG" | "SHORT";
    if (!sym) continue;
    const counts = countsBySide.get(sym) ?? { LONG: 0, SHORT: 0 };
    if (side === "LONG" || side === "SHORT") counts[side] += 1;
    countsBySide.set(sym, counts);
  }
  return {
    openPositions,
    openPositionsCount: openPositions.length,
    marginUtilization: equity > 0 ? usedMargin / equity : 1,
    equity,
    usedMargin,
    availableMargin,
    countsBySide,
    fetchedAt: Date.now(),
  };
}

function summarizeCapitalRisk(ctx: CapitalContext, config: ReturnType<typeof getBotConfig>): Record<string, unknown> {
  const positions = capitalPositionsForSizing(ctx);
  const stopLossPct = Math.max(0.01, config.stopLossPct);
  const bySymbol = new Map<string, number>();
  const bySide = new Map<string, number>();
  let totalRiskIfStop = 0;
  let totalNotional = 0;
  for (const pos of positions) {
    const notional = pos.marginUsed * pos.leverage;
    const risk = notional * (stopLossPct / 100);
    totalNotional += notional;
    totalRiskIfStop += risk;
    bySymbol.set(pos.symbol, (bySymbol.get(pos.symbol) ?? 0) + risk);
    bySide.set(pos.positionSide ?? "UNKNOWN", (bySide.get(pos.positionSide ?? "UNKNOWN") ?? 0) + risk);
  }
  return {
    equity: ctx.equity,
    availableMargin: ctx.availableMargin,
    usedMargin: ctx.usedMargin,
    marginUtilization: ctx.marginUtilization,
    openPositions: ctx.openPositionsCount,
    totalNotional,
    effectiveLeverage: ctx.equity > 0 ? totalNotional / ctx.equity : null,
    totalRiskIfStop,
    riskBySymbol: Object.fromEntries(bySymbol),
    riskBySide: Object.fromEntries(bySide),
  };
}

/**
 * GET /api/bot/sentiment — 24h directional bias engine per symbol.
 *
 * Returns SentimentResult for each allowed symbol:
 *   direction: BULL | BEAR | NEUTRAL
 *   confidence: 0-1
 *   biasRatio: 0.5 = neutral; 0.72 = 72% weight to dominantSide
 *   entryBias: { longWeight, shortWeight } for bulk order distribution
 *   indicators: vwapDeviation, volumeDelta, momentum4h, momentum24h, ema12vs24, etc.
 *
 * Use biasRatio to tilt bulk entry distribution:
 *   BULL 0.75 → 75% of bulk slots are LONG, 25% SHORT
 *   BEAR 0.70 → 70% SHORT, 30% LONG
 */
router.get("/bot/sentiment", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const symbols = config.allowedSymbols.length > 0 ? config.allowedSymbols : [];
  const single = req.query.symbol as string | undefined;

  if (single) {
    const result = await getMarketSentiment(single);
    res.json(result);
    return;
  }

  if (symbols.length === 0) {
    res.json({ symbols: [], fetchedAt: Date.now() });
    return;
  }

  const results = await getMarketSentimentBulk(symbols);

  const overallScore = results.reduce((acc, r) => {
    const w = r.confidence;
    return acc + (r.direction === "BULL" ? w : r.direction === "BEAR" ? -w : 0);
  }, 0) / Math.max(1, results.length);

  const portfolioBias: "BULL" | "BEAR" | "NEUTRAL" =
    overallScore > 0.08 ? "BULL" : overallScore < -0.08 ? "BEAR" : "NEUTRAL";

  const portfolioBiasRatio = Math.max(0.5, Math.min(0.80, 0.5 + Math.abs(overallScore) * 2.5));

  res.json({
    symbols: results,
    portfolioBias,
    portfolioBiasRatio,
    fetchedAt: Date.now(),
  });
});

/** GET /api/bot/scan — parallel multi-symbol scan with adaptive ranking */
router.get("/bot/scan", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const engine = getEngine();

  const btcChangePct = req.query.btcChangePct !== undefined
    ? parseFloat(String(req.query.btcChangePct))
    : 0;
  const positionSideFilter = (req.query.positionSide as string | undefined) ?? "BOTH";

  const btcRegime: BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";

  const currentHourUtc = new Date().getUTCHours();

  // Which symbols to scan — if allowlist empty, nothing to scan
  const symbols = config.allowedSymbols.length > 0 ? config.allowedSymbols : [];

  if (symbols.length === 0) {
    res.json({
      scanTime: Date.now(),
      btcRegime,
      btcChangePct,
      currentHourUtc,
      symbols: [],
      candidateCount: 0,
      maxOrdersPerSecond: BINGX_RATE_LIMIT,
    });
    return;
  }

  // Determine which sides to evaluate. In BOTH mode we keep both sides visible
  // so the edge engine can choose contrarian scalp entries after extreme moves.
  const sides: PositionSide[] =
    positionSideFilter === "LONG" ? ["LONG"] :
    positionSideFilter === "SHORT" ? ["SHORT"] :
    ["LONG", "SHORT"];

  // Fetch tickers AND sentiment in parallel — both public endpoints
  const [tickerResults, sentimentResults] = await Promise.all([
    Promise.allSettled(
      symbols.map(async (sym) => {
        const url = `${BINGX_PUBLIC_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(sym)}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const json = await resp.json() as Record<string, unknown>;
        if (json.code !== 0) throw new Error(`ticker error ${sym}: ${json.msg}`);
        const d = (json.data as Record<string, unknown>) ?? {};
        return {
          symbol: sym,
          lastPrice: String(d.lastPrice ?? "0"),
          priceChangePct: parseFloat(String(d.priceChangePercent ?? "0")),
        };
      })
    ),
    getMarketSentimentBulk(symbols).catch(() => symbols.map((s) => ({
      symbol: s, direction: "NEUTRAL" as const, confidence: 0, biasRatio: 0.5,
      dominantSide: "NEUTRAL" as const, entryBias: { longWeight: 0.5, shortWeight: 0.5 },
      indicators: { vwapDeviation: 0, volumeDelta: 0, momentum4h: 0, momentum24h: 0,
        ema12vs24: "FLAT" as const, rangePosition: 0.5, bodyBias: 0, volumeTrend: "FLAT" as const,
        highLowBreak: "RANGE_BOUND" as const },
      candles24h: 0, fetchedAt: Date.now(),
    }))),
  ]);

  const sentimentBySymbol = new Map<string, SentimentResult>(
    sentimentResults.map((r) => [r.symbol, r])
  );

  // Build ScanSymbol entries for each symbol × each applicable side
  const scanSymbols: Array<{
    symbol: string;
    positionSide: PositionSide;
    lastPrice: string;
    priceChangePct: number;
    rankingScore: number;
    priorityScore: number;
    toxicityScore: number;
    ewmaWinRate: number;
    ev: number;
    samples: number;
    gatePass: boolean;
    gateRejects: string[];
    isCandidate: boolean;
    isToxic: boolean;
    sentiment?: {
      direction: string;
      confidence: number;
      biasRatio: number;
      dominantSide: string;
      aligned: boolean;
      longWeight: number;
      shortWeight: number;
      vwapDeviation: number;
      momentum24h: number;
    };
  }> = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const tickerResult = tickerResults[i];
    const ticker = tickerResult.status === "fulfilled" ? tickerResult.value : null;

    for (const side of sides) {
      const gateRejects: string[] = [];

      // Gate: hour blacklist
      if (config.hourBlacklist.includes(currentHourUtc)) {
        gateRejects.push(`HOUR_REJECT: UTC hour ${currentHourUtc} is blacklisted`);
      }

      // BTC regime is telemetry only. Do not reject LONG/SHORT by BULL/BEAR tag.

      // Get adaptive context
      const clusterKey: ClusterKey = { symbol: sym, positionSide: side, hourUtc: currentHourUtc, btcRegime };
      const signal = engine.contextSignal(clusterKey);
      const symProfile = engine.symbolProfile(sym);
      const clusterProfile = engine.clusterProfile(clusterKey);

      const isToxic = symProfile?.isToxic ?? false;
      const ev = clusterProfile?.ev ?? symProfile?.ev ?? 0;
      const ewmaWinRate = clusterProfile?.ewmaWinRate ?? (symProfile?.winRate ?? 0.5);
      const priorityScore = signal.priorityScore;
      const toxicityScore = signal.toxicityScore;

      // Gate: toxicity
      if (isToxic) {
        gateRejects.push(`TOXICITY_REJECT: ${sym} has negative realized PnL (${symProfile?.totalSamples ?? 0} trades)`);
      }

      // Gate: EV threshold
      if (config.evMinThreshold > 0 && signal.samples >= 10 && ev < config.evMinThreshold) {
        gateRejects.push(`EV_REJECT: EV ${ev.toFixed(4)} < threshold ${config.evMinThreshold.toFixed(4)}`);
      }

      const feeDragReject = feeDragRejectReason(ev, config.marginPerTrade, config);
      if (signal.samples >= 10 && feeDragReject) {
        gateRejects.push(feeDragReject);
      }

      // Gate: win rate
      if (config.winRateMin > 0 && signal.samples >= 10 && ewmaWinRate < config.winRateMin) {
        gateRejects.push(`WR_REJECT: WR ${(ewmaWinRate * 100).toFixed(1)}% < min ${(config.winRateMin * 100).toFixed(1)}%`);
      }

      // Gate: no ticker data
      if (!ticker) {
        gateRejects.push(`TICKER_FAIL: could not fetch price for ${sym}`);
      }

      const gatePass = gateRejects.length === 0;

      const sentiment = sentimentBySymbol.get(sym);
      const sentimentDirection = sentiment?.direction ?? "NEUTRAL";
      const sentimentBiasRatio = sentiment?.biasRatio ?? 0.5;
      const sentimentConfidence = sentiment?.confidence ?? 0;

      const sentimentAligned =
        (side === "LONG" && sentimentDirection === "BULL") ||
        (side === "SHORT" && sentimentDirection === "BEAR");
      const sentimentAdjustedRank = gatePass
        ? Math.max(0, engine.rankingScore(clusterKey, Math.max(0, ev)))
        : 0;

      scanSymbols.push({
        symbol: sym,
        positionSide: side,
        lastPrice: ticker?.lastPrice ?? "0",
        priceChangePct: ticker?.priceChangePct ?? 0,
        rankingScore: sentimentAdjustedRank,
        priorityScore,
        toxicityScore,
        ewmaWinRate,
        ev,
        samples: signal.samples,
        gatePass,
        gateRejects,
        isCandidate: gatePass,
        isToxic,
        sentiment: {
          direction: sentimentDirection,
          confidence: sentimentConfidence,
          biasRatio: sentimentBiasRatio,
          dominantSide: sentiment?.dominantSide ?? "NEUTRAL",
          aligned: sentimentAligned,
          longWeight: sentiment?.entryBias.longWeight ?? 0.5,
          shortWeight: sentiment?.entryBias.shortWeight ?? 0.5,
          vwapDeviation: sentiment?.indicators.vwapDeviation ?? 0,
          momentum24h: sentiment?.indicators.momentum24h ?? 0,
        },
      });
    }
  }

  // Sort by rankingScore descending, then by priorityScore
  scanSymbols.sort((a, b) => {
    if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore;
    return b.priorityScore - a.priorityScore;
  });

  const candidateCount = scanSymbols.filter((s) => s.isCandidate).length;

  // Portfolio-level directional bias from sentiment
  const sentimentScores = sentimentResults.map((r) => {
    const w = r.confidence;
    return r.direction === "BULL" ? w : r.direction === "BEAR" ? -w : 0;
  });
  const portfolioSentimentScore = sentimentScores.reduce((a, b) => a + b, 0) / Math.max(1, sentimentScores.length);
  const portfolioBias: "BULL" | "BEAR" | "NEUTRAL" =
    portfolioSentimentScore > 0.08 ? "BULL" : portfolioSentimentScore < -0.08 ? "BEAR" : "NEUTRAL";
  const portfolioBiasRatio = Math.max(0.5, Math.min(0.80, 0.5 + Math.abs(portfolioSentimentScore) * 2.5));
  const recommendedLongPct = portfolioBias === "BULL" ? portfolioBiasRatio : portfolioBias === "BEAR" ? 1 - portfolioBiasRatio : 0.5;

  res.json({
    scanTime: Date.now(),
    btcRegime,
    btcChangePct,
    currentHourUtc,
    symbols: scanSymbols,
    candidateCount,
    maxOrdersPerSecond: BINGX_RATE_LIMIT,
    portfolioBias,
    portfolioBiasRatio,
    recommendedLongPct,
    recommendedShortPct: 1 - recommendedLongPct,
  });
});

/**
 * GET /api/bot/edge
 *
 * Full Edge Telemetry for all target symbols — combines:
 *   1. CandleEdge: EMA9/21 cross, RSI14, ATR14, volume surge (real-time market)
 *   2. AdaptiveEngine: EWMA win rate, EV, priority/toxicity scores (learned telemetry)
 *   3. Combined edge score: adaptiveRanking × (0.60 + marketScore × 0.40)
 *
 * Equivalent to how the Rust runtime fuses priority_score + sizing_score + liquidity_distortion_score.
 *
 * Query params:
 *   interval  — candle interval: 1m | 3m | 5m | 15m  (default: 5m)
 *   btcChangePct — BTC % change for regime detection (default: 0)
 */
router.get("/bot/edge", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const engine = getEngine();

  const interval = (req.query.interval as CandleInterval | undefined) ?? "5m";
  const validIntervals: CandleInterval[] = ["1m", "3m", "5m", "15m"];
  const safeInterval: CandleInterval = validIntervals.includes(interval) ? interval : "5m";

  const btcChangePct = req.query.btcChangePct !== undefined
    ? parseFloat(String(req.query.btcChangePct))
    : 0;

  const btcRegime: BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";

  const currentHourUtc = new Date().getUTCHours();
  const symbols = config.allowedSymbols.length > 0 ? config.allowedSymbols : [];

  if (symbols.length === 0) {
    res.json({ edgeTime: Date.now(), btcRegime, currentHourUtc, interval: safeInterval, symbols: [] });
    return;
  }

  // Fetch candles for all symbols in parallel
  const candleEdges = await computeAllCandleEdges(symbols, safeInterval);

  // Build per-symbol edge report
  const edgeSymbols = symbols.map((sym, i) => {
    const candle = candleEdges[i];
    const adaptive = engine.edgeSummary(sym, currentHourUtc, btcRegime);

    // Combined scores for LONG and SHORT
    const longKey: ClusterKey = { symbol: sym, positionSide: "LONG", hourUtc: currentHourUtc, btcRegime };
    const shortKey: ClusterKey = { symbol: sym, positionSide: "SHORT", hourUtc: currentHourUtc, btcRegime };

    const longCombined  = engine.combinedEdgeScore(longKey,  adaptive.longEdge.ev,  candle.longScore);
    const shortCombined = engine.combinedEdgeScore(shortKey, adaptive.shortEdge.ev, candle.shortScore);

    // Best side from combined score
    const bestSide: PositionSide | "NEUTRAL" =
      longCombined > shortCombined && longCombined > 0.01 ? "LONG" :
      shortCombined > longCombined && shortCombined > 0.01 ? "SHORT" : "NEUTRAL";

    // ATR-based TP/SL suggestions (dynamic sizing like Rust's self_slippage_bps)
    const atrTpSuggestion  = candle.atr14 > 0 && candle.lastClose > 0
      ? parseFloat(((candle.atr14 * 1.5 / candle.lastClose) * 100).toFixed(3))
      : config.takeProfitPct;
    const atrSlSuggestion  = candle.atr14 > 0 && candle.lastClose > 0
      ? parseFloat(((candle.atr14 * 1.0 / candle.lastClose) * 100).toFixed(3))
      : config.stopLossPct;

    return {
      symbol: sym,
      // ── Market indicators (CandleEdge) ────────────────────────────────────
      market: {
        lastClose: candle.lastClose,
        interval: candle.interval,
        ema9: candle.ema9,
        ema21: candle.ema21,
        emaCross: candle.emaCross,
        emaCrossPct: parseFloat(candle.emaCrossPct.toFixed(4)),
        rsi14: parseFloat(candle.rsi14.toFixed(2)),
        atr14: candle.atr14,
        atrPct: parseFloat(candle.atrPct.toFixed(3)),
        volumeRatio: parseFloat(candle.volumeRatio.toFixed(2)),
        lastCandleMovePct: parseFloat(candle.lastCandleMovePct.toFixed(3)),
        recentMovePct: parseFloat(candle.recentMovePct.toFixed(3)),
        reversalScore: parseFloat(candle.reversalScore.toFixed(4)),
        longScore: parseFloat(candle.longScore.toFixed(4)),
        shortScore: parseFloat(candle.shortScore.toFixed(4)),
        suggestedSide: candle.suggestedSide,
        candleError: candle.error ?? null,
      },
      // ── Adaptive telemetry (learned from trade history) ───────────────────
      adaptive: {
        long: {
          samples: adaptive.longEdge.samples,
          ewmaWinRate: parseFloat((adaptive.longEdge.winRate * 100).toFixed(1)),
          ev: parseFloat(adaptive.longEdge.ev.toFixed(4)),
          priorityScore: parseFloat(adaptive.longEdge.priorityScore.toFixed(4)),
          toxicityScore: parseFloat(adaptive.longEdge.toxicityScore.toFixed(4)),
        },
        short: {
          samples: adaptive.shortEdge.samples,
          ewmaWinRate: parseFloat((adaptive.shortEdge.winRate * 100).toFixed(1)),
          ev: parseFloat(adaptive.shortEdge.ev.toFixed(4)),
          priorityScore: parseFloat(adaptive.shortEdge.priorityScore.toFixed(4)),
          toxicityScore: parseFloat(adaptive.shortEdge.toxicityScore.toFixed(4)),
        },
        symbol: adaptive.symbolProfile
          ? {
              totalSamples: adaptive.symbolProfile.totalSamples,
              netPnl: parseFloat(adaptive.symbolProfile.netPnl.toFixed(4)),
              winRate: parseFloat((adaptive.symbolProfile.winRate * 100).toFixed(1)),
              profitFactor: parseFloat(adaptive.symbolProfile.profitFactor.toFixed(2)),
              isToxic: adaptive.symbolProfile.isToxic,
              bestHour: adaptive.symbolProfile.bestHour,
              worstHour: adaptive.symbolProfile.worstHour,
            }
          : null,
      },
      // ── Combined edge (market × telemetry fusion) ─────────────────────────
      combined: {
        longScore:  parseFloat(longCombined.toFixed(6)),
        shortScore: parseFloat(shortCombined.toFixed(6)),
        bestSide,
        // ATR-driven dynamic TP/SL suggestion (% of price)
        atrTpSuggestionPct: atrTpSuggestion,
        atrSlSuggestionPct: atrSlSuggestion,
      },
    };
  });

  // Sort by max(longCombined, shortCombined) descending — best edge first
  edgeSymbols.sort((a, b) =>
    Math.max(b.combined.longScore, b.combined.shortScore) -
    Math.max(a.combined.longScore, a.combined.shortScore),
  );

  res.json({
    edgeTime: Date.now(),
    btcRegime,
    btcChangePct,
    currentHourUtc,
    interval: safeInterval,
    totalSymbols: symbols.length,
    globalTelemetry: (() => {
      const g = engine.globalState();
      return {
        totalTrades: g.totalTrades,
        ewmaWinRate: parseFloat((g.ewmaWinRate * 100).toFixed(1)),
        ewmaEv: parseFloat(g.ewmaEv.toFixed(4)),
        ewmaFeePerTrade: parseFloat(g.ewmaFeePerTrade.toFixed(4)),
      };
    })(),
    gateRecommendation: engine.gateRecommendation(),
    symbols: edgeSymbols,
  });
});

/** GET /api/bot/intelligence - consolidated operational view of Quant Brain. */
router.get("/bot/intelligence", async (req: Request, res: Response) => {
  try {
  const config = getBotConfig();
  const source = normalizeTelemetrySource(req.query.source);
  const engine = getTelemetryEngineForSource(source);
  const requestedSymbol = String(req.query.symbol ?? config.allowedSymbols[0] ?? "BTC-USDT").toUpperCase();
  const symbol = requestedSymbol.endsWith("-USDT") ? requestedSymbol : `${requestedSymbol}-USDT`;
  const positionSide: PositionSide = String(req.query.side ?? "LONG").toUpperCase() === "SHORT"
    ? "SHORT"
    : "LONG";
  const btcChangePct = Number(req.query.btcChangePct ?? 0);
  const btcRegime: BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";
  const hourUtc = new Date().getUTCHours();
  const clusterKey: ClusterKey = { symbol, positionSide, hourUtc, btcRegime };
  const cluster = engine.clusterProfile(clusterKey);
  const symbolProfile = engine.symbolProfile(symbol);
  const context = engine.contextSignal(clusterKey);

  // Shared QB deadline tracks the real intelligence timeout with a small buffer,
  // so the route does not mark QB offline before it has a chance to answer.
  const localTelemetryFallback = { recentOutcomes: engine.rawOutcomes() };
  const QB_DEADLINE_MS = Math.max(
    2_000,
    Math.min(5_000, Number(process.env["QUANT_BRAIN_INTELLIGENCE_TIMEOUT_MS"] ?? 4_000)) + 500,
  );
  const qbDeadline = new Promise<null>((r) => setTimeout(() => r(null), QB_DEADLINE_MS));

  // Timeout fallback for QB intelligence (allow = true so trades aren't hard-blocked)
  const gm = quantBrainGateMode();
  const intelligenceOnTimeout: QuantBrainIntelligence = {
    connected: false,
    enabled: true,
    gateMode: gm,
    checkedAt: Date.now(),
    edge: {
      allow: gm !== "enforce",
      available: false,
      contractVersion: "edge-v3",
      gateRejects: gm === "enforce" ? ["QB_TIMEOUT"] : [],
      score: null,
      calibratedProbability: null,
      uncertaintyType: "SERVICE_UNAVAILABLE",
      error: "intelligence timeout",
    },
    health: null,
    model: null,
    signalEdge: null,
    newsContext: null,
    errors: { service: `QB timeout (>${QB_DEADLINE_MS}ms)` },
  };

  const [intelligence, telemetryState] = await Promise.all([
    Promise.race([
      getQuantBrainIntelligence({
        symbol,
        side: positionSide === "LONG" ? "BUY" : "SELL",
        positionSide,
        hourUtc,
        btcChangePct,
        currentEv: cluster?.ev ?? symbolProfile?.ev ?? 0,
        currentWinRate: cluster?.ewmaWinRate ?? symbolProfile?.winRate ?? 0.5,
        currentProfitFactor: cluster?.profitFactor ?? symbolProfile?.profitFactor ?? 0,
        config,
      }),
      qbDeadline.then(() => intelligenceOnTimeout),
    ]),
    Promise.race([
      buildTelemetryState(source),
      qbDeadline.then(() => localTelemetryFallback),
    ]),
  ]);

  // Compute real stats from QB-merged outcomes (same source as Demo Analysis page)
  const recentOutcomes = (telemetryState as { recentOutcomes?: TradeOutcome[] }).recentOutcomes ?? [];

  // Helper: compute win rate + profit factor from a set of outcomes
  function computeStats(outcomes: typeof recentOutcomes) {
    const wins = outcomes.filter((o) => o.realizedPnl > 0);
    const losses = outcomes.filter((o) => o.realizedPnl <= 0);
    const totalWin = wins.reduce((s, o) => s + o.realizedPnl, 0);
    const totalLoss = Math.abs(losses.reduce((s, o) => s + o.realizedPnl, 0));
    return {
      samples: outcomes.length,
      winRate: outcomes.length > 0 ? wins.length / outcomes.length : null,
      profitFactor: totalLoss > 0 ? totalWin / totalLoss : wins.length > 0 ? 999 : null,
    };
  }

  const symbolOutcomes = recentOutcomes.filter(
    (o) => o.symbol === symbol && o.positionSide === positionSide,
  );
  const symbolStats = computeStats(symbolOutcomes);
  // Fall back to global stats when no symbol-specific data
  const globalStats = computeStats(recentOutcomes);

  const mergedSamples = symbolStats.samples > 0 ? symbolStats.samples : globalStats.samples;
  const mergedWinRate = symbolStats.winRate ?? globalStats.winRate;
  const mergedProfitFactor = symbolStats.profitFactor ?? globalStats.profitFactor;
  const mergedNetPnl = recentOutcomes.reduce((s, o) => s + o.realizedPnl, 0);

  res.json({
    symbol,
    positionSide,
    btcRegime,
    hourUtc,
    symbols: config.allowedSymbols,
    executionEnabled: config.allowExecution,
    telemetrySource: source,
    telemetry: {
      samples: mergedSamples > 0 ? mergedSamples : (context.samples ?? 0),
      priorityScore: context.priorityScore,
      toxicityScore: context.toxicityScore,
      ev: cluster?.ev ?? symbolProfile?.ev ?? 0,
      winRate: mergedWinRate !== null ? mergedWinRate : (cluster?.ewmaWinRate ?? symbolProfile?.winRate ?? 0.5),
      profitFactor: mergedProfitFactor !== null ? mergedProfitFactor : (cluster?.profitFactor ?? symbolProfile?.profitFactor ?? 0),
      netPnl: recentOutcomes.length > 0 ? mergedNetPnl : (symbolProfile?.netPnl ?? 0),
      isToxic: symbolProfile?.isToxic ?? false,
      totalOutcomes: recentOutcomes.length,
    },
    quantBrain: intelligence,
  });
  } catch (err) {
    const source = normalizeTelemetrySource(req.query.source);
    const requestedSymbol = String(req.query.symbol ?? "BTC-USDT").toUpperCase();
    const symbol = requestedSymbol.endsWith("-USDT") ? requestedSymbol : `${requestedSymbol}-USDT`;
    const positionSide: PositionSide = String(req.query.side ?? "LONG").toUpperCase() === "SHORT"
      ? "SHORT"
      : "LONG";
    const btcChangePct = Number(req.query.btcChangePct ?? 0);
    let config: ReturnType<typeof getBotConfig> | null = null;
    try {
      config = getBotConfig();
    } catch {
      config = null;
    }
    const btcRegime: BtcRegime = config
      ? btcChangePct >= config.btcRegimeThresholdPct ? "BULL"
        : btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR"
          : "NEUTRAL"
      : "NEUTRAL";
    const gateMode = quantBrainGateMode();
    const message = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, symbol, positionSide }, "bot intelligence degraded fallback");
    res.status(200).json({
      symbol,
      positionSide,
      btcRegime,
      hourUtc: new Date().getUTCHours(),
      symbols: config?.allowedSymbols ?? [symbol],
      executionEnabled: config?.allowExecution ?? false,
      telemetrySource: source,
      telemetry: {
        samples: 0,
        priorityScore: 0,
        toxicityScore: 0,
        ev: 0,
        winRate: 0.5,
        profitFactor: 0,
        netPnl: 0,
        isToxic: false,
        totalOutcomes: 0,
      },
      quantBrain: {
        connected: false,
        enabled: true,
        gateMode,
        checkedAt: Date.now(),
        edge: {
          allow: gateMode !== "enforce",
          available: false,
          contractVersion: "edge-v3",
          gateRejects: gateMode === "enforce" ? [`QB_INTELLIGENCE_ERROR: ${message}`] : [],
          score: null,
          calibratedProbability: null,
          uncertaintyType: "SERVICE_UNAVAILABLE",
          error: message,
        },
        health: null,
        model: null,
        signalEdge: null,
        newsContext: null,
        errors: { service: message },
      },
    });
  }
});

// ── Bot Modes ─────────────────────────────────────────────────────────────────

/** GET /api/bot/modes — list all available mode presets */
router.get("/bot/modes", (_req: Request, res: Response) => {
  res.json({
    modes: Object.values(BOT_MODES),
    activeMode: getActiveModeId(),
  });
});

/** POST /api/bot/mode — activate a mode (applies runtime overrides) */
router.post("/bot/mode", requireAdminAuthorization, (req: Request, res: Response) => {
  const { mode } = req.body as { mode: string };
  if (!mode || !(mode in BOT_MODES)) {
    res.status(400).json({
      error: `Unknown mode: "${mode}". Valid: ${Object.keys(BOT_MODES).join(", ")}`,
    });
    return;
  }
  const id = mode as BotModeId;
  const preset = BOT_MODES[id];
  setActiveModeId(id);
  setConfigOverrides({
    leverage: preset.leverage,
    marginPerTrade: preset.marginPerTrade,
    marginType: preset.marginType,
  });
  req.log.info({ mode: id, preset }, "bot mode activated");
  res.json({ activeMode: id, preset, config: getBotConfig() });
});

/** POST /api/bot/mode/reset — clear active mode and related overrides */
router.post("/bot/mode/reset", requireAdminAuthorization, (_req: Request, res: Response) => {
  clearActiveMode();
  resetConfigOverrides();
  res.json({ activeMode: null, config: getBotConfig() });
});

// ── Shared order executor (gate checks + BingX call) ─────────────────────────
// capitalCtx — optional pre-fetched capital snapshot for mass/bulk execution.
// If provided, skips the per-order positions+balance fetch (big latency win).

const QB_SNIPER_TIMEOUT_MS = Math.max(
  400,
  Number(process.env["QB_SNIPER_TIMEOUT_MS"] ?? 600),
);
const QB_ORDER_TIMEOUT_MS = Math.max(
  400,
  Number(process.env["QB_ORDER_TIMEOUT_MS"] ?? process.env["QB_SNIPER_TIMEOUT_MS"] ?? 600),
);

async function executeSingleOrder(
  item: BulkOrderItem,
  index: number,
  creds: ExecutionCredentials,
  config: ReturnType<typeof getBotConfig>,
  preGateRejects: string[] = [],
  capitalCtx?: CapitalContext,
  executionCtx: { readinessStatus?: LiveReadinessStatus } = {},
): Promise<BulkOrderResult> {
  const t0 = Date.now();
  const { symbol, side, positionSide, btcChangePct } = item;
  let orderMargin = item.marginOverride ?? config.marginPerTrade;
  let orderLeverage = Math.max(1, Math.round(item.leverageOverride ?? config.leverage));
  const gateRejects: string[] = [...preGateRejects];
  const currentHour = new Date().getUTCHours();
  const killSwitch = evaluateLiveKillSwitch({
    config,
    btcChangePct,
    capitalCtx,
    maxSessionLossRemaining: config.maxSessionLoss,
    integrityOk: true,
  });
  if (!killSwitch.entryAllowed) {
    return killSwitchReject(item, index, killSwitch, t0);
  }
  config = applyKillSwitchToConfig(config, killSwitch);
  orderMargin = item.marginOverride ?? config.marginPerTrade;
  const playbook = item.playbook ?? "MOMENTUM_BREAKOUT_SCALP";
  let readinessScopeId: string | undefined;
  let promotionState: PromotionState | undefined;
  const candle = item.marketEventId ? null : await computeCandleEdge(symbol, "5m");
  const marketEventId = item.marketEventId ?? candle?.marketEventId;
  const featureTimestampMs = item.featureTimestampMs ?? candle?.candleCloseTimeMs;
  const candleIsComplete = item.candleIsComplete ?? candle?.candleIsComplete;
  if (candle) gateRejects.push(...candleConfirmationRejects(candle, positionSide, config));
  if (!marketEventId) {
    gateRejects.push("MARKET_EVENT_REJECT: canonical completed candle event is unavailable");
  }
  if (candleIsComplete !== true) {
    gateRejects.push("INCOMPLETE_CANDLE_REJECT: live execution requires a completed candle");
  }
  if (!Number.isSafeInteger(featureTimestampMs) || (featureTimestampMs ?? 0) <= 0) {
    gateRejects.push("FEATURE_TIMESTAMP_REJECT: feature timestamp is unavailable");
  } else if ((featureTimestampMs ?? 0) > Date.now()) {
    gateRejects.push("FEATURE_TIMESTAMP_REJECT: feature timestamp is in the future");
  }

  // Gate: symbol allowlist
  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(symbol)) {
    gateRejects.push(`SYMBOL_REJECT: ${symbol} not in allowlist`);
  }
  // Gate: hour blacklist
  if (config.hourBlacklist.includes(currentHour)) {
    gateRejects.push(`HOUR_REJECT: UTC hour ${currentHour} is blacklisted`);
  }
  // BTC regime is telemetry only. Entry direction is enforced by candle/edge gates.

  const feeDragReject = feeDragRejectReason(item.currentEv, orderMargin, { ...config, marginPerTrade: orderMargin, leverage: orderLeverage });
  if (feeDragReject) gateRejects.push(feeDragReject);

  // ── Capital gate (use pre-fetched context if available) ───────────────────
  const ctx = capitalCtx ?? await fetchCapitalContext(creds).catch(() => null);

  if (!ctx && config.allowExecution) {
    gateRejects.push("CAPITAL_CONTEXT_REJECT: live capital snapshot unavailable");
  }

  if (ctx) {
    if (ctx.openPositionsCount >= config.maxConcurrentPositions) {
      gateRejects.push(`CAPITAL_REJECT: ${ctx.openPositionsCount} positions >= max ${config.maxConcurrentPositions}`);
    }
    if (ctx.marginUtilization > config.maxMarginUtilization) {
      gateRejects.push(`MARGIN_REJECT: ${(ctx.marginUtilization * 100).toFixed(1)}% > max ${(config.maxMarginUtilization * 100).toFixed(0)}%`);
    }
    // Stacking / hedging
    const symUpper = symbol.toUpperCase();
    const counts = ctx.countsBySide.get(symUpper) ?? { LONG: 0, SHORT: 0 };
    const sameSide = counts[positionSide];
    const oppSide = counts[positionSide === "LONG" ? "SHORT" : "LONG"];
    if (config.preventHedgedPositions && oppSide > 0) {
      gateRejects.push(`HEDGE_REJECT: ${symbol} has ${oppSide} open ${positionSide === "LONG" ? "SHORT" : "LONG"} position(s)`);
    }
    const stackLimit = driftAdjustedStackLimit(config);
    if (stackLimit === 0) {
      gateRejects.push("DRIFT_PAUSED_REJECT: drift policy blocks new entries");
    }
    if (sameSide >= stackLimit) {
      gateRejects.push(`STACK_REJECT: ${symbol} ${positionSide} at limit ${sameSide}/${stackLimit}`);
    }
    gateRejects.push(...portfolioRiskRejectsForOrder({
      ctx,
      config,
      symbol,
      positionSide,
      margin: orderMargin,
      leverage: orderLeverage,
      playbook,
      btcChangePct,
      sizing: item.sizing as PositionSizingDecision | undefined,
    }));
  }

  // ── QB gate — hard 600ms cap so sniper is never held hostage ──────────────
  if (config.allowExecution) {
    const sameSideOpen = ctx?.countsBySide.get(symbol.toUpperCase())?.[positionSide] ?? 0;
    const readinessStatus = executionCtx.readinessStatus ?? await getCachedLiveReadinessStatus(config);
    const btcRegimeForReadiness: BtcRegime | null = btcChangePct === undefined
      ? null
      : btcChangePct >= config.btcRegimeThresholdPct
        ? "BULL"
        : btcChangePct <= -config.btcRegimeThresholdPct
          ? "BEAR"
          : "NEUTRAL";
    const readiness = evaluateLiveReadinessForOrder({
      status: readinessStatus,
      order: {
        symbol,
        side,
        positionSide,
        playbook,
        btcRegime: btcRegimeForReadiness,
        score: item.currentEv,
        context: item.context,
        stackingDepth: item.stackingDepth,
        exitPolicy: item.exitPolicy,
        positionSizingTier: item.positionSizingTier,
      },
      config,
      openSameSidePositions: sameSideOpen,
    });
    readinessScopeId = readiness.readinessScopeId ?? undefined;
    promotionState = readiness.promotionState;
    if (!readiness.allowed) {
      gateRejects.push(...readiness.gateRejects);
    } else {
      orderMargin = Math.min(orderMargin, readiness.maxMargin);
    }
  }

  const qbMode = quantBrainGateMode();
  const signalId = randomUUID();
  const signalCreatedAt = Date.now();
  let predictionTimestamp: number | undefined;
  let predictionId: string | undefined;
  let qbEvaluatedAt: number | undefined;
  // Exhaustion Trigger fields — populated from QB enforce result
  let qbExecutionType: "TRIGGER_LIMIT" | "MARKET" | undefined;
  let qbTriggerPrice: number | null | undefined;
  let qbTriggerExpirationSeconds = parseInt(process.env["TRIGGER_EXPIRATION_SECONDS"] ?? "45", 10);
  let qbExhaustionType: string | undefined;
  const expiresAt = Date.now() + 30_000; // 30s — signal must be evaluated before expiry
  if (qbMode === "enforce") {
    try {
      const [sentiment, qbResult] = await Promise.all([
        getMarketSentiment(symbol).catch(() => null),
        Promise.race([
          evaluateQuantBrainEdge({
            symbol, side, positionSide, hourUtc: currentHour,
            btcChangePct, currentEv: item.currentEv, config,
            costModel: estimateExecutionCosts(
              orderMargin,
              orderLeverage,
              config.takerFeeBps / 10_000,
              undefined,
              undefined,
              {
                takeProfitPct: config.takeProfitPct,
                stopLossPct: config.stopLossPct,
                grossEv: item.currentEv,
                slippageBpsPerSide: config.slippageBpsPerSide,
                fundingCostPct: config.estimatedFundingCostPct,
                minEdgeOverCostPct: config.minEdgeOverCostPct,
              },
            ),
            signalId, marketEventId, expiresAt, featureVersion: "sniper-v1",
            featureTimestampMs, candleIsComplete, marketDataSource: "bingx",
            referencePrice: candle?.lastClose,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("QB_TIMEOUT")), QB_SNIPER_TIMEOUT_MS),
          ),
        ]),
      ]);
      void sentiment; // used only for QB enrichment below if needed
      predictionTimestamp = qbResult.predictionTimestamp;
      predictionId = qbResult.predictionId;
      qbEvaluatedAt = Date.now();
      if (!qbResult.allow) {
        gateRejects.push(...qbResult.gateRejects.map((r) => `QB_${r}`));
      }
      // Capture exhaustion trigger recommendation from microframe intelligence
      if (
        qbResult.executionType === "TRIGGER_LIMIT" &&
        typeof qbResult.triggerPrice === "number" &&
        qbResult.triggerPrice > 0
      ) {
        qbExecutionType = "TRIGGER_LIMIT";
        qbTriggerPrice = qbResult.triggerPrice;
        qbTriggerExpirationSeconds = qbResult.triggerExpirationSeconds ?? qbTriggerExpirationSeconds;
        const regime = qbResult.microframeRegime as Record<string, unknown> | undefined;
        qbExhaustionType = regime?.exhaustionType as string | undefined;
      }
    } catch (err) {
      gateRejects.push(`QB_ENFORCE_REJECT: ${err instanceof Error ? err.message : "Quant Brain unavailable"}`);
    }
  } else {
    // Shadow: fire-and-forget — never waits
    Promise.resolve().then(() =>
      getMarketSentiment(symbol).catch(() => null).then((sentiment) =>
        evaluateQuantBrainEdge({
          symbol, side, positionSide, hourUtc: currentHour,
          btcChangePct, currentEv: item.currentEv, config,
          costModel: estimateExecutionCosts(
            orderMargin,
            orderLeverage,
            config.takerFeeBps / 10_000,
            undefined,
            undefined,
            {
              takeProfitPct: config.takeProfitPct,
              stopLossPct: config.stopLossPct,
              grossEv: item.currentEv,
              slippageBpsPerSide: config.slippageBpsPerSide,
              fundingCostPct: config.estimatedFundingCostPct,
              minEdgeOverCostPct: config.minEdgeOverCostPct,
            },
          ),
          signalId, marketEventId, expiresAt, featureVersion: "sniper-v1",
          featureTimestampMs, candleIsComplete, marketDataSource: "bingx",
          referencePrice: candle?.lastClose,
          sentimentContext: sentiment ? {
            direction: sentiment.direction, confidence: sentiment.confidence,
            biasRatio: sentiment.biasRatio, dominantSide: sentiment.dominantSide,
            vwapDeviation: sentiment.indicators.vwapDeviation,
            volumeDelta: sentiment.indicators.volumeDelta,
            momentum24h: sentiment.indicators.momentum24h,
          } : undefined,
        }).catch(() => {})
      )
    );
  }

  // Observation mode short-circuit
  if (!config.allowExecution) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: null, gateRejects, observationMode: true,
      message: gateRejects.length > 0
        ? `BLOCKED by ${gateRejects.length} gate(s). Observation mode.`
        : "All gates pass. Observation mode — set SCALP_ALLOW_EXECUTION=true.",
      durationMs: Date.now() - t0,
    };
  }

  try {
    assertLiveExecutionAllowed(creds);
  } catch (err) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: null,
      gateRejects: ["LIVE_ENVIRONMENT_REJECT"],
      observationMode: false,
      message: err instanceof Error ? err.message : "Real-money execution refused.",
      durationMs: Date.now() - t0,
    };
  }

  // Gate blocked
  if (gateRejects.length > 0) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: null, gateRejects, observationMode: false,
      message: `REJECTED: ${gateRejects[0]}`,
      durationMs: Date.now() - t0,
    };
  }

  // Compute qty from mark price (use pre-fetched price hint if available via item)
  // When using a trigger limit, triggerPrice IS the intended entry — use it directly.
  const useTriggerLimit =
    qbExecutionType === "TRIGGER_LIMIT" &&
    qbTriggerPrice != null &&
    qbTriggerPrice > 0;

  let expectedEntryPrice = item.expectedEntryPrice ?? 0;
  let qty = item.quantity;
  if (useTriggerLimit && qbTriggerPrice != null && qbTriggerPrice > 0) {
    expectedEntryPrice = qbTriggerPrice;
    if (!qty) qty = Math.floor((orderMargin * orderLeverage) / qbTriggerPrice * 1000) / 1000;
  } else if (!qty || expectedEntryPrice <= 0) {
    try {
      const url = `${BINGX_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}&timestamp=${Date.now()}`;
      const json = (await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()) as Record<string, unknown>;
      if (json.code === 0) {
        const d = (json.data as Record<string, string>) ?? {};
        const markPrice = parseFloat(d.lastPrice ?? "0");
        if (markPrice > 0) {
          expectedEntryPrice = markPrice;
          if (!qty) qty = Math.floor((orderMargin * orderLeverage) / markPrice * 1000) / 1000;
        }
      }
    } catch { /* fallthrough */ }
  }

  if (!qty || qty <= 0) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: null, gateRejects: ["QTY_REJECT: could not compute quantity"],
      observationMode: false, message: "Could not determine order quantity.",
      durationMs: Date.now() - t0,
    };
  }

  if (!marketEventId || !claimMarketEventExecution(marketEventId, positionSide)) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: qty, gateRejects: ["DUPLICATE_EXECUTION_REJECT: candle event already executed"],
      observationMode: false, message: "Duplicate candle execution rejected.",
      durationMs: Date.now() - t0,
    };
  }

  // Place order
  const clientOrderId = deterministicClientOrderId({ symbol, side, positionSide, marketEventId });
  try {
    recordPredictionExecutionAge(predictionTimestamp);
    const orderRequestedAt = Date.now();
    const orderSentAt = orderRequestedAt;
    // When QB detects microframe exhaustion, place a LIMIT order at triggerPrice
    // instead of an immediate MARKET order — catching the reversal at the exact
    // mathematical turning point (sell exhaustion → LONG, buy exhaustion → SHORT).
    const baseOrderParams: Record<string, string | number> = {
      symbol,
      side,
      positionSide,
      type: useTriggerLimit ? "LIMIT" : config.orderType,
      quantity: qty,
      leverage: orderLeverage,
      clientOrderID: clientOrderId,
      ...(useTriggerLimit && qbTriggerPrice != null ? { price: qbTriggerPrice } : {}),
    };
    const protection = withEntryProtection(baseOrderParams, expectedEntryPrice, positionSide, config);
    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      protection.orderParams,
      creds.apiKey, creds.secretKey,
    );
    const orderAckAt = Date.now();
    if (data.code !== 0) {
      releaseMarketEventExecution(marketEventId, positionSide);
      recordKillSwitchExecutionAttempt({
        placed: false,
        latencyMs: orderAckAt - orderSentAt,
        failedAck: true,
        failedConfirmation: false,
        slippagePctNotional: 0,
        message: String(data.msg ?? "BingX order error"),
      });
      return {
        index, symbol, side, placed: false, orderId: null,
        quantity: qty, gateRejects: [], observationMode: false,
        message: `BingX error: ${(data.msg as string) ?? "unknown"}`,
        durationMs: Date.now() - t0,
      };
    }
    const order = ((data.data as Record<string, unknown>)?.order ?? {}) as Record<string, unknown>;
    const placedOrderId = String(order.orderId ?? "");
    const executedPrice = Number(order.avgPrice ?? order.price ?? 0);
    const notional = executedPrice > 0 ? executedPrice * qty : 0;
    const adverseSlip = expectedEntryPrice > 0 && executedPrice > 0
      ? Math.max(0, positionSide === "LONG" ? executedPrice - expectedEntryPrice : expectedEntryPrice - executedPrice) * qty
      : 0;
    recordKillSwitchExecutionAttempt({
      placed: Boolean(placedOrderId),
      latencyMs: orderAckAt - orderSentAt,
      failedAck: false,
      failedConfirmation: !placedOrderId,
      slippagePctNotional: notional > 0 ? adverseSlip / notional : 0,
      message: placedOrderId ? "order placed" : "order ack missing id",
    });

    if (!placedOrderId) {
      return {
        index, symbol, side, placed: false, orderId: null,
        quantity: qty,
        gateRejects: ["ORDER_ACK_AMBIGUOUS: BingX accepted request but did not return orderId"],
        observationMode: false,
        message: "Ambiguous BingX ACK; market event remains claimed until reconciliation confirms the exchange state.",
        durationMs: Date.now() - t0,
      };
    }

    // Register entry for autonomous outcome recording — watcher polls BingX
    // every LIVE_WATCHER_POLL_MS and records the outcome when the position closes.
    if (placedOrderId) {
      const sizingDecision = item.sizing as PositionSizingDecision | undefined;
      const liveRiskTier: PositionRiskTier | undefined =
        sizingDecision?.riskTier === "NO_TRADE" ? undefined : sizingDecision?.riskTier;
      updateWatcherCreds(creds);
      const btcRegimeForEntry: import("../lib/adaptiveEngine").BtcRegime =
        (item.btcChangePct ?? 0) >= config.btcRegimeThresholdPct ? "BULL" :
        (item.btcChangePct ?? 0) <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";
      registerLiveEntry({
        entryOrderId: placedOrderId,
        symbol,
        positionSide,
        side,
        expectedEntryPrice,
        qty: qty!,
        leverage: orderLeverage,
        marginUsed: orderMargin,
        btcRegime: btcRegimeForEntry,
        hourUtc: currentHour,
        entryTime: orderAckAt,
        expectedTpProfit: orderMargin * orderLeverage * (config.takeProfitPct / 100),
        takeProfitPct: config.takeProfitPct,
        stopLossPct: config.stopLossPct,
        riskTier: liveRiskTier,
        sizeMultiplier: sizingDecision?.sizeMultiplier,
        sizeReason: sizingDecision?.reason,
        recommendedMargin: sizingDecision?.recommendedMargin,
        recommendedLeverage: sizingDecision?.recommendedLeverage,
        maxLossIfStop: sizingDecision?.maxLossIfStop,
        notional: sizingDecision?.notional,
        signalId,
        marketEventId,
        clientOrderId,
        predictionId,
        featureVersion: "sniper-v1",
        ...liveEntryPolicyProvenance(),
        signalCreatedAt,
        qbEvaluatedAt,
        orderRequestedAt,
        orderSentAt,
        orderAckAt,
        positionConfirmedAt: orderAckAt,
        protectionAttachedAt: protection.protectionAttached ? orderAckAt : undefined,
        orderType: useTriggerLimit ? "LIMIT" : config.orderType,
        playbook,
        readinessScopeId,
        promotionState,
        stackingDepth: item.stackingDepth,
        exitPolicy: item.exitPolicy ?? protection.riskMode,
      });

      // Arm expiry timer for LIMIT orders placed by Exhaustion Trigger system.
      // If price never reaches triggerPrice within the TTL window, cancel the
      // open order so it doesn't linger and fill at a stale price.
      if (useTriggerLimit && qbTriggerPrice != null) {
        armLimitOrderExpiry({
          orderId: placedOrderId,
          symbol,
          direction: positionSide as "LONG" | "SHORT",
          triggerPrice: qbTriggerPrice,
          exhaustionType: qbExhaustionType,
          expirationMs: qbTriggerExpirationSeconds * 1_000,
          cancelFn: async () => {
            await bingxPost(
              "/openApi/swap/v2/trade/cancel",
              { symbol, orderId: placedOrderId },
              creds.apiKey,
              creds.secretKey,
            ).catch(() => {});
          },
        });
      }
    }

    return {
      index, symbol, side, placed: true, orderId: placedOrderId,
      quantity: qty, gateRejects: [], observationMode: false,
      message: `Placed: ${side} ${qty} ${symbol}`,
      sizing: item.sizing,
      protectionAttached: protection.protectionAttached,
      riskMode: protection.riskMode,
      protectionStopPrice: protection.protectionStopPrice,
      protectionTakeProfitPrice: protection.protectionTakeProfitPrice,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    recordKillSwitchExecutionAttempt({
      placed: false,
      latencyMs: Date.now() - t0,
      failedAck: true,
      failedConfirmation: false,
      slippagePctNotional: 0,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: qty, gateRejects: [], observationMode: false,
      message: `Execution error after clientOrderID ${clientOrderId}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t0,
    };
  }
}

// ── Sniper: Mass execution endpoint ──────────────────────────────────────────

/**
 * POST /api/bot/sniper/mass
 *
 * Takes pre-scored scan candidates and fires them all in one low-latency
 * burst. Key optimization: capital (positions + balance) is fetched once
 * and shared across all orders — avoids N×2 BingX calls.
 *
 * Body: { candidates: Array<{ symbol, positionSide, combinedScore?, currentEv?, btcChangePct? }>, ordersPerSecond? }
 */
router.post("/sniper/risk/simulate-cycle", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  let config = getBotConfig();
  if (req.body?.config && typeof req.body.config === "object") {
    config = { ...config, ...(req.body.config as Partial<ReturnType<typeof getBotConfig>>) };
  }
  const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates as BulkOrderItem[] : [];
  if (candidates.length === 0) {
    res.status(400).json({ error: "candidates must be a non-empty array" });
    return;
  }
  if (candidates.length > 50) {
    res.status(400).json({ error: "Max 50 candidates per simulation" });
    return;
  }

  const capitalCtx = capitalContextFromRequest(req.body?.capital)
    ?? (creds ? await fetchCapitalContext(creds).catch(() => null) : null);
  if (!capitalCtx) {
    res.status(200).json({
      approved: [],
      rejected: candidates.map((candidate, index) => ({
        index,
        symbol: candidate.symbol,
        positionSide: candidate.positionSide,
        reasons: ["CAPITAL_CONTEXT_REJECT: capital snapshot unavailable"],
      })),
      recommendedSafeBatch: [],
      capitalSnapshot: null,
      riskTotals: null,
    });
    return;
  }

  const correlationRejects = buildBulkCorrelationRejects(candidates, maxCorrelatedBulkOrders());
  const approved: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const margin = candidate.marginOverride ?? config.marginPerTrade;
    const leverage = Math.max(1, Math.round(candidate.leverageOverride ?? config.leverage));
    const reasons = [
      ...(correlationRejects.get(index) ?? []),
      ...portfolioRiskRejectsForOrder({
        ctx: capitalCtx,
        config,
        symbol: candidate.symbol,
        positionSide: candidate.positionSide,
        margin,
        leverage,
        playbook: candidate.playbook,
        btcChangePct: candidate.btcChangePct,
        sizing: candidate.sizing as PositionSizingDecision | undefined,
      }),
    ];
    const riskIncrement = margin * leverage * (Math.max(0.01, config.stopLossPct) / 100);
    const row = {
      index,
      symbol: candidate.symbol,
      side: candidate.side,
      positionSide: candidate.positionSide,
      playbook: candidate.playbook ?? "MOMENTUM_BREAKOUT_SCALP",
      btcChangePct: candidate.btcChangePct,
      margin,
      leverage,
      notional: margin * leverage,
      riskIncrement,
      reasons,
    };
    if (reasons.length > 0) {
      rejected.push(row);
      continue;
    }
    approved.push(row);
    projectOrderIntoCapitalContext(capitalCtx, {
      symbol: candidate.symbol,
      positionSide: candidate.positionSide,
      margin,
      leverage,
    });
  }

  res.json({
    approved,
    rejected,
    recommendedSafeBatch: approved,
    capitalSnapshot: {
      openPositions: capitalCtx.openPositionsCount,
      marginUtilization: capitalCtx.marginUtilization,
      equity: capitalCtx.equity,
      availableMargin: capitalCtx.availableMargin,
    },
    riskTotals: summarizeCapitalRisk(capitalCtx, config),
  });
});

router.post("/bot/sniper/mass", requireAdminAuthorization, async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) { res.status(401).json({ error: "Not connected." }); return; }

  const { candidates, ordersPerSecond = 10 } = req.body as {
    candidates: Array<{
      symbol: string;
      positionSide: "LONG" | "SHORT";
      combinedScore?: number;
      aggressiveScore?: number;
      calibratedScore?: number;
      calibratedProbability?: number | null;
      expectedValuePct?: number;
      optimalThreshold?: number;
      profitabilityVerified?: boolean;
      kellyFraction?: number;
      mlSizingMultiplier?: number;
      currentEv?: number;
      btcChangePct?: number;
    }>;
    ordersPerSecond?: number;
  };

  if (!Array.isArray(candidates) || candidates.length === 0) {
    res.status(400).json({ error: "candidates must be a non-empty array" });
    return;
  }
  if (candidates.length > 30) {
    res.status(400).json({ error: "Max 30 candidates per mass request" });
    return;
  }

  let config = getBotConfig();
  const t0 = Date.now();

  // Pre-fetch capital once for ALL orders
  const capitalCtx = await fetchCapitalContext(creds).catch(() => null);
  const firstBtcChangePct = candidates[0]?.btcChangePct;
  const initialBtcRegime: BtcRegime = firstBtcChangePct !== undefined
    ? firstBtcChangePct >= config.btcRegimeThresholdPct ? "BULL"
      : firstBtcChangePct <= -config.btcRegimeThresholdPct ? "BEAR"
      : "NEUTRAL"
    : "NEUTRAL";
  const killSwitch = evaluateLiveKillSwitch({
    config,
    btcRegime: Math.abs(firstBtcChangePct ?? 0) >= 2.5 ? "HIGH_VOLATILITY_CHAOS" : initialBtcRegime,
    btcChangePct: firstBtcChangePct,
    capitalCtx,
    maxSessionLossRemaining: config.maxSessionLoss,
    integrityOk: capitalCtx !== null,
  });
  if (!killSwitch.entryAllowed) {
    res.status(200).json({
      total: candidates.length,
      filtered: 0,
      attempted: 0,
      placed: 0,
      rejected: candidates.length,
      skippedNoHeadroom: 0,
      skippedBelowScore: 0,
      skippedByRotation: 0,
      killSwitch,
      durationMs: Date.now() - t0,
      results: [],
    });
    return;
  }
  config = applyKillSwitchToConfig(config, killSwitch);
  const rotation = await buildSymbolRotationReport({
    symbols: Array.from(new Set(candidates.map((candidate) => candidate.symbol))),
    engine: getEngine(),
    config,
    btcRegime: initialBtcRegime,
    hourUtc: new Date().getUTCHours(),
    openCountsBySymbol: openCountsBySymbolFromCapital(capitalCtx),
  });
  const rotationBySymbol = rotationRankBySymbol(rotation);

  const rps = Math.min(Math.max(1, ordersPerSecond), 10);
  const bucket = new TokenBucket(rps, rps);

  const scored = candidates.map((candidate) => {
    const rank = rotationBySymbol.get(candidate.symbol.toUpperCase());
    const baseScore = candidate.aggressiveScore ?? candidate.combinedScore ?? 1;
    const mlProbability = typeof candidate.calibratedProbability === "number"
      ? Math.max(0, Math.min(1, candidate.calibratedProbability))
      : undefined;
    const mlWeight = mlProbability === undefined
      ? 0
      : Math.max(0, Math.min(0.30, Number(process.env["SNIPER_ML_SCORE_WEIGHT"] ?? 0.25)));
    const mlScore = candidate.calibratedScore ?? mlProbability;
    const authorityScore = mlScore === undefined ? baseScore : baseScore * (1 - mlWeight) + mlScore * mlWeight;
    const sideFactor =
      !rank || rank.sideBias === "NEUTRAL" || rank.sideBias === candidate.positionSide ? 1 : 0.72;
    return {
      ...candidate,
      rotationRank: rank,
      effectiveScore: authorityScore * (rank?.rotationScore ?? 0.5) * sideFactor,
    };
  });
  const btcRegime: BtcRegime = initialBtcRegime;
  const aggression = evaluateAggression({
    config,
    outcomes: exportAllOutcomes().filter((outcome) => !isDemoOutcome(outcome)),
    serviceState: getServiceState(),
    candidates: scored.map((candidate) => ({
      symbol: candidate.symbol,
      positionSide: candidate.positionSide,
      score: candidate.effectiveScore,
      rankingScore: candidate.rotationRank?.rotationScore,
    })),
    btcRegime,
    btcChangePct: candidates[0]?.btcChangePct,
    openPositionsCount: capitalCtx?.openPositionsCount ?? 0,
    maxOpenPositions: config.maxConcurrentPositions,
    dataFresh: true,
    apiHealthy: capitalCtx !== null,
    executionHealthy: true,
    source: "live",
  });
  const aggressiveConfig = applyAggressionToConfig(config, aggression);

  // Sort by aggressiveScore * rotationScore; paused symbols never fire.
  const sorted = scored
    .filter((c) => (c.combinedScore ?? c.aggressiveScore ?? 1) >= aggressiveConfig.sniperMinCombinedScore)
    .filter((c) => c.effectiveScore >= aggression.minAggressiveScore)
    .filter((c) => c.rotationRank?.state !== "PAUSED")
    .sort((a, b) => b.effectiveScore - a.effectiveScore);

  // Headroom check
  const currentOpen = capitalCtx?.openPositionsCount ?? 0;
  const headroom = config.maxConcurrentPositions - currentOpen;
  const selectedBySymbol = new Map<string, number>();
  const toFire: typeof sorted = [];
  for (const candidate of sorted) {
    if (toFire.length >= Math.max(0, Math.min(headroom, aggression.maxCandidatesThisCycle, aggression.maxPositionsThisCycle))) break;
    const symbol = candidate.symbol.toUpperCase();
    const rank = candidate.rotationRank;
    const maxPositions = Math.min(rank?.maxPositions ?? 1, aggression.symbolConcentrationLimit);
    const openCounts = capitalCtx?.countsBySide.get(symbol) ?? { LONG: 0, SHORT: 0 };
    const openForSymbol = openCounts.LONG + openCounts.SHORT;
    const selectedForSymbol = selectedBySymbol.get(symbol) ?? 0;
    if (openForSymbol + selectedForSymbol >= maxPositions) continue;
    selectedBySymbol.set(symbol, selectedForSymbol + 1);
    toFire.push(candidate);
  }

  const results: BulkOrderResult[] = [];
  const correlationRejects = buildBulkCorrelationRejects(
    toFire.map((c) => ({
      symbol: c.symbol,
      side: c.positionSide === "LONG" ? "BUY" as const : "SELL" as const,
      positionSide: c.positionSide,
      btcChangePct: c.btcChangePct,
    })),
    maxCorrelatedBulkOrders(),
  );
  const recentOutcomes = exportAllOutcomes();
  const projectedPositions = capitalPositionsForSizing(capitalCtx);
  const dataQualityStatus = getMarketDataQualityStatus();
  const dataQualityDegraded = dataQualityStatus.incidents.some((incident) => Date.now() - incident.occurredAt < 10 * 60_000);
  const readinessStatus = aggressiveConfig.allowExecution
    ? await getCachedLiveReadinessStatus(aggressiveConfig)
    : undefined;

  for (let i = 0; i < toFire.length; i++) {
    await bucket.consume();
    const c = toFire[i];
    const rank = c.rotationRank;
    const openSameSide = projectedPositions.filter((position) =>
      position.symbol.toUpperCase() === c.symbol.toUpperCase()
      && position.positionSide === c.positionSide
    );
    const sizingStats = recentSizingStats(recentOutcomes, c.symbol, c.positionSide);
    const sizing = calculatePositionSizing({
      symbol: c.symbol,
      positionSide: c.positionSide,
      accountEquity: capitalCtx?.equity ?? aggressiveConfig.marginPerTrade / 0.005,
      availableMargin: capitalCtx?.availableMargin ?? Number.POSITIVE_INFINITY,
      aggressiveScore: Math.max(0, Math.min(1, c.aggressiveScore ?? c.combinedScore ?? c.effectiveScore ?? 0)),
      calibratedScore: c.calibratedScore,
      calibratedProbability: c.calibratedProbability ?? null,
      expectedValuePct: c.expectedValuePct ?? null,
      optimalThreshold: c.optimalThreshold ?? null,
      profitabilityVerified: c.profitabilityVerified,
      kellyFraction: c.kellyFraction ?? null,
      mlSizingMultiplier: c.mlSizingMultiplier ?? null,
      btcRegime,
      coachRank: i + 1,
      rotationState: rank?.state,
      aggressionState: aggression.aggressionState === "DEFENSIVE" ? "DEFENSIVE" : getActiveModeId() === "aggressive" ? "AGGRESSIVE" : "NORMAL",
      recentPnl: sizingStats.recentPnl,
      recentWinRate: sizingStats.recentWinRate,
      profitFactor: sizingStats.profitFactor,
      drawdown: sizingStats.drawdown,
      executionSlippageBps: rank?.metrics.avgSlippageBps ?? sizingStats.executionSlippageBps,
      campaignDepth: openSameSide.length + 1,
      campaignPnl: sizingStats.recentPnl,
      previousEntryMargin: openSameSide.at(-1)?.marginUsed,
      currentOpenPositions: projectedPositions,
      symbolConcentration: rank ? rank.currentOpenPositions / Math.max(1, aggressiveConfig.maxConcurrentPositions) : undefined,
      sideContextWinRate: sizingStats.sideContextWinRate,
      sideContextProfitFactor: sizingStats.sideContextProfitFactor,
      experimentArm: req.body?.experimentArm,
      dataQualityDegraded,
      exitPreservingProfit: sizingStats.recentPnl > 0 && sizingStats.drawdown <= Math.max(0.5, (capitalCtx?.equity ?? 0) * 0.005),
      baseMarginFallback: aggressiveConfig.marginPerTrade,
      leverageFallback: aggressiveConfig.leverage,
      stopLossPct: aggressiveConfig.stopLossPct,
      takeProfitPct: aggressiveConfig.takeProfitPct,
    });
    if (!sizing.approved) {
      results.push({
        index: i,
        symbol: c.symbol,
        side: c.positionSide === "LONG" ? "BUY" : "SELL",
        placed: false,
        orderId: null,
        quantity: null,
        gateRejects: sizing.gateRejects,
        observationMode: false,
        message: `REJECTED: ${sizing.gateRejects[0] ?? sizing.reason}`,
        sizing,
        durationMs: 0,
      });
      continue;
    }
    const orderConfig = rank
      ? {
          ...aggressiveConfig,
          maxPositionsPerSymbol: Math.max(1, rank.maxPositions),
          positionStackingEnabled: aggressiveConfig.positionStackingEnabled && rank.maxPositions > 1,
        }
      : aggressiveConfig;
    const result = await executeSingleOrder(
      {
        symbol: c.symbol,
        side: c.positionSide === "LONG" ? "BUY" : "SELL",
        positionSide: c.positionSide,
        marginOverride: sizing.recommendedMargin,
        leverageOverride: sizing.recommendedLeverage,
        sizing,
        currentEv: c.currentEv,
        btcChangePct: c.btcChangePct,
      },
      i,
      creds,
      orderConfig,
      correlationRejects.get(i) ?? [],
      capitalCtx ?? undefined,
      { readinessStatus },
    );
    results.push(result);
    if (result.placed) {
      projectedPositions.push({
        symbol: c.symbol,
        positionSide: c.positionSide,
        marginUsed: sizing.recommendedMargin,
        leverage: sizing.recommendedLeverage,
      });
      projectOrderIntoCapitalContext(capitalCtx, {
        symbol: c.symbol,
        positionSide: c.positionSide,
        margin: sizing.recommendedMargin,
        leverage: sizing.recommendedLeverage,
      });
    }
  }

  const placed = results.filter((r) => r.placed).length;
  recordAggressionCycleImpact(toFire.length, placed);
  req.log.info({
    total: candidates.length,
    filtered: sorted.length,
    headroom,
    attempted: toFire.length,
    placed,
    rotationHot: rotation.hotSymbols.length,
    rotationPaused: rotation.pausedSymbols.length,
    aggressionState: aggression.aggressionState,
    durationMs: Date.now() - t0,
  }, "sniper/mass execution complete");

  const skippedBelowScore = candidates.filter((c) => (c.combinedScore ?? c.aggressiveScore ?? 1) < aggressiveConfig.sniperMinCombinedScore).length;
  const skippedPaused = scored.filter((c) =>
    (c.combinedScore ?? c.aggressiveScore ?? 1) >= config.sniperMinCombinedScore
    && c.rotationRank?.state === "PAUSED"
  ).length;

  res.json({
    total: candidates.length,
    filtered: sorted.length,
    attempted: toFire.length,
    placed,
    rejected: toFire.length - placed,
    skippedNoHeadroom: sorted.length - toFire.length,
    skippedBelowScore,
    skippedByRotation: skippedPaused,
    aggression,
    killSwitch,
    durationMs: Date.now() - t0,
    rotation: {
      activeSymbols: rotation.activeSymbols,
      reducedSymbols: rotation.reducedSymbols,
      pausedSymbols: rotation.pausedSymbols,
      ranking: rotation.ranking,
    },
    capitalSnapshot: capitalCtx ? {
      openPositions: capitalCtx.openPositionsCount,
      marginUtilization: parseFloat((capitalCtx.marginUtilization * 100).toFixed(1)),
      equity: capitalCtx.equity,
    } : null,
    results,
  });
});

// ── Sniper: Autopilot endpoints ───────────────────────────────────────────────

/** POST /api/bot/sniper/autopilot/start — begin server-side autonomous scalp loop */
router.post("/bot/sniper/autopilot/start", requireAdminAuthorization, (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) { res.status(401).json({ error: "Not connected." }); return; }

  if (autopilot.running) {
    res.json({ started: false, reason: "Autopilot already running", state: { ...autopilot, handle: null, creds: null } });
    return;
  }

  const config = getBotConfig();
  if (!config.allowExecution) {
    res.status(403).json({ started: false, reason: "SCALP_ALLOW_EXECUTION=false blocks live autopilot." });
    return;
  }
  try {
    assertLiveExecutionAllowed(creds);
  } catch (err) {
    res.status(403).json({
      started: false,
      reason: err instanceof Error ? err.message : "Real-money execution refused.",
    });
    return;
  }
  const intervalMs = config.sniperAutopilotIntervalSec * 1000;

  autopilot.running = true;
  autopilot.startedAt = Date.now();
  autopilot.creds = { ...creds };
  autopilot.totalCycles = 0;
  autopilot.totalPlaced = 0;
  autopilot.sessionLossUsd = 0;
  autopilot.lastCycle = null;
  autopilot.history = [];
  autopilot.stopReason = null;

  // First cycle fires immediately, then on interval
  runAutopilotCycleLocked().catch((err) => req.log.warn({ err }, "autopilot cycle error"));
  autopilot.handle = setInterval(() => {
    runAutopilotCycleLocked().catch(() => {});
  }, intervalMs);

  req.log.info({ intervalMs, sniperMinCombinedScore: config.sniperMinCombinedScore, maxCandidates: config.sniperMaxCandidatesPerCycle }, "sniper autopilot started");
  res.json({
    started: true,
    intervalMs,
    sniperMinCombinedScore: config.sniperMinCombinedScore,
    sniperMaxCandidatesPerCycle: config.sniperMaxCandidatesPerCycle,
    positionStackingEnabled: config.positionStackingEnabled,
    maxPositionsPerSymbol: config.maxPositionsPerSymbol,
  });
});

/** POST /api/bot/sniper/autopilot/stop — halt the autonomous loop */
router.post("/bot/sniper/autopilot/stop", requireAdminAuthorization, (req: Request, res: Response) => {
  if (!autopilot.running) {
    res.json({ stopped: false, reason: "Autopilot was not running" });
    return;
  }
  stopAutopilot("MANUAL_STOP");
  req.log.info({ totalCycles: autopilot.totalCycles, totalPlaced: autopilot.totalPlaced }, "sniper autopilot stopped");
  res.json({ stopped: true, totalCycles: autopilot.totalCycles, totalPlaced: autopilot.totalPlaced });
});

/** GET /api/bot/sniper/autopilot/status — current autopilot state and cycle history */
router.get("/bot/sniper/autopilot/status", (_req: Request, res: Response) => {
  const config = getBotConfig();
  res.json({
    running: autopilot.running,
    startedAt: autopilot.startedAt,
    uptimeMs: autopilot.startedAt ? Date.now() - autopilot.startedAt : null,
    totalCycles: autopilot.totalCycles,
    totalPlaced: autopilot.totalPlaced,
    sessionLossUsd: autopilot.sessionLossUsd,
    stopReason: autopilot.stopReason,
    cycleInFlight: autopilotCycleInFlight,
    skippedOverlaps: autopilotSkippedOverlaps,
    lastCycle: autopilot.lastCycle,
    aggression: getAggressionStatus(),
    recentHistory: autopilot.history.slice(-20),
    config: {
      intervalSec: config.sniperAutopilotIntervalSec,
      maxCandidatesPerCycle: config.sniperMaxCandidatesPerCycle,
      minCombinedScore: config.sniperMinCombinedScore,
      positionStackingEnabled: config.positionStackingEnabled,
      maxPositionsPerSymbol: config.maxPositionsPerSymbol,
    },
  });
});

/** POST /api/bot/order/bulk — rate-limited bulk execution for Aggressive mode
 *
 *  Accepts up to 50 orders in one request, executes them sequentially through
 *  a token-bucket rate limiter so BingX's 10 orders/second cap is respected.
 *  Each order runs through the full gate pipeline before hitting the exchange.
 */
/** GET /api/sniper/concurrency/status - live lock/idempotency health snapshot */
router.get("/sniper/concurrency/status", (_req: Request, res: Response) => {
  const dataQuality = getMarketDataQualityStatus();
  const watcher = getLiveWatcherStats();
  const quantQueue = getQuantBrainQueueStats();
  const telemetry = getTelemetryStats();
  const recentRaceWarnings = dataQuality.incidents
    .filter((incident) => ["DUPLICATE_EXECUTION", "DUPLICATE", "OUT_OF_ORDER", "STALE"].includes(incident.type))
    .slice(-20);

  res.json({
    activeExecutionClaims: {
      count: dataQuality.activeExecutionClaims,
      keys: dataQuality.activeExecutionClaimKeys,
    },
    autopilotCycleInFlight,
    skippedOverlaps: {
      autopilot: autopilotSkippedOverlaps,
      watcher: watcher.skippedOverlaps,
    },
    pendingOutcomes: quantQueue.pendingOutcomes,
    outboxFlushInFlight: quantQueue.flushInFlight,
    telemetryWriteQueueDepth: telemetry.bufferSize,
    watcherTrackedPositions: watcher.trackedEntries,
    duplicateClaimsRejected: dataQuality.metrics.duplicateExecutions,
    recentRaceWarnings,
    lockHealth: {
      marketEventClaims: "ok",
      autopilotCycle: autopilotCycleInFlight ? "in_flight" : "idle",
      quantBrainOutbox: quantQueue.flushInFlight ? "flushing" : "idle",
      liveWatcher: watcher.pollInFlight ? "polling" : "idle",
      telemetryWriter: telemetry.bufferSize > 0 ? "buffered" : "idle",
    },
  });
});

router.post("/bot/order/bulk", requireAdminAuthorization, async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected." });
    return;
  }

  const { orders, ordersPerSecond = 10 } = req.body as {
    orders: BulkOrderItem[];
    ordersPerSecond?: number;
  };

  if (!Array.isArray(orders) || orders.length === 0) {
    res.status(400).json({ error: "orders must be a non-empty array" });
    return;
  }
  if (orders.length > 50) {
    res.status(400).json({ error: "Max 50 orders per bulk request" });
    return;
  }

  const rps = Math.min(Math.max(1, ordersPerSecond), 10); // clamp 1–10
  const bucket = new TokenBucket(rps, rps);
  let config = getBotConfig();
  const activeMode = getActiveModeId();
  const t0 = Date.now();
  const results: BulkOrderResult[] = [];
  const correlationRejects = buildBulkCorrelationRejects(orders, maxCorrelatedBulkOrders());

  // Pre-fetch capital once — all orders share the same snapshot
  const capitalCtx = await fetchCapitalContext(creds).catch(() => undefined);
  const firstBtcChangePct = orders[0]?.btcChangePct;
  const killSwitch = evaluateLiveKillSwitch({
    config,
    btcChangePct: firstBtcChangePct,
    capitalCtx,
    maxSessionLossRemaining: config.maxSessionLoss,
    integrityOk: capitalCtx !== undefined,
  });
  if (!killSwitch.entryAllowed) {
    res.json({
      mode: activeMode ?? "aggressive",
      total: orders.length,
      placed: 0,
      rejected: orders.length,
      observationMode: !config.allowExecution,
      durationMs: Date.now() - t0,
      killSwitch,
      results: [],
    });
    return;
  }
  config = applyKillSwitchToConfig(config, killSwitch);

  req.log.info({
    count: orders.length, rps, activeMode,
    correlationRejected: correlationRejects.size,
    openPositions: capitalCtx?.openPositionsCount ?? "unknown",
  }, "bulk execution started");
  const readinessStatus = config.allowExecution
    ? buildLiveReadinessStatus({
        outcomes: exportAllOutcomes(),
        closedDemoTrades: await loadClosedTrades(5_000),
        config,
      })
    : undefined;

  for (let i = 0; i < orders.length; i++) {
    await bucket.consume(); // respect rate limit
    const result = await executeSingleOrder(
      orders[i],
      i,
      creds,
      config,
      correlationRejects.get(i) ?? [],
      capitalCtx,
      { readinessStatus },
    );
    results.push(result);
    if (result.placed) {
      projectOrderIntoCapitalContext(capitalCtx, {
        symbol: orders[i].symbol,
        positionSide: orders[i].positionSide,
        margin: orders[i].marginOverride ?? config.marginPerTrade,
        leverage: Math.max(1, Math.round(orders[i].leverageOverride ?? config.leverage)),
      });
    }
  }

  const placed = results.filter((r) => r.placed).length;
  const summary: BulkExecutionSummary = {
    mode: activeMode ?? "aggressive",
    total: orders.length,
    placed,
    rejected: orders.length - placed,
    observationMode: !config.allowExecution,
    durationMs: Date.now() - t0,
    results,
  };

  req.log.info({ placed, total: orders.length, durationMs: summary.durationMs }, "bulk execution complete");
  res.json({ ...summary, killSwitch });
});

/** GET /api/bot/watcher — live position watcher health and registry snapshot */
router.get("/bot/watcher", (_req: Request, res: Response) => {
  res.json(getLiveWatcherStats());
});

/** GET /api/sniper/protection/status — local protection and exit reliability snapshot */
router.get("/sniper/protection/status", (_req: Request, res: Response) => {
  const now = Date.now();
  const watcher = getLiveWatcherStats();
  const outcomes = exportAllOutcomes().filter((outcome) => !isDemoOutcome(outcome));
  const recentOutcomes = outcomes.filter((outcome) => now - outcome.exitTime <= 7 * 24 * 60 * 60 * 1000);
  const openUnprotected = watcher.entries.filter((entry) => !entry.protectionAttachedAt);
  const unprotectedRiskUsdt = openUnprotected.reduce(
    (sum, entry) => sum + entry.marginUsed * entry.leverage * (getBotConfig().stopLossPct / 100),
    0,
  );
  const watcherLagMs = watcher.lastPollAt ? now - watcher.lastPollAt : null;
  const stalePositions = watcher.entries
    .filter((entry) => entry.ageMs > Math.max(watcher.pollIntervalMs * 4, 60_000))
    .map((entry) => ({
      entryOrderId: entry.entryOrderId,
      symbol: entry.symbol,
      positionSide: entry.positionSide,
      ageMs: entry.ageMs,
      protected: Boolean(entry.protectionAttachedAt),
    }));

  const byPlaybook = new Map<string, { trades: number; wins: number; pnl: number; gaveBack: number; sl: number }>();
  const bySymbol = new Map<string, { trades: number; pnl: number; gaveBack: number; sl: number }>();
  for (const outcome of recentOutcomes) {
    const playbook = outcome.playbook ?? "UNKNOWN";
    const symbol = outcome.symbol.toUpperCase();
    const mfe = outcome.mfe ?? 0;
    const gaveBack = Math.max(0, mfe - outcome.realizedPnl);
    const playbookRow = byPlaybook.get(playbook) ?? { trades: 0, wins: 0, pnl: 0, gaveBack: 0, sl: 0 };
    playbookRow.trades += 1;
    playbookRow.wins += outcome.realizedPnl > 0 ? 1 : 0;
    playbookRow.pnl += outcome.realizedPnl;
    playbookRow.gaveBack += gaveBack;
    playbookRow.sl += outcome.exitReason === "SL" ? 1 : 0;
    byPlaybook.set(playbook, playbookRow);

    const symbolRow = bySymbol.get(symbol) ?? { trades: 0, pnl: 0, gaveBack: 0, sl: 0 };
    symbolRow.trades += 1;
    symbolRow.pnl += outcome.realizedPnl;
    symbolRow.gaveBack += gaveBack;
    symbolRow.sl += outcome.exitReason === "SL" ? 1 : 0;
    bySymbol.set(symbol, symbolRow);
  }

  const exitQuality = Array.from(byPlaybook.entries()).map(([playbook, row]) => ({
    playbook,
    trades: row.trades,
    winRate: row.trades > 0 ? row.wins / row.trades : 0,
    netPnl: row.pnl,
    avgGaveBack: row.trades > 0 ? row.gaveBack / row.trades : 0,
    slRate: row.trades > 0 ? row.sl / row.trades : 0,
  })).sort((a, b) => a.netPnl - b.netPnl);

  const topSymbolsWithBadExit = Array.from(bySymbol.entries())
    .map(([symbol, row]) => ({
      symbol,
      trades: row.trades,
      netPnl: row.pnl,
      avgGaveBack: row.trades > 0 ? row.gaveBack / row.trades : 0,
      slRate: row.trades > 0 ? row.sl / row.trades : 0,
    }))
    .filter((row) => row.trades >= 2 && (row.netPnl < 0 || row.slRate >= 0.5))
    .sort((a, b) => a.netPnl - b.netPnl)
    .slice(0, 10);

  const recentProtected = outcomes.slice(-100).filter((outcome) => outcome.protectionAttachedAt).length;
  const protectionAttachFailureRate = outcomes.length > 0
    ? 1 - recentProtected / Math.min(100, outcomes.length)
    : openUnprotected.length > 0 ? 1 : 0;
  const pendingCloseRecon = watcher.closesDetected - watcher.outcomesRecorded;
  const latestCriticalFailures = [
    ...openUnprotected.slice(0, 5).map((entry) => ({
      severity: "CRITICAL",
      type: "UNPROTECTED_OPEN_POSITION",
      symbol: entry.symbol,
      positionSide: entry.positionSide,
      ageMs: entry.ageMs,
    })),
    ...(watcher.lastError ? [{ severity: "HIGH", type: "WATCHER_ERROR", message: watcher.lastError }] : []),
  ];
  const recommendedActions: string[] = [];
  if (openUnprotected.length > 0) recommendedActions.push("Reconcile unprotected live entries and close or attach exchange protection manually.");
  if (watcherLagMs === null || watcherLagMs > watcher.pollIntervalMs * 3) recommendedActions.push("Restart or investigate livePositionWatcher; polling is stale.");
  if (pendingCloseRecon > 0) recommendedActions.push("Review order history reconciliation before increasing sniper size.");
  if (topSymbolsWithBadExit.length > 0) recommendedActions.push("Reduce or pause symbols with negative exit quality until recent outcomes recover.");

  res.json({
    generatedAt: now,
    openPositions: {
      protected: watcher.entries.filter((entry) => entry.protectionAttachedAt).length,
      unprotected: openUnprotected.length,
      entries: watcher.entries.map((entry) => ({
        entryOrderId: entry.entryOrderId,
        symbol: entry.symbol,
        positionSide: entry.positionSide,
        protected: Boolean(entry.protectionAttachedAt),
        riskMode: entry.exitPolicy ?? (entry.protectionAttachedAt ? "TP_SL_PROTECTED" : "UNPROTECTED_HIGH_RISK"),
        ageMs: entry.ageMs,
        marginUsed: entry.marginUsed,
        leverage: entry.leverage,
      })),
    },
    protectionAttachFailureRate,
    watcherLagMs,
    stalePositions,
    pendingCloseRecon,
    unprotectedRiskUsdt,
    exitQuality,
    topSymbolsWithBadExit,
    latestCriticalFailures,
    recommendedActions,
  });
});

export default router;
