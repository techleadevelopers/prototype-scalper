/**
 * Unit tests for PnL estimation and fee accounting.
 *
 * These functions are extracted from demo.ts logic and tested in isolation
 * so we can validate correctness without running a live BingX session.
 */
import { describe, it, expect } from "vitest";

// ─── Helpers mirrored from demo.ts ───────────────────────────────────────────

function estimateGrossPnl(
  positionSide: string,
  entryPrice: number,
  exitPrice: number,
  qty: number,
): number {
  if (positionSide === "LONG") return (exitPrice - entryPrice) * qty;
  return (entryPrice - exitPrice) * qty;
}

function estimateFee(marginUsed: number, leverage: number, feeRate = 0.001): number {
  return Math.max(0, Math.abs(marginUsed * leverage) * feeRate);
}

function computeSlippage(actualPrice: number, expectedPrice: number): number {
  return Math.abs(actualPrice - expectedPrice);
}

function computeSlippagePct(actualPrice: number, expectedPrice: number): number {
  if (expectedPrice === 0) return 0;
  return Math.abs(actualPrice - expectedPrice) / expectedPrice;
}

function inferExitReason(
  favorableMovePct: number,
  takeProfitPct: number,
  stopLossPct: number,
): "TP" | "SL" | "MANUAL" {
  if (favorableMovePct >= takeProfitPct * 0.7) return "TP";
  if (favorableMovePct <= -(stopLossPct * 0.7)) return "SL";
  return "MANUAL";
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("estimateGrossPnl", () => {
  it("computes LONG profit correctly", () => {
    // Entry at 100, exit at 110, qty 1 → profit = 10
    expect(estimateGrossPnl("LONG", 100, 110, 1)).toBe(10);
  });

  it("computes LONG loss correctly", () => {
    expect(estimateGrossPnl("LONG", 100, 90, 1)).toBe(-10);
  });

  it("computes SHORT profit correctly", () => {
    // Short: entry 100, exit 90 → profit = (100-90)*qty
    expect(estimateGrossPnl("SHORT", 100, 90, 1)).toBe(10);
  });

  it("computes SHORT loss correctly", () => {
    expect(estimateGrossPnl("SHORT", 100, 110, 1)).toBe(-10);
  });

  it("scales linearly with qty", () => {
    expect(estimateGrossPnl("LONG", 100, 105, 10)).toBeCloseTo(50);
  });

  it("returns 0 for flat exit", () => {
    expect(estimateGrossPnl("LONG", 100, 100, 1)).toBe(0);
  });

  it("handles fractional prices", () => {
    // 0.0001 BTC contract, $1 move
    expect(estimateGrossPnl("LONG", 50000, 51000, 0.001)).toBeCloseTo(1);
  });
});

describe("estimateFee", () => {
  it("returns 0.1% of notional (margin × leverage)", () => {
    // $10 margin, 10x leverage → $100 notional → fee = $0.10
    expect(estimateFee(10, 10)).toBeCloseTo(0.1);
  });

  it("is always non-negative", () => {
    expect(estimateFee(-5, 10)).toBeGreaterThanOrEqual(0);
  });

  it("respects custom fee rate", () => {
    expect(estimateFee(100, 5, 0.0005)).toBeCloseTo(0.25);
  });

  it("is proportional to leverage", () => {
    const fee5x = estimateFee(10, 5);
    const fee10x = estimateFee(10, 10);
    expect(fee10x).toBeCloseTo(fee5x * 2);
  });
});

describe("computeSlippage", () => {
  it("computes absolute slippage", () => {
    expect(computeSlippage(100.5, 100)).toBeCloseTo(0.5);
  });

  it("is always non-negative", () => {
    expect(computeSlippage(99, 100)).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 for exact fill", () => {
    expect(computeSlippage(100, 100)).toBe(0);
  });
});

describe("computeSlippagePct", () => {
  it("returns 0.5% for $0.5 slippage on $100 expected price", () => {
    expect(computeSlippagePct(100.5, 100)).toBeCloseTo(0.005);
  });

  it("returns 0 when expected price is 0 (avoid division by zero)", () => {
    expect(computeSlippagePct(100, 0)).toBe(0);
  });
});

describe("realizedPnl after fee", () => {
  it("winner: grossPnl minus fee is positive", () => {
    const gross = estimateGrossPnl("LONG", 100, 105, 1);
    const fee = estimateFee(10, 10); // $0.10
    expect(gross - fee).toBeCloseTo(4.9);
  });

  it("loser: fee makes a bad trade worse", () => {
    const gross = estimateGrossPnl("LONG", 100, 99, 1); // -1
    const fee = estimateFee(10, 10); // -0.10
    expect(gross - fee).toBeCloseTo(-1.1);
  });
});

describe("inferExitReason", () => {
  it("TP when favorable move ≥ 70% of takeProfitPct", () => {
    // takeProfitPct = 2%, 70% threshold = 1.4%, favorable = 1.5%
    expect(inferExitReason(1.5, 2, 1)).toBe("TP");
  });

  it("SL when favorable move ≤ -(70% of stopLossPct)", () => {
    // stopLossPct = 1%, threshold = 0.7%, favorable = -0.8%
    expect(inferExitReason(-0.8, 2, 1)).toBe("SL");
  });

  it("MANUAL for ambiguous small moves", () => {
    expect(inferExitReason(0.2, 2, 1)).toBe("MANUAL");
  });

  it("uses canonical short enum values (not TAKE_PROFIT/STOP_LOSS)", () => {
    // Regression: exitReason must be "TP"/"SL"/"MANUAL", not "TAKE_PROFIT"/"STOP_LOSS"
    const tp = inferExitReason(2, 2, 1);
    const sl = inferExitReason(-2, 2, 1);
    expect(["TP", "SL", "MANUAL"]).toContain(tp);
    expect(["TP", "SL", "MANUAL"]).toContain(sl);
    expect(tp).toBe("TP");
    expect(sl).toBe("SL");
  });
});
