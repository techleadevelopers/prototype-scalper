import type { BotConfig } from "./botConfig";
import { z } from "zod";

// ========== CONSTANTS ==========

const DEFAULT_TAKER_FEE_RATE = 0.0005;
const FEE_DRAG_BUFFER_MULTIPLIER = 1.5;
const DEFAULT_MAX_CORRELATED_BULK_ORDERS = 3;
const DEFAULT_MAX_POSITION_EXPOSURE_PCT = 0.25; // 25% da margem disponível
const DEFAULT_MAX_SYMBOL_CONCENTRATION_PCT = 0.40; // 40% em um único símbolo

// ========== SCHEMAS ==========

export const ExecutionCostEstimateSchema = z.object({
  notional: z.number(),
  roundTripFee: z.number(),
  slippageCost: z.number(),
  spreadCost: z.number(),
  fundingCost: z.number(),
  latencyDragCost: z.number(),
  partialFillDragCost: z.number(),
  protectionFailureRiskCost: z.number(),
  closeFailureRiskCost: z.number(),
  totalCost: z.number(),
  feeDragPctOfMargin: z.number(),
  minExpectedPnl: z.number(),
  expectedTpProfit: z.number().optional(),
  grossEv: z.number().optional(),
  netEv: z.number().optional(),
  breakEvenWinRate: z.number().optional(),
  expectedWinRate: z.number().optional(),
  effectiveSlippageBps: z.number().optional(),
  effectiveSlippageBpsPerSide: z.number().optional(),
  spreadBpsRoundTrip: z.number().optional(),
  totalCostPct: z.number().optional(),
  breakevenMovePct: z.number().optional(),
  recommendedMinTpPct: z.number().optional(),
});
export type ExecutionCostEstimate = z.infer<typeof ExecutionCostEstimateSchema>;

export const CorrelationMatrixSchema = z.record(z.string(), z.record(z.string(), z.number()));
export type CorrelationMatrix = z.infer<typeof CorrelationMatrixSchema>;

export const ExposureLimitsSchema = z.object({
  maxPositionExposurePct: z.number(),
  maxSymbolConcentrationPct: z.number(),
  maxNotionalExposure: z.number(),
  currentNotionalExposure: z.number(),
  remainingCapacity: z.number(),
  isOverExposed: z.boolean(),
  symbolExposures: z.record(z.string(), z.number()),
});
export type ExposureLimits = z.infer<typeof ExposureLimitsSchema>;

export const OrderRiskAssessmentSchema = z.object({
  isAllowed: z.boolean(),
  rejectReasons: z.array(z.string()),
  adjustedMargin: z.number(),
  adjustedLeverage: z.number(),
  warningLevel: z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  correlationPenalty: z.number(),
});
export type OrderRiskAssessment = z.infer<typeof OrderRiskAssessmentSchema>;

// ========== CORRELATION MATRIX ==========

// Matriz de correlação estática entre pares (valores empíricos)
const STATIC_CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  "BTC-USDT": {
    "ETH-USDT": 0.82,
    "SOL-USDT": 0.75,
    "BNB-USDT": 0.78,
    "NEAR-USDT": 0.68,
  },
  "ETH-USDT": {
    "BTC-USDT": 0.82,
    "SOL-USDT": 0.85,
    "BNB-USDT": 0.80,
    "NEAR-USDT": 0.72,
  },
  "SOL-USDT": {
    "BTC-USDT": 0.75,
    "ETH-USDT": 0.85,
    "BNB-USDT": 0.70,
    "NEAR-USDT": 0.78,
  },
};

// Cache para correlações dinâmicas
let _dynamicCorrelationMatrix: CorrelationMatrix = {};
let _lastCorrelationUpdate = 0;
const CORRELATION_UPDATE_INTERVAL_MS = 3600000; // 1 hora

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function takerFeeRate(): number {
  return envNum("SCALP_TAKER_FEE_RATE", DEFAULT_TAKER_FEE_RATE);
}

export function feeDragBufferMultiplier(): number {
  return envNum("SCALP_FEE_DRAG_BUFFER_MULTIPLIER", FEE_DRAG_BUFFER_MULTIPLIER);
}

export function maxCorrelatedBulkOrders(): number {
  return Math.max(1, Math.floor(envNum("SCALP_MAX_CORRELATED_BULK_ORDERS", DEFAULT_MAX_CORRELATED_BULK_ORDERS)));
}

export function maxPositionExposurePct(): number {
  return envNum("SCALP_MAX_POSITION_EXPOSURE_PCT", DEFAULT_MAX_POSITION_EXPOSURE_PCT);
}

export function maxSymbolConcentrationPct(): number {
  return envNum("SCALP_MAX_SYMBOL_CONCENTRATION_PCT", DEFAULT_MAX_SYMBOL_CONCENTRATION_PCT);
}

// ========== ESTIMATIVA DE SLIPPAGE DINÂMICO ==========

export interface SlippageContext {
  volumeRatio: number;      // volume atual / média (1 = normal)
  spreadBps: number;        // spread atual em bps
  atrPct: number;           // ATR percentual
  orderSizeUsdt: number;    // tamanho da ordem em USDT
  marketDepth: number;      // profundidade do book (0-1)
  fundingCostPct?: number;
  latencyDragBps?: number;
  partialFillDragBps?: number;
  protectionFailureRiskBps?: number;
  closeFailureRiskBps?: number;
}

export function estimateSlippageBps(context: SlippageContext): number {
  let slippage = 2.0; // baseline 2 bps

  // Volume baixo = maior slippage
  if (context.volumeRatio < 0.5) slippage *= 2.5;
  else if (context.volumeRatio < 0.8) slippage *= 1.5;
  else if (context.volumeRatio > 2.0) slippage *= 0.7;

  // Spread alto = maior slippage
  if (context.spreadBps > 10) slippage += context.spreadBps * 0.5;
  else if (context.spreadBps > 5) slippage += context.spreadBps * 0.3;

  // Volatilidade alta = maior slippage
  if (context.atrPct > 1.5) slippage *= 1.4;
  else if (context.atrPct > 0.8) slippage *= 1.1;

  // Tamanho da ordem vs profundidade
  const sizeFactor = Math.min(1.0, context.orderSizeUsdt / 10000);
  if (sizeFactor > 0.5) slippage *= (1 + sizeFactor * 0.5);

  // Profundidade do book (quanto menor, maior slippage)
  const depthFactor = Math.max(0.3, context.marketDepth);
  slippage /= depthFactor;

  return Math.max(0.5, Math.min(50, slippage));
}

// ========== ESTIMATIVA DE CUSTOS ==========

export function estimateExecutionCosts(
  marginUsed: number,
  leverage: number,
  feeRate = takerFeeRate(),
  bufferMultiplier = feeDragBufferMultiplier(),
  slippageContext?: SlippageContext,
  options?: {
    takeProfitPct?: number;
    stopLossPct?: number;
    grossEv?: number;
    expectedWinRate?: number;
    slippageBpsPerSide?: number;
    fundingCostPct?: number;
    minEdgeOverCostPct?: number;
  },
): ExecutionCostEstimate {
  const safeMargin = Math.max(0.001, marginUsed);
  const safeLeverage = Math.max(1, leverage);
  const notional = safeMargin * safeLeverage;

  const roundTripFee = notional * feeRate * 2;

  // Slippage estimado
  const slippageBpsPerSide = Math.max(
    0,
    options?.slippageBpsPerSide ?? (slippageContext ? estimateSlippageBps(slippageContext) : 2.0),
  );
  const roundTripSlippageBps = slippageBpsPerSide * 2;
  const slippageCost = notional * (roundTripSlippageBps / 10_000);
  const spreadBpsRoundTrip = Math.max(0, slippageContext?.spreadBps ?? 0) * 2;
  const spreadCost = notional * (spreadBpsRoundTrip / 10_000);
  const fundingCostPct = Math.max(0, options?.fundingCostPct ?? slippageContext?.fundingCostPct ?? 0);
  const fundingCost = notional * (fundingCostPct / 100);
  const latencyDragCost = notional * (Math.max(0, slippageContext?.latencyDragBps ?? 0) / 10_000);
  const partialFillDragCost = notional * (Math.max(0, slippageContext?.partialFillDragBps ?? 0) / 10_000);
  const protectionFailureRiskCost = notional * (Math.max(0, slippageContext?.protectionFailureRiskBps ?? 0) / 10_000);
  const closeFailureRiskCost = notional * (Math.max(0, slippageContext?.closeFailureRiskBps ?? 0) / 10_000);

  const totalCost = roundTripFee
    + slippageCost
    + spreadCost
    + fundingCost
    + latencyDragCost
    + partialFillDragCost
    + protectionFailureRiskCost
    + closeFailureRiskCost;
  const totalCostPct = (totalCost / safeMargin) * 100;
  const feeDragPctOfMargin = safeMargin > 0 ? (roundTripFee / safeMargin) * 100 : 0;

  // Ponto de breakeven: movimento necessário para cobrir custos
  const breakevenMovePct = notional > 0 ? (totalCost / notional) * 100 : 0;
  const minEdgeOverCostPct = Math.max(0, options?.minEdgeOverCostPct ?? 0);
  const recommendedMinTpPct = breakevenMovePct + minEdgeOverCostPct;
  const expectedTpProfit = options?.takeProfitPct !== undefined
    ? notional * (Math.max(0, options.takeProfitPct) / 100)
    : undefined;
  const grossEv = options?.grossEv;
  const netEv = grossEv !== undefined ? grossEv - totalCost : undefined;
  const stopLossPct = Math.max(0, options?.stopLossPct ?? 0);
  const lossAtStop = stopLossPct > 0 ? notional * (stopLossPct / 100) + totalCost : undefined;
  const breakEvenWinRate = expectedTpProfit !== undefined && lossAtStop !== undefined
    ? lossAtStop / Math.max(0.000001, expectedTpProfit + lossAtStop)
    : undefined;

  return {
    notional,
    roundTripFee,
    slippageCost,
    spreadCost,
    fundingCost,
    latencyDragCost,
    partialFillDragCost,
    protectionFailureRiskCost,
    closeFailureRiskCost,
    totalCost,
    feeDragPctOfMargin,
    minExpectedPnl: totalCost * bufferMultiplier,
    expectedTpProfit,
    grossEv,
    netEv,
    breakEvenWinRate,
    expectedWinRate: options?.expectedWinRate,
    effectiveSlippageBps: roundTripSlippageBps,
    effectiveSlippageBpsPerSide: slippageBpsPerSide,
    spreadBpsRoundTrip,
    totalCostPct: totalCostPct,
    breakevenMovePct,
    recommendedMinTpPct,
  };
}

export function estimateOrderMargin(config: BotConfig, quantity?: number, price?: number | null): number {
  if (quantity && quantity > 0 && price && price > 0) {
    return (quantity * price) / config.leverage;
  }
  return config.marginPerTrade;
}

export function feeDragRejectReason(
  currentEv: number | undefined,
  marginUsed: number,
  config: BotConfig,
  slippageContext?: SlippageContext
): string | null {
  if (currentEv === undefined) return null;

  const costs = estimateExecutionCosts(
    marginUsed,
    config.leverage,
    config.takerFeeBps / 10_000,
    undefined,
    slippageContext,
    {
      takeProfitPct: config.takeProfitPct,
      stopLossPct: config.stopLossPct,
      grossEv: currentEv,
      slippageBpsPerSide: config.slippageBpsPerSide,
      fundingCostPct: config.estimatedFundingCostPct,
      minEdgeOverCostPct: config.minEdgeOverCostPct,
    },
  );

  if ((costs.netEv ?? 0) <= 0) {
    return `NET_EV_REJECT: gross EV ${currentEv.toFixed(4)} - total cost ${costs.totalCost.toFixed(4)} = ${(costs.netEv ?? 0).toFixed(4)}`;
  }

  if (costs.expectedTpProfit !== undefined && costs.expectedTpProfit <= costs.totalCost) {
    return `TP_COST_REJECT: expected TP ${costs.expectedTpProfit.toFixed(4)} <= round-trip cost ${costs.totalCost.toFixed(4)} (min TP ${costs.recommendedMinTpPct?.toFixed(3)}%)`;
  }

  if (currentEv >= costs.minExpectedPnl) return null;

  return `FEE_DRAG_REJECT: EV ${currentEv.toFixed(4)} < cost buffer ${costs.minExpectedPnl.toFixed(4)} (${costs.feeDragPctOfMargin.toFixed(2)}% margin fee drag, slippage ${costs.effectiveSlippageBps?.toFixed(1)}bps RT)`;
}

// ========== ANÁLISE DE CORRELAÇÃO ==========

export function getCorrelation(symbolA: string, symbolB: string): number {
  // Verifica matriz dinâmica primeiro
  if (_dynamicCorrelationMatrix[symbolA]?.[symbolB]) {
    return _dynamicCorrelationMatrix[symbolA][symbolB];
  }
  if (_dynamicCorrelationMatrix[symbolB]?.[symbolA]) {
    return _dynamicCorrelationMatrix[symbolB][symbolA];
  }

  // Fallback para matriz estática
  if (STATIC_CORRELATION_MATRIX[symbolA]?.[symbolB]) {
    return STATIC_CORRELATION_MATRIX[symbolA][symbolB];
  }
  if (STATIC_CORRELATION_MATRIX[symbolB]?.[symbolA]) {
    return STATIC_CORRELATION_MATRIX[symbolB][symbolA];
  }

  // Correlação padrão para pares não mapeados (0.5 = média)
  return 0.5;
}

export function updateCorrelationMatrix(correlations: CorrelationMatrix): void {
  _dynamicCorrelationMatrix = correlations;
  _lastCorrelationUpdate = Date.now();
}

export function getCorrelationMatrix(): CorrelationMatrix {
  return { ..._dynamicCorrelationMatrix };
}

export function getCorrelationAge(): number {
  return Date.now() - _lastCorrelationUpdate;
}

// ========== ANÁLISE DE EXPOSIÇÃO ==========

export function calculateExposureLimits(
  currentPositions: Array<{ symbol: string; notional: number; marginUsed: number }>,
  totalEquity: number,
  maxExposurePct = maxPositionExposurePct(),
  maxConcentrationPct = maxSymbolConcentrationPct(),
): ExposureLimits {
  const maxNotionalExposure = totalEquity * maxExposurePct;
  const currentNotionalExposure = currentPositions.reduce((sum, p) => sum + p.notional, 0);
  const remainingCapacity = Math.max(0, maxNotionalExposure - currentNotionalExposure);
  const isOverExposed = currentNotionalExposure > maxNotionalExposure;

  const symbolExposures: Record<string, number> = {};
  for (const pos of currentPositions) {
    const concentrationPct = pos.notional / maxNotionalExposure;
    symbolExposures[pos.symbol] = concentrationPct;
  }

  return {
    maxPositionExposurePct: maxExposurePct,
    maxSymbolConcentrationPct: maxConcentrationPct,
    maxNotionalExposure,
    currentNotionalExposure,
    remainingCapacity,
    isOverExposed,
    symbolExposures,
  };
}

// ========== AVALIAÇÃO DE RISCO DE ORDEM ==========

export interface OrderRiskContext {
  symbol: string;
  marginUsed: number;
  leverage: number;
  currentEv?: number;
  currentPositions: Array<{ symbol: string; notional: number; marginUsed: number }>;
  totalEquity: number;
  correlationMatrix?: CorrelationMatrix;
  slippageContext?: SlippageContext;
  config: BotConfig;
}

export function assessOrderRisk(context: OrderRiskContext): OrderRiskAssessment {
  const rejectReasons: string[] = [];
  let warningLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "NONE";
  let adjustedMargin = context.marginUsed;
  let adjustedLeverage = context.leverage;

  // 1. Verifica fee drag
  const feeReason = feeDragRejectReason(
    context.currentEv,
    context.marginUsed,
    context.config,
    context.slippageContext
  );
  if (feeReason) rejectReasons.push(feeReason);

  // 2. Verifica exposição total
  const exposure = calculateExposureLimits(
    context.currentPositions,
    context.totalEquity
  );

  if (exposure.isOverExposed) {
    rejectReasons.push(`OVER_EXPOSURE: notional ${exposure.currentNotionalExposure.toFixed(0)} > limit ${exposure.maxNotionalExposure.toFixed(0)}`);
    warningLevel = "HIGH";
  } else if (exposure.remainingCapacity < context.marginUsed * context.leverage * 0.5) {
    rejectReasons.push(`LOW_CAPACITY: remaining ${exposure.remainingCapacity.toFixed(0)} USDT`);
    warningLevel = "MEDIUM";
  }

  // 3. Verifica concentração por símbolo
  const currentSymbolExposure = exposure.symbolExposures[context.symbol] || 0;
  const newSymbolExposure = (context.marginUsed * context.leverage) / exposure.maxNotionalExposure;
  const totalSymbolExposure = currentSymbolExposure + newSymbolExposure;

  if (totalSymbolExposure > exposure.maxSymbolConcentrationPct) {
    rejectReasons.push(`SYMBOL_CONCENTRATION: ${context.symbol} would be ${(totalSymbolExposure * 100).toFixed(0)}% of max exposure`);
    warningLevel = warningLevel === "HIGH" ? "CRITICAL" : "HIGH";
  }

  // 4. Verifica correlação com posições existentes
  let maxCorrelation = 0;
  for (const pos of context.currentPositions) {
    const corr = getCorrelation(context.symbol, pos.symbol);
    maxCorrelation = Math.max(maxCorrelation, corr);
  }

  const correlationPenalty = maxCorrelation > 0.7 ? 0.7 : maxCorrelation > 0.5 ? 0.85 : 1.0;

  if (maxCorrelation > 0.8) {
    rejectReasons.push(`HIGH_CORRELATION: ${context.symbol} correlation ${maxCorrelation.toFixed(2)} with existing position`);
    if (context.currentPositions.length >= maxCorrelatedBulkOrders()) {
      rejectReasons.push(`MAX_CORRELATED_BULK: would exceed ${maxCorrelatedBulkOrders()} correlated positions`);
      warningLevel = "HIGH";
    }
  }

  // 5. Ajusta margem baseado em risco
  if (warningLevel === "HIGH" || warningLevel === "CRITICAL") {
    adjustedMargin = context.marginUsed * 0.5;
    adjustedLeverage = Math.max(1, context.leverage * 0.7);
  } else if (warningLevel === "MEDIUM") {
    adjustedMargin = context.marginUsed * 0.75;
    adjustedLeverage = Math.max(1, context.leverage * 0.85);
  }

  const isAllowed = rejectReasons.length === 0;

  return {
    isAllowed,
    rejectReasons,
    adjustedMargin,
    adjustedLeverage,
    warningLevel,
    correlationPenalty,
  };
}

// ========== ANÁLISE DE CORRELAÇÃO ENTRE ORDENS BULK ==========

export interface BulkCorrelationAnalysis {
  independentGroups: string[][];
  correlatedPairs: Array<{ symbolA: string; symbolB: string; correlation: number }>;
  maxCorrelation: number;
  recommendation: "PROCEED" | "REDUCE" | "CANCEL";
}

export function analyzeBulkCorrelation(orders: Array<{ symbol: string }>): BulkCorrelationAnalysis {
  const correlatedPairs: Array<{ symbolA: string; symbolB: string; correlation: number }> = [];
  let maxCorrelation = 0;

  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      const corr = getCorrelation(orders[i].symbol, orders[j].symbol);
      if (corr > 0.5) {
        correlatedPairs.push({
          symbolA: orders[i].symbol,
          symbolB: orders[j].symbol,
          correlation: corr,
        });
        maxCorrelation = Math.max(maxCorrelation, corr);
      }
    }
  }

  let recommendation: "PROCEED" | "REDUCE" | "CANCEL" = "PROCEED";
  if (maxCorrelation > 0.8 && orders.length > maxCorrelatedBulkOrders()) {
    recommendation = "CANCEL";
  } else if (maxCorrelation > 0.7 && orders.length > maxCorrelatedBulkOrders() + 1) {
    recommendation = "REDUCE";
  }

  // Agrupa ordens por correlação (clusters)
  const independentGroups: string[][] = [];
  const assigned = new Set<string>();

  for (const order of orders) {
    if (assigned.has(order.symbol)) continue;

    const group = [order.symbol];
    assigned.add(order.symbol);

    for (const other of orders) {
      if (assigned.has(other.symbol)) continue;
      const corr = getCorrelation(order.symbol, other.symbol);
      if (corr > 0.6) {
        group.push(other.symbol);
        assigned.add(other.symbol);
      }
    }

    independentGroups.push(group);
  }

  return {
    independentGroups,
    correlatedPairs,
    maxCorrelation,
    recommendation,
  };
}

// ========== MÉTRICAS DE RISCO AGREGADAS ==========

export interface RiskMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  var95Pct: number;      // Value at Risk 95%
  cvar95Pct: number;     // Conditional VaR
  winRate: number;
  profitFactor: number;
  avgWinLossRatio: number;
}

export function calculateRiskMetrics(trades: Array<{ pnlPct: number; win: boolean }>): RiskMetrics {
  if (trades.length === 0) {
    return {
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdownPct: 0,
      var95Pct: 0,
      cvar95Pct: 0,
      winRate: 0,
      profitFactor: 0,
      avgWinLossRatio: 0,
    };
  }

  const returns = trades.map(t => t.pnlPct);
  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
  const stdReturn = Math.sqrt(variance);

  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(365) : 0;

  const negativeReturns = returns.filter(r => r < 0);
  const downsideVariance = negativeReturns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / (negativeReturns.length || 1);
  const downsideStd = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideStd > 0 ? (meanReturn / downsideStd) * Math.sqrt(365) : 0;

  // Maximum Drawdown
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // VaR 95% (percentil 5)
  const sortedReturns = [...returns].sort((a, b) => a - b);
  const var95Idx = Math.floor(sortedReturns.length * 0.05);
  const var95Pct = sortedReturns[var95Idx] || 0;

  // CVaR 95% (média dos piores 5%)
  const tailReturns = sortedReturns.slice(0, var95Idx + 1);
  const cvar95Pct = tailReturns.reduce((a, b) => a + b, 0) / (tailReturns.length || 1);

  const winRate = wins.length / trades.length;

  const grossProfit = wins.reduce((a, b) => a + b.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b.pnlPct, 0) / losses.length) : 0;
  const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  return {
    sharpeRatio: Number(sharpeRatio.toFixed(3)),
    sortinoRatio: Number(sortinoRatio.toFixed(3)),
    maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
    var95Pct: Number(var95Pct.toFixed(4)),
    cvar95Pct: Number(cvar95Pct.toFixed(4)),
    winRate: Number(winRate.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(3)),
    avgWinLossRatio: Number(avgWinLossRatio.toFixed(3)),
  };
}
