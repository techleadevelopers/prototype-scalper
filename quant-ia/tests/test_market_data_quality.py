from __future__ import annotations

import math

from core.market_data_quality import (
    SnapshotTracker,
    canonical_market_event_id,
    claim_event,
    reset_quality_state,
    sanitize_candles,
    validate_feature_contract,
)

INTERVAL_MS = 300_000
BASE_MS = 1_800_000_000_000


def candle(open_time: int, **overrides):
    value = {
        "time": open_time,
        "open": "100",
        "high": "102",
        "low": "99",
        "close": "101",
        "volume": "10",
    }
    value.update(overrides)
    return value


def setup_function():
    reset_quality_state()


def test_canonical_event_id_matches_backend_contract():
    assert canonical_market_event_id("ethusdt", "5M", BASE_MS) == (
        f"md:v1:bingx:ETH-USDT:5m:{BASE_MS}"
    )


def test_duplicate_missing_incomplete_and_out_of_order_candles():
    result = sanitize_candles(
        "ETHUSDT",
        "5m",
        [
            candle(BASE_MS + INTERVAL_MS),
            candle(BASE_MS),
            candle(BASE_MS),
            candle(BASE_MS + INTERVAL_MS * 3),
            candle(BASE_MS + INTERVAL_MS * 4),
        ],
        now_ms=BASE_MS + INTERVAL_MS * 4 + 1,
    )
    assert result["duplicates"] == 1
    assert result["outOfOrder"] == 1
    assert result["missing"] == 1
    assert result["incomplete"] == 1
    assert [row["time"] for row in result["completed"]] == [
        BASE_MS,
        BASE_MS + INTERVAL_MS,
        BASE_MS + INTERVAL_MS * 3,
    ]


def test_nan_and_impossible_values_are_rejected():
    result = sanitize_candles(
        "ETH-USDT",
        "5m",
        [
            candle(BASE_MS, high="98"),
            candle(BASE_MS + INTERVAL_MS, close=math.nan),
        ],
        now_ms=BASE_MS + INTERVAL_MS * 3,
    )
    assert result["invalid"] == 2
    assert result["completed"] == []


def test_stale_candles_are_detected():
    result = sanitize_candles(
        "ETH-USDT", "5m", [candle(BASE_MS)], now_ms=BASE_MS + INTERVAL_MS * 4
    )
    assert result["stale"] is True


def test_snapshot_duplicate_out_of_order_gap_and_reconnect_recovery():
    tracker = SnapshotTracker(expected_interval_seconds=5)
    assert tracker.accept("ETH-USDT", 100, now=100).accepted
    assert tracker.accept("ETH-USDT", 100, now=101).duplicate
    assert tracker.accept("ETH-USDT", 99, now=101).out_of_order
    gapped = tracker.accept("ETH-USDT", 120, now=120)
    assert gapped.accepted and gapped.gap_seconds == 20
    recovered = tracker.accept("ETH-USDT", 125, now=125)
    assert recovered.accepted and recovered.recovered


def test_feature_timestamp_and_completion_violations():
    event_id = canonical_market_event_id("ETH-USDT", "5m", BASE_MS)
    rejects = validate_feature_contract({
        "marketEventId": event_id,
        "featureTimestampMs": BASE_MS + 60_000,
        "candleIsComplete": False,
    }, now_ms=BASE_MS)
    assert any("FEATURE_TIMESTAMP_REJECT" in item for item in rejects)
    assert any("CANDLE_INCOMPLETE_REJECT" in item for item in rejects)


def test_duplicate_event_evaluation_is_rejected():
    event_id = canonical_market_event_id("ETH-USDT", "5m", BASE_MS)
    assert claim_event(event_id, "LONG", now=100)
    assert not claim_event(event_id, "LONG", now=101)
    assert claim_event(event_id, "SHORT", now=101)
