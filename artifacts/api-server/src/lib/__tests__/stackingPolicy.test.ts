import { describe, expect, it } from "vitest";
import type { DemoClosedTrade, DemoTradeEntry } from "../demoTradeStore";
import { buildStackingAudit, evaluateStackingInsertion } from "../stackingPolicy";

function openEntry(overrides: Partial<DemoTradeEntry> = {}): DemoTradeEntry {
  return {
    tradeId: "t1",
    campaignId: "c1",
    signalId: "s1",
    orderId: "o1",
    clientOrderId: null,
    symbol: "BTC-USDT",
    side: "BUY",
    positionSide: "LONG",
    entryTime: 1_000,
    entryPrice: 100,
    expectedEntryPrice: 100,
    qty: 1,
    leverage: 10,
    marginUsed: 10,
    notional: 100,
    tpPct: 1,
    slPct: 1,
    btcRegime: "BULLISH",
    hourUtc: 12,
    edgeScore: 0.7,
    modelVersion: "test",
    fallbackMode: false,
    mfe: 2,
    mae: -1,
    mfeAt: null,
    maeAt: null,
    lastMarkPrice: null,
    lastCheckedAt: null,
    closedAt: null,
    marketEventId: "event-1",
    stateFingerprint: "state-1",
    ...overrides,
  };
}

function closedEntry(depth: number, pnl: number, campaignId: string, exitTime: number): DemoClosedTrade {
  return {
    ...openEntry({
      tradeId: `${campaignId}-${depth}`,
      orderId: `${campaignId}-${depth}`,
      campaignId,
      entryTime: exitTime - 100,
      stackingDepth: depth,
      edgeAtInsertion: 0.7 + depth * 0.01,
      correlationAdjustedExposure: 100,
    }),
    exitTime,
    exitPrice: 101,
    expectedExitPrice: 101,
    holdDurationMs: 100,
    grossPnl: pnl,
    fee: 0,
    entrySlippage: 0,
    exitSlippage: 0,
    totalSlippage: 0,
    slippagePctNotional: 0,
    funding: 0,
    realizedPnl: pnl,
    pnlSource: "exchange_reported",
    estimated: false,
    exitReason: pnl > 0 ? "TP" : "SL",
    exitOrderId: null,
  };
}

describe("evaluateStackingInsertion", () => {
  it("allows an exploratory first entry without model calibration", () => {
    const result = evaluateStackingInsertion({
      openEntries: [],
      proposedSide: "LONG",
      edgeScore: 0.6,
      calibratedProbability: null,
      uncertaintyType: null,
      marketEventId: "event-1",
      stateFingerprint: "state-1",
      now: 1_000,
      cooldownMs: 60_000,
      campaignCap: 1,
      proposedMargin: 10,
      campaignDrawdownPct: 0,
      maxCampaignDrawdownPct: 5,
      portfolioCapacityAvailable: true,
    });
    expect(result.allow).toBe(true);
    expect(result.depth).toBe(1);
  });

  it("rejects duplicate-event averaging and increased size", () => {
    const result = evaluateStackingInsertion({
      openEntries: [openEntry()],
      proposedSide: "LONG",
      edgeScore: 0.8,
      calibratedProbability: 0.7,
      uncertaintyType: "LOW",
      marketEventId: "event-1",
      stateFingerprint: "state-2",
      now: 100_000,
      cooldownMs: 60_000,
      campaignCap: 3,
      proposedMargin: 20,
      campaignDrawdownPct: 1,
      maxCampaignDrawdownPct: 5,
      portfolioCapacityAvailable: true,
    });
    expect(result.allow).toBe(false);
    expect(result.rejects.some((reason) => reason.startsWith("DUPLICATE_EVENT_REJECT"))).toBe(true);
    expect(result.rejects.some((reason) => reason.startsWith("MARTINGALE_REJECT"))).toBe(true);
  });
});

describe("buildStackingAudit", () => {
  it("uses a chronological holdout and reports every depth", () => {
    const trades: DemoClosedTrade[] = [];
    for (let campaign = 0; campaign < 30; campaign++) {
      for (let depth = 1; depth <= 3; depth++) {
        trades.push(closedEntry(depth, depth === 3 ? -0.2 : 1, `c${campaign}`, campaign * 10_000 + depth));
      }
    }
    const report = buildStackingAudit(trades);
    expect(report.trainCampaigns).toBe(21);
    expect(report.testCampaigns).toBe(9);
    expect(report.depths).toHaveLength(10);
    expect(report.controls.map((control) => control.maxEntries)).toEqual([1, 3, 5, 10]);
  });
});
