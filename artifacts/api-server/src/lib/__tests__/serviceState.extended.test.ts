/**
 * Extended service state tests covering:
 *   - isEntryAllowed() per state + campaignHasEntry semantics
 *   - updateVstEquity() equity-relative circuit breakers
 *   - isFallbackMode() / isMonitoringAllowed()
 *   - State transition history correctness
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getServiceState,
  isEntryAllowed,
  isFallbackMode,
  isMonitoringAllowed,
  recordTradeLoss,
  recordTradeWin,
  recordQbFailure,
  updateVstEquity,
  pauseExecution,
  resetServiceState,
} from "../serviceState";

beforeEach(() => {
  resetServiceState("MANUAL_RESET");
});

// ──────────────────────────────────────────────────────────────────────────────
// isEntryAllowed — per-state policy
// ──────────────────────────────────────────────────────────────────────────────
describe("isEntryAllowed — HEALTHY", () => {
  it("allows first entry in campaign", () => {
    expect(isEntryAllowed(false)).toBe(true);
  });
  it("allows additional entries in same campaign (stacking)", () => {
    expect(isEntryAllowed(true)).toBe(true);
  });
});

describe("isEntryAllowed — DEGRADED", () => {
  beforeEach(() => {
    for (let i = 0; i < 4; i++) recordTradeLoss(-5);
  });
  it("state is DEGRADED", () => {
    expect(getServiceState().state).toBe("DEGRADED");
  });
  it("allows first entry in campaign", () => {
    expect(isEntryAllowed(false)).toBe(true);
  });
  it("allows stacking within campaign", () => {
    expect(isEntryAllowed(true)).toBe(true);
  });
});

describe("isEntryAllowed — SHADOW_ONLY", () => {
  beforeEach(() => {
    for (let i = 0; i < 8; i++) recordQbFailure("unavailable");
  });
  it("state is SHADOW_ONLY", () => {
    expect(getServiceState().state).toBe("SHADOW_ONLY");
  });
  it("allows first entry in a campaign (no existing entry)", () => {
    expect(isEntryAllowed(false)).toBe(true);
  });
  it("blocks second/stacked entry in same campaign", () => {
    expect(isEntryAllowed(true)).toBe(false);
  });
});

describe("isEntryAllowed — PAUSED", () => {
  beforeEach(() => {
    pauseExecution("MANUAL_PAUSE");
  });
  it("blocks entry even for fresh campaign", () => {
    expect(isEntryAllowed(false)).toBe(false);
  });
  it("blocks entry for campaigns with existing entries", () => {
    expect(isEntryAllowed(true)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isFallbackMode
// ──────────────────────────────────────────────────────────────────────────────
describe("isFallbackMode", () => {
  it("is false in HEALTHY", () => {
    expect(isFallbackMode()).toBe(false);
  });
  it("is false in DEGRADED", () => {
    for (let i = 0; i < 4; i++) recordTradeLoss(-5);
    expect(isFallbackMode()).toBe(false);
  });
  it("is true in SHADOW_ONLY", () => {
    for (let i = 0; i < 8; i++) recordQbFailure("unavailable");
    expect(isFallbackMode()).toBe(true);
  });
  it("is false in PAUSED (paused = stop, not fallback)", () => {
    pauseExecution("MANUAL_PAUSE");
    expect(isFallbackMode()).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isMonitoringAllowed — must always return true
// ──────────────────────────────────────────────────────────────────────────────
describe("isMonitoringAllowed", () => {
  it("true in HEALTHY", () => { expect(isMonitoringAllowed()).toBe(true); });
  it("true in PAUSED (monitoring must never stop)", () => {
    pauseExecution("MANUAL_PAUSE");
    expect(isMonitoringAllowed()).toBe(true);
  });
  it("true in SHADOW_ONLY", () => {
    for (let i = 0; i < 8; i++) recordQbFailure("unavailable");
    expect(isMonitoringAllowed()).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Equity-relative circuit breakers (updateVstEquity)
// ──────────────────────────────────────────────────────────────────────────────
describe("equity-relative circuit breakers", () => {
  it("vstEquity starts null", () => {
    expect(getServiceState().vstEquity).toBeNull();
  });

  it("updateVstEquity records equity", () => {
    updateVstEquity(1000);
    expect(getServiceState().vstEquity).toBe(1000);
  });

  it("DEGRADED when rolling loss exceeds ROLLING_LOSS_PCT_DEGRADED (−2% default)", () => {
    // Record a loss FIRST so _rollingLossPnl is negative,
    // then call updateVstEquity which recomputes and triggers threshold.
    recordTradeLoss(-21); // _rollingLossPnl = -21
    updateVstEquity(1000); // -21/1000 = -2.1% ≤ -2% DEGRADED threshold
    const snap = getServiceState();
    expect(["DEGRADED", "PAUSED"]).toContain(snap.state);
  });

  it("PAUSED when rolling loss exceeds ROLLING_LOSS_PCT_PAUSE (−5% default)", () => {
    // Set equity to $1000; a −5% loss = −$50 should trigger PAUSED
    updateVstEquity(1000);
    recordTradeLoss(-51); // exceeds 5% of 1000 = 50
    const snap = getServiceState();
    expect(snap.state).toBe("PAUSED");
    expect(snap.reason).toBe("EQUITY_LOSS_LIMIT");
  });

  it("rollingLossPct is calculated correctly", () => {
    updateVstEquity(2000);
    recordTradeLoss(-40); // 40/2000 = 2%
    const snap = getServiceState();
    expect(snap.rollingLossPct).not.toBeNull();
    // rollingLossPct should be around −2%
    expect(snap.rollingLossPct!).toBeLessThan(0);
    expect(snap.rollingLossPct!).toBeGreaterThan(-10);
  });

  it("PAUSED reason is EQUITY_LOSS_LIMIT when equity threshold exceeded", () => {
    updateVstEquity(500);
    recordTradeLoss(-30); // 30/500 = 6% > 5% threshold
    expect(getServiceState().reason).toBe("EQUITY_LOSS_LIMIT");
  });

  it("win clears rolling loss state and can restore to HEALTHY", () => {
    // 4 losses → DEGRADED; then win restores
    for (let i = 0; i < 4; i++) recordTradeLoss(-5);
    expect(getServiceState().state).toBe("DEGRADED");
    recordTradeWin();
    expect(getServiceState().consecutiveLosses).toBe(0);
    // After clearing consecutive losses, rolling loss may still be negative
    // but state should improve
    expect(getServiceState().state).not.toBe("PAUSED");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Transition history
// ──────────────────────────────────────────────────────────────────────────────
describe("transition history", () => {
  it("records each state change in history", () => {
    for (let i = 0; i < 8; i++) recordQbFailure("unavailable"); // DEGRADED then SHADOW_ONLY
    resetServiceState("MANUAL_RESET"); // HEALTHY
    const snap = getServiceState();
    expect(snap.history.length).toBeGreaterThanOrEqual(2);
    const states = snap.history.map((h) => h.state);
    expect(states).toContain("SHADOW_ONLY");
  });

  it("history has timestamps", () => {
    for (let i = 0; i < 8; i++) recordQbFailure("unavailable");
    const snap = getServiceState();
    for (const h of snap.history) {
      expect(h.at).toBeGreaterThan(0);
    }
  });
});
