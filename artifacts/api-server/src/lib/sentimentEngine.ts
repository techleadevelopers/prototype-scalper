/**
 * Sentiment Engine — 24h/48h directional bias for scalp trading.
 *
 * Fetches 48 × 1h candles from BingX public API and computes:
 *   - VWAP deviation (where price sits relative to value area)
 *   - Volume delta proxy (buy vs sell pressure from candle bodies)
 *   - EMA12/24 cross on 1h timeframe
 *   - Momentum slope (4h vs 24h acceleration)
 *   - Range position (0 = 24h low, 1 = 24h high)
 *   - Body bias (ratio of bullish vs bearish candle bodies)
 *
 * Output: direction + confidence + biasRatio
 *   biasRatio 0.5 = neutral (50/50 LONG/SHORT)
 *   biasRatio 0.72 = 72% weight to dominant direction
 *
 * The bot uses biasRatio to set bulk order distribution:
 *   e.g. BULL 0.72 → 72% LONG entries, 28% SHORT (scalp contra-tendência)
 *
 * Cache: 5 minutes per symbol (1h candles are slow-moving for scalp macro direction).
 */

const BINGX_PUBLIC = "https://open-api.bingx.com";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CANDLE_LIMIT = 48;
const FETCH_TIMEOUT_MS = 5_000;

export type SentimentDirection = "BULL" | "BEAR" | "NEUTRAL";

export interface SentimentIndicators {
  vwapDeviation: number;
  volumeDelta: number;
  momentum4h: number;
  momentum24h: number;
  ema12vs24: "BULL" | "BEAR" | "FLAT";
  rangePosition: number;
  bodyBias: number;
  volumeTrend: "RISING" | "FALLING" | "FLAT";
  highLowBreak: "BREAKOUT_UP" | "BREAKOUT_DOWN" | "RANGE_BOUND";
}

export interface SentimentResult {
  symbol: string;
  direction: SentimentDirection;
  confidence: number;
  biasRatio: number;
  dominantSide: "LONG" | "SHORT" | "NEUTRAL";
  entryBias: { longWeight: number; shortWeight: number };
  indicators: SentimentIndicators;
  candles24h: number;
  fetchedAt: number;
  error?: string;
}

interface CandleRaw {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVol?: number;
}

interface CacheEntry {
  result: SentimentResult;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

function neutralResult(symbol: string, error: string): SentimentResult {
  return {
    symbol,
    direction: "NEUTRAL",
    confidence: 0,
    biasRatio: 0.5,
    dominantSide: "NEUTRAL",
    entryBias: { longWeight: 0.5, shortWeight: 0.5 },
    indicators: {
      vwapDeviation: 0,
      volumeDelta: 0,
      momentum4h: 0,
      momentum24h: 0,
      ema12vs24: "FLAT",
      rangePosition: 0.5,
      bodyBias: 0,
      volumeTrend: "FLAT",
      highLowBreak: "RANGE_BOUND",
    },
    candles24h: 0,
    fetchedAt: Date.now(),
    error,
  };
}

interface BingXKlineRow {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  time: number;
}

function toKlineSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("-")) return s;
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}-USDT`;
  if (s.endsWith("USDC")) return `${s.slice(0, -4)}-USDC`;
  return s;
}

async function fetchCandles(symbol: string): Promise<CandleRaw[]> {
  const klineSymbol = toKlineSymbol(symbol);
  const url = `${BINGX_PUBLIC}/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(klineSymbol)}&interval=1h&limit=${CANDLE_LIMIT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { code: number; data: unknown };
  if (json.code !== 0 || !Array.isArray(json.data)) throw new Error(`BingX klines code=${json.code}`);

  const rows = json.data as BingXKlineRow[];
  return rows
    .map((r) => ({
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
    }))
    .filter((c) => c.close > 0)
    .sort((a, b) => 0);
}

function computeEma(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function computeVwap(candles: CandleRaw[]): number {
  let tpvSum = 0;
  let volSum = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    tpvSum += typicalPrice * c.volume;
    volSum += c.volume;
  }
  return volSum > 0 ? tpvSum / volSum : 0;
}

function computeVolumeDelta(candles: CandleRaw[]): number {
  let buyVol = 0;
  let totalVol = 0;
  for (const c of candles) {
    totalVol += c.volume;
    if (c.takerBuyVol !== undefined) {
      buyVol += c.takerBuyVol;
    } else {
      const body = c.close - c.open;
      const range = c.high - c.low;
      const bullishFraction = range > 0 ? Math.max(0, body / range) : 0.5;
      buyVol += c.volume * (0.3 + bullishFraction * 0.4);
    }
  }
  if (totalVol === 0) return 0;
  const buyRatio = buyVol / totalVol;
  return (buyRatio - 0.5) * 2;
}

function computeBodyBias(candles: CandleRaw[]): number {
  if (candles.length === 0) return 0;
  let bullishBodySum = 0;
  let totalBodySum = 0;
  for (const c of candles) {
    const body = Math.abs(c.close - c.open);
    const isBull = c.close >= c.open;
    bullishBodySum += isBull ? body : 0;
    totalBodySum += body;
  }
  if (totalBodySum === 0) return 0;
  const bullishRatio = bullishBodySum / totalBodySum;
  return (bullishRatio - 0.5) * 2;
}

function computeVolumeTrend(candles: CandleRaw[]): "RISING" | "FALLING" | "FLAT" {
  if (candles.length < 8) return "FLAT";
  const half = Math.floor(candles.length / 2);
  const firstHalf = candles.slice(0, half).reduce((s, c) => s + c.volume, 0) / half;
  const secondHalf = candles.slice(half).reduce((s, c) => s + c.volume, 0) / (candles.length - half);
  if (secondHalf > firstHalf * 1.15) return "RISING";
  if (secondHalf < firstHalf * 0.85) return "FALLING";
  return "FLAT";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function computeSentiment(symbol: string, candles: CandleRaw[]): SentimentResult {
  if (candles.length < 4) return neutralResult(symbol, "insufficient_candles");

  const last24 = candles.slice(-24);
  const last4 = candles.slice(-4);
  const current = candles[candles.length - 1].close;

  const vwap24 = computeVwap(last24);
  const vwapDeviation = vwap24 > 0 ? (current - vwap24) / vwap24 : 0;

  const volumeDelta = computeVolumeDelta(last24);

  const close24h = candles.length >= 24 ? candles[candles.length - 24].open : candles[0].open;
  const close4h = last4[0].open;
  const momentum24h = close24h > 0 ? (current - close24h) / close24h : 0;
  const momentum4h = close4h > 0 ? (current - close4h) / close4h : 0;

  const closes = candles.map((c) => c.close);
  const ema12 = computeEma(closes, 12);
  const ema24 = computeEma(closes, 24);
  const lastEma12 = ema12[ema12.length - 1] ?? current;
  const lastEma24 = ema24[ema24.length - 1] ?? current;
  const emaDeltaPct = lastEma24 > 0 ? (lastEma12 - lastEma24) / lastEma24 : 0;
  const ema12vs24: "BULL" | "BEAR" | "FLAT" =
    emaDeltaPct > 0.001 ? "BULL" : emaDeltaPct < -0.001 ? "BEAR" : "FLAT";

  const h24 = Math.max(...last24.map((c) => c.high));
  const l24 = Math.min(...last24.map((c) => c.low));
  const rangePosition = h24 > l24 ? (current - l24) / (h24 - l24) : 0.5;

  const bodyBias = computeBodyBias(last24);
  const volumeTrend = computeVolumeTrend(last24);

  const recentH = Math.max(...last4.map((c) => c.high));
  const recentL = Math.min(...last4.map((c) => c.low));
  const prevH = Math.max(...last24.slice(0, 20).map((c) => c.high));
  const prevL = Math.min(...last24.slice(0, 20).map((c) => c.low));
  const highLowBreak: "BREAKOUT_UP" | "BREAKOUT_DOWN" | "RANGE_BOUND" =
    recentH > prevH * 1.002 ? "BREAKOUT_UP" :
    recentL < prevL * 0.998 ? "BREAKOUT_DOWN" : "RANGE_BOUND";

  const bullSignals = [
    vwapDeviation > 0.002 ? 1 : vwapDeviation < -0.002 ? -1 : 0,
    volumeDelta > 0.1 ? 1 : volumeDelta < -0.1 ? -1 : 0,
    momentum24h > 0.003 ? 1 : momentum24h < -0.003 ? -1 : 0,
    momentum4h > 0.001 ? 1 : momentum4h < -0.001 ? -1 : 0,
    ema12vs24 === "BULL" ? 1 : ema12vs24 === "BEAR" ? -1 : 0,
    rangePosition > 0.65 ? 1 : rangePosition < 0.35 ? -1 : 0,
    bodyBias > 0.1 ? 1 : bodyBias < -0.1 ? -1 : 0,
    highLowBreak === "BREAKOUT_UP" ? 1 : highLowBreak === "BREAKOUT_DOWN" ? -1 : 0,
  ];

  const signalWeights = [0.18, 0.16, 0.16, 0.14, 0.16, 0.08, 0.08, 0.04];
  let score = 0;
  for (let i = 0; i < bullSignals.length; i++) {
    score += bullSignals[i] * signalWeights[i];
  }

  const absScore = Math.abs(score);
  const direction: SentimentDirection =
    score > 0.08 ? "BULL" :
    score < -0.08 ? "BEAR" : "NEUTRAL";

  const confidence = clamp(absScore * 2.5, 0, 1);

  const rawBias = clamp(0.5 + score * 2.5, 0.20, 0.80);
  const biasRatio = direction === "NEUTRAL" ? 0.5 : rawBias;

  const dominantSide: "LONG" | "SHORT" | "NEUTRAL" =
    direction === "BULL" ? "LONG" :
    direction === "BEAR" ? "SHORT" : "NEUTRAL";

  const longWeight = direction === "BULL" ? biasRatio : 1 - biasRatio;
  const shortWeight = 1 - longWeight;

  return {
    symbol,
    direction,
    confidence,
    biasRatio: direction === "BULL" ? biasRatio : direction === "BEAR" ? 1 - biasRatio : 0.5,
    dominantSide,
    entryBias: { longWeight, shortWeight },
    indicators: {
      vwapDeviation: parseFloat((vwapDeviation * 100).toFixed(4)),
      volumeDelta: parseFloat(volumeDelta.toFixed(4)),
      momentum4h: parseFloat((momentum4h * 100).toFixed(4)),
      momentum24h: parseFloat((momentum24h * 100).toFixed(4)),
      ema12vs24,
      rangePosition: parseFloat(rangePosition.toFixed(3)),
      bodyBias: parseFloat(bodyBias.toFixed(4)),
      volumeTrend,
      highLowBreak,
    },
    candles24h: last24.length,
    fetchedAt: Date.now(),
  };
}

export async function getMarketSentiment(symbol: string): Promise<SentimentResult> {
  const now = Date.now();
  const cached = _cache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.result;

  try {
    const candles = await fetchCandles(symbol);
    const result = computeSentiment(symbol, candles);
    _cache.set(symbol, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : "fetch_failed";
    const stale = cached?.result;
    if (stale) {
      return { ...stale, error: `stale: ${error}`, fetchedAt: stale.fetchedAt };
    }
    return neutralResult(symbol, error);
  }
}

export async function getMarketSentimentBulk(symbols: string[]): Promise<SentimentResult[]> {
  return Promise.all(symbols.map((s) => getMarketSentiment(s)));
}

export function getSentimentCacheStats(): { size: number; keys: string[] } {
  return { size: _cache.size, keys: Array.from(_cache.keys()) };
}

export function invalidateSentimentCache(symbol?: string): void {
  if (symbol) {
    _cache.delete(symbol);
  } else {
    _cache.clear();
  }
}
