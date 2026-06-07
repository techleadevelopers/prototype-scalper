from __future__ import annotations

import hashlib
import json
import os
import time
import math
import random
from collections import defaultdict
from typing import Any
from dataclasses import dataclass

from core import knowledge_base as kb
from core.database import connect
from core.movement_sniper import MovementFeatures
from layers.tactical import get_snapshot_history


TARGETS_USDT = (0.5, 1.0, 2.0)
OUTCOME_SECONDS = (30, 60, 120, 300)
MIN_CONTEXT_SAMPLES = 12
STRATEGY_VERSION = "sniper-v2"
OUTCOME_WINDOW_SECONDS = int(os.environ.get("SIGNAL_OUTCOME_WINDOW_SECONDS", "300"))
SIGNAL_OUTCOME_MIN_AGE_SECONDS = int(os.environ.get("SIGNAL_OUTCOME_MIN_AGE_SECONDS", str(OUTCOME_WINDOW_SECONDS)))
PRICE_TOLERANCE_SECONDS = 35

# Cache para contexto e decisões
_context_performance_cache: dict[str, dict] = {}
_cache_ttl = 300  # 5 minutos


@dataclass
class ContextPerformance:
    """Performance acumulada por contexto."""
    context_key: str
    total_attempts: int
    total_wins: int
    total_losses: int
    total_pnl_pct: float
    avg_win_pct: float
    avg_loss_pct: float
    win_rate: float
    expected_value: float
    last_updated: float


def _bucket(value: float, steps: list[tuple[float, str]], fallback: str) -> str:
    for limit, name in steps:
        if value < limit:
            return name
    return fallback


def _side_from_decision(decision: str, fallback: str) -> str:
    upper = decision.upper()
    if "LONG" in upper:
        return "LONG"
    if "SHORT" in upper:
        return "SHORT"
    return fallback.upper() if fallback else "UNKNOWN"


def _target_move_pct(
    target_usdt: float,
    margin_usdt: float,
    leverage: float,
    estimated_cost_pct: float = 0.0,
) -> float:
    notional = margin_usdt * leverage
    if notional <= 0:
        return 0.0
    return target_usdt / notional * 100 + estimated_cost_pct


def _decision_group(decision: str) -> str:
    upper = decision.upper()
    if upper.startswith("ALLOW_"):
        return "ALLOW"
    if upper.startswith("BLOCK_"):
        return "BLOCK"
    return "WAIT"


def _config_hash(config: dict[str, Any]) -> str:
    encoded = json.dumps(config, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def _estimated_cost_pct(alt: MovementFeatures, config: dict[str, Any]) -> float:
    entry_fee_bps = float(config.get("entryFeeBps", config.get("takerFeeBps", 5.0)) or 0)
    exit_fee_bps = float(config.get("exitFeeBps", config.get("takerFeeBps", 5.0)) or 0)
    slippage_bps = float(config.get("slippageBpsPerSide", 2.0) or 0) * 2
    funding_cost_pct = max(0.0, float(config.get("estimatedFundingCostPct", 0.0) or 0))
    return max(0.0, (entry_fee_bps + exit_fee_bps + slippage_bps) / 100 + funding_cost_pct)


def _entry_price(alt: MovementFeatures, side: str) -> float:
    if side == "LONG":
        return alt.ask or alt.last_price
    if side == "SHORT":
        return alt.bid or alt.last_price
    return alt.last_price


def build_context_key(alt: MovementFeatures, btc: MovementFeatures) -> str:
    """Constrói chave de contexto com buckets mais granulares."""
    volume_bucket = _bucket(
        alt.volume_ratio,
        [(1.1, "vol_low"), (1.4, "vol_ok"), (1.8, "vol_high"), (2.5, "vol_hot")],
        "vol_extreme",
    )
    atr_bucket = _bucket(
        alt.atr_pct,
        [(0.8, "atr_low"), (1.5, "atr_ok"), (2.5, "atr_high"), (4.0, "atr_very_high")],
        "atr_extreme",
    )
    rsi_bucket = _bucket(
        alt.rsi,
        [(30, "rsi_oversold"), (45, "rsi_low"), (55, "rsi_mid"), (65, "rsi_high"), (75, "rsi_overbought")],
        "rsi_exhausted",
    )
    oi_bucket = "oi_down" if alt.oi_change_pct < -0.5 else "oi_flat" if alt.oi_change_pct < 0.8 else "oi_up" if alt.oi_change_pct < 3 else "oi_surge"
    funding_bucket = (
        "funding_very_negative" if alt.funding_rate < -0.0006
        else "funding_negative" if alt.funding_rate < -0.0003
        else "funding_neutral" if alt.funding_rate < 0.0003
        else "funding_positive" if alt.funding_rate < 0.0006
        else "funding_very_positive"
    )
    spread_bucket = _bucket(
        alt.spread_bps,
        [(3, "spread_tight"), (6, "spread_ok"), (10, "spread_wide")],
        "spread_very_wide",
    )

    return "|".join([
        alt.movement_state,
        btc.movement_state,
        volume_bucket,
        atr_bucket,
        rsi_bucket,
        oi_bucket,
        funding_bucket,
        spread_bucket,
    ])


def _get_context_performance(context_key: str) -> ContextPerformance | None:
    """Recupera performance de contexto do cache."""
    cache_key = f"perf_{context_key}"
    if cache_key in _context_performance_cache:
        cached = _context_performance_cache[cache_key]
        if time.time() - cached.get("last_updated", 0) < _cache_ttl:
            return ContextPerformance(**cached)
    return None


def _update_context_performance(context_key: str, won: bool, pnl_pct: float):
    """Atualiza performance de contexto no cache."""
    existing = _get_context_performance(context_key)

    if existing:
        existing.total_attempts += 1
        if won:
            existing.total_wins += 1
            existing.total_pnl_pct += pnl_pct
            existing.avg_win_pct = existing.total_pnl_pct / existing.total_wins
        else:
            existing.total_losses += 1
            existing.total_pnl_pct += pnl_pct
            existing.avg_loss_pct = abs(existing.total_pnl_pct) / existing.total_losses
        existing.win_rate = existing.total_wins / existing.total_attempts
        existing.expected_value = (existing.win_rate * existing.avg_win_pct) - ((1 - existing.win_rate) * existing.avg_loss_pct)
        existing.last_updated = time.time()
    else:
        existing = ContextPerformance(
            context_key=context_key,
            total_attempts=1,
            total_wins=1 if won else 0,
            total_losses=0 if won else 1,
            total_pnl_pct=pnl_pct if won else pnl_pct,
            avg_win_pct=pnl_pct if won else 0,
            avg_loss_pct=abs(pnl_pct) if not won else 0,
            win_rate=1.0 if won else 0.0,
            expected_value=pnl_pct if won else pnl_pct,
            last_updated=time.time(),
        )

    _context_performance_cache[f"perf_{context_key}"] = existing.__dict__


def _signal_id(symbol: str, side: str, decision: str, created_bucket: int, context_key: str) -> str:
    raw = f"{symbol}|{side}|{decision}|{created_bucket}|{context_key}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _calculate_optimal_target(
    alt: MovementFeatures,
    btc: MovementFeatures,
    available_targets: list[float],
    margin: float,
    leverage: float,
) -> tuple[float, float]:
    """Seleciona target ótimo baseado em risk/reward."""
    notional = margin * leverage
    best_target = 0.5
    best_score = -999

    for target_usdt in available_targets:
        move_pct = target_usdt / notional * 100

        # Score baseado em probabilidade vs distância
        prob = _estimate_target_probability(alt, btc, move_pct)
        distance_score = 1 - min(1.0, move_pct / 5.0)  # Quanto menor o target, maior o score

        # ATR confirmação
        atr_score = 1.0 if alt.atr_pct >= move_pct * 0.8 else alt.atr_pct / (move_pct * 0.8) if move_pct > 0 else 0

        score = (prob * 0.5) + (distance_score * 0.3) + (atr_score * 0.2)

        if score > best_score:
            best_score = score
            best_target = target_usdt

    return best_target, best_score


def _estimate_target_probability(
    alt: MovementFeatures,
    btc: MovementFeatures,
    target_move_pct: float,
) -> float:
    """Estima probabilidade de atingir target baseado em contexto."""
    # Baseado em movimento atual
    base = 0.35

    # Momentum strength
    if abs(alt.price_change_pct) > 0:
        base += min(0.25, abs(alt.price_change_pct) / 4)

    # Volume confirmation
    if alt.volume_ratio > 1.5:
        base += 0.1
    elif alt.volume_ratio > 1.2:
        base += 0.05

    # OI confirmation
    if alt.oi_change_pct > 0:
        base += 0.05

    # BTC alignment
    if (alt.direction == "LONG" and btc.direction == "LONG") or \
       (alt.direction == "SHORT" and btc.direction == "SHORT"):
        base += 0.1

    # RSI zone
    if 35 <= alt.rsi <= 65:
        base += 0.05
    elif alt.rsi > 75 or alt.rsi < 25:
        base -= 0.1

    # Target difficulty
    difficulty = target_move_pct / max(alt.atr_pct, 0.2)
    if difficulty > 1.5:
        base -= 0.15
    elif difficulty > 1.0:
        base -= 0.05

    return max(0.05, min(0.85, base))


async def record_signal_from_gate(
    symbol: str,
    fallback_side: str,
    sniper: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Registra decisão do gate para aprendizado posterior."""
    alt = MovementFeatures(**sniper["altFeatures"])
    btc = MovementFeatures(**sniper["btcFeatures"])
    side = _side_from_decision(str(sniper.get("decision", "")), fallback_side)
    entry_price = float(_entry_price(alt, side) or 0)
    margin = float(config.get("marginPerTrade", 1.0) or 1.0)
    leverage = float(config.get("leverage", 1.0) or 1.0)
    estimated_cost_pct = _estimated_cost_pct(alt, config)
    context_key = build_context_key(alt, btc)

    # Target moves com otimização
    target_moves = {
        str(t): _target_move_pct(t, margin, leverage, estimated_cost_pct)
        for t in TARGETS_USDT
    }

    # Target ótimo baseado em contexto
    optimal_target, optimal_score = _calculate_optimal_target(
        alt, btc, list(TARGETS_USDT), margin, leverage
    )
    target_moves["optimal"] = _target_move_pct(optimal_target, margin, leverage, estimated_cost_pct)
    target_moves["optimal_target_usdt"] = optimal_target
    target_moves["optimal_score"] = optimal_score

    target_moves["configured"] = max(0.0, float(config.get("takeProfitPct", 0.15) or 0.15))
    stop_move_pct = max(0.0, float(config.get("stopLossPct", 0.10) or 0.10))
    dedupe_seconds = max(
        OUTCOME_WINDOW_SECONDS,
        int(
            config.get(
                "signalDedupeSeconds",
                os.environ.get("SIGNAL_DEDUPE_SECONDS", OUTCOME_WINDOW_SECONDS),
            )
            or OUTCOME_WINDOW_SECONDS
        ),
    )
    created_bucket = int(time.time() // dedupe_seconds)
    signal_id = _signal_id(symbol, side, str(sniper.get("decision", "")), created_bucket, context_key)
    decision = str(sniper.get("decision", "WAIT"))
    source_type = str(config.get("signalSourceType", "hypothetical")).lower()

    features = {
        "alt": sniper.get("altFeatures", {}),
        "btc": sniper.get("btcFeatures", {}),
        "alt_timeframes": sniper.get("altTimeframes", {}),
        "btc_timeframes": sniper.get("btcTimeframes", {}),
        "candle_regime": sniper.get("candleRegime", {}),
        "target_moves_pct": target_moves,
        "target_probabilities": sniper.get("targetProbabilities", {}),
        "estimated_cost_pct": estimated_cost_pct,
        "strategy_version": STRATEGY_VERSION,
        "stop_move_pct": stop_move_pct,
        "optimal_target_usdt": optimal_target,
        "optimal_score": optimal_score,
    }

    recorded = await kb.record_signal_decision(
        signal_id=signal_id,
        symbol=symbol,
        side=side,
        decision=decision,
        decision_group=_decision_group(decision),
        source_type=source_type,
        strategy_version=STRATEGY_VERSION,
        config_hash=_config_hash(config),
        context_key=context_key,
        features=features,
        reasons=list(sniper.get("reasons", [])),
        entry_price=entry_price,
        estimated_cost_pct=estimated_cost_pct,
        target_moves=target_moves,
    )

    return {
        "recorded": recorded,
        "signalId": signal_id,
        "contextKey": context_key,
        "side": side,
        "entryPrice": entry_price,
        "targetMovesPct": target_moves,
        "estimatedCostPct": round(estimated_cost_pct, 6),
        "decisionGroup": _decision_group(decision),
        "sourceType": source_type,
        "strategyVersion": STRATEGY_VERSION,
        "optimalTargetUsdt": optimal_target,
        "optimalScore": round(optimal_score, 4),
    }


def _nearest_price(history: list[dict], target_ts: float) -> float | None:
    if not history:
        return None
    best = min(history, key=lambda x: abs(float(x.get("timestamp", 0)) - target_ts))
    if abs(float(best.get("timestamp", 0)) - target_ts) > PRICE_TOLERANCE_SECONDS:
        return None
    price = float(best.get("price", 0) or 0)
    return price if price > 0 else None


def _executable_price(snapshot: dict, side: str) -> float:
    if side == "LONG":
        return float(snapshot.get("bid", snapshot.get("price", 0)) or 0)
    return float(snapshot.get("ask", snapshot.get("price", 0)) or 0)


def _directional_move_pct(entry: float, price: float, side: str) -> float:
    if entry <= 0 or price <= 0:
        return 0.0
    raw = (price - entry) / entry * 100
    return raw if side == "LONG" else -raw


def _calculate_sharpe_from_outcome(moves: list[float]) -> float:
    """Calcula Sharpe ratio do outcome para avaliação de qualidade."""
    if len(moves) < 3:
        return 0.0

    mean_move = sum(moves) / len(moves)
    variance = sum((m - mean_move) ** 2 for m in moves) / len(moves)
    std_move = math.sqrt(variance) if variance > 0 else 0.0001

    if std_move == 0:
        return 0.0

    return mean_move / std_move


async def finalize_due_signal_outcomes() -> dict[str, Any]:
    """Finaliza outcomes pendentes com métricas avançadas."""
    pending = await kb.get_pending_signal_outcomes(min_age_seconds=SIGNAL_OUTCOME_MIN_AGE_SECONDS, limit=250)
    finalized = 0
    results = []

    for signal in pending:
        symbol = str(signal["symbol"])
        side = str(signal["side"]).upper()
        entry = float(signal["entry_price"] or 0)
        created_at = float(signal["created_at"] or 0)
        context_key = str(signal["context_key"])

        history = get_snapshot_history(symbol, 420)
        window_end = created_at + OUTCOME_WINDOW_SECONDS
        future = [
            h for h in history
            if created_at <= float(h.get("timestamp", 0)) <= window_end
        ]
        if not future:
            persisted = await kb.get_feature_history(symbol, hours=2)
            future = [
                h for h in persisted
                if created_at <= float(h.get("timestamp", 0)) <= window_end
            ]
        if entry <= 0 or not future:
            continue

        prices = {}
        for sec in OUTCOME_SECONDS:
            price = _nearest_price(future, created_at + sec)
            if price is not None:
                prices[str(sec)] = price

        ordered = sorted(future, key=lambda h: float(h.get("timestamp", 0)))
        moves = [_directional_move_pct(entry, _executable_price(h, side), side) for h in ordered]
        max_favorable = max(moves) if moves else 0.0
        max_adverse = min(moves) if moves else 0.0
        sharpe = _calculate_sharpe_from_outcome(moves)

        stop_move_pct = float(
            signal["features"].get("stop_move_pct")
            or max(float(signal["target_configured_move_pct"] or 0), 0.15)
        )
        target_thresholds = {
            "configured": float(signal["target_configured_move_pct"] or 0),
            "0.5": float(signal["target_050_move_pct"] or 0),
            "1.0": float(signal["target_100_move_pct"] or 0),
            "2.0": float(signal["target_200_move_pct"] or 0),
            "optimal": float(signal["features"].get("target_moves_pct", {}).get("optimal", 0)),
        }

        stop_time = next(
            (
                float(item.get("timestamp", 0))
                for item, move in zip(ordered, moves)
                if move <= -stop_move_pct
            ),
            None,
        )
        target_times = {
            target: next(
                (
                    float(item.get("timestamp", 0))
                    for item, move in zip(ordered, moves)
                    if move >= threshold
                ),
                None,
            )
            for target, threshold in target_thresholds.items()
        }
        hits = {
            target: hit_time is not None and (stop_time is None or hit_time <= stop_time)
            for target, hit_time in target_times.items()
        }

        configured_target_time = target_times.get("configured")
        stopped = stop_time is not None and (
            configured_target_time is None or stop_time < configured_target_time
        )

        if stopped:
            first_event = "STOP"
            first_event_time = stop_time
        elif configured_target_time is not None:
            first_event = "TARGET_CONFIGURED"
            first_event_time = configured_target_time
        else:
            first_event = "TIMEOUT"
            first_event_time = window_end

        # Atualiza performance de contexto
        hit_configured = hits.get("configured", False)
        pnl_pct = target_thresholds["configured"] if hit_configured else -stop_move_pct
        _update_context_performance(context_key, hit_configured, pnl_pct)

        await kb.finalize_signal_outcome(
            signal_id=str(signal["signal_id"]),
            prices=prices,
            hits=hits,
            stopped=stopped,
            first_event=first_event,
            first_event_seconds=round(max(0.0, first_event_time - created_at), 3),
            max_favorable_pct=round(max_favorable, 4),
            max_adverse_pct=round(max_adverse, 4),
        )

        results.append({
            "signal_id": signal["signal_id"],
            "hit": hit_configured,
            "stopped": stopped,
            "sharpe": round(sharpe, 3),
            "max_favorable": round(max_favorable, 2),
            "max_adverse": round(max_adverse, 2),
        })
        finalized += 1

    return {
        "pending": len(pending),
        "finalized": finalized,
        "results": results[:20],
        "hit_rate_finalized": round(sum(1 for r in results if r["hit"]) / max(1, len(results)) * 100, 1),
    }


async def score_signal_context(
    symbol: str,
    side: str,
    context_key: str,
    decision_group: str = "ALLOW",
    source_type: str = "hypothetical",
) -> dict[str, Any]:
    """Avalia contexto com cache e métricas avançadas."""
    # Verifica cache
    cached_perf = _get_context_performance(context_key)
    if cached_perf and cached_perf.total_attempts >= MIN_CONTEXT_SAMPLES:
        return {
            "score": round(min(0.95, max(0.05, 0.5 + cached_perf.expected_value * 2)), 4),
            "verdict": "positive_context" if cached_perf.win_rate >= 0.55 else "toxic_context" if cached_perf.win_rate <= 0.45 else "neutral_context",
            "minSamples": MIN_CONTEXT_SAMPLES,
            "context": {
                "samples": cached_perf.total_attempts,
                "hit_configured": cached_perf.win_rate,
                "avg_favorable_pct": cached_perf.avg_win_pct,
                "avg_adverse_pct": cached_perf.avg_loss_pct,
            },
            "symbolSide": await kb.get_signal_edge_stats(symbol=symbol, side=side, decision_group=decision_group, source_type=source_type),
            "decisionGroup": decision_group,
            "sourceType": source_type,
            "cached": True,
        }

    context_stats = await kb.get_signal_edge_stats(
        symbol=symbol,
        side=side,
        context_key=context_key,
        decision_group=decision_group,
        source_type=source_type,
    )
    symbol_stats = await kb.get_signal_edge_stats(
        symbol=symbol,
        side=side,
        context_key=None,
        decision_group=decision_group,
        source_type=source_type,
    )

    effective = context_stats if context_stats["samples"] >= MIN_CONTEXT_SAMPLES else symbol_stats
    samples = effective["samples"]

    if samples == 0:
        score = 0.5
        verdict = "cold_start"
    else:
        hit = effective["hit_configured"]
        stop = effective["stop_rate"]
        favorable = effective.get("avg_favorable_pct", 0)
        adverse = effective.get("avg_adverse_pct", 0)

        # Risk-adjusted score
        risk_adjusted = hit - (stop * 0.6) + (favorable / max(adverse, 0.1)) * 0.1
        score = max(0.0, min(0.95, 0.35 + risk_adjusted))

        if samples < MIN_CONTEXT_SAMPLES:
            verdict = "learning"
        elif hit >= 0.60 and stop <= 0.35 and risk_adjusted > 0.2:
            verdict = "positive_context"
        elif hit < 0.45 or stop > 0.45:
            verdict = "toxic_context"
        else:
            verdict = "neutral_context"

    return {
        "score": round(score, 4),
        "verdict": verdict,
        "minSamples": MIN_CONTEXT_SAMPLES,
        "context": context_stats,
        "symbolSide": symbol_stats,
        "decisionGroup": decision_group,
        "sourceType": source_type,
        "cached": False,
    }


async def get_top_contexts(limit: int = 20) -> list[dict]:
    """Retorna os melhores contextos baseados em performance."""
    contexts = []

    async for ctx in _get_all_contexts_from_db():
        perf = _get_context_performance(ctx)
        if perf and perf.total_attempts >= MIN_CONTEXT_SAMPLES:
            contexts.append({
                "context_key": ctx,
                "win_rate": round(perf.win_rate * 100, 1),
                "expected_value": round(perf.expected_value, 4),
                "samples": perf.total_attempts,
                "avg_win_pct": round(perf.avg_win_pct, 2),
                "avg_loss_pct": round(perf.avg_loss_pct, 2),
            })

    contexts.sort(key=lambda x: x["expected_value"], reverse=True)
    return contexts[:limit]


async def _get_all_contexts_from_db() -> list[str]:
    """Recupera todos os context keys do banco."""
    from core.knowledge_base import DB_PATH

    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            "SELECT DISTINCT context_key FROM signal_outcomes WHERE finalized=1 LIMIT 1000"
        )).fetchall()

    return [str(r[0]) for r in rows if r[0]]


async def clear_context_cache():
    """Limpa cache de performance de contexto."""
    _context_performance_cache.clear()
