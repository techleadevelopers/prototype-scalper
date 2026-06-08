/**
 * Live Position Watcher — autonomous outcome recording for live trades.
 *
 * Fills the critical gap: bot places orders but never detects when they close.
 * This watcher polls BingX positions every LIVE_WATCHER_POLL_MS and when a tracked
 * position disappears (TP/SL hit or manual close), it:
 *   1. Fetches the exit order from BingX order history
 *   2. Reconstructs the TradeOutcome via buildOutcomeFromOrders
 *   3. Records it to telemetryStore → AdaptiveEngine learns automatically
 *   4. Syncs to Quant Brain for ML training
 *
 * Design principles:
 *   - Source of truth is always BingX — we poll live state, never trust stale cache
 *   - Idempotent: recordedIds Set prevents double-recording across poll cycles
 *   - Credential-agnostic: adopts the most recent creds (one active session per user)
 *   - Zero blocking on critical path: all detection/recording runs in background interval
 *   - Stacking-aware: handles N entries per (symbol, positionSide) via oldest→oldest pairing
 *   - Stale entry eviction: entries older than STALE_ENTRY_TTL_MS are pruned with a warning
 */

import { createHmac } from "crypto";
import fs from "fs";
import path from "path";
import { buildOutcomeFromOrders, recordTradeOutcome } from "./telemetryStore";
import { syncQuantBrainOutcome } from "./quantBrainClient";
import { logger } from "./logger";
import type { BtcRegime } from "./adaptiveEngine";

// ── Config ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = Math.max(
  5_000,
  parseInt(process.env["LIVE_WATCHER_POLL_MS"] ?? "15000", 10),
);
const ORDER_LOOKBACK_EXTRA_MS = 10_000; // fetch orders from slighty before entry time
const STALE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — evict unresolvable entries
const MAX_TRACKED_ENTRIES = 500; // safety cap on registry size
const BINGX_BASE = "https://open-api.bingx.com";
const BINGX_TIMEOUT_MS = 8_000;
const LIVE_WATCHER_JOURNAL_PATH = process.env["LIVE_WATCHER_JOURNAL_PATH"]
  ?? path.join(process.cwd(), "data", "live-watcher-journal.json");
const LIVE_WATCHER_DEADLETTER_PATH = process.env["LIVE_WATCHER_DEADLETTER_PATH"]
  ?? path.join(process.cwd(), "data", "live-watcher-deadletter.jsonl");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiveTradeEntry {
  entryOrderId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  side: "BUY" | "SELL";
  expectedEntryPrice: number;
  qty: number;
  leverage: number;
  marginUsed: number;
  btcRegime: BtcRegime;
  hourUtc: number;
  entryTime: number;
  expectedTpProfit: number;
  takeProfitPct: number;
  stopLossPct: number;
  riskTier?: "MICRO" | "SCOUT" | "BASE" | "BOOST" | "AGGRESSIVE" | "MAX_SNIPER";
  sizeMultiplier?: number;
  sizeReason?: string;
  recommendedMargin?: number;
  recommendedLeverage?: number;
  maxLossIfStop?: number;
  notional?: number;
  signalId?: string;
  marketEventId?: string;
  clientOrderId?: string;
  predictionId?: string;
  featureVersion?: string;
  strategyVersion?: string;
  configVersion?: string;
  policyVersion?: string;
  labelVersion?: string;
  modelVersion?: string;
  scoreCalibrationVersion?: string;
  sizingPolicyVersion?: string;
  rotationPolicyVersion?: string;
  playbookVersion?: string;
  signalCreatedAt?: number;
  qbEvaluatedAt?: number;
  orderRequestedAt?: number;
  orderSentAt?: number;
  orderAckAt?: number;
  positionConfirmedAt?: number;
  protectionAttachedAt?: number;
  spreadBps?: number;
  spreadAtSignal?: number;
  spreadAtEntry?: number;
  orderType?: string;
  playbook?: string;
  readinessScopeId?: string;
  promotionState?: "DEMO_ONLY" | "SHADOW_LIVE" | "MICRO_LIVE" | "LIMITED_LIVE" | "STANDARD_LIVE" | "SUSPENDED";
  stackingDepth?: number;
  exitPolicy?: string;
}

interface BingXRawOrder {
  orderId: string;
  symbol: string;
  side: string;
  positionSide: string;
  type: string;
  origQty: string;
  price: string;
  avgPrice: string;
  stopPrice: string | null;
  status: string;
  time: number;
  profit: string | null;
  commission: string | null;
}

interface BingXRawPosition {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  avgPrice: string;
  markPrice: string;
  leverage: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

// entryOrderId → entry context
const tracked = new Map<string, LiveTradeEntry>();
// entryOrderIds that have been successfully recorded — never re-process
const recordedIds = new Set<string>();
// latest credentials from any order placement
let activeCreds: { apiKey: string; secretKey: string } | null = null;
// watcher interval handle
let watchHandle: NodeJS.Timeout | null = null;
let isRunning = false;
let pollInFlight = false;
let statSkippedOverlaps = 0;

// ── Stats ─────────────────────────────────────────────────────────────────────

let statPollCount = 0;
let statClosesDetected = 0;
let statOutcomesRecorded = 0;
let statLastPollAt = 0;
let statLastError: string | null = null;
let statLastClosedAt: number | null = null;
let statDeadLettered = 0;

function persistWatcherJournal(): void {
  try {
    fs.mkdirSync(path.dirname(LIVE_WATCHER_JOURNAL_PATH), { recursive: true });
    const tmp = `${LIVE_WATCHER_JOURNAL_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      tracked: Array.from(tracked.values()),
      recordedIds: Array.from(recordedIds).slice(-5_000),
      savedAt: Date.now(),
    }), "utf8");
    fs.renameSync(tmp, LIVE_WATCHER_JOURNAL_PATH);
  } catch (err) {
    statLastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "[watcher] failed to persist live watcher journal");
  }
}

function deadLetterEntry(entry: LiveTradeEntry, reason: string): void {
  statDeadLettered++;
  try {
    fs.mkdirSync(path.dirname(LIVE_WATCHER_DEADLETTER_PATH), { recursive: true });
    fs.appendFileSync(LIVE_WATCHER_DEADLETTER_PATH, `${JSON.stringify({
      reason,
      deadLetteredAt: Date.now(),
      entry,
    })}\n`, "utf8");
  } catch (err) {
    statLastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err, entryOrderId: entry.entryOrderId, reason }, "[watcher] failed to dead-letter live entry");
  }
}

function loadWatcherJournal(): void {
  try {
    if (!fs.existsSync(LIVE_WATCHER_JOURNAL_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(LIVE_WATCHER_JOURNAL_PATH, "utf8")) as {
      tracked?: LiveTradeEntry[];
      recordedIds?: string[];
    };
    for (const id of parsed.recordedIds ?? []) {
      if (typeof id === "string" && id) recordedIds.add(id);
    }
    for (const entry of parsed.tracked ?? []) {
      if (entry?.entryOrderId && !recordedIds.has(entry.entryOrderId)) {
        tracked.set(entry.entryOrderId, entry);
      }
    }
    logger.info({ tracked: tracked.size, recordedIds: recordedIds.size }, "[watcher] restored live watcher journal");
  } catch (err) {
    statLastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "[watcher] failed to load live watcher journal");
  }
}

loadWatcherJournal();

// ── BingX HTTP ────────────────────────────────────────────────────────────────

function signParams(params: Record<string, string | number>, secret: string): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secret).update(qs).digest("hex");
}

async function bingxGet(
  path: string,
  params: Record<string, string | number>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = signParams(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    headers: { "X-BX-APIKEY": apiKey },
    signal: AbortSignal.timeout(BINGX_TIMEOUT_MS),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

// ── BingX Data Fetchers ───────────────────────────────────────────────────────

async function fetchOpenPositions(
  apiKey: string,
  secretKey: string,
): Promise<BingXRawPosition[]> {
  const data = await bingxGet("/openApi/swap/v2/user/positions", {}, apiKey, secretKey);
  if (data.code !== 0) return [];
  return ((data.data as unknown[]) ?? []) as BingXRawPosition[];
}

async function fetchFilledOrders(
  symbol: string,
  startTime: number,
  apiKey: string,
  secretKey: string,
): Promise<BingXRawOrder[]> {
  const data = await bingxGet(
    "/openApi/swap/v2/trade/allOrders",
    { symbol, startTime, limit: 200 },
    apiKey,
    secretKey,
  );
  if (data.code !== 0) {
    logger.warn({ code: data.code, msg: data.msg, symbol }, "[watcher] allOrders API error");
    return [];
  }
  const orders = ((data.data as Record<string, unknown>)?.orders ?? []) as BingXRawOrder[];
  return orders.filter((o) => o.status === "FILLED");
}

// ── Exit Reason Inference ─────────────────────────────────────────────────────

function inferExitReason(
  exitPrice: number,
  entryPrice: number,
  positionSide: "LONG" | "SHORT",
  takeProfitPct: number,
  stopLossPct: number,
): "TP" | "SL" | "MANUAL" {
  if (entryPrice <= 0 || exitPrice <= 0) return "MANUAL";

  const movePct = positionSide === "LONG"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  // TP hit: price moved at least 70% of expected TP distance in the right direction
  if (movePct >= takeProfitPct * 0.70) return "TP";
  // SL hit: price moved at least 70% of expected SL distance against us
  if (movePct <= -stopLossPct * 0.70) return "SL";
  // Ambiguous region (partial TP, manual close, liquidation, etc.)
  return "MANUAL";
}

// ── Core Poll Cycle ───────────────────────────────────────────────────────────

async function pollCycle(): Promise<void> {
  if (pollInFlight) {
    statSkippedOverlaps++;
    return;
  }
  pollInFlight = true;
  try {
  if (!activeCreds) return;

  statPollCount++;
  statLastPollAt = Date.now();

  // Build a snapshot of active (not yet recorded) entries
  const activeEntries: LiveTradeEntry[] = [];
  const now = Date.now();

  for (const [orderId, entry] of tracked.entries()) {
    if (recordedIds.has(orderId)) {
      tracked.delete(orderId); // clean up already-recorded entries
      persistWatcherJournal();
      continue;
    }
    // Evict stale entries that are too old to recover
    if (now - entry.entryTime > STALE_ENTRY_TTL_MS) {
      logger.warn({
        orderId,
        symbol: entry.symbol,
        positionSide: entry.positionSide,
        ageHours: ((now - entry.entryTime) / 3600_000).toFixed(1),
      }, "[watcher] dead-lettering stale unresolved entry");
      deadLetterEntry(entry, "STALE_UNRESOLVED_ENTRY");
      tracked.delete(orderId);
      persistWatcherJournal();
      continue;
    }
    activeEntries.push(entry);
  }

  if (activeEntries.length === 0) return;

  // Fetch all open positions from BingX
  let positions: BingXRawPosition[];
  try {
    positions = await fetchOpenPositions(activeCreds.apiKey, activeCreds.secretKey);
  } catch (err) {
    statLastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "[watcher] failed to fetch positions — will retry next cycle");
    return;
  }

  // Index open positions by "SYMBOL:POSITIONSIDE"
  const openSet = new Set<string>();
  for (const pos of positions) {
    const amt = parseFloat(String(pos.positionAmt ?? "0"));
    if (amt !== 0) {
      openSet.add(`${String(pos.symbol).toUpperCase()}:${String(pos.positionSide).toUpperCase()}`);
    }
  }

  // Group tracked entries by (symbol, positionSide)
  const groups = new Map<string, LiveTradeEntry[]>();
  for (const entry of activeEntries) {
    const key = `${entry.symbol}:${entry.positionSide}`;
    const g = groups.get(key);
    if (g) g.push(entry);
    else groups.set(key, [entry]);
  }

  // Process each group where the position has fully closed
  for (const [groupKey, entries] of groups.entries()) {
    if (openSet.has(groupKey)) continue; // still open — skip

    const [symbol, positionSide] = groupKey.split(":") as [string, "LONG" | "SHORT"];

    // Sort entries by entryTime ascending (oldest first) for oldest→oldest pairing
    entries.sort((a, b) => a.entryTime - b.entryTime);
    const earliestEntryTime = entries[0].entryTime;

    logger.info({
      groupKey,
      entryCount: entries.length,
      oldestEntryAge: ((now - earliestEntryTime) / 1000).toFixed(0) + "s",
    }, "[watcher] position close detected — fetching order history");

    // Fetch all filled orders for this symbol since earliest entry
    let filledOrders: BingXRawOrder[];
    try {
      filledOrders = await fetchFilledOrders(
        symbol,
        Math.max(0, earliestEntryTime - ORDER_LOOKBACK_EXTRA_MS),
        activeCreds.apiKey,
        activeCreds.secretKey,
      );
    } catch (err) {
      statLastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err, symbol, groupKey }, "[watcher] failed to fetch order history — will retry next cycle");
      continue;
    }

    statClosesDetected += entries.length;

    // Identify closing orders (opposite side, closing position direction)
    const exitSide = positionSide === "LONG" ? "SELL" : "BUY";
    let exitOrders = filledOrders.filter((o) => {
      return (
        String(o.side).toUpperCase() === exitSide &&
        String(o.positionSide).toUpperCase() === positionSide &&
        o.time >= earliestEntryTime - ORDER_LOOKBACK_EXTRA_MS
      );
    });

    // Primary filter: prefer closing orders that have a profit field (realized PnL)
    const exitOrdersWithProfit = exitOrders.filter(
      (o) => o.profit !== null && o.profit !== undefined && o.profit !== "0" && o.profit !== "",
    );
    if (exitOrdersWithProfit.length > 0) {
      exitOrders = exitOrdersWithProfit;
    }

    // Sort exits oldest first for pairing with entries
    exitOrders.sort((a, b) => a.time - b.time);

    if (exitOrders.length === 0) {
      logger.warn({ groupKey, entryCount: entries.length },
        "[watcher] no exit orders found — position may still be settling; will retry next cycle");
      // Don't remove entries — they'll be checked again next poll
      continue;
    }

    // Find entry orders from BingX history for commission data
    const entrySide = positionSide === "LONG" ? "BUY" : "SELL";
    const entryOrdersFromBingx = filledOrders
      .filter((o) =>
        String(o.side).toUpperCase() === entrySide &&
        String(o.positionSide).toUpperCase() === positionSide &&
        o.time >= earliestEntryTime - ORDER_LOOKBACK_EXTRA_MS,
      )
      .sort((a, b) => a.time - b.time);

    // Pair entries to exits: oldest→oldest
    const pairsToRecord = Math.min(entries.length, exitOrders.length);

    for (let i = 0; i < pairsToRecord; i++) {
      const entry = entries[i];
      const exitOrder = exitOrders[i];

      if (recordedIds.has(entry.entryOrderId)) continue;

      // Find the matching BingX entry order by orderId, fall back to positional match
      const bingxEntry = entryOrdersFromBingx.find((o) => o.orderId === entry.entryOrderId)
        ?? entryOrdersFromBingx[i]
        ?? null;

      // Build the entryOrder shape — prefer real BingX data, fall back to our recorded context
      const entryOrderShape: {
        orderId: string;
        symbol: string;
        side: string;
        positionSide: string;
        avgPrice: string;
        origQty: string;
        commission: string | null;
        time: number;
      } = bingxEntry
        ? { ...bingxEntry }
        : {
            orderId: entry.entryOrderId,
            symbol: entry.symbol,
            side: entry.side,
            positionSide: entry.positionSide,
            avgPrice: String(entry.expectedEntryPrice),
            origQty: String(entry.qty),
            commission: null,
            time: entry.entryTime,
          };

      const exitPrice = parseFloat(exitOrder.avgPrice) || 0;
      const entryPrice = parseFloat(entryOrderShape.avgPrice) || entry.expectedEntryPrice;

      const exitReason = inferExitReason(
        exitPrice,
        entryPrice,
        positionSide,
        entry.takeProfitPct,
        entry.stopLossPct,
      );

      try {
        const outcome = buildOutcomeFromOrders(
          entryOrderShape,
          exitOrder,
          {
            btcRegime: entry.btcRegime,
            leverage: entry.leverage,
            marginUsed: entry.marginUsed,
            expectedTpProfit: entry.expectedTpProfit,
            exitReason,
            expectedEntryPrice: entry.expectedEntryPrice,
            expectedExitPrice: exitPrice > 0 ? exitPrice : undefined,
          },
        );
        outcome.signalId = entry.signalId;
        outcome.marketEventId = entry.marketEventId;
        outcome.clientOrderId = entry.clientOrderId;
        outcome.predictionId = entry.predictionId;
        outcome.featureVersion = entry.featureVersion;
        outcome.strategyVersion = entry.strategyVersion;
        outcome.configVersion = entry.configVersion;
        outcome.policyVersion = entry.policyVersion;
        outcome.labelVersion = entry.labelVersion;
        outcome.modelVersion = entry.modelVersion;
        outcome.expectedEntryPrice = entry.expectedEntryPrice;
        outcome.markPriceBeforeOrder = entry.expectedEntryPrice;
        outcome.actualAvgEntryPrice = outcome.entryPrice;
        outcome.actualExitPrice = outcome.exitPrice;
        outcome.signalCreatedAt = entry.signalCreatedAt;
        outcome.qbEvaluatedAt = entry.qbEvaluatedAt;
        outcome.orderRequestedAt = entry.orderRequestedAt;
        outcome.orderSentAt = entry.orderSentAt;
        outcome.orderAckAt = entry.orderAckAt;
        outcome.positionConfirmedAt = entry.positionConfirmedAt ?? outcome.entryTime;
        outcome.positionClosedAt = outcome.exitTime;
        outcome.monitorDetectedCloseAt = Date.now();
        outcome.protectionAttachedAt = entry.protectionAttachedAt;
        outcome.spreadBps = entry.spreadBps;
        outcome.spreadAtSignal = entry.spreadAtSignal;
        outcome.spreadAtEntry = entry.spreadAtEntry;
        outcome.orderType = entry.orderType;
        outcome.playbook = entry.playbook;
        outcome.readinessScopeId = entry.readinessScopeId;
        outcome.promotionState = entry.promotionState;
        outcome.stackingDepth = entry.stackingDepth;
        outcome.exitPolicy = entry.exitPolicy;
        outcome.riskTier = entry.riskTier;
        outcome.sizeMultiplier = entry.sizeMultiplier;
        outcome.sizeReason = entry.sizeReason;
        outcome.recommendedMargin = entry.recommendedMargin;
        outcome.recommendedLeverage = entry.recommendedLeverage;
        outcome.maxLossIfStop = entry.maxLossIfStop;
        outcome.notional = entry.notional;

        recordTradeOutcome(outcome);
        recordedIds.add(entry.entryOrderId);
        tracked.delete(entry.entryOrderId);
        persistWatcherJournal();
        statOutcomesRecorded++;
        statLastClosedAt = Date.now();

        logger.info({
          entryOrderId: entry.entryOrderId,
          symbol: entry.symbol,
          positionSide: entry.positionSide,
          exitReason,
          realizedPnl: outcome.realizedPnl.toFixed(4),
          grossPnl: outcome.grossPnl.toFixed(4),
          fee: outcome.fee.toFixed(4),
          entryPrice: outcome.entryPrice,
          exitPrice: outcome.exitPrice,
          leverage: outcome.leverage,
          durationSec: ((outcome.exitTime - outcome.entryTime) / 1000).toFixed(0),
          btcRegime: outcome.btcRegime,
          hourUtc: outcome.hourUtc,
        }, "[watcher] ✅ live trade outcome recorded — AdaptiveEngine updated");

        // Fire-and-forget Quant Brain sync — never block recording on QB latency
        syncQuantBrainOutcome(outcome).catch((err: unknown) => {
          logger.warn({ err, entryOrderId: entry.entryOrderId },
            "[watcher] QB sync failed for recorded outcome");
        });

      } catch (err) {
        statLastError = err instanceof Error ? err.message : String(err);
        logger.error({ err, entryOrderId: entry.entryOrderId, symbol, positionSide },
          "[watcher] failed to build or record trade outcome");
      }
    }
  }
  } finally {
    pollInFlight = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a live trade entry for outcome tracking.
 * Call immediately after a successful BingX order placement.
 */
export function registerLiveEntry(entry: LiveTradeEntry): void {
  if (recordedIds.has(entry.entryOrderId)) return; // already processed

  // Enforce registry cap — evict oldest if full
  if (tracked.size >= MAX_TRACKED_ENTRIES) {
    const sorted = Array.from(tracked.values()).sort((a, b) => a.entryTime - b.entryTime);
    const oldest = sorted[0];
    if (oldest) {
      logger.warn({ orderId: oldest.entryOrderId },
        "[watcher] registry cap reached — dead-lettering oldest unresolved entry");
      deadLetterEntry(oldest, "REGISTRY_CAP_REACHED");
      tracked.delete(oldest.entryOrderId);
    }
  }

  tracked.set(entry.entryOrderId, entry);
  persistWatcherJournal();

  logger.info({
    entryOrderId: entry.entryOrderId,
    symbol: entry.symbol,
    positionSide: entry.positionSide,
    side: entry.side,
    expectedEntryPrice: entry.expectedEntryPrice,
    qty: entry.qty,
    leverage: entry.leverage,
    btcRegime: entry.btcRegime,
    hourUtc: entry.hourUtc,
    trackedTotal: tracked.size,
  }, "[watcher] live entry registered for outcome tracking");
}

/**
 * Update active credentials used for BingX polling.
 * Called on every successful order placement so creds stay fresh.
 */
export function updateWatcherCreds(creds: { apiKey: string; secretKey: string }): void {
  activeCreds = creds;
}

/**
 * Start the background position watcher interval.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startLivePositionWatcher(): void {
  if (isRunning) return;
  isRunning = true;
  watchHandle = setInterval(() => {
    pollCycle().catch((err: unknown) => {
      statLastError = err instanceof Error ? (err as Error).message : String(err);
      logger.warn({ err }, "[watcher] uncaught error in poll cycle");
    });
  }, POLL_INTERVAL_MS);
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "[watcher] live position watcher started");
}

/**
 * Stop the background watcher. Tracked entries are preserved in memory.
 */
export function stopLivePositionWatcher(): void {
  if (watchHandle) {
    clearInterval(watchHandle);
    watchHandle = null;
  }
  isRunning = false;
  persistWatcherJournal();
  logger.info("[watcher] live position watcher stopped");
}

/**
 * Health and statistics snapshot for the monitoring endpoint.
 */
export function getLiveWatcherStats(): {
  running: boolean;
  pollIntervalMs: number;
  credentials: "configured" | "missing";
  trackedEntries: number;
  recordedLifetime: number;
  pollCount: number;
  closesDetected: number;
  outcomesRecorded: number;
  lastPollAt: number | null;
  lastClosedAt: number | null;
  lastError: string | null;
  pollInFlight: boolean;
  skippedOverlaps: number;
  deadLettered: number;
  journalPath: string;
  deadLetterPath: string;
  entries: Array<{
    entryOrderId: string;
    symbol: string;
    positionSide: string;
    entryTime: number;
    ageMs: number;
    btcRegime: BtcRegime;
    qty: number;
    leverage: number;
    marginUsed: number;
    protectionAttachedAt: number | null;
    exitPolicy: string | null;
    riskTier: string | null;
  }>;
} {
  const now = Date.now();
  return {
    running: isRunning,
    pollIntervalMs: POLL_INTERVAL_MS,
    credentials: activeCreds ? "configured" : "missing",
    trackedEntries: tracked.size,
    recordedLifetime: recordedIds.size,
    pollCount: statPollCount,
    closesDetected: statClosesDetected,
    outcomesRecorded: statOutcomesRecorded,
    lastPollAt: statLastPollAt || null,
    lastClosedAt: statLastClosedAt,
    lastError: statLastError,
    pollInFlight,
    skippedOverlaps: statSkippedOverlaps,
    deadLettered: statDeadLettered,
    journalPath: LIVE_WATCHER_JOURNAL_PATH,
    deadLetterPath: LIVE_WATCHER_DEADLETTER_PATH,
    entries: Array.from(tracked.values()).map((e) => ({
      entryOrderId: e.entryOrderId,
      symbol: e.symbol,
      positionSide: e.positionSide,
      entryTime: e.entryTime,
      ageMs: now - e.entryTime,
      btcRegime: e.btcRegime,
      qty: e.qty,
      leverage: e.leverage,
      marginUsed: e.marginUsed,
      protectionAttachedAt: e.protectionAttachedAt ?? null,
      exitPolicy: e.exitPolicy ?? null,
      riskTier: e.riskTier ?? null,
    })),
  };
}
