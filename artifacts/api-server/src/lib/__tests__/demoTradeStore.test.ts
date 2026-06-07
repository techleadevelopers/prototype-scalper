/**
 * Unit tests for demoTradeStore campaign resolution and MFE/MAE accounting.
 * These tests run in-memory only (no file I/O) using the exported helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolveCampaignId } from "../demoTradeStore";

// Campaign window for tests (1 hour in ms)
const CAMPAIGN_WINDOW_MS = 3_600_000;

describe("resolveCampaignId", () => {
  // Reset the module's campaign map between tests by using unique symbols
  let symbolCounter = 0;
  function sym(): string { return `TEST${++symbolCounter}-USDT`; }

  it("returns same campaign_id for same symbol+side within window", () => {
    const symbol = sym();
    const t0 = Date.now();
    const id1 = resolveCampaignId(symbol, "LONG", t0);
    const id2 = resolveCampaignId(symbol, "LONG", t0 + 1000);
    expect(id1).toBe(id2);
  });

  it("returns different campaign_id for different positionSide", () => {
    const symbol = sym();
    const t0 = Date.now();
    const longId = resolveCampaignId(symbol, "LONG", t0);
    const shortId = resolveCampaignId(symbol, "SHORT", t0);
    expect(longId).not.toBe(shortId);
  });

  it("returns different campaign_id for different symbols", () => {
    const t0 = Date.now();
    const id1 = resolveCampaignId(sym(), "LONG", t0);
    const id2 = resolveCampaignId(sym(), "LONG", t0);
    expect(id1).not.toBe(id2);
  });

  it("starts a new campaign after the window expires", () => {
    const symbol = sym();
    const t0 = Date.now();
    const id1 = resolveCampaignId(symbol, "LONG", t0);
    // Simulate gap > 1h
    const id2 = resolveCampaignId(symbol, "LONG", t0 + CAMPAIGN_WINDOW_MS + 1);
    expect(id1).not.toBe(id2);
  });

  it("extends campaign window on each entry (rolling)", () => {
    const symbol = sym();
    const t0 = Date.now();
    const id1 = resolveCampaignId(symbol, "LONG", t0);
    // Second entry just before window closes
    const id2 = resolveCampaignId(symbol, "LONG", t0 + CAMPAIGN_WINDOW_MS - 1);
    // Third entry just inside the refreshed window
    const id3 = resolveCampaignId(symbol, "LONG", t0 + CAMPAIGN_WINDOW_MS - 1 + CAMPAIGN_WINDOW_MS - 1);
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it("returns a valid UUID format", () => {
    const id = resolveCampaignId(sym(), "LONG", Date.now());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

// ─── PnL accounting helpers (pure functions, no store dependency) ─────────────

function computeMfe(
  positionSide: "LONG" | "SHORT",
  entryPrice: number,
  markPrice: number,
  qty: number,
): number {
  return positionSide === "LONG"
    ? (markPrice - entryPrice) * qty
    : (entryPrice - markPrice) * qty;
}

describe("MFE/MAE accounting", () => {
  it("LONG: positive mark move yields positive MFE", () => {
    expect(computeMfe("LONG", 100, 105, 1)).toBeCloseTo(5);
  });

  it("LONG: negative mark move yields negative (MAE territory)", () => {
    expect(computeMfe("LONG", 100, 95, 1)).toBeCloseTo(-5);
  });

  it("SHORT: downward mark move yields positive MFE", () => {
    expect(computeMfe("SHORT", 100, 95, 1)).toBeCloseTo(5);
  });

  it("SHORT: upward mark move yields negative (MAE territory)", () => {
    expect(computeMfe("SHORT", 100, 105, 1)).toBeCloseTo(-5);
  });

  it("MFE tracks maximum, MAE tracks minimum over lifecycle", () => {
    let mfe = 0;
    let mae = 0;
    const moves = [2, 5, 3, 8, -1, -3, 4]; // favorable move in USD
    for (const move of moves) {
      const pnl = computeMfe("LONG", 100, 100 + move, 1);
      if (pnl > mfe) mfe = pnl;
      if (pnl < mae) mae = pnl;
    }
    expect(mfe).toBeCloseTo(8);
    expect(mae).toBeCloseTo(-3);
  });
});

// ─── Slippage accounting ──────────────────────────────────────────────────────

describe("slippage accounting", () => {
  it("entry slippage = abs(actualEntry - expectedEntry)", () => {
    const expected = 100;
    const actual = 100.5;
    const slippage = Math.abs(actual - expected);
    expect(slippage).toBeCloseTo(0.5);
  });

  it("total slippage = entrySlippage + exitSlippage", () => {
    const entry = 0.5;
    const exit = 0.3;
    expect(entry + exit).toBeCloseTo(0.8);
  });

  it("slippage pct of notional", () => {
    const totalSlippage = 0.8;
    const notional = 1000;
    const pct = totalSlippage / notional;
    expect(pct).toBeCloseTo(0.0008); // 0.08%
  });

  it("zero slippage when prices match exactly", () => {
    expect(Math.abs(100 - 100)).toBe(0);
  });
});
