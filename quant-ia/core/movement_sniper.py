from __future__ import annotations

import time
import math
from dataclasses import dataclass, field
from typing import Any

from core.candle_intelligence import build_multiframe_context


SNIPER_WINDOW_SECONDS = 300


@dataclass
class MovementFeatures:
    symbol: str
    samples: int
    window_seconds: int
    first_price: float
    last_price: float
    bid: float
    ask: float
    spread_bps: float
    high_price: float
    low_price: float
    price_change_pct: float
    price_acceleration: float
    max_favorable_pct: float
    max_adverse_pct: float
    volume_ratio: float
    oi_change_pct: float
    funding_rate: float
    rsi: float
    atr_pct: float
    btc_regime: str
    direction: str
    movement_state: str
    # NOVOS CAMPOS PARA NÍVEL MÁXIMO DE EXCELÊNCIA
    vwap_distance_pct: float = 0.0
    volume_trend: str = "flat"
    tick_imbalance: float = 0.0
    book_pressure: float = 0.0
    cvd_change_pct: float = 0.0
    volume_profile_poc: float = 0.0
    microstructure_toxicity: float = 0.0
    momentum_quality: str = "low"


def _pct_change(first: float, last: float) -> float:
    if first <= 0:
        return 0.0
    return (last - first) / first * 100


def _avg(values: list[float], fallback: float = 0.0) -> float:
    vals = [v for v in values if isinstance(v, (int, float))]
    return sum(vals) / len(vals) if vals else fallback


def _std(values: list[float]) -> float:
    """Desvio padrão para análise de volatilidade."""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((x - mean) ** 2 for x in values) / len(values)
    return math.sqrt(variance) if variance > 0 else 0.0


def _last_float(history: list[dict], key: str, fallback: float = 0.0) -> float:
    if not history:
        return fallback
    value = history[-1].get(key, fallback)
    try:
        return float(value)
    except Exception:
        return fallback


def _calc_vwap_distance(history: list[dict], current_price: float) -> float:
    """Calcula distância do preço atual para o VWAP."""
    cumulative_pv = 0.0
    cumulative_vol = 0.0

    for h in history[-50:]:  # Últimos 50 snaps (~4min)
        price = h.get("price", 0)
        vol = h.get("volume_ratio", 1) * 1000
        if price > 0:
            cumulative_pv += price * vol
            cumulative_vol += vol

    if cumulative_vol == 0:
        return 0.0

    vwap = cumulative_pv / cumulative_vol
    return _pct_change(vwap, current_price) if vwap > 0 else 0.0


def _calc_volume_trend(history: list[dict]) -> str:
    """Detecta tendência de volume (crescente/decrescente/estável)."""
    volumes = [h.get("volume_ratio", 1) for h in history[-20:] if h.get("volume_ratio", 1) > 0]
    if len(volumes) < 10:
        return "flat"

    first_half = sum(volumes[:len(volumes)//2]) / (len(volumes)//2)
    second_half = sum(volumes[len(volumes)//2:]) / (len(volumes) - len(volumes)//2)

    if second_half > first_half * 1.15:
        return "rising"
    elif second_half < first_half * 0.85:
        return "falling"
    return "flat"


def _calc_tick_imbalance(history: list[dict]) -> float:
    """Calcula imbalance de ticks (up vs down)."""
    up_ticks = 0
    down_ticks = 0

    for i in range(1, len(history)):
        prev_price = history[i-1].get("price", 0)
        curr_price = history[i].get("price", 0)
        if prev_price > 0 and curr_price > 0:
            if curr_price > prev_price:
                up_ticks += 1
            elif curr_price < prev_price:
                down_ticks += 1

    total = up_ticks + down_ticks
    if total == 0:
        return 0.0

    return (up_ticks - down_ticks) / total


def _calc_book_pressure(history: list[dict]) -> float:
    """Calcula pressão do order book (bid_imbalance)."""
    imbalances = [h.get("book_imbalance", 0) for h in history[-10:] if h.get("book_imbalance", 0) != 0]
    if not imbalances:
        return 0.0
    return sum(imbalances) / len(imbalances)


def _calc_cvd_change(history: list[dict]) -> float:
    """Calcula mudança no Cumulative Volume Delta."""
    cvd_values = [h.get("cvd", 0) for h in history if h.get("cvd", 0) != 0]
    if len(cvd_values) < 5:
        return 0.0

    cvd_old = cvd_values[0]
    cvd_new = cvd_values[-1]
    if cvd_old == 0:
        return 0.0

    return (cvd_new - cvd_old) / abs(cvd_old) * 100


def _calc_microstructure_toxicity(history: list[dict]) -> float:
    """
    Calcula toxicidade da microestrutura.
    Baseado em: spreads altos + gaps + tick imbalance extremo.
    """
    spreads = [h.get("spread_bps", 0) for h in history[-20:] if h.get("spread_bps", 0) > 0]
    tick_imb = abs(_calc_tick_imbalance(history))

    if not spreads:
        return 0.0

    avg_spread = sum(spreads) / len(spreads)

    toxicity = 0.0
    if avg_spread > 15:
        toxicity += 0.4
    elif avg_spread > 8:
        toxicity += 0.2

    if tick_imb > 0.6:
        toxicity += 0.3
    elif tick_imb > 0.4:
        toxicity += 0.15

    return min(1.0, toxicity)


def _calc_momentum_quality(alt: MovementFeatures, btc: MovementFeatures) -> str:
    """Classifica qualidade do momentum baseado em múltiplos fatores."""
    score = 0

    # Volume confirmando movimento
    if alt.volume_ratio > 1.5:
        score += 1
    if alt.volume_trend == "rising":
        score += 1

    # OI confirmando
    if alt.oi_change_pct > 0 and abs(alt.price_change_pct) > 0.2:
        score += 1

    # Tick flow confirmando
    if alt.tick_imbalance > 0.2 and alt.direction == "LONG":
        score += 1
    elif alt.tick_imbalance < -0.2 and alt.direction == "SHORT":
        score += 1

    # Book pressure
    if alt.book_pressure > 0.2 and alt.direction == "LONG":
        score += 1
    elif alt.book_pressure < -0.2 and alt.direction == "SHORT":
        score += 1

    # RSI em zona saudável
    if 30 <= alt.rsi <= 70:
        score += 1

    # Microestrutura não tóxica
    if alt.microstructure_toxicity < 0.3:
        score += 1

    if score >= 5:
        return "very_high"
    elif score >= 3:
        return "high"
    elif score >= 2:
        return "medium"
    return "low"


def _movement_state(
    change_pct: float,
    acceleration: float,
    volume_ratio: float,
    oi_change_pct: float,
    rsi: float,
    btc_regime: str,
    tick_imbalance: float = 0.0,
    book_pressure: float = 0.0,
    volume_trend: str = "flat",
) -> str:
    """Versão aprimorada com mais indicadores de qualidade."""
    abs_change = abs(change_pct)

    # Condições de chopp
    if abs_change < 0.12 or volume_ratio < 1.05:
        return "CHOP"

    # Exaustão
    if rsi >= 76 and change_pct > 0:
        return "EXHAUSTION_UP"
    if rsi <= 24 and change_pct < 0:
        return "EXHAUSTION_DOWN"

    # Confirmação de volume trend
    volume_confirmed = volume_trend == "rising" or volume_ratio >= 1.4
    flow_confirmed = abs(tick_imbalance) > 0.2 or abs(book_pressure) > 0.15

    # Impulso com qualidade
    if change_pct > 0.25 and acceleration > 0 and volume_confirmed and oi_change_pct >= 0:
        if btc_regime != "BEAR" and flow_confirmed:
            return "IMPULSE_UP_HIGH_QUALITY"
        elif btc_regime != "BEAR":
            return "IMPULSE_UP"
        else:
            return "BTC_CONFLICT"

    if change_pct < -0.25 and acceleration < 0 and volume_confirmed and oi_change_pct >= 0:
        if btc_regime != "BULL" and flow_confirmed:
            return "IMPULSE_DOWN_HIGH_QUALITY"
        elif btc_regime != "BULL":
            return "IMPULSE_DOWN"
        else:
            return "BTC_CONFLICT"

    # Fake move: volume baixo com movimento grande
    if abs_change >= 0.6 and volume_ratio < 1.2:
        return "FAKE_MOVE"

    # Microstructure suspect
    if abs(tick_imbalance) > 0.5 and abs_change < 0.15:
        return "SUSPECT_FLOW"

    return "WAIT"


def build_movement_features(symbol: str, history: list[dict], window_seconds: int = SNIPER_WINDOW_SECONDS) -> MovementFeatures:
    if history:
        end_ts = float(history[-1].get("timestamp", 0) or 0)
        history = [
            item for item in history
            if float(item.get("timestamp", 0) or 0) >= end_ts - window_seconds
        ]
    if not history:
        return MovementFeatures(
            symbol=symbol,
            samples=0,
            window_seconds=window_seconds,
            first_price=0.0,
            last_price=0.0,
            bid=0.0,
            ask=0.0,
            spread_bps=0.0,
            high_price=0.0,
            low_price=0.0,
            price_change_pct=0.0,
            price_acceleration=0.0,
            max_favorable_pct=0.0,
            max_adverse_pct=0.0,
            volume_ratio=0.0,
            oi_change_pct=0.0,
            funding_rate=0.0,
            rsi=50.0,
            atr_pct=0.0,
            btc_regime="NEUTRAL",
            direction="FLAT",
            movement_state="NO_DATA",
            # NOVOS CAMPOS
            vwap_distance_pct=0.0,
            volume_trend="flat",
            tick_imbalance=0.0,
            book_pressure=0.0,
            cvd_change_pct=0.0,
            volume_profile_poc=0.0,
            microstructure_toxicity=0.0,
            momentum_quality="low",
        )

    prices = [float(x.get("price", 0) or 0) for x in history]
    valid_prices = [p for p in prices if p > 0]
    first_price = valid_prices[0] if valid_prices else 0.0
    last_price = valid_prices[-1] if valid_prices else 0.0
    bid = _last_float(history, "bid", last_price)
    ask = _last_float(history, "ask", last_price)
    spread_bps = _last_float(history, "spread_bps")
    high_price = max(valid_prices) if valid_prices else 0.0
    low_price = min(valid_prices) if valid_prices else 0.0
    change_pct = _pct_change(prices[0], prices[-1]) if len(prices) >= 2 else 0.0
    max_favorable = _pct_change(first_price, high_price) if first_price > 0 else 0.0
    max_adverse = _pct_change(first_price, low_price) if first_price > 0 else 0.0
    midpoint = max(1, len(prices) // 2)
    early_change = _pct_change(prices[0], prices[midpoint - 1]) if len(prices) >= 4 else 0.0
    late_change = _pct_change(prices[midpoint], prices[-1]) if len(prices) >= 4 else change_pct
    acceleration = late_change - early_change
    volume_ratio = _avg([float(x.get("volume_ratio", 1) or 1) for x in history], 1.0)
    oi_change_pct = _last_float(history, "oi_change_pct")
    funding_rate = _last_float(history, "funding_rate")
    rsi = _last_float(history, "rsi", 50.0)
    atr_pct = _last_float(history, "atr_pct")
    btc_regime = str(history[-1].get("btc_regime", "NEUTRAL"))
    direction = "LONG" if change_pct > 0 else "SHORT" if change_pct < 0 else "FLAT"

    # ========== NOVAS MÉTRICAS ==========
    vwap_distance_pct = _calc_vwap_distance(history, last_price)
    volume_trend = _calc_volume_trend(history)
    tick_imbalance = _calc_tick_imbalance(history)
    book_pressure = _calc_book_pressure(history)
    cvd_change_pct = _calc_cvd_change(history)
    volume_profile_poc = _last_float(history, "volume_profile_poc")
    microstructure_toxicity = _calc_microstructure_toxicity(history)

    state = _movement_state(
        change_pct, acceleration, volume_ratio, oi_change_pct, rsi, btc_regime,
        tick_imbalance, book_pressure, volume_trend
    )

    # Cria features temporárias para momentum quality
    temp_features = MovementFeatures(
        symbol=symbol,
        samples=len(history),
        window_seconds=window_seconds,
        first_price=first_price,
        last_price=last_price,
        bid=bid,
        ask=ask,
        spread_bps=spread_bps,
        high_price=high_price,
        low_price=low_price,
        price_change_pct=change_pct,
        price_acceleration=acceleration,
        max_favorable_pct=max_favorable,
        max_adverse_pct=max_adverse,
        volume_ratio=volume_ratio,
        oi_change_pct=oi_change_pct,
        funding_rate=funding_rate,
        rsi=rsi,
        atr_pct=atr_pct,
        btc_regime=btc_regime,
        direction=direction,
        movement_state=state,
        vwap_distance_pct=vwap_distance_pct,
        volume_trend=volume_trend,
        tick_imbalance=tick_imbalance,
        book_pressure=book_pressure,
        cvd_change_pct=cvd_change_pct,
        volume_profile_poc=volume_profile_poc,
        microstructure_toxicity=microstructure_toxicity,
        momentum_quality="low",
    )

    momentum_quality = _calc_momentum_quality(temp_features, MovementFeatures(
        symbol="BTC-USDT",
        samples=0,
        window_seconds=window_seconds,
        first_price=0,
        last_price=0,
        bid=0,
        ask=0,
        spread_bps=0,
        high_price=0,
        low_price=0,
        price_change_pct=0,
        price_acceleration=0,
        max_favorable_pct=0,
        max_adverse_pct=0,
        volume_ratio=0,
        oi_change_pct=0,
        funding_rate=0,
        rsi=0,
        atr_pct=0,
        btc_regime=btc_regime,
        direction="FLAT",
        movement_state="NO_DATA",
    ))

    return MovementFeatures(
        symbol=symbol,
        samples=len(history),
        window_seconds=window_seconds,
        first_price=round(first_price, 8),
        last_price=round(last_price, 8),
        bid=round(bid, 8),
        ask=round(ask, 8),
        spread_bps=round(spread_bps, 4),
        high_price=round(high_price, 8),
        low_price=round(low_price, 8),
        price_change_pct=round(change_pct, 4),
        price_acceleration=round(acceleration, 4),
        max_favorable_pct=round(max_favorable, 4),
        max_adverse_pct=round(max_adverse, 4),
        volume_ratio=round(volume_ratio, 4),
        oi_change_pct=round(oi_change_pct, 4),
        funding_rate=round(funding_rate, 8),
        rsi=round(rsi, 2),
        atr_pct=round(atr_pct, 4),
        btc_regime=btc_regime,
        direction=direction,
        movement_state=state,
        vwap_distance_pct=round(vwap_distance_pct, 4),
        volume_trend=volume_trend,
        tick_imbalance=round(tick_imbalance, 4),
        book_pressure=round(book_pressure, 4),
        cvd_change_pct=round(cvd_change_pct, 4),
        volume_profile_poc=round(volume_profile_poc, 8) if volume_profile_poc else 0.0,
        microstructure_toxicity=round(microstructure_toxicity, 4),
        momentum_quality=momentum_quality,
    )


def classify_btc_commander(btc: MovementFeatures) -> dict[str, Any]:
    """Classifica o regime do BTC com confiança aprimorada."""
    if btc.samples < 3:
        return {"state": "BTC_NO_DATA", "confidence": 0.0}

    # Impulsos com qualidade
    if btc.movement_state == "IMPULSE_UP_HIGH_QUALITY":
        return {"state": "BTC_IMPULSE_UP", "confidence": min(0.98, 0.65 + abs(btc.price_change_pct) / 1.5)}
    if btc.movement_state == "IMPULSE_UP":
        return {"state": "BTC_IMPULSE_UP", "confidence": min(0.95, 0.55 + abs(btc.price_change_pct) / 2)}

    if btc.movement_state == "IMPULSE_DOWN_HIGH_QUALITY":
        return {"state": "BTC_IMPULSE_DOWN", "confidence": min(0.98, 0.65 + abs(btc.price_change_pct) / 1.5)}
    if btc.movement_state == "IMPULSE_DOWN":
        return {"state": "BTC_IMPULSE_DOWN", "confidence": min(0.95, 0.55 + abs(btc.price_change_pct) / 2)}

    # Chopp com confiança reduzida
    if btc.movement_state in {"CHOP", "WAIT"}:
        return {"state": "BTC_CHOP", "confidence": 0.6}

    # Exaustão
    if "EXHAUSTION" in btc.movement_state:
        return {"state": "BTC_EXHAUSTION", "confidence": 0.72}

    # Flow suspeito
    if btc.movement_state == "SUSPECT_FLOW":
        return {"state": "BTC_SUSPECT_FLOW", "confidence": 0.55}

    return {"state": btc.movement_state, "confidence": 0.5}


def _target_probability(
    alt: MovementFeatures,
    btc: MovementFeatures,
    target_move_pct: float,
) -> float:
    """Probabilidade de atingir target com métricas avançadas."""
    if alt.samples < 3 or btc.samples < 3:
        return 0.0

    # Direção alinhada
    direction_ok = (
        alt.movement_state in {"IMPULSE_UP", "IMPULSE_UP_HIGH_QUALITY"} and
        btc.movement_state in {"IMPULSE_UP", "IMPULSE_UP_HIGH_QUALITY"}
    ) or (
        alt.movement_state in {"IMPULSE_DOWN", "IMPULSE_DOWN_HIGH_QUALITY"} and
        btc.movement_state in {"IMPULSE_DOWN", "IMPULSE_DOWN_HIGH_QUALITY"}
    )

    # Base probability
    base = 0.38

    # Momentum quality bonus
    if alt.momentum_quality == "very_high":
        base += 0.18
    elif alt.momentum_quality == "high":
        base += 0.12
    elif alt.momentum_quality == "medium":
        base += 0.06

    # Price change strength
    base += min(0.20, abs(alt.price_change_pct) / 3)

    # Volume confirmation
    base += min(0.14, max(0.0, alt.volume_ratio - 1.0) / 6)
    if alt.volume_trend == "rising":
        base += 0.05

    # OI confirmation
    base += min(0.10, max(0.0, alt.oi_change_pct) / 15)

    # BTC strength
    base += min(0.08, abs(btc.price_change_pct) / 4)

    # Direction alignment bonus
    if direction_ok:
        base += 0.12

    # Flow confirmation
    if alt.tick_imbalance > 0.15 and alt.direction == "LONG":
        base += 0.04
    elif alt.tick_imbalance < -0.15 and alt.direction == "SHORT":
        base += 0.04

    if alt.book_pressure > 0.1 and alt.direction == "LONG":
        base += 0.03
    elif alt.book_pressure < -0.1 and alt.direction == "SHORT":
        base += 0.03

    # Penalties
    if alt.rsi >= 76 or alt.rsi <= 24:
        base -= 0.16

    if alt.movement_state in {"CHOP", "FAKE_MOVE", "BTC_CONFLICT", "NO_DATA", "SUSPECT_FLOW"}:
        base -= 0.22

    if alt.microstructure_toxicity > 0.5:
        base -= 0.12
    elif alt.microstructure_toxicity > 0.3:
        base -= 0.06

    # Target difficulty
    available_move = max(abs(alt.price_change_pct), alt.atr_pct * 0.25)
    if target_move_pct > 0:
        difficulty = target_move_pct / max(available_move, 0.05)
        base -= min(0.30, max(0.0, difficulty - 0.5) * 0.10)

    return round(max(0.0, min(0.95, base)), 4)


def evaluate_sniper_window(
    symbol: str,
    alt_history: list[dict],
    btc_history: list[dict],
    targets_usdt: list[float] | None = None,
    target_moves_pct: dict[str, float] | None = None,
    window_seconds: int = SNIPER_WINDOW_SECONDS,
) -> dict[str, Any]:
    """Avalia janela sniper com análise multiframe e decisão de entrada."""
    targets = targets_usdt or [0.5, 1.0, 2.0]
    alt = build_movement_features(symbol, alt_history, window_seconds)
    btc = build_movement_features("BTC-USDT", btc_history, window_seconds)
    alt_frames = build_multiframe_context(alt_history)
    btc_frames = build_multiframe_context(btc_history)
    btc_state = classify_btc_commander(btc)

    probabilities = {
        str(t): _target_probability(
            alt,
            btc,
            float((target_moves_pct or {}).get(str(t), 0.0)),
        )
        for t in targets
    }
    best_target = max(probabilities, key=probabilities.get) if probabilities else "0.5"
    best_probability = probabilities.get(best_target, 0.0)

    # Limiares ajustados por qualidade do momentum
    allow_threshold = 0.55 if alt.momentum_quality in {"high", "very_high"} else 0.58
    scout_threshold = 0.50 if alt.momentum_quality in {"high", "very_high"} else 0.52

    decision = "WAIT"
    reasons: list[str] = []

    if alt.samples < 3 or btc.samples < 3:
        decision = "WAIT"
        reasons.append("insufficient_realtime_samples")

    # Impulsos com alta qualidade
    elif alt.movement_state == "IMPULSE_UP_HIGH_QUALITY" and btc_state["state"] == "BTC_IMPULSE_UP":
        decision = "ALLOW_LONG" if best_probability >= allow_threshold else "WAIT"
        reasons.extend(["btc_impulse_up", "alt_impulse_up_high_quality"])

    elif alt.movement_state == "IMPULSE_DOWN_HIGH_QUALITY" and btc_state["state"] == "BTC_IMPULSE_DOWN":
        decision = "ALLOW_SHORT" if best_probability >= allow_threshold else "WAIT"
        reasons.extend(["btc_impulse_down", "alt_impulse_down_high_quality"])

    # Impulsos padrão
    elif alt.movement_state == "IMPULSE_UP" and btc_state["state"] == "BTC_IMPULSE_UP":
        decision = "ALLOW_LONG" if best_probability >= allow_threshold else "WAIT"
        reasons.extend(["btc_impulse_up", "alt_impulse_up"])

    elif alt.movement_state == "IMPULSE_DOWN" and btc_state["state"] == "BTC_IMPULSE_DOWN":
        decision = "ALLOW_SHORT" if best_probability >= allow_threshold else "WAIT"
        reasons.extend(["btc_impulse_down", "alt_impulse_down"])

    # Condições de bloqueio
    elif alt.movement_state == "CHOP" or btc_state["state"] == "BTC_CHOP":
        decision = "BLOCK_CHOP"
        reasons.append("chop_environment")

    elif "EXHAUSTION" in alt.movement_state:
        decision = "BLOCK_EXHAUSTION"
        reasons.append("alt_exhaustion_risk")

    elif alt.movement_state == "BTC_CONFLICT":
        decision = "BLOCK_BTC_CONFLICT"
        reasons.append("alt_move_conflicts_with_btc")

    elif alt.movement_state == "FAKE_MOVE":
        decision = "BLOCK_FAKE_VOLUME"
        reasons.append("price_move_without_volume_confirmation")

    elif alt.movement_state == "SUSPECT_FLOW":
        decision = "BLOCK_SUSPECT_FLOW"
        reasons.append("microstructure_suspect_tick_flow")

    # Condições tóxicas adicionais
    if alt.microstructure_toxicity > 0.6:
        reasons.append("high_microstructure_toxicity")
        if decision.startswith("ALLOW"):
            decision = "WAIT"
            reasons.append("toxicity_override_wait")

    # Condições positivas (adiciona razões mesmo se bloqueado)
    if alt.volume_ratio >= 1.4:
        reasons.append("volume_expansion")
    if alt.oi_change_pct >= 0:
        reasons.append("oi_not_against_move")
    if 35 <= alt.rsi <= 70:
        reasons.append("rsi_healthy")
    if alt.volume_trend == "rising":
        reasons.append("volume_trend_rising")
    if alt.momentum_quality in {"high", "very_high"}:
        reasons.append(f"momentum_quality_{alt.momentum_quality}")
    if abs(alt.tick_imbalance) > 0.2:
        reasons.append(f"tick_flow_{'buying' if alt.tick_imbalance > 0 else 'selling'}")

    # Confirmações multiframe
    if alt_frames["5m"]["breakoutState"] in {"BREAKOUT_UP", "BREAKOUT_DOWN"}:
        reasons.append("confirmed_5m_breakout")
    if alt_frames["1m"]["breakoutState"] == "FAKEOUT":
        reasons.append("one_minute_fakeout_risk")
    if alt_frames["15m"]["breakoutState"] in {"BREAKOUT_UP", "BREAKOUT_DOWN"}:
        reasons.append("confirmed_15m_breakout")

    # Escore de risco baseado na qualidade
    if best_probability >= 0.72 and alt.momentum_quality == "very_high":
        risk = "aggressive"
    elif best_probability >= 0.68 or alt.momentum_quality == "high":
        risk = "standard"
    elif best_probability >= allow_threshold:
        risk = "scout"
    else:
        risk = "wait"

    # Expected time to target baseado em momentum e volatilidade
    expected_seconds = 30
    if alt.momentum_quality == "very_high":
        expected_seconds = 20
    elif alt.momentum_quality == "high":
        expected_seconds = 35
    elif alt.momentum_quality == "medium":
        expected_seconds = 60
    else:
        expected_seconds = 90

    expected_seconds = int(min(180, max(15, expected_seconds - int(best_probability * 30))))

    return {
        "symbol": symbol,
        "windowSeconds": window_seconds,
        "evaluatedAt": time.time(),
        "decision": decision,
        "score": best_probability,
        "target": f"{best_target} USDT",
        "targetHitProbability": best_probability,
        "targetProbabilities": probabilities,
        "expectedTimeToTargetSec": expected_seconds if best_probability else None,
        "risk": risk,
        "reasons": reasons,
        "btcCommander": btc_state,
        "btcFeatures": btc.__dict__,
        "altFeatures": alt.__dict__,
        "btcTimeframes": btc_frames,
        "altTimeframes": alt_frames,
        # NOVOS CAMPOS
        "momentumQuality": alt.momentum_quality,
        "microstructureToxicity": alt.microstructure_toxicity,
        "volumeTrend": alt.volume_trend,
        "tickImbalance": alt.tick_imbalance,
        "bookPressure": alt.book_pressure,
        "cvdChangePct": alt.cvd_change_pct,
        "vwapDistancePct": alt.vwap_distance_pct,
        "learningMode": "movement_first_pnl_auditor_v2",
    }
