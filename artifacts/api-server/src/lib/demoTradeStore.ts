/**
 * Demo Trade Store — persistent JSONL ledger for open demo positions and closed outcomes.
 *
 * Survives API server restarts (unlike the in-memory sniperOpenTrades Map).
 * Adds campaign_id, signal_id, mfe, mae, holdDurationMs, fallbackMode,
 * edgeFeatures, modelVersion to the canonical trade record.
 *
 * Two files:
 *   demo-open.jsonl   — one entry per open position (upserted on placement, deleted on close)
 *   demo-closed.jsonl — append-only closed trade ledger with full accounting
 *
 * Campaign semantics:
 *   Entries for the same symbol+positionSide placed within CAMPAIGN_WINDOW_MS
 *   of the first entry share the same campaign_id. A new campaign starts when
 *   the symbol+side has been flat for longer than the window.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { logger } from "./logger";

// ========== CONSTANTS ==========

const DATA_DIR = path.join(process.cwd(), "data");
const OPEN_FILE = path.join(DATA_DIR, "demo-open.jsonl");
const CLOSED_FILE = path.join(DATA_DIR, "demo-closed.jsonl");
const CAMPAIGN_WINDOW_MS = parseInt(process.env["DEMO_CAMPAIGN_WINDOW_MS"] ?? "3600000", 10); // 1h

// ========== TYPES ==========

export interface DemoTradeEntry {
  tradeId: string;
  campaignId: string;
  signalId: string;
  orderId: string;
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
  pnlSource: "balance_delta" | "price_estimate";
  estimated: boolean;
  exitReason: "TP" | "SL" | "MANUAL";
  exitOrderId: string | null;
}

// ========== IN-MEMORY STATE ==========

// open entries keyed by tradeId
let _openTrades = new Map<string, DemoTradeEntry>();
// campaign tracking: symbol:positionSide → { campaignId, lastEntryAt }
let _campaigns = new Map<string, { campaignId: string; lastEntryAt: number }>();
// write lock
let _writeLock: Promise<void> = Promise.resolve();

// ========== HELPERS ==========

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
  const tmp = `${OPEN_FILE}.tmp`;
  await fs.promises.writeFile(tmp, lines ? lines + "\n" : "", "utf-8");
  await fs.promises.rename(tmp, OPEN_FILE);
}

// ========== STARTUP LOAD ==========

export async function initDemoTradeStore(): Promise<void> {
  ensureDir();

  // Load open trades
  if (fs.existsSync(OPEN_FILE)) {
    const rl = readline.createInterface({ input: fs.createReadStream(OPEN_FILE), crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const entry = JSON.parse(line) as DemoTradeEntry;
        if (entry.tradeId) _openTrades.set(entry.tradeId, entry);
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

  if (!fs.existsSync(CLOSED_FILE)) {
    await fs.promises.writeFile(CLOSED_FILE, "", "utf-8");
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

// ========== OPEN TRADE OPERATIONS ==========

export async function persistOpenTrade(entry: Omit<DemoTradeEntry, "tradeId" | "campaignId" | "signalId"> & {
  tradeId?: string;
  campaignId?: string;
  signalId?: string;
}): Promise<DemoTradeEntry> {
  const release = await acquireLock();
  try {
    const now = entry.entryTime || Date.now();
    const full: DemoTradeEntry = {
      ...entry,
      tradeId: entry.tradeId ?? crypto.randomUUID(),
      campaignId: entry.campaignId ?? resolveCampaignId(entry.symbol, entry.positionSide, now),
      signalId: entry.signalId ?? crypto.randomUUID(),
      mfe: entry.mfe ?? 0,
      mae: entry.mae ?? 0,
      mfeAt: entry.mfeAt ?? null,
      maeAt: entry.maeAt ?? null,
      lastMarkPrice: entry.lastMarkPrice ?? null,
      lastCheckedAt: entry.lastCheckedAt ?? null,
      closedAt: entry.closedAt ?? null,
    } as DemoTradeEntry;
    _openTrades.set(full.tradeId, full);
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
    pnlSource: "balance_delta" | "price_estimate";
    estimated: boolean;
    exitReason: "TP" | "SL" | "MANUAL";
    exitOrderId: string | null;
  },
): Promise<DemoClosedTrade | null> {
  const entry = _openTrades.get(tradeId);
  if (!entry) return null;

  const release = await acquireLock();
  try {
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
    await rewriteOpenFile();
    await appendLine(CLOSED_FILE, closed);
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
  for (const entry of _openTrades.values()) {
    if (entry.orderId === orderId) return entry;
  }
  return null;
}

export function getOpenTradesBySymbolSide(symbol: string, positionSide: "LONG" | "SHORT"): DemoTradeEntry[] {
  return Array.from(_openTrades.values()).filter(
    (e) => e.symbol === symbol && e.positionSide === positionSide,
  );
}

export async function loadClosedTrades(limit = 500): Promise<DemoClosedTrade[]> {
  if (!fs.existsSync(CLOSED_FILE)) return [];
  const results: DemoClosedTrade[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(CLOSED_FILE), crlfDelay: Infinity });
  for await (const line of rl) {
    try { results.push(JSON.parse(line) as DemoClosedTrade); } catch { /* skip */ }
  }
  return results.slice(-limit);
}

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
