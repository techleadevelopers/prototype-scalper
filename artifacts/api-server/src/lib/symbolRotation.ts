import type { AdaptiveEngine, BtcRegime, PositionSide, TradeOutcome } from "./adaptiveEngine";
import type { BotConfig } from "./botConfig";
import { computeAllCandleEdges, type CandleEdge } from "./candleEdge";

export type SymbolRotationState = "HOT" | "ACTIVE" | "REDUCED" | "PAUSED" | "RECOVERY";
export type SymbolSideBias = "LONG" | "SHORT" | "NEUTRAL";

export interface SymbolOpenCounts {
  LONG: number;
  SHORT: number;
}

export interface SymbolRotationRank {
  symbol: string;
  state: SymbolRotationState;
  sideBias: SymbolSideBias;
  longScore: number;
  shortScore: number;
  rotationScore: number;
  allocationWeight: number;
  maxPositions: number;
  currentOpenPositions: number;
  recommendedPosition: "increase" | "normal" | "small" | "none";
  reason: string;
  metrics: {
    recentPnlUsdt: number;
    pnl24hUsdt: number;
    winRate4h: number;
    profitFactor4h: number;
    coachScoreAvg: number;
    executionQualityScore: number;
    currentMomentumScore: number;
    liquidityScore: number;
    validSignalRate: number;
    drawdownUsdt: number;
    avgSlippageUsdt: number;
    avgSlippageBps: number;
    toxicContextScore: number;
    samples4h: number;
    samples24h: number;
  };
}

export interface SymbolRotationReport {
  generatedAt: number;
  activeSymbols: string[];
  reducedSymbols: string[];
  pausedSymbols: string[];
  hotSymbols: string[];
  recoverySymbols: string[];
  ranking: SymbolRotationRank[];
}

interface BuildRotationInput {
  symbols: string[];
  engine: AdaptiveEngine;
  config: BotConfig;
  btcRegime?: BtcRegime;
  hourUtc?: number;
  candleEdges?: CandleEdge[];
  openCountsBySymbol?: Map<string, SymbolOpenCounts>;
}

const FIFTEEN_MIN_MS = 15 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const FOUR_HOUR_MS = 4 * ONE_HOUR_MS;
const DAY_MS = 24 * ONE_HOUR_MS;

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function sideFromBias(longScore: number, shortScore: number): SymbolSideBias {
  if (longScore > shortScore + 0.08) return "LONG";
  if (shortScore > longScore + 0.08) return "SHORT";
  return "NEUTRAL";
}

function outcomesForWindow(outcomes: TradeOutcome[], symbol: string, windowMs: number, now: number): TradeOutcome[] {
  const normalized = normalizeSymbol(symbol);
  const start = now - windowMs;
  return outcomes.filter((outcome) =>
    normalizeSymbol(outcome.symbol) === normalized
    && (outcome.exitTime ?? outcome.entryTime) >= start
    && (outcome.exitTime ?? outcome.entryTime) <= now
  );
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
  for (const outcome of [...outcomes].sort((a, b) => (a.exitTime ?? a.entryTime) - (b.exitTime ?? b.entryTime))) {
    cumulative += outcome.realizedPnl;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);
  }
  return maxDd;
}

function avgSlippageBps(outcomes: TradeOutcome[]): number {
  const values = outcomes
    .map((outcome) => outcome.slippagePctNotional)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value * 10_000, 0) / values.length;
}

function scoreSide(outcomes: TradeOutcome[], fallbackPriority: number): number {
  if (outcomes.length < 3) return clamp(fallbackPriority);
  const pnl = outcomes.reduce((sum, outcome) => sum + outcome.realizedPnl, 0);
  const wins = outcomes.filter((outcome) => outcome.realizedPnl > 0).length;
  const wr = wins / outcomes.length;
  const pf = profitFactor(outcomes);
  const pnlScore = clamp(0.5 + pnl / Math.max(5, outcomes.length * 2));
  return clamp(wr * 0.35 + clamp(pf / 2.5) * 0.30 + pnlScore * 0.20 + fallbackPriority * 0.15);
}

function classifyState(input: {
  score: number;
  pf4h: number;
  samples4h: number;
  samples24h: number;
  executionQuality: number;
  momentum: number;
  drawdownPenalty: number;
  slippagePenalty: number;
  toxicPenalty: number;
  recentPnl: number;
}): SymbolRotationState {
  const enoughTactical = input.samples4h >= 4;
  const enoughStable = input.samples24h >= 8;
  const severePenalty = input.drawdownPenalty + input.slippagePenalty + input.toxicPenalty;

  if (
    enoughStable
    && (input.drawdownPenalty >= 0.22 || input.toxicPenalty >= 0.18 || severePenalty >= 0.35)
    && input.recentPnl < 0
  ) {
    return "PAUSED";
  }
  if (enoughTactical && input.recentPnl < 0 && input.score < 0.42) return "RECOVERY";
  if (enoughTactical && input.pf4h >= 1.6 && input.executionQuality >= 0.65 && input.momentum >= 0.60 && input.score >= 0.70) {
    return "HOT";
  }
  if (input.score < 0.45 || input.slippagePenalty >= 0.16) return "REDUCED";
  return "ACTIVE";
}

function maxPositionsForState(state: SymbolRotationState, config: BotConfig): number {
  const configured = Math.max(1, Math.trunc(config.maxPositionsPerSymbol));
  if (state === "HOT") return Math.max(configured, 5);
  if (state === "ACTIVE") return Math.max(configured, 3);
  if (state === "REDUCED" || state === "RECOVERY") return 1;
  return 0;
}

function reasonFor(rank: Omit<SymbolRotationRank, "reason" | "allocationWeight">): string {
  if (rank.state === "PAUSED") return "paused_recent_drawdown_or_toxic_execution";
  if (rank.state === "RECOVERY") return "recovery_after_weak_recent_performance";
  if (rank.state === "HOT") return "high_recent_pf_low_slippage";
  if (rank.metrics.avgSlippageBps > 8) return "reduced_elevated_slippage";
  if (rank.metrics.validSignalRate < 0.45) return "reduced_low_valid_signal_rate";
  if (rank.sideBias !== "NEUTRAL") return `active_${rank.sideBias.toLowerCase()}_side_bias`;
  return "active_balanced_rotation";
}

export async function buildSymbolRotationReport(input: BuildRotationInput): Promise<SymbolRotationReport> {
  const now = Date.now();
  const symbols = Array.from(new Set(input.symbols.map(normalizeSymbol).filter(Boolean)));
  const btcRegime = input.btcRegime ?? "NEUTRAL";
  const hourUtc = input.hourUtc ?? new Date(now).getUTCHours();
  const candleEdges = input.candleEdges ?? await computeAllCandleEdges(symbols, "5m");
  const candleBySymbol = new Map(candleEdges.map((edge) => [normalizeSymbol(edge.symbol), edge]));
  const outcomes = input.engine.rawOutcomes();

  const rawRanking = symbols.map((symbol): Omit<SymbolRotationRank, "allocationWeight"> => {
    const w1h = outcomesForWindow(outcomes, symbol, ONE_HOUR_MS, now);
    const w4h = outcomesForWindow(outcomes, symbol, FOUR_HOUR_MS, now);
    const w24h = outcomesForWindow(outcomes, symbol, DAY_MS, now);
    const recentPnl = w4h.reduce((sum, outcome) => sum + outcome.realizedPnl, 0);
    const pnl24h = w24h.reduce((sum, outcome) => sum + outcome.realizedPnl, 0);
    const wins4h = w4h.filter((outcome) => outcome.realizedPnl > 0).length;
    const pf4h = profitFactor(w4h);
    const winRate4h = w4h.length > 0 ? wins4h / w4h.length : 0.5;
    const dd = maxDrawdown(w24h);
    const slippageUsdt = w1h.reduce((sum, outcome) => sum + Math.max(0, outcome.totalSlippage ?? 0), 0) / Math.max(1, w1h.length);
    const slipBps = avgSlippageBps(w1h.length > 0 ? w1h : w24h);

    const symbolProfile = input.engine.symbolProfile(symbol);
    const longKey = { symbol, positionSide: "LONG" as const, hourUtc, btcRegime };
    const shortKey = { symbol, positionSide: "SHORT" as const, hourUtc, btcRegime };
    const longSignal = input.engine.contextSignal(longKey);
    const shortSignal = input.engine.contextSignal(shortKey);
    const longOutcomes = w24h.filter((outcome) => outcome.positionSide === "LONG");
    const shortOutcomes = w24h.filter((outcome) => outcome.positionSide === "SHORT");
    const longScore = scoreSide(longOutcomes, longSignal.priorityScore);
    const shortScore = scoreSide(shortOutcomes, shortSignal.priorityScore);
    const sideBias = sideFromBias(longScore, shortScore);

    const candle = candleBySymbol.get(symbol);
    const currentMomentumScore = candle
      ? clamp(Math.max(candle.longScore, candle.shortScore) * 0.70 + clamp(Math.abs(candle.recentMovePct) / 2.5) * 0.30)
      : 0.5;
    const liquidityScore = candle
      ? clamp((candle.volumeRatio ?? 1) / 2.5)
      : 0.5;

    const recentPnlScore = clamp(0.5 + recentPnl / Math.max(5, input.config.marginPerTrade * 4));
    const recentProfitFactorScore = w4h.length < 3 ? 0.55 : clamp(pf4h / 2.5);
    const coachScoreAvg = clamp((longSignal.priorityScore + shortSignal.priorityScore + (symbolProfile?.priorityScore ?? 0.5)) / 3);
    const executionQualityScore = w1h.length === 0 ? 0.65 : clamp(1 - slipBps / 20);
    const validSignalRate = clamp((longSignal.priorityScore + shortSignal.priorityScore) / 2);
    const toxicContextScore = clamp(Math.max(longSignal.toxicityScore, shortSignal.toxicityScore, symbolProfile?.toxicityScore ?? 0));

    const drawdownPenalty = clamp(dd / Math.max(3, input.config.marginPerTrade * 4)) * 0.25;
    const slippagePenalty = clamp(slipBps / 18) * 0.20;
    const toxicContextPenalty = toxicContextScore >= 0.70 ? clamp((toxicContextScore - 0.60) / 0.40) * 0.22 : 0;

    const rotationScore = clamp(
      recentPnlScore * 0.25
      + recentProfitFactorScore * 0.20
      + coachScoreAvg * 0.20
      + executionQualityScore * 0.15
      + currentMomentumScore * 0.10
      + liquidityScore * 0.10
      - drawdownPenalty
      - slippagePenalty
      - toxicContextPenalty,
    );

    const state = classifyState({
      score: rotationScore,
      pf4h,
      samples4h: w4h.length,
      samples24h: w24h.length,
      executionQuality: executionQualityScore,
      momentum: currentMomentumScore,
      drawdownPenalty,
      slippagePenalty,
      toxicPenalty: toxicContextPenalty,
      recentPnl,
    });
    const currentOpenPositions = Object.values(input.openCountsBySymbol?.get(symbol) ?? { LONG: 0, SHORT: 0 })
      .reduce((sum, value) => sum + value, 0);
    const maxPositions = maxPositionsForState(state, input.config);
    const recommendedPosition: SymbolRotationRank["recommendedPosition"] =
      state === "HOT" ? "increase" :
      state === "ACTIVE" ? "normal" :
      state === "REDUCED" || state === "RECOVERY" ? "small" :
      "none";

    const withoutReason = {
      symbol,
      state,
      sideBias,
      longScore: round(longScore),
      shortScore: round(shortScore),
      rotationScore: round(rotationScore),
      maxPositions,
      currentOpenPositions,
      recommendedPosition,
      metrics: {
        recentPnlUsdt: round(recentPnl),
        pnl24hUsdt: round(pnl24h),
        winRate4h: round(winRate4h),
        profitFactor4h: round(Math.min(pf4h, 99), 3),
        coachScoreAvg: round(coachScoreAvg),
        executionQualityScore: round(executionQualityScore),
        currentMomentumScore: round(currentMomentumScore),
        liquidityScore: round(liquidityScore),
        validSignalRate: round(validSignalRate),
        drawdownUsdt: round(dd),
        avgSlippageUsdt: round(slippageUsdt),
        avgSlippageBps: round(slipBps, 2),
        toxicContextScore: round(toxicContextScore),
        samples4h: w4h.length,
        samples24h: w24h.length,
      },
    };

    return {
      ...withoutReason,
      reason: reasonFor(withoutReason),
    };
  });

  rawRanking.sort((a, b) => b.rotationScore - a.rotationScore);
  const allocatable = rawRanking.filter((rank) => rank.state !== "PAUSED" && rank.maxPositions > 0);
  const totalScore = allocatable.reduce((sum, rank) => sum + Math.max(0.05, rank.rotationScore), 0);
  const ranking = rawRanking.map((rank) => ({
    ...rank,
    allocationWeight: rank.state === "PAUSED" || totalScore <= 0
      ? 0
      : round(Math.max(0.05, rank.rotationScore) / totalScore),
  }));

  return {
    generatedAt: now,
    activeSymbols: ranking.filter((rank) => rank.state === "HOT" || rank.state === "ACTIVE").map((rank) => rank.symbol),
    reducedSymbols: ranking.filter((rank) => rank.state === "REDUCED" || rank.state === "RECOVERY").map((rank) => rank.symbol),
    pausedSymbols: ranking.filter((rank) => rank.state === "PAUSED").map((rank) => rank.symbol),
    hotSymbols: ranking.filter((rank) => rank.state === "HOT").map((rank) => rank.symbol),
    recoverySymbols: ranking.filter((rank) => rank.state === "RECOVERY").map((rank) => rank.symbol),
    ranking,
  };
}

export function rotationRankBySymbol(report: SymbolRotationReport): Map<string, SymbolRotationRank> {
  return new Map(report.ranking.map((rank) => [normalizeSymbol(rank.symbol), rank]));
}
