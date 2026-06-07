/**
 * Service State Machine — tracks system health and controls execution behaviour.
 *
 * States (ordered by severity):
 *   HEALTHY      — all gates nominal, full execution allowed
 *   DEGRADED     — elevated failures; execution continues with tighter limits
 *   SHADOW_ONLY  — critical failure (stale data / DB / QB outage); no new entries
 *   PAUSED       — manual pause or circuit-breaker trip; no new entries
 *
 * Transitions are one-way toward more restrictive states automatically;
 * recovery requires explicit resetServiceState() after the root cause clears.
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
const ROLLING_LOSS_PAUSE_USD = parseFloat(process.env["ROLLING_LOSS_PAUSE_USD"] ?? "-50");
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
    lastBtcPriceAt: _lastBtcPriceAt,
    staleDataThresholdMs: STALE_DATA_SHADOW_MS,
    history: _history.slice(-20),
  };
}

export function isExecutionAllowed(): boolean {
  return _state === "HEALTHY" || _state === "DEGRADED";
}

export function isShadowOnly(): boolean {
  return _state === "SHADOW_ONLY" || _state === "PAUSED";
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

export function recordTradeLoss(pnl: number): void {
  _consecutiveLosses++;
  _rollingLossPnl += pnl;

  if (_consecutiveLosses >= CONSECUTIVE_LOSS_PAUSE_THRESHOLD || _rollingLossPnl <= ROLLING_LOSS_PAUSE_USD) {
    transition("PAUSED", _rollingLossPnl <= ROLLING_LOSS_PAUSE_USD ? "ROLLING_NEGATIVE_EV" : "CONSECUTIVE_LOSSES");
  } else if (_consecutiveLosses >= CONSECUTIVE_LOSS_DEGRADED_THRESHOLD) {
    transition("DEGRADED", "CONSECUTIVE_LOSSES");
  }
}

export function recordTradeWin(): void {
  _consecutiveLosses = 0;
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
  _qbFailureTimes = [];
  _qbFailures = 0;
  _apiErrorTimes = [];
  _apiErrors = 0;
  logger.info({ reason }, "[serviceState] reset to HEALTHY");
  emitter.emit("transition", { state: "HEALTHY", reason, at: _since });
}

export const serviceStateEmitter = emitter;
