/**
 * Extended service state tests covering:
 *   - isEntryAllowed() per state + campaignHasEntry semantics
 *   - updateVstEquity() equity-relative circuit breakers
 *   - isFallbackMode() / isMonitoringAllowed()
 *   - State transition history correctness
 *
 * Thresholds (aggressive demo phase defaults):
 *   CONSECUTIVE_LOSS_DEGRADED = 8   (was 4)
 *   CONSECUTIVE_LOSS_PAUSE    = 15  (was 8)
 *   ROLLING_LOSS_PCT_DEGRADED = -5% (was -2%)
 *   ROLLING_LOSS_PCT_PAUSE    = -10%(was -5%)
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
    // DEGRADED threshold is now 8 consecutive losses
    for (let i = 0; i < 8; i++) recordTradeLoss(-5);
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
    // DEGRADED threshold is now 8 consecutive losses
    for (let i = 0; i < 8; i++) recordTradeLoss(-5);
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

  it("DEGRADED when rolling loss exceeds ROLLING_LOSS_PCT_DEGRADED (−5% default)", () => {
    // Record a loss FIRST so _rollingLossPnl is negative,
    // then call updateVstEquity which recomputes and triggers threshold.
    recordTradeLoss(-51); // _rollingLossPnl = -51
    updateVstEquity(1000); // -51/1000 = -5.1% ≤ -5% DEGRADED threshold
    const snap = getServiceState();
    expect(["DEGRADED", "PAUSED"]).toContain(snap.state);
  });

  it("PAUSED when rolling loss exceeds ROLLING_LOSS_PCT_PAUSE (−10% default)", () => {
    // Set equity to $1000; a −10% loss = −$100 triggers PAUSED
    updateVstEquity(1000);
    recordTradeLoss(-101); // exceeds 10% of 1000 = 100
    const snap = getServiceState();
    expect(snap.state).toBe("PAUSED");
    expect(snap.reason).toBe("EQUITY_LOSS_LIMIT");
  });

  it("rollingLossPct is calculated correctly", () => {
    updateVstEquity(2000);
    recordTradeLoss(-40); // 40/2000 = 2%
    const snap = getServiceState();
    expect(snap.rollingLossPct).not.toBeNull();
    // rollingLossPct should be around −2% (well inside both thresholds)
    expect(snap.rollingLossPct!).toBeLessThan(0);
    expect(snap.rollingLossPct!).toBeGreaterThan(-10);
  });

  it("PAUSED reason is EQUITY_LOSS_LIMIT when equity threshold exceeded", () => {
    // −10% of 500 = −50; use −51 to exceed PAUSED threshold
    updateVstEquity(500);
    recordTradeLoss(-51); // 51/500 = 10.2% > 10% PAUSED threshold
    expect(getServiceState().reason).toBe("EQUITY_LOSS_LIMIT");
  });

  it("win clears rolling loss state and can restore to HEALTHY", () => {
    // 8 losses → DEGRADED (new threshold); then win restores
    for (let i = 0; i < 8; i++) recordTradeLoss(-5);
    expect(getServiceState().state).toBe("DEGRADED");
    recordTradeWin();
    expect(getServiceState().consecutiveLosses).toBe(0);
    // State resets to HEALTHY on win after consecutive-loss DEGRADED
    expect(getServiceState().state).toBe("HEALTHY");
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
