import { describe, expect, it } from "vitest";
import type { BotConfig } from "../botConfig";
import { estimateExecutionCosts, feeDragRejectReason } from "../executionRisk";

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    leverage: 10,
    marginPerTrade: 10,
    takeProfitPct: 0.15,
    stopLossPct: 0.1,
    takerFeeBps: 5,
    slippageBpsPerSide: 2,
    estimatedFundingCostPct: 0,
    minEdgeOverCostPct: 0,
    ...overrides,
  } as BotConfig;
}

describe("execution cost model", () => {
  it("counts taker fee and slippage as round-trip not one side", () => {
    const costs = estimateExecutionCosts(10, 10, 0.0005, 1.5, undefined, {
      slippageBpsPerSide: 2,
      takeProfitPct: 0.15,
    });

    expect(costs.notional).toBe(100);
    expect(costs.roundTripFee).toBeCloseTo(0.1);
    expect(costs.slippageCost).toBeCloseTo(0.04);
    expect(costs.totalCost).toBeCloseTo(0.14);
    expect(costs.effectiveSlippageBps).toBe(4);
    expect(costs.expectedTpProfit).toBeCloseTo(0.15);
  });

  it("reports break-even move as pct of notional, not pct of margin", () => {
    const costs = estimateExecutionCosts(10, 10, 0.0005, 1.5, undefined, {
      slippageBpsPerSide: 2,
    });

    expect(costs.breakevenMovePct).toBeCloseTo(0.14);
    expect(costs.totalCostPct).toBeCloseTo(1.4);
  });

  it("funding cost reduces net EV on notional", () => {
    const costs = estimateExecutionCosts(10, 10, 0.0005, 1.5, undefined, {
      grossEv: 0.2,
      slippageBpsPerSide: 2,
      fundingCostPct: 0.05,
    });

    expect(costs.fundingCost).toBeCloseTo(0.05);
    expect(costs.netEv).toBeCloseTo(0.01);
  });

  it("rejects a high raw score/EV when net EV is negative", () => {
    const reject = feeDragRejectReason(0.13, 10, config());

    expect(reject).toContain("NET_EV_REJECT");
  });

  it("rejects when expected TP is smaller than round-trip cost", () => {
    const reject = feeDragRejectReason(0.3, 10, config({ takeProfitPct: 0.1 }));

    expect(reject).toContain("TP_COST_REJECT");
  });
});
