import type { BotConfig } from "./botConfig";
import type { BtcRegime, TradeOutcome } from "./adaptiveEngine";
import type { ServiceStateSnapshot } from "./serviceState";
import { logger } from "./logger";

export type KillSwitchState = "RUNNING" | "CAUTION" | "SOFT_PAUSE" | "HARD_PAUSE" | "RECOVERY" | "RESUME";

export interface KillSwitchTrigger {
  name: string;
  severity: "caution" | "soft" | "hard";
  message: string;
  value?: number | string | boolean | null;
  threshold?: number | string | boolean | null;
}

export interface KillSwitchTransition {
  from: KillSwitchState;
  to: KillSwitchState;
  reason: string;
  timestamp: number;
  metrics: Record<string, unknown>;
}

export interface KillSwitchSnapshotInput {
  outcomes: TradeOutcome[];
  config: BotConfig;
  serviceState: ServiceStateSnapshot;
  marketRegime?: BtcRegime | "HIGH_VOLATILITY_CHAOS" | "LOW_LIQUIDITY" | "NEUTRAL";
  btcChangePct?: number;
  dataQuality?: {
    stale?: number;
    invalid?: number;
    missing?: number;
    duplicates?: number;
    incidents?: unknown[];
    activeExecutionClaims?: number;
  };
  pipeline?: {
    dataFresh?: boolean;
    integrityOk?: boolean;
    scoreCalibrationHealthy?: boolean;
    symbolRotationHealthy?: boolean;
    openPositionRisk?: number;
    exitMonitorDelayMs?: number;
  };
  openPositionsCount?: number;
  maxOpenPositions?: number;
  maxSessionLossRemaining?: number | null;
}

export interface KillSwitchDecision {
  state: KillSwitchState;
  reason: string;
  activeTriggers: KillSwitchTrigger[];
  cooldownRemainingMs: number;
  recoveryStage: "none" | "scout" | "normal_probe" | "ready";
  recommendedAction: string;
  lastTransitions: KillSwitchTransition[];
  currentRiskSnapshot: Record<string, unknown>;
  entryAllowed: boolean;
  sizeMultiplier: number;
  maxCandidatesMultiplier: number;
  stackingAllowed: boolean;
  minScoreBoost: number;
}

interface ExecutionAttempt {
  at: number;
  placed: boolean;
  latencyMs: number;
  failedAck: boolean;
  failedConfirmation: boolean;
  slippagePctNotional: number;
  message?: string;
}

const LOSS_WINDOW_MS = Number(process.env["KILL_SWITCH_LOSS_WINDOW_MS"] ?? 10 * 60 * 1000);
const LOSS_STREAK_WINDOW_MS = Number(process.env["KILL_SWITCH_LOSS_STREAK_WINDOW_MS"] ?? 5 * 60 * 1000);
const SOFT_COOLDOWN_MS = Number(process.env["KILL_SWITCH_SOFT_COOLDOWN_MS"] ?? 3 * 60 * 1000);
const HARD_COOLDOWN_MS = Number(process.env["KILL_SWITCH_HARD_COOLDOWN_MS"] ?? 15 * 60 * 1000);
const RECOVERY_MIN_MS = Number(process.env["KILL_SWITCH_RECOVERY_MIN_MS"] ?? 5 * 60 * 1000);
const LOSS_STREAK_THRESHOLD = Number(process.env["KILL_SWITCH_LOSS_STREAK"] ?? 3);
const DRAWDOWN_SOFT_PCT = Number(process.env["KILL_SWITCH_DRAWDOWN_SOFT_PCT"] ?? 3);
const DRAWDOWN_HARD_PCT = Number(process.env["KILL_SWITCH_DRAWDOWN_HARD_PCT"] ?? 8);
const SLIPPAGE_P95_SOFT = Number(process.env["KILL_SWITCH_SLIPPAGE_P95_SOFT"] ?? 0.003);
const SLIPPAGE_P95_HARD = Number(process.env["KILL_SWITCH_SLIPPAGE_P95_HARD"] ?? 0.008);
const LATENCY_P95_SOFT_MS = Number(process.env["KILL_SWITCH_LATENCY_P95_SOFT_MS"] ?? 2_500);
const LATENCY_P95_HARD_MS = Number(process.env["KILL_SWITCH_LATENCY_P95_HARD_MS"] ?? 7_500);
const FAILED_ORDER_SOFT_RATE = Number(process.env["KILL_SWITCH_FAILED_ORDER_SOFT_RATE"] ?? 0.35);
const FAILED_ORDER_HARD_RATE = Number(process.env["KILL_SWITCH_FAILED_ORDER_HARD_RATE"] ?? 0.65);
const EXIT_MONITOR_DELAY_HARD_MS = Number(process.env["KILL_SWITCH_EXIT_MONITOR_DELAY_HARD_MS"] ?? 120_000);
const BTC_CHAOS_PCT = Number(process.env["KILL_SWITCH_BTC_CHAOS_PCT"] ?? 2.5);

let currentState: KillSwitchState = "RUNNING";
let stateSince = Date.now();
let lastReason = "initial";
let recoveryStartedAt: number | null = null;
const transitions: KillSwitchTransition[] = [];
const executionAttempts: ExecutionAttempt[] = [];
let lastDecision: KillSwitchDecision | null = null;

function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function recentOutcomes(outcomes: TradeOutcome[], windowMs: number): TradeOutcome[] {
  const cutoff = Date.now() - windowMs;
  return outcomes.filter((outcome) => outcome.exitTime >= cutoff);
}

function consecutiveRecentLosses(outcomes: TradeOutcome[]): number {
  const sorted = [...outcomes].sort((a, b) => b.exitTime - a.exitTime);
  let count = 0;
  for (const outcome of sorted) {
    if (outcome.realizedPnl < 0) count++;
    else break;
  }
  return count;
}

function computeDrawdownPct(outcomes: TradeOutcome[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const outcome of [...outcomes].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += outcome.realizedPnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const marginBase = outcomes.reduce((sum, outcome) => sum + Math.max(0, outcome.marginUsed || 0), 0);
  return marginBase > 0 ? (maxDd / marginBase) * 100 : 0;
}

function scoreCalibrationHealthy(outcomes: TradeOutcome[]): boolean {
  const scored = outcomes
    .map((outcome) => ({
      score: Number((outcome as unknown as { combinedScore?: number; aggressiveScore?: number }).combinedScore
        ?? (outcome as unknown as { aggressiveScore?: number }).aggressiveScore
        ?? NaN),
      pnl: outcome.realizedPnl,
    }))
    .filter((item) => Number.isFinite(item.score));
  if (scored.length < 12) return true;
  scored.sort((a, b) => a.score - b.score);
  const bucketSize = Math.max(3, Math.floor(scored.length / 3));
  const low = scored.slice(0, bucketSize);
  const high = scored.slice(-bucketSize);
  const avg = (items: typeof scored) => items.reduce((sum, item) => sum + item.pnl, 0) / Math.max(1, items.length);
  return avg(high) >= avg(low);
}

function pushTransition(to: KillSwitchState, reason: string, metrics: Record<string, unknown>): void {
  if (to === currentState) return;
  const transition: KillSwitchTransition = {
    from: currentState,
    to,
    reason,
    timestamp: Date.now(),
    metrics,
  };
  transitions.push(transition);
  while (transitions.length > 50) transitions.shift();
  logger.warn(transition, "[kill-switch] transition");
  currentState = to;
  stateSince = transition.timestamp;
  lastReason = reason;
  if (to === "RECOVERY") recoveryStartedAt = transition.timestamp;
  if (to === "RUNNING" || to === "RESUME") recoveryStartedAt = null;
}

function addTrigger(
  triggers: KillSwitchTrigger[],
  name: string,
  severity: KillSwitchTrigger["severity"],
  message: string,
  value?: KillSwitchTrigger["value"],
  threshold?: KillSwitchTrigger["threshold"],
): void {
  triggers.push({ name, severity, message, value, threshold });
}

function buildDecision(state: KillSwitchState, reason: string, triggers: KillSwitchTrigger[], risk: Record<string, unknown>): KillSwitchDecision {
  const now = Date.now();
  const cooldownMs = state === "HARD_PAUSE" ? HARD_COOLDOWN_MS : state === "SOFT_PAUSE" ? SOFT_COOLDOWN_MS : 0;
  const cooldownRemainingMs = Math.max(0, stateSince + cooldownMs - now);
  const recoveryElapsed = recoveryStartedAt ? now - recoveryStartedAt : 0;
  const recoveryStage =
    state !== "RECOVERY" ? "none" :
    recoveryElapsed < RECOVERY_MIN_MS / 2 ? "scout" :
    recoveryElapsed < RECOVERY_MIN_MS ? "normal_probe" :
    "ready";

  const controls: Pick<KillSwitchDecision, "entryAllowed" | "sizeMultiplier" | "maxCandidatesMultiplier" | "stackingAllowed" | "minScoreBoost"> =
    state === "RUNNING" || state === "RESUME"
      ? { entryAllowed: true, sizeMultiplier: 1, maxCandidatesMultiplier: 1, stackingAllowed: true, minScoreBoost: 0 }
      : state === "CAUTION"
        ? { entryAllowed: true, sizeMultiplier: 0.55, maxCandidatesMultiplier: 0.55, stackingAllowed: false, minScoreBoost: 0.08 }
        : state === "RECOVERY"
          ? { entryAllowed: true, sizeMultiplier: 0.25, maxCandidatesMultiplier: 0.30, stackingAllowed: false, minScoreBoost: 0.12 }
          : { entryAllowed: false, sizeMultiplier: 0, maxCandidatesMultiplier: 0, stackingAllowed: false, minScoreBoost: 1 };

  const recommendedAction =
    state === "HARD_PAUSE" ? "block_new_entries_alert_continue_exits" :
    state === "SOFT_PAUSE" ? "block_new_entries_continue_monitoring" :
    state === "RECOVERY" ? "scout_only_raise_score_no_deep_stacking" :
    state === "CAUTION" ? "reduce_size_candidates_and_stacking" :
    state === "RESUME" ? "resume_normal_after_recovery" :
    "normal_aggressive_operation";

  return {
    state,
    reason,
    activeTriggers: triggers,
    cooldownRemainingMs,
    recoveryStage,
    recommendedAction,
    lastTransitions: transitions.slice(-20),
    currentRiskSnapshot: risk,
    ...controls,
  };
}

export function recordKillSwitchOutcome(outcome: TradeOutcome): void {
  void outcome;
  if (lastDecision) {
    lastDecision = null;
  }
}

export function recordKillSwitchExecutionAttempt(attempt: Omit<ExecutionAttempt, "at"> & { at?: number }): void {
  executionAttempts.push({ at: attempt.at ?? Date.now(), ...attempt });
  const cutoff = Date.now() - LOSS_WINDOW_MS;
  while (executionAttempts.length > 0 && executionAttempts[0].at < cutoff) executionAttempts.shift();
}

export function evaluateKillSwitch(input: KillSwitchSnapshotInput): KillSwitchDecision {
  const now = Date.now();
  const triggers: KillSwitchTrigger[] = [];
  const recent = recentOutcomes(input.outcomes, LOSS_WINDOW_MS);
  const recentLossStreak = consecutiveRecentLosses(recentOutcomes(input.outcomes, LOSS_STREAK_WINDOW_MS));
  const recentPnl = recent.reduce((sum, outcome) => sum + outcome.realizedPnl, 0);
  const drawdownPct = computeDrawdownPct(recent);
  const attempts = executionAttempts.filter((attempt) => attempt.at >= now - LOSS_WINDOW_MS);
  const failedRate = attempts.length > 0 ? attempts.filter((attempt) => !attempt.placed || attempt.failedAck || attempt.failedConfirmation).length / attempts.length : 0;
  const latencyP95 = percentile(attempts.map((attempt) => attempt.latencyMs), 0.95);
  const slippageP95 = percentile(attempts.map((attempt) => attempt.slippagePctNotional), 0.95);
  const calibrationHealthy = input.pipeline?.scoreCalibrationHealthy ?? scoreCalibrationHealthy(recent);
  const recentDataIncidents = (input.dataQuality?.incidents ?? []).filter((incident) => {
    const occurredAt = Number((incident as { occurredAt?: number }).occurredAt ?? 0);
    return occurredAt > 0 && Date.now() - occurredAt <= LOSS_WINDOW_MS;
  });
  const dataQualityBroken = recentDataIncidents.some((incident) => {
    const type = String((incident as { type?: string }).type ?? "");
    return type === "STALE" || type === "INVALID_VALUE" || type === "OUT_OF_ORDER" || type === "TIMESTAMP_VIOLATION";
  }) || recentDataIncidents.filter((incident) => String((incident as { type?: string }).type ?? "") === "GAP").length > 5;
  const servicePaused = input.serviceState.state === "PAUSED";
  const pipelineHardFailure = input.pipeline?.integrityOk === false || servicePaused;
  const maxSessionLossHit = input.maxSessionLossRemaining !== null
    && input.maxSessionLossRemaining !== undefined
    && input.maxSessionLossRemaining <= 0;
  const marketChaos = input.marketRegime === "HIGH_VOLATILITY_CHAOS"
    || Math.abs(input.btcChangePct ?? 0) >= BTC_CHAOS_PCT;

  if (recentLossStreak >= LOSS_STREAK_THRESHOLD) {
    addTrigger(triggers, "loss_velocity", "soft", "consecutive losses inside loss window", recentLossStreak, LOSS_STREAK_THRESHOLD);
  }
  if (drawdownPct >= DRAWDOWN_SOFT_PCT) {
    addTrigger(triggers, "drawdown_velocity", drawdownPct >= DRAWDOWN_HARD_PCT ? "hard" : "soft", "recent drawdown exceeded threshold", drawdownPct, DRAWDOWN_SOFT_PCT);
  }
  if (slippageP95 >= SLIPPAGE_P95_SOFT) {
    addTrigger(triggers, "slippage_p95", slippageP95 >= SLIPPAGE_P95_HARD ? "hard" : "soft", "recent slippage p95 elevated", slippageP95, SLIPPAGE_P95_SOFT);
  }
  if (latencyP95 >= LATENCY_P95_SOFT_MS) {
    addTrigger(triggers, "latency_p95", latencyP95 >= LATENCY_P95_HARD_MS ? "hard" : "soft", "recent order latency p95 elevated", latencyP95, LATENCY_P95_SOFT_MS);
  }
  if (failedRate >= FAILED_ORDER_SOFT_RATE) {
    addTrigger(triggers, "failed_order_rate", failedRate >= FAILED_ORDER_HARD_RATE ? "hard" : "soft", "order ack or confirmation failure rate elevated", failedRate, FAILED_ORDER_SOFT_RATE);
  }
  if (dataQualityBroken) {
    addTrigger(triggers, "data_quality", "hard", "market data quality is broken", true, false);
  }
  if (pipelineHardFailure) {
    addTrigger(triggers, "pipeline_integrity", "hard", "pipeline or service state blocks safe entries", input.serviceState.state, "HEALTHY/DEGRADED");
  }
  if (maxSessionLossHit) {
    addTrigger(triggers, "max_session_loss", "hard", "session loss limit reached", input.maxSessionLossRemaining, "> 0");
  }
  if ((input.pipeline?.exitMonitorDelayMs ?? 0) >= EXIT_MONITOR_DELAY_HARD_MS) {
    addTrigger(triggers, "exit_monitor_delay", "hard", "exit monitor delay too high", input.pipeline?.exitMonitorDelayMs, EXIT_MONITOR_DELAY_HARD_MS);
  }
  if (!calibrationHealthy) {
    addTrigger(triggers, "score_calibration", "caution", "high scores are underperforming lower scores", false, true);
  }
  if (input.pipeline?.symbolRotationHealthy === false) {
    addTrigger(triggers, "symbol_rotation", "caution", "symbol rotation health degraded", false, true);
  }
  if (marketChaos || input.marketRegime === "LOW_LIQUIDITY") {
    addTrigger(triggers, "market_toxic", marketChaos ? "soft" : "caution", "market regime is toxic for mass sniper", input.marketRegime ?? input.btcChangePct, "stable");
  }

  const hard = triggers.find((trigger) => trigger.severity === "hard");
  const soft = triggers.find((trigger) => trigger.severity === "soft");
  const caution = triggers.find((trigger) => trigger.severity === "caution");
  const severeClear = !hard && !soft;
  const allClear = severeClear && !caution && !dataQualityBroken && calibrationHealthy;
  const risk = {
    recentPnl,
    recentTrades: recent.length,
    recentLossStreak,
    drawdownPct,
    slippageP95,
    latencyP95,
    failedOrderRate: failedRate,
    dataQuality: input.dataQuality ?? null,
    pipeline: input.pipeline ?? null,
    marketRegime: input.marketRegime ?? null,
    btcChangePct: input.btcChangePct ?? null,
    openPositionsCount: input.openPositionsCount ?? null,
    maxOpenPositions: input.maxOpenPositions ?? null,
    maxSessionLossRemaining: input.maxSessionLossRemaining ?? null,
  };

  if (hard) {
    pushTransition("HARD_PAUSE", hard.name, risk);
  } else if (soft) {
    if (currentState !== "HARD_PAUSE" || now - stateSince >= HARD_COOLDOWN_MS) {
      pushTransition("SOFT_PAUSE", soft.name, risk);
    }
  } else if ((currentState === "HARD_PAUSE" && now - stateSince >= HARD_COOLDOWN_MS && severeClear)
    || (currentState === "SOFT_PAUSE" && now - stateSince >= SOFT_COOLDOWN_MS && severeClear)) {
    pushTransition("RECOVERY", "cooldown_cleared", risk);
  } else if (currentState === "RECOVERY" && allClear && recoveryStartedAt && now - recoveryStartedAt >= RECOVERY_MIN_MS) {
    pushTransition("RESUME", "recovery_stabilized", risk);
  } else if ((currentState as KillSwitchState) === "RESUME") {
    pushTransition("RUNNING", "resume_complete", risk);
  } else if ((currentState === "RUNNING" || (currentState as KillSwitchState) === "RESUME") && caution) {
    pushTransition("CAUTION", caution.name, risk);
  } else if (currentState === "CAUTION" && allClear) {
    pushTransition("RUNNING", "risk_cleared", risk);
  }

  lastDecision = buildDecision(currentState, triggers[0]?.name ?? lastReason, triggers, risk);
  return lastDecision;
}

export function getKillSwitchStatus(input?: KillSwitchSnapshotInput): KillSwitchDecision {
  if (input) return evaluateKillSwitch(input);
  return lastDecision ?? buildDecision(currentState, lastReason, [], {});
}

export function applyKillSwitchToConfig<T extends BotConfig>(config: T, decision: KillSwitchDecision): T {
  if (decision.state === "RUNNING" || decision.state === "RESUME") return config;
  return {
    ...config,
    marginPerTrade: Math.max(0.1, config.marginPerTrade * decision.sizeMultiplier),
    sniperMaxCandidatesPerCycle: Math.max(1, Math.floor(config.sniperMaxCandidatesPerCycle * decision.maxCandidatesMultiplier)),
    maxPositionsPerSymbol: decision.stackingAllowed ? config.maxPositionsPerSymbol : 1,
    positionStackingEnabled: config.positionStackingEnabled && decision.stackingAllowed,
    sniperMinCombinedScore: Math.min(1, config.sniperMinCombinedScore + decision.minScoreBoost),
  };
}
