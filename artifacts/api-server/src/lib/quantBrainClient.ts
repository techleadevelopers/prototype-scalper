import type { TradeOutcome } from "./adaptiveEngine";
import type { BotConfig } from "./botConfig";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalMarketEventId, normalizeMarketSymbol } from "./marketDataQuality";
import { validateLearningEligibility } from "./pipelineAuditor";
import { logger } from "./logger";

export const QUANT_BRAIN_CONTRACT_VERSION = "edge-v3";
export const DEFAULT_FEATURE_VERSION = "sniper-v1";
const SUPPORTED_FEATURE_VERSIONS = new Set(["sniper-v1", "candle-edge-v1"]);
const MAX_PREDICTION_AGE_MS = Math.max(
  1_000,
  Number(process.env["QUANT_BRAIN_MAX_PREDICTION_AGE_MS"] ?? 15_000),
);
const MAX_MARKET_DATA_AGE_MS = Math.max(
  1_000,
  Number(process.env["QUANT_BRAIN_MAX_MARKET_DATA_AGE_MS"] ?? 30_000),
);
const MAX_FEATURE_AGE_MS = Math.max(
  1_000,
  Number(process.env["QUANT_BRAIN_MAX_FEATURE_AGE_MS"] ?? 30_000),
);

// Keep Quant Brain calls bounded. Sniper execution must never wait minutes for
// a shadow-only advisory service.
const DEFAULT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env["QUANT_BRAIN_TIMEOUT_MS"] ?? 8_000),
);
const SHADOW_EDGE_TIMEOUT_MS = Math.max(
  750,
  Number(process.env["QUANT_BRAIN_SHADOW_EDGE_TIMEOUT_MS"] ?? 2_500),
);
const ENFORCE_EDGE_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env["QUANT_BRAIN_ENFORCE_EDGE_TIMEOUT_MS"] ?? 8_000),
);
const INTELLIGENCE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env["QUANT_BRAIN_INTELLIGENCE_TIMEOUT_MS"] ?? 4_000),
);
const INTELLIGENCE_EDGE_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env["QUANT_BRAIN_INTELLIGENCE_EDGE_CACHE_TTL_MS"] ?? 5_000),
);
const INTELLIGENCE_SIDECAR_TIMEOUT_MS = Math.max(
  500,
  Number(process.env["QUANT_BRAIN_INTELLIGENCE_SIDECAR_TIMEOUT_MS"] ?? 900),
);
const INTELLIGENCE_SIDECAR_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env["QUANT_BRAIN_INTELLIGENCE_SIDECAR_CACHE_TTL_MS"] ?? 30_000),
);
const INTELLIGENCE_STALE_TTL_MS = Math.max(
  INTELLIGENCE_SIDECAR_CACHE_TTL_MS,
  Number(process.env["QUANT_BRAIN_INTELLIGENCE_STALE_TTL_MS"] ?? 300_000),
);
const SUMMARY_TIMEOUT_MS = Math.max(
  750,
  Number(process.env["QUANT_BRAIN_SUMMARY_TIMEOUT_MS"] ?? 1_500),
);
const SUMMARY_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env["QUANT_BRAIN_SUMMARY_CACHE_TTL_MS"] ?? 15_000),
);
const OUTCOME_SYNC_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env["QUANT_BRAIN_OUTCOME_SYNC_INTERVAL_MS"] ?? 30_000),
);
const OUTCOME_SYNC_BATCH_SIZE = Math.max(
  1,
  Number(process.env["QUANT_BRAIN_OUTCOME_SYNC_BATCH_SIZE"] ?? 25),
);
const pendingOutcomes = new Map<string, TradeOutcome>();
const OUTCOME_OUTBOX_PATH = process.env["QUANT_BRAIN_OUTBOX_PATH"]
  ?? path.join(process.cwd(), "data", "quant-brain-outbox.json");
let outcomeSyncTimer: NodeJS.Timeout | null = null;
let outcomeFlushInFlight = false;
let outcomeOutboxLock: Promise<void> = Promise.resolve();
let outcomeFlushFailures = 0;
let outcomeFlushBatches = 0;
let outcomeFlushRecords = 0;
let retryBudgetUsed = 0;
let retryBudgetResetAt = Date.now() + 60_000;
const requestLatencySamples: number[] = [];
const MAX_REQUEST_LATENCY_SAMPLES = 512;
let requestCount = 0;
let requestErrorCount = 0;
let requestTimeoutCount = 0;
let lastRequestError: string | null = null;
let lastRequestErrorAt: number | null = null;
let tradeSummaryCache: { value: QuantTradeSummary | null; expiresAt: number } | null = null;
const recentTradesCache = new Map<string, { value: TradeOutcome[]; expiresAt: number }>();
const intelligenceEdgeCache = new Map<string, { value: QuantBrainEdgeResult; expiresAt: number; staleUntil: number }>();
const intelligenceEdgeInflight = new Map<string, Promise<QuantBrainEdgeResult>>();
const sidecarCache = new Map<string, { value: unknown; expiresAt: number; staleUntil: number }>();

async function withOutcomeOutboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = outcomeOutboxLock;
  let release!: () => void;
  outcomeOutboxLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// Max entries per unbounded Map — evict oldest when exceeded to prevent memory leak
const MAX_CACHE_ENTRIES = 500;
// Max pending outcomes before evicting oldest — prevents OOM during extended QB downtime
// at high-frequency stacking rates (e.g. 100 trades/hour × 24h = 2400 entries without this)
const MAX_PENDING_OUTCOMES = 1_000;
const RETRY_BUDGET_PER_MINUTE = Math.max(
  1,
  Number(process.env["QUANT_BRAIN_RETRY_BUDGET_PER_MINUTE"] ?? 20),
);

function consumeRetryBudget(): boolean {
  const now = Date.now();
  if (now >= retryBudgetResetAt) {
    retryBudgetUsed = 0;
    retryBudgetResetAt = now + 60_000;
  }
  if (retryBudgetUsed >= RETRY_BUDGET_PER_MINUTE) return false;
  retryBudgetUsed++;
  return true;
}

function evictOldest<V extends { expiresAt: number }>(map: Map<string, V>): void {
  if (map.size <= MAX_CACHE_ENTRIES) return;
  // Sort by expiresAt ascending and delete the oldest third
  const sorted = Array.from(map.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toDelete = Math.ceil(sorted.length / 3);
  for (let i = 0; i < toDelete; i++) map.delete(sorted[i][0]);
}

function evictOldestPending(): void {
  if (pendingOutcomes.size <= MAX_PENDING_OUTCOMES) return;
  // Sort by entryTime ascending and evict oldest third to bound memory usage
  const sorted = Array.from(pendingOutcomes.entries())
    .sort((a, b) => (a[1].entryTime ?? 0) - (b[1].entryTime ?? 0));
  const toDelete = Math.ceil(sorted.length / 3);
  for (let i = 0; i < toDelete; i++) pendingOutcomes.delete(sorted[i][0]);
}

function persistOutcomeOutbox(): void {
  try {
    fs.mkdirSync(path.dirname(OUTCOME_OUTBOX_PATH), { recursive: true });
    const tmp = `${OUTCOME_OUTBOX_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(pendingOutcomes.values())), "utf8");
    fs.renameSync(tmp, OUTCOME_OUTBOX_PATH);
  } catch {
    // In-memory retries continue; a later mutation retries persistence.
  }
}

function loadOutcomeOutbox(): TradeOutcome[] {
  try {
    if (!fs.existsSync(OUTCOME_OUTBOX_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(OUTCOME_OUTBOX_PATH, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
        (item): item is TradeOutcome => Boolean(item && typeof item === "object" && "id" in item),
      )
      : [];
  } catch {
    return [];
  }
}

function quantBrainUrl(): string | null {
  const raw = process.env["QUANT_BRAIN_URL"]?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function quantBrainEnabled(): boolean {
  return process.env["QUANT_BRAIN_ENABLED"] !== "false";
}

function rememberRequestLatency(value: number): void {
  requestLatencySamples.push(value);
  if (requestLatencySamples.length > MAX_REQUEST_LATENCY_SAMPLES) {
    requestLatencySamples.splice(0, requestLatencySamples.length - MAX_REQUEST_LATENCY_SAMPLES);
  }
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile));
  return Number(ordered[index].toFixed(2));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
}

function quantBrainHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env["QUANT_BRAIN_API_TOKEN"]?.trim();
  if (token) headers["X-Quant-Brain-Token"] = token;
  return headers;
}

export type QuantBrainGateMode = "off" | "shadow" | "enforce";

export function quantBrainGateMode(): QuantBrainGateMode {
  const raw = process.env["QUANT_BRAIN_GATE_MODE"]?.trim().toLowerCase();
  return raw === "enforce" || raw === "shadow" || raw === "off" ? raw : "shadow";
}

export interface QuantBrainEdgeResult {
  allow: boolean;
  gateRejects: string[];
  available: boolean;
  contractVersion: string;
  score: number | null;
  authority?: string;
  mode?: string;
  // Contract v2 — audit fields
  predictionId?: string;
  signalId?: string;
  marketEventId?: string;
  symbol?: string;
  side?: "BUY" | "SELL";
  positionSide?: "LONG" | "SHORT";
  modelVersion?: string | null;
  featureVersion?: string;
  calibratedProbability?: number | null;
  calibratedScore?: number | null;
  probabilityDefinition?: string;
  uncertaintyType?: string;
  predictionTimestamp?: number;
  dataAgeMs?: number | null;
  driftPolicy?: QuantBrainDriftPolicy;
  sniper?: unknown;
  realizedEdge?: unknown;
  error?: string;
}

export interface QuantBrainDriftPolicy {
  mlEnforcementAllowed: boolean;
  stackingMultiplier: number;
  newEntriesAllowed: boolean;
}

let lastDriftPolicy: QuantBrainDriftPolicy = {
  mlEnforcementAllowed: true,
  stackingMultiplier: 1,
  newEntriesAllowed: true,
};

export function getCurrentQuantBrainDriftPolicy(): QuantBrainDriftPolicy {
  return { ...lastDriftPolicy };
}

function unavailableGate(error: string): QuantBrainEdgeResult {
  return quantBrainGateMode() === "enforce"
    ? {
        allow: false,
        available: false,
        contractVersion: QUANT_BRAIN_CONTRACT_VERSION,
        gateRejects: [`UNAVAILABLE_REJECT: ${error}`],
        score: null,
        calibratedProbability: null,
        uncertaintyType: "SERVICE_UNAVAILABLE",
        error,
      }
    : {
        allow: true,
        available: false,
        contractVersion: QUANT_BRAIN_CONTRACT_VERSION,
        gateRejects: [],
        score: null,
        calibratedProbability: null,
        uncertaintyType: "SERVICE_UNAVAILABLE",
        error,
      };
}

const QuantBrainEdgeResponseSchema = z.object({
  allow: z.boolean(),
  available: z.boolean(),
  contractVersion: z.literal(QUANT_BRAIN_CONTRACT_VERSION),
  gateRejects: z.array(z.string()),
  score: z.number().min(0).max(1).nullable(),
  authority: z.string(),
  mode: z.string().optional(),
  predictionId: z.string().min(1),
  signalId: z.string().min(1),
  marketEventId: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  positionSide: z.enum(["LONG", "SHORT"]),
  modelVersion: z.string().min(1).nullable(),
  featureVersion: z.string().min(1),
  calibratedProbability: z.number().min(0).max(1).nullable(),
  calibratedScore: z.number().min(0).max(1).nullable().optional(),
  probabilityDefinition: z.literal("probability_configured_target_hit_before_stop"),
  uncertaintyType: z.enum([
    "STRONG_EVIDENCE",
    "WEAK_EVIDENCE",
    "INSUFFICIENT_DATA",
    "OOD",
    "MODEL_UNAVAILABLE",
    "UNCALIBRATED",
  ]),
  predictionTimestamp: z.number().int().positive(),
  dataAgeMs: z.number().min(0).nullable(),
  driftPolicy: z.object({
    mlEnforcementAllowed: z.boolean(),
    stackingMultiplier: z.number().min(0).max(1),
    newEntriesAllowed: z.boolean(),
  }).optional(),
  sniper: z.unknown().optional(),
  realizedEdge: z.unknown().optional(),
});

const OutcomeAckSchema = z.object({
  ok: z.literal(true),
  sourceId: z.string().min(1),
  recorded: z.boolean(),
  duplicate: z.boolean(),
});

const OutcomeBatchAckItemSchema = z.object({
  sourceId: z.string().min(1),
  recorded: z.boolean(),
  duplicate: z.boolean(),
  blockedReasons: z.array(z.string()),
  error: z.string().optional(),
});

const OutcomeBatchAckSchema = z.object({
  items: z.array(OutcomeBatchAckItemSchema),
});

export function tradeOutcomeToQuantPayload(outcome: TradeOutcome): Record<string, unknown> {
  return {
    id: outcome.id,
    symbol: outcome.symbol,
    side: outcome.positionSide,
    positionSide: outcome.positionSide,
    entryPrice: outcome.entryPrice,
    exitPrice: outcome.exitPrice,
    qty: outcome.qty,
    leverage: outcome.leverage,
    marginUsed: outcome.marginUsed,
    grossPnl: outcome.grossPnl,
    fee: outcome.fee,
    feePaidUsdt: outcome.fee,
    realizedPnl: outcome.realizedPnl,
    pnlSource: outcome.pnlSource,
    estimated: outcome.estimated ?? outcome.pnlSource === "price_estimate",
    pnl_pct: outcome.marginUsed > 0
      ? (outcome.realizedPnl / outcome.marginUsed) * 100
      : outcome.realizedPnl,
    btcRegime: outcome.btcRegime,
    hourUtc: outcome.hourUtc,
    entryTime: outcome.entryTime,
    exitTime: outcome.exitTime,
    exitReason: outcome.exitReason,
    expectedTpProfit: outcome.expectedTpProfit,
    expectedEntryPrice: outcome.expectedEntryPrice,
    markPriceBeforeOrder: outcome.markPriceBeforeOrder,
    actualAvgEntryPrice: outcome.actualAvgEntryPrice ?? outcome.entryPrice,
    expectedExitPrice: outcome.expectedExitPrice,
    actualExitPrice: outcome.actualExitPrice ?? outcome.exitPrice,
    signalCreatedAt: outcome.signalCreatedAt,
    qbEvaluatedAt: outcome.qbEvaluatedAt,
    orderRequestedAt: outcome.orderRequestedAt,
    orderSentAt: outcome.orderSentAt,
    orderAckAt: outcome.orderAckAt,
    positionConfirmedAt: outcome.positionConfirmedAt,
    positionClosedAt: outcome.positionClosedAt ?? outcome.exitTime,
    protectionAttachedAt: outcome.protectionAttachedAt,
    monitorDetectedCloseAt: outcome.monitorDetectedCloseAt,
    spreadBps: outcome.spreadBps,
    spreadAtSignal: outcome.spreadAtSignal,
    spreadAtEntry: outcome.spreadAtEntry,
    spreadAtExit: outcome.spreadAtExit,
    orderType: outcome.orderType,
    quantity: outcome.qty,
    entrySlippage: outcome.entrySlippage ?? 0,
    exitSlippage: outcome.exitSlippage ?? 0,
    totalSlippage: outcome.totalSlippage ?? 0,
    slippageBps: (outcome.slippagePctNotional ?? 0) * 10_000,
    source: outcome.source ?? "manual",
    isDemo: outcome.isDemo ?? false,
    // Audit trail — present when populated by campaign aggregation
    mfe: outcome.mfe,
    mae: outcome.mae,
    holdDurationMs: outcome.holdDurationMs,
    entryCount: outcome.entryCount,
    riskTier: outcome.riskTier,
    sizeMultiplier: outcome.sizeMultiplier,
    sizeReason: outcome.sizeReason,
    recommendedMargin: outcome.recommendedMargin,
    recommendedLeverage: outcome.recommendedLeverage,
    maxLossIfStop: outcome.maxLossIfStop,
    notional: outcome.notional,
    sizing: outcome.sizing,
    modelVersion: outcome.modelVersion,
    aggressiveScore: outcome.aggressiveScore,
    executionPriority: outcome.executionPriority,
    coachScore: outcome.coachScore,
    playbookScore: outcome.playbookScore,
    playbook: outcome.playbook,
    setup: outcome.setup,
    mlProbability: outcome.mlProbability ?? outcome.calibratedProbability,
    calibratedProbability: outcome.calibratedProbability ?? outcome.mlProbability,
    executionQuality: outcome.executionQuality,
    calibratedScore: outcome.calibratedScore,
    signalId: outcome.signalId,
    marketEventId: outcome.marketEventId,
    predictionId: outcome.predictionId,
    campaignId: outcome.campaignId,
    clientOrderId: outcome.clientOrderId,
    exchangeOrderId: outcome.exchangeOrderId ?? outcome.entryOrderId,
    featureVersion: outcome.featureVersion,
    strategyVersion: outcome.strategyVersion,
    configVersion: outcome.configVersion,
    policyVersion: outcome.policyVersion,
    sourceType: outcome.sourceType,
    contractVersion: QUANT_BRAIN_CONTRACT_VERSION,
    labelVersion: outcome.labelVersion ?? (outcome.id.startsWith("campaign:") ? "campaign-pnl-v1" : undefined),
  };
}

export function tradeOutcomesToQuantBatchPayload(outcomes: TradeOutcome[]): Record<string, unknown>[] {
  return outcomes.map(tradeOutcomeToQuantPayload);
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const baseUrl = quantBrainUrl();
  if (!baseUrl) throw new Error("missing QUANT_BRAIN_URL");

  const retryable =
    timeoutMs >= 10_000
    && ((init.method ?? "GET") === "GET"
      || path === "/edge/evaluate"
      || path === "/kb/trades"
      || path === "/kb/trades/batch");
  const attempts = retryable ? 2 : 1;
  const attemptTimeoutMs = Math.max(1_000, timeoutMs);
  let lastError: unknown;
  const startedAt = Date.now();
  requestCount += 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: quantBrainHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json() as T;
      rememberRequestLatency(Date.now() - startedAt);
      return value;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && consumeRetryBudget()) {
        const jitterMs = Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, 150 + jitterMs));
      } else {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  requestErrorCount += 1;
  if (isTimeoutError(lastError)) requestTimeoutCount += 1;
  lastRequestError = errorMessage(lastError);
  lastRequestErrorAt = Date.now();
  rememberRequestLatency(lastRequestErrorAt - startedAt);
  throw lastError instanceof Error ? lastError : new Error("Quant Brain unavailable");
}

async function postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  return requestJson<T>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    timeoutMs,
  );
}

async function getJson<T>(path: string, timeoutMs?: number): Promise<T> {
  return requestJson<T>(path, { method: "GET" }, timeoutMs);
}

async function getCachedJson<T>(
  key: string,
  path: string,
  timeoutMs = INTELLIGENCE_SIDECAR_TIMEOUT_MS,
): Promise<{ value: T | null; error?: string; stale?: boolean }> {
  const now = Date.now();
  const cached = sidecarCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { value: cached.value as T };
  }

  try {
    const value = await getJson<T>(path, timeoutMs);
    evictOldest(sidecarCache);
    sidecarCache.set(key, {
      value,
      expiresAt: now + INTELLIGENCE_SIDECAR_CACHE_TTL_MS,
      staleUntil: now + INTELLIGENCE_STALE_TTL_MS,
    });
    return { value };
  } catch (err) {
    if (cached && cached.staleUntil > now) {
      return {
        value: cached.value as T,
        stale: true,
        error: err instanceof Error ? err.message : "unknown error",
      };
    }
    return {
      value: null,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

async function getCachedIntelligenceEdge(input: QuantBrainEdgeInput): Promise<QuantBrainEdgeResult> {
  const regimeBucket = Math.round((input.btcChangePct ?? 0) * 10) / 10;
  // Include sentiment direction + bias bucket so BULL/BEAR shifts invalidate the cache
  const sentimentKey = input.sentimentContext
    ? `${input.sentimentContext.direction}:${Math.round(input.sentimentContext.biasRatio * 10)}`
    : "ns";
  const cacheKey = [
    input.symbol,
    input.positionSide,
    input.hourUtc ?? "na",
    regimeBucket,
    sentimentKey,
    quantBrainGateMode(),
  ].join(":");
  const now = Date.now();
  const cached = intelligenceEdgeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const inflight = intelligenceEdgeInflight.get(cacheKey);
  if (inflight) return inflight;

  const normalized = normalizeEdgeInput(input);
  const request = postJson<unknown>("/edge/evaluate", normalized, INTELLIGENCE_TIMEOUT_MS)
    .then((raw) => {
      const value = validateQuantBrainEdgeResponse(raw, normalized);
      evictOldest(intelligenceEdgeCache);
      intelligenceEdgeCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + INTELLIGENCE_EDGE_CACHE_TTL_MS,
        staleUntil: Date.now() + INTELLIGENCE_STALE_TTL_MS,
      });
      return value;
    })
    .catch((err) => {
      if (cached && cached.staleUntil > Date.now()) return cached.value;
      return unavailableGate(err instanceof Error ? err.message : "unknown error");
    })
    .finally(() => {
      intelligenceEdgeInflight.delete(cacheKey);
    });

  intelligenceEdgeInflight.set(cacheKey, request);
  return request;
}

export interface QuantTradeSourceSummary {
  source: string;
  isDemo: boolean;
  trades: number;
  wins: number;
  losses: number;
  pnlUsdt: number;
  positivePnlUsdt: number;
  negativePnlUsdt: number;
  lastTradeAt: number;
}

export interface QuantTradeSummary {
  totalTrades: number;
  demoTrades: number;
  liveTrades: number;
  sources: QuantTradeSourceSummary[];
}

export async function getQuantBrainTradeSummary(): Promise<QuantTradeSummary | null> {
  if (!quantBrainEnabled()) return null;
  const now = Date.now();
  if (tradeSummaryCache && tradeSummaryCache.expiresAt > now) return tradeSummaryCache.value;
  try {
    const value = await getJson<QuantTradeSummary>("/kb/trades/summary", SUMMARY_TIMEOUT_MS);
    tradeSummaryCache = { value, expiresAt: now + SUMMARY_CACHE_TTL_MS };
    return value;
  } catch {
    if (tradeSummaryCache) return tradeSummaryCache.value;
    tradeSummaryCache = { value: null, expiresAt: now + SUMMARY_CACHE_TTL_MS };
    return tradeSummaryCache.value;
  }
}

export async function getQuantBrainRecentTrades(
  source: "all" | "demo" | "live" = "all",
  limit = 500,
): Promise<TradeOutcome[]> {
  if (!quantBrainEnabled()) return [];
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 2_000));
  const cacheKey = `${source}:${safeLimit}`;
  const now = Date.now();
  const cached = recentTradesCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const params = new URLSearchParams({ source, limit: String(safeLimit) });
    const value = await getJson<TradeOutcome[]>(`/kb/trades/recent?${params.toString()}`, SUMMARY_TIMEOUT_MS);
    evictOldest(recentTradesCache);
    recentTradesCache.set(cacheKey, { value, expiresAt: now + SUMMARY_CACHE_TTL_MS });
    return value;
  } catch {
    return cached?.value ?? [];
  }
}

export async function getQuantBrainExecutionAudit(hours = 24): Promise<unknown | null> {
  if (!quantBrainEnabled()) return null;
  const safeHours = Math.max(1, Math.min(Math.trunc(hours), 720));
  try {
    return await getJson<unknown>(`/execution/audit?hours=${safeHours}`, SUMMARY_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export async function syncQuantBrainOutcome(
  outcome: TradeOutcome,
): Promise<{ synced: boolean; error?: string }> {
  return withOutcomeOutboxLock(async () => {
  if (!quantBrainEnabled()) return { synced: false, error: "disabled" };
  const eligibility = validateLearningEligibility(outcome);
  if (!eligibility.learningEligible) {
    return {
      synced: false,
      error: `pipeline_integrity_blocked:${eligibility.blockedReasons.join(",")}`,
    };
  }
  pendingOutcomes.set(outcome.id, outcome);
  evictOldestPending();
  persistOutcomeOutbox();
  try {
    const rawAck = await postJson<unknown>("/kb/trades", tradeOutcomeToQuantPayload(outcome), 30_000);
    const ack = OutcomeAckSchema.parse(rawAck);
    if (ack.sourceId !== outcome.id) {
      throw new Error(`outcome acknowledgement mismatch: expected ${outcome.id}, got ${ack.sourceId}`);
    }
    pendingOutcomes.delete(outcome.id);
    persistOutcomeOutbox();
    return { synced: true };
  } catch (err) {
    return {
      synced: false,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
  });
}

function persistBatchAckFailure(outcome: TradeOutcome, ack: z.infer<typeof OutcomeBatchAckItemSchema>): void {
  const mutable = outcome as TradeOutcome & {
    quantBrainLastAckAt?: number;
    quantBrainLastError?: string;
    quantBrainBlockedReasons?: string[];
  };
  mutable.quantBrainLastAckAt = Date.now();
  if (ack.error) mutable.quantBrainLastError = ack.error;
  if (ack.blockedReasons.length > 0) mutable.quantBrainBlockedReasons = ack.blockedReasons;
}

export async function flushPendingQuantBrainOutcomes(): Promise<void> {
  return withOutcomeOutboxLock(async () => {
  if (!quantBrainEnabled() || pendingOutcomes.size === 0 || outcomeFlushInFlight) return;
  const batch = Array.from(pendingOutcomes.values()).slice(0, OUTCOME_SYNC_BATCH_SIZE);
  // Parallel flush — never wait 30s × N sequentially when QB is slow/down
  outcomeFlushInFlight = true;
  try {
    const rawAck = await postJson<unknown>("/kb/trades/batch", tradeOutcomesToQuantBatchPayload(batch), 30_000);
    const ack = OutcomeBatchAckSchema.parse(rawAck);
    const ackBySourceId = new Map(ack.items.map((item) => [item.sourceId, item]));
    let changed = false;
    let removed = 0;
    for (const outcome of batch) {
      const itemAck = ackBySourceId.get(outcome.id);
      if (!itemAck) {
        logger.warn({ sourceId: outcome.id }, "quant brain batch ack missing sourceId");
        continue;
      }
      if (itemAck.recorded || itemAck.duplicate) {
        pendingOutcomes.delete(outcome.id);
        changed = true;
        removed++;
        logger.info({
          sourceId: outcome.id,
          recorded: itemAck.recorded,
          duplicate: itemAck.duplicate,
        }, "quant brain batch ack accepted");
      } else {
        persistBatchAckFailure(outcome, itemAck);
        changed = true;
        logger.warn({
          sourceId: outcome.id,
          blockedReasons: itemAck.blockedReasons,
          error: itemAck.error,
        }, "quant brain batch ack kept pending");
      }
    }
    if (changed) persistOutcomeOutbox();
    outcomeFlushBatches++;
    outcomeFlushRecords += removed;
  } catch (err) {
    logger.warn({ err }, "quant brain batch ack invalid or failed; keeping pending outcomes");
    outcomeFlushFailures++;
  } finally {
    outcomeFlushInFlight = false;
  }
  });
}

export function startQuantBrainOutcomeSync(initialOutcomes: TradeOutcome[] = []): void {
  for (const outcome of loadOutcomeOutbox()) {
    if (validateLearningEligibility(outcome).learningEligible) pendingOutcomes.set(outcome.id, outcome);
  }
  for (const outcome of initialOutcomes) {
    if (validateLearningEligibility(outcome).learningEligible) pendingOutcomes.set(outcome.id, outcome);
  }
  persistOutcomeOutbox();
  if (outcomeSyncTimer) return;
  outcomeSyncTimer = setInterval(() => {
    void flushPendingQuantBrainOutcomes();
  }, OUTCOME_SYNC_INTERVAL_MS);
  outcomeSyncTimer.unref?.();
  void flushPendingQuantBrainOutcomes();
}

export function getQuantBrainQueueStats() {
  return {
    pendingOutcomes: pendingOutcomes.size,
    maxPendingOutcomes: MAX_PENDING_OUTCOMES,
    flushInFlight: outcomeFlushInFlight,
    flushBatches: outcomeFlushBatches,
    flushRecords: outcomeFlushRecords,
    flushFailures: outcomeFlushFailures,
    retryBudgetUsed,
    retryBudgetLimit: RETRY_BUDGET_PER_MINUTE,
    retryBudgetResetAt,
  };
}

export function getQuantBrainOperationalStats() {
  return {
    enabled: quantBrainEnabled(),
    gateMode: quantBrainGateMode(),
    urlConfigured: Boolean(quantBrainUrl()),
    requestCount,
    requestErrorCount,
    requestTimeoutCount,
    errorRate: requestCount > 0 ? requestErrorCount / requestCount : 0,
    timeoutRate: requestCount > 0 ? requestTimeoutCount / requestCount : 0,
    latencyMs: {
      samples: requestLatencySamples.length,
      p50: percentile(requestLatencySamples, 0.50),
      p95: percentile(requestLatencySamples, 0.95),
      p99: percentile(requestLatencySamples, 0.99),
    },
    lastRequestError,
    lastRequestErrorAt,
  };
}

export function _resetQuantBrainOutcomeStateForTesting(): void {
  pendingOutcomes.clear();
  if (outcomeSyncTimer) clearInterval(outcomeSyncTimer);
  outcomeSyncTimer = null;
  outcomeFlushInFlight = false;
  outcomeFlushFailures = 0;
  outcomeFlushBatches = 0;
  outcomeFlushRecords = 0;
  persistOutcomeOutbox();
}

export function _enqueueQuantBrainOutcomeForTesting(outcome: TradeOutcome): void {
  pendingOutcomes.set(outcome.id, outcome);
  persistOutcomeOutbox();
}

export interface SentimentContext {
  direction: "BULL" | "BEAR" | "NEUTRAL";
  confidence: number;
  biasRatio: number;
  dominantSide: "LONG" | "SHORT" | "NEUTRAL";
  vwapDeviation?: number;
  volumeDelta?: number;
  momentum24h?: number;
}

export interface QuantBrainEdgeInput {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  hourUtc?: number;
  btcChangePct?: number;
  currentEv?: number;
  currentWinRate?: number;
  currentProfitFactor?: number;
  config: BotConfig;
  costModel?: unknown;
  sentimentContext?: SentimentContext;
  // Contract v2 — signal provenance & lifecycle
  signalId?: string;
  marketEventId?: string;
  expiresAt?: number;
  featureVersion?: string;
  featureTimestampMs?: number;
  candleIsComplete?: boolean;
  marketDataSource?: "bingx";
  referencePrice?: number;
  observationSourceType?: "hypothetical" | "vst_campaign" | "shadow_sampler";
  requestTimestamp?: number;
  contractVersion?: string;
}

type NormalizedEdgeInput = QuantBrainEdgeInput & Required<
  Pick<
    QuantBrainEdgeInput,
    "signalId" | "marketEventId" | "expiresAt" | "featureVersion" |
    "requestTimestamp" | "contractVersion"
  >
>;

function normalizeEdgeInput(input: QuantBrainEdgeInput): NormalizedEdgeInput {
  const now = Date.now();
  const completedFiveMinuteClose = Math.floor(now / 300_000) * 300_000;
  const completedFiveMinuteOpen = completedFiveMinuteClose - 300_000;
  return {
    ...input,
    signalId: input.signalId ?? randomUUID(),
    marketEventId: input.marketEventId
      ?? canonicalMarketEventId(input.symbol, "5m", completedFiveMinuteOpen),
    expiresAt: input.expiresAt ?? now + 30_000,
    featureVersion: input.featureVersion ?? DEFAULT_FEATURE_VERSION,
    featureTimestampMs: input.featureTimestampMs ?? completedFiveMinuteClose,
    candleIsComplete: input.candleIsComplete ?? true,
    marketDataSource: input.marketDataSource ?? "bingx",
    requestTimestamp: input.requestTimestamp ?? now,
    contractVersion: QUANT_BRAIN_CONTRACT_VERSION,
  } as NormalizedEdgeInput;
}

export function validateQuantBrainEdgeResponse(
  raw: unknown,
  request: NormalizedEdgeInput,
  now = Date.now(),
): QuantBrainEdgeResult {
  const result = QuantBrainEdgeResponseSchema.parse(raw);
  if (!SUPPORTED_FEATURE_VERSIONS.has(request.featureVersion)) {
    throw new Error(`unsupported request featureVersion: ${request.featureVersion}`);
  }
  if (result.featureVersion !== request.featureVersion) {
    throw new Error(`featureVersion mismatch: expected ${request.featureVersion}, got ${result.featureVersion}`);
  }
  if (
    result.signalId !== request.signalId
    || result.marketEventId !== request.marketEventId
    || normalizeMarketSymbol(result.symbol) !== normalizeMarketSymbol(request.symbol)
    || result.side !== request.side
    || result.positionSide !== request.positionSide
  ) {
    throw new Error("prediction provenance mismatch");
  }
  if (request.candleIsComplete === false) {
    throw new Error("incomplete candle rejected");
  }
  if (request.featureTimestampMs !== undefined) {
    if (!Number.isSafeInteger(request.featureTimestampMs) || request.featureTimestampMs <= 0) {
      throw new Error("invalid feature timestamp");
    }
    if (request.featureTimestampMs > request.requestTimestamp) {
      throw new Error("feature timestamp is in the future");
    }
    if (request.requestTimestamp - request.featureTimestampMs > MAX_FEATURE_AGE_MS) {
      throw new Error("stale feature timestamp");
    }
    if (result.predictionTimestamp + 1_000 < request.featureTimestampMs) {
      throw new Error("prediction predates feature timestamp");
    }
  }
  if (now - result.predictionTimestamp > MAX_PREDICTION_AGE_MS) {
    throw new Error("stale prediction timestamp");
  }
  if (result.predictionTimestamp + 1_000 < request.requestTimestamp) {
    throw new Error("prediction predates request");
  }
  if (result.dataAgeMs !== null && result.dataAgeMs > MAX_MARKET_DATA_AGE_MS) {
    throw new Error("stale prediction market data");
  }
  if (!result.available && (result.score !== null || result.calibratedProbability !== null)) {
    throw new Error("unavailable prediction must not contain a score or probability");
  }
  return result;
}

export async function evaluateQuantBrainEdge(
  input: QuantBrainEdgeInput,
): Promise<QuantBrainEdgeResult> {
  if (!quantBrainEnabled()) return unavailableGate("disabled");
  const request = normalizeEdgeInput(input);
  try {
    const timeoutMs = quantBrainGateMode() === "enforce"
      ? ENFORCE_EDGE_TIMEOUT_MS
      : SHADOW_EDGE_TIMEOUT_MS;
    const raw = await postJson<unknown>("/edge/evaluate", request, timeoutMs);
    const result = validateQuantBrainEdgeResponse(raw, request);
    if (result.driftPolicy) lastDriftPolicy = { ...result.driftPolicy };
    return result;
  } catch (err) {
    return unavailableGate(err instanceof Error ? err.message : "unknown error");
  }
}

export interface QuantBrainIntelligence {
  connected: boolean;
  enabled: boolean;
  gateMode: QuantBrainGateMode;
  checkedAt: number;
  edge: QuantBrainEdgeResult;
  health: unknown;
  model: unknown;
  signalEdge: unknown;
  newsContext: unknown;
  errors: Record<string, string>;
}

export async function getQuantBrainIntelligence(
  input: QuantBrainEdgeInput,
): Promise<QuantBrainIntelligence> {
  const gateMode = quantBrainGateMode();
  if (!quantBrainEnabled()) {
    return {
      connected: false,
      enabled: false,
      gateMode,
      checkedAt: Date.now(),
      edge: unavailableGate("disabled"),
      health: null,
      model: null,
      signalEdge: null,
      newsContext: null,
      errors: { service: "disabled" },
    };
  }

  const symbol = encodeURIComponent(input.symbol);
  const side = encodeURIComponent(input.positionSide);
  
  const [edge, health, model, signalEdge, newsContext] = await Promise.all([
    getCachedIntelligenceEdge(input),
    getCachedJson<unknown>("health/live", "/health/live", 600),
    getCachedJson<unknown>("models/sniper/status", "/models/sniper/status", INTELLIGENCE_SIDECAR_TIMEOUT_MS),
    getCachedJson<unknown>(`signals/edge/${symbol}:${side}`, `/signals/edge/${symbol}?side=${side}`, INTELLIGENCE_SIDECAR_TIMEOUT_MS),
    getCachedJson<unknown>(`news/context/${symbol}`, `/news/context/${symbol}`, 600),
  ]);

  const errors: Record<string, string> = {};
  if (health.error) errors.health = health.stale ? `stale: ${health.error}` : health.error;
  if (model.error) errors.model = model.stale ? `stale: ${model.error}` : model.error;
  if (signalEdge.error) errors.signalEdge = signalEdge.stale ? `stale: ${signalEdge.error}` : signalEdge.error;
  if (newsContext.error) errors.newsContext = newsContext.stale ? `stale: ${newsContext.error}` : newsContext.error;

  return {
    connected: health.value !== null,
    enabled: true,
    gateMode,
    checkedAt: Date.now(),
    edge,
    health: health.value,
    model: model.value,
    signalEdge: signalEdge.value,
    newsContext: newsContext.value,
    errors,
  };
}

export async function getQuantBrainScoreCalibrationStatus(
  days = 30,
  limit = 5000,
): Promise<unknown> {
  if (!quantBrainEnabled()) {
    return {
      connected: false,
      enabled: false,
      error: "disabled",
      scoreTruth: {
        isMonotonic: false,
        calibrationQuality: "INSUFFICIENT_DATA",
        overconfidence: false,
        bestBucket: null,
        toxicBucket: null,
        recommendedMinScore: 0.58,
        recommendedBoostScore: 0.76,
      },
      buckets: [],
      recommendedThresholds: {
        minAggressiveScore: 0.58,
        minStackingScore: 0.68,
        minBoostScore: 0.76,
        maxSniperScore: 0.92,
      },
      overconfidenceWarnings: ["quant_brain_disabled"],
      bestScoringModel: null,
      scoreVsActualPnlChartData: [],
    };
  }
  const params = new URLSearchParams({
    days: String(Math.max(1, Math.floor(days))),
    limit: String(Math.max(50, Math.floor(limit))),
  });
  return await getJson<unknown>(`/score-calibration/status?${params.toString()}`, SUMMARY_TIMEOUT_MS);
}
