from __future__ import annotations

import asyncio
import math
import random
import time
from datetime import datetime, timezone
from typing import Any

from core.movement_sniper import evaluate_sniper_window
from core import knowledge_base as kb
from core.recommendation import recommend_entry
from core.signal_learning import (
    finalize_due_signal_outcomes,
    record_signal_from_gate,
    score_signal_context,
)
from core.shadow_model import predict_shadow
from core.database import connect
from layers.tactical import get_snapshot_history


def _target_moves(config: dict[str, Any]) -> dict[str, float]:
    margin = max(_num(config.get("marginPerTrade"), 1.0), 0.01)
    leverage = max(_num(config.get("leverage"), 1.0), 1.0)
    notional = margin * leverage
    fees_bps = (
        _num(config.get("entryFeeBps", config.get("takerFeeBps")), 5.0)
        + _num(config.get("exitFeeBps", config.get("takerFeeBps")), 5.0)
        + 2 * _num(config.get("slippageBpsPerSide"), 2.0)
    )
    costs_pct = fees_bps / 100 + max(0.0, _num(config.get("estimatedFundingCostPct"), 0.0))
    targets = {
        str(target): target / notional * 100 + costs_pct
        for target in (0.5, 1.0, 2.0)
    }
    targets["configured"] = max(0.0, _num(config.get("takeProfitPct"), 0.15))
    return targets


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        if value is None:
            return fallback
        return float(value)
    except Exception:
        return fallback


def _bool(value: Any, fallback: bool = False) -> bool:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"1", "true", "yes", "on"}


def _list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value:
        return [x.strip() for x in value.split(",") if x.strip()]
    return []


def _position_to_side(position_side: str | None, side: str | None) -> str:
    raw = (position_side or side or "").upper()
    if raw in {"LONG", "BUY"}:
        return "LONG"
    if raw in {"SHORT", "SELL"}:
        return "SHORT"
    return raw or "UNKNOWN"


def _btc_regime_from_change(change_pct: float, threshold: float) -> str:
    if abs(change_pct) < threshold:
        return "NEUTRAL"
    return "BULL" if change_pct > 0 else "BEAR"


# ========== NOVAS FUNÇÕES DE EXCELÊNCIA TÉCNICA ==========

def _calculate_kelly_fraction(win_rate: float, avg_win: float, avg_loss: float) -> float:
    """
    Kelly Criterion - tamanho ótimo de posição baseado em edge.
    Fórmula clássica: f* = (p * b - q) / b
    onde p = win_rate, q = 1-p, b = avg_win/avg_loss
    """
    if avg_loss <= 0:
        return 0.0

    b = avg_win / abs(avg_loss) if avg_loss != 0 else 1.0
    q = 1 - win_rate

    kelly = (win_rate * b - q) / b if b > 0 else 0.0

    # Limita a 25% do capital para segurança (Kelly fracionário)
    # Scalpers usam Kelly fracionário (1/4 a 1/2)
    return max(0.0, min(0.25, kelly * 0.5))


def _calculate_optimal_position_size(
    equity_usdt: float,
    win_rate: float,
    avg_win_usdt: float,
    avg_loss_usdt: float,
    max_risk_pct: float = 0.02
) -> dict[str, Any]:
    """
    Calcula tamanho de posição ótimo usando Kelly e risco fixo.
    Retorna o menor entre Kelly e risco máximo.
    """
    kelly_fraction = _calculate_kelly_fraction(win_rate, avg_win_usdt, abs(avg_loss_usdt))

    # Tamanho baseado em risco fixo (2% da conta)
    risk_based_size = equity_usdt * max_risk_pct / abs(avg_loss_usdt) if abs(avg_loss_usdt) > 0 else 0

    # Tamanho baseado em Kelly
    kelly_based_size = equity_usdt * kelly_fraction

    optimal_size = min(risk_based_size, kelly_based_size) if kelly_based_size > 0 else 0.0

    return {
        "optimal_margin_usdt": round(optimal_size, 2),
        "kelly_fraction": round(kelly_fraction, 4),
        "risk_based_margin_usdt": round(risk_based_size, 2),
        "max_risk_pct": max_risk_pct,
        "recommendation": "USE_OPTIMAL" if optimal_size > 0 else "TOO_SMALL_EDGE"
    }


def _calculate_correlation_penalty(correlations: dict[str, float], symbols_in_position: list[str]) -> float:
    """
    Penaliza entradas correlacionadas para evitar superexposição.
    Ex: se SOL e ETH têm correlação 0.8, não entrar nos dois simultaneamente.
    """
    if not symbols_in_position or not correlations:
        return 1.0

    max_correlation = 0.0
    for sym in symbols_in_position:
        corr = correlations.get(sym, 0.0)
        if corr > max_correlation:
            max_correlation = corr

    # Penalidade: correlação 0.5 reduz 10%, 0.8 reduz 30%, 0.95 reduz 50%
    penalty = 1.0 - (max_correlation * 0.5)
    return max(0.5, min(1.0, penalty))


def _calculate_market_regime_confidence(
    btc_regime: str,
    btc_volatility_pct: float,
    btc_trend_strength: float,
    alt_correlation: float
) -> dict[str, Any]:
    """
    Avalia confiança no regime de mercado atual.
    Baseado em: volatilidade BTC, força da tendência, correlação alt/BTC.
    """
    confidence = 0.5

    if btc_regime == "BULL":
        if btc_trend_strength > 0.3:
            confidence = 0.8
        elif btc_trend_strength > 0.15:
            confidence = 0.65
        else:
            confidence = 0.5
    elif btc_regime == "BEAR":
        if btc_trend_strength < -0.3:
            confidence = 0.8
        elif btc_trend_strength < -0.15:
            confidence = 0.65
        else:
            confidence = 0.5
    else:  # NEUTRAL
        confidence = 0.4

    # Penaliza volatilidade muito alta (incerteza)
    if btc_volatility_pct > 3.0:
        confidence *= 0.7
    elif btc_volatility_pct > 2.0:
        confidence *= 0.85

    # Penaliza correlação baixa (alt pode estar fazendo algo diferente)
    if alt_correlation < 0.5:
        confidence *= 0.8

    return {
        "regime_confidence": round(confidence, 3),
        "btc_regime": btc_regime,
        "btc_volatility_pct": round(btc_volatility_pct, 2),
        "btc_trend_strength": round(btc_trend_strength, 3),
        "alt_correlation": round(alt_correlation, 3)
    }


def _calculate_volatility_adjusted_stop(
    atr_pct: float,
    base_stop_pct: float,
    volatility_regime: str = "NORMAL"
) -> float:
    """
    Ajusta stop loss baseado na volatilidade atual.
    Volatilidade alta = stop mais largo, volatilidade baixa = stop mais justo.
    """
    if volatility_regime == "HIGH":
        multiplier = 1.5
    elif volatility_regime == "LOW":
        multiplier = 0.7
    else:
        multiplier = 1.0

    atr_adjusted = max(atr_pct * 1.5, base_stop_pct)  # Mínimo de 1.5x ATR
    return round(min(atr_adjusted * multiplier, base_stop_pct * 2.5), 4)


def _calculate_volatility_regime(historical_vols: list[float]) -> str:
    """Classifica regime de volatilidade baseado em percentis."""
    if len(historical_vols) < 20:
        return "NORMAL"

    current_vol = historical_vols[-1] if historical_vols else 0
    mean_vol = sum(historical_vols) / len(historical_vols)
    std_vol = math.sqrt(sum((v - mean_vol) ** 2 for v in historical_vols) / len(historical_vols)) if historical_vols else 0

    if current_vol > mean_vol + std_vol:
        return "HIGH"
    elif current_vol < mean_vol - std_vol:
        return "LOW"
    return "NORMAL"


def _calculate_sharpe_from_trades(returns: list[float], risk_free: float = 0.0) -> float:
    """Calcula Sharpe Ratio de trades realizados."""
    if len(returns) < 3:
        return 0.0

    mean_return = sum(returns) / len(returns)
    variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
    std_return = math.sqrt(variance) if variance > 0 else 0.0001

    if std_return == 0:
        return 0.0

    sharpe = (mean_return - risk_free) / std_return
    return sharpe * math.sqrt(365)  # Anualizado


def _calculate_bootstrap_ev_confidence(
    hit_probability: float,
    samples: int,
    net_target_usdt: float,
    loss_usdt: float,
    n_bootstrap: int = 1000
) -> dict[str, Any]:
    """
    Bootstrap para intervalo de confiança do Expected Value.
    Determina se EV > 0 é estatisticamente significativo.
    """
    if samples < 10:
        return {"ev_positive_confidence": 0.0, "reliable": False, "samples": samples}

    bootstrap_evs = []

    for _ in range(n_bootstrap):
        # Bootstrap da probabilidade de acerto
        bootstrap_hits = sum(1 for _ in range(samples) if random.random() < hit_probability)
        bootstrap_prob = bootstrap_hits / samples

        ev = bootstrap_prob * net_target_usdt - (1 - bootstrap_prob) * loss_usdt
        bootstrap_evs.append(ev)

    bootstrap_evs.sort()
    ev_positive_count = sum(1 for ev in bootstrap_evs if ev > 0)
    ev_positive_confidence = ev_positive_count / n_bootstrap

    # Percentis
    lower_5 = bootstrap_evs[int(n_bootstrap * 0.05)]
    upper_95 = bootstrap_evs[int(n_bootstrap * 0.95)]

    return {
        "ev_positive_confidence": round(ev_positive_confidence, 4),
        "ev_lower_5_percentile": round(lower_5, 4),
        "ev_upper_95_percentile": round(upper_95, 4),
        "reliable": samples >= 20,
        "samples": samples,
        "verdict": "POSITIVE_EV_CONFIRMED" if ev_positive_confidence > 0.95 else "POSITIVE_EV_LIKELY" if ev_positive_confidence > 0.8 else "POSITIVE_EV_UNCLEAR" if ev_positive_confidence > 0.5 else "NEGATIVE_EV"
    }


def _calculate_volatility_regime_from_history(history: list[dict]) -> tuple[str, float, list[float]]:
    """Extrai regime de volatilidade do histórico."""
    volatilities = []
    atr_values = [h.get("atr_pct", 0) for h in history if h.get("atr_pct", 0) > 0]

    if len(atr_values) >= 10:
        volatilities = atr_values[-30:] if len(atr_values) >= 30 else atr_values

    if len(volatilities) < 10:
        return "NORMAL", 0.0, []

    regime = _calculate_volatility_regime(volatilities)
    current_vol = volatilities[-1] if volatilities else 0

    return regime, current_vol, volatilities


def _calculate_correlation_from_history(
    alt_history: list[dict],
    btc_history: list[dict],
) -> float:
    """Calculate Pearson correlation from aligned recent price returns."""
    sample_count = min(len(alt_history), len(btc_history), 120)
    if sample_count < 10:
        return 0.0

    alt_prices = [float(item.get("price", 0) or 0) for item in alt_history[-sample_count:]]
    btc_prices = [float(item.get("price", 0) or 0) for item in btc_history[-sample_count:]]
    pairs = [
        (alt_prices[index - 1], alt_prices[index], btc_prices[index - 1], btc_prices[index])
        for index in range(1, sample_count)
        if alt_prices[index - 1] > 0
        and alt_prices[index] > 0
        and btc_prices[index - 1] > 0
        and btc_prices[index] > 0
    ]
    if len(pairs) < 8:
        return 0.0

    alt_returns = [(current - previous) / previous for previous, current, _, _ in pairs]
    btc_returns = [(current - previous) / previous for _, _, previous, current in pairs]
    alt_mean = sum(alt_returns) / len(alt_returns)
    btc_mean = sum(btc_returns) / len(btc_returns)
    covariance = sum(
        (alt_value - alt_mean) * (btc_value - btc_mean)
        for alt_value, btc_value in zip(alt_returns, btc_returns)
    )
    alt_variance = sum((value - alt_mean) ** 2 for value in alt_returns)
    btc_variance = sum((value - btc_mean) ** 2 for value in btc_returns)
    denominator = math.sqrt(alt_variance * btc_variance)
    return covariance / denominator if denominator > 0 else 0.0


async def _get_recent_returns(symbol: str, side: str, days: int = 30) -> list[float]:
    """Busca retornos recentes do símbolo para cálculo de Sharpe."""
    from core.knowledge_base import DB_PATH

    since = time.time() - days * 86400
    variants = (symbol, symbol.replace("-", ""))

    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT pnl_pct FROM trade_outcomes
               WHERE (symbol=? OR symbol=?) AND side=? AND timestamp >= ?
               ORDER BY timestamp DESC LIMIT 100""",
            (symbol, variants[1], side, since)
        )).fetchall()

    return [float(r[0] or 0) for r in rows]


# ========== FUNÇÃO PRINCIPAL EXISTENTE (COM ADIÇÕES) ==========

def _compute_aggressive_score(
    sniper: dict,
    signal_edge: dict,
    shadow_ml: dict,
    btc_regime: str,
    data_quality: dict,
    score_penalties: float,
    position_side: str,
) -> float:
    """
    Aggressive composite score for entry decisions.
    aggressiveScore = momentum*0.35 + candle*0.20 + volumeOI*0.15
                    + btcAlignment*0.10 + freshData*0.10
                    + realizedEdge*0.05 + shadowML*0.05 - penalties
    """
    alt_features = sniper.get("altFeatures") or {}
    btc_features = sniper.get("btcFeatures") or {}

    # 1. Momentum — sniper's 0-1 score (price accel, RSI, spread all baked in)
    momentum_score = max(0.0, min(1.0, float(sniper.get("score", 0.0))))

    # 2. Candle — use candleScore if provided, else derive from momentum
    candle_score = max(0.0, min(1.0, float(sniper.get("candleScore", momentum_score * 0.85))))

    # 3. Volume / OI — volume above average + OI moving = bullish confirmation
    volume_ratio = float(alt_features.get("volume_ratio", 1.0))
    oi_change_pct = float(alt_features.get("oi_change_pct", 0.0))
    volume_oi_score = min(1.0, max(0.0,
        0.50
        + min(0.30, (volume_ratio - 1.0) * 0.15)
        + min(0.20, abs(oi_change_pct) * 0.05)
    ))

    # 4. BTC alignment — regime match boosts, counter-regime reduces but does NOT block
    want_long = position_side == "LONG"
    btc_price_change = float(btc_features.get("price_change_pct", 0.0))
    if btc_regime == "BULL" and want_long:
        btc_alignment_score = 0.80
    elif btc_regime == "BEAR" and not want_long:
        btc_alignment_score = 0.80
    elif btc_regime == "NEUTRAL":
        btc_alignment_score = 0.50
    else:
        btc_alignment_score = 0.38  # counter-regime allowed, just lower score
    if abs(btc_price_change) > 0.5:
        btc_alignment_score = min(1.0, btc_alignment_score + 0.10)

    # 5. Fresh data — average 1m/5m/BTC coverage
    coverages = [
        float((data_quality.get("alt1m") or {}).get("coveragePct", 0.0)),
        float((data_quality.get("alt5m") or {}).get("coveragePct", 0.0)),
        float((data_quality.get("btc1m") or {}).get("coveragePct", 0.0)),
    ]
    fresh_data_score = sum(coverages) / max(len(coverages), 1)

    # 6. Realized edge — neutral when samples are too low (learning mode)
    edge_score = float(signal_edge.get("score", 0.5))
    edge_samples = int((signal_edge.get("symbolSide") or {}).get("samples", 0))
    realized_edge_score = 0.50 if edge_samples < 5 else max(0.0, min(1.0, edge_score))

    # 7. Shadow ML — neutral when no model yet
    if shadow_ml.get("available") and shadow_ml.get("calibratedProbability") is not None:
        shadow_ml_score = max(0.0, min(1.0, float(shadow_ml["calibratedProbability"])))
    else:
        shadow_ml_score = 0.50

    raw = (
        momentum_score      * 0.35
        + candle_score      * 0.20
        + volume_oi_score   * 0.15
        + btc_alignment_score * 0.10
        + fresh_data_score  * 0.10
        + realized_edge_score * 0.05
        + shadow_ml_score   * 0.05
    )
    return max(0.0, min(1.0, raw - score_penalties))


async def evaluate_edge_gate(payload: dict[str, Any]) -> dict[str, Any]:
    symbol = str(payload.get("symbol", "")).upper()
    if symbol and not symbol.endswith("-USDT"):
        symbol = f"{symbol}-USDT"
    position_side = _position_to_side(payload.get("positionSide"), payload.get("side"))
    side = str(payload.get("side", "")).upper()
    now_hour = datetime.now(timezone.utc).hour
    hour_utc = int(payload.get("hourUtc", payload.get("hour_utc", now_hour)))
    config = payload.get("config") or {}
    gate_rejects: list[str] = []
    # Risk profile controls how aggressively the gate filters entries.
    # aggressive / sniper_max: EV/ML adjust ranking only; hard-blocks are minimal.
    # balanced: EV becomes a penalty, hard-blocks remain.
    # conservative: full defensive gating (original behaviour).
    risk_profile = str(
        config.get("riskProfile")
        or config.get("decisionProfile")
        or payload.get("riskProfile")
        or payload.get("decisionProfile")
        or "balanced"
    ).lower()
    # demo_learning_aggressive: maximum learning velocity, only fatal hard-blocks fire
    is_aggressive = risk_profile in ("aggressive", "sniper_max", "demo_learning_aggressive")
    is_demo_learning = risk_profile == "demo_learning_aggressive"
    score_penalties: float = 0.0

    # ── Signal expiry check (contract v2) ──────────────────────────────────────
    signal_id = payload.get("signalId")
    market_event_id = payload.get("marketEventId")
    feature_version = payload.get("featureVersion", "sniper-v1")
    expires_at_ms = payload.get("expiresAt")
    if expires_at_ms is not None:
        try:
            if time.time() * 1000 > float(expires_at_ms):
                return {
                    "allow": False,
                    "gateRejects": ["SIGNAL_EXPIRED: signal expired before QB evaluation"],
                    "authority": "quant-brain",
                    "mode": "expired",
                    "signalId": signal_id,
                    "marketEventId": market_event_id,
                    "predictionTimestamp": time.time(),
                }
        except (TypeError, ValueError):
            pass

    # ── Sentiment context (24h directional bias from sentimentEngine.ts) ──────
    sentiment_ctx = payload.get("sentimentContext") or {}
    sentiment_direction = str(sentiment_ctx.get("direction", "NEUTRAL")).upper()
    sentiment_confidence = float(sentiment_ctx.get("confidence") or 0)
    sentiment_bias_ratio = float(sentiment_ctx.get("biasRatio") or 0.5)
    # True when 24h bias matches the requested position side
    sentiment_aligned = (
        (position_side == "LONG" and sentiment_direction == "BULL")
        or (position_side == "SHORT" and sentiment_direction == "BEAR")
    )
    # True when 24h bias strongly contradicts the requested side
    sentiment_counter = (
        (position_side == "LONG" and sentiment_direction == "BEAR")
        or (position_side == "SHORT" and sentiment_direction == "BULL")
    )
    # Hard-block counter-trend entries only when sentiment is very confident
    if (
        sentiment_counter
        and sentiment_confidence >= 0.75
        and sentiment_bias_ratio >= 0.72
    ):
        gate_rejects.append(
            f"SENTIMENT_COUNTER_REJECT: 24h bias {sentiment_direction} "
            f"({sentiment_confidence:.0%} conf, {sentiment_bias_ratio:.0%} weight) "
            f"conflicts with {position_side}"
        )

    # ========== GATES EXISTENTES (MANTIDOS) ==========
    allowed_symbols = _list(config.get("allowedSymbols"))
    if allowed_symbols and symbol not in allowed_symbols:
        gate_rejects.append(f"SYMBOL_REJECT: {symbol} not in allowlist")

    hour_blacklist = [int(x) for x in _list(config.get("hourBlacklist"))]
    if hour_utc in hour_blacklist:
        gate_rejects.append(f"HOUR_REJECT: UTC hour {hour_utc} is blacklisted")

    btc_threshold = _num(config.get("btcRegimeThresholdPct"), 0.5)
    btc_change_pct = _num(payload.get("btcChangePct"), 0.0)
    btc_regime = str(payload.get("btcRegime") or _btc_regime_from_change(btc_change_pct, btc_threshold))
    btc_regime_required = _bool(config.get("btcRegimeRequired"), False)
    allow_counter = _bool(config.get("allowCounterRegimeScalp"), True)

    if btc_regime_required:
        if btc_regime == "NEUTRAL":
            gate_rejects.append(
                f"REGIME_REJECT: BTC change {btc_change_pct:.2f}% < threshold +/-{btc_threshold}%"
            )
        elif not allow_counter:
            want_long = position_side == "LONG"
            btc_bull = btc_regime == "BULL"
            if btc_bull != want_long:
                gate_rejects.append(f"REGIME_DIRECTION: BTC {btc_regime} but entry is {position_side}")

    current_ev = payload.get("currentEv")
    ev_threshold = _num(config.get("evMinThreshold"), 0.0)
    if current_ev is not None and ev_threshold > 0 and _num(current_ev) < ev_threshold:
        gate_rejects.append(f"EV_REJECT: EV {_num(current_ev):.4f} < threshold {ev_threshold:.4f}")

    current_wr = payload.get("currentWinRate")
    wr_min = _num(config.get("winRateMin"), 0.0)
    if current_wr is not None and wr_min > 0 and _num(current_wr) < wr_min:
        gate_rejects.append(f"WR_REJECT: WR {_num(current_wr) * 100:.1f}% < min {wr_min * 100:.1f}%")

    current_pf = payload.get("currentProfitFactor")
    pf_min = _num(config.get("profitFactorMin"), 0.0)
    if current_pf is not None and pf_min > 0 and _num(current_pf) < pf_min:
        gate_rejects.append(f"PF_REJECT: PF {_num(current_pf):.2f}x < min {pf_min:.2f}x")

    alt_history = get_snapshot_history(symbol, 900)
    btc_history = get_snapshot_history("BTC-USDT", 900)
    target_moves_pct = _target_moves(config)
    sniper = evaluate_sniper_window(
        symbol,
        alt_history,
        btc_history,
        target_moves_pct=target_moves_pct,
    )
    signal_memory = await record_signal_from_gate(symbol, position_side, sniper, config)
    signal_edge = await score_signal_context(symbol, signal_memory["side"], signal_memory["contextKey"])
    news_context = await kb.get_active_news_context(symbol)
    operational_risk = await kb.get_operational_risk_metrics(hours=24)
    data_quality = {
        "alt1m": sniper["altTimeframes"]["1m"],
        "alt5m": sniper["altTimeframes"]["5m"],
        "alt15m": sniper["altTimeframes"]["15m"],
        "btc1m": sniper["btcTimeframes"]["1m"],
        "btc5m": sniper["btcTimeframes"]["5m"],
        "btc15m": sniper["btcTimeframes"]["15m"],
    }
    if any(frame["quality"] == "STALE" for frame in data_quality.values()):
        gate_rejects.append("DATA_STALE_REJECT: market snapshots are stale")
    if any(frame["quality"] == "GAPPED" for frame in data_quality.values()):
        gate_rejects.append("DATA_GAP_REJECT: snapshot continuity is degraded")
    # requireFull15mContext defaults False so startup doesn't block for 15min
    if _bool(config.get("requireFull15mContext"), False):
        if (
            data_quality["alt15m"]["coveragePct"] < 0.8
            or data_quality["btc15m"]["coveragePct"] < 0.8
        ):
            gate_rejects.append("DATA_15M_REJECT: insufficient 15-minute context")

    max_daily_loss_pct = _num(config.get("maxDailyLossPct"), 0.0)
    max_drawdown_pct = _num(config.get("maxDrawdownPct"), 0.0)
    max_consecutive_losses = int(_num(config.get("maxConsecutiveLosses"), 0))
    if max_daily_loss_pct > 0 and operational_risk["netPnlPct"] <= -max_daily_loss_pct:
        gate_rejects.append("DAILY_LOSS_KILL_SWITCH: daily loss limit reached")
    if max_drawdown_pct > 0 and operational_risk["maxDrawdownPct"] >= max_drawdown_pct:
        gate_rejects.append("DRAWDOWN_KILL_SWITCH: drawdown limit reached")
    if (
        max_consecutive_losses > 0
        and operational_risk["consecutiveLosses"] >= max_consecutive_losses
    ):
        gate_rejects.append("LOSS_STREAK_KILL_SWITCH: consecutive loss limit reached")

    # Hard block: sniper direction conflicts with requested position side (always fatal, all profiles)
    if sniper["decision"] == "ALLOW_LONG" and position_side != "LONG":
        gate_rejects.append(f"SNIPER_SIDE_MISMATCH: sniper recommends LONG but entry is {position_side}")
    elif sniper["decision"] == "ALLOW_SHORT" and position_side != "SHORT":
        gate_rejects.append(f"SNIPER_SIDE_MISMATCH: sniper recommends SHORT but entry is {position_side}")

    if sniper["decision"].startswith("BLOCK_"):
        gate_rejects.append(f"SNIPER_{sniper['decision']}: {','.join(sniper['reasons'])}")
    elif sniper["decision"] == "WAIT":
        if is_aggressive:
            # In aggressive mode WAIT is not a blocker — momentum is the authority.
            # Penalise the score instead.
            score_penalties += 0.08
        else:
            gate_rejects.append(f"SNIPER_WAIT: {','.join(sniper['reasons'])}")

    if signal_edge["verdict"] == "toxic_context":
        _se_samples = int((signal_edge.get("symbolSide") or {}).get("samples", 0))
        if is_aggressive:
            # In aggressive mode only block if truly destroyed with meaningful sample size
            if _se_samples >= 30 and float(signal_edge.get("score", 1.0)) < 0.20:
                gate_rejects.append(
                    "SIGNAL_EDGE_REJECT: target-hit context severely degraded "
                    f"(score {signal_edge['score']:.4f}, samples {_se_samples})"
                )
            else:
                score_penalties += 0.05
        else:
            gate_rejects.append(
                "SIGNAL_EDGE_REJECT: target-hit context degraded "
                f"(score {signal_edge['score']:.4f})"
            )

    margin = max(_num(config.get("marginPerTrade"), 1.0), 0.01)
    leverage = max(_num(config.get("leverage"), 1.0), 1.0)
    cost_pct = float(signal_memory.get("estimatedCostPct", 0.0))
    configured_target_pct = float(signal_memory["targetMovesPct"].get("configured", 0.0))
    net_target_pct = configured_target_pct - cost_pct
    min_edge_over_cost_pct = _num(config.get("minEdgeOverCostPct"), 0.03)
    # In aggressive mode only block if TP is truly eaten by costs (net negative).
    _cost_threshold = 0.0 if is_aggressive else min_edge_over_cost_pct
    if net_target_pct <= _cost_threshold:
        gate_rejects.append(
            "COST_EDGE_REJECT: target movement does not clear execution costs and noise"
        )
    effective_stats = (
        signal_edge["context"]
        if signal_edge["context"]["samples"] >= signal_edge["minSamples"]
        else signal_edge["symbolSide"]
    )
    hit_probability = float(effective_stats.get("hit_configured", 0.0))
    stop_move_pct = max(
        _num(config.get("stopMovePct", config.get("stopLossPct")), 0.0),
        0.15,
    )
    notional = margin * leverage
    net_target_usdt = max(0.0, net_target_pct) / 100 * notional
    loss_usdt = (stop_move_pct + cost_pct) / 100 * notional
    net_ev_usdt = hit_probability * net_target_usdt - (1 - hit_probability) * loss_usdt
    _ev_samples = effective_stats.get("samples", 0)
    if is_aggressive:
        # Sample-count based EV rules (0-50: learn, 50-150: penalise, 150+: hard-block if toxic)
        if _ev_samples >= 150 and net_ev_usdt < -0.50:
            gate_rejects.append(
                f"NET_EV_REJECT: expected value {net_ev_usdt:.4f} USDT "
                f"(150+ samples, confirmed negative)"
            )
        elif _ev_samples >= 50 and net_ev_usdt < 0:
            # 50-149 samples: proportional score penalty, not hard block
            score_penalties += min(0.15, abs(net_ev_usdt) * 0.30)
        # 0-49 samples: pure learning mode — no EV penalty at all
    else:
        if _ev_samples >= signal_edge["minSamples"] and net_ev_usdt <= 0:
            gate_rejects.append(f"NET_EV_REJECT: expected value {net_ev_usdt:.4f} USDT")

    shadow_ml = predict_shadow({
        "symbol": symbol,
        "side": signal_memory["side"],
        "context_key": signal_memory["contextKey"],
        "target_configured_move_pct": target_moves_pct["configured"],
        "estimated_cost_pct": cost_pct,
        "features": {
            "alt": sniper["altFeatures"],
            "btc": sniper["btcFeatures"],
            "alt_timeframes": sniper["altTimeframes"],
        },
    })

    # NOVO: Shadow ML com limiar mais rigoroso
    if (
        _bool(config.get("shadowMlEnforce"), False)
        and shadow_ml.get("available")
        and shadow_ml.get("calibratedProbability", 0) < 0.52
    ):
        gate_rejects.append(f"SHADOW_ML_REJECT: prob {shadow_ml['calibratedProbability']:.3f} < 0.52")

    if news_context["action"] == "block":
        gate_rejects.append("NEWS_RISK_REJECT: active high-impact event blocks entries")
    elif news_context["action"] == "reduce_aggression":
        if is_aggressive:
            score_penalties += 0.06
        elif signal_edge["score"] < 0.72:
            gate_rejects.append("NEWS_RISK_REDUCE: news risk requires stronger target-hit edge")

    recommendation = await recommend_entry({
        "symbol": symbol,
        "position_side": position_side,
        "btc_regime": btc_regime,
        "hour_utc": hour_utc,
        "shadow_only": True,
    })

    stats = recommendation.get("stats", {}).get("symbolSide", {})
    samples = int(stats.get("samples", 0) or 0)
    _realized_min = recommendation.get("minSamplesForLiveGate", 8)
    if is_aggressive:
        # Sample-count based realized-edge rules (0-50: learn, 50-150: penalise, 150+: hard-block if toxic)
        if samples >= 150 and not recommendation.get("shadowRecommendation") and float(recommendation.get("score", 1.0)) < 0.25:
            gate_rejects.append(
                f"REALIZED_EDGE_REJECT: score {recommendation.get('score', 0):.4f} "
                f"(150+ samples, confirmed toxic)"
            )
        elif samples >= 50 and not recommendation.get("shadowRecommendation"):
            # 50-149 samples: proportional ranking penalty
            realized_score = float(recommendation.get("score", 0.5))
            score_penalties += max(0.0, (0.5 - realized_score) * 0.20)
        # 0-49 samples: pure learning mode — no realized-edge penalty
    else:
        if samples >= _realized_min and not recommendation.get("shadowRecommendation"):
            gate_rejects.append(f"REALIZED_EDGE_REJECT: score {recommendation.get('score', 0):.4f}")

    # ========== NOVOS GATES DE EXCELÊNCIA ==========

    # 1. Volatilidade e Stop Ajustado
    volatility_regime, current_vol, vol_history = _calculate_volatility_regime_from_history(alt_history)
    adjusted_stop = _calculate_volatility_adjusted_stop(current_vol, stop_move_pct, volatility_regime)

    # Aggressive: raise threshold to 4%; below that add penalty instead of blocking
    _vol_hard_threshold = 4.0 if is_aggressive else 2.5
    if volatility_regime == "HIGH" and current_vol > _vol_hard_threshold:
        gate_rejects.append(f"HIGH_VOLATILITY_REJECT: current vol {current_vol:.2f}% > {_vol_hard_threshold}%")
    elif is_aggressive and volatility_regime == "HIGH" and current_vol > 2.5:
        score_penalties += 0.08

    # 2. Sharpe Ratio de trades realizados
    recent_returns = await _get_recent_returns(symbol, position_side, days=30)
    realized_sharpe = _calculate_sharpe_from_trades(recent_returns)

    # min 25 samples before Sharpe gate activates; in aggressive mode convert to score penalty
    if len(recent_returns) >= 25 and realized_sharpe < 0.3:
        if is_aggressive:
            score_penalties += 0.05
        else:
            gate_rejects.append(f"LOW_REALIZED_SHARPE_REJECT: Sharpe {realized_sharpe:.2f} < 0.3")

    # 3. Correlação e Penalidade
    correlation = _calculate_correlation_from_history(alt_history, btc_history)
    symbols_in_position = _list(payload.get("currentPositions", []))
    supplied_correlations = payload.get("positionCorrelations") or {}
    correlation_penalty = _calculate_correlation_penalty(
        {
            str(key).upper(): abs(_num(value))
            for key, value in supplied_correlations.items()
        } if isinstance(supplied_correlations, dict) else {},
        [str(item).upper() for item in symbols_in_position],
    )

    if correlation_penalty < 0.7 and len(symbols_in_position) > 0:
        if is_aggressive:
            score_penalties += 0.05
        else:
            gate_rejects.append(f"CORRELATION_PENALTY: {symbol} correlated with existing positions")

    # 4. Regime Confidence
    btc_trend_strength = sniper.get("btcFeatures", {}).get("price_change_pct", 0)
    regime_confidence = _calculate_market_regime_confidence(
        btc_regime, current_vol * 2, btc_trend_strength, correlation
    )

    # Threshold 0.4 to allow entries in ambiguous but not chaotic regimes
    if regime_confidence["regime_confidence"] < 0.4:
        if is_aggressive:
            score_penalties += 0.05
        else:
            gate_rejects.append(f"LOW_REGIME_CONFIDENCE: confidence {regime_confidence['regime_confidence']:.2f}")

    # 5. Bootstrap EV Confidence
    ev_bootstrap = _calculate_bootstrap_ev_confidence(
        hit_probability, effective_stats.get("samples", 0),
        net_target_usdt, loss_usdt
    )

    if ev_bootstrap["reliable"] and ev_bootstrap["ev_positive_confidence"] < 0.8:
        if is_aggressive:
            score_penalties += 0.05
        else:
            gate_rejects.append(f"LOW_EV_CONFIDENCE: EV positive confidence {ev_bootstrap['ev_positive_confidence']:.0%}")

    # 6. Kelly Optimal Position Size
    equity_usdt = _num(payload.get("equityUsdt", 1000.0), 1000.0)
    avg_win_usdt = net_target_usdt
    avg_loss_usdt = loss_usdt

    optimal_size = _calculate_optimal_position_size(
        equity_usdt, hit_probability, avg_win_usdt, avg_loss_usdt
    )

    suggested_margin = optimal_size["optimal_margin_usdt"]
    # KELLY_REJECT removed — Kelly is used for position sizing guidance only, not as a hard gate.

    # 7. Microestrutura - Toxic Flow
    microstructure = data_quality["alt1m"].get("microstructure", {})
    if microstructure.get("toxicity_score", 0) > 0.7:
        gate_rejects.append(f"HIGH_FLOW_TOXICITY: VPIN {microstructure['toxicity_score']:.2f} > 0.7")

    # 8. Liquidity Void
    liquidity_void = data_quality["alt1m"].get("liquidityVoid", {})
    if liquidity_void.get("void", False):
        gate_rejects.append(f"LIQUIDITY_VOID: spread {liquidity_void.get('avg_spread_bps', 0)}bps")

    # 9. Divergência Preço-Volume
    delta_divergence = data_quality["alt1m"].get("deltaDivergence", {})
    if delta_divergence.get("divergence", False):
        if is_aggressive:
            score_penalties += 0.05
        else:
            gate_rejects.append(f"DIVERGENCE: {delta_divergence.get('type', 'unknown')}")

    # 10. Structural Break
    structural_break = data_quality["alt5m"].get("structuralBreak", {})
    if structural_break.get("break_detected", False):
        if is_aggressive:
            score_penalties += 0.05
        else:
            gate_rejects.append(f"STRUCTURAL_BREAK: {structural_break.get('direction', 'unknown')} break")

    # ── Aggressive score (momentum-first composite) ───────────────────────────
    aggressive_score = _compute_aggressive_score(
        sniper=sniper,
        signal_edge=signal_edge,
        shadow_ml=shadow_ml,
        btc_regime=btc_regime,
        data_quality=data_quality,
        score_penalties=score_penalties,
        position_side=position_side,
    )

    allow = len(gate_rejects) == 0

    if is_aggressive:
        # In aggressive mode, use the aggressive composite score as the primary score
        score = aggressive_score
    else:
        score = min(
            float(sniper.get("score", 0.0)),
            float(recommendation.get("score", 0.5)),
            float(signal_edge.get("score", 0.5)),
        )

        # Ajusta score com base na confiança do regime
        score = score * regime_confidence["regime_confidence"]

        # Penaliza por correlação
        score = score * correlation_penalty

        # Bônus para Sharpe alto
        if realized_sharpe > 1.0 and score < 0.8:
            score = min(0.85, score * 1.1)

        if news_context["action"] == "reduce_aggression":
            score = min(score, max(0.0, score - 0.08))
        if samples < recommendation.get("minSamplesForLiveGate", 8):
            score = min(float(sniper.get("score", 0.0)), float(signal_edge.get("score", 0.5)))

    # ── Sentiment alignment adjustment ──────────────────────────────────────────
    # Aligned 24h bias boosts score; counter-bias penalises it.
    if sentiment_aligned and sentiment_confidence > 0.3:
        score = min(1.0, score * (1.0 + sentiment_confidence * 0.15))
    elif sentiment_counter and sentiment_confidence > 0.3:
        score = score * (1.0 - sentiment_confidence * 0.10)

    # ── Contract v2 audit fields from shadow ML ────────────────────────────────
    ml_model_version: str = shadow_ml.get("modelVersion", "shadow-unknown")
    ml_calibrated_prob: float | None = shadow_ml.get("calibratedProbability")
    if shadow_ml.get("available"):
        ml_uncertainty_type = shadow_ml.get("uncertaintyType", "UNCALIBRATED")
    else:
        ml_uncertainty_type = "MODEL_UNAVAILABLE"

    # ========== NOVOS CAMPOS NO RETORNO ==========
    return {
        "allow": allow,
        "gateRejects": gate_rejects,
        "score": round(score, 4),
        "aggressiveScore": round(aggressive_score, 4),
        "scorePenalties": round(score_penalties, 4),
        "riskProfile": risk_profile,
        "authority": "quant-brain",
        # Contract v2 — provenance & ML audit
        "signalId": signal_id,
        "marketEventId": market_event_id,
        "featureVersion": feature_version,
        "modelVersion": ml_model_version,
        "calibratedProbability": round(ml_calibrated_prob, 6) if ml_calibrated_prob is not None else None,
        "uncertaintyType": ml_uncertainty_type,
        "predictionTimestamp": time.time(),
        "symbol": symbol,
        "side": side,
        "positionSide": position_side,
        "hourUtc": hour_utc,
        "btcRegime": btc_regime,
        "sentimentContext": {
            "direction": sentiment_direction,
            "confidence": round(sentiment_confidence, 3),
            "biasRatio": round(sentiment_bias_ratio, 3),
            "aligned": sentiment_aligned,
            "counter": sentiment_counter,
        },
        "sniper": sniper,
        "signalMemory": signal_memory,
        "signalEdge": signal_edge,
        "economics": {
            "targetMovesPct": target_moves_pct,
            "estimatedCostPct": round(cost_pct, 6),
            "hitProbability": round(hit_probability, 4),
            "estimatedLossUsdt": round(loss_usdt, 4),
            "estimatedNetTargetUsdt": round(net_target_usdt, 4),
            "netEvUsdt": round(net_ev_usdt, 4),
            # NOVOS CAMPOS ECONÔMICOS
            "adjustedStopPct": adjusted_stop,
            "optimalMarginKelly": optimal_size["optimal_margin_usdt"],
            "kellyFraction": optimal_size["kelly_fraction"],
        },
        "newsContext": news_context,
        "dataQuality": data_quality,
        "operationalRisk": operational_risk,
        "shadowMl": shadow_ml,
        "realizedEdge": recommendation,
        # NOVOS CAMPOS DE INTELIGÊNCIA
        "advancedMetrics": {
            "volatilityRegime": volatility_regime,
            "realizedSharpe": round(realized_sharpe, 3),
            "correlationPenalty": round(correlation_penalty, 3),
            "regimeConfidence": regime_confidence,
            "evBootstrap": ev_bootstrap,
            "correlation": round(correlation, 3),
            "adjustedStopPct": adjusted_stop,
        },
        "mode": "movement_first_realized_pnl_auditor",
    }
