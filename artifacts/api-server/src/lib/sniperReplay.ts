export type ReplayMode = "historical-policy" | "candidate-policy";
export type ReplaySourceType = "demo" | "live" | "shadow" | "hypothetical";
export type ReplayDecision = "allow" | "block";
export type ReplaySide = "LONG" | "SHORT";

export interface ReplayOutcome {
  realizedPnl: number;
  hypotheticalPnl?: number;
  fee: number;
  slippage: number;
  funding: number;
  exitTime: number;
  exitReason: "TP" | "SL" | "TIMEOUT" | "MANUAL";
}

export interface ReplayDecisionSnapshot {
  signalId: string;
  symbol: string;
  side: ReplaySide;
  decisionTimestamp: number;
  marketEventId: string;
  candleCloseTimestamp: number;
  candleIsComplete: boolean;
  bid: number;
  ask: number;
  spreadBps: number;
  referencePrice: number;
  configVersion: string;
  policyVersion: string;
  modelVersion: string;
  featureSnapshot: Record<string, unknown>;
  playbook: string;
  regime: string;
  setup: string;
  rawScore: number;
  calibratedScore: number;
  gateRejects: string[];
  decision: ReplayDecision;
  sourceType: ReplaySourceType;
  outcome?: ReplayOutcome;
}

export interface ReplayValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ReplayExecutionAssumptions {
  feeBps?: number;
  slippageBps?: number;
  fundingBps?: number;
  maxConcurrentPositions?: number;
  maxMarginUtilization?: number;
  marginPerTrade?: number;
}

export interface ReplaySimulationInput {
  snapshots: ReplayDecisionSnapshot[];
  mode: ReplayMode;
  startingEquity: number;
  assumptions?: ReplayExecutionAssumptions;
}

export interface ReplaySimulationResult {
  tradesSimulated: number;
  netPnl: number;
  profitFactor: number | null;
  winRate: number | null;
  maxDrawdown: number;
  maxConsecutiveLosses: number;
  slippageDrag: number;
  fundingDrag: number;
  rejectedReasons: Record<string, number>;
  missedWins: number;
  avoidedLosses: number;
  capitalUtilization: number;
  promotionRecommendation: "promote" | "hold" | "reject";
}

const criticalFields: Array<keyof ReplayDecisionSnapshot> = [
  "signalId",
  "symbol",
  "side",
  "decisionTimestamp",
  "marketEventId",
  "candleCloseTimestamp",
  "bid",
  "ask",
  "spreadBps",
  "referencePrice",
  "configVersion",
  "policyVersion",
  "modelVersion",
  "featureSnapshot",
  "playbook",
  "regime",
  "setup",
  "rawScore",
  "calibratedScore",
  "gateRejects",
  "decision",
  "sourceType",
];

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateReplayDecisionSnapshot(snapshot: Partial<ReplayDecisionSnapshot>): ReplayValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of criticalFields) {
    const value = snapshot[field];
    if (value === undefined || value === null || value === "") {
      errors.push(`MISSING_${String(field).toUpperCase()}`);
    }
  }

  if (!finitePositive(snapshot.decisionTimestamp)) errors.push("INVALID_DECISION_TIMESTAMP");
  if (!finitePositive(snapshot.candleCloseTimestamp)) errors.push("INVALID_CANDLE_CLOSE_TIMESTAMP");
  if (
    typeof snapshot.decisionTimestamp === "number"
    && typeof snapshot.candleCloseTimestamp === "number"
    && snapshot.candleCloseTimestamp > snapshot.decisionTimestamp
  ) {
    errors.push("LOOKAHEAD_REJECT: candle close is after decision timestamp");
  }
  if (snapshot.candleIsComplete !== true) errors.push("INCOMPLETE_CANDLE_REJECT");
  const bid = snapshot.bid;
  const ask = snapshot.ask;
  if (!finitePositive(bid)) errors.push("INVALID_BID");
  if (!finitePositive(ask)) errors.push("INVALID_ASK");
  if (finitePositive(bid) && finitePositive(ask) && ask < bid) {
    errors.push("INVALID_SPREAD: ask below bid");
  }
  if (!finiteNonNegative(snapshot.spreadBps)) errors.push("INVALID_SPREAD_BPS");
  if (!finitePositive(snapshot.referencePrice)) errors.push("INVALID_REFERENCE_PRICE");
  if (typeof snapshot.rawScore === "number" && (snapshot.rawScore < 0 || snapshot.rawScore > 1)) errors.push("INVALID_RAW_SCORE");
  if (typeof snapshot.calibratedScore === "number" && (snapshot.calibratedScore < 0 || snapshot.calibratedScore > 1)) errors.push("INVALID_CALIBRATED_SCORE");
  if (snapshot.decision === "allow" && Array.isArray(snapshot.gateRejects) && snapshot.gateRejects.length > 0) {
    errors.push("ALLOW_WITH_GATE_REJECTS");
  }
  if (snapshot.decision === "block" && (!Array.isArray(snapshot.gateRejects) || snapshot.gateRejects.length === 0)) {
    warnings.push("BLOCK_WITHOUT_REJECT_REASON");
  }
  if (snapshot.outcome && snapshot.outcome.exitTime < (snapshot.decisionTimestamp ?? 0)) {
    errors.push("LOOKAHEAD_REJECT: outcome exits before decision");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertReplayReady(snapshots: Array<Partial<ReplayDecisionSnapshot>>): ReplayDecisionSnapshot[] {
  const seenMarketEvents = new Set<string>();
  const ready: ReplayDecisionSnapshot[] = [];

  snapshots.forEach((snapshot, index) => {
    const validation = validateReplayDecisionSnapshot(snapshot);
    if (!validation.ok) {
      throw new Error(`Replay snapshot ${index} is not replay-ready: ${validation.errors.join(", ")}`);
    }
    const full = snapshot as ReplayDecisionSnapshot;
    const eventKey = `${full.sourceType}:${full.marketEventId}:${full.side}`;
    if (seenMarketEvents.has(eventKey)) {
      throw new Error(`Replay snapshot ${index} reuses marketEventId: ${eventKey}`);
    }
    seenMarketEvents.add(eventKey);
    ready.push(full);
  });

  return ready.sort((a, b) => a.decisionTimestamp - b.decisionTimestamp);
}

export function simulateReplay(input: ReplaySimulationInput): ReplaySimulationResult {
  if (!Number.isFinite(input.startingEquity) || input.startingEquity <= 0) {
    throw new Error("startingEquity must be positive");
  }

  const assumptions = input.assumptions ?? {};
  const marginPerTrade = assumptions.marginPerTrade ?? input.startingEquity * 0.05;
  const maxConcurrentPositions = assumptions.maxConcurrentPositions ?? 1;
  const maxMarginUtilization = assumptions.maxMarginUtilization ?? 1;
  const snapshots = assertReplayReady(input.snapshots);
  let equity = input.startingEquity;
  let peak = equity;
  let maxDrawdown = 0;
  let openPositions = 0;
  let usedMargin = 0;
  let tradesSimulated = 0;
  let wins = 0;
  let grossWins = 0;
  let grossLosses = 0;
  let maxConsecutiveLosses = 0;
  let consecutiveLosses = 0;
  let slippageDrag = 0;
  let fundingDrag = 0;
  let missedWins = 0;
  let avoidedLosses = 0;
  let utilizationSum = 0;
  const rejectedReasons: Record<string, number> = {};

  for (const snapshot of snapshots) {
    for (const reason of snapshot.gateRejects) {
      rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
    }

    if (snapshot.decision === "block") {
      const blockedPnl = snapshot.outcome?.hypotheticalPnl ?? snapshot.outcome?.realizedPnl;
      if (typeof blockedPnl === "number" && blockedPnl > 0) missedWins++;
      if (typeof blockedPnl === "number" && blockedPnl < 0) avoidedLosses++;
      continue;
    }

    if (openPositions >= maxConcurrentPositions || (usedMargin + marginPerTrade) / equity > maxMarginUtilization) {
      rejectedReasons.CAPITAL_REJECT = (rejectedReasons.CAPITAL_REJECT ?? 0) + 1;
      continue;
    }
    if (!snapshot.outcome) {
      throw new Error(`Replay snapshot ${snapshot.signalId} is allowed but has no outcome`);
    }

    openPositions++;
    usedMargin += marginPerTrade;
    utilizationSum += usedMargin / equity;

    const fee = snapshot.outcome.fee + marginPerTrade * (assumptions.feeBps ?? 0) / 10_000;
    const slippage = snapshot.outcome.slippage + marginPerTrade * (assumptions.slippageBps ?? 0) / 10_000;
    const funding = snapshot.outcome.funding + marginPerTrade * (assumptions.fundingBps ?? 0) / 10_000;
    const pnl = snapshot.outcome.realizedPnl - fee - slippage - funding;

    slippageDrag += slippage;
    fundingDrag += funding;
    equity += pnl;
    tradesSimulated++;
    if (pnl > 0) {
      wins++;
      grossWins += pnl;
      consecutiveLosses = 0;
    } else {
      grossLosses += Math.abs(pnl);
      consecutiveLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    }
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    usedMargin -= marginPerTrade;
    openPositions--;
  }

  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? null : 0;
  const winRate = tradesSimulated > 0 ? wins / tradesSimulated : null;
  const capitalUtilization = tradesSimulated > 0 ? utilizationSum / tradesSimulated : 0;
  const netPnl = equity - input.startingEquity;
  const promotionRecommendation = netPnl > 0 && (profitFactor ?? 0) >= 1.2 && maxDrawdown <= input.startingEquity * 0.1
    ? "promote"
    : netPnl < 0 || maxDrawdown > input.startingEquity * 0.2
      ? "reject"
      : "hold";

  return {
    tradesSimulated,
    netPnl,
    profitFactor,
    winRate,
    maxDrawdown,
    maxConsecutiveLosses,
    slippageDrag,
    fundingDrag,
    rejectedReasons,
    missedWins,
    avoidedLosses,
    capitalUtilization,
    promotionRecommendation,
  };
}
