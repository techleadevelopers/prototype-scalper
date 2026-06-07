from __future__ import annotations

import time
import math
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from core.database import connect, table_columns
from core.knowledge_base import DB_PATH


MIN_SAMPLES_FOR_BLOCK = 8
MIN_SCORE_TO_ALLOW = 0.58
CONFIDENCE_LEVEL = 0.95


@dataclass
class TradeRow:
    symbol: str
    side: str
    pnl_pct: float
    pnl_usdt: float
    win: int
    btc_regime: str
    timestamp: float

    @property
    def hour_utc(self) -> int:
        return datetime.fromtimestamp(self.timestamp, tz=timezone.utc).hour


def _normalize_symbol(symbol: str) -> str:
    sym = symbol.upper().strip()
    if "-" in sym:
        return sym
    if sym.endswith("USDT"):
        return f"{sym[:-4]}-USDT"
    return sym


def _symbol_variants(symbol: str) -> tuple[str, str]:
    normalized = _normalize_symbol(symbol)
    compact = normalized.replace("-", "")
    return normalized, compact


def _position_to_side(position_side: str | None, side: str | None) -> str:
    raw = (position_side or side or "").upper()
    if raw in {"LONG", "BUY"}:
        return "LONG"
    if raw in {"SHORT", "SELL"}:
        return "SHORT"
    return raw or "UNKNOWN"


def _profit_factor(rows: list[TradeRow]) -> float:
    gross_win = sum(r.pnl_pct for r in rows if r.pnl_pct > 0)
    gross_loss = abs(sum(r.pnl_pct for r in rows if r.pnl_pct < 0))
    if gross_loss == 0:
        return 999.0 if gross_win > 0 else 0.0
    return gross_win / gross_loss


def _sharpe_ratio(rows: list[TradeRow]) -> float:
    """Calcula Sharpe Ratio anualizado dos trades realizados."""
    if len(rows) < 5:
        return 0.0

    returns = [r.pnl_pct for r in rows]
    mean_return = sum(returns) / len(returns)
    variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
    std_return = math.sqrt(variance) if variance > 0 else 0.0001

    if std_return == 0:
        return 0.0

    sharpe = (mean_return / std_return) * math.sqrt(365)
    return round(sharpe, 3)


def _sortino_ratio(rows: list[TradeRow]) -> float:
    """Sortino Ratio - só penaliza downside deviation."""
    if len(rows) < 5:
        return 0.0

    returns = [r.pnl_pct for r in rows]
    mean_return = sum(returns) / len(returns)

    negative_returns = [r for r in returns if r < 0]
    if not negative_returns:
        return 999.0

    downside_var = sum((r - mean_return) ** 2 for r in negative_returns) / len(returns)
    downside_std = math.sqrt(downside_var) if downside_var > 0 else 0.0001

    sortino = (mean_return / downside_std) * math.sqrt(365)
    return round(sortino, 3)


def _max_drawdown(rows: list[TradeRow]) -> float:
    """Maximum drawdown percentual."""
    if len(rows) < 2:
        return 0.0

    cumulative = 0.0
    peak = 0.0
    max_dd = 0.0

    for r in rows:
        cumulative += r.pnl_pct
        if cumulative > peak:
            peak = cumulative
        dd = peak - cumulative
        if dd > max_dd:
            max_dd = dd

    return round(max_dd, 4)


def _win_rate_confidence_interval(wins: int, total: int, confidence: float = 0.95) -> dict:
    """
    Intervalo de confiança para win rate usando Wilson score.
    Método estatisticamente robusto para amostras pequenas.
    """
    if total == 0:
        return {"lower": 0.0, "upper": 1.0, "margin": 0.5}

    p = wins / total
    z = 1.96  # 95% confidence

    denominator = 1 + z**2 / total
    centre = p + z**2 / (2 * total)
    half_width = z * math.sqrt((p * (1 - p) + z**2 / (4 * total)) / total)

    lower = max(0.0, (centre - half_width) / denominator)
    upper = min(1.0, (centre + half_width) / denominator)

    return {
        "lower": round(lower, 4),
        "upper": round(upper, 4),
        "margin": round((upper - lower) / 2, 4),
        "is_significant": lower > 0.5 or upper < 0.5
    }


def _bootstrap_pnl_confidence(rows: list[TradeRow], n_bootstrap: int = 1000) -> dict:
    """
    Bootstrap para intervalo de confiança do PnL total.
    Determina se edge é estatisticamente significativo.
    """
    if len(rows) < 5:
        return {"pnl_positive_confidence": 0.0, "reliable": False}

    total_pnls = []

    for _ in range(n_bootstrap):
        sample = random.choices(rows, k=len(rows))
        sample_pnl = sum(r.pnl_pct for r in sample)
        total_pnls.append(sample_pnl)

    total_pnls.sort()
    pnl_positive = sum(1 for p in total_pnls if p > 0) / n_bootstrap

    lower_idx = int(n_bootstrap * (1 - CONFIDENCE_LEVEL) / 2)
    upper_idx = int(n_bootstrap * (1 + CONFIDENCE_LEVEL) / 2)

    return {
        "pnl_positive_confidence": round(pnl_positive, 4),
        "pnl_lower_bound": round(total_pnls[lower_idx], 4),
        "pnl_upper_bound": round(total_pnls[upper_idx], 4),
        "reliable": len(rows) >= 15,
        "verdict": "POSITIVE_PNL_CONFIRMED" if pnl_positive > 0.95 else "POSITIVE_PNL_LIKELY" if pnl_positive > 0.8 else "INCONCLUSIVE"
    }


def _detect_toxicity_trend(rows: list[TradeRow], window: int = 20) -> dict:
    """
    Detecta tendência de toxicidade: win rate e PnL estão piorando?
    """
    if len(rows) < window * 2:
        return {"toxic_trend": False, "trend_strength": 0.0}

    first_half = rows[:window]
    second_half = rows[-window:]

    wr_first = len([r for r in first_half if r.win]) / len(first_half)
    wr_second = len([r for r in second_half if r.win]) / len(second_half)

    pnl_first = sum(r.pnl_pct for r in first_half) / len(first_half)
    pnl_second = sum(r.pnl_pct for r in second_half) / len(second_half)

    wr_decline = wr_first - wr_second
    pnl_decline = pnl_first - pnl_second

    if wr_decline > 0.1 and pnl_decline > 0.05:
        return {
            "toxic_trend": True,
            "trend_strength": round((wr_decline + pnl_decline) / 2, 4),
            "wr_decline_pp": round(wr_decline * 100, 1),
            "pnl_decline_pct": round(pnl_decline, 4),
            "verdict": "EDGE_DETERIORATING"
        }

    return {"toxic_trend": False, "trend_strength": 0.0}


def _calculate_expected_value(rows: list[TradeRow]) -> dict:
    """
    Calcula Expected Value real e ajustado por taxa.
    """
    if not rows:
        return {"ev_pct": 0.0, "ev_usdt": 0.0, "ev_ratio": 0.0}

    avg_win = sum(r.pnl_pct for r in rows if r.pnl_pct > 0) / max(1, len([r for r in rows if r.pnl_pct > 0]))
    avg_loss = abs(sum(r.pnl_pct for r in rows if r.pnl_pct < 0)) / max(1, len([r for r in rows if r.pnl_pct < 0]))
    win_rate = len([r for r in rows if r.win]) / len(rows)
    loss_rate = 1 - win_rate

    ev_pct = (win_rate * avg_win) - (loss_rate * avg_loss)

    # EV em USDT
    avg_win_usdt = sum(r.pnl_usdt for r in rows if r.pnl_usdt > 0) / max(1, len([r for r in rows if r.pnl_usdt > 0]))
    avg_loss_usdt = abs(sum(r.pnl_usdt for r in rows if r.pnl_usdt < 0)) / max(1, len([r for r in rows if r.pnl_usdt < 0]))
    ev_usdt = (win_rate * avg_win_usdt) - (loss_rate * avg_loss_usdt)

    # EV Ratio (expectativa / risco médio)
    avg_risk = avg_loss if avg_loss > 0 else 0.01
    ev_ratio = ev_pct / avg_risk if avg_risk > 0 else 0

    if ev_ratio >= 0.5:
        rating = "ELITE"
    elif ev_ratio >= 0.3:
        rating = "EXCELLENT"
    elif ev_ratio >= 0.15:
        rating = "GOOD"
    elif ev_ratio > 0:
        rating = "MARGINAL"
    else:
        rating = "NEGATIVE"

    return {
        "ev_pct": round(ev_pct, 4),
        "ev_usdt": round(ev_usdt, 4),
        "ev_ratio": round(ev_ratio, 3),
        "rating": rating,
        "avg_win_pct": round(avg_win, 4),
        "avg_loss_pct": round(avg_loss, 4)
    }


def _stats(rows: list[TradeRow]) -> dict[str, Any]:
    """Estatísticas completas com métricas avançadas."""
    if not rows:
        return {
            "samples": 0,
            "win_rate": 0.0,
            "avg_pnl": 0.0,
            "total_pnl": 0.0,
            "total_pnl_usdt": 0.0,
            "profit_factor": 0.0,
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "sharpe": 0.0,
            "sortino": 0.0,
            "max_drawdown": 0.0,
            "expected_value": {"ev_pct": 0.0, "ev_ratio": 0.0, "rating": "NO_DATA"},
            "confidence_interval": {"lower": 0.0, "upper": 1.0, "is_significant": False},
            "bootstrap": {"pnl_positive_confidence": 0.0, "reliable": False},
            "toxicity_trend": {"toxic_trend": False},
        }

    wins = [r for r in rows if r.pnl_pct > 0]
    losses = [r for r in rows if r.pnl_pct <= 0]
    total_pnl = sum(r.pnl_pct for r in rows)
    total_pnl_usdt = sum(r.pnl_usdt for r in rows)
    win_rate = len(wins) / len(rows)

    confidence = _win_rate_confidence_interval(len(wins), len(rows))
    bootstrap = _bootstrap_pnl_confidence(rows)
    toxicity = _detect_toxicity_trend(rows)
    ev = _calculate_expected_value(rows)

    return {
        "samples": len(rows),
        "win_rate": round(win_rate, 4),
        "avg_pnl": round(total_pnl / len(rows), 4),
        "total_pnl": round(total_pnl, 4),
        "total_pnl_usdt": round(total_pnl_usdt, 4),
        "profit_factor": round(_profit_factor(rows), 3),
        "avg_win": round(sum(w.pnl_pct for w in wins) / len(wins), 4) if wins else 0.0,
        "avg_loss": round(sum(l.pnl_pct for l in losses) / len(losses), 4) if losses else 0.0,
        "sharpe": _sharpe_ratio(rows),
        "sortino": _sortino_ratio(rows),
        "max_drawdown": _max_drawdown(rows),
        "expected_value": ev,
        "confidence_interval": confidence,
        "bootstrap": bootstrap,
        "toxicity_trend": toxicity,
    }


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _score(stats: dict[str, Any], recent_stats: dict[str, Any]) -> float:
    """
    Score avançado com múltiplos fatores:
    - Win rate base
    - Sharpe ratio
    - Expected value
    - Significância estatística
    - Tendência de toxicidade
    """
    samples = stats["samples"]
    if samples == 0:
        return 0.5

    confidence = _clamp(samples / 30)

    # Fatores base
    wr_score = stats["win_rate"]

    # Sharpe score (max 0.25 bonus)
    sharpe = stats.get("sharpe", 0)
    sharpe_score = _clamp(sharpe / 2.0) * 0.15

    # Expected value score
    ev_ratio = stats.get("expected_value", {}).get("ev_ratio", 0)
    ev_score = _clamp(ev_ratio / 0.5) * 0.12

    # Profit factor score
    pf_score = _clamp(stats["profit_factor"] / 2.0) * 0.10

    # Avg PnL score
    avg_pnl_score = _clamp((stats["avg_pnl"] + 0.4) / 0.8) * 0.08

    # Significância estatística (bônus se edge é real)
    significance_bonus = 0.05 if stats.get("confidence_interval", {}).get("is_significant", False) else 0

    # Tendência de toxicidade (penalidade se edge está deteriorando)
    toxicity_penalty = 0
    if stats.get("toxicity_trend", {}).get("toxic_trend", False):
        toxicity_penalty = -0.08

    # Recent drift
    recent_bonus = _clamp((recent_stats["avg_pnl"] - stats["avg_pnl"] + 0.2) / 0.4) * 0.10 if recent_stats["samples"] else 0.05

    raw = (wr_score * 0.30) + sharpe_score + ev_score + pf_score + avg_pnl_score + recent_bonus + significance_bonus + toxicity_penalty

    # Ajuste por confiança da amostra
    final = (raw * confidence) + (0.5 * (1 - confidence))

    return round(_clamp(final), 4)


def _risk_bucket(score: float, samples: int, stats: dict) -> str:
    """Bucket de risco com validação estatística."""
    if samples < MIN_SAMPLES_FOR_BLOCK:
        return "shadow_only"

    # Se EV é negativo, força reject mesmo com score alto
    if stats.get("expected_value", {}).get("ev_pct", 0) < 0:
        return "reject"

    # Se Sharpe é muito baixo, reduz agressividade
    sharpe = stats.get("sharpe", 0)
    if sharpe < 0.3 and samples > 20:
        if score >= 0.78:
            return "standard"  # Downgrade de aggressive
        if score >= 0.66:
            return "scout"     # Downgrade de standard

    # Se intervalo de confiança contém 0.5, edge pode ser sorte
    ci = stats.get("confidence_interval", {})
    if ci.get("is_significant") == False and samples > 20 and score > 0.66:
        return "scout"  # Downgrade

    if score >= 0.78:
        return "aggressive"
    if score >= 0.66:
        return "standard"
    if score >= MIN_SCORE_TO_ALLOW:
        return "scout"
    return "reject"


def _suggested_margin(score: float, samples: int, stats: dict) -> float:
    """Sugestão de margem baseada em score, Sharpe e EV."""
    if samples < MIN_SAMPLES_FOR_BLOCK or score < MIN_SCORE_TO_ALLOW:
        return 0.0

    # Ajuste por Sharpe
    sharpe = stats.get("sharpe", 0)
    sharpe_multiplier = min(1.0, max(0.5, sharpe / 1.5))

    # Ajuste por EV ratio
    ev_ratio = stats.get("expected_value", {}).get("ev_ratio", 0)
    ev_multiplier = min(1.0, max(0.3, ev_ratio / 0.3))

    base_margin = 0.0
    if score >= 0.78:
        base_margin = 2.0
    elif score >= 0.66:
        base_margin = 1.0
    else:
        base_margin = 0.5

    adjusted = base_margin * min(sharpe_multiplier, ev_multiplier)

    if adjusted < 0.5:
        return 0.0
    if adjusted < 0.75:
        return 0.5
    if adjusted < 1.25:
        return 1.0
    return 2.0


async def _load_trades(days: int = 30, include_usdt: bool = True) -> list[TradeRow]:
    """Carrega trades com suporte para pnl_usdt."""
    since = time.time() - days * 86400

    # Verifica se coluna pnl_usdt existe
    async with connect(DB_PATH) as db:
        columns = await table_columns("trade_outcomes", DB_PATH)
        has_pnl_usdt = "pnl_usdt" in columns

        if has_pnl_usdt and include_usdt:
            rows = await (await db.execute(
                """SELECT symbol, side, pnl_pct, pnl_usdt, win, btc_regime, timestamp
                   FROM trade_outcomes
                   WHERE timestamp >= ?
                   ORDER BY timestamp ASC""",
                (since,),
            )).fetchall()
        else:
            rows = await (await db.execute(
                """SELECT symbol, side, pnl_pct, 0.0 as pnl_usdt, win, btc_regime, timestamp
                   FROM trade_outcomes
                   WHERE timestamp >= ?
                   ORDER BY timestamp ASC""",
                (since,),
            )).fetchall()

    result = []
    for r in rows:
        try:
            result.append(TradeRow(
                symbol=str(r[0]),
                side=_position_to_side(None, str(r[1])),
                pnl_pct=float(r[2] or 0),
                pnl_usdt=float(r[3] or 0) if len(r) > 3 else 0.0,
                win=int(r[4] or 0) if len(r) > 4 else 0,
                btc_regime=str(r[5] or "NEUTRAL") if len(r) > 5 else "NEUTRAL",
                timestamp=float(r[6] or 0) if len(r) > 6 else 0,
            ))
        except (IndexError, ValueError, TypeError):
            continue

    return result


async def recommend_entry(payload: dict[str, Any], days: int = 30) -> dict[str, Any]:
    """
    Recomendação de entrada baseada em realized PnL com estatística avançada.
    """
    symbol = _normalize_symbol(str(payload.get("symbol", "")))
    side = _position_to_side(payload.get("position_side"), payload.get("side"))
    btc_regime = str(payload.get("btc_regime", "NEUTRAL")).upper()
    hour_utc = int(payload.get("hour_utc", datetime.now(timezone.utc).hour))
    shadow_only = bool(payload.get("shadow_only", True))
    variants = set(_symbol_variants(symbol))

    trades = await _load_trades(days)
    symbol_rows = [r for r in trades if r.symbol in variants and r.side == side]
    cluster_rows = [r for r in symbol_rows if r.btc_regime == btc_regime and r.hour_utc == hour_utc]
    regime_rows = [r for r in symbol_rows if r.btc_regime == btc_regime]
    hour_rows = [r for r in symbol_rows if r.hour_utc == hour_utc]
    recent_rows = symbol_rows[-20:]

    base_stats = _stats(symbol_rows)
    cluster_stats = _stats(cluster_rows)
    regime_stats = _stats(regime_rows)
    hour_stats = _stats(hour_rows)
    recent_stats = _stats(recent_rows)

    # Escolhe estatísticas mais relevantes com prioridade para cluster específico
    if cluster_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK:
        effective_stats = cluster_stats
    elif regime_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK:
        effective_stats = regime_stats
    elif hour_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK:
        effective_stats = hour_stats
    else:
        effective_stats = base_stats

    score = _score(effective_stats, recent_stats)
    risk = _risk_bucket(score, effective_stats["samples"], effective_stats)
    allow = score >= MIN_SCORE_TO_ALLOW and effective_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK

    # Validação adicional: EV deve ser positivo para allow
    if allow and effective_stats.get("expected_value", {}).get("ev_pct", 0) <= 0:
        allow = False
        risk = "reject"

    # Validação adicional: Sharpe mínimo para aggressive
    if risk == "aggressive" and effective_stats.get("sharpe", 0) < 1.0:
        risk = "standard"

    reasons: list[str] = []

    if effective_stats["samples"] < MIN_SAMPLES_FOR_BLOCK:
        reasons.append("insufficient_realized_samples")
    elif effective_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK:
        # Adiciona razões estatísticas
        ci = effective_stats.get("confidence_interval", {})
        if ci.get("is_significant"):
            reasons.append(f"statistically_significant_edge_95ci_win_rate_{effective_stats['win_rate']*100:.0f}%")

        ev = effective_stats.get("expected_value", {})
        if ev.get("ev_ratio", 0) > 0.3:
            reasons.append(f"high_expectancy_ratio_{ev['ev_ratio']:.2f}")

        if effective_stats.get("sharpe", 0) > 1.0:
            reasons.append(f"good_sharpe_ratio_{effective_stats['sharpe']:.2f}")

        bootstrap = effective_stats.get("bootstrap", {})
        if bootstrap.get("verdict") == "POSITIVE_PNL_CONFIRMED":
            reasons.append("positive_pnl_statistically_confirmed")

    if base_stats["total_pnl"] < 0 and base_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK:
        reasons.append("negative_symbol_side_total_pnl")

    if hour_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK and hour_stats["avg_pnl"] < 0:
        reasons.append("toxic_hour_for_symbol_side")
        if hour_stats.get("toxicity_trend", {}).get("toxic_trend"):
            reasons.append("hour_toxicity_trend_worsening")

    if regime_stats["samples"] >= MIN_SAMPLES_FOR_BLOCK and regime_stats["avg_pnl"] < 0:
        reasons.append("toxic_btc_regime_for_symbol_side")

    if recent_stats["samples"] >= 8 and recent_stats["avg_pnl"] < base_stats["avg_pnl"]:
        reasons.append("recent_edge_drift_down")

    if effective_stats.get("toxicity_trend", {}).get("toxic_trend"):
        reasons.append("edge_deteriorating_trend_detected")

    if allow:
        reasons.append("positive_realized_edge_gate")

    return {
        "allow": allow if not shadow_only else False,
        "shadowRecommendation": allow,
        "shadowOnly": shadow_only,
        "score": score,
        "risk": risk,
        "suggestedMarginUsdt": _suggested_margin(score, effective_stats["samples"], effective_stats),
        "minSamplesForLiveGate": MIN_SAMPLES_FOR_BLOCK,
        "reasons": reasons,
        "context": {
            "symbol": symbol,
            "side": side,
            "btcRegime": btc_regime,
            "hourUtc": hour_utc,
            "days": days,
        },
        "stats": {
            "symbolSide": base_stats,
            "cluster": cluster_stats,
            "regime": regime_stats,
            "hour": hour_stats,
            "recent": recent_stats,
            "effective": effective_stats,
        },
        "statisticalSummary": {
            "winRateConfidenceInterval": effective_stats.get("confidence_interval", {}),
            "pnlBootstrap": effective_stats.get("bootstrap", {}),
            "expectedValue": effective_stats.get("expected_value", {}),
            "toxicityTrend": effective_stats.get("toxicity_trend", {}),
        }
    }


def _apply_gate(rows: list[TradeRow], gate: str, threshold: float) -> tuple[list[TradeRow], list[TradeRow]]:
    grouped: dict[Any, list[TradeRow]] = {}
    for r in rows:
        key = r.symbol if gate == "symbol" else r.hour_utc if gate == "hour" else r.btc_regime
        grouped.setdefault(key, []).append(r)
    stats_by_key = {key: _stats(vals) for key, vals in grouped.items()}
    kept: list[TradeRow] = []
    rejected: list[TradeRow] = []
    for r in rows:
        key = r.symbol if gate == "symbol" else r.hour_utc if gate == "hour" else r.btc_regime
        s = stats_by_key[key]
        should_reject = s["samples"] >= MIN_SAMPLES_FOR_BLOCK and s["avg_pnl"] < threshold
        (rejected if should_reject else kept).append(r)
    return kept, rejected


async def simulate_gate_rejections(days: int = 30, min_avg_pnl: float = 0.0) -> dict[str, Any]:
    """Simula gate rejections com estatísticas avançadas."""
    rows = await _load_trades(days)
    baseline = _stats(rows)
    simulations = []

    for gate in ("symbol", "hour", "regime"):
        kept, rejected = _apply_gate(rows, gate, min_avg_pnl)
        kept_stats = _stats(kept)
        rejected_stats = _stats(rejected)

        # PnL improvement adicional considerando Sharpe
        sharpe_improvement = kept_stats.get("sharpe", 0) - baseline.get("sharpe", 0)

        simulations.append({
            "gate": gate,
            "threshold": {"minAvgPnl": min_avg_pnl},
            "keptTrades": kept_stats["samples"],
            "rejectedTrades": rejected_stats["samples"],
            "baselineTotalPnl": baseline["total_pnl"],
            "keptTotalPnl": kept_stats["total_pnl"],
            "rejectedTotalPnl": rejected_stats["total_pnl"],
            "pnlImprovementIfRejected": -rejected_stats["total_pnl"],
            "keptWinRate": kept_stats["win_rate"],
            "rejectedWinRate": rejected_stats["win_rate"],
            "keptSharpe": kept_stats.get("sharpe", 0),
            "baselineSharpe": baseline.get("sharpe", 0),
            "sharpeImprovement": round(sharpe_improvement, 3),
        })

    simulations.sort(key=lambda x: x["pnlImprovementIfRejected"], reverse=True)

    return {
        "days": days,
        "baseline": baseline,
        "simulations": simulations,
        "statisticalSummary": {
            "totalSamples": len(rows),
            "sampleConfidence": len(rows) >= 30,
            "bestGate": simulations[0]["gate"] if simulations else None,
            "bestImprovement": simulations[0]["pnlImprovementIfRejected"] if simulations else 0,
        },
        "note": "Positive pnlImprovementIfRejected means the gate would have removed net losing flow.",
    }
