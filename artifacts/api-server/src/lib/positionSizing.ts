import type { BtcRegime, PositionSide, TradeOutcome } from "./adaptiveEngine";
import type { BotConfig } from "./botConfig";
import type { SymbolRotationRank, SymbolRotationState } from "./symbolRotation";

export type PositionRiskTier = "MICRO" | "SCOUT" | "BASE" | "BOOST" | "AGGRESSIVE" | "MAX_SNIPER";

export interface PositionSizingConfig {
  enabled: boolean;
  minMargin: number;
  baseRiskPct: number;
  maxRiskPctPerTrade: number;
  maxTotalRiskPct: number;
  maxSymbolRiskPct: number;
  maxConcurrentPositions: number;
  maxMarginUtilization: number;
  demoLearningAggressive: boolean;
}

export interface PositionSizingOpenPosition {
  symbol: string;
  positionSide?: PositionSide;
  marginUsed: number;
  leverage: number;
}

export interface PositionSizingInput {
  symbol: string;
  positionSide: PositionSide;
  accountEquity: number;
  availableMargin: number;
  aggressiveScore: number;
  calibratedScore?: number;
  coachRank?: number;
  rotationState?: SymbolRotationState;
  aggressionState?: "DEFENSIVE" | "NORMAL" | "AGGRESSIVE" | "SNIPER";
  recentPnl?: number;
  recentWinRate?: number;
  profitFactor?: number;
  drawdown?: number;
  executionSlippageBps?: number;
  campaignDepth?: number;
  campaignPnl?: number;
  previousEntryMargin?: number;
  currentOpenPositions?: PositionSizingOpenPosition[];
  symbolConcentration?: number;
  sideContextWinRate?: number;
  sideContextProfitFactor?: number;
  experimentArm?: string;
  dataQualityDegraded?: boolean;
  exitPreservingProfit?: boolean;
  baseMarginFallback?: number;
  leverageFallback?: number;
  stopLossPct?: number;
  config?: Partial<PositionSizingConfig>;
}

export interface PositionSizingDecision {
  recommendedMargin: number;
  recommendedLeverage: number;
  riskTier: PositionRiskTier | "NO_TRADE";
  sizeMultiplier: number;
  reason: string;
  maxLossIfStop: number;
  notional: number;
  baseMargin: number;
  approved: boolean;
  gateRejects: string[];
  diagnostics: {
    totalRiskPct: number;
    symbolRiskPct: number;
    marginUtilizationAfter: number;
    recentWinRate: number;
    profitFactor: number;
    drawdownPct: number;
    executionSlippageBps: number;
  };
}

const TIER_MULTIPLIER: Record<PositionRiskTier, number> = {
  MICRO: 0.25,
  SCOUT: 0.5,
  BASE: 1.0,
  BOOST: 1.25,
  AGGRESSIVE: 1.5,
  MAX_SNIPER: 2.0,
};

function envNum(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safePct(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.max(0, value!);
}

export function getPositionSizingConfig(botConfig?: BotConfig): PositionSizingConfig {
  const aggressiveMode = botConfig?.activeMode === "aggressive";
  const demoLearning = String(process.env["EXPERIMENT_ARM"] ?? "").toLowerCase().includes("demo_learning_aggressive");
  return {
    enabled: envBool("POSITION_SIZING_ENABLED", true),
    minMargin: envNum("MIN_MARGIN", Math.max(0.1, botConfig?.marginPerTrade ?? 5)),
    baseRiskPct: envNum("BASE_RISK_PCT", 0.005),
    maxRiskPctPerTrade: envNum("MAX_RISK_PCT_PER_TRADE", aggressiveMode || demoLearning ? 0.025 : 0.015),
    maxTotalRiskPct: envNum("MAX_TOTAL_RISK_PCT", aggressiveMode || demoLearning ? 0.12 : 0.08),
    maxSymbolRiskPct: envNum("MAX_SYMBOL_RISK_PCT", aggressiveMode || demoLearning ? 0.05 : 0.03),
    maxConcurrentPositions: botConfig?.maxConcurrentPositions ?? envNum("SCALP_MAX_CONCURRENT_POSITIONS", 10),
    maxMarginUtilization: botConfig?.maxMarginUtilization ?? envNum("SCALP_MAX_MARGIN_UTILIZATION", 0.5),
    demoLearningAggressive: aggressiveMode || demoLearning,
  };
}

function initialTier(score: number, rotationState?: SymbolRotationState, slippageBps = 0): PositionRiskTier | "NO_TRADE" {
  if (score < 0.55) return "NO_TRADE";
  if (score >= 0.85 && rotationState === "HOT" && slippageBps <= 3) return "MAX_SNIPER";
  if (score >= 0.78) return rotationState === "REDUCED" ? "BOOST" : "AGGRESSIVE";
  if (score >= 0.68) return rotationState === "REDUCED" ? "BASE" : "BOOST";
  return score >= 0.62 ? "BASE" : "SCOUT";
}

function shiftTier(tier: PositionRiskTier, delta: number): PositionRiskTier {
  const tiers: PositionRiskTier[] = ["MICRO", "SCOUT", "BASE", "BOOST", "AGGRESSIVE", "MAX_SNIPER"];
  return tiers[clamp(tiers.indexOf(tier) + delta, 0, tiers.length - 1)];
}

export function calculatePositionSizing(input: PositionSizingInput): PositionSizingDecision {
  const cfg = { ...getPositionSizingConfig(), ...(input.config ?? {}) };
  const equity = Math.max(0, input.accountEquity || 0);
  const leverage = Math.max(1, Math.round(input.leverageFallback ?? 14));
  const stopLossPct = Math.max(0.01, input.stopLossPct ?? 0.1);
  const baseMargin = Math.max(cfg.minMargin, equity * cfg.baseRiskPct, input.baseMarginFallback ?? 0);
  const slippageBps = safePct(input.executionSlippageBps);
  const openPositions = input.currentOpenPositions ?? [];
  const gateRejects: string[] = [];
  const reasons: string[] = [];
  const sizingScore = clamp(input.calibratedScore ?? input.aggressiveScore, 0, 1);

  if (!cfg.enabled) {
    const margin = Math.max(cfg.minMargin, input.baseMarginFallback ?? baseMargin);
    return buildDecision("BASE", 1, margin, leverage, stopLossPct, baseMargin, true, ["fixed_sizing_disabled"], [], equity, openPositions, input);
  }

  let tier = initialTier(sizingScore, input.rotationState, slippageBps);
  if (tier === "NO_TRADE") {
    return buildDecision("NO_TRADE", 0, 0, leverage, stopLossPct, baseMargin, false, ["score_below_trade_floor"], ["SCORE_REJECT: calibratedScore < 0.55"], equity, openPositions, input);
  }
  if (input.calibratedScore !== undefined && Math.abs(input.calibratedScore - input.aggressiveScore) >= 0.03) {
    reasons.push("score_calibrated");
  }

  if (input.rotationState === "HOT") reasons.push("hot_symbol");
  if (input.rotationState === "REDUCED" || input.rotationState === "RECOVERY") {
    tier = shiftTier(tier, -2);
    reasons.push("symbol_reduced");
  }
  if (input.aggressionState === "DEFENSIVE") {
    tier = shiftTier(tier, -2);
    reasons.push("defensive_state");
  }
  if ((input.profitFactor ?? 1) >= 1.6 && (input.recentWinRate ?? 0.5) >= 0.56) {
    tier = shiftTier(tier, 1);
    reasons.push("recent_edge_good");
  }
  if (input.exitPreservingProfit) {
    tier = shiftTier(tier, 1);
    reasons.push("exit_preserving_profit");
  }
  if ((input.drawdown ?? 0) > equity * 0.02 || (input.drawdown ?? 0) > 2) {
    tier = shiftTier(tier, -1);
    reasons.push("drawdown_elevated");
  }
  if (slippageBps > 6) {
    tier = shiftTier(tier, -1);
    reasons.push("slippage_high");
  }
  if (input.dataQualityDegraded) {
    tier = shiftTier(tier, -2);
    reasons.push("data_quality_degraded");
  }
  if ((input.sideContextWinRate ?? 0.5) < 0.45 && (input.sideContextProfitFactor ?? 1) < 1) {
    tier = shiftTier(tier, -1);
    reasons.push("side_context_weak");
  }

  const depth = Math.max(1, Math.floor(input.campaignDepth ?? 1));
  if (depth === 2) {
    tier = shiftTier(tier, -1);
    reasons.push("depth_2_no_pyramid");
  } else if (depth >= 3 && (input.campaignPnl ?? 0) <= 0) {
    tier = shiftTier(tier, -2);
    reasons.push("deep_negative_campaign");
  }

  let multiplier = TIER_MULTIPLIER[tier];
  let margin = baseMargin * multiplier;
  const previous = input.previousEntryMargin;
  if (depth > 1 && previous !== undefined && (input.campaignPnl ?? 0) <= 0 && margin > previous) {
    margin = previous;
    multiplier = margin / Math.max(baseMargin, 0.000001);
    tier = shiftTier(tier, -1);
    reasons.push("martingale_guard");
  }
  if (depth > 1 && previous !== undefined && (input.campaignPnl ?? 0) > 0 && sizingScore < 0.78 && margin > previous) {
    margin = previous;
    multiplier = margin / Math.max(baseMargin, 0.000001);
    reasons.push("stack_score_not_higher");
  }

  const maxPerTradeMargin = equity > 0
    ? (equity * cfg.maxRiskPctPerTrade) / (leverage * (stopLossPct / 100))
    : margin;
  if (margin > maxPerTradeMargin) {
    margin = maxPerTradeMargin;
    multiplier = margin / Math.max(baseMargin, 0.000001);
    reasons.push("per_trade_risk_cap");
  }

  if (margin > input.availableMargin) {
    margin = Math.max(0, input.availableMargin);
    multiplier = margin / Math.max(baseMargin, 0.000001);
    reasons.push("available_margin_cap");
  }

  const risk = margin * leverage * (stopLossPct / 100);
  const openRisk = openPositions.reduce((sum, pos) => sum + pos.marginUsed * pos.leverage * (stopLossPct / 100), 0);
  const symbolRisk = openPositions
    .filter((pos) => pos.symbol.toUpperCase() === input.symbol.toUpperCase())
    .reduce((sum, pos) => sum + pos.marginUsed * pos.leverage * (stopLossPct / 100), 0) + risk;
  const usedMargin = openPositions.reduce((sum, pos) => sum + pos.marginUsed, 0);

  const totalRiskPct = equity > 0 ? (openRisk + risk) / equity : 0;
  const symbolRiskPct = equity > 0 ? symbolRisk / equity : 0;
  const marginUtilizationAfter = equity > 0 ? (usedMargin + margin) / equity : 0;

  if (openPositions.length >= cfg.maxConcurrentPositions) gateRejects.push("SIZE_CAPITAL_REJECT: max concurrent positions");
  if (totalRiskPct > cfg.maxTotalRiskPct) gateRejects.push("SIZE_TOTAL_RISK_REJECT");
  if (symbolRiskPct > cfg.maxSymbolRiskPct) gateRejects.push("SIZE_SYMBOL_RISK_REJECT");
  if (marginUtilizationAfter > cfg.maxMarginUtilization) gateRejects.push("SIZE_MARGIN_UTILIZATION_REJECT");
  if (margin <= 0) gateRejects.push("SIZE_MARGIN_REJECT");

  if (reasons.length === 0) reasons.push(`${tier.toLowerCase()}_score_band`);
  return buildDecision(tier, multiplier, margin, leverage, stopLossPct, baseMargin, gateRejects.length === 0, reasons, gateRejects, equity, openPositions, input);
}

function buildDecision(
  tier: PositionRiskTier | "NO_TRADE",
  multiplier: number,
  margin: number,
  leverage: number,
  stopLossPct: number,
  baseMargin: number,
  approved: boolean,
  reasons: string[],
  gateRejects: string[],
  equity: number,
  openPositions: PositionSizingOpenPosition[],
  input: PositionSizingInput,
): PositionSizingDecision {
  const maxLossIfStop = margin * leverage * (stopLossPct / 100);
  const symbol = input.symbol.toUpperCase();
  const openRisk = openPositions.reduce((sum, pos) => sum + pos.marginUsed * pos.leverage * (stopLossPct / 100), 0);
  const symbolRisk = openPositions
    .filter((pos) => pos.symbol.toUpperCase() === symbol)
    .reduce((sum, pos) => sum + pos.marginUsed * pos.leverage * (stopLossPct / 100), 0) + maxLossIfStop;
  const usedMargin = openPositions.reduce((sum, pos) => sum + pos.marginUsed, 0);
  return {
    recommendedMargin: round(Math.max(0, margin), 4),
    recommendedLeverage: leverage,
    riskTier: tier,
    sizeMultiplier: round(Math.max(0, multiplier), 4),
    reason: reasons.join("_"),
    maxLossIfStop: round(maxLossIfStop, 4),
    notional: round(margin * leverage, 4),
    baseMargin: round(baseMargin, 4),
    approved,
    gateRejects,
    diagnostics: {
      totalRiskPct: round(equity > 0 ? (openRisk + maxLossIfStop) / equity : 0, 6),
      symbolRiskPct: round(equity > 0 ? symbolRisk / equity : 0, 6),
      marginUtilizationAfter: round(equity > 0 ? (usedMargin + margin) / equity : 0, 6),
      recentWinRate: round(input.recentWinRate ?? 0.5, 4),
      profitFactor: round(input.profitFactor ?? 1, 4),
      drawdownPct: round(equity > 0 ? (input.drawdown ?? 0) / equity : 0, 6),
      executionSlippageBps: round(input.executionSlippageBps ?? 0, 4),
    },
  };
}

export function summarizeSizingStatus(input: {
  equity: number;
  outcomes: TradeOutcome[];
  openPositions: PositionSizingOpenPosition[];
  config: BotConfig;
  btcRegime?: BtcRegime;
}): Record<string, unknown> {
  const cfg = getPositionSizingConfig(input.config);
  const baseMargin = Math.max(cfg.minMargin, input.equity * cfg.baseRiskPct, input.config.marginPerTrade);
  const byTier = new Map<string, { trades: number; wins: number; pnl: number; maxDrawdown: number; equityCurve: number[] }>();
  for (const outcome of input.outcomes) {
    const tier = outcome.riskTier ?? "UNSIZED";
    const row = byTier.get(tier) ?? { trades: 0, wins: 0, pnl: 0, maxDrawdown: 0, equityCurve: [] };
    row.trades += 1;
    row.wins += outcome.realizedPnl > 0 ? 1 : 0;
    row.pnl += outcome.realizedPnl;
    row.equityCurve.push(row.pnl);
    let peak = 0;
    row.maxDrawdown = Math.max(...row.equityCurve.map((value) => {
      peak = Math.max(peak, value);
      return peak - value;
    }), 0);
    byTier.set(tier, row);
  }
  const tierStats = Object.fromEntries([...byTier.entries()].map(([tier, row]) => [tier, {
    trades: row.trades,
    pnl: round(row.pnl, 4),
    winRate: row.trades > 0 ? round(row.wins / row.trades, 4) : 0,
    drawdown: round(row.maxDrawdown, 4),
  }]));
  const concentration = new Map<string, number>();
  for (const pos of input.openPositions) {
    concentration.set(pos.symbol.toUpperCase(), (concentration.get(pos.symbol.toUpperCase()) ?? 0) + pos.marginUsed * pos.leverage);
  }
  const largest = [...concentration.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  return {
    enabled: cfg.enabled,
    baseMargin: round(baseMargin, 4),
    equityUsed: round(input.equity, 4),
    sizeTierDistribution: Object.fromEntries([...byTier.entries()].map(([tier, row]) => [tier, row.trades])),
    pnlByRiskTier: Object.fromEntries([...byTier.entries()].map(([tier, row]) => [tier, round(row.pnl, 4)])),
    winRateByRiskTier: Object.fromEntries([...byTier.entries()].map(([tier, row]) => [tier, row.trades > 0 ? round(row.wins / row.trades, 4) : 0])),
    drawdownByRiskTier: Object.fromEntries([...byTier.entries()].map(([tier, row]) => [tier, round(row.maxDrawdown, 4)])),
    tierStats,
    largestSymbolConcentration: largest ? { symbol: largest[0], notional: round(largest[1], 4) } : null,
    compoundingCurve: input.outcomes
      .slice(-200)
      .reduce<Array<{ trade: number; equity: number; baseMargin: number }>>((rows, outcome, index) => {
        const prev = rows[index - 1]?.equity ?? input.equity;
        const equity = prev + outcome.realizedPnl;
        rows.push({ trade: index + 1, equity: round(equity, 4), baseMargin: round(Math.max(cfg.minMargin, equity * cfg.baseRiskPct), 4) });
        return rows;
      }, []),
    recommendedConfig: cfg,
  };
}

export function recentSizingStats(outcomes: TradeOutcome[], symbol: string, side: PositionSide, now = Date.now()): {
  recentPnl: number;
  recentWinRate: number;
  profitFactor: number;
  drawdown: number;
  executionSlippageBps: number;
  sideContextWinRate: number;
  sideContextProfitFactor: number;
} {
  const since = now - 4 * 60 * 60_000;
  const recent = outcomes.filter((outcome) => (outcome.exitTime ?? outcome.entryTime) >= since);
  const scoped = recent.filter((outcome) => outcome.symbol.toUpperCase() === symbol.toUpperCase() && outcome.positionSide === side);
  const calc = scoped.length > 0 ? scoped : recent;
  const wins = calc.filter((outcome) => outcome.realizedPnl > 0);
  const losses = calc.filter((outcome) => outcome.realizedPnl <= 0);
  const grossWin = wins.reduce((sum, outcome) => sum + outcome.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, outcome) => sum + outcome.realizedPnl, 0));
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const outcome of [...calc].sort((a, b) => (a.exitTime ?? a.entryTime) - (b.exitTime ?? b.entryTime))) {
    cumulative += outcome.realizedPnl;
    peak = Math.max(peak, cumulative);
    drawdown = Math.max(drawdown, peak - cumulative);
  }
  return {
    recentPnl: round(calc.reduce((sum, outcome) => sum + outcome.realizedPnl, 0), 4),
    recentWinRate: calc.length > 0 ? wins.length / calc.length : 0.5,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 1,
    drawdown,
    executionSlippageBps: calc.length > 0
      ? calc.reduce((sum, outcome) => sum + (outcome.slippagePctNotional ?? 0) * 10_000, 0) / calc.length
      : 0,
    sideContextWinRate: scoped.length > 0 ? scoped.filter((outcome) => outcome.realizedPnl > 0).length / scoped.length : 0.5,
    sideContextProfitFactor: scoped.length > 0
      ? (() => {
          const sw = scoped.reduce((sum, outcome) => sum + Math.max(0, outcome.realizedPnl), 0);
          const sl = Math.abs(scoped.reduce((sum, outcome) => sum + Math.min(0, outcome.realizedPnl), 0));
          return sl > 0 ? sw / sl : sw > 0 ? 999 : 1;
        })()
      : 1,
  };
}
