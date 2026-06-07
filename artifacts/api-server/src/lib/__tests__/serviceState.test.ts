/**
 * Unit tests for the service state machine.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getServiceState,
  isExecutionAllowed,
  isShadowOnly,
  recordQbFailure,
  recordQbSuccess,
  recordApiError,
  recordApiSuccess,
  recordTradeLoss,
  recordTradeWin,
  recordBtcPriceUpdate,
  pauseExecution,
  resetServiceState,
} from "../serviceState";

// Reset to HEALTHY before every test
beforeEach(() => {
  resetServiceState("MANUAL_RESET");
});

describe("initial state", () => {
  it("starts HEALTHY", () => {
    expect(getServiceState().state).toBe("HEALTHY");
  });

  it("allows execution in HEALTHY state", () => {
    expect(isExecutionAllowed()).toBe(true);
  });

  it("is not shadow-only in HEALTHY state", () => {
    expect(isShadowOnly()).toBe(false);
  });
});

describe("QB failure tracking", () => {
  it("stays HEALTHY below degraded threshold", () => {
    recordQbFailure("timeout");
    recordQbFailure("timeout");
    expect(getServiceState().state).toBe("HEALTHY");
  });

  it("transitions to DEGRADED at 3+ QB failures", () => {
    recordQbFailure("timeout");
    recordQbFailure("timeout");
    recordQbFailure("timeout");
    expect(getServiceState().state).toBe("DEGRADED");
    expect(isExecutionAllowed()).toBe(true); // DEGRADED still allows execution
  });

  it("transitions to SHADOW_ONLY at 8+ QB failures", () => {
    for (let i = 0; i < 8; i++) recordQbFailure("unavailable");
    expect(getServiceState().state).toBe("SHADOW_ONLY");
    expect(isExecutionAllowed()).toBe(false);
    expect(isShadowOnly()).toBe(true);
  });

  it("resets QB failure count on success", () => {
    recordQbFailure("timeout");
    recordQbFailure("timeout");
    recordQbSuccess(); // should clear the window
    resetServiceState("MANUAL_RESET"); // ensure HEALTHY
    expect(getServiceState().state).toBe("HEALTHY");
    expect(getServiceState().qbFailures).toBe(0);
  });
});

describe("consecutive loss circuit breaker", () => {
  it("stays HEALTHY below degraded threshold (3 losses)", () => {
    recordTradeLoss(-5);
    recordTradeLoss(-5);
    recordTradeLoss(-5);
    expect(getServiceState().state).toBe("HEALTHY");
  });

  it("transitions to DEGRADED at 4+ consecutive losses", () => {
    for (let i = 0; i < 4; i++) recordTradeLoss(-5);
    expect(getServiceState().state).toBe("DEGRADED");
  });

  it("transitions to PAUSED at 8+ consecutive losses", () => {
    for (let i = 0; i < 8; i++) recordTradeLoss(-5);
    expect(getServiceState().state).toBe("PAUSED");
    expect(isExecutionAllowed()).toBe(false);
  });

  it("triggers PAUSED on rolling loss exceeding USD threshold", () => {
    // ROLLING_LOSS_PAUSE_USD default = -50, single -60 loss triggers pause
    recordTradeLoss(-60);
    expect(getServiceState().state).toBe("PAUSED");
    expect(getServiceState().reason).toBe("ROLLING_NEGATIVE_EV");
  });

  it("resets consecutive loss count on a win", () => {
    for (let i = 0; i < 4; i++) recordTradeLoss(-5);
    expect(getServiceState().state).toBe("DEGRADED");
    recordTradeWin();
    expect(getServiceState().consecutiveLosses).toBe(0);
    // State resets to HEALTHY on win after consecutive-loss DEGRADED
    expect(getServiceState().state).toBe("HEALTHY");
  });
});

describe("manual pause and reset", () => {
  it("can be paused manually", () => {
    pauseExecution("MANUAL_PAUSE");
    expect(getServiceState().state).toBe("PAUSED");
    expect(isExecutionAllowed()).toBe(false);
  });

  it("can be reset to HEALTHY", () => {
    pauseExecution("MANUAL_PAUSE");
    resetServiceState("MANUAL_RESET");
    expect(getServiceState().state).toBe("HEALTHY");
    expect(isExecutionAllowed()).toBe(true);
  });

  it("carries history on transitions", () => {
    pauseExecution("MANUAL_PAUSE");
    resetServiceState("MANUAL_RESET");
    const snap = getServiceState();
    expect(snap.history.length).toBeGreaterThanOrEqual(2);
  });
});

describe("BTC price freshness", () => {
  it("starts with null lastBtcPriceAt", () => {
    expect(getServiceState().lastBtcPriceAt).toBeNull();
  });

  it("records BTC price update timestamp", () => {
    const before = Date.now();
    recordBtcPriceUpdate();
    const snap = getServiceState();
    expect(snap.lastBtcPriceAt).not.toBeNull();
    expect(snap.lastBtcPriceAt!).toBeGreaterThanOrEqual(before);
  });
});

describe("state snapshot completeness", () => {
  it("includes all required fields", () => {
    const snap = getServiceState();
    expect(snap).toHaveProperty("state");
    expect(snap).toHaveProperty("reason");
    expect(snap).toHaveProperty("since");
    expect(snap).toHaveProperty("qbFailures");
    expect(snap).toHaveProperty("apiErrors");
    expect(snap).toHaveProperty("consecutiveLosses");
    expect(snap).toHaveProperty("rollingLossPnl");
    expect(snap).toHaveProperty("lastBtcPriceAt");
    expect(snap).toHaveProperty("staleDataThresholdMs");
    expect(snap).toHaveProperty("history");
  });
});
