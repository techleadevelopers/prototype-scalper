"""
Camada Tática — monitora anomalias em tempo real (1s/5s/15s/30s/1min).
Detecta padrões, gera alertas e salva observações na Knowledge Base.
Nível Excelência: cointegração, qualidade de dados, esgotamento de vol, liquidez tóxica.
"""
from __future__ import annotations

import asyncio
import os
import time
import logging
import math
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Optional, Tuple

from core.feature_engine import FeatureEngine, MarketSnapshot, SYMBOLS
from core import knowledge_base as kb

log = logging.getLogger("tactical")


@dataclass
class TacticalAlert:
    symbol: str
    alert_type: str
    message: str
    confidence: float
    similar_occurrences: int
    avg_return_past: float
    win_rate_past: float
    conditions: dict
    timestamp: float = field(default_factory=time.time)


# Keep at least 30 minutes at the default 5-second collection interval.
_snap_buffer: dict[str, deque] = defaultdict(lambda: deque(maxlen=360))
_active_alerts: list[TacticalAlert] = []
_alert_callbacks: list = []

# ========== NOVAS ESTRUTURAS PARA EXCELÊNCIA ==========

class CointegrationTracker:
    """Monitora pares cointegrados para mean-reversion e arbitragem estatística."""

    def __init__(self, pair: Tuple[str, str], lookback_seconds: int = 3600):
        self.pair = pair
        self.spread: deque[float] = deque(maxlen=lookback_seconds // 5)
        self.hedge_ratio: float = 1.0
        self.last_signal_time: float = 0
        self.cooldown_seconds: int = 300

    def update(self, price_a: float, price_b: float) -> Optional[dict]:
        """Atualiza spread e retorna sinal se houver oportunidade."""
        if price_a <= 0 or price_b <= 0:
            return None

        spread = price_a - self.hedge_ratio * price_b
        self.spread.append(spread)

        if len(self.spread) < 30:
            return None

        arr = list(self.spread)
        mean = sum(arr) / len(arr)
        variance = sum((x - mean) ** 2 for x in arr) / len(arr)
        std = math.sqrt(variance) if variance > 0 else 1e-6
        zscore = (spread - mean) / std

        now = time.time()
        zscore_threshold = 2.0

        if now - self.last_signal_time < self.cooldown_seconds:
            return None

        signal = None
        if zscore > zscore_threshold:
            signal = {
                "type": "COINTEGRATION_SHORT_A_LONG_B",
                "zscore": round(zscore, 3),
                "pair": f"{self.pair[0]}/{self.pair[1]}",
                "confidence": min(0.85, 0.5 + (zscore - zscore_threshold) * 0.15),
                "expected_reversion_pct": round(abs(zscore) * 0.15, 2),
                "action": "SHORT_FIRST_LONG_SECOND"
            }
            self.last_signal_time = now
        elif zscore < -zscore_threshold:
            signal = {
                "type": "COINTEGRATION_LONG_A_SHORT_B",
                "zscore": round(zscore, 3),
                "pair": f"{self.pair[0]}/{self.pair[1]}",
                "confidence": min(0.85, 0.5 + (abs(zscore) - zscore_threshold) * 0.15),
                "expected_reversion_pct": round(abs(zscore) * 0.15, 2),
                "action": "LONG_FIRST_SHORT_SECOND"
            }
            self.last_signal_time = now

        return signal


# Trackers globais de cointegração
_cointegration_trackers: dict[Tuple[str, str], CointegrationTracker] = {}
# Pares a monitorar (ajuste conforme correlação histórica)
COINTEGRATION_PAIRS = [
    ("ETH-USDT", "SOL-USDT"),
    ("BTC-USDT", "ETH-USDT"),
    ("SOL-USDT", "NEAR-USDT"),
]


def _get_or_create_cointegration_tracker(sym_a: str, sym_b: str) -> CointegrationTracker:
    """Obtém ou cria tracker de cointegração para o par."""
    key = (sym_a, sym_b)
    if key not in _cointegration_trackers:
        _cointegration_trackers[key] = CointegrationTracker(key)
    return _cointegration_trackers[key]


def _detect_volatility_exhaustion(history: list[dict], window: int = 20) -> dict:
    """Detecta quando a volatilidade está diminuindo após um pico (exaustão)."""
    if len(history) < window:
        return {"exhausted": False, "reason": "insufficient_data", "signal": None}

    ranges = []
    for i in range(max(1, len(history) - window), len(history)):
        h = history[i]
        price = h.get("price", 0)
        if price > 0:
            high = h.get("high_24h", price)
            low = h.get("low_24h", price)
            if high > 0 and low > 0:
                rng = (high - low) / price * 100
                ranges.append(rng)

    if len(ranges) < 10:
        return {"exhausted": False, "reason": "insufficient_ranges", "signal": None}

    first_half = sum(ranges[:len(ranges)//2]) / (len(ranges)//2)
    second_half = sum(ranges[len(ranges)//2:]) / max(1, len(ranges) - len(ranges)//2)

    if first_half <= 0:
        return {"exhausted": False, "reason": "zero_volatility", "signal": None}

    contraction = (first_half - second_half) / first_half

    if contraction > 0.3 and second_half < 0.5:
        return {
            "exhausted": True,
            "contraction_pct": round(contraction * 100, 1),
            "current_vol_pct": round(second_half, 2),
            "previous_vol_pct": round(first_half, 2),
            "signal": "VOLATILITY_EXHAUSTION",
            "action": "REDUCE_POSITION_SIZE"
        }

    return {"exhausted": False, "contraction_pct": round(contraction * 100, 1), "signal": None}


def _detect_toxic_liquidity(history: list[dict], threshold_bps: float = 15.0) -> dict:
    """Detecta momentos onde o spread está alto e volume baixo (liquidez tóxica)."""
    if len(history) < 5:
        return {"toxic": False, "reason": "insufficient_data", "signal": None}

    recent = history[-5:]
    spreads = [h.get("spread_bps", 0) for h in recent if h.get("spread_bps", 0) > 0]
    volumes = [h.get("volume_ratio", 1) for h in recent]

    if not spreads:
        return {"toxic": False, "reason": "no_spread_data", "signal": None}

    avg_spread = sum(spreads) / len(spreads)
    avg_volume = sum(volumes) / len(volumes)

    if avg_spread > threshold_bps and avg_volume < 0.8:
        return {
            "toxic": True,
            "avg_spread_bps": round(avg_spread, 1),
            "avg_volume_ratio": round(avg_volume, 2),
            "signal": "TOXIC_LIQUIDITY",
            "action": "BLOCK_ENTRIES",
            "confidence": min(0.9, 0.5 + (avg_spread - threshold_bps) / 30)
        }

    return {"toxic": False, "avg_spread_bps": round(avg_spread, 1), "signal": None}


def _detect_micro_structure_anomaly(history: list[dict]) -> dict:
    """
    Detecta anomalias de microestrutura:
    - Quote stuffing (muitas mudanças de preço sem volume)
    - Spoofing (ordens grandes que somem)
    """
    if len(history) < 10:
        return {"anomaly": False, "reason": "insufficient_data", "signal": None}

    recent = history[-10:]

    # Mudanças de preço consecutivas sem volume
    price_changes = [abs(h.get("price_change_pct", 0)) for h in recent]
    volumes = [h.get("volume_ratio", 1) for h in recent]

    high_change_count = sum(1 for pc in price_changes if pc > 0.2)
    low_volume_count = sum(1 for v in volumes if v < 0.7)

    if high_change_count >= 6 and low_volume_count >= 6:
        return {
            "anomaly": True,
            "type": "QUOTE_STUFFING",
            "signal": "MICRO_STRUCTURE_ANOMALY",
            "action": "DELAY_ENTRY_5_SECONDS",
            "confidence": 0.7
        }

    return {"anomaly": False, "signal": None}


async def _assess_data_quality(symbol: str, history: list[dict]) -> dict:
    """Avaliação contínua da qualidade dos dados de mercado."""

    if len(history) < 10:
        return {"quality": "BOOTSTRAPPING", "score": 0.3, "signal": None}

    # 1. Latência
    now = time.time()
    last_ts = history[-1].get("timestamp", 0)
    latency = now - last_ts
    latency_penalty = 0 if latency < 2 else min(0.5, (latency - 2) / 10)

    # 2. Gaps entre snapshots
    timestamps = [h.get("timestamp", 0) for h in history]
    gaps = [timestamps[i] - timestamps[i-1] for i in range(1, len(timestamps))]
    max_gap = max(gaps) if gaps else 0
    gap_penalty = 0 if max_gap < 10 else min(0.4, (max_gap - 10) / 30)

    # 3. Consistência de preço (sem saltos anormais)
    prices = [h.get("price", 0) for h in history if h.get("price", 0) > 0]
    abnormal_moves = 0
    if len(prices) > 1:
        for i in range(1, len(prices)):
            if prices[i-1] > 0:
                move_pct = abs(prices[i] - prices[i-1]) / prices[i-1] * 100
                if move_pct > 5:  # 5% em 5 segundos é anormal
                    abnormal_moves += 1
        abnormal_penalty = min(0.3, abnormal_moves / len(prices))
    else:
        abnormal_penalty = 0.3

    quality_score = max(0.0, 1.0 - (latency_penalty + gap_penalty + abnormal_penalty))

    if quality_score >= 0.9:
        quality = "EXCELLENT"
        signal = None
    elif quality_score >= 0.7:
        quality = "GOOD"
        signal = None
    elif quality_score >= 0.5:
        quality = "DEGRADED"
        signal = "DATA_QUALITY_DEGRADED"
    else:
        quality = "UNRELIABLE"
        signal = "DATA_QUALITY_UNRELIABLE"

    # Persiste observação se qualidade degradada
    if quality in {"DEGRADED", "UNRELIABLE"}:
        await kb.save_observation(
            symbol=symbol,
            category="DATA_QUALITY",
            text=f"Qualidade de dados {quality}: latência {latency:.1f}s, gap máx {max_gap:.1f}s, movimentos anormais {abnormal_moves}",
            data={
                "quality": quality,
                "score": quality_score,
                "latency": round(latency, 2),
                "max_gap": round(max_gap, 2),
                "abnormal_moves": abnormal_moves,
                "abnormal_moves_ratio": round(abnormal_moves / len(prices) if prices else 0, 3)
            },
            confidence=quality_score
        )

    return {"quality": quality, "score": quality_score, "signal": signal}


def _detect_order_flow_imbalance(history: list[dict], window: int = 10) -> dict:
    """
    Detecta imbalance no order flow baseado em tick direction.
    Simula tick direction via price change.
    """
    if len(history) < window:
        return {"imbalance": 0.0, "signal": None}

    recent = history[-window:]
    up_ticks = 0
    down_ticks = 0

    for i in range(1, len(recent)):
        prev_price = recent[i-1].get("price", 0)
        curr_price = recent[i].get("price", 0)
        if prev_price > 0 and curr_price > 0:
            if curr_price > prev_price:
                up_ticks += 1
            elif curr_price < prev_price:
                down_ticks += 1

    total = up_ticks + down_ticks
    if total == 0:
        return {"imbalance": 0.0, "signal": None}

    imbalance = (up_ticks - down_ticks) / total

    # Imbalance significativo (> 0.6 ou < -0.6)
    if imbalance > 0.6:
        return {
            "imbalance": round(imbalance, 3),
            "direction": "BUYING_PRESSURE",
            "signal": "ORDER_FLOW_IMBALANCE_BUY",
            "confidence": min(0.8, 0.5 + abs(imbalance))
        }
    elif imbalance < -0.6:
        return {
            "imbalance": round(imbalance, 3),
            "direction": "SELLING_PRESSURE",
            "signal": "ORDER_FLOW_IMBALANCE_SELL",
            "confidence": min(0.8, 0.5 + abs(imbalance))
        }

    return {"imbalance": round(imbalance, 3), "signal": None}


def _detect_liquidity_sweep(history: list[dict], lookback: int = 20) -> dict:
    """
    Detecta liquidity sweep: preço quebra nível chave e reverte rapidamente.
    """
    if len(history) < lookback:
        return {"sweep": False, "signal": None}

    recent = history[-lookback:]
    prices = [h.get("price", 0) for h in recent if h.get("price", 0) > 0]

    if len(prices) < lookback // 2:
        return {"sweep": False, "signal": None}

    # Níveis chave: high e low do período
    high = max(prices)
    low = min(prices)
    current = prices[-1]
    prev_2 = prices[-3] if len(prices) >= 3 else current

    # Detecta sweep de high (quebra seguida de reversão)
    if prev_2 >= high * 0.998 and current < high * 0.995:
        return {
            "sweep": True,
            "type": "HIGH_SWEEP_REVERSAL",
            "signal": "LIQUIDITY_SWEEP_SHORT",
            "confidence": 0.65,
            "action": "SHORT_ON_REVERSAL"
        }

    # Detecta sweep de low
    if prev_2 <= low * 1.002 and current > low * 1.005:
        return {
            "sweep": True,
            "type": "LOW_SWEEP_REVERSAL",
            "signal": "LIQUIDITY_SWEEP_LONG",
            "confidence": 0.65,
            "action": "LONG_ON_REVERSAL"
        }

    return {"sweep": False, "signal": None}


# ========== FUNÇÕES EXISTENTES (mantidas intactas) ==========

def on_alert(fn):
    _alert_callbacks.append(fn)


def get_active_alerts(max_age_seconds: int = 300) -> list[TacticalAlert]:
    cutoff = time.time() - max_age_seconds
    return [a for a in _active_alerts if a.timestamp >= cutoff]


def get_snapshot_history(symbol: str, window_seconds: int = 300) -> list[dict]:
    sym = symbol.upper()
    if not sym.endswith("-USDT"):
        sym = f"{sym}-USDT"
    cutoff = time.time() - window_seconds
    in_memory = [x for x in _snap_buffer[sym] if x.get("timestamp", 0) >= cutoff]
    if in_memory:
        return in_memory
    # After a restart the in-memory deque is empty.  Fall back to the persisted
    # feature_snapshots DB so that signal finalization can still run.
    try:
        import asyncio
        hours_needed = max(1, int(window_seconds / 3600) + 1)
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Can't block — return empty; caller should use async fallback
            return []
        rows = loop.run_until_complete(kb.get_feature_history(sym, hours=hours_needed))
        return [r for r in rows if r.get("timestamp", 0) >= cutoff]
    except Exception:
        return []


def get_all_snapshot_history(window_seconds: int = 300) -> dict[str, list[dict]]:
    return {sym: get_snapshot_history(sym, window_seconds) for sym in SYMBOLS}


def _classify_pattern(snap: MarketSnapshot, history: list[dict]) -> list[str]:
    """Identifica padrões nomeados a partir das condições atuais."""
    patterns = []

    if snap.oi_change_pct >= 5 and snap.price_change_pct >= 0.5 and snap.volume_ratio >= 2:
        patterns.append("OI_PRICE_VOL_TRIPLE_UP")

    if snap.oi_change_pct >= 5 and snap.price_change_pct <= -0.5:
        patterns.append("OI_UP_PRICE_DOWN")

    if snap.funding_rate <= -0.0003 and snap.rsi_approx <= 35:
        patterns.append("NEGATIVE_FUNDING_OVERSOLD")

    if snap.funding_rate >= 0.0003 and snap.rsi_approx >= 65:
        patterns.append("POSITIVE_FUNDING_OVERBOUGHT")

    if snap.volume_ratio >= 3 and abs(snap.price_change_pct) <= 0.3:
        patterns.append("HIGH_VOL_LOW_MOVE")

    if snap.btc_regime == "NEUTRAL" and snap.oi_change_pct >= 4 and snap.funding_rate <= 0.0001:
        patterns.append("BTC_LATERAL_OI_BUILD")

    if len(history) >= 10:
        prices = [h.get("price", 0) for h in history[-10:]]
        if prices[-1] > 0 and min(prices) > 0:
            move = (prices[-1] - prices[0]) / prices[0] * 100
            if move >= 1.5 and snap.volume_ratio >= 2:
                patterns.append("BREAKOUT_UP_CONFIRMED")
            elif move <= -1.5 and snap.volume_ratio >= 2:
                patterns.append("BREAKOUT_DOWN_CONFIRMED")

    return patterns


async def _process_snapshot(snap: MarketSnapshot):
    """Processa um snapshot: detecta padrões, cria alertas, persiste observações."""
    sym = snap.symbol
    _snap_buffer[sym].append({
        "price": snap.price,
        "bid": snap.bid,
        "ask": snap.ask,
        "spread_bps": snap.spread_bps,
        "effective_spread_bps": snap.effective_spread_bps,
        "atr_pct": snap.atr_pct,
        "price_change_pct": snap.price_change_pct,
        "oi_change_pct": snap.oi_change_pct,
        "funding_rate": snap.funding_rate,
        "volume_ratio": snap.volume_ratio,
        "volume_imbalance": snap.volume_imbalance,
        "rsi": snap.rsi_approx,
        "btc_regime": snap.btc_regime,
        "timestamp": snap.timestamp,
        "high_24h": snap.high_24h,
        "low_24h": snap.low_24h,
        "bid_depth_5": snap.bid_depth_5,
        "ask_depth_5": snap.ask_depth_5,
        "book_imbalance": snap.bid_ask_imbalance,
        "cvd": snap.cumulative_delta,
        "data_quality_score": snap.data_quality_score,
        "price_confidence": snap.price_confidence,
        "latency_ms": snap.latency_ms,
    })

    history = list(_snap_buffer[sym])

    # ========== NOVAS DETECÇÕES PARA EXCELÊNCIA ==========

    # 1. Qualidade dos dados
    data_quality = await _assess_data_quality(sym, history)
    if data_quality.get("signal"):
        snap.anomalies.append(data_quality["signal"])

    # 2. Liquidez tóxica
    toxic_liquidity = _detect_toxic_liquidity(history)
    if toxic_liquidity.get("signal"):
        snap.anomalies.append(f"{toxic_liquidity['signal']}: spread {toxic_liquidity['avg_spread_bps']}bps")

    # 3. Volatilidade exausta
    vol_exhaustion = _detect_volatility_exhaustion(history)
    if vol_exhaustion.get("signal"):
        snap.anomalies.append(f"{vol_exhaustion['signal']}: vol caiu {vol_exhaustion['contraction_pct']:.0f}%")

    # 4. Order flow imbalance
    ofi = _detect_order_flow_imbalance(history)
    if ofi.get("signal"):
        snap.anomalies.append(f"{ofi['signal']}: imbalance {ofi['imbalance']:.2f}")

    # 5. Liquidity sweep
    sweep = _detect_liquidity_sweep(history)
    if sweep.get("signal"):
        snap.anomalies.append(f"{sweep['signal']}: {sweep['type']}")

    # 6. Cointegração
    for pair in COINTEGRATION_PAIRS:
        if sym in pair:
            other = pair[0] if pair[1] == sym else pair[1]
            other_snap = None
            for s, snap_obj in _snap_buffer.items():
                if s == other and snap_obj:
                    other_snap = snap_obj[-1] if snap_obj else None
                    break

            if other_snap and other_snap.get("price", 0) > 0:
                tracker = _get_or_create_cointegration_tracker(pair[0], pair[1])
                signal = tracker.update(snap.price, other_snap["price"])
                if signal:
                    snap.anomalies.append(f"{signal['type']}: z={signal['zscore']}")
                    await kb.save_observation(
                        symbol=sym,
                        category="COINTEGRATION",
                        text=f"Cointegração detectada: {signal['message'] if 'message' in signal else signal['type']}",
                        data=signal,
                        confidence=signal.get("confidence", 0.6)
                    )

    # 7. Microestrutura
    micro_anomaly = _detect_micro_structure_anomaly(history)
    if micro_anomaly.get("signal"):
        snap.anomalies.append(f"{micro_anomaly['signal']}: {micro_anomaly.get('type', 'unknown')}")

    # ========== PERSISTÊNCIA EXISTENTE ==========

    # Persiste snapshot na KB a cada ~30s
    if int(snap.timestamp) % 30 < 5:
        await kb.save_feature_snapshot(sym, {
            "price": snap.price,
            "bid": snap.bid,
            "ask": snap.ask,
            "price_change_pct": snap.price_change_pct,
            "volume_ratio": snap.volume_ratio,
            "oi_change_pct": snap.oi_change_pct,
            "funding_rate": snap.funding_rate,
            "rsi": snap.rsi_approx,
            "ema_cross": "FLAT",
            "atr_pct": snap.atr_pct,
            "spread_bps": snap.spread_bps,
            "btc_regime": snap.btc_regime,
            "bid_depth_5": snap.bid_depth_5,
            "ask_depth_5": snap.ask_depth_5,
            "book_imbalance": snap.bid_ask_imbalance,
            "cvd": snap.cumulative_delta,
        })

    if not snap.anomalies:
        return

    pattern_names = _classify_pattern(snap, history)

    for pat_name in pattern_names:
        patterns_db = await kb.get_top_patterns(min_occurrences=1, limit=100)
        match = next(
            (p for p in patterns_db if p["name"] == pat_name and p["symbol"] == sym),
            None
        )
        similar_occ = match["occurrences"] if match else 0
        avg_ret = match["avg_return"] if match else 0.0
        win_rate = match["win_rate"] if match else 0.0

        confidence = min(0.95, 0.4 + (similar_occ / 100) * 0.55) if similar_occ else 0.4

        msg = _build_alert_message(sym, pat_name, snap, similar_occ, avg_ret, win_rate)

        alert = TacticalAlert(
            symbol=sym,
            alert_type=pat_name,
            message=msg,
            confidence=round(confidence, 2),
            similar_occurrences=similar_occ,
            avg_return_past=round(avg_ret, 4),
            win_rate_past=round(win_rate, 4),
            conditions={
                "oi_change_pct": snap.oi_change_pct,
                "price_change_pct": snap.price_change_pct,
                "volume_ratio": snap.volume_ratio,
                "funding_rate": snap.funding_rate,
                "rsi": snap.rsi_approx,
                "btc_regime": snap.btc_regime,
            },
        )

        _active_alerts.append(alert)
        if len(_active_alerts) > 500:
            _active_alerts.pop(0)

        await kb.save_observation(
            symbol=sym,
            category="TACTICAL_ALERT",
            text=msg,
            data={
                "pattern": pat_name,
                "anomalies": snap.anomalies,
                "conditions": alert.conditions,
                "confidence": confidence,
                "similar_occ": similar_occ,
                "avg_return": avg_ret,
                "win_rate": win_rate,
            },
            confidence=confidence,
        )
        await asyncio.sleep(0)

        for cb in _alert_callbacks:
            try:
                await cb(alert)
            except Exception:
                pass

        log.info(f"ALERT [{sym}] {pat_name} | conf={confidence:.0%} | occ={similar_occ} | wr={win_rate:.0%}")


def _build_alert_message(
    symbol: str, pattern: str, snap: MarketSnapshot,
    similar_occ: int, avg_ret: float, win_rate: float
) -> str:
    short = symbol.replace("-USDT", "")
    lines = [f"⚡ ALERTA — {short}", f"Padrão: {pattern}"]

    if snap.oi_change_pct != 0:
        lines.append(f"Open Interest: {snap.oi_change_pct:+.1f}%")
    if snap.price_change_pct != 0:
        lines.append(f"Preço: {snap.price_change_pct:+.2f}%")
    if snap.volume_ratio > 1.2:
        lines.append(f"Volume: {snap.volume_ratio:.1f}×")
    if abs(snap.funding_rate) > 0:
        lines.append(f"Funding: {snap.funding_rate:+.4f}")

    if similar_occ >= 5:
        lines.append(f"\nOcorrências similares: {similar_occ}")
        lines.append(f"Retorno médio histórico: {avg_ret:+.2f}%")
        lines.append(f"Win rate histórico: {win_rate:.0%}")
    else:
        lines.append("\nPadrão novo — sem histórico suficiente")

    return "\n".join(lines)


async def _detect_lead_lag(snaps: dict[str, MarketSnapshot]):
    """Detecta se movimentos de um ativo precedem outros (ex: SOL → ETH)."""
    buf = {}
    for sym, snap in snaps.items():
        h = list(_snap_buffer[sym])
        if len(h) >= 4:
            prices = [x["price"] for x in h[-4:]]
            if prices[0] > 0:
                buf[sym] = (prices[-1] - prices[0]) / prices[0] * 100

    if len(buf) < 2:
        return

    movers = [(sym, mv) for sym, mv in buf.items() if abs(mv) >= 0.5]
    for sym, mv in movers:
        for other_sym, other_mv in buf.items():
            if other_sym == sym:
                continue
            if abs(mv) >= 1.0 and abs(other_mv) <= 0.2:
                direction = "LONG" if mv > 0 else "SHORT"
                msg = (
                    f"Lead-lag detectado: {sym.replace('-USDT','')} moveu {mv:+.2f}% "
                    f"enquanto {other_sym.replace('-USDT','')} ainda está flat ({other_mv:+.2f}%). "
                    f"Potencial setup {direction} em {other_sym.replace('-USDT','')}."
                )
                await kb.save_observation(
                    symbol=other_sym,
                    category="LEAD_LAG",
                    text=msg,
                    data={"leader": sym, "leader_move": mv, "lagger": other_sym, "lagger_move": other_mv},
                    confidence=0.55,
                )


_tactical_initialized = False
async def process_tactical_cycle(engine: FeatureEngine) -> dict:
    """Run one bounded tactical cycle. Runtime supervisor owns scheduling."""
    global _tactical_initialized

    if not _tactical_initialized:
        await kb.init_db()
        engine.on_snapshot(_process_snapshot)
        _tactical_initialized = True

    snaps = await engine.snapshot_all()
    await _detect_lead_lag(snaps)

    return {
        "snapshots": len(snaps),
        "finalizedSignals": False,
        "activeAlerts": len(_active_alerts),
    }


async def run_tactical_loop(engine: FeatureEngine, interval_seconds: int = 5):
    """Compatibility loop. Prefer process_tactical_cycle under JobSupervisor."""
    log.info(f"Tactical loop iniciado (interval={interval_seconds}s)")
    while True:
        try:
            await process_tactical_cycle(engine)
        except Exception as e:
            log.error(f"Tactical loop error: {e}")
        await asyncio.sleep(interval_seconds)


# ═══════════════════════════════════════════════════════════════════════════════
# SNIPER ENTRY ENGINE — Multi-signal confluence for precision entries
# ═══════════════════════════════════════════════════════════════════════════════

from dataclasses import field as _field


@dataclass
class SniperOpportunity:
    symbol: str
    side: str                   # LONG | SHORT
    confluence_score: float     # 0.0–1.0 weighted sum
    entry_price: float
    signals: list               # active signal names
    signal_details: dict        # per-signal breakdown
    confidence: float           # calibrated confidence
    timestamp: float = _field(default_factory=time.time)


@dataclass
class MassEntryZone:
    symbol: str
    side: str
    base_price: float
    levels: list                # [{index, label, price, position_weight_pct, trigger_deviation_pct}]
    total_confluence: float
    strategy: str               # LADDER | CLUSTER | SINGLE
    timestamp: float = _field(default_factory=time.time)


# ── Signal scorers ─────────────────────────────────────────────────────────────

def _score_rsi_divergence(history: list[dict], side: str) -> tuple:
    """RSI divergence: price new low + RSI higher low = bullish; vice versa for bearish."""
    if len(history) < 20:
        return 0.0, "INSUFFICIENT_DATA"

    prices = [h.get("price", 0) for h in history[-20:] if h.get("price", 0) > 0]
    rsis   = [h.get("rsi", 50) for h in history[-20:]]

    if len(prices) < 10:
        return 0.0, "INSUFFICIENT_PRICES"

    mid = len(prices) // 2
    early_low  = min(prices[:mid])
    late_low   = min(prices[mid:])
    early_high = max(prices[:mid])
    late_high  = max(prices[mid:])
    early_rsi  = sum(rsis[:mid]) / max(1, mid)
    late_rsi   = sum(rsis[mid:]) / max(1, len(rsis) - mid)

    if side == "LONG":
        if late_low < early_low * 0.998 and late_rsi > early_rsi + 3:
            s = min(1.0, (late_rsi - early_rsi) / 15)
            return round(0.5 + s * 0.4, 3), "BULLISH_DIVERGENCE"
    else:
        if late_high > early_high * 1.002 and late_rsi < early_rsi - 3:
            s = min(1.0, (early_rsi - late_rsi) / 15)
            return round(0.5 + s * 0.4, 3), "BEARISH_DIVERGENCE"

    return 0.0, "NO_DIVERGENCE"


def _score_momentum_burst(history: list[dict], side: str, window: int = 6) -> tuple:
    """Aceleração de preço na direção do trade."""
    if len(history) < window:
        return 0.0, "INSUFFICIENT_DATA"

    recent = history[-window:]
    prices = [h.get("price", 0) for h in recent if h.get("price", 0) > 0]

    if len(prices) < 3:
        return 0.0, "NO_PRICES"

    velocity = (prices[-1] - prices[0]) / prices[0] * 100

    if side == "LONG" and velocity > 0.3:
        s = min(1.0, velocity / 1.5)
        return round(s * 0.75, 3), f"LONG_MOMENTUM_{velocity:.2f}pct"
    elif side == "SHORT" and velocity < -0.3:
        s = min(1.0, abs(velocity) / 1.5)
        return round(s * 0.75, 3), f"SHORT_MOMENTUM_{abs(velocity):.2f}pct"

    return 0.0, "NO_BURST"


def _score_funding_extreme(funding_rate: float, side: str) -> tuple:
    """Funding rate extremo → mean-reversion bias."""
    if side == "LONG" and funding_rate < -0.0005:
        s = min(0.85, abs(funding_rate) / 0.002 * 0.85)
        return round(s, 3), f"NEG_FUNDING_{funding_rate:.5f}"
    if side == "SHORT" and funding_rate > 0.0005:
        s = min(0.85, funding_rate / 0.002 * 0.85)
        return round(s, 3), f"POS_FUNDING_{funding_rate:.5f}"
    return 0.0, "NEUTRAL_FUNDING"


def _score_vol_squeeze_breakout(history: list[dict], side: str) -> tuple:
    """Vol comprimida seguida de explosão → entrada no breakout."""
    if len(history) < 15:
        return 0.0, "INSUFFICIENT_DATA"

    mid   = len(history) // 2
    early = history[:mid]
    late  = history[mid:]

    def avg_abs_chg(lst):
        vals = [abs(h.get("price_change_pct", 0)) for h in lst]
        return sum(vals) / max(1, len(vals))

    early_vol = avg_abs_chg(early)
    late_vol  = avg_abs_chg(late)

    if early_vol > 0 and late_vol > early_vol * 1.8 and late_vol > 0.15:
        chg = late[-1].get("price_change_pct", 0) if late else 0
        if side == "LONG" and chg > 0:
            return 0.70, "VOL_SQUEEZE_BREAKOUT_LONG"
        if side == "SHORT" and chg < 0:
            return 0.70, "VOL_SQUEEZE_BREAKOUT_SHORT"

    return 0.0, "NO_SQUEEZE"


def _score_book_imbalance(snap: dict, side: str) -> tuple:
    """Imbalance de book de ordens favorável ao lado."""
    imb = snap.get("book_imbalance", 0.0)
    if imb == 0:
        return 0.0, "NO_BOOK_DATA"
    if side == "LONG" and imb > 0.15:
        s = min(0.80, imb * 2)
        return round(s, 3), f"BOOK_BID_HEAVY_{imb:.3f}"
    if side == "SHORT" and imb < -0.15:
        s = min(0.80, abs(imb) * 2)
        return round(s, 3), f"BOOK_ASK_HEAVY_{imb:.3f}"
    return 0.0, "NEUTRAL_BOOK"


def _score_cvd_bias(snap: dict, side: str) -> tuple:
    """Cumulative delta de volume aponta para a direção."""
    cvd = snap.get("cvd", 0.0)
    if cvd == 0:
        return 0.0, "NO_CVD"
    if side == "LONG" and cvd > 0.10:
        s = min(0.75, cvd * 1.5)
        return round(s, 3), f"CVD_POSITIVE_{cvd:.3f}"
    if side == "SHORT" and cvd < -0.10:
        s = min(0.75, abs(cvd) * 1.5)
        return round(s, 3), f"CVD_NEGATIVE_{cvd:.3f}"
    return 0.0, "NEUTRAL_CVD"


# ── SniperEntryEngine ──────────────────────────────────────────────────────────

class SniperEntryEngine:
    """
    Confluência de 8 sinais independentes por símbolo e lado.
    Score ponderado >= THRESHOLD → oportunidade sniper.
    """

    SIGNAL_WEIGHTS = {
        "rsi_divergence": 0.22,
        "order_flow":     0.18,
        "volume_spike":   0.15,
        "momentum_burst": 0.14,
        "book_imbalance": 0.12,
        "cvd_bias":       0.10,
        "funding_extreme":0.05,
        "vol_squeeze":    0.04,
    }
    THRESHOLD = 0.52

    def score_symbol(
        self, sym: str, snap: dict, history: list[dict]
    ) -> Optional[SniperOpportunity]:
        price = snap.get("price", 0)
        if not history or price <= 0:
            return None
        best: Optional[SniperOpportunity] = None
        for side in ("LONG", "SHORT"):
            opp = self._score_side(sym, side, snap, history, price)
            if opp and (best is None or opp.confluence_score > best.confluence_score):
                best = opp
        return best

    def _score_side(self, sym, side, snap, history, price) -> Optional[SniperOpportunity]:
        scores: dict[str, float] = {}
        labels: list[str] = []
        details: dict = {}

        # 1. RSI divergence
        rsi_s, rsi_lbl = _score_rsi_divergence(history, side)
        scores["rsi_divergence"] = rsi_s
        if rsi_s > 0:
            labels.append(rsi_lbl)
            details["rsi_divergence"] = {"score": rsi_s, "label": rsi_lbl}

        # 2. Order flow imbalance
        ofi = _detect_order_flow_imbalance(history)
        ofi_ok = (side == "LONG" and ofi.get("direction") == "BUYING_PRESSURE") or \
                 (side == "SHORT" and ofi.get("direction") == "SELLING_PRESSURE")
        ofi_s = round(ofi.get("confidence", 0) * 0.9, 3) if ofi_ok else 0.0
        scores["order_flow"] = ofi_s
        if ofi_s > 0:
            labels.append(ofi.get("signal", "OFI"))
            details["order_flow"] = {"score": ofi_s, "direction": ofi.get("direction")}

        # 3. Volume spike + direction
        vol_ratio = snap.get("volume_ratio", 1.0)
        price_chg = snap.get("price_change_pct", 0.0)
        vol_ok = (side == "LONG" and vol_ratio >= 1.5 and price_chg > 0) or \
                 (side == "SHORT" and vol_ratio >= 1.5 and price_chg < 0)
        vol_s = round(min(0.85, (vol_ratio - 1) / 3), 3) if vol_ok else 0.0
        scores["volume_spike"] = vol_s
        if vol_s > 0:
            labels.append(f"VOL_SPIKE_{vol_ratio:.1f}x")
            details["volume_spike"] = {"score": vol_s, "vol_ratio": round(vol_ratio, 2)}

        # 4. Momentum burst
        mom_s, mom_lbl = _score_momentum_burst(history, side)
        scores["momentum_burst"] = mom_s
        if mom_s > 0:
            labels.append(mom_lbl)
            details["momentum_burst"] = {"score": mom_s, "label": mom_lbl}

        # 5. Book imbalance
        book_s, book_lbl = _score_book_imbalance(snap, side)
        scores["book_imbalance"] = book_s
        if book_s > 0:
            labels.append(book_lbl)
            details["book_imbalance"] = {"score": book_s}

        # 6. CVD bias
        cvd_s, cvd_lbl = _score_cvd_bias(snap, side)
        scores["cvd_bias"] = cvd_s
        if cvd_s > 0:
            labels.append(cvd_lbl)
            details["cvd_bias"] = {"score": cvd_s, "cvd": round(snap.get("cvd", 0), 4)}

        # 7. Funding extreme
        fund_s, fund_lbl = _score_funding_extreme(snap.get("funding_rate", 0), side)
        scores["funding_extreme"] = fund_s
        if fund_s > 0:
            labels.append(fund_lbl)
            details["funding_extreme"] = {"score": fund_s, "rate": snap.get("funding_rate")}

        # 8. Volatility squeeze breakout
        sq_s, sq_lbl = _score_vol_squeeze_breakout(history, side)
        scores["vol_squeeze"] = sq_s
        if sq_s > 0:
            labels.append(sq_lbl)
            details["vol_squeeze"] = {"score": sq_s}

        # Weighted confluence
        total = sum(self.SIGNAL_WEIGHTS.get(k, 0) * v for k, v in scores.items())

        if total < self.THRESHOLD:
            return None

        active    = sum(1 for v in scores.values() if v > 0)
        confidence = round(min(0.92, 0.42 + active * 0.08), 3)

        return SniperOpportunity(
            symbol=sym,
            side=side,
            confluence_score=round(total, 4),
            entry_price=price,
            signals=labels,
            signal_details=details,
            confidence=confidence,
        )


_sniper_engine = SniperEntryEngine()


async def compute_sniper_opportunities(engine: "FeatureEngine") -> list:
    """Varre todos os símbolos e retorna SniperOpportunities ordenadas por score."""
    snaps_obj = engine.get_all_snapshots()
    opps = []
    for sym, snap_obj in snaps_obj.items():
        snap    = engine.to_dict(snap_obj)
        history = list(_snap_buffer.get(sym, deque()))
        opp     = _sniper_engine.score_symbol(sym, snap, history)
        if opp:
            opps.append(opp)
    opps.sort(key=lambda x: x.confluence_score, reverse=True)
    return opps


def compute_mass_entry_zones(
    symbol: str,
    history: list[dict],
    side: str,
    n_levels: int = 3,
    step_pct: float = 0.30,
) -> Optional[MassEntryZone]:
    """
    Gera N níveis de entrada escalonados (ladder) para entrada em massa.
    Pesos Kelly-inspirados: entrada imediata com maior exposição.
    """
    if not history:
        return None
    current = history[-1].get("price", 0)
    if current <= 0:
        return None
    tp_pct = max(0.01, float(os.environ.get("SHADOW_SAMPLER_TAKE_PROFIT_PCT", "0.22")))
    sl_pct = max(0.01, float(os.environ.get("SHADOW_SAMPLER_STOP_LOSS_PCT", "0.55")))

    weight_map = {1: [1.0], 2: [0.55, 0.45], 3: [0.40, 0.35, 0.25]}
    label_map  = {1: ["IMMEDIATE"], 2: ["IMMEDIATE", "LIMIT_1"],
                  3: ["IMMEDIATE", "LIMIT_1", "LIMIT_2"]}
    weights = weight_map.get(n_levels, [0.40, 0.35, 0.25])
    lbl_arr = label_map.get(n_levels, ["IMMEDIATE", "LIMIT_1", "LIMIT_2"])

    levels = []
    for i, (w, lbl) in enumerate(zip(weights, lbl_arr)):
        deviation = i * step_pct
        if side == "LONG":
            price = current * (1 - deviation / 100)
            target_price = price * (1 + tp_pct / 100)
            stop_price = price * (1 - sl_pct / 100)
        else:
            price = current * (1 + deviation / 100)
            target_price = price * (1 - tp_pct / 100)
            stop_price = price * (1 + sl_pct / 100)
        levels.append({
            "index": i,
            "level": i + 1,
            "label": lbl,
            "price": round(price, 6),
            "triggerPrice": round(price, 6),
            "targetPrice": round(target_price, 6),
            "stopPrice": round(stop_price, 6),
            "position_weight_pct": round(w * 100, 1),
            "allocationFactor": round(w, 6),
            "trigger_deviation_pct": round(deviation, 2),
        })

    strategy = {1: "SINGLE", 2: "CLUSTER", 3: "LADDER"}.get(n_levels, "LADDER")
    return MassEntryZone(
        symbol=symbol,
        side=side,
        base_price=current,
        levels=levels,
        total_confluence=1.0,
        strategy=strategy,
    )


async def compute_all_mass_entry_zones(
    engine: "FeatureEngine",
    opportunities: list,
) -> list:
    """Para cada oportunidade sniper de alta confluência, gera zona de entrada em massa."""
    zones = []
    for opp in opportunities:
        if opp.confluence_score < 0.60:
            continue
        history = list(_snap_buffer.get(opp.symbol, deque()))
        n = 3 if opp.confluence_score >= 0.72 else 2
        zone = compute_mass_entry_zones(opp.symbol, history, opp.side, n_levels=n)
        if zone:
            zone.total_confluence = opp.confluence_score
            zones.append(zone)
    return zones
