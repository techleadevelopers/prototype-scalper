import test from "node:test";
import assert from "node:assert/strict";
import { calculatePositionSizing } from "../positionSizing";

const baseInput = {
  symbol: "ETH-USDT",
  positionSide: "LONG" as const,
  accountEquity: 1000,
  availableMargin: 1000,
  aggressiveScore: 0.78,
  recentWinRate: 0.56,
  profitFactor: 1.7,
  drawdown: 0,
  executionSlippageBps: 1,
  currentOpenPositions: [],
  baseMarginFallback: 5,
  leverageFallback: 10,
  stopLossPct: 0.1,
  takeProfitPct: 0.2,
};

test("marginal positive ML EV forces micro sizing", () => {
  const sizing = calculatePositionSizing({
    ...baseInput,
    calibratedProbability: 0.62,
    expectedValuePct: 0.0004,
    optimalThreshold: 0.60,
    profitabilityVerified: true,
    kellyFraction: 0.01,
    btcRegime: "BULL",
  });

  assert.equal(sizing.approved, true);
  assert.equal(sizing.riskTier, "MICRO");
  assert.ok(sizing.recommendedMargin <= sizing.baseMargin * 0.25);
});

test("verified high probability ML edge can reach max sniper under risk caps", () => {
  const sizing = calculatePositionSizing({
    ...baseInput,
    calibratedProbability: 0.76,
    expectedValuePct: 0.002,
    optimalThreshold: 0.60,
    profitabilityVerified: true,
    kellyFraction: 0.22,
    mlSizingMultiplier: 2,
    btcRegime: "BULL",
  });

  assert.equal(sizing.approved, true);
  assert.equal(sizing.riskTier, "MAX_SNIPER");
  assert.ok(sizing.sizeMultiplier > 1.5);
});
