import { describe, expect, it } from "vitest";
import {
  assertReplayReady,
  simulateReplay,
  validateReplayDecisionSnapshot,
  type ReplayDecisionSnapshot,
} from "../sniperReplay";

function snapshot(overrides: Partial<ReplayDecisionSnapshot> = {}): ReplayDecisionSnapshot {
  return {
    signalId: "signal-1",
    symbol: "BTC-USDT",
    side: "LONG",
    decisionTimestamp: 1_000_000,
    marketEventId: "md:v1:bingx:BTC-USDT:5m:900000",
    candleCloseTimestamp: 900_000,
    candleIsComplete: true,
    bid: 99.9,
    ask: 100.1,
    spreadBps: 20,
    referencePrice: 100,
    configVersion: "config-v1",
    policyVersion: "policy-v1",
    modelVersion: "model-v1",
    featureSnapshot: { atrPct: 0.5, rsi14: 55 },
    playbook: "MOMENTUM_BREAKOUT_SCALP",
    regime: "BULL",
    setup: "ema_cross",
    rawScore: 0.64,
    calibratedScore: 0.61,
    gateRejects: [],
    decision: "allow",
    sourceType: "demo",
    outcome: {
      realizedPnl: 12,
      fee: 1,
      slippage: 0.25,
      funding: 0.1,
      exitTime: 1_100_000,
      exitReason: "TP",
    },
    ...overrides,
  };
}

describe("sniper replay readiness", () => {
  it("rejects lookahead from future candle close data", () => {
    const result = validateReplayDecisionSnapshot(snapshot({
      decisionTimestamp: 1_000_000,
      candleCloseTimestamp: 1_001_000,
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith("LOOKAHEAD_REJECT"))).toBe(true);
  });

  it("keeps old policy/config/model versions intact for historical reproduction", () => {
    const ready = assertReplayReady([
      snapshot({
        configVersion: "config-2026-01-01",
        policyVersion: "champion-17",
        modelVersion: "shadow-1700000000",
      }),
    ]);

    expect(ready[0].configVersion).toBe("config-2026-01-01");
    expect(ready[0].policyVersion).toBe("champion-17");
    expect(ready[0].modelVersion).toBe("shadow-1700000000");
  });

  it("blocks duplicate marketEventId execution for the same side and source", () => {
    expect(() => assertReplayReady([
      snapshot({ signalId: "a" }),
      snapshot({ signalId: "b" }),
    ])).toThrow(/reuses marketEventId/);
  });

  it("rejects capital-limited trades instead of using infinite capital", () => {
    const result = simulateReplay({
      startingEquity: 100,
      mode: "historical-policy",
      assumptions: { marginPerTrade: 80, maxMarginUtilization: 0.5 },
      snapshots: [snapshot()],
    });

    expect(result.tradesSimulated).toBe(0);
    expect(result.rejectedReasons.CAPITAL_REJECT).toBe(1);
  });

  it("charges slippage and funding drag against EV", () => {
    const clean = simulateReplay({
      startingEquity: 1_000,
      mode: "historical-policy",
      snapshots: [snapshot({ outcome: { ...snapshot().outcome!, fee: 0, slippage: 0, funding: 0 } })],
    });
    const dragged = simulateReplay({
      startingEquity: 1_000,
      mode: "historical-policy",
      assumptions: { slippageBps: 10, fundingBps: 5, marginPerTrade: 100 },
      snapshots: [snapshot({ outcome: { ...snapshot().outcome!, fee: 0, slippage: 0, funding: 0 } })],
    });

    expect(dragged.netPnl).toBeLessThan(clean.netPnl);
    expect(dragged.slippageDrag).toBeGreaterThan(0);
    expect(dragged.fundingDrag).toBeGreaterThan(0);
  });

  it("counts blocked signals as missed wins or avoided losses", () => {
    const result = simulateReplay({
      startingEquity: 1_000,
      mode: "candidate-policy",
      snapshots: [
        snapshot({
          signalId: "missed",
          marketEventId: "event-1",
          decision: "block",
          gateRejects: ["SCORE_REJECT"],
          outcome: { ...snapshot().outcome!, hypotheticalPnl: 5 },
        }),
        snapshot({
          signalId: "avoided",
          marketEventId: "event-2",
          decision: "block",
          gateRejects: ["SPREAD_REJECT"],
          outcome: { ...snapshot().outcome!, realizedPnl: -7 },
        }),
      ],
    });

    expect(result.missedWins).toBe(1);
    expect(result.avoidedLosses).toBe(1);
  });

  it("fails closed when a critical replay field is missing", () => {
    expect(() => assertReplayReady([
      snapshot({ policyVersion: "" }),
    ])).toThrow(/MISSING_POLICYVERSION/);
  });
});
