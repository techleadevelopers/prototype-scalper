import { Router } from "express";
import type { Request, Response } from "express";
import {
  getEngine,
  recordTradeOutcome,
  exportAllOutcomes,
  tradeCount,
  getTelemetrySseEmitter,
} from "../lib/telemetryStore";
import { getQuantBrainRecentTrades, getQuantBrainTradeSummary, syncQuantBrainOutcome } from "../lib/quantBrainClient";
import { AdaptiveEngine } from "../lib/adaptiveEngine";
import type { BtcRegime, ExitReason, PositionSide, TradeOutcome } from "../lib/adaptiveEngine";
import { requireAdminAuthorization } from "../lib/executionSecurity";
import { loadClosedTrades, type DemoClosedTrade } from "../lib/demoTradeStore";
import { getTriggerStats } from "../lib/exhaustionTriggerManager";

const router = Router();

type TelemetrySourceFilter = "all" | "demo" | "live";

function normalizeTelemetrySource(value: unknown): TelemetrySourceFilter {
  const raw = String(value ?? "all").trim().toLowerCase();
  return raw === "demo" || raw === "live" ? raw : "all";
}

function outcomeMatchesSource(outcome: TradeOutcome, source: TelemetrySourceFilter): boolean {
  if (source === "all") return true;
  const isDemo = outcome.isDemo === true || outcome.source === "bingx-vst";
  return source === "demo" ? isDemo : !isDemo;
}

function emptyGateRecommendation() {
  return {
    evMinThreshold: 0,
    winRateMin: 0,
    profitFactorMin: 0,
    toxicSymbols: [] as string[],
    toxicHours: [] as number[],
    confidence: "INSUFFICIENT_DATA" as const,
    basedOnSamples: 0,
    lastCalibrated: Date.now(),
  };
}

function mergeOutcomes(primary: TradeOutcome[], secondary: TradeOutcome[]): TradeOutcome[] {
  const byId = new Map<string, TradeOutcome>();
  for (const outcome of [...primary, ...secondary]) {
    const key = outcome.id || `${outcome.source ?? "unknown"}-${outcome.symbol}-${outcome.positionSide}-${outcome.exitTime}`;
    if (!byId.has(key)) byId.set(key, outcome);
  }
  return Array.from(byId.values()).sort((a, b) => b.exitTime - a.exitTime);
}

function withDeadline<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

function demoClosedTradeToOutcome(trade: DemoClosedTrade): TradeOutcome {
  return {
    id: `demo-ledger:${trade.tradeId}`,
    isDemo: true,
    source: "bingx-vst",
    sourceType: "demo",
    entryOrderId: trade.orderId,
    exitOrderId: trade.exitOrderId ?? undefined,
    symbol: trade.symbol,
    positionSide: trade.positionSide,
    side: trade.side,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    hourUtc: trade.hourUtc,
    btcRegime: trade.btcRegime as BtcRegime,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    qty: trade.qty,
    leverage: trade.leverage,
    marginUsed: trade.marginUsed,
    grossPnl: trade.grossPnl,
    fee: trade.fee,
    realizedPnl: trade.realizedPnl,
    pnlSource: trade.pnlSource,
    estimated: trade.estimated,
    expectedEntryPrice: trade.expectedEntryPrice ?? undefined,
    expectedExitPrice: trade.expectedExitPrice ?? undefined,
    entrySlippage: trade.entrySlippage,
    exitSlippage: trade.exitSlippage,
    totalSlippage: trade.totalSlippage,
    slippagePctNotional: trade.slippagePctNotional,
    exitReason: trade.exitReason,
    expectedTpProfit: trade.marginUsed * trade.leverage * (trade.tpPct / 100),
    mfe: trade.mfe,
    mae: trade.mae,
    holdDurationMs: trade.holdDurationMs,
    modelVersion: trade.modelVersion,
    signalId: trade.signalId,
    marketEventId: trade.marketEventId ?? undefined,
    predictionId: trade.predictionId ?? undefined,
    campaignId: trade.campaignId,
    clientOrderId: trade.clientOrderId,
    exchangeOrderId: trade.orderId,
    featureVersion: trade.featureVersion ?? undefined,
  };
}

function isCampaignAggregateAlreadyCovered(outcome: TradeOutcome, ledgerCampaignIds: Set<string>): boolean {
  const campaignId = outcome.campaignId
    ?? (outcome.id.startsWith("campaign:") ? outcome.id.slice("campaign:".length) : "");
  return Boolean(campaignId && ledgerCampaignIds.has(campaignId) && outcome.id.startsWith("campaign:"));
}

export async function buildTelemetryState(source: TelemetrySourceFilter = "all") {
  const engine = getEngine();
  const qbDeadlineMs = 350;
  const [quantTradeSummary, quantRecentTrades, closedDemoTrades] = await Promise.all([
    withDeadline(getQuantBrainTradeSummary(), null, qbDeadlineMs),
    withDeadline(getQuantBrainRecentTrades(source, 500), [], qbDeadlineMs),
    source === "live" ? Promise.resolve([]) : loadClosedTrades(2_000),
  ]);
  const ledgerOutcomes = closedDemoTrades.map(demoClosedTradeToOutcome);
  const ledgerCampaignIds = new Set(closedDemoTrades.map((trade) => trade.campaignId).filter(Boolean));
  const localOutcomes = engine.rawOutcomes()
    .slice()
    .sort((a, b) => b.exitTime - a.exitTime)
    .filter((outcome) => outcomeMatchesSource(outcome, source))
    .filter((outcome) => !isCampaignAggregateAlreadyCovered(outcome, ledgerCampaignIds));
  const outcomes = mergeOutcomes(
    mergeOutcomes(ledgerOutcomes, localOutcomes),
    quantRecentTrades
      .filter((outcome) => outcomeMatchesSource(outcome, source))
      .filter((outcome) => !isCampaignAggregateAlreadyCovered(outcome, ledgerCampaignIds)),
  );
  const recentOutcomes = outcomes.slice(0, 500);

  if (source === "all") {
    const global = engine.globalState();
    return {
      source,
      totalTrades: global.totalTrades,
      ewmaWinRate: global.ewmaWinRate,
      ewmaEv: global.ewmaEv,
      ewmaFeePerTrade: global.ewmaFeePerTrade,
      symbolProfiles: engine.allSymbolProfiles(),
      clusterProfiles: engine.allClusterProfiles(),
      hourProfile: engine.hourProfile(),
      gateRecommendation: engine.gateRecommendation(),
      recentOutcomes,
      quantTradeSummary,
    };
  }

  if (outcomes.length === 0) {
    return {
      source,
      totalTrades: 0,
      ewmaWinRate: 0,
      ewmaEv: 0,
      ewmaFeePerTrade: 0,
      symbolProfiles: [],
      clusterProfiles: [],
      hourProfile: [],
      gateRecommendation: emptyGateRecommendation(),
      recentOutcomes,
      quantTradeSummary,
    };
  }

  const scopedEngine = new AdaptiveEngine(outcomes);
  scopedEngine.stopAutoSave();
  const scopedGlobal = scopedEngine.globalState();
  return {
    source,
    totalTrades: scopedGlobal.totalTrades,
    ewmaWinRate: scopedGlobal.ewmaWinRate,
    ewmaEv: scopedGlobal.ewmaEv,
    ewmaFeePerTrade: scopedGlobal.ewmaFeePerTrade,
    symbolProfiles: scopedEngine.allSymbolProfiles(),
    clusterProfiles: scopedEngine.allClusterProfiles(),
    hourProfile: scopedEngine.hourProfile(),
    gateRecommendation: scopedEngine.gateRecommendation(),
    recentOutcomes,
    quantTradeSummary,
  };
}

/** GET /api/telemetry/state — full adaptive engine state for dashboard */
router.get("/telemetry/state", async (req: Request, res: Response) => {
  res.json(await buildTelemetryState(normalizeTelemetrySource(req.query.source)));
});

/**
 * GET /api/telemetry/stats — métricas consolidadas de produção para o dashboard.
 *
 * Agrega: distribuição de outcomes, fill/expiry rate, win rate global,
 * hold time médio, e estado do mux-lock.
 *
 * Nunca bloqueia: usa deadline de 500ms para o QB, falha silenciosa para
 * dados não críticos.
 */
router.get("/telemetry/stats", async (_req: Request, res: Response) => {
  const qbDeadlineMs = 500;
  const [closedDemoTrades, quantSummary] = await Promise.all([
    loadClosedTrades(5_000),
    withDeadline(getQuantBrainTradeSummary(), null, qbDeadlineMs),
  ]);

  const triggerStats = getTriggerStats();
  const localOutcomes = exportAllOutcomes();
  const demoOutcomes = closedDemoTrades.map(demoClosedTradeToOutcome);
  const allOutcomes = mergeOutcomes(demoOutcomes, localOutcomes);

  // Distribuição de outcomes por PnL realizado
  const won = allOutcomes.filter((o) => (o.realizedPnl ?? 0) > 0).length;
  const stopped = allOutcomes.filter((o) => (o.realizedPnl ?? 0) <= 0 && o.exitTime).length;
  const totalResolved = won + stopped;

  // Hold time médio (ms → segundos)
  const avgHoldMs =
    allOutcomes.length > 0
      ? allOutcomes.reduce((s, o) => s + (o.holdDurationMs ?? 0), 0) / allOutcomes.length
      : 0;

  // Taxa de maker (ordens que foram filled como maker, não taker)
  const makerCount = allOutcomes.filter((o) => (o.entrySlippage ?? 0) <= 0).length;
  const makerTaxEfficiencyPct =
    allOutcomes.length > 0 ? Math.round((makerCount / allOutcomes.length) * 10000) / 100 : 0;

  res.json({
    summary: {
      totalSignalsGenerated: triggerStats.totalArmed,
      totalTradesExecuted: triggerStats.presumedFilled,
      totalOutcomesClosed: totalResolved,
      globalWinRate:
        totalResolved > 0 ? Math.round((won / totalResolved) * 10000) / 10000 : null,
    },
    outcomeDistribution: {
      FILLED_AND_WON: won,
      FILLED_AND_STOPPED: stopped,
      EXPIRED_UNFILLED: triggerStats.expired,
      SECTOR_CASCADE_CANCELLED: triggerStats.sectorCascadeCancelled,
      PENDING: triggerStats.pending,
    },
    efficiencyMetrics: {
      fillRatePct: Math.round(triggerStats.fillRate * 10000) / 100,
      expiryRatePct: Math.round(triggerStats.expiryRate * 10000) / 100,
      makerTaxEfficiencyPct,
      averageHoldTimeSeconds: Math.round(avgHoldMs / 100) / 10,
    },
    muxLock: triggerStats.muxLock,
    activeSectors: triggerStats.activeSectors,
    quantBrain: quantSummary ?? null,
    generatedAt: Date.now(),
  });
});

/** GET /api/telemetry/recommendation — adaptive gate recommendation only */
router.get("/telemetry/recommendation", (_req: Request, res: Response) => {
  res.json(getEngine().gateRecommendation());
});

/** POST /api/telemetry/outcome — record a realized trade outcome */
router.post("/telemetry/outcome", requireAdminAuthorization, (req: Request, res: Response) => {
  const body = req.body as {
    id?: string;
    symbol: string;
    positionSide: PositionSide;
    side: "BUY" | "SELL";
    entryTime: number;
    exitTime: number;
    hourUtc?: number;
    btcRegime: BtcRegime;
    entryPrice: number;
    exitPrice: number;
    qty: number;
    leverage: number;
    marginUsed: number;
    grossPnl: number;
    fee: number;
    realizedPnl: number;
    exitReason: ExitReason;
    expectedTpProfit: number;
  };

  if (!body.symbol || body.entryPrice == null || body.exitPrice == null || body.realizedPnl == null) {
    res.status(400).json({ error: "symbol, entryPrice, exitPrice, realizedPnl are required" });
    return;
  }

  try {
    const outcome = recordTradeOutcome({
      ...body,
      hourUtc: body.hourUtc ?? new Date(body.entryTime).getUTCHours(),
    });
    void syncQuantBrainOutcome(outcome).then((result) => {
      if (!result.synced && result.error !== "missing QUANT_BRAIN_URL") {
        req.log.warn({ error: result.error, outcomeId: outcome.id }, "quant brain sync skipped");
      }
    });
    req.log.info({ symbol: outcome.symbol, pnl: outcome.realizedPnl, side: outcome.positionSide }, "telemetry outcome recorded");
    res.json({ recorded: true, id: outcome.id, totalTrades: tradeCount() });
  } catch (err) {
    req.log.error({ err }, "telemetry record error");
    res.status(500).json({ error: "Failed to record outcome" });
  }
});

/**
 * GET /api/telemetry/context — ContextSignal for a specific cluster.
 * Equivalent to adaptive_policy.context_signal(router, hour_utc) in Rust.
 * Frontend sends this before each potential entry to get priority/toxicity scores.
 */
router.get("/telemetry/context", (req: Request, res: Response) => {
  const { symbol, positionSide, hourUtc, btcRegime } = req.query as {
    symbol: string;
    positionSide: string;
    hourUtc: string;
    btcRegime: string;
  };
  if (!symbol || !positionSide || hourUtc == null || !btcRegime) {
    res.status(400).json({ error: "symbol, positionSide, hourUtc, btcRegime are required" });
    return;
  }
  const signal = getEngine().contextSignal({
    symbol,
    positionSide: positionSide as PositionSide,
    hourUtc: parseInt(hourUtc, 10),
    btcRegime: btcRegime as BtcRegime,
  });
  res.json(signal);
});

/** GET /api/telemetry/rank — ranking score for a pending entry */
router.get("/telemetry/rank", (req: Request, res: Response) => {
  const { symbol, positionSide, hourUtc, btcRegime, currentEv } = req.query as Record<string, string>;
  if (!symbol || !positionSide || hourUtc == null || !btcRegime || currentEv == null) {
    res.status(400).json({ error: "symbol, positionSide, hourUtc, btcRegime, currentEv are required" });
    return;
  }
  const score = getEngine().rankingScore(
    { symbol, positionSide: positionSide as PositionSide, hourUtc: parseInt(hourUtc, 10), btcRegime: btcRegime as BtcRegime },
    parseFloat(currentEv),
  );
  const signal = getEngine().contextSignal({
    symbol,
    positionSide: positionSide as PositionSide,
    hourUtc: parseInt(hourUtc, 10),
    btcRegime: btcRegime as BtcRegime,
  });
  res.json({ rankingScore: score, ...signal });
});

/** GET /api/telemetry/export — raw JSONL export of all outcomes */
router.get("/telemetry/export", async (_req: Request, res: Response) => {
  const qbDeadlineMs = 500;
  const [localOutcomes, closedDemoTrades, quantRecentTrades] = await Promise.all([
    Promise.resolve(exportAllOutcomes()),
    loadClosedTrades(2_000),
    withDeadline(getQuantBrainRecentTrades("all", 2_000), [], qbDeadlineMs),
  ]);
  const ledgerCampaignIds = new Set(closedDemoTrades.map((trade) => trade.campaignId).filter(Boolean));
  res.json(mergeOutcomes(
    mergeOutcomes(
      closedDemoTrades.map(demoClosedTradeToOutcome),
      localOutcomes.filter((outcome) => !isCampaignAggregateAlreadyCovered(outcome, ledgerCampaignIds)),
    ),
    quantRecentTrades.filter((outcome) => !isCampaignAggregateAlreadyCovered(outcome, ledgerCampaignIds)),
  ));
});

/**
 * GET /api/telemetry/live — Server-Sent Events real-time feed.
 *
 * Streams:
 *   { type: "engine_state", data: GlobalState }      — on connect + every 15s
 *   { type: "trade_recorded", data: TradeOutcome }   — whenever a trade is logged
 *   { type: "heartbeat", ts: number }                — every 20s keepalive
 *
 * Client usage:
 *   const es = new EventSource("/api/telemetry/live", { withCredentials: true })
 *   es.onmessage = (e) => { const msg = JSON.parse(e.data); ... }
 */
router.get("/telemetry/live", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  function send(msg: Record<string, unknown>) {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  // Send initial engine snapshot on connect
  try {
    const engine = getEngine();
    const global = engine.globalState();
    send({ type: "engine_state", data: global });
  } catch {
    // non-fatal — just skip initial snapshot if engine unavailable
  }

  // Engine heartbeat + state refresh every 15s
  const stateInterval = setInterval(() => {
    try {
      const engine = getEngine();
      const global = engine.globalState();
      send({ type: "engine_state", data: global });
    } catch {
      // ignore
    }
  }, 15_000);

  // Keepalive heartbeat every 20s (prevents proxy timeout)
  const heartbeatInterval = setInterval(() => {
    send({ type: "heartbeat", ts: Date.now() });
  }, 20_000);

  // Listen for new trade outcomes
  const { sseEmitter } = getTelemetrySseEmitter();
  function onTrade(outcome: unknown) {
    send({ type: "trade_recorded", data: outcome });
  }
  sseEmitter.on("trade", onTrade);

  req.on("close", () => {
    clearInterval(stateInterval);
    clearInterval(heartbeatInterval);
    sseEmitter.off("trade", onTrade);
  });
});

export default router;
