import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  assessCandleBatch,
  canonicalMarketEventId,
  claimMarketEventExecution,
  resetMarketDataQualityState,
} from "../marketDataQuality";

const INTERVAL = 300_000;
const BASE = 1_800_000_000_000;

function candle(openTime: number, overrides: Partial<{
  open: number; high: number; low: number; close: number; volume: number;
}> = {}) {
  return {
    openTime,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 10,
    ...overrides,
  };
}

describe("market data quality", () => {
  beforeEach(() => resetMarketDataQualityState());

  it("uses the same canonical ID across normalized symbol forms", () => {
    assert.equal(
      canonicalMarketEventId("ethusdt", "5M", BASE),
      `md:v1:bingx:ETH-USDT:5m:${BASE}`,
    );
  });

  it("deduplicates, sorts, detects gaps, and excludes incomplete candles", () => {
    const result = assessCandleBatch("ETHUSDT", "5m", [
      candle(BASE + INTERVAL),
      candle(BASE),
      candle(BASE),
      candle(BASE + INTERVAL * 3),
      candle(BASE + INTERVAL * 4),
    ], BASE + INTERVAL * 4 + 1);

    assert.equal(result.duplicateCount, 1);
    assert.equal(result.outOfOrderCount, 1);
    assert.equal(result.missingCount, 1);
    assert.equal(result.incompleteCount, 1);
    assert.deepEqual(
      result.completedCandles.map((row) => row.openTime),
      [BASE, BASE + INTERVAL, BASE + INTERVAL * 3],
    );
  });

  it("rejects impossible and non-finite OHLCV values", () => {
    const result = assessCandleBatch("ETH-USDT", "5m", [
      candle(BASE, { high: 98 }),
      candle(BASE + INTERVAL, { close: Number.NaN }),
    ], BASE + INTERVAL * 3);
    assert.equal(result.invalidCount, 2);
    assert.equal(result.completedCandles.length, 0);
  });

  it("marks old completed candles stale", () => {
    const result = assessCandleBatch(
      "ETH-USDT", "5m", [candle(BASE)], BASE + INTERVAL * 4,
    );
    assert.equal(result.stale, true);
  });

  it("claims a candle-side execution only once", () => {
    const id = canonicalMarketEventId("ETH-USDT", "5m", BASE);
    assert.equal(claimMarketEventExecution(id, "LONG", BASE), true);
    assert.equal(claimMarketEventExecution(id, "LONG", BASE + 1), false);
    assert.equal(claimMarketEventExecution(id, "SHORT", BASE + 1), true);
  });
});
