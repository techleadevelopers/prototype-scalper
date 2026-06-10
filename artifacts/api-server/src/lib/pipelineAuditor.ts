import type { TradeOutcome } from "./adaptiveEngine";
import type { DemoClosedTrade, DemoTradeEntry } from "./demoTradeStore";

export type PipelineSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type PipelineHealth = "HEALTHY" | "DEGRADED" | "CRITICAL";

export interface PipelineGap {
  severity: PipelineSeverity;
  code: string;
  message: string;
  entityType: "signal" | "decision" | "order" | "position" | "outcome" | "campaign" | "prediction" | "learning";
  entityId: string | null;
  previousId?: string | null;
  details?: Record<string, unknown>;
}

export interface LearningEligibility {
  learningEligible: boolean;
  blockedReasons: string[];
}

export interface PipelineAuditReport {
  health: PipelineHealth;
  totalSignals: number;
  totalOrders: number;
  totalPositions: number;
  totalOutcomes: number;
  criticalGaps: PipelineGap[];
  highGaps: PipelineGap[];
  mediumGaps: PipelineGap[];
  lowGaps: PipelineGap[];
  orphanSignals: number;
  orphanOrders: number;
  orphanPositions: number;
  duplicateExecutions: number;
  learningEligibleOutcomes: number;
  blockedFromLearning: number;
  gapsByStage: Record<string, number>;
  topIntegrityLossCauses: Array<{ code: string; count: number; severity: PipelineSeverity }>;
  latestCriticalFailures: PipelineGap[];
}

export interface PipelineAuditInput {
  outcomes: TradeOutcome[];
  openDemoTrades?: DemoTradeEntry[];
  closedDemoTrades?: DemoClosedTrade[];
}

const SEVERITY_ORDER: Record<PipelineSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function isLongShortSideCorrect(positionSide: string | undefined, side: string | undefined): boolean {
  return (positionSide === "LONG" && side === "BUY") || (positionSide === "SHORT" && side === "SELL");
}

function expectedCloseSide(positionSide: string | undefined): "BUY" | "SELL" | null {
  if (positionSide === "LONG") return "SELL";
  if (positionSide === "SHORT") return "BUY";
  return null;
}

function hasPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sourceTypeOf(outcome: TradeOutcome): "demo" | "live" | "hypothetical" | "shadow" | "unknown" {
  if (outcome.sourceType) return outcome.sourceType;
  if (outcome.source === "bingx-vst" || outcome.isDemo === true) return "demo";
  if (outcome.source === "bingx-live" || outcome.isDemo === false) return "live";
  return "unknown";
}

function hasEnvironmentMismatch(outcome: TradeOutcome): boolean {
  const sourceType = sourceTypeOf(outcome);
  if (outcome.source === "bingx-vst" && sourceType === "live") return true;
  if (outcome.source === "bingx-live" && sourceType === "demo") return true;
  if (outcome.isDemo === true && sourceType === "live") return true;
  if (outcome.isDemo === false && sourceType === "demo") return true;
  return false;
}

export function validateLearningEligibility(
  outcome: TradeOutcome,
  context: { duplicateOutcomeIds?: Set<string>; duplicatePositionIds?: Set<string>; duplicateClientOrderIds?: Set<string> } = {},
): LearningEligibility {
  const blockedReasons: string[] = [];

  if (!outcome.signalId) blockedReasons.push("missing_signalId");
  if (!isLongShortSideCorrect(outcome.positionSide, outcome.side)) blockedReasons.push("side_mismatch");
  if (!hasPositiveNumber(outcome.entryPrice)) blockedReasons.push("missing_entryPrice");
  if (!hasPositiveNumber(outcome.exitPrice) && !outcome.entryTime) blockedReasons.push("missing_exitPrice_or_firstEvent");
  if (!hasPositiveNumber(outcome.entryTime)) blockedReasons.push("missing_entryTimestamp");
  if (!hasPositiveNumber(outcome.exitTime)) blockedReasons.push("missing_exitTimestamp");
  if (!outcome.exitReason || !Number.isFinite(outcome.realizedPnl)) blockedReasons.push("invalid_outcome");
  if (context.duplicateOutcomeIds?.has(outcome.id)) blockedReasons.push("duplicated_outcome");
  const positionId = outcome.exchangeOrderId ?? outcome.entryOrderId ?? outcome.id;
  if (context.duplicatePositionIds?.has(positionId)) blockedReasons.push("duplicated_position");
  if (outcome.clientOrderId && context.duplicateClientOrderIds?.has(outcome.clientOrderId)) {
    blockedReasons.push("duplicated_clientOrderId");
  }
  if (hasEnvironmentMismatch(outcome)) blockedReasons.push("environment_mismatch");

  return {
    learningEligible: blockedReasons.length === 0,
    blockedReasons,
  };
}

function findDuplicates(values: Array<string | null | undefined>): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    if (seen.has(value)) duplicated.add(value);
    else seen.add(value);
  }
  return duplicated;
}

function pushGap(gaps: PipelineGap[], gap: PipelineGap): void {
  gaps.push(gap);
}

export function auditPipeline(input: PipelineAuditInput): PipelineAuditReport {
  const outcomes = input.outcomes;
  const openDemoTrades = input.openDemoTrades ?? [];
  const closedDemoTrades = input.closedDemoTrades ?? [];
  const gaps: PipelineGap[] = [];

  const duplicateMarketEventIds = findDuplicates([
    ...outcomes.map((outcome) => outcome.marketEventId),
    ...openDemoTrades.map((trade) => trade.marketEventId),
    ...closedDemoTrades.map((trade) => trade.marketEventId),
  ]);
  const duplicateClientOrderIds = findDuplicates([
    ...outcomes.map((outcome) => outcome.clientOrderId ?? undefined),
    ...openDemoTrades.map((trade) => trade.clientOrderId ?? undefined),
    ...closedDemoTrades.map((trade) => trade.clientOrderId ?? undefined),
  ]);
  const duplicateOutcomeIds = findDuplicates(outcomes.map((outcome) => outcome.id));
  const positionIds = outcomes.map((outcome) => outcome.exchangeOrderId ?? outcome.entryOrderId ?? outcome.id);
  const duplicatePositionIds = findDuplicates(positionIds);

  for (const marketEventId of duplicateMarketEventIds) {
    pushGap(gaps, {
      severity: "CRITICAL",
      code: "DUPLICATED_MARKET_EVENT_ID",
      message: "marketEventId duplicated across executions/outcomes.",
      entityType: "signal",
      entityId: marketEventId,
    });
  }

  for (const clientOrderId of duplicateClientOrderIds) {
    pushGap(gaps, {
      severity: "CRITICAL",
      code: "DUPLICATED_CLIENT_ORDER_ID",
      message: "clientOrderId duplicated; execution idempotency is compromised.",
      entityType: "order",
      entityId: clientOrderId,
    });
  }

  for (const positionId of duplicatePositionIds) {
    pushGap(gaps, {
      severity: "CRITICAL",
      code: "MULTIPLE_OUTCOMES_FOR_POSITION",
      message: "More than one outcome references the same position/order id.",
      entityType: "position",
      entityId: positionId,
    });
  }

  for (const trade of openDemoTrades) {
    const positionId = trade.orderId || trade.tradeId;
    if (!trade.campaignId) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "CAMPAIGN_STACKING_WITHOUT_CAMPAIGN_ID",
        message: "Open stacked trade is missing campaignId.",
        entityType: "campaign",
        entityId: trade.tradeId,
      });
    }
    if (!trade.lastCheckedAt) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "POSITION_OPENED_WITHOUT_MONITOR",
        message: "Open position has not been checked by the monitor.",
        entityType: "position",
        entityId: positionId,
      });
    }
    if (!hasPositiveNumber(trade.entryPrice)) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "ENTRY_PRICE_MISSING",
        message: "Open position is missing entryPrice.",
        entityType: "position",
        entityId: positionId,
      });
    }
    if (trade.predictionId && !trade.signalId) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "QUANT_PREDICTION_WITHOUT_SIGNAL_ID",
        message: "Quant Brain prediction is not linked to a signalId.",
        entityType: "prediction",
        entityId: trade.predictionId,
      });
    }
    if (trade.stackingDepth && trade.stackingDepth > 1 && trade.edgeAtInsertion == null) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "STACKING_EDGE_AT_INSERTION_MISSING",
        message: "Stacking entry lacks edgeAtInsertion.",
        entityType: "campaign",
        entityId: trade.campaignId,
      });
    }
    if (trade.featureVersion == null) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "FEATURE_VERSION_MISSING",
        message: "Open trade lacks featureVersion.",
        entityType: "position",
        entityId: positionId,
      });
    }
  }

  for (const trade of closedDemoTrades) {
    if (!trade.exitOrderId && trade.exitReason !== "MANUAL") {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "TP_SL_WITHOUT_POSITION_LINK",
        message: "TP/SL close has no exit order link.",
        entityType: "position",
        entityId: trade.tradeId,
      });
    }
    if (!hasPositiveNumber(trade.exitPrice)) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "EXIT_PRICE_MISSING",
        message: "Closed trade is missing exitPrice.",
        entityType: "position",
        entityId: trade.tradeId,
      });
    }
    if (trade.mfe == null || trade.mae == null) {
      pushGap(gaps, {
        severity: "HIGH",
        code: "TRADE_WITHOUT_MFE_MAE",
        message: "Closed trade lacks MFE/MAE tracking.",
        entityType: "position",
        entityId: trade.tradeId,
      });
    }
  }

  let learningEligibleOutcomes = 0;
  let blockedFromLearning = 0;
  const eligibilityContext = { duplicateOutcomeIds, duplicatePositionIds, duplicateClientOrderIds };

  for (const outcome of outcomes) {
    const positionId = outcome.exchangeOrderId ?? outcome.entryOrderId ?? outcome.id;
    const sourceType = sourceTypeOf(outcome);
    const eligibility = validateLearningEligibility(outcome, eligibilityContext);

    if (eligibility.learningEligible) learningEligibleOutcomes++;
    else {
      blockedFromLearning++;
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "LEARNING_USING_INCOMPLETE_TRADE",
        message: "Outcome is blocked from model training by pipeline integrity checks.",
        entityType: "learning",
        entityId: outcome.id,
        previousId: outcome.signalId ?? null,
        details: { reasons: eligibility.blockedReasons },
      });
    }

    if (!outcome.signalId) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "OUTCOME_WITHOUT_ORIGINAL_SIGNAL",
        message: "Outcome does not point to the original signalId.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
    if (outcome.predictionId && !outcome.signalId) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "QUANT_PREDICTION_WITHOUT_SIGNAL_ID",
        message: "Quant Brain prediction has no signalId lineage.",
        entityType: "prediction",
        entityId: outcome.predictionId,
      });
    }
    if (!outcome.predictionId && outcome.source === "bingx-vst" && outcome.id.startsWith("campaign:")) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "PREDICTION_ID_MISSING",
        message: "Campaign ML outcome lacks predictionId.",
        entityType: "prediction",
        entityId: outcome.id,
        previousId: outcome.signalId ?? null,
      });
    }
    if (!outcome.campaignId && outcome.source === "bingx-vst") {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "CAMPAIGN_ID_MISSING",
        message: "Demo/VST outcome lacks campaignId.",
        entityType: "campaign",
        entityId: outcome.id,
      });
    }
    if (!outcome.featureVersion) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "FEATURE_VERSION_MISSING",
        message: "Outcome lacks featureVersion.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
    if (!outcome.modelVersion) {
      pushGap(gaps, {
        severity: "MEDIUM",
        code: "MODEL_VERSION_MISSING",
        message: "Outcome lacks modelVersion.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
    if (!hasPositiveNumber(outcome.entryPrice)) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "ENTRY_PRICE_MISSING",
        message: "Outcome has no valid entryPrice.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
    if (!hasPositiveNumber(outcome.exitPrice)) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "EXIT_PRICE_MISSING",
        message: "Outcome has no valid exitPrice.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
    if (!isLongShortSideCorrect(outcome.positionSide, outcome.side)) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "SIDE_MISMATCH",
        message: "Entry side does not match positionSide.",
        entityType: "outcome",
        entityId: outcome.id,
        details: { positionSide: outcome.positionSide, entrySide: outcome.side, expectedCloseSide: expectedCloseSide(outcome.positionSide) },
      });
    }
    if (hasEnvironmentMismatch(outcome)) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "ENVIRONMENT_MISMATCH",
        message: "Demo/live flags conflict with source/sourceType.",
        entityType: "outcome",
        entityId: outcome.id,
        details: { source: outcome.source, isDemo: outcome.isDemo, sourceType },
      });
    }
    if ((outcome.entrySlippage != null || outcome.exitSlippage != null || outcome.totalSlippage != null)
      && (outcome.expectedEntryPrice == null && outcome.expectedExitPrice == null)) {
      pushGap(gaps, {
        severity: "HIGH",
        code: "SLIPPAGE_WITHOUT_EXPECTED_PRICE",
        message: "Slippage exists without expected entry/exit price.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
    if ((outcome.mfe == null || outcome.mae == null) && outcome.source === "bingx-vst" && outcome.id.startsWith("campaign:")) {
      pushGap(gaps, {
        severity: "HIGH",
        code: "TRADE_WITHOUT_MFE_MAE",
        message: "Campaign training outcome lacks MFE/MAE.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
    if (!positionId) {
      pushGap(gaps, {
        severity: "CRITICAL",
        code: "OUTCOME_WITHOUT_POSITION",
        message: "Outcome has no position/order identity.",
        entityType: "outcome",
        entityId: outcome.id,
      });
    }
  }

  const bySeverity = (severity: PipelineSeverity) => gaps.filter((gap) => gap.severity === severity);
  const criticalGaps = bySeverity("CRITICAL");
  const highGaps = bySeverity("HIGH");
  const mediumGaps = bySeverity("MEDIUM");
  const lowGaps = bySeverity("LOW");
  const gapsByStage: Record<string, number> = {};
  const causeCounts = new Map<string, { count: number; severity: PipelineSeverity }>();

  for (const gap of gaps) {
    gapsByStage[gap.entityType] = (gapsByStage[gap.entityType] ?? 0) + 1;
    const existing = causeCounts.get(gap.code);
    if (!existing) causeCounts.set(gap.code, { count: 1, severity: gap.severity });
    else {
      existing.count++;
      if (SEVERITY_ORDER[gap.severity] > SEVERITY_ORDER[existing.severity]) existing.severity = gap.severity;
    }
  }

  const orphanSignals = outcomes.filter((outcome) => !outcome.signalId).length;
  const orphanOrders = openDemoTrades.filter((trade) => !trade.orderId).length
    + outcomes.filter((outcome) => !outcome.entryOrderId && !outcome.exchangeOrderId && !outcome.clientOrderId).length;
  const outcomePositionIds = new Set(positionIds.filter(Boolean));
  const orphanPositions = openDemoTrades.filter((trade) => !outcomePositionIds.has(trade.orderId)).length;
  const duplicateExecutions = duplicateMarketEventIds.size + duplicateClientOrderIds.size;
  const health: PipelineHealth = criticalGaps.length > 0 ? "CRITICAL" : highGaps.length > 0 || mediumGaps.length > 0 ? "DEGRADED" : "HEALTHY";

  return {
    health,
    totalSignals: new Set([
      ...outcomes.map((outcome) => outcome.signalId).filter(Boolean),
      ...openDemoTrades.map((trade) => trade.signalId).filter(Boolean),
      ...closedDemoTrades.map((trade) => trade.signalId).filter(Boolean),
    ]).size,
    totalOrders: new Set([
      ...outcomes.map((outcome) => outcome.clientOrderId ?? outcome.entryOrderId ?? outcome.exchangeOrderId).filter(Boolean),
      ...openDemoTrades.map((trade) => trade.clientOrderId ?? trade.orderId).filter(Boolean),
      ...closedDemoTrades.map((trade) => trade.clientOrderId ?? trade.orderId).filter(Boolean),
    ]).size,
    totalPositions: new Set([
      ...positionIds,
      ...openDemoTrades.map((trade) => trade.orderId),
      ...closedDemoTrades.map((trade) => trade.orderId),
    ].filter(Boolean)).size,
    totalOutcomes: outcomes.length,
    criticalGaps,
    highGaps,
    mediumGaps,
    lowGaps,
    orphanSignals,
    orphanOrders,
    orphanPositions,
    duplicateExecutions,
    learningEligibleOutcomes,
    blockedFromLearning,
    gapsByStage,
    topIntegrityLossCauses: Array.from(causeCounts.entries())
      .map(([code, value]) => ({ code, count: value.count, severity: value.severity }))
      .sort((a, b) => b.count - a.count || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
      .slice(0, 10),
    latestCriticalFailures: criticalGaps.slice(-50).reverse(),
  };
}
