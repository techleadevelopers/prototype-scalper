from __future__ import annotations

import math
import time
from typing import Any

from core.feature_engine import FeatureEngine


_state: dict[str, Any] = {
    "lastRunAt": 0.0,
    "lastError": None,
    "cycles": 0,
    "symbols": {},
}


def candle_regime_status() -> dict[str, Any]:
    return dict(_state)


def _f(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _close(candle: dict) -> float:
    return _f(candle.get("close", candle.get("c", 0)))


def _volume(candle: dict) -> float:
    return _f(candle.get("volume", candle.get("vol", 0)))


def _pct(first: float, last: float) -> float:
    return ((last - first) / first * 100) if first > 0 else 0.0


def _ema(values: list[float], period: int) -> float:
    if not values:
        return 0.0
    if len(values) < period:
        return values[-1]
    k = 2 / (period + 1)
    ema = values[0]
    for value in values[1:]:
        ema = value * k + ema * (1 - k)
    return ema


def _frame_features(candles: list[dict], lookback: int) -> dict[str, Any]:
    recent = candles[-lookback:] if len(candles) >= lookback else candles
    closes = [_close(c) for c in recent if _close(c) > 0]
    volumes = [_volume(c) for c in recent if _volume(c) >= 0]
    if len(closes) < 3:
        return {"quality": "NO_DATA", "movePct": 0.0, "trend": "NEUTRAL", "slope": 0.0, "volumeRatio": 0.0}

    move = _pct(closes[0], closes[-1])
    ema_fast = _ema(closes, min(9, max(3, len(closes) // 3)))
    ema_slow = _ema(closes, min(21, max(5, len(closes))))
    slope = _pct(closes[max(0, len(closes) - 4)], closes[-1])
    avg_vol = sum(volumes[:-1]) / max(1, len(volumes) - 1) if len(volumes) > 1 else 0.0
    vol_ratio = volumes[-1] / avg_vol if avg_vol > 0 else 0.0
    volatility = math.sqrt(sum((x - sum(closes) / len(closes)) ** 2 for x in closes) / len(closes)) / closes[-1] * 100

    if ema_fast > ema_slow and slope > 0:
        trend = "BULL"
    elif ema_fast < ema_slow and slope < 0:
        trend = "BEAR"
    else:
        trend = "NEUTRAL"

    return {
        "quality": "OK",
        "movePct": round(move, 4),
        "trend": trend,
        "slope": round(slope, 4),
        "volumeRatio": round(vol_ratio, 4),
        "volatilityPct": round(volatility, 4),
        "emaFast": round(ema_fast, 6),
        "emaSlow": round(ema_slow, 6),
    }


def _combine(symbol: str, f1h: dict, f4h: dict, f1d: dict) -> dict[str, Any]:
    bull_votes = sum(1 for f in (f1h, f4h, f1d) if f.get("trend") == "BULL")
    bear_votes = sum(1 for f in (f1h, f4h, f1d) if f.get("trend") == "BEAR")
    if bull_votes >= 2:
        bias = "LONG"
    elif bear_votes >= 2:
        bias = "SHORT"
    else:
        bias = "NEUTRAL"

    one_hour_move = float(f1h.get("movePct", 0) or 0)
    four_hour_move = float(f4h.get("movePct", 0) or 0)
    daily_move = float(f1d.get("movePct", 0) or 0)
    correction_risk = 0.0
    if abs(one_hour_move) >= 1.0:
        correction_risk += 0.25
    if abs(four_hour_move) >= 2.0:
        correction_risk += 0.25
    if abs(daily_move) >= 5.0:
        correction_risk += 0.25
    if f1h.get("trend") != f4h.get("trend"):
        correction_risk += 0.20
    if float(f1h.get("volumeRatio", 0) or 0) < 0.8 and abs(one_hour_move) > 0.8:
        correction_risk += 0.15

    correction_risk = round(min(1.0, correction_risk), 4)
    trend_score = round((bull_votes - bear_votes) / 3, 4)
    action = "SCALP_WITH_TREND"
    if correction_risk >= 0.7:
        action = "WAIT_CORRECTION"
    elif bias == "NEUTRAL":
        action = "RANGE_ONLY"

    return {
        "symbol": symbol,
        "generatedAt": time.time(),
        "bias": bias,
        "trendScore": trend_score,
        "correctionRisk": correction_risk,
        "action": action,
        "frames": {"1h": f1h, "4h": f4h, "1d": f1d},
    }


async def analyze_macro_candle_regime(engine: FeatureEngine, symbols: list[str]) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for symbol in symbols:
        sym = symbol if symbol.endswith("-USDT") else f"{symbol}-USDT"
        candles_1h = await engine.fetch_klines(sym, "1h", 80)
        candles_4h = await engine.fetch_klines(sym, "4h", 80)
        candles_1d = await engine.fetch_klines(sym, "1d", 60)
        results[sym] = _combine(
            sym,
            _frame_features(candles_1h, 24),
            _frame_features(candles_4h, 30),
            _frame_features(candles_1d, 30),
        )

    _state.update({
        "lastRunAt": time.time(),
        "lastError": None,
        "cycles": int(_state["cycles"]) + 1,
        "symbols": results,
    })
    return {"count": len(results), "symbols": results}
