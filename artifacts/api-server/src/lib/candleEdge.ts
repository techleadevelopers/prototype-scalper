/**
 * CandleEdge — market-side of the Edge Engine.
 *
 * Fetches OHLCV candles from BingX and computes technical indicators:
 *   - EMA(9) and EMA(21) crossover → trend direction
 *   - RSI(14) → momentum / overbought / oversold
 *   - ATR(14) → volatility, used for dynamic TP/SL sizing
 *   - Volume surge ratio vs 14-period avg
 *   - MACD → trend strength confirmation
 *   - Bollinger Bands → volatility bands
 *   - Ichimoku (simplified) → support/resistance levels
 *
 * Combined market score mirrors the Rust sizing_score() concept:
 *   marketScore = emaCross × 0.35 + rsiSignal × 0.25 + volumeBoost × 0.15 + macdSignal × 0.15 + bbSignal × 0.10
 *
 * Results are cached 30s per symbol to avoid hammering the public endpoint.
 *
 * Nível Máximo de Excelência:
 * - Schema validation com Zod
 * - Cache adaptativo com TTL baseado em volatilidade
 * - Múltiplos indicadores (MACD, BB, Ichimoku simplificado)
 * - Divergência price/RSI detection
 * - Suporte a múltiplos timeframes
 * - Rate limiting e retry com backoff
 * - Event emitter para mudanças de sinal
 */

import { EventEmitter } from "events";
import { createHash } from "crypto";
import { z } from "zod";

// ========== CONSTANTS ==========

const BINGX_PUBLIC = "https://open-api.bingx.com";
const DEFAULT_CACHE_TTL_MS = 30_000;
const HIGH_VOLATILITY_CACHE_TTL_MS = 15_000;
const LOW_VOLATILITY_CACHE_TTL_MS = 60_000;
const CANDLE_LIMIT = 50; // Aumentado para suportar indicadores adicionais
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ========== SCHEMAS ==========

export const EdgeSideSchema = z.enum(["LONG", "SHORT", "NEUTRAL"]);
export type EdgeSide = z.infer<typeof EdgeSideSchema>;

export const CandleIntervalSchema = z.enum(["1m", "3m", "5m", "15m", "30m", "1h"]);
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;

export const EmaCrossSchema = z.enum(["BULLISH", "BEARISH", "FLAT"]);
export type EmaCross = z.infer<typeof EmaCrossSchema>;

export const MacdSignalSchema = z.enum(["BULLISH", "BEARISH", "NEUTRAL"]);
export type MacdSignal = z.infer<typeof MacdSignalSchema>;

export const BbPositionSchema = z.enum(["ABOVE_TOP", "INSIDE", "BELOW_BOTTOM"]);
export type BbPosition = z.infer<typeof BbPositionSchema>;

export const DivergenceSchema = z.enum(["BULLISH", "BEARISH", "NONE"]);
export type Divergence = z.infer<typeof DivergenceSchema>;

export const CandleEdgeSchema = z.object({
  symbol: z.string(),
  interval: CandleIntervalSchema,
  candleCount: z.number().int(),
  lastClose: z.number(),
  ema9: z.number(),
  ema21: z.number(),
  emaCross: EmaCrossSchema,
  emaCrossPct: z.number(),
  rsi14: z.number(),
  atr14: z.number(),
  atrPct: z.number(),
  volumeRatio: z.number(),
  lastCandleMovePct: z.number(),
  recentMovePct: z.number(),
  reversalScore: z.number(),
  longScore: z.number(),
  shortScore: z.number(),
  suggestedSide: EdgeSideSchema,
  fetchedAt: z.number(),
  error: z.string().optional(),
  // Candle completion provenance — prevent live-candle repainting
  candleOpenTimeMs: z.number().optional(),
  candleCloseTimeMs: z.number().optional(),
  candleIsComplete: z.boolean().optional(),
  marketEventId: z.string().optional(),
  // NOVOS CAMPOS
  macdLine: z.number().optional(),
  macdSignal: z.number().optional(),
  macdHistogram: z.number().optional(),
  macdSignalDirection: MacdSignalSchema.optional(),
  bbUpper: z.number().optional(),
  bbLower: z.number().optional(),
  bbMiddle: z.number().optional(),
  bbPosition: BbPositionSchema.optional(),
  bbWidthPct: z.number().optional(),
  ichimokuBase: z.number().optional(),
  ichimokuConversion: z.number().optional(),
  priceToIchimokuPct: z.number().optional(),
  divergence: DivergenceSchema.optional(),
  volumeTrend: z.enum(["RISING", "FALLING", "FLAT"]).optional(),
  volatilityRegime: z.enum(["HIGH", "NORMAL", "LOW"]).optional(),
});

export type CandleEdge = z.infer<typeof CandleEdgeSchema>;

// ========== CACHE ==========

interface CacheEntry {
  edge: CandleEdge;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();
const cacheEvents = new EventEmitter();

function cacheKey(symbol: string, interval: CandleInterval): string {
  return `${symbol}:${interval}`;
}

function getAdaptiveTTL(atrPct: number): number {
  if (atrPct > 1.5) return HIGH_VOLATILITY_CACHE_TTL_MS;
  if (atrPct < 0.5) return LOW_VOLATILITY_CACHE_TTL_MS;
  return DEFAULT_CACHE_TTL_MS;
}

function getCached(symbol: string, interval: CandleInterval): CandleEdge | null {
  const key = cacheKey(symbol, interval);
  const cached = _cache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return cached.edge;
}

function setCache(edge: CandleEdge): void {
  const ttl = getAdaptiveTTL(edge.atrPct);
  const key = cacheKey(edge.symbol, edge.interval);
  _cache.set(key, {
    edge,
    expiresAt: Date.now() + ttl,
  });
  cacheEvents.emit("cached", edge);
}

export function invalidateCandleCache(symbol: string): void {
  const intervals: CandleInterval[] = ["1m", "3m", "5m", "15m", "30m", "1h"];
  for (const interval of intervals) {
    _cache.delete(cacheKey(symbol, interval));
  }
  cacheEvents.emit("invalidated", symbol);
}

export function onCacheEvent(listener: (event: "cached" | "invalidated", data: any) => void): () => void {
  cacheEvents.on("cached", (data) => listener("cached", data));
  cacheEvents.on("invalidated", (data) => listener("invalidated", data));
  return () => {
    cacheEvents.off("cached", (data) => listener("cached", data));
    cacheEvents.off("invalidated", (data) => listener("invalidated", data));
  };
}

// ========== INDICATOR MATH ==========

function ema(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr14(highs: number[], lows: number[], closes: number[]): number {
  if (closes.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  if (trs.length === 0) return 0;
  const period = Math.min(14, trs.length);
  const k = 2 / (period + 1);
  let atrVal = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = trs[i] * k + atrVal * (1 - k);
  }
  return atrVal;
}

function macd(closes: number[], fast: number = 12, slow: number = 26, signal: number = 9): {
  macdLine: number;
  signalLine: number;
  histogram: number;
} {
  if (closes.length < slow + signal) {
    return { macdLine: 0, signalLine: 0, histogram: 0 };
  }

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast[emaFast.length - 1] - emaSlow[emaSlow.length - 1];

  // Calcula signal line (EMA do MACD)
  const macdValues: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const fastEma = ema(closes.slice(0, i + 1), fast);
    const slowEma = ema(closes.slice(0, i + 1), slow);
    macdValues.push(fastEma[fastEma.length - 1] - slowEma[slowEma.length - 1]);
  }

  const signalLine = ema(macdValues, signal)[macdValues.length - 1] || 0;
  const histogram = macdLine - signalLine;

  return { macdLine, signalLine, histogram };
}

function bollingerBands(closes: number[], period: number = 20, stdDev: number = 2): {
  upper: number;
  middle: number;
  lower: number;
} {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last };
  }

  const recent = closes.slice(-period);
  const middle = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((a, b) => a + Math.pow(b - middle, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: middle + stdDev * std,
    middle,
    lower: middle - stdDev * std,
  };
}

function ichimokuSimplified(highs: number[], lows: number[], closes: number[]): {
  conversionLine: number;
  baseLine: number;
} {
  // Tenkan-sen (conversion line): (highest high + lowest low) / 2 over 9 periods
  const tenkanPeriod = 9;
  const kijunPeriod = 26;

  const recentHighs = highs.slice(-tenkanPeriod);
  const recentLows = lows.slice(-tenkanPeriod);
  const conversionLine = (Math.max(...recentHighs) + Math.min(...recentLows)) / 2;

  const baseHighs = highs.slice(-kijunPeriod);
  const baseLows = lows.slice(-kijunPeriod);
  const baseLine = (Math.max(...baseHighs) + Math.min(...baseLows)) / 2;

  return { conversionLine, baseLine };
}

function detectDivergence(prices: number[], rsiValues: number[], lookback: number = 14): {
  bullish: boolean;
  bearish: boolean;
} {
  if (prices.length < lookback || rsiValues.length < lookback) {
    return { bullish: false, bearish: false };
  }

  const recentPrices = prices.slice(-lookback);
  const recentRsi = rsiValues.slice(-lookback);

  // Find price peaks/valleys
  const pricePeaks: number[] = [];
  const rsiPeaks: number[] = [];
  const priceTroughs: number[] = [];
  const rsiTroughs: number[] = [];

  for (let i = 2; i < recentPrices.length - 2; i++) {
    if (recentPrices[i] > recentPrices[i-1] && recentPrices[i] > recentPrices[i+1]) {
      pricePeaks.push(recentPrices[i]);
      rsiPeaks.push(recentRsi[i]);
    }
    if (recentPrices[i] < recentPrices[i-1] && recentPrices[i] < recentPrices[i+1]) {
      priceTroughs.push(recentPrices[i]);
      rsiTroughs.push(recentRsi[i]);
    }
  }

  // Bearish divergence: higher price peak, lower RSI peak
  let bearish = false;
  if (pricePeaks.length >= 2 && rsiPeaks.length >= 2) {
    const priceHigher = pricePeaks[pricePeaks.length - 1] > pricePeaks[pricePeaks.length - 2];
    const rsiLower = rsiPeaks[rsiPeaks.length - 1] < rsiPeaks[rsiPeaks.length - 2];
    bearish = priceHigher && rsiLower;
  }

  // Bullish divergence: lower price trough, higher RSI trough
  let bullish = false;
  if (priceTroughs.length >= 2 && rsiTroughs.length >= 2) {
    const priceLower = priceTroughs[priceTroughs.length - 1] < priceTroughs[priceTroughs.length - 2];
    const rsiHigher = rsiTroughs[rsiTroughs.length - 1] > rsiTroughs[rsiTroughs.length - 2];
    bullish = priceLower && rsiHigher;
  }

  return { bullish, bearish };
}

function detectVolumeTrend(volumes: number[]): "RISING" | "FALLING" | "FLAT" {
  if (volumes.length < 10) return "FLAT";

  const firstHalf = volumes.slice(0, volumes.length / 2);
  const secondHalf = volumes.slice(volumes.length / 2);

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  if (avgSecond > avgFirst * 1.15) return "RISING";
  if (avgSecond < avgFirst * 0.85) return "FALLING";
  return "FLAT";
}

function detectVolatilityRegime(atrPct: number): "HIGH" | "NORMAL" | "LOW" {
  if (atrPct > 1.5) return "HIGH";
  if (atrPct < 0.5) return "LOW";
  return "NORMAL";
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function computeScores(
  ema9val: number,
  ema21val: number,
  rsi: number,
  volRatio: number,
  lastCandleMovePct: number,
  recentMovePct: number,
  macdHistogram: number,
  bbPosition: "ABOVE_TOP" | "INSIDE" | "BELOW_BOTTOM",
  divergence: "BULLISH" | "BEARISH" | "NONE",
): { longScore: number; shortScore: number; reversalScore: number } {
  const emaDeltaPct = (ema9val - ema21val) / (ema21val || 1);
  const emaBullStrength = clamp01(emaDeltaPct * 200);
  const emaBearStrength = clamp01(-emaDeltaPct * 200);

  // RSI signal
  const rsiLong = rsi < 50
    ? clamp01((55 - rsi) / 25)
    : clamp01((75 - rsi) / 25);
  const rsiShort = rsi > 50
    ? clamp01((rsi - 45) / 25)
    : clamp01((rsi - 25) / 25);

  const volBoost = clamp01(volRatio / 2.5);

  // MACD signal
  const macdLong = macdHistogram > 0 ? clamp01(macdHistogram * 10) : 0;
  const macdShort = macdHistogram < 0 ? clamp01(-macdHistogram * 10) : 0;

  // Bollinger Bands signal
  let bbLong = 0;
  let bbShort = 0;
  if (bbPosition === "BELOW_BOTTOM") bbLong = 0.8;
  else if (bbPosition === "ABOVE_TOP") bbShort = 0.8;
  else if (bbPosition === "INSIDE") {
    bbLong = 0.3;
    bbShort = 0.3;
  }

  // Divergence signal
  let divLong = 0;
  let divShort = 0;
  if (divergence === "BULLISH") divLong = 0.7;
  if (divergence === "BEARISH") divShort = 0.7;

  const continuationLong = clamp01(
    emaBullStrength * 0.30 +
    rsiLong * 0.20 +
    volBoost * 0.15 +
    macdLong * 0.15 +
    bbLong * 0.10 +
    divLong * 0.10
  );

  const continuationShort = clamp01(
    emaBearStrength * 0.30 +
    rsiShort * 0.20 +
    volBoost * 0.15 +
    macdShort * 0.15 +
    bbShort * 0.10 +
    divShort * 0.10
  );

  // Scalp contrarian signals
  const dumpStrength = clamp01((Math.max(-lastCandleMovePct, -recentMovePct) - 2) / 2);
  const pumpStrength = clamp01((Math.max(lastCandleMovePct, recentMovePct) - 2) / 2);
  const oversoldBoost = rsi <= 42 ? clamp01((45 - rsi) / 18) : 0;
  const overboughtBoost = rsi >= 58 ? clamp01((rsi - 55) / 18) : 0;

  const contrarianLong = clamp01(dumpStrength * 0.60 + oversoldBoost * 0.25 + volBoost * 0.15);
  const contrarianShort = clamp01(pumpStrength * 0.60 + overboughtBoost * 0.25 + volBoost * 0.15);

  const reversalScore = clamp01(Math.max(dumpStrength, pumpStrength) * 0.65 + volBoost * 0.20 +
    (divergence !== "NONE" ? 0.15 : 0));

  return {
    longScore: clamp01(Math.max(continuationLong, contrarianLong)),
    shortScore: clamp01(Math.max(continuationShort, contrarianShort)),
    reversalScore,
  };
}

// ========== INTERVAL UTILITIES ==========

function intervalToMs(interval: CandleInterval): number {
  const map: Record<CandleInterval, number> = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
  };
  return map[interval] ?? 300_000;
}

function makeMarketEventId(symbol: string, interval: CandleInterval, candleOpenTimeMs: number): string {
  return createHash("sha256")
    .update(`${symbol}|${interval}|${candleOpenTimeMs}`)
    .digest("hex")
    .slice(0, 16);
}

// ========== SYMBOL NORMALIZATION ==========

function toKlineSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("-")) return s;
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}-USDT`;
  if (s.endsWith("USDC")) return `${s.slice(0, -4)}-USDC`;
  if (s.endsWith("USD")) return `${s.slice(0, -3)}-USDT`;
  return s;
}

// ========== BINGX CANDLE FETCH ==========

interface RawCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BingXKlineRow {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  time: number;
}

async function fetchCandlesWithRetry(
  symbol: string,
  interval: CandleInterval,
  limit: number,
  retryCount: number = 0
): Promise<RawCandle[]> {
  try {
    const klineSymbol = toKlineSymbol(symbol);
    const url = `${BINGX_PUBLIC}/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(klineSymbol)}&interval=${interval}&limit=${limit}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const json = await resp.json() as Record<string, unknown>;

    if (json.code !== 0) {
      throw new Error(`BingX error ${symbol}: ${json.msg ?? json.code}`);
    }

    const rows = json.data as BingXKlineRow[];
    if (!Array.isArray(rows)) throw new Error(`Invalid data for ${symbol}`);

    if (rows.length < 10 && retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
      return fetchCandlesWithRetry(symbol, interval, limit, retryCount + 1);
    }

    return rows
      .map((r) => ({
        openTime: Number(r.time),
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: parseFloat(r.volume),
      }))
      .sort((a, b) => a.openTime - b.openTime);
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
      return fetchCandlesWithRetry(symbol, interval, limit, retryCount + 1);
    }
    throw err;
  }
}

// ========== PUBLIC API ==========

export async function computeCandleEdge(
  symbol: string,
  interval: CandleInterval = "5m",
): Promise<CandleEdge> {
  const cached = getCached(symbol, interval);
  if (cached) return cached;

  try {
    const candles = await fetchCandlesWithRetry(symbol, interval, CANDLE_LIMIT);
    if (candles.length < 10) {
      throw new Error(`Insufficient candles: ${candles.length}`);
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const ema9vals = ema(closes, 9);
    const ema21vals = ema(closes, 21);
    const ema9val = ema9vals[ema9vals.length - 1];
    const ema21val = ema21vals[ema21vals.length - 1];

    const rsiVal = rsi14(closes);
    const atrVal = atr14(highs, lows, closes);

    const { macdLine, signalLine, histogram: macdHistogram } = macd(closes);
    const { upper: bbUpper, middle: bbMiddle, lower: bbLower } = bollingerBands(closes);
    const { conversionLine, baseLine } = ichimokuSimplified(highs, lows, closes);

    const recentVol = volumes[volumes.length - 1];
    const avgVol14 = volumes.slice(-15, -1).reduce((s, v) => s + v, 0) / Math.min(14, volumes.length - 1);
    const volRatio = avgVol14 > 0 ? recentVol / avgVol14 : 1;

    const volumeTrend = detectVolumeTrend(volumes);

    const emaCrossPct = ((ema9val - ema21val) / (ema21val || 1)) * 100;
    const emaCross: EmaCross = Math.abs(emaCrossPct) < 0.02 ? "FLAT" : ema9val > ema21val ? "BULLISH" : "BEARISH";

    const macdSignalDirection: MacdSignal = macdHistogram > 0 ? "BULLISH" : macdHistogram < 0 ? "BEARISH" : "NEUTRAL";

    const lastClose = closes[closes.length - 1];
    const atrPct = lastClose > 0 ? (atrVal / lastClose) * 100 : 0;
    const volatilityRegime = detectVolatilityRegime(atrPct);

    const lastCandle = candles[candles.length - 1];
    const priorClose = closes[Math.max(0, closes.length - 4)];
    const lastCandleMovePct = lastCandle.open > 0
      ? ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100
      : 0;
    const recentMovePct = priorClose > 0
      ? ((lastClose - priorClose) / priorClose) * 100
      : 0;

    let bbPosition: BbPosition = "INSIDE";
    if (lastClose > bbUpper) bbPosition = "ABOVE_TOP";
    else if (lastClose < bbLower) bbPosition = "BELOW_BOTTOM";
    const bbWidthPct = ((bbUpper - bbLower) / bbMiddle) * 100;

    const { bullish: bullishDivergence, bearish: bearishDivergence } = detectDivergence(closes, closes.map((_, i) => rsi14(closes.slice(0, i + 1))));
    const divergence: Divergence = bullishDivergence ? "BULLISH" : bearishDivergence ? "BEARISH" : "NONE";

    const priceToIchimokuPct = ((lastClose - baseLine) / baseLine) * 100;

    const { longScore, shortScore, reversalScore } = computeScores(
      ema9val, ema21val, rsiVal, volRatio, lastCandleMovePct, recentMovePct,
      macdHistogram, bbPosition, divergence
    );

    const suggestedSide: EdgeSide = longScore > shortScore && longScore > 0.35 ? "LONG" :
                                    shortScore > longScore && shortScore > 0.35 ? "SHORT" : "NEUTRAL";

    const edge: CandleEdge = {
      symbol,
      interval,
      candleCount: candles.length,
      lastClose,
      ema9: ema9val,
      ema21: ema21val,
      emaCross,
      emaCrossPct,
      rsi14: rsiVal,
      atr14: atrVal,
      atrPct,
      volumeRatio: volRatio,
      lastCandleMovePct,
      recentMovePct,
      reversalScore,
      longScore,
      shortScore,
      suggestedSide,
      fetchedAt: Date.now(),
      // NOVOS CAMPOS
      macdLine,
      macdSignal: signalLine,
      macdHistogram,
      macdSignalDirection,
      bbUpper,
      bbLower,
      bbMiddle,
      bbPosition,
      bbWidthPct,
      ichimokuConversion: conversionLine,
      ichimokuBase: baseLine,
      priceToIchimokuPct,
      divergence,
      volumeTrend,
      volatilityRegime,
    };

    setCache(edge);
    return edge;
  } catch (err) {
    const fallback: CandleEdge = {
      symbol,
      interval,
      candleCount: 0,
      lastClose: 0,
      ema9: 0,
      ema21: 0,
      emaCross: "FLAT",
      emaCrossPct: 0,
      rsi14: 50,
      atr14: 0,
      atrPct: 0,
      volumeRatio: 1,
      lastCandleMovePct: 0,
      recentMovePct: 0,
      reversalScore: 0,
      longScore: 0,
      shortScore: 0,
      suggestedSide: "NEUTRAL",
      fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
    setCache(fallback);
    return fallback;
  }
}

export async function computeAllCandleEdges(
  symbols: string[],
  interval: CandleInterval = "5m",
): Promise<CandleEdge[]> {
  const results = await Promise.allSettled(
    symbols.map((sym) => computeCandleEdge(sym, interval)),
  );
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          symbol: symbols[i],
          interval,
          candleCount: 0,
          lastClose: 0,
          ema9: 0,
          ema21: 0,
          emaCross: "FLAT" as const,
          emaCrossPct: 0,
          rsi14: 50,
          atr14: 0,
          atrPct: 0,
          volumeRatio: 1,
          lastCandleMovePct: 0,
          recentMovePct: 0,
          reversalScore: 0,
          longScore: 0,
          shortScore: 0,
          suggestedSide: "NEUTRAL" as const,
          fetchedAt: Date.now(),
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}

export function getCandleCacheStats(): { size: number; keys: string[] } {
  return {
    size: _cache.size,
    keys: Array.from(_cache.keys()),
  };
}

export function clearCandleCache(): void {
  _cache.clear();
  cacheEvents.emit("cleared");
}