from __future__ import annotations

import asyncio
import math
import os
import random
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from core.movement_sniper import MovementFeatures, evaluate_sniper_window
from core import knowledge_base as kb
from core.recommendation import recommend_entry
from core.async_utils import run_edge_blocking
from core.signal_learning import (
    build_context_key,
    finalize_due_signal_outcomes,
    record_signal_from_gate,
    score_signal_context,
)
from core.shadow_model import predict_shadow
from core.database import connect
from layers.tactical import get_snapshot_history
from core.judge_sniper import judge_entry, judge_high_sample_context
from core.coach_ranker import score_candidate
from core.experiment_engine import assign_signal_to_experiments, persist_assignments, primary_assignment
from core.regime_playbook import classify_regime_playbook
from core.score_calibration import run_score_calibration

_score_calibration_cache: dict[str, Any] = {"expires_at": 0.0, "status": None}


async def _score_calibration_status() -> dict[str, Any] | None:
    now = time.time()
    if _score_calibration_cache["status"] is not None and now < float(_score_calibration_cache["expires_at"]):
        return _score_calibration_cache["status"]
    try:
        rows = await kb.get_score_calibration_rows(days=30, limit=5000)
        status = run_score_calibration(rows)
    except Exception:
        status = None
    _score_calibration_cache["status"] = status
    _score_calibration_cache["expires_at"] = now + 60
    return status


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


def _risk_geometry_blocks(
    *,
    config: dict[str, Any],
    net_target_pct: float,
    stop_move_pct: float,
    cost_pct: float,
    hit_probability: float,
    ev_samples: int,
    shadow_ml: dict[str, Any],
    min_samples: int,
) -> tuple[list[str], dict[str, Any]]:
    loss_pct = max(0.0, stop_move_pct + cost_pct)
    reward_risk = net_target_pct / loss_pct if loss_pct > 0 else 0.0
    breakeven_probability = (
        loss_pct / max(0.000001, net_target_pct + loss_pct)
        if net_target_pct > 0 and loss_pct > 0
        else 1.0
    )
    min_reward_risk = max(
        0.0,
        _num(
            config.get("minRewardRiskRatio"),
            _num(os.environ.get("MIN_REWARD_RISK_RATIO"), 0.75),
        ),
    )
    edge_buffer = max(
        0.0,
        _num(
            config.get("minProbabilityEdge"),
            _num(os.environ.get("MIN_PROBABILITY_EDGE"), 0.03),
        ),
    )

    probability_source = "none"
    probability_estimate: float | None = None
    if shadow_ml.get("available") and shadow_ml.get("calibratedProbability") is not None:
        probability_estimate = max(0.0, min(1.0, float(shadow_ml["calibratedProbability"])))
        probability_source = "shadow_ml"
    elif ev_samples >= min_samples:
        probability_estimate = max(0.0, min(1.0, hit_probability))
        probability_source = "realized_signal_edge"

    blocks: list[str] = []
    if reward_risk < min_reward_risk:
        blocks.append(
            "RISK_REWARD_REJECT: "
            f"net reward:risk {reward_risk:.2f} < {min_reward_risk:.2f} "
            f"(netTarget={net_target_pct:.4f}%, stopPlusCost={loss_pct:.4f}%)"
        )

    required_probability = min(0.99, breakeven_probability + edge_buffer)
    if probability_estimate is not None and probability_estimate < required_probability:
        blocks.append(
            "BREAKEVEN_PROB_REJECT: "
            f"{probability_source}={probability_estimate:.3f} < required={required_probability:.3f} "
            f"(breakeven={breakeven_probability:.3f})"
        )

    return blocks, {
        "netRewardRisk": round(reward_risk, 4),
        "minRewardRisk": round(min_reward_risk, 4),
        "breakevenProbability": round(breakeven_probability, 4),
        "requiredProbability": round(required_probability, 4),
        "probabilityEstimate": round(probability_estimate, 4) if probability_estimate is not None else None,
        "probabilitySource": probability_source,
        "lossPctWithCost": round(loss_pct, 6),
    }


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


def _calculate_market_breadth_from_snapshots() -> float:
    """Approximate market breadth from cached tactical snapshots."""
    from layers.tactical import _snap_buffer

    latest: list[float] = []
    for history in _snap_buffer.values():
        if history:
            latest.append(_num(history[-1].get("price_change_pct"), 0.0))
    if not latest:
        return 0.5
    return sum(1 for value in latest if value > 0) / len(latest)


def _liquidity_score(*, spread_bps: float, bid_depth: float, ask_depth: float) -> float:
    spread_component = max(0.0, 1.0 - max(0.0, spread_bps) / 30.0)
    depth = max(0.0, min(bid_depth, ask_depth))
    depth_component = max(0.0, min(1.0, depth / 10_000.0))
    if depth <= 0:
        depth_component = 0.55
    return max(0.0, min(1.0, spread_component * 0.65 + depth_component * 0.35))


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


# ========== MAIN GATE (Judge + Coach dual-layer orchestrator) ==========
# _compute_aggressive_score has moved to core/coach_ranker.py


async def evaluate_edge_gate(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Judge Sniper + Coach Ranker dual-layer orchestrator.

    Layer 1 — Judge Sniper  : fatal hard blocks only (profile-independent).
    Layer 2 — Coach Ranker  : scoring, soft penalties, ranking (never blocks).

    In demo_learning_aggressive:
      • WR / PF / EV user thresholds → ignored (learning mode)
      • btcRegimeRequired direction → BTC alignment penalty (not a block)
      • sentimentCounter → penalty (not a block)
      • SNIPER_WAIT → penalty (not a block)
      • EV negative with < 150 samples → penalty (not a block)
      • Sharpe low with < 25 returns → penalty (not a block)
      • Only fatal blocks fire: data stale/gapped, side mismatch, cost > TP,
        extreme liquidity/toxicity, kill switches, news hard block, signal expired
    """
    symbol = str(payload.get("symbol", "")).upper()
    if symbol and not symbol.endswith("-USDT"):
        symbol = f"{symbol}-USDT"
    position_side = _position_to_side(payload.get("positionSide"), payload.get("side"))
    side = str(payload.get("side", "")).upper()
    now_hour = datetime.now(timezone.utc).hour
    hour_utc = int(payload.get("hourUtc", payload.get("hour_utc", now_hour)))
    config = payload.get("config") or {}
    intelligence_only = bool(payload.get("intelligenceOnly"))
    if payload.get("observationSourceType"):
        config = {**config, "signalSourceType": payload.get("observationSourceType")}

    risk_profile = str(
        config.get("riskProfile")
        or config.get("decisionProfile")
        or payload.get("riskProfile")
        or payload.get("decisionProfile")
        or "balanced"
    ).lower()
    is_aggressive = risk_profile in ("aggressive", "sniper_max", "demo_learning_aggressive")

    # ── Signal metadata ──────────────────────────────────────────────────────
    signal_id = payload.get("signalId") or str(uuid.uuid4())
    request_signal_id = str(signal_id)
    market_event_id = payload.get("marketEventId")
    feature_version = payload.get("featureVersion", "sniper-v1")
    experiment_assignments = assign_signal_to_experiments(payload)
    try:
        await persist_assignments(payload, experiment_assignments)
    except Exception:
        pass
    primary_experiment = primary_assignment(
        experiment_assignments,
        str(payload.get("experimentId") or payload.get("experiment_id") or "") or None,
    )

    expires_at_ms = payload.get("expiresAt")
    signal_expired = False
    if expires_at_ms is not None:
        try:
            signal_expired = time.time() * 1000 > float(expires_at_ms)
        except (TypeError, ValueError):
            pass

    # ── Sentiment context ────────────────────────────────────────────────────
    sentiment_ctx = payload.get("sentimentContext") or {}
    sentiment_direction = str(sentiment_ctx.get("direction", "NEUTRAL")).upper()
    sentiment_confidence = float(sentiment_ctx.get("confidence") or 0)
    sentiment_bias_ratio = float(sentiment_ctx.get("biasRatio") or 0.5)
    sentiment_aligned = (
        (position_side == "LONG" and sentiment_direction == "BULL")
        or (position_side == "SHORT" and sentiment_direction == "BEAR")
    )
    sentiment_counter = (
        (position_side == "LONG" and sentiment_direction == "BEAR")
        or (position_side == "SHORT" and sentiment_direction == "BULL")
    )

    # ── BTC regime ───────────────────────────────────────────────────────────
    btc_threshold = _num(config.get("btcRegimeThresholdPct"), 0.5)
    btc_change_pct = _num(payload.get("btcChangePct"), 0.0)
    btc_regime = str(
        payload.get("btcRegime") or _btc_regime_from_change(btc_change_pct, btc_threshold)
    )

    # ── Market data ──────────────────────────────────────────────────────────
    alt_history = get_snapshot_history(symbol, 900)
    btc_history = get_snapshot_history("BTC-USDT", 900)
    target_moves_pct = _target_moves(config)
    sniper = await run_edge_blocking(
        evaluate_sniper_window,
        symbol, alt_history, btc_history, target_moves_pct=target_moves_pct
    )
    signal_metadata = {
        "signalId": signal_id,
        "predictionId": str(payload.get("predictionId") or uuid.uuid4()),
        "marketEventId": market_event_id,
        "featureVersion": feature_version,
        "featureTimestampMs": payload.get("featureTimestampMs"),
        "requestTimestamp": payload.get("requestTimestamp"),
        "expiresAt": payload.get("expiresAt"),
        "referencePrice": payload.get("referencePrice"),
        "configVersion": payload.get("configVersion") or config.get("configVersion"),
    }
    if intelligence_only:
        alt_for_context = MovementFeatures(**sniper["altFeatures"])
        btc_for_context = MovementFeatures(**sniper["btcFeatures"])
        taker_fee_bps = _num(config.get("takerFeeBps"), _num(config.get("taker_fee_bps"), 5.0))
        slippage_bps = _num(config.get("slippageBpsPerSide"), _num(config.get("slippage_bps_per_side"), 2.0))
        funding_pct = _num(config.get("estimatedFundingCostPct"), 0.0)
        signal_memory = {
            "signalId": request_signal_id,
            "side": position_side,
            "contextKey": build_context_key(alt_for_context, btc_for_context),
            "targetMovesPct": target_moves_pct,
            "estimatedCostPct": (taker_fee_bps + slippage_bps * 2.0) / 100.0 + funding_pct,
            "recordStatus": "intelligence_only",
        }
        memory_signal_id = request_signal_id
    else:
        signal_memory = await record_signal_from_gate(
            symbol,
            position_side,
            sniper,
            config,
            metadata=signal_metadata,
        )
        memory_signal_id = signal_memory["signalId"]
    signal_edge, news_context, operational_risk = await asyncio.gather(
        score_signal_context(symbol, signal_memory["side"], signal_memory["contextKey"]),
        kb.get_active_news_context(symbol),
        kb.get_operational_risk_metrics(hours=24),
    )

    data_quality = {
        "alt1m":  sniper["altTimeframes"]["1m"],
        "alt5m":  sniper["altTimeframes"]["5m"],
        "alt15m": sniper["altTimeframes"]["15m"],
        "btc1m":  sniper["btcTimeframes"]["1m"],
        "btc5m":  sniper["btcTimeframes"]["5m"],
        "btc15m": sniper["btcTimeframes"]["15m"],
    }

    # ── Economics ────────────────────────────────────────────────────────────
    margin = max(_num(config.get("marginPerTrade"), 1.0), 0.01)
    leverage = max(_num(config.get("leverage"), 1.0), 1.0)
    cost_pct = float(signal_memory.get("estimatedCostPct", 0.0))
    configured_target_pct = float(signal_memory["targetMovesPct"].get("configured", 0.0))
    net_target_pct = configured_target_pct - cost_pct
    stop_move_pct = max(_num(config.get("stopMovePct", config.get("stopLossPct")), 0.0), 0.15)
    notional = margin * leverage

    effective_stats = (
        signal_edge["context"]
        if signal_edge["context"]["samples"] >= signal_edge["minSamples"]
        else signal_edge["symbolSide"]
    )
    hit_probability = float(effective_stats.get("hit_configured", 0.0))
    net_target_usdt = max(0.0, net_target_pct) / 100 * notional
    loss_usdt = (stop_move_pct + cost_pct) / 100 * notional
    net_ev_usdt = hit_probability * net_target_usdt - (1 - hit_probability) * loss_usdt
    ev_samples = int(effective_stats.get("samples", 0))

    # ── Shadow ML ────────────────────────────────────────────────────────────
    shadow_ml = await run_edge_blocking(
        predict_shadow,
        {
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
        },
    )

    # ── Realized edge recommendation ─────────────────────────────────────────
    recommendation = await recommend_entry({
        "symbol": symbol,
        "position_side": position_side,
        "btc_regime": btc_regime,
        "hour_utc": hour_utc,
        "shadow_only": True,
    })
    rec_samples = int(
        (recommendation.get("stats", {}).get("symbolSide", {}) or {}).get("samples", 0)
    )

    # ── Advanced metrics ─────────────────────────────────────────────────────
    volatility_regime, current_vol, _ = _calculate_volatility_regime_from_history(alt_history)
    adjusted_stop = _calculate_volatility_adjusted_stop(current_vol, stop_move_pct, volatility_regime)
    recent_returns = await _get_recent_returns(symbol, position_side, days=30)
    realized_sharpe = _calculate_sharpe_from_trades(recent_returns)
    correlation = _calculate_correlation_from_history(alt_history, btc_history)

    symbols_in_position = _list(payload.get("currentPositions", []))
    supplied_correlations = payload.get("positionCorrelations") or {}
    correlation_penalty = _calculate_correlation_penalty(
        {str(k).upper(): abs(_num(v)) for k, v in supplied_correlations.items()}
        if isinstance(supplied_correlations, dict) else {},
        [str(i).upper() for i in symbols_in_position],
    )

    btc_trend_strength = sniper.get("btcFeatures", {}).get("price_change_pct", 0)
    regime_confidence_dict = _calculate_market_regime_confidence(
        btc_regime, current_vol * 2, btc_trend_strength, correlation
    )
    regime_confidence_val = float(regime_confidence_dict["regime_confidence"])

    equity_usdt = _num(payload.get("equityUsdt", 1000.0), 1000.0)
    ev_bootstrap = _calculate_bootstrap_ev_confidence(
        hit_probability, effective_stats.get("samples", 0), net_target_usdt, loss_usdt
    )
    optimal_size = _calculate_optimal_position_size(
        equity_usdt, hit_probability, net_target_usdt, loss_usdt
    )

    alt_features = sniper.get("altFeatures") or {}
    alt_1m = data_quality.get("alt1m") or {}
    micro = alt_1m.get("microstructure", {}) if isinstance(alt_1m, dict) else {}
    bid_depth = _num(alt_1m.get("bid_depth_5") or alt_1m.get("bidDepth5"), 0.0)
    ask_depth = _num(alt_1m.get("ask_depth_5") or alt_1m.get("askDepth5"), 0.0)
    spread_bps = _num(alt_features.get("spread_bps"), _num(alt_1m.get("spread_bps"), 0.0))
    liquidity_score = _liquidity_score(
        spread_bps=spread_bps,
        bid_depth=bid_depth,
        ask_depth=ask_depth,
    )
    market_breadth = _calculate_market_breadth_from_snapshots()
    playbook_performance = await kb.get_playbook_performance(days=30)
    regime_playbook = classify_regime_playbook(
        symbol=symbol,
        position_side=position_side,
        btc_regime=btc_regime,
        btc_volatility_pct=current_vol * 2,
        btc_trend_strength=_num(btc_trend_strength),
        alt_btc_correlation=correlation,
        symbol_momentum=_num(alt_features.get("price_change_pct"), 0.0),
        volume_ratio=_num(alt_features.get("volume_ratio"), 1.0),
        oi_change_pct=_num(alt_features.get("oi_change_pct"), 0.0),
        spread_bps=spread_bps,
        liquidity_score=liquidity_score,
        candle_context=sniper.get("altTimeframes") or {},
        recent_pnl_by_setup={},
        symbol_rotation_state=str(payload.get("symbolRotationState") or "NEUTRAL"),
        market_breadth=market_breadth,
        funding_rate=_num(alt_features.get("funding_rate"), 0.0),
        news_context=news_context,
        operational_risk=operational_risk,
        playbook_performance=playbook_performance,
    )
    size_multiplier = _num((regime_playbook.get("sizing") or {}).get("sizeMultiplier"), 1.0)
    optimal_size["base_optimal_margin_usdt"] = optimal_size["optimal_margin_usdt"]
    optimal_size["optimal_margin_usdt"] = round(
        max(0.0, optimal_size["optimal_margin_usdt"] * size_multiplier),
        2,
    )

    # ── LAYER 1: Judge Sniper — fatal hard blocks ────────────────────────────
    judge_result = judge_entry(
        symbol=symbol,
        position_side=position_side,
        hour_utc=hour_utc,
        config=config,
        sniper=sniper,
        data_quality=data_quality,
        net_target_pct=net_target_pct,
        news_action=news_context.get("action", "allow"),
        operational_risk=operational_risk,
        signal_expired=signal_expired,
    )

    # High-sample-count confirmed-negative contexts also get a fatal block.
    # These are allowed in demo_learning_aggressive only after 150+ real outcomes.
    high_sample_blocks = judge_high_sample_context(
        net_ev_usdt=net_ev_usdt,
        ev_samples=ev_samples,
        realized_score=float(recommendation.get("score", 1.0)),
        rec_samples=rec_samples,
        rec_has_recommendation=bool(recommendation.get("shadowRecommendation")),
    )
    risk_geometry_blocks, risk_geometry = _risk_geometry_blocks(
        config=config,
        net_target_pct=net_target_pct,
        stop_move_pct=stop_move_pct,
        cost_pct=cost_pct,
        hit_probability=hit_probability,
        ev_samples=ev_samples,
        shadow_ml=shadow_ml,
        min_samples=int(signal_edge.get("minSamples", 8)),
    )

    # In non-aggressive profiles: also apply the optional user-configured thresholds
    # (WR / PF / EV minimums). In demo_learning_aggressive these are IGNORED so the
    # system gathers real data without premature filtering.
    extra_blocks: list[str] = []
    if not is_aggressive:
        # BTC regime required (direction) — only hard-block in conservative/balanced
        btc_regime_required = _bool(config.get("btcRegimeRequired"), False)
        allow_counter = _bool(config.get("allowCounterRegimeScalp"), True)
        if btc_regime_required:
            if btc_regime == "NEUTRAL":
                extra_blocks.append(
                    f"REGIME_REJECT: BTC change {btc_change_pct:.2f}% < threshold +/-{btc_threshold}%"
                )
            elif not allow_counter:
                want_long = position_side == "LONG"
                btc_bull = btc_regime == "BULL"
                if btc_bull != want_long:
                    extra_blocks.append(
                        f"REGIME_DIRECTION: BTC {btc_regime} but entry is {position_side}"
                    )

        # Sentiment counter — hard block only in non-aggressive modes
        if sentiment_counter and sentiment_confidence >= 0.75 and sentiment_bias_ratio >= 0.72:
            extra_blocks.append(
                f"SENTIMENT_COUNTER_REJECT: 24h bias {sentiment_direction} "
                f"({sentiment_confidence:.0%} conf) conflicts with {position_side}"
            )

        # User-configured WR / PF / EV thresholds
        current_ev = payload.get("currentEv")
        ev_threshold = _num(config.get("evMinThreshold"), 0.0)
        if current_ev is not None and ev_threshold > 0 and _num(current_ev) < ev_threshold:
            extra_blocks.append(
                f"EV_REJECT: EV {_num(current_ev):.4f} < threshold {ev_threshold:.4f}"
            )
        current_wr = payload.get("currentWinRate")
        wr_min = _num(config.get("winRateMin"), 0.0)
        if current_wr is not None and wr_min > 0 and _num(current_wr) < wr_min:
            extra_blocks.append(
                f"WR_REJECT: WR {_num(current_wr) * 100:.1f}% < min {wr_min * 100:.1f}%"
            )
        current_pf = payload.get("currentProfitFactor")
        pf_min = _num(config.get("profitFactorMin"), 0.0)
        if current_pf is not None and pf_min > 0 and _num(current_pf) < pf_min:
            extra_blocks.append(
                f"PF_REJECT: PF {_num(current_pf):.2f}x < min {pf_min:.2f}x"
            )

        # SNIPER_WAIT — hard block in conservative/balanced
        if sniper["decision"] == "WAIT":
            extra_blocks.append(f"SNIPER_WAIT: {','.join(sniper.get('reasons', []))}")

        # Signal edge degraded — hard block in conservative/balanced
        if signal_edge.get("verdict") == "toxic_context":
            extra_blocks.append(
                f"SIGNAL_EDGE_REJECT: target-hit context degraded "
                f"(score {signal_edge.get('score', 0):.4f})"
            )

        # EV negative with enough samples
        if ev_samples >= signal_edge["minSamples"] and net_ev_usdt <= 0:
            extra_blocks.append(f"NET_EV_REJECT: expected value {net_ev_usdt:.4f} USDT")

        # Realized edge
        realized_min = recommendation.get("minSamplesForLiveGate", 8)
        if rec_samples >= realized_min and not recommendation.get("shadowRecommendation"):
            extra_blocks.append(
                f"REALIZED_EDGE_REJECT: score {recommendation.get('score', 0):.4f}"
            )

        # Volatility hard block (lower threshold for conservative/balanced)
        if volatility_regime == "HIGH" and current_vol > 2.5:
            extra_blocks.append(
                f"HIGH_VOLATILITY_REJECT: vol {current_vol:.2f}% > 2.5%"
            )

        # Sharpe
        if len(recent_returns) >= 25 and realized_sharpe < 0.3:
            extra_blocks.append(
                f"LOW_REALIZED_SHARPE_REJECT: Sharpe {realized_sharpe:.2f} < 0.3"
            )

        # Correlation
        if correlation_penalty < 0.7 and len(symbols_in_position) > 0:
            extra_blocks.append(
                f"CORRELATION_PENALTY: {symbol} correlated with existing positions"
            )

        # Regime confidence
        if regime_confidence_val < 0.4:
            extra_blocks.append(
                f"LOW_REGIME_CONFIDENCE: confidence {regime_confidence_val:.2f}"
            )

        # EV bootstrap confidence
        if ev_bootstrap["reliable"] and ev_bootstrap["ev_positive_confidence"] < 0.8:
            extra_blocks.append(
                f"LOW_EV_CONFIDENCE: EV positive confidence "
                f"{ev_bootstrap['ev_positive_confidence']:.0%}"
            )

        # Toxicity & liquidity (lower threshold for non-aggressive)
        micro = data_quality["alt1m"].get("microstructure", {})
        if float(micro.get("toxicity_score", 0)) > 0.70:
            extra_blocks.append(
                f"HIGH_FLOW_TOXICITY: VPIN {micro.get('toxicity_score', 0):.2f} > 0.70"
            )

        # Price-volume divergence
        dd = data_quality["alt1m"].get("deltaDivergence", {})
        if dd.get("divergence", False):
            extra_blocks.append(f"DIVERGENCE: {dd.get('type', 'unknown')}")

        # Structural break
        sb = data_quality["alt5m"].get("structuralBreak", {})
        if sb.get("break_detected", False):
            extra_blocks.append(f"STRUCTURAL_BREAK: {sb.get('direction', 'unknown')} break")

        # News reduce-aggression in conservative/balanced with weak edge
        if news_context["action"] == "reduce_aggression" and float(signal_edge.get("score", 1.0)) < 0.72:
            extra_blocks.append("NEWS_RISK_REDUCE: news risk requires stronger edge")

        # Shadow ML hard enforce (opt-in flag)
        if (
            _bool(config.get("shadowMlEnforce"), False)
            and shadow_ml.get("available")
            and float(shadow_ml.get("calibratedProbability", 1.0)) < 0.52
        ):
            extra_blocks.append(
                f"SHADOW_ML_REJECT: prob {shadow_ml['calibratedProbability']:.3f} < 0.52"
            )

        # 15m context requirement (opt-in)
        if _bool(config.get("requireFull15mContext"), False):
            if (
                data_quality["alt15m"]["coveragePct"] < 0.8
                or data_quality["btc15m"]["coveragePct"] < 0.8
            ):
                extra_blocks.append("DATA_15M_REJECT: insufficient 15-minute context")

        # Cost-edge margin (non-aggressive: require minEdgeOverCostPct buffer)
        min_edge_over_cost = _num(config.get("minEdgeOverCostPct"), 0.03)
        if net_target_pct <= min_edge_over_cost:
            extra_blocks.append(
                "COST_EDGE_REJECT: target does not clear execution costs + noise margin"
            )

    all_blocks = judge_result["blocks"] + high_sample_blocks + risk_geometry_blocks + extra_blocks
    allow = len(all_blocks) == 0

    # ── LAYER 2: Coach Ranker — scoring, soft penalties, ranking ────────────
    score_calibration = await _score_calibration_status()
    coaching = score_candidate(
        symbol=symbol,
        position_side=position_side,
        risk_profile=risk_profile,
        sniper=sniper,
        signal_edge=signal_edge,
        shadow_ml=shadow_ml,
        btc_regime=btc_regime,
        data_quality=data_quality,
        recommendation=recommendation,
        operational_risk=operational_risk,
        realized_sharpe=realized_sharpe,
        correlation_penalty=correlation_penalty,
        regime_confidence=regime_confidence_val,
        ev_bootstrap=ev_bootstrap,
        net_ev_usdt=net_ev_usdt,
        news_action=news_context.get("action", "allow"),
        sentiment_counter=sentiment_counter,
        sentiment_confidence=sentiment_confidence,
        sentiment_aligned=sentiment_aligned,
        regime_playbook=regime_playbook,
        score_calibration=score_calibration,
    )

    # ── ML audit fields ───────────────────────────────────────────────────────
    ml_model_version: str = shadow_ml.get("modelVersion", "shadow-unknown")
    ml_calibrated_prob: float | None = shadow_ml.get("calibratedProbability")
    ml_uncertainty_type = (
        shadow_ml.get("uncertaintyType", "UNCALIBRATED")
        if shadow_ml.get("available")
        else "MODEL_UNAVAILABLE"
    )
    if not intelligence_only:
        await kb.update_signal_decision_audit(
            memory_signal_id,
            allowed=allow,
            reject_reasons=all_blocks,
            raw_score=float(coaching["executionPriority"]),
            calibrated_score=float(coaching.get("calibratedScore", coaching["executionPriority"])),
            policy_version=primary_experiment["policyVersion"] if primary_experiment else None,
            playbook=regime_playbook.get("playbook"),
            regime=regime_playbook.get("regime"),
            setup_type=(regime_playbook.get("allowedSetups") or [None])[0],
        )

    return {
        "allow": allow,
        "available": True,
        "gateRejects": all_blocks,
        "score": coaching["executionPriority"],
        "aggressiveScore": coaching["aggressiveScore"],
        "learningScore": coaching["learningScore"],
        "executionPriority": coaching["executionPriority"],
        "calibratedScore": coaching.get("calibratedScore", coaching["executionPriority"]),
        "scorePenalties": coaching["scorePenalties"],
        "riskProfile": risk_profile,
        "authority": "quant-brain",
        "judgeSniper": judge_result,
        "coachRanker": coaching,
        # Contract v2 — provenance & ML audit
        "signalId": request_signal_id,
        "predictionId": str(payload.get("predictionId") or uuid.uuid4()),
        "marketEventId": market_event_id,
        "featureVersion": feature_version,
        "experimentAssignments": experiment_assignments,
        "experimentId": primary_experiment["experimentId"] if primary_experiment else None,
        "experimentArm": primary_experiment["experimentArm"] if primary_experiment else None,
        "policyVersion": primary_experiment["policyVersion"] if primary_experiment else None,
        "modelVersion": ml_model_version,
        "calibratedProbability": round(ml_calibrated_prob, 6) if ml_calibrated_prob is not None else None,
        "uncertaintyType": ml_uncertainty_type,
        "predictionTimestamp": int(time.time() * 1000),
        "contractVersion": "edge-v3",
        "probabilityDefinition": "probability_configured_target_hit_before_stop",
        "dataAgeMs": None,
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
        "regimePlaybook": regime_playbook,
        "regime": regime_playbook["regime"],
        "playbook": regime_playbook["playbook"],
        "allowedSetups": regime_playbook["allowedSetups"],
        "blockedSetups": regime_playbook["blockedSetups"],
        "scoreAdjustments": regime_playbook["scoreAdjustments"],
        "recommendedTpPct": regime_playbook["recommendedTpPct"],
        "recommendedSlPct": regime_playbook["recommendedSlPct"],
        "maxPositions": regime_playbook["maxPositions"],
        "stackingBias": regime_playbook["stackingBias"],
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
            "adjustedStopPct": adjusted_stop,
            "optimalMarginKelly": optimal_size["optimal_margin_usdt"],
            "kellyFraction": optimal_size["kelly_fraction"],
            "playbookSizeMultiplier": size_multiplier,
            "baseOptimalMarginKelly": optimal_size.get("base_optimal_margin_usdt", 0.0),
            "riskGeometry": risk_geometry,
        },
        "newsContext": news_context,
        "dataQuality": data_quality,
        "operationalRisk": operational_risk,
        "shadowMl": shadow_ml,
        "realizedEdge": recommendation,
        "advancedMetrics": {
            "volatilityRegime": volatility_regime,
            "realizedSharpe": round(realized_sharpe, 3),
            "correlationPenalty": round(correlation_penalty, 3),
            "regimeConfidence": regime_confidence_dict,
            "evBootstrap": ev_bootstrap,
            "correlation": round(correlation, 3),
            "marketBreadth": round(market_breadth, 3),
            "liquidityScore": round(liquidity_score, 3),
            "adjustedStopPct": adjusted_stop,
        },
        "mode": "expired" if signal_expired else "judge-coach-dual-layer-v1",
    }
