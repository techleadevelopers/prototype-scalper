import { describe, expect, it } from "vitest";
import type { TradeOutcome } from "../adaptiveEngine";
import type { LiveReadinessStatus } from "../live_readiness";
import { buildSniperGovernanceStatus } from "../sniperGovernance";
import type { StrategyMemoryStatus, StrategyRule } from "../strategyMemory";

function outcome(overrides: Partial<TradeOutcome> = {}): TradeOutcome {
  return {
    id: overrides.id ?? "o1",
    isDemo: true,
    source: "bingx-vst",
    sourceType: "demo",
    symbol: "BTC-USDT",
    positionSide: "LONG",
    side: "BUY",
    entryTime: 1_700_000_000_000,
    exitTime: 1_700_000_060_000,
    hourUtc: 12,
    btcRegime: "BULL",
    entryPrice: 100,
    exitPrice: 101,
    qty: 1,
    leverage: 10,
    marginUsed: 10,
    grossPnl: 1,
    fee: 0,
    realizedPnl: 1,
    exitReason: "TP",
    expectedTpProfit: 1,
    policyVersion: "policy-old",
    modelVersion: "model-1",
    configVersion: "config-1",
    ...overrides,
  };
}

function strategyMemory(overrides: Partial<StrategyMemoryStatus> = {}): StrategyMemoryStatus {
  const rule: StrategyRule = {
    ruleId: "rule_btc_boost",
    version: 1,
    scope: { symbol: "BTC-USDT", side: "LONG" as const, playbook: "MOMENTUM", regime: "BULL" },
    action: "BOOST_PRIORITY" as const,
    maturity: "ACTIVE_RULE" as const,
    confidence: 0.72,
    evidence: {
      trades: 20,
      eligibleTrades: 20,
      winRate: 0.8,
      profitFactor: 0.9,
      avgPnl: 0.1,
      totalPnl: 2,
      maxDrawdown: 1,
      avgSlippageBps: 1,
      p95SlippageBps: 2,
      avgScore: 0.8,
      calibrationError: 0.31,
      tpRate: 0.8,
      slRate: 0.2,
      avgHoldMinutes: 5,
      avgStackDepth: 1,
      integrityOk: true,
      executionAcceptable: true,
      operationalErrorRate: 0,
    },
    createdAt: 1,
    lastValidatedAt: 2,
    expiresAt: 3,
    ruleDecay: 1,
    driftDetected: false,
    retirementReason: null,
    conflictGroup: "BTC-USDT|LONG|MOMENTUM|BULL",
    supersedes: [],
    rationale: "test",
    distillation: "test",
  };
  return {
    generatedAt: 1,
    rules: [rule],
    activeRules: [rule],
    hypotheses: [],
    expiredRules: [],
    rulesBySymbol: { "BTC-USDT": [rule] },
    rulesByPlaybook: { MOMENTUM: [rule] },
    newRecommendations: [rule],
    estimatedImpact: {
      priorityBoostScopes: 1,
      reducedRiskScopes: 0,
      pausedScopes: 0,
      sizingChanges: 0,
      liveReadinessChanges: 0,
      expectedPnlDeltaUsdt: 1,
    },
    applications: [],
    knowledgeDistillation: { topLearnedRules: [], report: "" },
    diagnostics: {
      totalOutcomes: 20,
      eligibleOutcomes: 20,
      blockedOutcomes: 0,
      candidateScopes: 1,
      conflictsResolved: 0,
      integrityRequired: true,
    },
    ...overrides,
  };
}

function liveReadiness(overrides: Partial<LiveReadinessStatus> = {}): LiveReadinessStatus {
  const approved = {
    id: "BTC-USDT:LONG:MOMENTUM:BULL:SCORE_0.8_0.9:SNIPER:D1:TP_SL:BOOST",
    symbol: "BTC-USDT",
    side: "LONG" as const,
    playbook: "MOMENTUM",
    regime: "BULL",
    scoreBucket: "SCORE_0.8_0.9",
    context: "SNIPER",
    stackingDepth: 1,
    exitPolicy: "TP_SL",
    positionSizingTier: "BOOST",
    promotionState: "LIMITED_LIVE" as const,
    readinessScore: 0.9,
    maxMargin: 2,
    maxPositions: 1,
    maxDailyLoss: 1,
    allowedScoreMin: 0.8,
    killSwitchSensitivity: "MEDIUM" as const,
    metrics: {
      demoTrades: 80,
      demoPnl: 10,
      demoProfitFactor: 1.8,
      demoDrawdown: 1,
      liveTrades: 10,
      livePnl: -2,
      liveProfitFactor: 0.7,
      liveDrawdown: 2,
      liveShadowTrades: 0,
      liveShadowPnl: 0,
      slippageLiveVsDemoBps: 1,
      executionQuality: 0.9,
      scoreCalibration: 0.9,
      exitQuality: 0.8,
      pipelineIntegrity: 1,
      consecutiveLiveLosses: 2,
    },
    reason: "approved",
    recommendations: [],
  };
  return {
    liveReady: true,
    readinessScore: 0.9,
    approvedScopes: [approved],
    blockedScopes: [],
    reason: "ready",
    generatedAt: 1,
    promotionStates: {
      DEMO_ONLY: 0,
      SHADOW_LIVE: 0,
      MICRO_LIVE: 0,
      LIMITED_LIVE: 1,
      STANDARD_LIVE: 0,
      SUSPENDED: 0,
    },
    recommendations: [],
    ...overrides,
  };
}

describe("buildSniperGovernanceStatus", () => {
  it("blocks confidence when promoted rules have low sample and weak PF despite positive PnL", () => {
    const status = buildSniperGovernanceStatus({
      outcomes: [outcome()],
      strategyMemory: strategyMemory(),
      liveReadiness: liveReadiness({ approvedScopes: [], liveReady: false }),
      scoreCalibration: { connected: true, scoreTruth: { calibrationQuality: "GOOD" } },
      now: 1,
    });

    expect(status.promotedRules).toHaveLength(1);
    expect(status.sampleSizeWarnings.some((warning) => warning.code === "RULE_ACTIVE_BELOW_GOVERNANCE_SAMPLE")).toBe(true);
    expect(status.overfitWarnings.some((warning) => warning.code === "POSITIVE_ACTION_WITH_WEAK_EV")).toBe(true);
  });

  it("flags bad score calibration and recommends shadow instead of boost", () => {
    const status = buildSniperGovernanceStatus({
      outcomes: [outcome()],
      strategyMemory: strategyMemory({ activeRules: [] }),
      liveReadiness: liveReadiness({ approvedScopes: [], liveReady: false }),
      scoreCalibration: {
        connected: true,
        scoreTruth: { calibrationQuality: "POOR" },
        brierScore: 0.2,
        overconfidenceWarnings: ["overconfident_high_bucket"],
      },
      now: 1,
    });

    expect(status.overfitWarnings.some((warning) => warning.code === "SCORE_CALIBRATION_ERROR_TOO_HIGH")).toBe(true);
    expect(status.recommendedNextAction).toContain("shadow");
  });

  it("recommends rollback when live treatment drawdown or PF degrades", () => {
    const status = buildSniperGovernanceStatus({
      outcomes: [outcome()],
      strategyMemory: strategyMemory({ activeRules: [] }),
      liveReadiness: liveReadiness(),
      scoreCalibration: { connected: true, scoreTruth: { calibrationQuality: "GOOD" } },
      now: 1,
    });

    expect(status.rollbackCandidates.some((candidate) => candidate.reason === "live_pf_or_drawdown_degraded")).toBe(true);
    expect(status.championChallenger.status).toBe("ROLLBACK_RECOMMENDED");
  });

  it("preserves the latest policy version from historical outcomes", () => {
    const status = buildSniperGovernanceStatus({
      outcomes: [
        outcome({ id: "old", exitTime: 10, policyVersion: "policy-old" }),
        outcome({ id: "new", exitTime: 20, policyVersion: "policy-new" }),
      ],
      strategyMemory: strategyMemory({ activeRules: [] }),
      liveReadiness: liveReadiness({ approvedScopes: [], liveReady: false }),
      scoreCalibration: { connected: true, scoreTruth: { calibrationQuality: "GOOD" } },
      now: 1,
    });

    expect(status.currentPolicyVersion).toBe("policy-new");
    expect(status.championChallenger.championPolicyVersion).toContain("policy-new");
  });
});
