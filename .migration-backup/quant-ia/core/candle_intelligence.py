from __future__ import annotations

import time
import math
from typing import Any


def _pct(first: float, last: float) -> float:
    if first <= 0:
        return 0.0
    return (last - first) / first * 100


def _ema(values: list[float], period: int) -> float:
    vals = [v for v in values if v > 0]
    if not vals:
        return 0.0
    k = 2 / (period + 1)
    ema = vals[0]
    for value in vals[1:]:
        ema = value * k + ema * (1 - k)
    return ema


def _rsi(prices: list[float], period: int = 14) -> float:
    """RSI clássico para confirmação de sobrecompra/sobrevenda."""
    if len(prices) < period + 1:
        return 50.0

    gains = []
    losses = []

    for i in range(1, len(prices)):
        change = prices[i] - prices[i-1]
        if change > 0:
            gains.append(change)
            losses.append(0)
        else:
            gains.append(0)
            losses.append(abs(change))

    if len(gains) < period:
        return 50.0

    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period

    if avg_loss == 0:
        return 100.0

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))

    return rsi


def _vwap(history: list[dict[str, Any]]) -> float:
    """
    Volume Weighted Average Price - referência institucional.
    Extraído de fóruns quant: VWAP é usado por funds para executar ordens grandes.
    """
    cumulative_pv = 0.0
    cumulative_volume = 0.0

    for h in history:
        price = h.get("price", 0)
        volume_ratio = h.get("volume_ratio", 1)
        if price > 0:
            # Simula volume baseado no volume_ratio
            volume = max(1, volume_ratio * 1000)
            cumulative_pv += price * volume
            cumulative_volume += volume

    if cumulative_volume == 0:
        return 0.0

    return cumulative_pv / cumulative_volume


def _calculate_volume_profile(history: list[dict[str, Any]], n_bins: int = 10) -> dict[str, Any]:
    """
    Volume Profile - detecta níveis de alto volume (POC - Point of Control).
    Técnica de fóruns: identificar onde o volume foi mais alto.
    """
    if len(history) < 20:
        return {"poc": 0.0, "value_area_high": 0.0, "value_area_low": 0.0, "quality": "INSUFFICIENT"}

    prices = []
    volumes = []

    for h in history:
        price = h.get("price", 0)
        volume_ratio = h.get("volume_ratio", 1)
        if price > 0:
            prices.append(price)
            volumes.append(volume_ratio * 1000)

    if not prices:
        return {"poc": 0.0, "value_area_high": 0.0, "value_area_low": 0.0, "quality": "NO_DATA"}

    price_min = min(prices)
    price_max = max(prices)
    bin_size = (price_max - price_min) / n_bins

    if bin_size == 0:
        return {"poc": prices[0], "value_area_high": prices[0], "value_area_low": prices[0], "quality": "FLAT"}

    bins = [0] * n_bins
    for price, volume in zip(prices, volumes):
        bin_idx = min(int((price - price_min) / bin_size), n_bins - 1)
        bins[bin_idx] += volume

    poc_idx = bins.index(max(bins)) if bins else 0
    poc_price = price_min + (poc_idx + 0.5) * bin_size

    # Value Area (70% do volume)
    total_volume = sum(bins)
    value_area_volume = total_volume * 0.7
    cum_volume = 0

    # Expande do POC para baixo e para cima
    value_area_low_idx = poc_idx
    value_area_high_idx = poc_idx

    while cum_volume < value_area_volume and (value_area_low_idx > 0 or value_area_high_idx < n_bins - 1):
        left_volume = bins[value_area_low_idx - 1] if value_area_low_idx > 0 else 0
        right_volume = bins[value_area_high_idx + 1] if value_area_high_idx < n_bins - 1 else 0

        if left_volume > right_volume:
            value_area_low_idx -= 1
            cum_volume += left_volume
        else:
            value_area_high_idx += 1
            cum_volume += right_volume

    value_area_low = price_min + value_area_low_idx * bin_size
    value_area_high = price_min + (value_area_high_idx + 1) * bin_size

    # Distância do preço atual para o POC
    current_price = prices[-1] if prices else 0
    distance_to_poc_pct = abs(current_price - poc_price) / poc_price * 100 if poc_price > 0 else 0

    return {
        "poc": round(poc_price, 8),
        "value_area_high": round(value_area_high, 8),
        "value_area_low": round(value_area_low, 8),
        "distance_to_poc_pct": round(distance_to_poc_pct, 2),
        "quality": "GOOD" if len(prices) >= 30 else "PARTIAL"
    }


def _detect_market_microstructure(history: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Detecção avançada de microestrutura de mercado.
    Baseado em papers acadêmicos e fóruns quant:
    - Tick imbalance
    - Order flow toxicity (VPIN)
    - Spread dynamics
    """
    if len(history) < 20:
        return {"toxicity": 0.0, "tick_imbalance": 0.0, "spread_squeeze": False, "quality": "INSUFFICIENT"}

    # Tick imbalance (direction based on price changes)
    up_ticks = 0
    down_ticks = 0
    zero_ticks = 0

    for i in range(1, len(history)):
        prev_price = history[i-1].get("price", 0)
        curr_price = history[i].get("price", 0)
        if prev_price > 0 and curr_price > 0:
            if curr_price > prev_price:
                up_ticks += 1
            elif curr_price < prev_price:
                down_ticks += 1
            else:
                zero_ticks += 1

    total_ticks = up_ticks + down_ticks + zero_ticks
    if total_ticks > 0:
        tick_imbalance = (up_ticks - down_ticks) / total_ticks
    else:
        tick_imbalance = 0.0

    # Order flow toxicity (simplified VPIN)
    # Volume acima da média + tick imbalance pode indicar toxic flow
    volumes = [h.get("volume_ratio", 1) for h in history]
    avg_volume = sum(volumes) / len(volumes) if volumes else 1
    current_volume = volumes[-1] if volumes else 1

    volume_surge = current_volume > avg_volume * 1.5
    toxicity = 0.0

    if volume_surge and abs(tick_imbalance) > 0.3:
        # Volume alto com tick imbalance forte = ordem agressiva
        toxicity = min(0.9, 0.5 + abs(tick_imbalance) * 0.8)
    elif volume_surge and abs(tick_imbalance) < 0.1:
        # Volume alto sem direção = absorção (pode ser acumulação)
        toxicity = 0.2

    # Spread squeeze detection
    spreads = [h.get("spread_bps", 0) for h in history[-10:]]
    if len(spreads) >= 5:
        recent_spreads = spreads[-5:]
        avg_recent_spread = sum(recent_spreads) / len(recent_spreads)
        historical_spreads = spreads[:-5]
        if historical_spreads:
            avg_historical_spread = sum(historical_spreads) / len(historical_spreads)
            spread_squeeze = avg_recent_spread < avg_historical_spread * 0.7
        else:
            spread_squeeze = False
    else:
        spread_squeeze = False

    # Recomendação baseada na toxicidade
    if toxicity > 0.7:
        recommendation = "BLOCK_ENTRY_HIGH_TOXICITY"
    elif toxicity > 0.5:
        recommendation = "REDUCE_SIZE_TOXIC_FLOW"
    elif spread_squeeze and tick_imbalance > 0.2:
        recommendation = "POTENTIAL_BREAKOUT"
    else:
        recommendation = "NEUTRAL"

    return {
        "tick_imbalance": round(tick_imbalance, 4),
        "up_ticks": up_ticks,
        "down_ticks": down_ticks,
        "zero_ticks": zero_ticks,
        "toxicity_score": round(toxicity, 4),
        "spread_squeeze": spread_squeeze,
        "recommendation": recommendation,
        "quality": "GOOD" if len(history) >= 30 else "PARTIAL"
    }


def _detect_order_book_imbalance(history: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Detecta imbalance no order book baseado em bid/ask.
    Técnica de fóruns: ratio de bid volume vs ask volume.
    """
    if len(history) < 10:
        return {"imbalance": 0.0, "pressure": "NEUTRAL", "quality": "INSUFFICIENT"}

    real_imbalances = [
        float(h.get("book_imbalance", 0) or 0)
        for h in history[-10:]
        if abs(float(h.get("book_imbalance", 0) or 0)) > 0
    ]
    if real_imbalances:
        imbalance = sum(real_imbalances) / len(real_imbalances)
        if imbalance > 0.15:
            pressure = "BUYING_PRESSURE"
        elif imbalance < -0.15:
            pressure = "SELLING_PRESSURE"
        else:
            pressure = "NEUTRAL"
        return {
            "imbalance": round(imbalance, 4),
            "pressure": pressure,
            "quality": "GOOD" if len(real_imbalances) >= 5 else "PARTIAL",
        }

    bid_prices = [h.get("bid", 0) for h in history if h.get("bid", 0) > 0]
    ask_prices = [h.get("ask", 0) for h in history if h.get("ask", 0) > 0]

    if not bid_prices or not ask_prices:
        return {"imbalance": 0.0, "pressure": "NEUTRAL", "quality": "NO_DATA"}

    # Simula pressure baseado no spread dynamics
    current_bid = bid_prices[-1]
    current_ask = ask_prices[-1]
    mid_price = (current_bid + current_ask) / 2 if current_bid > 0 and current_ask > 0 else 0

    # Pressure baseada na distância do preço para bid/ask
    current_price = history[-1].get("price", mid_price)

    if current_price > 0 and current_bid > 0 and current_ask > 0:
        bid_distance = (current_price - current_bid) / current_price * 10000  # bps
        ask_distance = (current_ask - current_price) / current_price * 10000

        # Imbalance: se preço está mais perto do ask, pressão compradora
        if ask_distance > 0 and bid_distance > 0:
            imbalance = (ask_distance - bid_distance) / (ask_distance + bid_distance)
        else:
            imbalance = 0.0
    else:
        imbalance = 0.0

    if imbalance > 0.3:
        pressure = "BUYING_PRESSURE"
    elif imbalance < -0.3:
        pressure = "SELLING_PRESSURE"
    else:
        pressure = "NEUTRAL"

    return {
        "imbalance": round(imbalance, 4),
        "pressure": pressure,
        "bid_price": round(current_bid, 8),
        "ask_price": round(current_ask, 8),
        "mid_price": round(mid_price, 8),
        "quality": "GOOD"
    }


def _detect_structural_break(prices: list[float], window: int = 20, threshold_sigma: float = 3.0) -> dict[str, Any]:
    """
    Detecta quebras estruturais usando CUSUM adaptado.
    Técnica de fóruns quant: detectar mudanças de regime em tempo real.
    """
    if len(prices) < window * 2:
        return {"break_detected": False, "reason": "insufficient_data"}

    # Calcula média e desvio do rolling window
    recent = prices[-window:]
    if len(recent) < window:
        return {"break_detected": False, "reason": "insufficient_recent_data"}

    mean_recent = sum(recent) / len(recent)
    variance = sum((p - mean_recent) ** 2 for p in recent) / len(recent)
    std_recent = math.sqrt(variance) if variance > 0 else 0.0001

    # Verifica se preço atual é outlier
    current_price = prices[-1]
    z_score = abs(current_price - mean_recent) / std_recent if std_recent > 0 else 0

    if z_score > threshold_sigma:
        direction = "UP" if current_price > mean_recent else "DOWN"
        return {
            "break_detected": True,
            "direction": direction,
            "z_score": round(z_score, 2),
            "threshold_sigma": threshold_sigma,
            "severity": "HIGH" if z_score > 5 else "MEDIUM" if z_score > 4 else "LOW",
            "action": "RECALIBRATE_STOPS" if z_score > 4 else "MONITOR"
        }

    return {"break_detected": False, "z_score": round(z_score, 2)}


def _detect_delta_divergence(history: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Detecta divergência entre preço e volume/delta.
    Técnica avançada: divergência de volume precede reversão.
    """
    if len(history) < 30:
        return {"divergence": False, "type": None, "quality": "INSUFFICIENT"}

    prices = [h.get("price", 0) for h in history if h.get("price", 0) > 0]
    volumes = [h.get("volume_ratio", 1) for h in history]
    cvd_values = [float(h.get("cvd", 0) or 0) for h in history if h.get("cvd", 0) not in (None, 0)]

    if len(prices) < 20:
        return {"divergence": False, "type": None, "quality": "NO_DATA"}

    if len(cvd_values) >= 10 and len(prices) >= 10:
        price_delta = prices[-1] - prices[-10]
        cvd_delta = cvd_values[-1] - cvd_values[-10]
        if price_delta > 0 and cvd_delta < 0:
            return {
                "divergence": True,
                "type": "BEARISH_PRICE_CVD",
                "confidence": 0.72,
                "action": "AVOID_LONG",
            }
        if price_delta < 0 and cvd_delta > 0:
            return {
                "divergence": True,
                "type": "BULLISH_PRICE_CVD",
                "confidence": 0.72,
                "action": "AVOID_SHORT",
            }

    # Preço faz high, volume cai = bearish divergence
    recent_start = max(0, len(prices) - 20)
    recent_high = max(prices[recent_start:])
    price_high_idx = recent_start + prices[recent_start:].index(recent_high) if recent_high > 0 else -1
    volume_at_high = volumes[price_high_idx] if price_high_idx >= 0 and price_high_idx < len(volumes) else 0
    current_volume = volumes[-1] if volumes else 0

    price_up = prices[-1] > prices[-5] if len(prices) >= 5 else False
    volume_down = current_volume < volume_at_high * 0.7 if volume_at_high > 0 else False

    if price_up and volume_down:
        return {
            "divergence": True,
            "type": "BEARISH_PRICE_VOLUME",
            "confidence": min(0.8, 0.5 + (volume_at_high / current_volume - 1) * 0.2 if current_volume > 0 else 0.5),
            "action": "AVOID_LONG"
        }

    price_down = prices[-1] < prices[-5] if len(prices) >= 5 else False
    volume_up = current_volume > volume_at_high * 1.3 if volume_at_high > 0 else False

    if price_down and volume_up:
        return {
            "divergence": True,
            "type": "BULLISH_PRICE_VOLUME",
            "confidence": min(0.8, 0.5 + (current_volume / volume_at_high - 1) * 0.2 if volume_at_high > 0 else 0.5),
            "action": "AVOID_SHORT"
        }

    return {"divergence": False, "type": None}


def _detect_liquidity_void(history: list[dict[str, Any]], threshold_spread_bps: float = 20.0) -> dict[str, Any]:
    """
    Detecta liquidez void - áreas onde o book tem pouca profundidade.
    Técnica de fóruns: evitar entrar em momentos de baixa liquidez.
    """
    if len(history) < 10:
        return {"void": False, "reason": "insufficient_data"}

    recent = history[-10:]
    avg_spread = sum(h.get("spread_bps", 0) for h in recent) / len(recent)
    recent_prices = [h.get("price", 0) for h in recent if h.get("price", 0) > 0]

    if not recent_prices:
        return {"void": False, "reason": "no_prices"}

    # Volatilidade recente
    price_range = (max(recent_prices) - min(recent_prices)) / min(recent_prices) * 100 if min(recent_prices) > 0 else 0

    void_detected = avg_spread > threshold_spread_bps or price_range > 0.5 and avg_spread > 10

    if void_detected:
        return {
            "void": True,
            "avg_spread_bps": round(avg_spread, 2),
            "price_range_pct": round(price_range, 2),
            "severity": "HIGH" if avg_spread > 30 else "MEDIUM",
            "action": "DELAY_ENTRY" if avg_spread > 15 else "MONITOR",
            "recommendation": "LIQUIDITY_VOID_AVOID"
        }

    return {"void": False, "avg_spread_bps": round(avg_spread, 2)}


def _frame(history: list[dict[str, Any]], seconds: int) -> dict[str, Any]:
    """Analisa um frame de tempo específico com técnicas avançadas."""
    if not history:
        return {
            "samples": 0,
            "changePct": 0.0,
            "emaDistancePct": 0.0,
            "rangePct": 0.0,
            "wickRatio": 0.0,
            "volumeRatioAvg": 0.0,
            "volumeTrend": "unknown",
            "breakoutState": "NO_DATA",
            "coveragePct": 0.0,
            "maxGapSeconds": 0.0,
            "staleSeconds": 0.0,
            "quality": "NO_DATA",
            # NOVOS CAMPOS
            "rsi": 50.0,
            "vwapDistancePct": 0.0,
            "volumeProfile": {},
            "microstructure": {},
            "bookImbalance": {},
            "structuralBreak": {},
            "deltaDivergence": {},
            "liquidityVoid": {},
        }

    end_ts = float(history[-1].get("timestamp", 0) or 0)
    start_ts = end_ts - seconds
    frame = [x for x in history if float(x.get("timestamp", 0) or 0) >= start_ts]
    prices = [float(x.get("price", 0) or 0) for x in frame if float(x.get("price", 0) or 0) > 0]

    if len(prices) < 2:
        return {
            "samples": len(prices),
            "changePct": 0.0,
            "emaDistancePct": 0.0,
            "rangePct": 0.0,
            "wickRatio": 0.0,
            "volumeRatioAvg": 0.0,
            "volumeTrend": "unknown",
            "breakoutState": "NO_DATA",
            "coveragePct": 0.0,
            "maxGapSeconds": 0.0,
            "staleSeconds": round(max(0.0, time.time() - end_ts), 3),
            "quality": "INSUFFICIENT",
            "rsi": 50.0,
            "vwapDistancePct": 0.0,
            "volumeProfile": {},
            "microstructure": {},
            "bookImbalance": {},
            "structuralBreak": {},
            "deltaDivergence": {},
            "liquidityVoid": {},
        }

    timestamps = sorted(float(x.get("timestamp", 0) or 0) for x in frame)
    observed_seconds = max(0.0, timestamps[-1] - timestamps[0])
    coverage_pct = min(1.0, observed_seconds / seconds)
    max_gap_seconds = max(
        (right - left for left, right in zip(timestamps, timestamps[1:])),
        default=0.0,
    )
    stale_seconds = max(0.0, time.time() - timestamps[-1])

    open_price = prices[0]
    close_price = prices[-1]
    high = max(prices)
    low = min(prices)

    body = abs(close_price - open_price)
    candle_range = max(high - low, 0.0)
    upper_wick = high - max(open_price, close_price)
    lower_wick = min(open_price, close_price) - low
    wick_ratio = (upper_wick + lower_wick) / body if body > 0 else (upper_wick + lower_wick)

    ema = _ema(prices, min(20, max(3, len(prices))))
    ema_distance = _pct(ema, close_price) if ema > 0 else 0.0

    # NOVO: RSI
    rsi = _rsi(prices)

    # NOVO: VWAP
    vwap = _vwap(frame)
    vwap_distance = _pct(vwap, close_price) if vwap > 0 else 0.0

    volumes = [float(x.get("volume_ratio", 1) or 1) for x in frame]
    midpoint = max(1, len(volumes) // 2)
    early_vol = sum(volumes[:midpoint]) / midpoint
    late_vol = sum(volumes[midpoint:]) / max(1, len(volumes[midpoint:]))
    volume_trend = "rising" if late_vol > early_vol * 1.08 else "falling" if late_vol < early_vol * 0.92 else "flat"

    change_pct = _pct(open_price, close_price)
    range_pct = _pct(low, high) if low > 0 else 0.0

    # NOVOS: Detecções avançadas
    volume_profile = _calculate_volume_profile(frame)
    microstructure = _detect_market_microstructure(frame)
    book_imbalance = _detect_order_book_imbalance(frame)
    structural_break = _detect_structural_break(prices)
    delta_divergence = _detect_delta_divergence(frame)
    liquidity_void = _detect_liquidity_void(frame)

    # Breakout state aprimorado com novas confirmações
    breakout_state = "RANGE"
    breakout_confidence = 0.0

    # Confirmação de breakout com múltiplos filtros
    volume_ok = late_vol >= 1.35
    wick_ok = wick_ratio <= 1.8
    microstructure_ok = microstructure.get("tick_imbalance", 0) > 0.2 if change_pct > 0 else microstructure.get("tick_imbalance", 0) < -0.2
    book_pressure_ok = book_imbalance.get("pressure") == "BUYING_PRESSURE" if change_pct > 0 else book_imbalance.get("pressure") == "SELLING_PRESSURE"
    liquidity_ok = not liquidity_void.get("void", False)

    if abs(change_pct) >= 0.25:
        if volume_ok and wick_ok and microstructure_ok and liquidity_ok:
            breakout_state = "BREAKOUT_UP" if change_pct > 0 else "BREAKOUT_DOWN"
            breakout_confidence = 0.75
        elif volume_ok and wick_ok:
            breakout_state = "BREAKOUT_UP" if change_pct > 0 else "BREAKOUT_DOWN"
            breakout_confidence = 0.60
        elif late_vol < 1.15 or wick_ratio > 2.5:
            breakout_state = "FAKEOUT"
            breakout_confidence = 0.70
        elif delta_divergence.get("divergence", False):
            breakout_state = "DIVERGENCE_ALERT"
            breakout_confidence = 0.65

    # Detecção de candle pattern avançado
    candle_pattern = "NEUTRAL"
    if seconds >= 300:  # Apenas para frames maiores
        # Doji
        if body <= candle_range * 0.1 and candle_range > 0:
            candle_pattern = "DOJI"
        # Hammer / Shooting Star
        elif lower_wick >= body * 2 and upper_wick <= body * 0.5 and body > 0:
            candle_pattern = "HAMMER"
        elif upper_wick >= body * 2 and lower_wick <= body * 0.5 and body > 0:
            candle_pattern = "SHOOTING_STAR"
        # Engulfing (simplificado - precisaria de candle anterior)
        elif body > candle_range * 0.7 and close_price > open_price:
            candle_pattern = "STRONG_BULLISH"
        elif body > candle_range * 0.7 and close_price < open_price:
            candle_pattern = "STRONG_BEARISH"

    quality = "GOOD"
    if stale_seconds > 15:
        quality = "STALE"
    elif max_gap_seconds > 20:
        quality = "GAPPED"
    elif coverage_pct < 0.8:
        quality = "PARTIAL"
    elif liquidity_void.get("void", False):
        quality = "LOW_LIQUIDITY"

    # Recomendação consolidada
    recommendation = "NEUTRAL"
    if breakout_state == "BREAKOUT_UP" and microstructure_ok:
        recommendation = "CONSIDER_LONG"
    elif breakout_state == "BREAKOUT_DOWN" and microstructure_ok:
        recommendation = "CONSIDER_SHORT"
    elif breakout_state == "FAKEOUT":
        recommendation = "AVOID_ENTRY"
    elif microstructure.get("recommendation") == "BLOCK_ENTRY_HIGH_TOXICITY":
        recommendation = "BLOCK_ENTRY"
    elif structural_break.get("break_detected", False):
        recommendation = "RECALIBRATE"

    return {
        "samples": len(prices),
        "changePct": round(change_pct, 4),
        "emaDistancePct": round(ema_distance, 4),
        "rangePct": round(range_pct, 4),
        "wickRatio": round(wick_ratio, 4),
        "volumeRatioAvg": round(sum(volumes) / len(volumes), 4),
        "volumeTrend": volume_trend,
        "breakoutState": breakout_state,
        "breakoutConfidence": round(breakout_confidence, 2),
        "candlePattern": candle_pattern,
        "coveragePct": round(coverage_pct, 4),
        "maxGapSeconds": round(max_gap_seconds, 3),
        "staleSeconds": round(stale_seconds, 3),
        "quality": quality,
        # NOVOS CAMPOS
        "rsi": round(rsi, 1),
        "vwapDistancePct": round(vwap_distance, 4),
        "volumeProfile": volume_profile,
        "microstructure": microstructure,
        "bookImbalance": book_imbalance,
        "structuralBreak": structural_break,
        "deltaDivergence": delta_divergence,
        "liquidityVoid": liquidity_void,
        "recommendation": recommendation,
    }


def build_multiframe_context(history: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Constrói contexto multiframe com todas as técnicas avançadas.
    Retorna análise para 1m, 5m, 15m.
    """
    return {
        "1m": _frame(history, 60),
        "5m": _frame(history, 300),
        "15m": _frame(history, 900),
    }
