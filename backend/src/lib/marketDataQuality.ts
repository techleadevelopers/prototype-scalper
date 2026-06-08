export type MarketDataIncidentType =
  | "DUPLICATE"
  | "GAP"
  | "STALE"
  | "INCOMPLETE"
  | "OUT_OF_ORDER"
  | "INVALID_VALUE"
  | "TIMESTAMP_VIOLATION"
  | "DUPLICATE_EXECUTION";

export interface CandleInput {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketDataIncident {
  type: MarketDataIncidentType;
  symbol: string;
  timeframe: string;
  occurredAt: number;
  detail: string;
}

export interface CandleBatchQuality {
  candles: CandleInput[];
  completedCandles: CandleInput[];
  latestCompleted?: CandleInput;
  duplicateCount: number;
  missingCount: number;
  outOfOrderCount: number;
  invalidCount: number;
  incompleteCount: number;
  stale: boolean;
  freshnessMs: number;
  incidents: MarketDataIncident[];
}

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

const metrics = {
  batches: 0,
  acceptedCandles: 0,
  duplicates: 0,
  missing: 0,
  outOfOrder: 0,
  invalid: 0,
  incomplete: 0,
  stale: 0,
  duplicateExecutions: 0,
};
const recentIncidents: MarketDataIncident[] = [];
const executionClaims = new Map<string, number>();

export function normalizeMarketSymbol(symbol: string): string {
  const compact = symbol.trim().toUpperCase().replace(/[_/]/g, "-");
  if (compact.includes("-")) return compact;
  for (const quote of ["USDT", "USDC", "USD"]) {
    if (compact.endsWith(quote)) {
      const base = compact.slice(0, -quote.length);
      return `${base}-${quote === "USD" ? "USDT" : quote}`;
    }
  }
  return compact;
}

export function normalizeTimeframe(timeframe: string): string {
  const normalized = timeframe.trim().toLowerCase();
  if (!TIMEFRAME_MS[normalized]) throw new Error(`Unsupported timeframe: ${timeframe}`);
  return normalized;
}

export function timeframeToMs(timeframe: string): number {
  return TIMEFRAME_MS[normalizeTimeframe(timeframe)];
}

export function canonicalMarketEventId(
  symbol: string,
  timeframe: string,
  candleOpenTimeMs: number,
): string {
  const openTime = Math.trunc(candleOpenTimeMs);
  if (!Number.isSafeInteger(openTime) || openTime <= 0) {
    throw new Error(`Invalid candle open timestamp: ${candleOpenTimeMs}`);
  }
  return `md:v1:bingx:${normalizeMarketSymbol(symbol)}:${normalizeTimeframe(timeframe)}:${openTime}`;
}

function recordIncident(incident: MarketDataIncident): void {
  recentIncidents.push(incident);
  if (recentIncidents.length > 200) recentIncidents.shift();
}

function validCandle(candle: CandleInput): boolean {
  const values = [
    candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume,
  ];
  return values.every(Number.isFinite)
    && Number.isSafeInteger(candle.openTime)
    && candle.openTime > 0
    && candle.open > 0
    && candle.high > 0
    && candle.low > 0
    && candle.close > 0
    && candle.volume >= 0
    && candle.high >= Math.max(candle.open, candle.close, candle.low)
    && candle.low <= Math.min(candle.open, candle.close, candle.high);
}

export function assessCandleBatch(
  symbol: string,
  timeframe: string,
  input: CandleInput[],
  nowMs: number = Date.now(),
  staleAfterIntervals: number = 2,
): CandleBatchQuality {
  const normalizedSymbol = normalizeMarketSymbol(symbol);
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const intervalMs = timeframeToMs(normalizedTimeframe);
  const incidents: MarketDataIncident[] = [];
  let outOfOrderCount = 0;
  for (let i = 1; i < input.length; i++) {
    if (input[i].openTime < input[i - 1].openTime) outOfOrderCount++;
  }

  const byOpenTime = new Map<number, CandleInput>();
  let duplicateCount = 0;
  let invalidCount = 0;
  for (const candle of input) {
    if (!validCandle(candle) || candle.openTime % intervalMs !== 0) {
      invalidCount++;
      continue;
    }
    if (byOpenTime.has(candle.openTime)) duplicateCount++;
    byOpenTime.set(candle.openTime, candle);
  }
  const candles = [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);

  let missingCount = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].openTime - candles[i - 1].openTime;
    if (delta > intervalMs) missingCount += Math.max(0, Math.round(delta / intervalMs) - 1);
  }

  const completedCandles = candles.filter((c) => c.openTime + intervalMs <= nowMs);
  const incompleteCount = candles.length - completedCandles.length;
  const latestCompleted = completedCandles.at(-1);
  const freshnessMs = latestCompleted
    ? Math.max(0, nowMs - (latestCompleted.openTime + intervalMs))
    : Number.POSITIVE_INFINITY;
  const stale = !latestCompleted || freshnessMs > intervalMs * staleAfterIntervals;

  const add = (type: MarketDataIncidentType, count: number, detail: string) => {
    if (count <= 0) return;
    const incident = {
      type, symbol: normalizedSymbol, timeframe: normalizedTimeframe, occurredAt: nowMs, detail,
    };
    incidents.push(incident);
    recordIncident(incident);
  };
  add("DUPLICATE", duplicateCount, `${duplicateCount} duplicate candle row(s)`);
  add("GAP", missingCount, `${missingCount} missing candle interval(s)`);
  add("OUT_OF_ORDER", outOfOrderCount, `${outOfOrderCount} out-of-order transition(s)`);
  add("INVALID_VALUE", invalidCount, `${invalidCount} invalid candle row(s)`);
  add("INCOMPLETE", incompleteCount, `${incompleteCount} unfinished candle row(s) excluded`);
  add("STALE", stale ? 1 : 0, `latest completed candle freshness=${freshnessMs}ms`);

  metrics.batches++;
  metrics.acceptedCandles += completedCandles.length;
  metrics.duplicates += duplicateCount;
  metrics.missing += missingCount;
  metrics.outOfOrder += outOfOrderCount;
  metrics.invalid += invalidCount;
  metrics.incomplete += incompleteCount;
  if (stale) metrics.stale++;

  return {
    candles,
    completedCandles,
    latestCompleted,
    duplicateCount,
    missingCount,
    outOfOrderCount,
    invalidCount,
    incompleteCount,
    stale,
    freshnessMs,
    incidents,
  };
}

export function claimMarketEventExecution(
  marketEventId: string,
  positionSide: "LONG" | "SHORT",
  nowMs: number = Date.now(),
  retentionMs: number = 86_400_000,
): boolean {
  for (const [key, claimedAt] of executionClaims) {
    if (nowMs - claimedAt > retentionMs) executionClaims.delete(key);
  }
  const key = `${marketEventId}|${positionSide}`;
  if (executionClaims.has(key)) {
    metrics.duplicateExecutions++;
    recordIncident({
      type: "DUPLICATE_EXECUTION",
      symbol: marketEventId,
      timeframe: "execution",
      occurredAt: nowMs,
      detail: `execution already claimed for ${positionSide}`,
    });
    return false;
  }
  executionClaims.set(key, nowMs);
  return true;
}

export function releaseMarketEventExecution(
  marketEventId: string,
  positionSide: "LONG" | "SHORT",
): void {
  executionClaims.delete(`${marketEventId}|${positionSide}`);
}

export function getMarketDataQualityStatus() {
  return {
    metrics: { ...metrics },
    incidents: [...recentIncidents],
    activeExecutionClaims: executionClaims.size,
  };
}

export function resetMarketDataQualityState(): void {
  for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) metrics[key] = 0;
  recentIncidents.length = 0;
  executionClaims.clear();
}
