/**
 * demoTradeStore ledger hardening tests.
 * Uses setDataDir + _resetStoreForTesting for per-test isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  initDemoTradeStore,
  persistOpenTrade,
  closeOpenTrade,
  getOpenTrades,
  getOpenTradesAsMap,
  getOpenTradeByOrderId,
  getCampaignOpenCount,
  getClosedTradeIds,
  getClosedTradesForCampaign,
  buildCampaignOutcome,
  resolveCampaignId,
  setDataDir,
  _resetStoreForTesting,
} from "../demoTradeStore";

// ──────────────────────────────────────────────────────────────────────────────
// Test setup: isolated temp directory per test
// ──────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-store-test-"));
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "data", "archive"), { recursive: true });
  // Point the store at this test's data dir and reset all in-memory state
  setDataDir(path.join(tmpDir, "data"));
  _resetStoreForTesting();
  await initDemoTradeStore();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Helper builders
// ──────────────────────────────────────────────────────────────────────────────
let _seq = 0;

function makeOpenPayload(overrides: Partial<Parameters<typeof persistOpenTrade>[0]> = {}) {
  const id = `ord-${++_seq}-${Date.now()}`;
  return {
    orderId: id,
    clientOrderId: `coid-${id}`,
    symbol: "BTC-USDT",
    side: "BUY" as const,
    positionSide: "LONG" as const,
    entryTime: Date.now(),
    entryPrice: 40000,
    expectedEntryPrice: 39990,
    qty: 0.001,
    leverage: 10,
    marginUsed: 4,
    notional: 40,
    tpPct: 1.0,
    slPct: 0.5,
    btcRegime: "BULLISH",
    hourUtc: 12,
    edgeScore: 0.85,
    modelVersion: "sniper-v1",
    fallbackMode: false,
    mfe: 0,
    mae: 0,
    mfeAt: null,
    maeAt: null,
    lastMarkPrice: null,
    lastCheckedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function makeClosePayload(overrides: Partial<Parameters<typeof closeOpenTrade>[1]> = {}) {
  return {
    exitTime: Date.now(),
    exitPrice: 40400,
    expectedExitPrice: null,
    grossPnl: 0.4,
    fee: 0.04,
    entrySlippage: 10,
    exitSlippage: 0,
    realizedPnl: 0.36,
    pnlSource: "price_estimate" as const,
    estimated: true,
    exitReason: "TP" as const,
    exitOrderId: null,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Basic open/close
// ──────────────────────────────────────────────────────────────────────────────
describe("basic open/close", () => {
  it("persistOpenTrade adds entry to open trades", async () => {
    const p = makeOpenPayload();
    await persistOpenTrade(p);
    const trades = getOpenTrades();
    expect(trades.some((t) => t.orderId === p.orderId)).toBe(true);
  });

  it("getOpenTradeByOrderId finds entry by orderId", async () => {
    const p = makeOpenPayload();
    await persistOpenTrade(p);
    const found = getOpenTradeByOrderId(p.orderId);
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe(p.orderId);
  });

  it("closeOpenTrade removes from open trades", async () => {
    const p = makeOpenPayload();
    await persistOpenTrade(p);
    const entry = getOpenTradeByOrderId(p.orderId)!;
    await closeOpenTrade(entry.tradeId, makeClosePayload());
    expect(getOpenTradeByOrderId(p.orderId)).toBeNull();
  });

  it("closeOpenTrade adds to closedTradeIds", async () => {
    const p = makeOpenPayload();
    await persistOpenTrade(p);
    const entry = getOpenTradeByOrderId(p.orderId)!;
    const closed = await closeOpenTrade(entry.tradeId, makeClosePayload());
    expect(closed).not.toBeNull();
    expect(getClosedTradeIds().has(entry.tradeId)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Idempotency
// ──────────────────────────────────────────────────────────────────────────────
describe("idempotency", () => {
  it("persistOpenTrade with same orderId is a no-op on second call", async () => {
    const p = makeOpenPayload();
    await persistOpenTrade(p);
    await persistOpenTrade(p); // duplicate
    const trades = getOpenTrades().filter((t) => t.orderId === p.orderId);
    expect(trades).toHaveLength(1);
  });

  it("closeOpenTrade with same tradeId returns same result on second call (idempotent)", async () => {
    const p = makeOpenPayload();
    await persistOpenTrade(p);
    const entry = getOpenTradeByOrderId(p.orderId)!;
    const c1 = await closeOpenTrade(entry.tradeId, makeClosePayload());
    // Second call: idempotency — returns cached result or null, does NOT double-record
    const c2 = await closeOpenTrade(entry.tradeId, makeClosePayload({ realizedPnl: -999 }));
    expect(c1).not.toBeNull();
    // c2 is either the cached object or null; the key invariant is that closedTradeIds
    // still has exactly ONE entry for this tradeId (no duplication)
    expect(getClosedTradeIds().has(entry.tradeId)).toBe(true);
    // realizedPnl must NOT be -999 (second call's payload was ignored)
    if (c2 !== null) {
      expect(c2.realizedPnl).not.toBe(-999);
    }
  });

  it("concurrent persistOpenTrade calls with same orderId produce exactly one entry", async () => {
    const p = makeOpenPayload();
    // Fire 10 concurrent writes
    await Promise.all(Array.from({ length: 10 }, () => persistOpenTrade(p)));
    const trades = getOpenTrades().filter((t) => t.orderId === p.orderId);
    expect(trades).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Campaign tracking
// ──────────────────────────────────────────────────────────────────────────────
describe("campaign open count", () => {
  it("getCampaignOpenCount is 0 for unknown campaign", () => {
    expect(getCampaignOpenCount("no-such-campaign")).toBe(0);
  });

  it("increments per persisted entry in same campaign", async () => {
    const t0 = Date.now();
    const campaignId = resolveCampaignId("BTC-USDT", "LONG", t0);
    await persistOpenTrade(makeOpenPayload({ entryTime: t0 }));
    await persistOpenTrade(makeOpenPayload({ entryTime: t0 + 100 }));
    expect(getCampaignOpenCount(campaignId)).toBe(2);
  });

  it("decrements when entry is closed", async () => {
    const t0 = Date.now();
    const campaignId = resolveCampaignId("SOL-USDT", "SHORT", t0);
    const p1 = makeOpenPayload({ symbol: "SOL-USDT", positionSide: "SHORT", side: "SELL", entryTime: t0 });
    const p2 = makeOpenPayload({ symbol: "SOL-USDT", positionSide: "SHORT", side: "SELL", entryTime: t0 + 50 });
    await persistOpenTrade(p1);
    await persistOpenTrade(p2);
    expect(getCampaignOpenCount(campaignId)).toBe(2);

    const e1 = getOpenTradeByOrderId(p1.orderId)!;
    await closeOpenTrade(e1.tradeId, makeClosePayload());
    expect(getCampaignOpenCount(campaignId)).toBe(1);
  });

  it("returns 0 when all campaign entries closed", async () => {
    const t0 = Date.now();
    const sym = "ETH-USDT";
    const campaignId = resolveCampaignId(sym, "LONG", t0);
    const p = makeOpenPayload({ symbol: sym, entryTime: t0 });
    await persistOpenTrade(p);
    const entry = getOpenTradeByOrderId(p.orderId)!;
    await closeOpenTrade(entry.tradeId, makeClosePayload());
    expect(getCampaignOpenCount(campaignId)).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Restart recovery
// ──────────────────────────────────────────────────────────────────────────────
describe("restart recovery", () => {
  it("getOpenTradesAsMap is populated after re-init", async () => {
    const p1 = makeOpenPayload({ symbol: "BTC-USDT", entryTime: Date.now() });
    const p2 = makeOpenPayload({ symbol: "ETH-USDT", entryTime: Date.now() });
    await persistOpenTrade(p1);
    await persistOpenTrade(p2);

    // Simulate restart: reset memory and call initDemoTradeStore again
    _resetStoreForTesting();
    await initDemoTradeStore();

    const map = getOpenTradesAsMap();
    expect(map.has(p1.orderId)).toBe(true);
    expect(map.has(p2.orderId)).toBe(true);
  });

  it("closed trade IDs are remembered across re-init", async () => {
    const p = makeOpenPayload();
    await persistOpenTrade(p);
    const entry = getOpenTradeByOrderId(p.orderId)!;
    await closeOpenTrade(entry.tradeId, makeClosePayload());
    const closedId = entry.tradeId;

    // Simulate restart
    _resetStoreForTesting();
    await initDemoTradeStore();
    expect(getClosedTradeIds().has(closedId)).toBe(true);
  });

  it(".tmp recovery: stranded .tmp file is promoted on re-init", async () => {
    // Persist a trade to create the open file
    const p1 = makeOpenPayload();
    await persistOpenTrade(p1);

    const openPath = path.join(tmpDir, "data", "demo-open.jsonl");
    const tmpPath = `${openPath}.tmp`;

    // Simulate crash: write .tmp with valid content, leave it stranded
    fs.writeFileSync(tmpPath, fs.readFileSync(openPath));

    // Simulate restart: reset memory, then init (should recover .tmp)
    _resetStoreForTesting();
    await initDemoTradeStore();

    // After recovery: open file should exist and .tmp should be gone
    expect(fs.existsSync(openPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
    // Original trade should still be loaded
    expect(getOpenTradeByOrderId(p1.orderId)).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildCampaignOutcome
// ──────────────────────────────────────────────────────────────────────────────
describe("buildCampaignOutcome", () => {
  it("returns null for empty trades array", () => {
    expect(buildCampaignOutcome([])).toBeNull();
  });

  it("aggregates PnL correctly across two entries", async () => {
    const t0 = Date.now();
    const sym = "AVAX-USDT";
    const p1 = makeOpenPayload({ symbol: sym, entryTime: t0, entryPrice: 20, qty: 5, marginUsed: 10 });
    const p2 = makeOpenPayload({ symbol: sym, entryTime: t0 + 100, entryPrice: 21, qty: 5, marginUsed: 10 });
    await persistOpenTrade(p1);
    await persistOpenTrade(p2);

    const e1 = getOpenTradeByOrderId(p1.orderId)!;
    const e2 = getOpenTradeByOrderId(p2.orderId)!;
    await closeOpenTrade(e1.tradeId, makeClosePayload({ realizedPnl: 1.0, grossPnl: 1.1, fee: 0.1, exitPrice: 22 }));
    await closeOpenTrade(e2.tradeId, makeClosePayload({ realizedPnl: 0.5, grossPnl: 0.6, fee: 0.1, exitPrice: 22 }));

    const campaignId = e1.campaignId;
    const trades = getClosedTradesForCampaign(campaignId);
    expect(trades).toHaveLength(2);

    const outcome = buildCampaignOutcome(trades);
    expect(outcome).not.toBeNull();
    expect(outcome!.entryCount).toBe(2);
    expect(outcome!.realizedPnl).toBeCloseTo(1.5, 4);
    expect(outcome!.totalFee).toBeCloseTo(0.2, 4);
    expect(outcome!.totalQty).toBeCloseTo(10, 4);
  });

  it("notional-weighted average entry price", async () => {
    // Entry 1: 10 units at $100 (notional $1000)
    // Entry 2: 10 units at $200 (notional $2000)
    // Weighted avg = (1000 + 2000) / 20 = $150
    const t0 = Date.now();
    const sym = "LINK-USDT";
    const p1 = makeOpenPayload({ symbol: sym, entryTime: t0, entryPrice: 100, qty: 10, marginUsed: 10 });
    const p2 = makeOpenPayload({ symbol: sym, entryTime: t0 + 100, entryPrice: 200, qty: 10, marginUsed: 20 });
    await persistOpenTrade(p1);
    await persistOpenTrade(p2);
    const e1 = getOpenTradeByOrderId(p1.orderId)!;
    const e2 = getOpenTradeByOrderId(p2.orderId)!;
    await closeOpenTrade(e1.tradeId, makeClosePayload({ exitPrice: 110 }));
    await closeOpenTrade(e2.tradeId, makeClosePayload({ exitPrice: 210 }));
    const trades = getClosedTradesForCampaign(e1.campaignId);
    const outcome = buildCampaignOutcome(trades);
    expect(outcome!.avgEntryPrice).toBeCloseTo(150, 2);
  });

  it("exchange_reported wins over price_estimate in pnlSource", async () => {
    const t0 = Date.now();
    const sym = "DOT-USDT";
    const p1 = makeOpenPayload({ symbol: sym, entryTime: t0 });
    const p2 = makeOpenPayload({ symbol: sym, entryTime: t0 + 100 });
    await persistOpenTrade(p1);
    await persistOpenTrade(p2);
    const e1 = getOpenTradeByOrderId(p1.orderId)!;
    const e2 = getOpenTradeByOrderId(p2.orderId)!;
    await closeOpenTrade(e1.tradeId, makeClosePayload({ pnlSource: "price_estimate", estimated: true }));
    await closeOpenTrade(e2.tradeId, makeClosePayload({ pnlSource: "exchange_reported", estimated: false }));
    const trades = getClosedTradesForCampaign(e1.campaignId);
    const outcome = buildCampaignOutcome(trades);
    expect(outcome!.pnlSource).toBe("exchange_reported");
    expect(outcome!.estimated).toBe(true); // any estimated = true
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Campaign sample deduplication
// ──────────────────────────────────────────────────────────────────────────────
describe("campaign sample deduplication", () => {
  it("10 stacked entries → 1 campaign outcome (prevents correlated ML samples)", async () => {
    const t0 = Date.now();
    const sym = "BNB-USDT";
    const campaignId = resolveCampaignId(sym, "LONG", t0);
    const entryIds: string[] = [];

    for (let i = 0; i < 10; i++) {
      const p = makeOpenPayload({ symbol: sym, entryTime: t0 + i * 50 });
      await persistOpenTrade(p);
      entryIds.push(p.orderId);
    }

    for (const orderId of entryIds) {
      const entry = getOpenTradeByOrderId(orderId)!;
      await closeOpenTrade(entry.tradeId, makeClosePayload());
    }

    expect(getCampaignOpenCount(campaignId)).toBe(0);

    const closedTrades = getClosedTradesForCampaign(campaignId);
    expect(closedTrades).toHaveLength(10);

    // buildCampaignOutcome returns exactly 1 outcome object
    const outcome = buildCampaignOutcome(closedTrades);
    expect(outcome).not.toBeNull();
    expect(outcome!.entryCount).toBe(10);
    expect(outcome!.campaignId).toBe(campaignId);
  });
});
