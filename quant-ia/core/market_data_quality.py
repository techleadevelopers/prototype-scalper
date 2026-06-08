from __future__ import annotations

import math
import time
from collections import Counter, deque
from dataclasses import dataclass
from typing import Any

TIMEFRAME_SECONDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}

_metrics: Counter[str] = Counter()
_incidents: deque[dict[str, Any]] = deque(maxlen=200)
_event_claims: dict[str, float] = {}


def normalize_symbol(symbol: str) -> str:
    value = str(symbol).strip().upper().replace("_", "-").replace("/", "-")
    if "-" in value:
        return value
    for quote in ("USDT", "USDC", "USD"):
        if value.endswith(quote):
            base = value[: -len(quote)]
            return f"{base}-{'USDT' if quote == 'USD' else quote}"
    return value


def normalize_timeframe(timeframe: str) -> str:
    value = str(timeframe).strip().lower()
    if value not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported timeframe: {timeframe}")
    return value


def canonical_market_event_id(symbol: str, timeframe: str, open_time_ms: int) -> str:
    value = int(open_time_ms)
    if value <= 0:
        raise ValueError(f"Invalid candle open timestamp: {open_time_ms}")
    return f"md:v1:bingx:{normalize_symbol(symbol)}:{normalize_timeframe(timeframe)}:{value}"


def _incident(kind: str, symbol: str, timeframe: str, detail: str, now: float) -> None:
    _metrics[kind.lower()] += 1
    _incidents.append({
        "type": kind,
        "symbol": normalize_symbol(symbol),
        "timeframe": timeframe,
        "occurredAt": now,
        "detail": detail,
    })


def _float(item: dict, *keys: str) -> float:
    for key in keys:
        if key in item:
            return float(item[key])
    return math.nan


def _open_time_ms(item: dict) -> int:
    for key in ("time", "openTime", "open_time", "timestamp"):
        if key in item:
            value = float(item[key])
            return int(value * 1000 if value < 10_000_000_000 else value)
    return 0


def sanitize_candles(
    symbol: str,
    timeframe: str,
    rows: list[dict],
    now_ms: int | None = None,
    stale_after_intervals: int = 2,
) -> dict[str, Any]:
    tf = normalize_timeframe(timeframe)
    interval_ms = TIMEFRAME_SECONDS[tf] * 1000
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    out_of_order = sum(
        1 for left, right in zip(rows, rows[1:])
        if _open_time_ms(right) < _open_time_ms(left)
    )
    unique: dict[int, dict] = {}
    duplicates = 0
    invalid = 0
    for row in rows:
        try:
            open_time = _open_time_ms(row)
            open_price = _float(row, "open", "o")
            high = _float(row, "high", "h")
            low = _float(row, "low", "l")
            close = _float(row, "close", "c")
            volume = _float(row, "volume", "vol", "v")
            values = (open_price, high, low, close, volume)
            valid = (
                open_time > 0
                and open_time % interval_ms == 0
                and all(math.isfinite(value) for value in values)
                and min(open_price, high, low, close) > 0
                and volume >= 0
                and high >= max(open_price, close, low)
                and low <= min(open_price, close, high)
            )
        except (TypeError, ValueError):
            valid = False
            open_time = 0
        if not valid:
            invalid += 1
            continue
        if open_time in unique:
            duplicates += 1
        normalized = dict(row)
        normalized["time"] = open_time
        normalized["marketEventId"] = canonical_market_event_id(symbol, tf, open_time)
        normalized["candleIsComplete"] = open_time + interval_ms <= now_ms
        unique[open_time] = normalized

    candles = [unique[key] for key in sorted(unique)]
    missing = 0
    for left, right in zip(candles, candles[1:]):
        delta = int(right["time"]) - int(left["time"])
        if delta > interval_ms:
            missing += max(0, round(delta / interval_ms) - 1)
    completed = [row for row in candles if row["candleIsComplete"]]
    incomplete = len(candles) - len(completed)
    freshness_ms = (
        max(0, now_ms - (int(completed[-1]["time"]) + interval_ms))
        if completed else math.inf
    )
    stale = not completed or freshness_ms > interval_ms * stale_after_intervals

    now = now_ms / 1000
    for kind, count in (
        ("DUPLICATE", duplicates),
        ("GAP", missing),
        ("OUT_OF_ORDER", out_of_order),
        ("INVALID_VALUE", invalid),
        ("INCOMPLETE", incomplete),
        ("STALE", int(stale)),
    ):
        if count:
            _incident(kind, symbol, tf, f"count={count}", now)
    _metrics["candle_batches"] += 1
    _metrics["accepted_candles"] += len(completed)
    return {
        "candles": candles,
        "completed": completed,
        "duplicates": duplicates,
        "missing": missing,
        "outOfOrder": out_of_order,
        "invalid": invalid,
        "incomplete": incomplete,
        "freshnessMs": freshness_ms,
        "stale": stale,
    }


@dataclass
class SnapshotDecision:
    accepted: bool
    duplicate: bool = False
    out_of_order: bool = False
    gap_seconds: float = 0.0
    freshness_seconds: float = 0.0
    recovered: bool = False


class SnapshotTracker:
    def __init__(self, expected_interval_seconds: float = 15.0):
        self.expected_interval_seconds = expected_interval_seconds
        self.last_timestamp: dict[str, float] = {}
        self.gapped: set[str] = set()

    def accept(self, symbol: str, source_timestamp: float, now: float | None = None) -> SnapshotDecision:
        now = time.time() if now is None else float(now)
        sym = normalize_symbol(symbol)
        ts = float(source_timestamp)
        if not math.isfinite(ts) or ts <= 0 or ts > now + 2:
            _incident("TIMESTAMP_VIOLATION", sym, "snapshot", f"source_timestamp={ts}", now)
            return SnapshotDecision(False)
        previous = self.last_timestamp.get(sym)
        if previous is not None and ts == previous:
            _incident("DUPLICATE", sym, "snapshot", f"timestamp={ts}", now)
            return SnapshotDecision(False, duplicate=True)
        if previous is not None and ts < previous:
            _incident("OUT_OF_ORDER", sym, "snapshot", f"{ts} < {previous}", now)
            return SnapshotDecision(False, out_of_order=True)
        gap = max(0.0, ts - previous) if previous is not None else 0.0
        is_gap = gap > self.expected_interval_seconds * 2
        recovered = sym in self.gapped and not is_gap
        if is_gap:
            self.gapped.add(sym)
            _incident("GAP", sym, "snapshot", f"gap_seconds={gap:.3f}", now)
        elif recovered:
            self.gapped.remove(sym)
            _incident("RECOVERED", sym, "snapshot", "continuity restored", now)
        self.last_timestamp[sym] = ts
        freshness = max(0.0, now - ts)
        if freshness > self.expected_interval_seconds * 2:
            _incident("STALE", sym, "snapshot", f"freshness_seconds={freshness:.3f}", now)
        _metrics["accepted_snapshots"] += 1
        return SnapshotDecision(True, gap_seconds=gap, freshness_seconds=freshness, recovered=recovered)


def validate_feature_contract(payload: dict[str, Any], now_ms: int | None = None) -> list[str]:
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    rejects: list[str] = []
    event_id = payload.get("marketEventId")
    feature_ts = payload.get("featureTimestampMs")
    if event_id and not str(event_id).startswith("md:v1:bingx:"):
        rejects.append("MARKET_EVENT_ID_REJECT: non-canonical market event id")
    if payload.get("candleIsComplete") is False:
        rejects.append("CANDLE_INCOMPLETE_REJECT: feature candle is unfinished")
    if feature_ts is not None:
        try:
            timestamp = int(feature_ts)
            if timestamp > now_ms + 2_000:
                rejects.append("FEATURE_TIMESTAMP_REJECT: feature timestamp is in the future")
            if now_ms - timestamp > 10 * 60_000:
                rejects.append("FEATURE_STALE_REJECT: feature timestamp is stale")
        except (TypeError, ValueError):
            rejects.append("FEATURE_TIMESTAMP_REJECT: feature timestamp is invalid")
    elif event_id:
        rejects.append("FEATURE_TIMESTAMP_REJECT: feature timestamp is missing")
    return rejects


def claim_event(event_id: str, side: str, now: float | None = None, ttl_seconds: float = 86400) -> bool:
    now = time.time() if now is None else float(now)
    for key, claimed_at in list(_event_claims.items()):
        if now - claimed_at > ttl_seconds:
            del _event_claims[key]
    key = f"{event_id}|{side}"
    if key in _event_claims:
        _incident("DUPLICATE_EXECUTION", event_id, "edge", side, now)
        return False
    _event_claims[key] = now
    return True


def quality_status() -> dict[str, Any]:
    return {
        "metrics": dict(_metrics),
        "incidents": list(_incidents),
        "activeEventClaims": len(_event_claims),
    }


def reset_quality_state() -> None:
    _metrics.clear()
    _incidents.clear()
    _event_claims.clear()
