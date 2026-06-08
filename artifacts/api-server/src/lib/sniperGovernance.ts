import type { TradeOutcome } from "./adaptiveEngine";
import type { LiveReadinessStatus } from "./live_readiness";
import type { StrategyMemoryStatus, StrategyRule } from "./strategyMemory";

export interface GovernanceWarning {
  code: string;
  severity: "P0" | "P1" | "P2";
  scope?: string;
  detail: string;
}

export interface GovernanceRuleSummary {
  ruleId: string;
  action: string;
  maturity: string;
  confidence: number;
  scope: StrategyRule["scope"];
  eligibleTrades: number;
  profitFactor: number;
  avgPnl: number;
  policyVersion: string;
}

export interface GovernanceRollbackCandidate {
  id: string;
  reason: string;
  severity: "P0" | "P1" | "P2";
  recommendedAction: string;
}

export interface SniperGovernanceStatus {
  generatedAt: number;
  currentPolicyVersion: string;
  activeExperiments: string[];
  promotedRules: GovernanceRuleSummary[];
  blockedPromotions: Array<{ id: string; reason: string; blockedReasons: string[] }>;
  overfitWarnings: GovernanceWarning[];
  leakageWarnings: GovernanceWarning[];
  sampleSizeWarnings: GovernanceWarning[];
  rollbackCandidates: GovernanceRollbackCandidate[];
  championChallenger: {
    championPolicyVersion: string;
    challengerExperiments: string[];
    status: "NO_CHALLENGER" | "SHADOW_REQUIRED" | "RUNNING" | "ROLLBACK_RECOMMENDED";
  };
  recommendedNextAction: string;
}

const MIN_RULE_PROMOTION_TRADES = 60;
const MIN_SCOPE_DAYS = 7;
const MIN_LIVE_SHADOW_TRADES = 20;
const MAX_ECE_OR_BRIER = 0.12;

function latestVersion(outcomes: TradeOutcome[], field: "policyVersion" | "modelVersion" | "configVersion"): string {
  const sorted = outcomes
    .filter((outcome) => typeof outcome[field] === "string" && outcome[field])
    .sort((a, b) => (b.exitTime ?? b.entryTime) - (a.exitTime ?? a.entryTime));
  return sorted[0]?.[field] ?? "unversioned";
}

function scopeText(rule: StrategyRule): string {
  return [
    rule.scope.symbol ?? "ALL",
    rule.scope.side ?? "BOTH",
    rule.scope.playbook ?? "GENERAL",
    rule.scope.regime ?? "ANY",
  ].join(":");
}

function daysCovered(outcomes: TradeOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const times = outcomes.flatMap((outcome) => [outcome.entryTime, outcome.exitTime]).filter(Number.isFinite);
  if (times.length === 0) return 0;
  return Math.max(1, Math.ceil((Math.max(...times) - Math.min(...times)) / 86_400_000));
}

function calibrationQuality(calibrationStatus: unknown): {
  quality: string;
  warnings: string[];
  eceOrBrier: number | null;
  connected: boolean;
} {
  const status = calibrationStatus as {
    connected?: boolean;
    scoreTruth?: { calibrationQuality?: string };
    overconfidenceWarnings?: string[];
    ece?: number;
    brier?: number;
    brierScore?: number;
  } | null;
  return {
    quality: String(status?.scoreTruth?.calibrationQuality ?? "UNKNOWN"),
    warnings: Array.isArray(status?.overconfidenceWarnings) ? status.overconfidenceWarnings.map(String) : [],
    eceOrBrier: typeof status?.ece === "number"
      ? status.ece
      : typeof status?.brier === "number"
        ? status.brier
        : typeof status?.brierScore === "number"
          ? status.brierScore
          : null,
    connected: status?.connected !== false,
  };
}

function activeExperimentNames(outcomes: TradeOutcome[]): string[] {
  const names = new Set<string>();
  const envArm = process.env["EXPERIMENT_ARM"];
  if (envArm) names.add(envArm);
  for (const outcome of outcomes) {
    const maybe = outcome as TradeOutcome & { experimentArm?: unknown };
    if (typeof maybe.experimentArm === "string" && maybe.experimentArm.trim()) {
      names.add(maybe.experimentArm.trim());
    }
  }
  return Array.from(names).sort();
}

export function buildSniperGovernanceStatus(input: {
  outcomes: TradeOutcome[];
  strategyMemory: StrategyMemoryStatus;
  liveReadiness: LiveReadinessStatus;
  scoreCalibration: unknown;
  now?: number;
}): SniperGovernanceStatus {
  const now = input.now ?? Date.now();
  const currentPolicyVersion = latestVersion(input.outcomes, "policyVersion");
  const currentModelVersion = latestVersion(input.outcomes, "modelVersion");
  const currentConfigVersion = latestVersion(input.outcomes, "configVersion");
  const activeExperiments = activeExperimentNames(input.outcomes);
  const calibration = calibrationQuality(input.scoreCalibration);
  const overfitWarnings: GovernanceWarning[] = [];
  const leakageWarnings: GovernanceWarning[] = [];
  const sampleSizeWarnings: GovernanceWarning[] = [];
  const rollbackCandidates: GovernanceRollbackCandidate[] = [];

  const activeRules = input.strategyMemory.activeRules;
  const promotedRules = activeRules.map((rule) => ({
    ruleId: rule.ruleId,
    action: rule.action,
    maturity: rule.maturity,
    confidence: rule.confidence,
    scope: rule.scope,
    eligibleTrades: rule.evidence.eligibleTrades,
    profitFactor: rule.evidence.profitFactor,
    avgPnl: rule.evidence.avgPnl,
    policyVersion: currentPolicyVersion,
  }));

  for (const rule of activeRules) {
    if (rule.evidence.eligibleTrades < MIN_RULE_PROMOTION_TRADES) {
      sampleSizeWarnings.push({
        code: "RULE_ACTIVE_BELOW_GOVERNANCE_SAMPLE",
        severity: "P1",
        scope: scopeText(rule),
        detail: `${rule.ruleId} is active with ${rule.evidence.eligibleTrades} eligible trades; governance floor is ${MIN_RULE_PROMOTION_TRADES}.`,
      });
    }
    if (["BOOST_PRIORITY", "INCREASE_SIZE", "ALLOW_STACKING", "LOWER_SCORE_THRESHOLD", "PROMOTE_TO_LIVE_SHADOW"].includes(rule.action)) {
      if (rule.evidence.profitFactor < 1.35 || rule.evidence.avgPnl <= 0) {
        overfitWarnings.push({
          code: "POSITIVE_ACTION_WITH_WEAK_EV",
          severity: "P1",
          scope: scopeText(rule),
          detail: `${rule.ruleId} has PF ${rule.evidence.profitFactor} and avgPnL ${rule.evidence.avgPnl}.`,
        });
      }
      if (rule.evidence.calibrationError != null && rule.evidence.calibrationError > 0.25) {
        overfitWarnings.push({
          code: "BOOST_WITH_CALIBRATION_ERROR",
          severity: "P1",
          scope: scopeText(rule),
          detail: `${rule.ruleId} calibration error is ${rule.evidence.calibrationError}.`,
        });
      }
    }
    if (rule.driftDetected || rule.maturity === "RETIRED_RULE") {
      rollbackCandidates.push({
        id: rule.ruleId,
        severity: "P1",
        reason: rule.retirementReason ?? "rule_drift_detected",
        recommendedAction: "Demote rule to shadow and restore previous threshold or sizing cap.",
      });
    }
  }

  const coveredDays = daysCovered(input.outcomes);
  if (coveredDays < MIN_SCOPE_DAYS && input.outcomes.length > 0) {
    sampleSizeWarnings.push({
      code: "HOLDOUT_WINDOW_TOO_SHORT",
      severity: "P1",
      detail: `Outcomes cover ${coveredDays} chronological day(s); require at least ${MIN_SCOPE_DAYS} days before promotion.`,
    });
  }

  if (input.strategyMemory.diagnostics.blockedOutcomes > 0) {
    leakageWarnings.push({
      code: "OUTCOMES_BLOCKED_BY_PIPELINE_AUDIT",
      severity: "P1",
      detail: `${input.strategyMemory.diagnostics.blockedOutcomes} outcome(s) were excluded from learning eligibility.`,
    });
  }

  const missingPolicy = input.outcomes.filter((outcome) => !outcome.policyVersion).length;
  const missingModel = input.outcomes.filter((outcome) => !outcome.modelVersion).length;
  const missingConfig = input.outcomes.filter((outcome) => !outcome.configVersion).length;
  if (missingPolicy || missingModel || missingConfig) {
    leakageWarnings.push({
      code: "MISSING_VERSION_PROVENANCE",
      severity: "P1",
      detail: `${missingPolicy} missing policyVersion, ${missingModel} missing modelVersion, ${missingConfig} missing configVersion.`,
    });
  }

  if (!calibration.connected || calibration.quality === "INSUFFICIENT_DATA" || calibration.quality === "UNKNOWN") {
    overfitWarnings.push({
      code: "SCORE_CALIBRATION_NOT_GOVERNED",
      severity: "P1",
      detail: `Score calibration quality is ${calibration.quality}; boosts and MAX_SNIPER should remain blocked.`,
    });
  }
  if (calibration.eceOrBrier != null && calibration.eceOrBrier > MAX_ECE_OR_BRIER) {
    overfitWarnings.push({
      code: "SCORE_CALIBRATION_ERROR_TOO_HIGH",
      severity: "P1",
      detail: `ECE/Brier ${calibration.eceOrBrier} exceeds ${MAX_ECE_OR_BRIER}.`,
    });
  }
  for (const warning of calibration.warnings) {
    overfitWarnings.push({
      code: "SCORE_CALIBRATION_WARNING",
      severity: "P2",
      detail: warning,
    });
  }

  const blockedPromotions = input.liveReadiness.blockedScopes.slice(0, 25).map((scope) => ({
    id: scope.id,
    reason: scope.reason,
    blockedReasons: scope.blockedReasons,
  }));

  for (const scope of input.liveReadiness.approvedScopes) {
    if (scope.metrics.liveShadowTrades < MIN_LIVE_SHADOW_TRADES && scope.promotionState !== "MICRO_LIVE") {
      sampleSizeWarnings.push({
        code: "LIVE_PROMOTION_WITHOUT_SHADOW_SAMPLE",
        severity: "P1",
        scope: scope.id,
        detail: `${scope.promotionState} has ${scope.metrics.liveShadowTrades} shadow trades; require ${MIN_LIVE_SHADOW_TRADES}.`,
      });
    }
    if (scope.metrics.liveTrades > 0 && (scope.metrics.liveProfitFactor < 0.9 || scope.metrics.liveDrawdown > scope.maxDailyLoss)) {
      rollbackCandidates.push({
        id: scope.id,
        severity: "P1",
        reason: "live_pf_or_drawdown_degraded",
        recommendedAction: "Rollback to SHADOW_LIVE or MICRO_LIVE and restore previous risk caps.",
      });
    }
  }

  const rollbackRecommended = rollbackCandidates.some((candidate) => candidate.severity === "P0" || candidate.severity === "P1");
  const challengerStatus = rollbackRecommended
    ? "ROLLBACK_RECOMMENDED"
    : activeExperiments.length > 0
      ? "RUNNING"
      : promotedRules.length > 0 && sampleSizeWarnings.length > 0
        ? "SHADOW_REQUIRED"
        : "NO_CHALLENGER";

  const recommendedNextAction = rollbackRecommended
    ? "Freeze promotions and rollback flagged scopes before allowing new live exposure."
    : leakageWarnings.length > 0
      ? "Fix provenance and pipeline leakage warnings, then rerun chronological holdout."
      : sampleSizeWarnings.length > 0 || overfitWarnings.length > 0
        ? "Keep improvements in shadow until minimum samples, calibration, and holdout evidence pass."
        : "Governance clear for monitored shadow/challenger continuation; require audit log before promotion.";

  return {
    generatedAt: now,
    currentPolicyVersion,
    activeExperiments,
    promotedRules,
    blockedPromotions,
    overfitWarnings,
    leakageWarnings,
    sampleSizeWarnings,
    rollbackCandidates,
    championChallenger: {
      championPolicyVersion: `${currentPolicyVersion}|${currentModelVersion}|${currentConfigVersion}`,
      challengerExperiments: activeExperiments,
      status: challengerStatus,
    },
    recommendedNextAction,
  };
}
