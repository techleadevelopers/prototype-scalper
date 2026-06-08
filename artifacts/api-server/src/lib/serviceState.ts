/**
 * Service State Machine — tracks system health and controls execution behaviour.
 *
 * States (ordered by severity):
 *   HEALTHY      — model + baseline available; full validated demo stacking
 *   DEGRADED     — elevated failures; reduced stacking and cycle concurrency
 *   SHADOW_ONLY  — ML unavailable/untrained; conservative deterministic baseline may continue
 *                  in VST demo; max ONE entry per campaign; every fallback trade is tagged
 *   PAUSED       — no new entries; continue monitoring, closing, and reconciliation
 *
 * Key semantic distinction from previous version:
 *   - SHADOW_ONLY allows a single exploratory entry per campaign (was: blocked entirely)
 *   - PAUSED never stops position monitoring or PnL reconciliation
 *   - isEntryAllowed(campaignHasEntry) encodes the per-state policy in one place
 *
 * Equity-relative risk:
 *   Rolling loss is tracked both in absolute USD (secondary) and as % of VST equity (primary).
 *   VST equity is updated each sniper cycle from the account balance endpoint.
 */

import { EventEmitter } from "events";
import { logger } from "./logger";

// ========== TYPES ==========

export type ServiceStateName = "HEALTHY" | "DEGRADED" | "SHADOW_ONLY" | "PAUSED";

export type ServiceStateReason =
  | "QB_TIMEOUT"
  | "QB_UNAVAILABLE"
  | "STALE_DATA"
  | "API_ERROR"
  | "CONSECUTIVE_LOSSES"
  | "ROLLING_NEGATIVE_EV"
  | "EQUITY_LOSS_LIMIT"
  | "DB_UNAVAILABLE"
  | "MANUAL_PAUSE"
  | "MANUAL_RESET";

export interface ServiceStateSnapshot {
  state: ServiceStateName;
  reason: ServiceStateReason | null;
  since: number;
  qbFailures: number;
  apiErrors: number;
  consecutiveLosses: number;
  rollingLossPnl: number;
  rollingLossPct: number | null;
  vstEquity: number | null;
  lastBtcPriceAt: number | null;
  staleDataThresholdMs: number;
  history: Array<{ state: ServiceStateName; reason: ServiceStateReason | null; at: number }>;
}

// ========== CONSTANTS ==========

const QB_FAILURE_DEGRADED_THRESHOLD = parseInt(process.env["QB_FAILURE_DEGRADED"] ?? "3", 10);
const QB_FAILURE_SHADOW_THRESHOLD = parseInt(process.env["QB_FAILURE_SHADOW"] ?? "8", 10);
const API_ERROR_DEGRADED_THRESHOLD = parseInt(process.env["API_ERROR_DEGRADED"] ?? "5", 10);
const API_ERROR_SHADOW_THRESHOLD = parseInt(process.env["API_ERROR_SHADOW"] ?? "15", 10);
const CONSECUTIVE_LOSS_PAUSE_THRESHOLD = parseInt(process.env["CONSECUTIVE_LOSS_PAUSE"] ?? "8", 10);
const CONSECUTIVE_LOSS_DEGRADED_THRESHOLD = parseInt(process.env["CONSECUTIVE_LOSS_DEGRADED"] ?? "4", 10);
// Absolute USD fallback (secondary safeguard)
const ROLLING_LOSS_PAUSE_USD = parseFloat(process.env["ROLLING_LOSS_PAUSE_USD"] ?? "-50");
// Equity-relative primary circuit breaker (% of VST equity, negative value)
const ROLLING_LOSS_PCT_PAUSE = parseFloat(process.env["ROLLING_LOSS_PCT_PAUSE"] ?? "-5");  // −5% of equity
const ROLLING_LOSS_PCT_DEGRADED = parseFloat(process.env["ROLLING_LOSS_PCT_DEGRADED"] ?? "-2"); // −2%
const STALE_DATA_SHADOW_MS = parseInt(process.env["STALE_DATA_SHADOW_MS"] ?? "90000", 10); // 90s
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5-min rolling window for failure counts

// ========== STATE ==========

let _state: ServiceStateName = "HEALTHY";
let _reason: ServiceStateReason | null = null;
let _since = Date.now();
let _qbFailures = 0;
let _qbFailureTimes: number[] = [];
let _apiErrors = 0;
let _apiErrorTimes: number[] = [];
let _consecutiveLosses = 0;
let _rollingLossPnl = 0;
let _vstEquity: number | null = null;           // latest VST account balance
let _rollingLossPct: number | null = null;      // rolling loss as % of equity
let _lastBtcPriceAt: number | null = null;
let _history: Array<{ state: ServiceStateName; reason: ServiceStateReason | null; at: number }> = [];

const emitter = new EventEmitter();

// ========== HELPERS ==========

function pruneWindow(times: number[]): number[] {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  return times.filter((t) => t >= cutoff);
}

function transition(next: ServiceStateName, reason: ServiceStateReason): void {
  const severity: Record<ServiceStateName, number> = {
    HEALTHY: 0,
    DEGRADED: 1,
    SHADOW_ONLY: 2,
    PAUSED: 3,
  };
  if (severity[next] <= severity[_state] && next !== "PAUSED") return; // only escalate automatically
  if (_state === next) return;
  _history.push({ state: _state, reason: _reason, at: _since });
  if (_history.length > 50) _history.shift();
  _state = next;
  _reason = reason;
  _since = Date.now();
  logger.warn({ from: _history[_history.length - 1]?.state, to: next, reason }, "[serviceState] transition");
  emitter.emit("transition", { state: next, reason, at: _since });
}

// ========== PUBLIC API ==========

export function getServiceState(): ServiceStateSnapshot {
  return {
    state: _state,
    reason: _reason,
    since: _since,
    qbFailures: _qbFailures,
    apiErrors: _apiErrors,
    consecutiveLosses: _consecutiveLosses,
    rollingLossPnl: _rollingLossPnl,
    rollingLossPct: _rollingLossPct,
    vstEquity: _vstEquity,
    lastBtcPriceAt: _lastBtcPriceAt,
    staleDataThresholdMs: STALE_DATA_SHADOW_MS,
    history: _history.slice(-20),
  };
}

/**
 * Determines whether a new entry can be placed for a given campaign.
 *
 * HEALTHY / DEGRADED  → always allowed
 * SHADOW_ONLY         → allowed only if the campaign has NO existing entries
 *                       (one exploratory entry per campaign, tagged as fallbackMode)
 * PAUSED              → never allowed (monitoring continues separately)
 */
export function isEntryAllowed(campaignHasExistingEntry: boolean): boolean {
  switch (_state) {
    case "HEALTHY":
    case "DEGRADED":
      return true;
    case "SHADOW_ONLY":
      return !campaignHasExistingEntry; // first entry only
    case "PAUSED":
      return false;
  }
}

/** @deprecated Use isEntryAllowed(). Kept for backward compatibility. */
export function isExecutionAllowed(): boolean {
  return _state === "HEALTHY" || _state === "DEGRADED";
}

export function isShadowOnly(): boolean {
  return _state === "SHADOW_ONLY" || _state === "PAUSED";
}

export function isFallbackMode(): boolean {
  return _state === "SHADOW_ONLY";
}

/**
 * Monitoring must never stop because entry execution is paused.
 * This always returns true — it exists to make the intent explicit in call sites.
 */
export function isMonitoringAllowed(): boolean {
  return true;
}

export function recordQbFailure(type: "timeout" | "unavailable"): void {
  _qbFailureTimes = pruneWindow(_qbFailureTimes);
  _qbFailureTimes.push(Date.now());
  _qbFailures = _qbFailureTimes.length;

  if (_qbFailures >= QB_FAILURE_SHADOW_THRESHOLD) {
    transition("SHADOW_ONLY", type === "timeout" ? "QB_TIMEOUT" : "QB_UNAVAILABLE");
  } else if (_qbFailures >= QB_FAILURE_DEGRADED_THRESHOLD) {
    transition("DEGRADED", type === "timeout" ? "QB_TIMEOUT" : "QB_UNAVAILABLE");
  }
}

export function recordQbSuccess(): void {
  _qbFailureTimes = [];
  _qbFailures = 0;
}

export function recordApiError(): void {
  _apiErrorTimes = pruneWindow(_apiErrorTimes);
  _apiErrorTimes.push(Date.now());
  _apiErrors = _apiErrorTimes.length;

  if (_apiErrors >= API_ERROR_SHADOW_THRESHOLD) {
    transition("SHADOW_ONLY", "API_ERROR");
  } else if (_apiErrors >= API_ERROR_DEGRADED_THRESHOLD) {
    transition("DEGRADED", "API_ERROR");
  }
}

export function recordApiSuccess(): void {
  _apiErrorTimes = pruneWindow(_apiErrorTimes);
  _apiErrors = _apiErrorTimes.length;
}

/**
 * Update VST account equity. Called at the start of each sniper cycle from the balance endpoint.
 * Triggers equity-relative circuit breakers when rolling loss exceeds configured thresholds.
 */
export function updateVstEquity(equity: number): void {
  if (equity <= 0) return;
  _vstEquity = equity;

  // Recompute rolling loss as % of current equity
  if (_rollingLossPnl < 0 && equity > 0) {
    _rollingLossPct = (_rollingLossPnl / equity) * 100;

    if (_rollingLossPct <= ROLLING_LOSS_PCT_PAUSE) {
      transition("PAUSED", "EQUITY_LOSS_LIMIT");
    } else if (_rollingLossPct <= ROLLING_LOSS_PCT_DEGRADED) {
      transition("DEGRADED", "ROLLING_NEGATIVE_EV");
    }
  } else {
    _rollingLossPct = 0;
  }
}

export function recordTradeLoss(pnl: number): void {
  _consecutiveLosses++;
  _rollingLossPnl += pnl;

  // Recompute equity-relative loss if equity is known
  if (_vstEquity && _vstEquity > 0) {
    _rollingLossPct = (_rollingLossPnl / _vstEquity) * 100;
    if (_rollingLossPct <= ROLLING_LOSS_PCT_PAUSE) {
      transition("PAUSED", "EQUITY_LOSS_LIMIT");
      return;
    }
  }

  // Absolute USD fallback (secondary safeguard)
  if (_consecutiveLosses >= CONSECUTIVE_LOSS_PAUSE_THRESHOLD || _rollingLossPnl <= ROLLING_LOSS_PAUSE_USD) {
    transition("PAUSED", _rollingLossPnl <= ROLLING_LOSS_PAUSE_USD ? "ROLLING_NEGATIVE_EV" : "CONSECUTIVE_LOSSES");
  } else if (_consecutiveLosses >= CONSECUTIVE_LOSS_DEGRADED_THRESHOLD) {
    transition("DEGRADED", "CONSECUTIVE_LOSSES");
  }
}

export function recordTradeWin(): void {
  _consecutiveLosses = 0;
  _rollingLossPnl = 0;
  _rollingLossPct = 0;
  if (_state === "DEGRADED" && _reason === "CONSECUTIVE_LOSSES") {
    resetServiceState("MANUAL_RESET");
  }
}

export function recordBtcPriceUpdate(): void {
  _lastBtcPriceAt = Date.now();
  if (_state === "SHADOW_ONLY" && _reason === "STALE_DATA") {
    resetServiceState("MANUAL_RESET");
  }
}

export function checkDataFreshness(): { fresh: boolean; ageMs: number | null } {
  if (_lastBtcPriceAt === null) return { fresh: false, ageMs: null };
  const ageMs = Date.now() - _lastBtcPriceAt;
  const fresh = ageMs <= STALE_DATA_SHADOW_MS;
  if (!fresh) transition("SHADOW_ONLY", "STALE_DATA");
  return { fresh, ageMs };
}

export function pauseExecution(reason: ServiceStateReason = "MANUAL_PAUSE"): void {
  _history.push({ state: _state, reason: _reason, at: _since });
  if (_history.length > 50) _history.shift();
  _state = "PAUSED";
  _reason = reason;
  _since = Date.now();
  logger.warn({ reason }, "[serviceState] execution paused");
  emitter.emit("transition", { state: "PAUSED", reason, at: _since });
}

export function resetServiceState(reason: ServiceStateReason = "MANUAL_RESET"): void {
  _history.push({ state: _state, reason: _reason, at: _since });
  if (_history.length > 50) _history.shift();
  _state = "HEALTHY";
  _reason = null;
  _since = Date.now();
  _consecutiveLosses = 0;
  _rollingLossPnl = 0;
  _rollingLossPct = 0;
  _qbFailureTimes = [];
  _qbFailures = 0;
  _apiErrorTimes = [];
  _apiErrors = 0;
  logger.info({ reason }, "[serviceState] reset to HEALTHY");
  emitter.emit("transition", { state: "HEALTHY", reason, at: _since });
}

export const serviceStateEmitter = emitter;
