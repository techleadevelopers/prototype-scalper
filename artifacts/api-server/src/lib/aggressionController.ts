import type { BotConfig } from "./botConfig";
import type { BtcRegime, TradeOutcome } from "./adaptiveEngine";
import type { ServiceStateSnapshot } from "./serviceState";

export type AggressionState = "PAUSED" | "DEFENSIVE" | "NORMAL" | "BOOST" | "MAX_SNIPER";

export interface AggressionCandidate {
  symbol: string;
  positionSide?: "LONG" | "SHORT";
  score: number;
  candleScore?: number;
  rankingScore?: number;
  volumeRatio?: number;
}

export interface AggressionControllerInput {
  config: BotConfig;
  outcomes: TradeOutcome[];
  serviceState?: ServiceStateSnapshot;
  candidates?: AggressionCandidate[];
  btcRegime?: BtcRegime;
  btcChangePct?: number;
  openPositionsCount?: number;
  maxOpenPositions?: number;
  dataFresh?: boolean;
  apiHealthy?: boolean;
  executionHealthy?: boolean;
  source?: "live" | "demo" | "all";
  now?: number;
}

export interface AggressionMetrics {
  recentTrades: number;
  recentWinRate: number;
  recentProfitFactor: number;
  recentPnlUsdt: number;
  recentDrawdownUsdt: number;
  consecutiveLosses: number;
  avgSlippageBps: number;
  scoreSeparation: number;
  hotSymbols: number;
  marketMomentum: number;
  openPositionPressure: number;
}

export interface AggressionDecision {
  aggressionState: AggressionState;
  maxCandidatesThisCycle: number;
  maxPositionsThisCycle: number;
  marginMultiplier: number;
  stackingAllowed: boolean;
  minAggressiveScore: number;
  cooldownMultiplier: number;
  symbolConcentrationLimit: number;
  allowBurstMode: boolean;
  reason: string;
  metrics: AggressionMetrics;
  appliedAt: number;
  source: "live" | "demo" | "all";
}

export interface AggressionStatus extends AggressionDecision {
  stateHistory: Array<{ from: AggressionState | null; to: AggressionState; reason: string; at: number }>;
  recentImpact: {
    tradesAttempted: number;
    tradesPlaced: number;
    pnlUsdt: number;
    enteredBoostAt: number | null;
    exitedBoostAt: number | null;
    enteredMaxSniperAt: number | null;
    exitedMaxSniperAt: number | null;
  };
}

const DEFAULT_METRICS: AggressionMetrics = {
  recentTrades: 0,
  recentWinRate: 0,
  recentProfitFactor: 0,
  recentPnlUsdt: 0,
  recentDrawdownUsdt: 0,
  consecutiveLosses: 0,
  avgSlippageBps: 0,
  scoreSeparation: 0,
  hotSymbols: 0,
  marketMomentum: 0,
  openPositionPressure: 0,
};

const BASE_DECISION: AggressionDecision = {
  aggressionState: "NORMAL",
  maxCandidatesThisCycle: 5,
  maxPositionsThisCycle: 3,
  marginMultiplier: 1,
  stackingAllowed: true,
  minAggressiveScore: 0.58,
  cooldownMultiplier: 1,
  symbolConcentrationLimit: 2,
  allowBurstMode: false,
  reason: "initial_normal",
  metrics: DEFAULT_METRICS,
  appliedAt: Date.now(),
  source: "all",
};

let lastDecision: AggressionDecision = BASE_DECISION;
const stateHistory: AggressionStatus["stateHistory"] = [];
const recentImpact = {
  tradesAttempted: 0,
  tradesPlaced: 0,
  pnlUsdt: 0,
  enteredBoostAt: null as number | null,
  exitedBoostAt: null as number | null,
  enteredMaxSniperAt: null as number | null,
  exitedMaxSniperAt: null as number | null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finite(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function maxDrawdown(pnls: number[]): number {
  let running = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of pnls) {
    running += pnl;
    peak = Math.max(peak, running);
    drawdown = Math.max(drawdown, peak - running);
  }
  return drawdown;
}

function consecutiveLosses(outcomes: TradeOutcome[]): number {
  let losses = 0;
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    if (outcomes[i].realizedPnl > 0) break;
    losses += 1;
  }
  return losses;
}

function scoreSeparation(outcomes: TradeOutcome[]): number {
  const scored = outcomes
    .map((outcome) => ({
      score: Number((outcome as TradeOutcome & { edgeScore?: number }).edgeScore ?? 0),
      pnl: outcome.realizedPnl,
    }))
    .filter((row) => Number.isFinite(row.score) && row.score > 0);
  if (scored.length < 8) return 0;
  scored.sort((a, b) => b.score - a.score);
  const bucket = Math.max(2, Math.floor(scored.length * 0.25));
  const high = scored.slice(0, bucket);
  const low = scored.slice(-bucket);
  const avg = (rows: typeof high) => rows.reduce((sum, row) => sum + row.pnl, 0) / rows.length;
  return avg(high) - avg(low);
}

function buildMetrics(input: AggressionControllerInput): AggressionMetrics {
  const now = input.now ?? Date.now();
  const since = now - input.config.recentEdgeWindowHours * 60 * 60 * 1000;
  const recent = input.outcomes
    .filter((outcome) => outcome.exitTime >= since)
    .sort((a, b) => a.exitTime - b.exitTime);
  const wins = recent.filter((outcome) => outcome.realizedPnl > 0);
  const losses = recent.filter((outcome) => outcome.realizedPnl <= 0);
  const grossProfit = wins.reduce((sum, outcome) => sum + outcome.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, outcome) => sum + outcome.realizedPnl, 0));
  const candidates = input.candidates ?? [];
  const candidateScores = candidates.map((candidate) => finite(candidate.score)).sort((a, b) => b - a);
  const hotSymbols = new Set(candidates.filter((candidate) => finite(candidate.score) >= 0.70).map((c) => c.symbol)).size;
  const marketMomentum = candidates.length > 0
    ? candidates.reduce((sum, candidate) => sum + finite(candidate.volumeRatio, 1), 0) / candidates.length
    : Math.abs(input.btcChangePct ?? 0) / Math.max(1, input.config.btcRegimeThresholdPct);
  const scoreSpread = candidateScores.length >= 4
    ? candidateScores.slice(0, Math.ceil(candidateScores.length / 4)).reduce((s, v) => s + v, 0) / Math.ceil(candidateScores.length / 4)
      - candidateScores.slice(-Math.ceil(candidateScores.length / 4)).reduce((s, v) => s + v, 0) / Math.ceil(candidateScores.length / 4)
    : scoreSeparation(recent);
  const openMax = input.maxOpenPositions ?? input.config.maxConcurrentPositions;
  return {
    recentTrades: recent.length,
    recentWinRate: recent.length > 0 ? wins.length / recent.length : 0,
    recentProfitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    recentPnlUsdt: grossProfit - grossLoss,
    recentDrawdownUsdt: maxDrawdown(recent.map((outcome) => outcome.realizedPnl)),
    consecutiveLosses: Math.max(consecutiveLosses(recent), input.serviceState?.consecutiveLosses ?? 0),
    avgSlippageBps: recent.length > 0
      ? recent.reduce((sum, outcome) => sum + finite(outcome.slippagePctNotional ?? 0) * 10_000, 0) / recent.length
      : 0,
    scoreSeparation: finite(scoreSpread),
    hotSymbols,
    marketMomentum: finite(marketMomentum),
    openPositionPressure: openMax > 0 ? clamp((input.openPositionsCount ?? 0) / openMax, 0, 2) : 0,
  };
}

function profile(state: AggressionState, config: BotConfig): Omit<AggressionDecision, "aggressionState" | "reason" | "metrics" | "appliedAt" | "source"> {
  const configuredMax = Math.max(1, config.sniperMaxCandidatesPerCycle);
  switch (state) {
    case "PAUSED":
      return { maxCandidatesThisCycle: 0, maxPositionsThisCycle: 0, marginMultiplier: 0, stackingAllowed: false, minAggressiveScore: 1, cooldownMultiplier: 999, symbolConcentrationLimit: 0, allowBurstMode: false };
    case "DEFENSIVE":
      return { maxCandidatesThisCycle: Math.min(2, configuredMax), maxPositionsThisCycle: 1, marginMultiplier: 0.5, stackingAllowed: false, minAggressiveScore: 0.68, cooldownMultiplier: 2, symbolConcentrationLimit: 1, allowBurstMode: false };
    case "BOOST":
      return { maxCandidatesThisCycle: Math.min(Math.max(8, configuredMax), 12), maxPositionsThisCycle: 5, marginMultiplier: 1.25, stackingAllowed: true, minAggressiveScore: 0.55, cooldownMultiplier: 0.75, symbolConcentrationLimit: 3, allowBurstMode: true };
    case "MAX_SNIPER":
      return { maxCandidatesThisCycle: Math.min(Math.max(10, configuredMax), 15), maxPositionsThisCycle: 8, marginMultiplier: 1.5, stackingAllowed: true, minAggressiveScore: 0.52, cooldownMultiplier: 0.5, symbolConcentrationLimit: 4, allowBurstMode: true };
    case "NORMAL":
    default:
      return { maxCandidatesThisCycle: Math.min(5, configuredMax), maxPositionsThisCycle: 3, marginMultiplier: 1, stackingAllowed: true, minAggressiveScore: 0.58, cooldownMultiplier: 1, symbolConcentrationLimit: 2, allowBurstMode: false };
  }
}

function chooseState(input: AggressionControllerInput, metrics: AggressionMetrics): { state: AggressionState; reason: string } {
  const svc = input.serviceState;
  if (
    svc?.state === "PAUSED"
    || input.dataFresh === false
    || input.apiHealthy === false
    || input.executionHealthy === false
    || (svc?.rollingLossPct !== null && svc?.rollingLossPct !== undefined && svc.rollingLossPct <= -10)
  ) {
    return { state: "PAUSED", reason: svc?.reason ? `service_${svc.reason.toLowerCase()}` : "api_or_data_health_failed" };
  }
  if (
    svc?.state === "DEGRADED"
    || svc?.state === "SHADOW_ONLY"
    || metrics.consecutiveLosses >= Math.max(3, input.config.recentEdgeMaxConsecutiveLosses)
    || metrics.avgSlippageBps > Math.max(12, input.config.slippageBpsPerSide * 4)
    || (metrics.recentTrades >= input.config.recentEdgeMinTrades && metrics.recentProfitFactor < input.config.recentEdgeMinProfitFactor)
    || (metrics.recentTrades >= input.config.recentEdgeMinTrades && metrics.scoreSeparation < -0.01)
  ) {
    return { state: "DEFENSIVE", reason: "recent_execution_or_edge_degraded" };
  }
  const enoughTrades = metrics.recentTrades >= Math.max(4, Math.floor(input.config.recentEdgeMinTrades / 2));
  const boosted =
    enoughTrades
    && metrics.recentProfitFactor > 1.3
    && metrics.recentWinRate >= 0.45
    && metrics.recentDrawdownUsdt <= Math.max(1, Math.abs(metrics.recentPnlUsdt) * 0.6)
    && metrics.avgSlippageBps <= Math.max(8, input.config.slippageBpsPerSide * 3)
    && metrics.scoreSeparation >= -0.001;
  const maxSniper =
    boosted
    && metrics.hotSymbols >= 3
    && metrics.marketMomentum >= 1.25
    && metrics.consecutiveLosses === 0
    && metrics.openPositionPressure < 0.75
    && (input.btcRegime === "BULL" || input.btcRegime === "BEAR");
  if (maxSniper) return { state: "MAX_SNIPER", reason: "multiple_hot_symbols_good_execution_market_momentum" };
  if (boosted) return { state: "BOOST", reason: "recent_profit_factor_high_drawdown_low" };
  return { state: "NORMAL", reason: "baseline_conditions" };
}

function recordTransition(next: AggressionDecision): void {
  if (next.aggressionState === lastDecision.aggressionState) return;
  stateHistory.push({
    from: lastDecision.aggressionState,
    to: next.aggressionState,
    reason: next.reason,
    at: next.appliedAt,
  });
  if (stateHistory.length > 50) stateHistory.shift();
  if (next.aggressionState === "BOOST" && recentImpact.enteredBoostAt === null) recentImpact.enteredBoostAt = next.appliedAt;
  if (lastDecision.aggressionState === "BOOST" && next.aggressionState !== "BOOST") recentImpact.exitedBoostAt = next.appliedAt;
  if (next.aggressionState === "MAX_SNIPER" && recentImpact.enteredMaxSniperAt === null) recentImpact.enteredMaxSniperAt = next.appliedAt;
  if (lastDecision.aggressionState === "MAX_SNIPER" && next.aggressionState !== "MAX_SNIPER") recentImpact.exitedMaxSniperAt = next.appliedAt;
}

export function evaluateAggression(input: AggressionControllerInput): AggressionDecision {
  const metrics = buildMetrics(input);
  const choice = chooseState(input, metrics);
  const decision: AggressionDecision = {
    aggressionState: choice.state,
    ...profile(choice.state, input.config),
    reason: choice.reason,
    metrics,
    appliedAt: input.now ?? Date.now(),
    source: input.source ?? "all",
  };
  recordTransition(decision);
  lastDecision = decision;
  return decision;
}

export function applyAggressionToConfig<T extends BotConfig>(config: T, decision: AggressionDecision): T {
  return {
    ...config,
    marginPerTrade: config.marginPerTrade * decision.marginMultiplier,
    sniperMaxCandidatesPerCycle: decision.maxCandidatesThisCycle,
    sniperMinCombinedScore: Math.max(config.sniperMinCombinedScore, decision.minAggressiveScore),
    positionStackingEnabled: config.positionStackingEnabled && decision.stackingAllowed,
    maxPositionsPerSymbol: Math.min(config.maxPositionsPerSymbol, Math.max(1, decision.symbolConcentrationLimit)),
  };
}

export function recordAggressionCycleImpact(attempted: number, placed: number, pnlUsdt = 0): void {
  recentImpact.tradesAttempted += Math.max(0, attempted);
  recentImpact.tradesPlaced += Math.max(0, placed);
  recentImpact.pnlUsdt += pnlUsdt;
}

export function getAggressionStatus(): AggressionStatus {
  return {
    ...lastDecision,
    stateHistory: stateHistory.slice(-20),
    recentImpact: { ...recentImpact },
  };
}
