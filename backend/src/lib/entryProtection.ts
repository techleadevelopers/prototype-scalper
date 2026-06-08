import type { TradeOutcome } from "./adaptiveEngine";
import type { BotConfig } from "./botConfig";
import type { CandleEdge } from "./candleEdge";

export interface RecentPerformanceSummary {
  windowHours: number;
  trades: number;
  wins: number;
  losses: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  consecutiveLosses: number;
}

export function summarizeRecentPerformance(
  outcomes: TradeOutcome[],
  config: BotConfig,
  now = Date.now(),
): RecentPerformanceSummary {
  const since = now - config.recentEdgeWindowHours * 60 * 60 * 1000;
  const recent = outcomes
    .filter((outcome) => outcome.exitTime >= since)
    .sort((a, b) => a.exitTime - b.exitTime);
  const wins = recent.filter((outcome) => outcome.realizedPnl > 0);
  const losses = recent.filter((outcome) => outcome.realizedPnl <= 0);
  const grossProfit = wins.reduce((sum, outcome) => sum + outcome.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, outcome) => sum + outcome.realizedPnl, 0));

  let consecutiveLosses = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].realizedPnl > 0) break;
    consecutiveLosses += 1;
  }

  return {
    windowHours: config.recentEdgeWindowHours,
    trades: recent.length,
    wins: wins.length,
    losses: losses.length,
    netPnl: grossProfit - grossLoss,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    consecutiveLosses,
  };
}

export function recentPerformanceRejects(summary: RecentPerformanceSummary, config: BotConfig): string[] {
  const rejects: string[] = [];
  if (summary.consecutiveLosses >= config.recentEdgeMaxConsecutiveLosses) {
    rejects.push(
      `RECENT_LOSS_STREAK_REJECT: ${summary.consecutiveLosses} consecutive losses in ${summary.windowHours}h`,
    );
  }
  if (
    summary.trades >= config.recentEdgeMinTrades
    && summary.netPnl < 0
    && summary.profitFactor < config.recentEdgeMinProfitFactor
  ) {
    rejects.push(
      `RECENT_EDGE_REJECT: ${summary.windowHours}h PnL ${summary.netPnl.toFixed(4)}, PF ${summary.profitFactor.toFixed(2)}`,
    );
  }
  return rejects;
}

export function candleConfirmationRejects(
  candle: CandleEdge,
  positionSide: "LONG" | "SHORT",
  config: BotConfig,
): string[] {
  if (candle.error || candle.candleCount < 10) {
    return [`CANDLE_DATA_REJECT: ${candle.error ?? `only ${candle.candleCount} candles`}`];
  }
  if (!candle.candleIsComplete) {
    return ["CANDLE_INCOMPLETE_REJECT: latest feature candle is unfinished"];
  }
  if ((candle.freshnessMs ?? Number.POSITIVE_INFINITY) > 10 * 60_000) {
    return [`CANDLE_STALE_REJECT: freshness ${candle.freshnessMs ?? "unknown"}ms`];
  }
  if ((candle.missingCandleCount ?? 0) > 0) {
    return [`CANDLE_GAP_REJECT: ${candle.missingCandleCount} missing interval(s)`];
  }

  const sideScore = positionSide === "LONG" ? candle.longScore : candle.shortScore;
  const oppositeScore = positionSide === "LONG" ? candle.shortScore : candle.longScore;
  const rejects: string[] = [];

  if (candle.suggestedSide !== positionSide) {
    rejects.push(`CANDLE_DIRECTION_REJECT: 5m suggests ${candle.suggestedSide}, entry is ${positionSide}`);
  }
  if (sideScore < config.candleMinScore) {
    rejects.push(`CANDLE_SCORE_REJECT: ${sideScore.toFixed(3)} < ${config.candleMinScore.toFixed(3)}`);
  }
  if (sideScore - oppositeScore < config.candleMinSeparation) {
    rejects.push(
      `CANDLE_CHOP_REJECT: score separation ${(sideScore - oppositeScore).toFixed(3)} < ${config.candleMinSeparation.toFixed(3)}`,
    );
  }
  if (candle.emaCross === "FLAT" && candle.volumeRatio < 1.1) {
    rejects.push(`CANDLE_RANGE_REJECT: EMA flat with volume ratio ${candle.volumeRatio.toFixed(2)}`);
  }

  return rejects;
}

function pricePrecision(referencePrice: number | string): number {
  const raw = String(referencePrice);
  const decimals = raw.includes(".") ? raw.split(".")[1].replace(/0+$/, "").length : 0;
  return Math.min(8, Math.max(2, decimals));
}

export function buildAttachedProtection(
  referencePrice: number | string,
  positionSide: "LONG" | "SHORT",
  config: BotConfig,
): { stopLoss: string; takeProfit: string; stopPrice: number; takeProfitPrice: number } | null {
  const price = Number(referencePrice);
  if (!config.attachProtectionOrders || !Number.isFinite(price) || price <= 0) return null;

  const precision = pricePrecision(referencePrice);
  const tpMove = config.takeProfitPct / 100;
  const slMove = config.stopLossPct / 100;
  const takeProfitPrice = Number((
    positionSide === "LONG" ? price * (1 + tpMove) : price * (1 - tpMove)
  ).toFixed(precision));
  const stopPrice = Number((
    positionSide === "LONG" ? price * (1 - slMove) : price * (1 + slMove)
  ).toFixed(precision));

  return {
    stopPrice,
    takeProfitPrice,
    stopLoss: JSON.stringify({
      type: "STOP_MARKET",
      stopPrice,
      workingType: "MARK_PRICE",
      stopGuaranteed: false,
    }),
    takeProfit: JSON.stringify({
      type: "TAKE_PROFIT_MARKET",
      stopPrice: takeProfitPrice,
      workingType: "MARK_PRICE",
      stopGuaranteed: false,
    }),
  };
}
