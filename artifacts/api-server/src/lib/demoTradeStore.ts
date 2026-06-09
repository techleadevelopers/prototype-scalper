/**
 * Demo Trade Store — persistent JSONL ledger for open demo positions and closed outcomes.
 *
 * Survives API server restarts (unlike the in-memory sniperOpenTrades Map).
 * Provides idempotent writes, crash-safe atomic renames, deduplication,
 * campaign-level outcome aggregation, and bounded file growth.
 *
 * Two files:
 *   demo-open.jsonl   — current open entries (atomic rewrite via .tmp)
 *   demo-closed.jsonl — append-only closed trade ledger (archived at MAX_CLOSED_LINES)
 *
 * Campaign semantics:
 *   Entries for the same symbol+positionSide placed within CAMPAIGN_WINDOW_MS
 *   of the first entry share the same campaign_id. A new campaign starts when
 *   the symbol+side has been flat for longer than the window.
 *
 * Idempotency:
 *   persistOpenTrade  — skips if orderId already exists in _openTrades
 *   closeOpenTrade    — skips if tradeId already in _closedTradeIds
 *   Both operations are serialized through _writeLock.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { logger } from "./logger";

// ========== CONSTANTS ==========

// DATA_DIR can be overridden for testing via setDataDir(); all path accessors
// use the getter so test isolation works without module re-import.
// In cloud, point DEMO_TRADE_DATA_DIR or RUNTIME_DATA_DIR at a persistent volume.
function resolveDefaultDataDir(): string {
  const configured = process.env["DEMO_TRADE_DATA_DIR"] || process.env["RUNTIME_DATA_DIR"];
  return configured ? path.resolve(configured) : path.join(process.cwd(), "data");
}

let _dataDir = resolveDefaultDataDir();
function DATA_DIR()   { return _dataDir; }
function OPEN_FILE()  { return path.join(_dataDir, "demo-open.jsonl"); }
function CLOSED_FILE(){ return path.join(_dataDir, "demo-closed.jsonl"); }
function ARCHIVE_DIR(){ return path.join(_dataDir, "archive"); }

/** Override data directory — for tests only. Must be called before initDemoTradeStore(). */
export function setDataDir(dir: string): void { _dataDir = dir; }

/** Reset all in-memory state — for tests only. Does NOT touch files. */
export function _resetStoreForTesting(): void {
  _openTrades    = new Map();
  _openByOrderId = new Map();
  _campaigns     = new Map();
  _closedTradeIds = new Set();
  _closedCache   = new Map();
  _writeLock     = Promise.resolve();
}
const CAMPAIGN_WINDOW_MS = parseInt(process.env["DEMO_CAMPAIGN_WINDOW_MS"] ?? "3600000", 10); // 1h
const MAX_CLOSED_LINES = parseInt(process.env["DEMO_MAX_CLOSED_LINES"] ?? "10000", 10);
const MAX_CLOSED_CACHE = parseInt(process.env["DEMO_MAX_CLOSED_CACHE"] ?? "2000", 10);

// ========== TYPES ==========

export interface DemoTradeEntry {
  tradeId: string;
  campaignId: string;
  signalId: string;
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  entryTime: number;
  entryPrice: number;
  expectedEntryPrice: number | null;
  qty: number;
  leverage: number;
  marginUsed: number;
  notional: number;
  tpPct: number;
  slPct: number;
  btcRegime: string;
  hourUtc: number;
  edgeScore: number | null;
  stackingDepth?: number;
  controlMaxEntries?: 1 | 3 | 5 | 10;
  edgeAtInsertion?: number;
  calibratedProbability?: number | null;
  uncertaintyType?: string | null;
  marketEventId?: string | null;
  predictionId?: string | null;
  featureVersion?: string | null;
  stateFingerprint?: string | null;
  correlationAdjustedExposure?: number;
  modelVersion: string | null;
  fallbackMode: boolean;
  mfe: number;
  mae: number;
  mfeAt: number | null;
  maeAt: number | null;
  lastMarkPrice: number | null;
  lastCheckedAt: number | null;
  closedAt: number | null;
}

export interface DemoClosedTrade extends DemoTradeEntry {
  exitTime: number;
  exitPrice: number;
  expectedExitPrice: number | null;
  holdDurationMs: number;
  grossPnl: number;
  fee: number;
  entrySlippage: number;
  exitSlippage: number;
  totalSlippage: number;
  slippagePctNotional: number;
  funding: number;
  realizedPnl: number;
  pnlSource: "exchange_reported" | "balance_delta" | "price_estimate";
  estimated: boolean;
  exitReason: "TP" | "SL" | "MANUAL";
  exitOrderId: string | null;
}

/**
 * Aggregated campaign outcome — one ML sample per campaign (not per entry).
 * Contains only information available at the first entry time.
 */
export interface DemoCampaignOutcome {
  campaignId: string;
  signalId: string;
  marketEventId: string | null;
  predictionId: string | null;
  clientOrderId: string | null;
  exchangeOrderId: string;
  featureVersion: string | null;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  side: "BUY" | "SELL";
  entryCount: number;
  openedAt: number;             // first entry time
  closedAt: number;             // last exit time
  holdDurationMs: number;
  totalQty: number;
  totalNotional: number;
  totalMarginUsed: number;
  avgEntryPrice: number;        // notional-weighted
  avgExitPrice: number;         // notional-weighted
  grossPnl: number;
  totalFee: number;
  realizedPnl: number;
  mfe: number;                  // max MFE across entries
  mae: number;                  // min MAE across entries (most negative)
  exitReasons: Record<string, number>;
  btcRegime: string;            // from first entry
  hourUtc: number;              // from first entry
  fallbackMode: boolean;        // true if any entry was fallback
  modelVersion: string | null;  // from first entry
  pnlSource: "exchange_reported" | "balance_delta" | "price_estimate";
  estimated: boolean;
}

// ========== IN-MEMORY STATE ==========

let _openTrades = new Map<string, DemoTradeEntry>();            // keyed by tradeId
let _openByOrderId = new Map<string, string>();                  // orderId → tradeId (fast lookup)
let _campaigns = new Map<string, { campaignId: string; lastEntryAt: number }>(); // symbol:positionSide → campaign
let _closedTradeIds = new Set<string>();                         // dedup set (tradeId)
let _closedCache = new Map<string, DemoClosedTrade>();           // tradeId → closed (last MAX_CLOSED_CACHE)
let _writeLock: Promise<void> = Promise.resolve();

// ========== HELPERS ==========

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR())) fs.mkdirSync(DATA_DIR(), { recursive: true });
  if (!fs.existsSync(ARCHIVE_DIR())) fs.mkdirSync(ARCHIVE_DIR(), { recursive: true });
}

function acquireLock(): Promise<() => void> {
  let release!: () => void;
  const prev = _writeLock;
  _writeLock = new Promise<void>((r) => { release = r; });
  return prev.then(() => release);
}

async function appendLine(file: string, obj: object): Promise<void> {
  const line = JSON.stringify(obj) + "\n";
  await fs.promises.appendFile(file, line, "utf-8");
}

async function rewriteOpenFile(): Promise<void> {
  const lines = Array.from(_openTrades.values())
    .map((e) => JSON.stringify(e))
    .join("\n");
  const tmp = `${OPEN_FILE()}.tmp`;
  await fs.promises.writeFile(tmp, lines ? lines + "\n" : "", "utf-8");
  await fs.promises.rename(tmp, OPEN_FILE());
}

function evictClosedCache(): void {
  if (_closedCache.size <= MAX_CLOSED_CACHE) return;
  // Evict oldest by exitTime
  const sorted = Array.from(_closedCache.entries()).sort(
    (a, b) => (a[1].exitTime ?? 0) - (b[1].exitTime ?? 0),
  );
  const toDelete = Math.ceil(sorted.length / 4);
  for (let i = 0; i < toDelete; i++) _closedCache.delete(sorted[i][0]);
}

// ========== STARTUP LOAD ==========

export async function initDemoTradeStore(): Promise<void> {
  ensureDir();

  // Recover a stranded .tmp file (crash during rewrite)
  const tmpFile = `${OPEN_FILE()}.tmp`;
  if (fs.existsSync(tmpFile)) {
    try {
      const tmpStat = fs.statSync(tmpFile);
      const mainStat = fs.existsSync(OPEN_FILE()) ? fs.statSync(OPEN_FILE()) : null;
      if (!mainStat || tmpStat.mtimeMs > mainStat.mtimeMs) {
        // .tmp is newer — it was the intended final state; complete the rename
        await fs.promises.rename(tmpFile, OPEN_FILE());
        logger.warn("[demoTradeStore] recovered stranded .tmp file");
      } else {
        await fs.promises.unlink(tmpFile);
      }
    } catch { /* non-fatal */ }
  }

  // Load open trades
  if (fs.existsSync(OPEN_FILE())) {
    const rl = readline.createInterface({ input: fs.createReadStream(OPEN_FILE()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as DemoTradeEntry;
        if (entry.tradeId && entry.orderId) {
          _openTrades.set(entry.tradeId, entry);
          _openByOrderId.set(entry.orderId, entry.tradeId);
        }
      } catch { /* skip corrupt */ }
    }
    logger.info({ count: _openTrades.size }, "[demoTradeStore] loaded open trades from disk");
  }

  // Rebuild campaign index from open trades
  for (const entry of _openTrades.values()) {
    const key = `${entry.symbol}:${entry.positionSide}`;
    const existing = _campaigns.get(key);
    if (!existing || entry.entryTime > existing.lastEntryAt) {
      _campaigns.set(key, { campaignId: entry.campaignId, lastEntryAt: entry.entryTime });
    }
  }

  // Load closed trade IDs + last MAX_CLOSED_CACHE for campaign lookups
  if (!fs.existsSync(CLOSED_FILE())) {
    await fs.promises.writeFile(CLOSED_FILE(), "", "utf-8");
  } else {
    const allClosed: DemoClosedTrade[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(CLOSED_FILE()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as DemoClosedTrade;
        if (t.tradeId) {
          _closedTradeIds.add(t.tradeId);
          allClosed.push(t);
        }
      } catch { /* skip */ }
    }
    // Keep last MAX_CLOSED_CACHE in memory
    const recent = allClosed.slice(-MAX_CLOSED_CACHE);
    for (const t of recent) _closedCache.set(t.tradeId, t);
    logger.info({ total: _closedTradeIds.size, cached: _closedCache.size }, "[demoTradeStore] loaded closed trade IDs");
  }
}

// ========== CAMPAIGN RESOLUTION ==========

export function resolveCampaignId(symbol: string, positionSide: "LONG" | "SHORT", entryTime: number): string {
  const key = `${symbol}:${positionSide}`;
  const existing = _campaigns.get(key);
  if (existing && (entryTime - existing.lastEntryAt) <= CAMPAIGN_WINDOW_MS) {
    existing.lastEntryAt = entryTime;
    return existing.campaignId;
  }
  const newId = crypto.randomUUID();
  _campaigns.set(key, { campaignId: newId, lastEntryAt: entryTime });
  return newId;
}

export function getActiveCampaignId(
  symbol: string,
  positionSide: "LONG" | "SHORT",
  entryTime: number,
): string | null {
  const existing = _campaigns.get(`${symbol}:${positionSide}`);
  return existing && (entryTime - existing.lastEntryAt) <= CAMPAIGN_WINDOW_MS
    ? existing.campaignId
    : null;
}

// ========== OPEN TRADE OPERATIONS ==========

export async function persistOpenTrade(entry: Omit<DemoTradeEntry, "tradeId" | "campaignId" | "signalId"> & {
  tradeId?: string;
  campaignId?: string;
  signalId?: string;
}): Promise<DemoTradeEntry> {
  // Idempotency: skip if orderId already persisted
  const existingTradeId = _openByOrderId.get(entry.orderId);
  if (existingTradeId) {
    const existing = _openTrades.get(existingTradeId);
    if (existing) return existing;
  }

  const release = await acquireLock();
  try {
    const now = entry.entryTime || Date.now();
    const campaignId = entry.campaignId ?? resolveCampaignId(entry.symbol, entry.positionSide, now);
    const campaignSignalId = Array.from(_openTrades.values()).find(
      (open) => open.campaignId === campaignId,
    )?.signalId;
    const full: DemoTradeEntry = {
      ...entry,
      clientOrderId: entry.clientOrderId ?? null,
      tradeId: entry.tradeId ?? crypto.randomUUID(),
      campaignId,
      signalId: entry.signalId ?? campaignSignalId ?? crypto.randomUUID(),
      mfe: entry.mfe ?? 0,
      mae: entry.mae ?? 0,
      mfeAt: entry.mfeAt ?? null,
      maeAt: entry.maeAt ?? null,
      lastMarkPrice: entry.lastMarkPrice ?? null,
      lastCheckedAt: entry.lastCheckedAt ?? null,
      closedAt: entry.closedAt ?? null,
    } as DemoTradeEntry;

    // Double-check idempotency inside lock
    if (_openByOrderId.has(entry.orderId)) {
      const tid = _openByOrderId.get(entry.orderId)!;
      return _openTrades.get(tid) ?? full;
    }

    _openTrades.set(full.tradeId, full);
    _openByOrderId.set(full.orderId, full.tradeId);
    _campaigns.set(`${full.symbol}:${full.positionSide}`, {
      campaignId: full.campaignId,
      lastEntryAt: full.entryTime,
    });
    await rewriteOpenFile();
    return full;
  } finally {
    release();
  }
}

export async function updateOpenTradeMfe(
  tradeId: string,
  markPrice: number,
  now = Date.now(),
): Promise<void> {
  const entry = _openTrades.get(tradeId);
  if (!entry) return;

  const grossPnl = entry.positionSide === "LONG"
    ? (markPrice - entry.entryPrice) * entry.qty
    : (entry.entryPrice - markPrice) * entry.qty;

  let changed = false;
  if (grossPnl > entry.mfe) { entry.mfe = grossPnl; entry.mfeAt = now; changed = true; }
  if (grossPnl < entry.mae) { entry.mae = grossPnl; entry.maeAt = now; changed = true; }
  entry.lastMarkPrice = markPrice;
  entry.lastCheckedAt = now;

  if (changed) {
    const release = await acquireLock();
    try { await rewriteOpenFile(); } finally { release(); }
  }
}

export async function closeOpenTrade(
  tradeId: string,
  closeData: {
    exitTime: number;
    exitPrice: number;
    expectedExitPrice: number | null;
    grossPnl: number;
    fee: number;
    entrySlippage: number;
    exitSlippage: number;
    funding?: number;
    realizedPnl: number;
    pnlSource: "exchange_reported" | "balance_delta" | "price_estimate";
    estimated: boolean;
    exitReason: "TP" | "SL" | "MANUAL";
    exitOrderId: string | null;
  },
): Promise<DemoClosedTrade | null> {
  // Idempotency: skip if already closed
  if (_closedTradeIds.has(tradeId)) {
    return _closedCache.get(tradeId) ?? null;
  }

  const entry = _openTrades.get(tradeId);
  if (!entry) return null;

  const release = await acquireLock();
  try {
    // Double-check inside lock
    if (_closedTradeIds.has(tradeId)) {
      return _closedCache.get(tradeId) ?? null;
    }

    const totalSlippage = closeData.entrySlippage + closeData.exitSlippage;
    const notional = entry.entryPrice * entry.qty;
    const closed: DemoClosedTrade = {
      ...entry,
      exitTime: closeData.exitTime,
      exitPrice: closeData.exitPrice,
      expectedExitPrice: closeData.expectedExitPrice,
      holdDurationMs: closeData.exitTime - entry.entryTime,
      grossPnl: closeData.grossPnl,
      fee: closeData.fee,
      entrySlippage: closeData.entrySlippage,
      exitSlippage: closeData.exitSlippage,
      totalSlippage,
      slippagePctNotional: notional > 0 ? totalSlippage / notional : 0,
      funding: closeData.funding ?? 0,
      realizedPnl: closeData.realizedPnl,
      pnlSource: closeData.pnlSource,
      estimated: closeData.estimated,
      exitReason: closeData.exitReason,
      exitOrderId: closeData.exitOrderId,
      closedAt: closeData.exitTime,
    };

    _openTrades.delete(tradeId);
    _openByOrderId.delete(entry.orderId);
    _closedTradeIds.add(tradeId);
    _closedCache.set(tradeId, closed);
    evictClosedCache();

    await rewriteOpenFile();
    await appendLine(CLOSED_FILE(), closed);

    return closed;
  } finally {
    release();
  }
}

// ========== QUERIES ==========

export function getOpenTrades(): DemoTradeEntry[] {
  return Array.from(_openTrades.values());
}

export function getOpenTradeByOrderId(orderId: string): DemoTradeEntry | null {
  const tradeId = _openByOrderId.get(orderId);
  return tradeId ? (_openTrades.get(tradeId) ?? null) : null;
}

export function getOpenTradeByTradeId(tradeId: string): DemoTradeEntry | null {
  return _openTrades.get(tradeId) ?? null;
}

export function getOpenTradesBySymbolSide(symbol: string, positionSide: "LONG" | "SHORT"): DemoTradeEntry[] {
  return Array.from(_openTrades.values()).filter(
    (e) => e.symbol === symbol && e.positionSide === positionSide,
  );
}

/**
 * Returns open trades keyed by orderId — used to restore sniperOpenTrades after restart.
 */
export function getOpenTradesAsMap(): Map<string, DemoTradeEntry> {
  const m = new Map<string, DemoTradeEntry>();
  for (const e of _openTrades.values()) m.set(e.orderId, e);
  return m;
}

/**
 * Returns the set of closed tradeIds — used to restore sniperRecordedIds after restart.
 */
export function getClosedTradeIds(): Set<string> {
  return new Set(_closedTradeIds);
}

/** Count open entries currently in a campaign. */
export function getCampaignOpenCount(campaignId: string): number {
  let count = 0;
  for (const e of _openTrades.values()) {
    if (e.campaignId === campaignId) count++;
  }
  return count;
}

/** Returns closed trades for a campaign from in-memory cache (last MAX_CLOSED_CACHE). */
export function getClosedTradesForCampaign(campaignId: string): DemoClosedTrade[] {
  const result: DemoClosedTrade[] = [];
  for (const t of _closedCache.values()) {
    if (t.campaignId === campaignId) result.push(t);
  }
  return result.sort((a, b) => a.entryTime - b.entryTime);
}

/** Aggregate PnL stats from in-memory closed-trade cache (no disk I/O). */
export interface DemoTelemetryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
}

export function getDemoTelemetryStats(symbol?: string, side?: string): DemoTelemetryStats {
  const trades = Array.from(_closedCache.values()).filter((t) => {
    if (symbol && t.symbol !== symbol) return false;
    if (side && t.positionSide !== side) return false;
    return true;
  });
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl <= 0);
  const netPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);
  const totalWinPnl = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const totalLossPnl = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0));
  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLossPnl / losses.length : 0;
  const profitFactor =
    totalLossPnl > 0 ? totalWinPnl / totalLossPnl :
    wins.length > 0 ? 999 : 0;
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    profitFactor,
    netPnl,
    avgWin,
    avgLoss,
  };
}

export async function loadClosedTrades(limit = 500): Promise<DemoClosedTrade[]> {
  if (!fs.existsSync(CLOSED_FILE())) return [];
  const results: DemoClosedTrade[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(CLOSED_FILE()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { results.push(JSON.parse(line) as DemoClosedTrade); } catch { /* skip */ }
  }
  return results.slice(-limit);
}

// ========== CAMPAIGN OUTCOME BUILDER ==========

/**
 * Aggregates individual closed trade entries for a campaign into a single ML-safe outcome.
 * Uses only information available at entry time — no future-data leakage.
 */
export function buildCampaignOutcome(trades: DemoClosedTrade[]): DemoCampaignOutcome | null {
  if (trades.length === 0) return null;

  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  let totalQty = 0;
  let totalNotional = 0;
  let totalExitNotional = 0;
  let grossPnl = 0;
  let totalFee = 0;
  let realizedPnl = 0;
  let mfe = 0;
  let mae = 0;
  let fallbackMode = false;
  const exitReasons: Record<string, number> = {};
  let anyEstimated = false;
  let anyExchangeReported = false;

  for (const t of sorted) {
    totalQty += t.qty;
    totalNotional += t.entryPrice * t.qty;
    totalExitNotional += t.exitPrice * t.qty;
    grossPnl += t.grossPnl;
    totalFee += t.fee;
    realizedPnl += t.realizedPnl;
    if (t.mfe > mfe) mfe = t.mfe;
    if (t.mae < mae) mae = t.mae;
    if (t.fallbackMode) fallbackMode = true;
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
    if (t.estimated) anyEstimated = true;
    if (t.pnlSource === "exchange_reported") anyExchangeReported = true;
  }

  const avgEntryPrice = totalQty > 0 ? totalNotional / totalQty : first.entryPrice;
  const avgExitPrice = totalQty > 0 ? totalExitNotional / totalQty : last.exitPrice;
  const pnlSource = anyExchangeReported ? "exchange_reported"
    : anyEstimated ? "price_estimate" : "balance_delta";

  return {
    campaignId: first.campaignId,
    signalId: first.signalId,
    marketEventId: first.marketEventId ?? null,
    predictionId: first.predictionId ?? null,
    clientOrderId: first.clientOrderId,
    exchangeOrderId: first.orderId,
    featureVersion: first.featureVersion ?? null,
    symbol: first.symbol,
    positionSide: first.positionSide,
    side: first.side,
    entryCount: sorted.length,
    openedAt: first.entryTime,
    closedAt: last.exitTime,
    holdDurationMs: last.exitTime - first.entryTime,
    totalQty,
    totalNotional,
    totalMarginUsed: sorted.reduce((s, t) => s + t.marginUsed, 0),
    avgEntryPrice,
    avgExitPrice,
    grossPnl,
    totalFee,
    realizedPnl,
    mfe,
    mae,
    exitReasons,
    btcRegime: first.btcRegime,
    hourUtc: first.hourUtc,
    fallbackMode,
    modelVersion: first.modelVersion,
    pnlSource,
    estimated: anyEstimated,
  };
}

// ========== CAMPAIGN SUMMARY ==========

interface CampaignSummaryEntry {
  campaignId: string;
  symbol: string;
  positionSide: string;
  openEntries: number;
  totalMarginUsed: number;
  totalNotional: number;
  mfe: number;
  mae: number;
  oldestEntryAt: number;
}

export async function getCampaignSummary(): Promise<Record<string, CampaignSummaryEntry>> {
  const campaigns: Record<string, CampaignSummaryEntry> = {};
  for (const entry of _openTrades.values()) {
    if (!campaigns[entry.campaignId]) {
      campaigns[entry.campaignId] = {
        campaignId: entry.campaignId,
        symbol: entry.symbol,
        positionSide: entry.positionSide,
        openEntries: 0,
        totalMarginUsed: 0,
        totalNotional: 0,
        mfe: 0,
        mae: 0,
        oldestEntryAt: entry.entryTime,
      };
    }
    const c = campaigns[entry.campaignId];
    c.openEntries++;
    c.totalMarginUsed += entry.marginUsed;
    c.totalNotional += entry.notional;
    c.mfe += entry.mfe;
    c.mae += entry.mae;
    if (entry.entryTime < c.oldestEntryAt) c.oldestEntryAt = entry.entryTime;
  }
  return campaigns;
}

// ========== BOUNDED GROWTH ==========

/**
 * Archives demo-closed.jsonl when it exceeds MAX_CLOSED_LINES.
 * Rotates to archive/demo-closed-TIMESTAMP.jsonl.
 * Safe to call at start of each sniper cycle.
 */
export async function archiveClosedIfNeeded(): Promise<void> {
  if (!fs.existsSync(CLOSED_FILE())) return;
  try {
    const content = await fs.promises.readFile(CLOSED_FILE(), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < MAX_CLOSED_LINES) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = path.join(ARCHIVE_DIR(), `demo-closed-${timestamp}.jsonl`);
    await fs.promises.rename(CLOSED_FILE(), archivePath);
    await fs.promises.writeFile(CLOSED_FILE(), "", "utf-8");
    logger.info({ lines: lines.length, archivePath }, "[demoTradeStore] archived closed JSONL");
  } catch (err) {
    logger.error({ err }, "[demoTradeStore] archiveClosedIfNeeded failed");
  }
}
