import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BotConfig } from "../botConfig";
import { getBotConfig } from "../botConfig";
import type { TradeOutcome } from "../adaptiveEngine";
import type { DemoClosedTrade } from "../demoTradeStore";
import { buildLiveReadinessStatus } from "../live_readiness";

const BASE_TIME = 1_800_000_000_000;

function config(): BotConfig {
  return {
    ...getBotConfig(),
    marginPerTrade: 4,
    maxPositionsPerSymbol: 3,
    maxSessionLoss: 20,
  };
}

function demoTrade(index: number, overrides: Partial<DemoClosedTrade> = {}): DemoClosedTrade {
  const win = index % 20 < 11;
  const pnl = win ? 2 : -1;
  return {
    tradeId: `demo-${index}`,
    campaignId: `campaign-${index}`,
    signalId: `signal-${index}`,
    orderId: `demo-order-${index}`,
    clientOrderId: `demo-client-${index}`,
    symbol: "BTC-USDT",
    side: "BUY",
    positionSide: "LONG",
    entryTime: BASE_TIME + index * 1_000,
    entryPrice: 100,
    expectedEntryPrice: 100,
    qty: 1,
    leverage: 10,
    marginUsed: 4,
    notional: 100,
    tpPct: 1,
    slPct: 1,
    btcRegime: "BULL",
    hourUtc: 12,
    edgeScore: 0.75,
    stackingDepth: 1,
    marketEventId: `event-${index}`,
    modelVersion: "test",
    fallbackMode: false,
    mfe: 2,
    mae: -1,
    mfeAt: null,
    maeAt: null,
    lastMarkPrice: null,
    lastCheckedAt: BASE_TIME + index * 1_000,
    closedAt: BASE_TIME + index * 1_000 + 500,
    exitTime: BASE_TIME + index * 1_000 + 500,
    exitPrice: win ? 102 : 99,
    expectedExitPrice: win ? 102 : 99,
    holdDurationMs: 500,
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
    exitReason: win ? "TP" : "SL",
    exitOrderId: `demo-exit-${index}`,
    ...overrides,
  };
}

function liveOutcome(index: number, overrides: Partial<TradeOutcome> = {}): TradeOutcome {
  const exitTime = BASE_TIME + 100_000 + index * 1_000;
  return {
    id: `live-${index}`,
    isDemo: false,
    source: "bingx-live",
    sourceType: "live",
    entryOrderId: `live-entry-${index}`,
    exitOrderId: `live-exit-${index}`,
    symbol: "BTC-USDT",
    positionSide: "LONG",
    side: "BUY",
    entryTime: exitTime - 500,
    exitTime,
    hourUtc: 12,
    btcRegime: "BULL",
    entryPrice: 100,
    exitPrice: 99,
    qty: 1,
    leverage: 10,
    marginUsed: 4,
    grossPnl: -1,
    fee: 0,
    realizedPnl: -1,
    exitReason: "TP",
    expectedTpProfit: 1,
    totalSlippage: 0,
    slippagePctNotional: 0,
    signalId: `live-signal-${index}`,
    marketEventId: `live-event-${index}`,
    featureVersion: "sniper-v1",
    modelVersion: "test",
    aggressiveScore: 0.75,
    riskTier: "MICRO",
    stackingDepth: 1,
    exitPolicy: "TP_SL_PROTECTED",
    ...overrides,
  };
}

describe("live readiness", () => {
  it("keeps a scope without enough sample out of live approval", () => {
    const status = buildLiveReadinessStatus({
      outcomes: [],
      closedDemoTrades: Array.from({ length: 19 }, (_, index) => demoTrade(index)),
      config: config(),
    });

    assert.equal(status.approvedScopes.length, 0);
    assert.equal(status.blockedScopes[0].promotionState, "DEMO_ONLY");
    assert.ok(status.blockedScopes[0].blockedReasons.includes("insufficient_demo_sample"));
  });

  it("promotes a good first scope only to MICRO_LIVE", () => {
    const status = buildLiveReadinessStatus({
      outcomes: [],
      closedDemoTrades: Array.from({ length: 20 }, (_, index) => demoTrade(index)),
      config: config(),
    });

    assert.equal(status.approvedScopes.length, 1);
    assert.equal(status.approvedScopes[0].promotionState, "MICRO_LIVE");
    assert.equal(status.approvedScopes[0].maxPositions, 1);
  });

  it("combines live evidence with the matching demo scope and demotes bad live performance", () => {
    const status = buildLiveReadinessStatus({
      outcomes: Array.from({ length: 30 }, (_, index) => liveOutcome(index)),
      closedDemoTrades: Array.from({ length: 80 }, (_, index) => demoTrade(index)),
      config: config(),
    });
    const btcLongScopes = [...status.approvedScopes, ...status.blockedScopes]
      .filter((scope) => scope.symbol === "BTC-USDT" && scope.side === "LONG");

    assert.equal(btcLongScopes.length, 1);
    assert.notEqual(btcLongScopes[0].promotionState, "STANDARD_LIVE");
    assert.equal(btcLongScopes[0].metrics.liveTrades, 30);
    assert.equal(btcLongScopes[0].metrics.consecutiveLiveLosses, 30);
  });

  it("blocks promotion when live slippage is materially worse than demo", () => {
    const status = buildLiveReadinessStatus({
      outcomes: [liveOutcome(1, { realizedPnl: 1, grossPnl: 1, slippagePctNotional: 0.002 })],
      closedDemoTrades: Array.from({ length: 20 }, (_, index) => demoTrade(index)),
      config: config(),
    });

    assert.equal(status.approvedScopes.length, 0);
    assert.ok(status.blockedScopes[0].blockedReasons.includes("slippage_worse_than_demo"));
  });
});
