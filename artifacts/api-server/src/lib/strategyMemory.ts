import type { BtcRegime, PositionSide, TradeOutcome } from "./adaptiveEngine";
import { validateLearningEligibility } from "./pipelineAuditor";

export type StrategyRuleAction =
  | "BOOST_PRIORITY"
  | "REDUCE_PRIORITY"
  | "PAUSE_SCOPE"
  | "INCREASE_SIZE"
  | "REDUCE_SIZE"
  | "ALLOW_STACKING"
  | "LIMIT_STACKING_DEPTH"
  | "PREFER_QUICK_TP"
  | "PREFER_TRAILING"
  | "AVOID_MARKET_ORDER"
  | "REQUIRE_HIGHER_SCORE"
  | "LOWER_SCORE_THRESHOLD"
  | "PROMOTE_TO_LIVE_SHADOW"
  | "DEMOTE_TO_DEMO_ONLY";

export type StrategyRuleMaturity = "OBSERVATION" | "HYPOTHESIS" | "ACTIVE_RULE" | "LOCKED_RULE" | "RETIRED_RULE";

export interface StrategyRuleScope {
  symbol?: string;
  side?: PositionSide | "BOTH";
  playbook?: string;
  regime?: BtcRegime | string;
}

export interface StrategyRuleEvidence {
  trades: number;
  eligibleTrades: number;
  winRate: number;
  profitFactor: number;
  avgPnl: number;
  totalPnl: number;
  maxDrawdown: number;
  avgSlippageBps: number;
  p95SlippageBps: number;
  avgScore: number | null;
  calibrationError: number | null;
  tpRate: number;
  slRate: number;
  avgHoldMinutes: number | null;
  avgStackDepth: number | null;
  integrityOk: boolean;
  executionAcceptable: boolean;
  operationalErrorRate: number;
}

export interface StrategyRule {
  ruleId: string;
  version: number;
  scope: StrategyRuleScope;
  action: StrategyRuleAction;
  maturity: StrategyRuleMaturity;
  confidence: number;
  evidence: StrategyRuleEvidence;
  createdAt: number;
  lastValidatedAt: number;
  expiresAt: number | null;
  ruleDecay: number;
  driftDetected: boolean;
  retirementReason: string | null;
  conflictGroup: string;
  supersedes: string[];
  rationale: string;
  distillation: string;
}

export interface StrategyRuleApplication {
  target:
    | "COACH_RANKER"
    | "SYMBOL_ROTATION"
    | "POSITION_SIZING"
    | "REGIME_PLAYBOOK"
    | "EXIT_INTELLIGENCE"
    | "LIVE_READINESS";
  effect: "BOOST" | "PENALTY" | "BLOCK" | "SIZE_UP" | "SIZE_DOWN" | "STACKING" | "EXIT_STYLE" | "THRESHOLD";
  ruleId: string;
  action: StrategyRuleAction;
  scope: StrategyRuleScope;
  weight: number;
  reason: string;
}

export interface StrategyMemoryStatus {
  generatedAt: number;
  rules: StrategyRule[];
  activeRules: StrategyRule[];
  hypotheses: StrategyRule[];
  expiredRules: StrategyRule[];
  rulesBySymbol: Record<string, StrategyRule[]>;
  rulesByPlaybook: Record<string, StrategyRule[]>;
  newRecommendations: StrategyRule[];
  estimatedImpact: {
    priorityBoostScopes: number;
    reducedRiskScopes: number;
    pausedScopes: number;
    sizingChanges: number;
    liveReadinessChanges: number;
    expectedPnlDeltaUsdt: number;
  };
  applications: StrategyRuleApplication[];
  knowledgeDistillation: {
    topLearnedRules: string[];
    report: string;
  };
  diagnostics: {
    totalOutcomes: number;
    eligibleOutcomes: number;
    blockedOutcomes: number;
    candidateScopes: number;
    conflictsResolved: number;
    integrityRequired: boolean;
  };
}

interface StrategyMemoryInput {
  outcomes: TradeOutcome[];
  now?: number;
  experiments?: StrategyExperiment[];
  liveReadiness?: { canPromote?: boolean; calibrationBrier?: number | null; ready?: boolean; status?: string } | null;
}

interface StrategyExperiment {
  scope?: StrategyRuleScope;
  action?: StrategyRuleAction;
  status: "running" | "won" | "lost" | "inconclusive";
  trades?: number;
}

interface OutcomeFacts {
  playbook: string;
  score: number | null;
  stackDepth: number | null;
  slippageBps: number | null;
  operationalError: boolean;
}

interface ScopeBucket {
  scope: Required<Pick<StrategyRuleScope, "symbol" | "side" | "playbook" | "regime">>;
  outcomes: TradeOutcome[];
  eligible: TradeOutcome[];
}

const MIN_OBSERVATION_TRADES = 4;
const MIN_HYPOTHESIS_TRADES = 8;
const MIN_ACTIVE_TRADES = 20;
const MIN_LOCKED_TRADES = 40;
const ACCEPTABLE_AVG_SLIPPAGE_BPS = 10;
const ACCEPTABLE_P95_SLIPPAGE_BPS = 25;
const ACTION_PRIORITY: Record<StrategyRuleAction, number> = {
  PAUSE_SCOPE: 100,
  DEMOTE_TO_DEMO_ONLY: 92,
  REDUCE_PRIORITY: 80,
  REDUCE_SIZE: 76,
  REQUIRE_HIGHER_SCORE: 72,
  LIMIT_STACKING_DEPTH: 70,
  AVOID_MARKET_ORDER: 68,
  PREFER_QUICK_TP: 55,
  PREFER_TRAILING: 54,
  LOWER_SCORE_THRESHOLD: 42,
  ALLOW_STACKING: 40,
  INCREASE_SIZE: 35,
  PROMOTE_TO_LIVE_SHADOW: 30,
  BOOST_PRIORITY: 20,
};

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizePlaybook(outcome: TradeOutcome): string {
  const extra = outcome as TradeOutcome & {
    playbook?: string;
    playbookId?: string;
    strategy?: string;
    strategyName?: string;
  };
  return (extra.playbook ?? extra.playbookId ?? extra.strategy ?? extra.strategyName ?? outcome.strategyVersion ?? outcome.riskTier ?? "GENERAL")
    .trim()
    .toUpperCase();
}

function factsOf(outcome: TradeOutcome): OutcomeFacts {
  const extra = outcome as TradeOutcome & {
    edgeScore?: number;
    score?: number;
    calibratedProbability?: number;
    stackingDepth?: number;
  };
  const score = [extra.edgeScore, extra.score, extra.calibratedProbability]
    .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) ?? null;
  const notional = outcome.notional ?? outcome.entryPrice * outcome.qty;
  const slippageBps = typeof outcome.slippagePctNotional === "number"
    ? outcome.slippagePctNotional * 10_000
    : notional > 0 && typeof outcome.totalSlippage === "number"
      ? (outcome.totalSlippage / notional) * 10_000
      : null;
  const stackDepth = extra.stackingDepth ?? outcome.entryCount ?? null;
  const operationalError = Boolean(
    outcome.estimated === true
    || outcome.pnlSource === "price_estimate"
    || (slippageBps != null && slippageBps >= 40)
    || (outcome.totalSlippage != null && outcome.totalSlippage > Math.max(2, Math.abs(outcome.realizedPnl) * 2)),
  );
  return {
    playbook: normalizePlaybook(outcome),
    score,
    stackDepth,
    slippageBps,
    operationalError,
  };
}

function duplicateSet(values: Array<string | null | undefined>): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return duplicated;
}

function eligibleOutcomeIds(outcomes: TradeOutcome[]): Set<string> {
  const duplicateOutcomeIds = duplicateSet(outcomes.map((outcome) => outcome.id));
  const duplicatePositionIds = duplicateSet(outcomes.map((outcome) => outcome.exchangeOrderId ?? outcome.entryOrderId ?? outcome.id));
  const duplicateClientOrderIds = duplicateSet(outcomes.map((outcome) => outcome.clientOrderId ?? undefined));
  return new Set(outcomes
    .filter((outcome) => validateLearningEligibility(outcome, {
      duplicateOutcomeIds,
      duplicatePositionIds,
      duplicateClientOrderIds,
    }).learningEligible)
    .map((outcome) => outcome.id));
}

function groupOutcomes(outcomes: TradeOutcome[], eligibleIds: Set<string>): ScopeBucket[] {
  const buckets = new Map<string, ScopeBucket>();
  for (const outcome of outcomes) {
    const facts = factsOf(outcome);
    const scope = {
      symbol: normalizeSymbol(outcome.symbol),
      side: outcome.positionSide,
      playbook: facts.playbook,
      regime: outcome.btcRegime,
    };
    const key = [scope.symbol, scope.side, scope.playbook, scope.regime].join("|");
    const existing = buckets.get(key);
    if (existing) {
      existing.outcomes.push(outcome);
      if (eligibleIds.has(outcome.id)) existing.eligible.push(outcome);
    } else {
      buckets.set(key, {
        scope,
        outcomes: [outcome],
        eligible: eligibleIds.has(outcome.id) ? [outcome] : [],
      });
    }
  }
  return Array.from(buckets.values());
}

function profitFactor(outcomes: TradeOutcome[]): number {
  const wins = outcomes.reduce((sum, outcome) => sum + Math.max(0, outcome.realizedPnl), 0);
  const losses = Math.abs(outcomes.reduce((sum, outcome) => sum + Math.min(0, outcome.realizedPnl), 0));
  if (wins > 0 && losses === 0) return 999;
  if (losses === 0) return 0;
  return wins / losses;
}

function maxDrawdown(outcomes: TradeOutcome[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  for (const outcome of [...outcomes].sort((a, b) => a.exitTime - b.exitTime)) {
    cumulative += outcome.realizedPnl;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);
  }
  return maxDd;
}

function calibrationError(outcomes: TradeOutcome[]): number | null {
  const scored = outcomes
    .map((outcome) => ({ score: factsOf(outcome).score, win: outcome.realizedPnl > 0 ? 1 : 0 }))
    .filter((row): row is { score: number; win: number } => row.score != null);
  if (scored.length < MIN_HYPOTHESIS_TRADES) return null;
  return mean(scored.map((row) => Math.abs(row.score - row.win)));
}

function evidenceFor(bucket: ScopeBucket): StrategyRuleEvidence {
  const eligible = bucket.eligible;
  const facts = eligible.map(factsOf);
  const slippage = facts.map((fact) => fact.slippageBps).filter((value): value is number => value != null && Number.isFinite(value));
  const scores = facts.map((fact) => fact.score).filter((value): value is number => value != null && Number.isFinite(value));
  const stackDepths = facts.map((fact) => fact.stackDepth).filter((value): value is number => value != null && Number.isFinite(value));
  const holdMinutes = eligible
    .map((outcome) => outcome.holdDurationMs ?? outcome.exitTime - outcome.entryTime)
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => value / 60_000);
  const avgSlippageBps = mean(slippage);
  const p95SlippageBps = percentile(slippage, 0.95);
  const operationalErrors = facts.filter((fact) => fact.operationalError).length;
  const wins = eligible.filter((outcome) => outcome.realizedPnl > 0).length;

  return {
    trades: bucket.outcomes.length,
    eligibleTrades: eligible.length,
    winRate: eligible.length > 0 ? round(wins / eligible.length) : 0,
    profitFactor: round(Math.min(profitFactor(eligible), 999), 4),
    avgPnl: round(mean(eligible.map((outcome) => outcome.realizedPnl)), 4),
    totalPnl: round(eligible.reduce((sum, outcome) => sum + outcome.realizedPnl, 0), 4),
    maxDrawdown: round(maxDrawdown(eligible), 4),
    avgSlippageBps: round(avgSlippageBps, 3),
    p95SlippageBps: round(p95SlippageBps, 3),
    avgScore: scores.length > 0 ? round(mean(scores), 4) : null,
    calibrationError: calibrationError(eligible),
    tpRate: eligible.length > 0 ? round(eligible.filter((outcome) => outcome.exitReason === "TP").length / eligible.length) : 0,
    slRate: eligible.length > 0 ? round(eligible.filter((outcome) => outcome.exitReason === "SL").length / eligible.length) : 0,
    avgHoldMinutes: holdMinutes.length > 0 ? round(mean(holdMinutes), 2) : null,
    avgStackDepth: stackDepths.length > 0 ? round(mean(stackDepths), 2) : null,
    integrityOk: bucket.outcomes.length > 0 && eligible.length / bucket.outcomes.length >= 0.85,
    executionAcceptable: slippage.length === 0 || (avgSlippageBps <= ACCEPTABLE_AVG_SLIPPAGE_BPS && p95SlippageBps <= ACCEPTABLE_P95_SLIPPAGE_BPS),
    operationalErrorRate: eligible.length > 0 ? round(operationalErrors / eligible.length) : 1,
  };
}

function maturityFor(evidence: StrategyRuleEvidence, experiment?: StrategyExperiment): StrategyRuleMaturity {
  if (experiment?.status === "won" && evidence.eligibleTrades >= MIN_LOCKED_TRADES) return "LOCKED_RULE";
  if (evidence.eligibleTrades >= MIN_ACTIVE_TRADES && evidence.integrityOk) return "ACTIVE_RULE";
  if (evidence.eligibleTrades >= MIN_HYPOTHESIS_TRADES && evidence.integrityOk) return "HYPOTHESIS";
  return "OBSERVATION";
}

function recentDiverged(outcomes: TradeOutcome[], evidence: StrategyRuleEvidence): boolean {
  if (outcomes.length < MIN_ACTIVE_TRADES) return false;
  const sorted = [...outcomes].sort((a, b) => b.exitTime - a.exitTime);
  const recent = sorted.slice(0, Math.max(6, Math.floor(sorted.length * 0.25)));
  const recentAvg = mean(recent.map((outcome) => outcome.realizedPnl));
  if (evidence.avgPnl > 0) return recentAvg < evidence.avgPnl * -0.35;
  if (evidence.avgPnl < 0) return recentAvg > Math.abs(evidence.avgPnl) * 0.35;
  return false;
}

function confidenceFor(evidence: StrategyRuleEvidence, action: StrategyRuleAction, maturity: StrategyRuleMaturity): number {
  const sampleScore = clamp((evidence.eligibleTrades - MIN_OBSERVATION_TRADES) / (MIN_ACTIVE_TRADES * 2));
  const consistency = action === "BOOST_PRIORITY" || action === "INCREASE_SIZE" || action === "ALLOW_STACKING"
    ? clamp((evidence.profitFactor - 1) / 1.4) * 0.45 + clamp(evidence.winRate - 0.45, 0, 0.3) * 1.3
    : clamp((1.05 - evidence.profitFactor) / 1.05) * 0.40 + clamp(0.52 - evidence.winRate, 0, 0.4);
  const integrity = evidence.integrityOk ? 0.16 : -0.25;
  const execution = evidence.executionAcceptable ? 0.10 : action === "AVOID_MARKET_ORDER" || action === "REDUCE_SIZE" ? 0.08 : -0.18;
  const maturityBoost = maturity === "LOCKED_RULE" ? 0.12 : maturity === "ACTIVE_RULE" ? 0.08 : maturity === "HYPOTHESIS" ? 0.03 : 0;
  return round(clamp(0.30 + sampleScore * 0.28 + consistency + integrity + execution + maturityBoost));
}

function stableId(scope: StrategyRuleScope, action: StrategyRuleAction): string {
  const raw = [
    "rule",
    scope.symbol ?? "all",
    scope.side ?? "both",
    scope.playbook ?? "general",
    scope.regime ?? "any",
    action.toLowerCase(),
  ].join("_");
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
}

function conflictGroup(scope: StrategyRuleScope): string {
  return [scope.symbol ?? "*", scope.side ?? "BOTH", scope.playbook ?? "*", scope.regime ?? "*"].join("|");
}

function matchingExperiment(experiments: StrategyExperiment[], scope: StrategyRuleScope, action: StrategyRuleAction): StrategyExperiment | undefined {
  return experiments.find((experiment) => {
    if (experiment.action && experiment.action !== action) return false;
    if (!experiment.scope) return false;
    if (experiment.scope.symbol && normalizeSymbol(experiment.scope.symbol) !== scope.symbol) return false;
    if (experiment.scope.side && experiment.scope.side !== scope.side) return false;
    if (experiment.scope.playbook && experiment.scope.playbook !== scope.playbook) return false;
    if (experiment.scope.regime && experiment.scope.regime !== scope.regime) return false;
    return true;
  });
}

function buildRule(
  bucket: ScopeBucket,
  action: StrategyRuleAction,
  evidence: StrategyRuleEvidence,
  now: number,
  experiments: StrategyExperiment[],
  rationale: string,
): StrategyRule {
  const scope: StrategyRuleScope = { ...bucket.scope };
  const experiment = matchingExperiment(experiments, scope, action);
  const maturity = maturityFor(evidence, experiment);
  const driftDetected = recentDiverged(bucket.eligible, evidence)
    || (evidence.calibrationError != null && evidence.calibrationError >= 0.42)
    || (!evidence.executionAcceptable && action !== "AVOID_MARKET_ORDER" && action !== "REDUCE_SIZE");
  const retired = driftDetected && (maturity === "ACTIVE_RULE" || maturity === "LOCKED_RULE");
  const finalMaturity: StrategyRuleMaturity = retired ? "RETIRED_RULE" : maturity;
  const confidence = confidenceFor(evidence, action, finalMaturity);
  const ruleDecay = round(clamp(
    1
    - (driftDetected ? 0.35 : 0)
    - (evidence.calibrationError != null ? clamp((evidence.calibrationError - 0.25) / 0.35) * 0.25 : 0)
    - (!evidence.executionAcceptable ? 0.18 : 0),
  ));
  const expiresInMs = finalMaturity === "OBSERVATION" ? 24 * 3600_000
    : finalMaturity === "HYPOTHESIS" ? 3 * 24 * 3600_000
      : finalMaturity === "ACTIVE_RULE" ? 7 * 24 * 3600_000
        : finalMaturity === "LOCKED_RULE" ? 21 * 24 * 3600_000
          : 0;

  return {
    ruleId: stableId(scope, action),
    version: 1,
    scope,
    action,
    maturity: finalMaturity,
    confidence,
    evidence,
    createdAt: now,
    lastValidatedAt: now,
    expiresAt: expiresInMs > 0 ? now + expiresInMs : now,
    ruleDecay,
    driftDetected,
    retirementReason: retired ? "recent_performance_or_calibration_drift" : null,
    conflictGroup: conflictGroup(scope),
    supersedes: [],
    rationale,
    distillation: distillRule(scope, action, evidence),
  };
}

function candidateActions(evidence: StrategyRuleEvidence): Array<{ action: StrategyRuleAction; rationale: string }> {
  const actions: Array<{ action: StrategyRuleAction; rationale: string }> = [];
  if (!evidence.integrityOk || evidence.eligibleTrades < MIN_OBSERVATION_TRADES || evidence.operationalErrorRate > 0.20) return actions;

  if (evidence.eligibleTrades >= MIN_HYPOTHESIS_TRADES && !evidence.executionAcceptable) {
    actions.push({ action: "AVOID_MARKET_ORDER", rationale: "execution_slippage_above_scope_limit" });
    actions.push({ action: "REDUCE_SIZE", rationale: "execution_drag_requires_smaller_size" });
  }

  if (evidence.executionAcceptable && evidence.profitFactor >= 1.35 && evidence.avgPnl > 0 && evidence.winRate >= 0.54) {
    actions.push({ action: "BOOST_PRIORITY", rationale: "consistent_positive_edge" });
    if (evidence.eligibleTrades >= MIN_ACTIVE_TRADES && (evidence.calibrationError == null || evidence.calibrationError <= 0.30)) {
      actions.push({ action: "INCREASE_SIZE", rationale: "edge_and_calibration_support_more_size" });
      actions.push({ action: "LOWER_SCORE_THRESHOLD", rationale: "scope_has_realized_edge_below_default_floor" });
    }
  }

  if (evidence.profitFactor <= 0.85 && evidence.avgPnl < 0 && evidence.eligibleTrades >= MIN_HYPOTHESIS_TRADES) {
    actions.push({ action: "REDUCE_PRIORITY", rationale: "negative_edge_after_integrity_filter" });
    actions.push({ action: "REDUCE_SIZE", rationale: "negative_edge_requires_risk_reduction" });
    if (evidence.eligibleTrades >= MIN_ACTIVE_TRADES && evidence.winRate <= 0.38) {
      actions.push({ action: "PAUSE_SCOPE", rationale: "persistent_negative_edge" });
    }
  }

  if (evidence.avgScore != null && evidence.avgScore >= 0.78 && evidence.winRate <= 0.48 && evidence.eligibleTrades >= MIN_HYPOTHESIS_TRADES) {
    actions.push({ action: "REQUIRE_HIGHER_SCORE", rationale: "score_bucket_is_overconfident" });
    actions.push({ action: "REDUCE_SIZE", rationale: "overconfident_score_requires_smaller_notional" });
  }

  if (evidence.avgStackDepth != null && evidence.avgStackDepth >= 3.5 && evidence.eligibleTrades >= MIN_HYPOTHESIS_TRADES) {
    actions.push(evidence.profitFactor >= 1.25 && evidence.avgPnl > 0
      ? { action: "ALLOW_STACKING", rationale: "stacked_entries_are_profitable_in_scope" }
      : { action: "LIMIT_STACKING_DEPTH", rationale: "deep_stacking_underperforms_in_scope" });
  }

  if (evidence.tpRate >= 0.62 && evidence.avgHoldMinutes != null && evidence.avgHoldMinutes <= 45 && evidence.profitFactor >= 1.10) {
    actions.push({ action: "PREFER_QUICK_TP", rationale: "wins_resolve_quickly_via_take_profit" });
  } else if (evidence.tpRate < 0.48 && evidence.profitFactor >= 1.10 && evidence.avgPnl > 0) {
    actions.push({ action: "PREFER_TRAILING", rationale: "edge_survives_without_fast_tp_dominance" });
  }

  if (evidence.eligibleTrades >= MIN_ACTIVE_TRADES && evidence.profitFactor >= 1.20 && evidence.executionAcceptable) {
    actions.push({ action: "PROMOTE_TO_LIVE_SHADOW", rationale: "scope_is_ready_for_shadow_validation" });
  }
  if (evidence.eligibleTrades >= MIN_ACTIVE_TRADES && (evidence.profitFactor < 0.75 || !evidence.executionAcceptable)) {
    actions.push({ action: "DEMOTE_TO_DEMO_ONLY", rationale: "scope_not_ready_for_live_risk" });
  }

  return actions;
}

function resolveConflicts(rules: StrategyRule[]): { rules: StrategyRule[]; conflictsResolved: number } {
  const byGroup = new Map<string, StrategyRule[]>();
  for (const rule of rules) {
    const existing = byGroup.get(rule.conflictGroup);
    if (existing) existing.push(rule);
    else byGroup.set(rule.conflictGroup, [rule]);
  }

  const resolved: StrategyRule[] = [];
  let conflictsResolved = 0;
  for (const groupRules of byGroup.values()) {
    const sorted = [...groupRules].sort((a, b) => {
      const priority = ACTION_PRIORITY[b.action] - ACTION_PRIORITY[a.action];
      if (priority !== 0) return priority;
      return b.confidence - a.confidence;
    });
    const winner = sorted[0];
    if (!winner) continue;
    const superseded = sorted.slice(1).filter((rule) => isContradictory(winner.action, rule.action));
    conflictsResolved += superseded.length;
    resolved.push({
      ...winner,
      supersedes: superseded.map((rule) => rule.ruleId),
    });
    for (const rule of sorted.slice(1)) {
      if (!superseded.some((item) => item.ruleId === rule.ruleId)) resolved.push(rule);
    }
  }
  return { rules: resolved.sort((a, b) => b.confidence - a.confidence), conflictsResolved };
}

function isContradictory(a: StrategyRuleAction, b: StrategyRuleAction): boolean {
  const boost = new Set<StrategyRuleAction>(["BOOST_PRIORITY", "INCREASE_SIZE", "ALLOW_STACKING", "LOWER_SCORE_THRESHOLD", "PROMOTE_TO_LIVE_SHADOW"]);
  const reduce = new Set<StrategyRuleAction>(["PAUSE_SCOPE", "REDUCE_PRIORITY", "REDUCE_SIZE", "LIMIT_STACKING_DEPTH", "REQUIRE_HIGHER_SCORE", "DEMOTE_TO_DEMO_ONLY"]);
  return (boost.has(a) && reduce.has(b)) || (reduce.has(a) && boost.has(b));
}

function distillRule(scope: StrategyRuleScope, action: StrategyRuleAction, evidence: StrategyRuleEvidence): string {
  const side = scope.side ?? "BOTH";
  const symbol = scope.symbol ?? "ALL";
  const playbook = scope.playbook ?? "GENERAL";
  const regime = scope.regime ?? "ANY_REGIME";
  const pf = evidence.profitFactor >= 99 ? "no losing samples" : `PF ${evidence.profitFactor}`;
  return `${symbol} ${side} / ${playbook} / ${regime}: ${action} (${evidence.eligibleTrades} trades, ${pf}, avgPnL ${evidence.avgPnl}).`;
}

function applicationsFor(rule: StrategyRule): StrategyRuleApplication[] {
  const weight = round(rule.confidence * rule.ruleDecay);
  const base = {
    ruleId: rule.ruleId,
    action: rule.action,
    scope: rule.scope,
    weight,
    reason: rule.rationale,
  };
  switch (rule.action) {
    case "PAUSE_SCOPE":
      return [
        { ...base, target: "COACH_RANKER", effect: "BLOCK" },
        { ...base, target: "SYMBOL_ROTATION", effect: "BLOCK" },
        { ...base, target: "LIVE_READINESS", effect: "BLOCK" },
      ];
    case "REDUCE_PRIORITY":
      return [
        { ...base, target: "COACH_RANKER", effect: "PENALTY" },
        { ...base, target: "SYMBOL_ROTATION", effect: "PENALTY" },
      ];
    case "BOOST_PRIORITY":
      return [
        { ...base, target: "COACH_RANKER", effect: "BOOST" },
        { ...base, target: "SYMBOL_ROTATION", effect: "BOOST" },
      ];
    case "INCREASE_SIZE":
      return [{ ...base, target: "POSITION_SIZING", effect: "SIZE_UP" }];
    case "REDUCE_SIZE":
      return [{ ...base, target: "POSITION_SIZING", effect: "SIZE_DOWN" }];
    case "ALLOW_STACKING":
    case "LIMIT_STACKING_DEPTH":
      return [{ ...base, target: "POSITION_SIZING", effect: "STACKING" }];
    case "PREFER_QUICK_TP":
    case "PREFER_TRAILING":
      return [{ ...base, target: "EXIT_INTELLIGENCE", effect: "EXIT_STYLE" }];
    case "AVOID_MARKET_ORDER":
      return [
        { ...base, target: "POSITION_SIZING", effect: "SIZE_DOWN" },
        { ...base, target: "REGIME_PLAYBOOK", effect: "PENALTY" },
      ];
    case "REQUIRE_HIGHER_SCORE":
    case "LOWER_SCORE_THRESHOLD":
      return [
        { ...base, target: "COACH_RANKER", effect: "THRESHOLD" },
        { ...base, target: "REGIME_PLAYBOOK", effect: "THRESHOLD" },
      ];
    case "PROMOTE_TO_LIVE_SHADOW":
    case "DEMOTE_TO_DEMO_ONLY":
      return [{ ...base, target: "LIVE_READINESS", effect: rule.action === "PROMOTE_TO_LIVE_SHADOW" ? "BOOST" : "BLOCK" }];
  }
}

function indexRules(rules: StrategyRule[], key: "symbol" | "playbook"): Record<string, StrategyRule[]> {
  const result: Record<string, StrategyRule[]> = {};
  for (const rule of rules) {
    const value = rule.scope[key] ?? "ALL";
    result[value] = result[value] ?? [];
    result[value].push(rule);
  }
  return result;
}

function estimatedImpact(rules: StrategyRule[]): StrategyMemoryStatus["estimatedImpact"] {
  const active = rules.filter((rule) => rule.maturity === "ACTIVE_RULE" || rule.maturity === "LOCKED_RULE");
  return {
    priorityBoostScopes: active.filter((rule) => rule.action === "BOOST_PRIORITY").length,
    reducedRiskScopes: active.filter((rule) => rule.action === "REDUCE_PRIORITY" || rule.action === "REDUCE_SIZE" || rule.action === "REQUIRE_HIGHER_SCORE").length,
    pausedScopes: active.filter((rule) => rule.action === "PAUSE_SCOPE").length,
    sizingChanges: active.filter((rule) => rule.action === "INCREASE_SIZE" || rule.action === "REDUCE_SIZE").length,
    liveReadinessChanges: active.filter((rule) => rule.action === "PROMOTE_TO_LIVE_SHADOW" || rule.action === "DEMOTE_TO_DEMO_ONLY").length,
    expectedPnlDeltaUsdt: round(active.reduce((sum, rule) => {
      const direction = rule.action === "BOOST_PRIORITY" || rule.action === "INCREASE_SIZE" || rule.action === "ALLOW_STACKING" ? 1 : -1;
      return sum + Math.abs(rule.evidence.avgPnl) * rule.evidence.eligibleTrades * rule.confidence * direction;
    }, 0), 3),
  };
}

function knowledgeReport(rules: StrategyRule[]): StrategyMemoryStatus["knowledgeDistillation"] {
  const learned = rules
    .filter((rule) => rule.maturity === "ACTIVE_RULE" || rule.maturity === "LOCKED_RULE")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10)
    .map((rule, index) => `${index + 1}. ${rule.distillation}`);
  const fallback = rules
    .filter((rule) => rule.maturity === "HYPOTHESIS" || rule.maturity === "OBSERVATION")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map((rule, index) => `${index + 1}. ${rule.distillation}`);
  const topLearnedRules = learned.length > 0 ? learned : fallback;
  return {
    topLearnedRules,
    report: topLearnedRules.length > 0
      ? `Top learned rules:\n${topLearnedRules.join("\n")}`
      : "Top learned rules:\nNo strategy-memory rules passed integrity and evidence gates yet.",
  };
}

export function buildStrategyMemoryStatus(input: StrategyMemoryInput): StrategyMemoryStatus {
  const now = input.now ?? Date.now();
  const outcomes = input.outcomes;
  const eligibleIds = eligibleOutcomeIds(outcomes);
  const buckets = groupOutcomes(outcomes, eligibleIds);
  const candidates: StrategyRule[] = [];

  for (const bucket of buckets) {
    const evidence = evidenceFor(bucket);
    for (const candidate of candidateActions(evidence)) {
      candidates.push(buildRule(bucket, candidate.action, evidence, now, input.experiments ?? [], candidate.rationale));
    }
  }

  const { rules, conflictsResolved } = resolveConflicts(candidates);
  const activeRules = rules.filter((rule) => rule.maturity === "ACTIVE_RULE" || rule.maturity === "LOCKED_RULE");
  const hypotheses = rules.filter((rule) => rule.maturity === "HYPOTHESIS" || rule.maturity === "OBSERVATION");
  const expiredRules = rules.filter((rule) => rule.maturity === "RETIRED_RULE" || (rule.expiresAt != null && rule.expiresAt <= now));
  const newRecommendations = rules
    .filter((rule) => rule.maturity !== "RETIRED_RULE")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12);
  const applications = activeRules.flatMap(applicationsFor);

  return {
    generatedAt: now,
    rules,
    activeRules,
    hypotheses,
    expiredRules,
    rulesBySymbol: indexRules(rules, "symbol"),
    rulesByPlaybook: indexRules(rules, "playbook"),
    newRecommendations,
    estimatedImpact: estimatedImpact(rules),
    applications,
    knowledgeDistillation: knowledgeReport(rules),
    diagnostics: {
      totalOutcomes: outcomes.length,
      eligibleOutcomes: eligibleIds.size,
      blockedOutcomes: outcomes.length - eligibleIds.size,
      candidateScopes: buckets.length,
      conflictsResolved,
      integrityRequired: true,
    },
  };
}
