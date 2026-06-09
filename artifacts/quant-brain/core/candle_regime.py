from __future__ import annotations

import asyncio
import math
import os
import time
from typing import Any

import httpx

from core.async_utils import run_blocking
from core.feature_engine import FeatureEngine

# ── Microframe constants ──────────────────────────────────────────────────────
_BINGX_KLINES_URL = "https://open-api.bingx.com/openApi/swap/v2/quote/klines"
_MICROFRAME_HTTP_TIMEOUT = 4.0
_TRIGGER_EXPIRATION_SECONDS = int(os.environ.get("TRIGGER_EXPIRATION_SECONDS", "45"))


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
    async def fetch_symbol(symbol: str) -> tuple[str, dict[str, Any]]:
        sym = symbol if symbol.endswith("-USDT") else f"{symbol}-USDT"
        candles_1h, candles_4h, candles_1d = await asyncio.gather(
            engine.fetch_klines(sym, "1h", 80),
            engine.fetch_klines(sym, "4h", 80),
            engine.fetch_klines(sym, "1d", 60),
        )
        f1h, f4h, f1d = await asyncio.gather(
            run_blocking(_frame_features, candles_1h, 24),
            run_blocking(_frame_features, candles_4h, 30),
            run_blocking(_frame_features, candles_1d, 30),
        )
        return sym, _combine(
            sym,
            f1h,
            f4h,
            f1d,
        )

    pairs = await asyncio.gather(*[fetch_symbol(symbol) for symbol in symbols])
    results = dict(pairs)

    _state.update({
        "lastRunAt": time.time(),
        "lastError": None,
        "cycles": int(_state["cycles"]) + 1,
        "symbols": results,
    })
    return {"count": len(results), "symbols": results}


# =====================================================================
# MICROFRAME INTELLIGENCE — Análise 1m/5m/15m + Detecção de Exaustão
# =====================================================================
# Cadência dupla conforme arquitetura de gatilho de exaustão:
#   · Loop de microestrutura: 15s (shadow_sampler contínuo)
#   · Atualização por fechamento de candle: 1m/5m/15m
#
# Detecta:
#   · Exaustão de vendedores (sell exhaustion) → gatilho LONG
#   · Exaustão de compradores (buy exhaustion) → gatilho SHORT
#
# O triggerPrice é calculado a partir do desvio padrão de 1m para
# capturar a "faca caindo" ou o "pavio superior" no ponto matemático
# exato da reversão.
# =====================================================================


async def _fetch_klines_standalone(symbol: str, interval: str, limit: int) -> list[dict]:
    """Busca klines via HTTP direto — não requer FeatureEngine."""
    try:
        async with httpx.AsyncClient(timeout=_MICROFRAME_HTTP_TIMEOUT) as client:
            r = await client.get(
                _BINGX_KLINES_URL,
                params={"symbol": symbol, "interval": interval, "limit": str(limit)},
            )
            data = r.json()
            if data.get("code") != 0:
                return []
            result = data.get("data", [])
            return [c for c in result if isinstance(c, dict)] if isinstance(result, list) else []
    except Exception:
        return []


def _high(candle: dict) -> float:
    return _f(candle.get("high", candle.get("h", 0)))


def _low(candle: dict) -> float:
    return _f(candle.get("low", candle.get("l", 0)))


def _open_price(candle: dict) -> float:
    return _f(candle.get("open", candle.get("o", 0)))


def _bollinger_bands(candles: list[dict], period: int = 20) -> dict[str, Any]:
    """Bollinger Bands (período=20, 2σ) a partir dos fechamentos de 1m."""
    closes = [_close(c) for c in candles if _close(c) > 0]
    if len(closes) < period:
        return {"upper": 0.0, "middle": 0.0, "lower": 0.0, "width": 0.0,
                "position": 0.5, "quality": "INSUFFICIENT_DATA"}
    recent = closes[-period:]
    middle = sum(recent) / period
    variance = sum((x - middle) ** 2 for x in recent) / period
    std = math.sqrt(variance)
    upper = middle + 2 * std
    lower = middle - 2 * std
    width = (upper - lower) / middle * 100 if middle > 0 else 0.0
    current = closes[-1]
    position = (current - lower) / (upper - lower) if (upper - lower) > 0 else 0.5
    return {
        "upper": round(upper, 6),
        "middle": round(middle, 6),
        "lower": round(lower, 6),
        "width": round(width, 4),
        "position": round(max(0.0, min(1.0, position)), 4),
        "quality": "OK",
    }


def _vwap_approx(candles: list[dict]) -> float:
    """VWAP = Σ(preço_típico × volume) / Σ(volume) — aproximação de 1m."""
    total_pv = 0.0
    total_v = 0.0
    for c in candles:
        h = _high(c)
        lo = _low(c)
        cl = _close(c)
        vol = _volume(c)
        if h > 0 and lo > 0 and cl > 0 and vol > 0:
            typical = (h + lo + cl) / 3.0
            total_pv += typical * vol
            total_v += vol
    return total_pv / total_v if total_v > 0 else 0.0


def _pivot_levels(candles: list[dict], lookback: int = 3) -> tuple[float, float]:
    """Detecta pivôs de alta/baixa para construção dos níveis S/R."""
    if len(candles) < lookback * 2 + 1:
        highs = [_high(c) for c in candles if _high(c) > 0]
        lows = [_low(c) for c in candles if _low(c) > 0]
        return (max(highs) if highs else 0.0, min(lows) if lows else 0.0)
    highs = [_high(c) for c in candles]
    lows = [_low(c) for c in candles]
    pivot_highs: list[float] = []
    pivot_lows: list[float] = []
    for i in range(lookback, len(candles) - lookback):
        h = highs[i]
        lo = lows[i]
        if h > 0 and all(h >= highs[j] for j in range(i - lookback, i + lookback + 1) if j != i):
            pivot_highs.append(h)
        if lo > 0 and all(lo <= lows[j] for j in range(i - lookback, i + lookback + 1) if j != i):
            pivot_lows.append(lo)
    resistance = max(pivot_highs[-3:]) if pivot_highs else (max(h for h in highs[-20:] if h > 0) if any(h > 0 for h in highs[-20:]) else 0.0)
    support = min(pivot_lows[-3:]) if pivot_lows else (min(lo for lo in lows[-20:] if lo > 0) if any(lo > 0 for lo in lows[-20:]) else 0.0)
    return resistance, support


def _support_resistance(candles_5m: list[dict], candles_15m: list[dict]) -> dict[str, Any]:
    """Níveis compostos de suporte/resistência a partir de pivôs de 5m e 15m."""
    r5m, s5m = _pivot_levels(candles_5m, lookback=3)
    r15m, s15m = _pivot_levels(candles_15m, lookback=3)
    resistance = (r5m + r15m) / 2 if r5m > 0 and r15m > 0 else (r5m or r15m)
    support = (s5m + s15m) / 2 if s5m > 0 and s15m > 0 else (s5m or s15m)
    return {
        "resistance": round(resistance, 6),
        "support": round(support, 6),
        "resistance5m": round(r5m, 6),
        "support5m": round(s5m, 6),
        "resistance15m": round(r15m, 6),
        "support15m": round(s15m, 6),
    }


def _wick_ratios(candle: dict) -> dict[str, float]:
    """Ratios de pavio superior/inferior para detectar velas de exaustão."""
    o = _open_price(candle)
    h = _high(candle)
    lo = _low(candle)
    c = _close(candle)
    if h <= lo or h == 0:
        return {"upperWickRatio": 0.0, "lowerWickRatio": 0.0,
                "bodyRatio": 0.0, "totalRange": 0.0}
    total_range = h - lo
    body = abs(c - o)
    upper_wick = h - max(o, c)
    lower_wick = min(o, c) - lo
    return {
        "upperWickRatio": round(upper_wick / total_range, 4),
        "lowerWickRatio": round(lower_wick / total_range, 4),
        "bodyRatio": round(body / total_range, 4),
        "totalRange": round(total_range, 8),
    }


def _detect_sell_exhaustion(
    candles_1m: list[dict],
    sr: dict[str, Any],
    f1m: dict[str, Any],
    f5m: dict[str, Any],
    f15m: dict[str, Any],
    bb: dict[str, Any],
) -> dict[str, Any]:
    """
    Detecta exaustão de vendedores para gatilho de entrada LONG.

    Condições de confirmação:
      1. Pavio inferior dominante (≥40% do range) nos últimos 3 candles de 1m
         → vendedores tentaram empurrar abaixo mas foram absorvidos
      2. Slope de 1m negativo (vendedores queimando combustível)
      3. Volume elevado (vol_ratio > 1.2 — pressão vendedora acima da média)
      4. Preço próximo do suporte de 5m/15m (< 0.6% de distância)
         OU posição abaixo da banda inferior de Bollinger (extremo estatístico)
      5. Contexto 5m/15m não fortemente bearish (contra-tendência, não continuação)
    """
    if len(candles_1m) < 5:
        return {"detected": False, "score": 0.0, "reasons": ["insufficient_data"],
                "dominantLowerWick": False}

    score = 0.0
    reasons: list[str] = []
    dominant_lower_wick = False

    for c in candles_1m[-3:]:
        wr = _wick_ratios(c)
        if wr["lowerWickRatio"] > 0.40:
            dominant_lower_wick = True
            score += 0.30
            reasons.append(f"lower_wick={wr['lowerWickRatio']:.2f}")
            break

    slope_1m = float(f1m.get("slope", 0.0))
    if slope_1m < -0.03:
        score += 0.20
        reasons.append(f"neg_slope_1m={slope_1m:.4f}")

    vol_ratio = float(f1m.get("volumeRatio", 1.0))
    if vol_ratio > 1.2:
        score += 0.15
        reasons.append(f"vol_ratio={vol_ratio:.2f}")

    current_price = _close(candles_1m[-1])
    support = float(sr.get("support", 0.0))
    if support > 0 and current_price > 0:
        dist_pct = abs((current_price - support) / support * 100)
        if dist_pct < 0.6:
            score += 0.25
            reasons.append(f"near_support={dist_pct:.3f}%")

    bb_pos = float(bb.get("position", 0.5))
    if bb_pos < 0.15:
        score += 0.20
        reasons.append(f"bb_oversold={bb_pos:.3f}")

    slope_5m = float(f5m.get("slope", 0.0))
    slope_15m = float(f15m.get("slope", 0.0))
    if -0.8 < slope_5m < 0.3 or -0.5 < slope_15m < 0.2:
        score += 0.10
        reasons.append(f"counter_trend:5m={slope_5m:.3f}")

    detected = score >= 0.45 and dominant_lower_wick
    return {"detected": detected, "score": round(score, 4),
            "reasons": reasons, "dominantLowerWick": dominant_lower_wick}


def _detect_buy_exhaustion(
    candles_1m: list[dict],
    sr: dict[str, Any],
    f1m: dict[str, Any],
    f5m: dict[str, Any],
    f15m: dict[str, Any],
    bb: dict[str, Any],
) -> dict[str, Any]:
    """
    Detecta exaustão de compradores para gatilho de entrada SHORT.

    Condições de confirmação:
      1. Pavio superior dominante (≥40% do range) nos últimos 3 candles de 1m
         → compradores tentaram subir mas foram rejeitados
      2. Slope de 1m positivo (compradores queimando combustível)
      3. Volume elevado (vol_ratio > 1.2)
      4. Preço próximo da resistência de 5m/15m (< 0.6%)
         OU posição acima da banda superior de Bollinger
      5. Contexto 5m/15m não fortemente bullish
    """
    if len(candles_1m) < 5:
        return {"detected": False, "score": 0.0, "reasons": ["insufficient_data"],
                "dominantUpperWick": False}

    score = 0.0
    reasons: list[str] = []
    dominant_upper_wick = False

    for c in candles_1m[-3:]:
        wr = _wick_ratios(c)
        if wr["upperWickRatio"] > 0.40:
            dominant_upper_wick = True
            score += 0.30
            reasons.append(f"upper_wick={wr['upperWickRatio']:.2f}")
            break

    slope_1m = float(f1m.get("slope", 0.0))
    if slope_1m > 0.03:
        score += 0.20
        reasons.append(f"pos_slope_1m={slope_1m:.4f}")

    vol_ratio = float(f1m.get("volumeRatio", 1.0))
    if vol_ratio > 1.2:
        score += 0.15
        reasons.append(f"vol_ratio={vol_ratio:.2f}")

    current_price = _close(candles_1m[-1])
    resistance = float(sr.get("resistance", 0.0))
    if resistance > 0 and current_price > 0:
        dist_pct = abs((resistance - current_price) / resistance * 100)
        if dist_pct < 0.6:
            score += 0.25
            reasons.append(f"near_resistance={dist_pct:.3f}%")

    bb_pos = float(bb.get("position", 0.5))
    if bb_pos > 0.85:
        score += 0.20
        reasons.append(f"bb_overbought={bb_pos:.3f}")

    slope_5m = float(f5m.get("slope", 0.0))
    slope_15m = float(f15m.get("slope", 0.0))
    if -0.3 < slope_5m < 0.8 or -0.2 < slope_15m < 0.5:
        score += 0.10
        reasons.append(f"counter_trend:5m={slope_5m:.3f}")

    detected = score >= 0.45 and dominant_upper_wick
    return {"detected": detected, "score": round(score, 4),
            "reasons": reasons, "dominantUpperWick": dominant_upper_wick}


async def analyze_microframe_regime(symbol: str) -> dict[str, Any]:
    """
    Análise multiframe 1m/5m/15m com detecção de exaustão cirúrgica.

    Fórmula RS_multiframe ponderada por velocidade:
        RS = 0.50 × slope_1m + 0.30 × slope_5m + 0.20 × slope_15m

    Também calcula RS do BTC para contexto de mercado global.

    Retorna:
        executionType   "TRIGGER_LIMIT" | "MARKET"
        exhaustionType  "SELL_EXHAUSTION" | "BUY_EXHAUSTION" | "NONE"
        triggerPrice    preço geométrico do gatilho (abaixo p/ LONG, acima p/ SHORT)
        triggerExpirationSeconds  TTL do gatilho (padrão: TRIGGER_EXPIRATION_SECONDS env)
        rsMicroframe    escalar RS ponderado do ativo
        btcRsMicroframe escalar RS ponderado do BTC
        stdDev1m        desvio padrão dos últimos 10 fechamentos de 1m
        bollingerBands  BB de 1m (20 períodos, 2σ)
        vwap / vwapDeviationPct
        supportResistance  níveis pivô de 5m+15m
        exhaustionSell / exhaustionBuy
        frames          dados brutos por timeframe
    """
    sym = symbol if symbol.endswith("-USDT") else f"{symbol}-USDT"

    # Busca paralela: ativo + BTC em 1m/5m/15m (6 chamadas simultâneas)
    results = await asyncio.gather(
        _fetch_klines_standalone(sym, "1m", 60),
        _fetch_klines_standalone(sym, "5m", 48),
        _fetch_klines_standalone(sym, "15m", 40),
        _fetch_klines_standalone("BTC-USDT", "1m", 60),
        _fetch_klines_standalone("BTC-USDT", "5m", 48),
        _fetch_klines_standalone("BTC-USDT", "15m", 40),
        return_exceptions=True,
    )

    def _safe(x: Any) -> list[dict]:
        return x if isinstance(x, list) else []

    candles_1m = _safe(results[0])
    candles_5m = _safe(results[1])
    candles_15m = _safe(results[2])
    btc_1m = _safe(results[3])
    btc_5m = _safe(results[4])
    btc_15m = _safe(results[5])

    # Características por timeframe
    f1m = _frame_features(candles_1m, 20)
    f5m = _frame_features(candles_5m, 24)
    f15m = _frame_features(candles_15m, 20)
    btc_f1m = _frame_features(btc_1m, 20)
    btc_f5m = _frame_features(btc_5m, 24)
    btc_f15m = _frame_features(btc_15m, 20)

    # Vetor RS_multiframe ponderado
    rs_multiframe = (
        0.50 * float(f1m.get("slope", 0.0)) +
        0.30 * float(f5m.get("slope", 0.0)) +
        0.20 * float(f15m.get("slope", 0.0))
    )
    btc_rs = (
        0.50 * float(btc_f1m.get("slope", 0.0)) +
        0.30 * float(btc_f5m.get("slope", 0.0)) +
        0.20 * float(btc_f15m.get("slope", 0.0))
    )

    current_price = _close(candles_1m[-1]) if candles_1m else 0.0

    # Bollinger Bands de 1m — detecta extremos estatísticos
    bb = _bollinger_bands(candles_1m, period=20)

    # VWAP de 1m — referência de equilíbrio intraday
    vwap = _vwap_approx(candles_1m)
    vwap_dev_pct = ((current_price - vwap) / vwap * 100) if vwap > 0 else 0.0

    # Suporte/Resistência compostos de 5m+15m
    sr = _support_resistance(candles_5m, candles_15m)

    # Desvio padrão dos últimos 10 fechamentos de 1m — determina a largura do gatilho
    recent_closes = [_close(c) for c in candles_1m[-10:] if _close(c) > 0]
    if len(recent_closes) >= 3:
        mean_c = sum(recent_closes) / len(recent_closes)
        std_dev_1m = math.sqrt(sum((x - mean_c) ** 2 for x in recent_closes) / len(recent_closes))
    else:
        std_dev_1m = current_price * 0.001  # fallback: 0.1% do preço atual

    # Detecção de exaustão (sell = LONG trigger, buy = SHORT trigger)
    exhaustion_sell = _detect_sell_exhaustion(candles_1m, sr, f1m, f5m, f15m, bb)
    exhaustion_buy = _detect_buy_exhaustion(candles_1m, sr, f1m, f5m, f15m, bb)

    # Determina tipo de execução e preço de gatilho
    execution_type = "MARKET"
    trigger_price: float | None = None
    exhaustion_type = "NONE"

    if exhaustion_sell["detected"]:
        # LONG: faca caindo → gatilho 0.5σ abaixo do preço atual
        # Captura a reversão no ponto matemático exato de exaustão dos vendedores
        trigger_price = round(current_price - std_dev_1m * 0.5, 6)
        execution_type = "TRIGGER_LIMIT"
        exhaustion_type = "SELL_EXHAUSTION"
    elif exhaustion_buy["detected"]:
        # SHORT: pavio superior → gatilho 0.5σ acima do preço atual
        # Captura a rejeição no ponto matemático exato de exaustão dos compradores
        trigger_price = round(current_price + std_dev_1m * 0.5, 6)
        execution_type = "TRIGGER_LIMIT"
        exhaustion_type = "BUY_EXHAUSTION"

    return {
        "symbol": sym,
        "currentPrice": current_price,
        "generatedAt": time.time(),
        "executionType": execution_type,
        "exhaustionType": exhaustion_type,
        "triggerPrice": trigger_price,
        "triggerExpirationSeconds": _TRIGGER_EXPIRATION_SECONDS,
        "rsMicroframe": round(rs_multiframe, 6),
        "btcRsMicroframe": round(btc_rs, 6),
        "stdDev1m": round(std_dev_1m, 8),
        "bollingerBands": bb,
        "vwap": round(vwap, 6),
        "vwapDeviationPct": round(vwap_dev_pct, 4),
        "supportResistance": sr,
        "exhaustionSell": exhaustion_sell,
        "exhaustionBuy": exhaustion_buy,
        "frames": {
            "1m": f1m,
            "5m": f5m,
            "15m": f15m,
            "btc1m": btc_f1m,
            "btc5m": btc_f5m,
            "btc15m": btc_f15m,
        },
    }
