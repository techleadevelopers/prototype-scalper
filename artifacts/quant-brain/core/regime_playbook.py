from __future__ import annotations

import time
from typing import Any


PLAYBOOK_VERSION = "regime-playbook-v1"

REGIMES = {
    "BTC_TREND_UP",
    "BTC_TREND_DOWN",
    "BTC_CHOP",
    "ALT_MOMENTUM_BURST",
    "LOW_LIQUIDITY",
    "HIGH_VOLATILITY_CHAOS",
    "NEWS_SPIKE",
    "RECOVERY_AFTER_DRAWDOWN",
}

PLAYBOOKS = {
    "MOMENTUM_BREAKOUT_SCALP",
    "PULLBACK_CONTINUATION",
    "RANGE_QUICK_SCALP",
    "LIQUIDITY_SWEEP_REVERSAL",
    "BTC_LEAD_ALT_FOLLOW",
    "AVOID_MODE",
}


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value) if value is not None else fallback
    except Exception:
        return fallback


def _upper(value: Any, fallback: str = "") -> str:
    text = str(value or fallback).strip().upper()
    return text or fallback


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _stats_from_performance(performance: dict[str, Any] | None, playbook: str) -> dict[str, Any]:
    if not isinstance(performance, dict):
        return {"trades": 0, "winRate": None, "profitFactor": None, "avgPnlPct": 0.0}
    row = performance.get(playbook) or {}
    return {
        "trades": int(_num(row.get("trades"), 0)),
        "winRate": row.get("winRate"),
        "profitFactor": row.get("profitFactor"),
        "avgPnlPct": _num(row.get("avgPnlPct"), 0.0),
    }


def classify_regime_playbook(
    *,
    symbol: str,
    position_side: str = "LONG",
    btc_regime: str = "NEUTRAL",
    btc_volatility_pct: float = 0.0,
    btc_trend_strength: float = 0.0,
    alt_btc_correlation: float = 0.0,
    symbol_momentum: float = 0.0,
    volume_ratio: float = 1.0,
    oi_change_pct: float = 0.0,
    spread_bps: float = 0.0,
    liquidity_score: float = 1.0,
    candle_context: dict[str, Any] | None = None,
    recent_pnl_by_setup: dict[str, Any] | None = None,
    symbol_rotation_state: str = "NEUTRAL",
    market_breadth: float = 0.5,
    funding_rate: float = 0.0,
    news_context: dict[str, Any] | None = None,
    operational_risk: dict[str, Any] | None = None,
    playbook_performance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Classify the current market regime and choose an execution playbook.

    Inputs are intentionally plain scalars/dicts so the engine can be called
    from live API context, tests, or future offline training jobs.
    """
    side = _upper(position_side, "LONG")
    btc = _upper(btc_regime, "NEUTRAL")
    candles = candle_context or {}
    news = news_context or {}
    risk = operational_risk or {}

    momentum_abs = abs(symbol_momentum)
    btc_strength_abs = abs(btc_trend_strength)
    spread = max(0.0, spread_bps)
    liquidity = _clamp(liquidity_score)
    volume_expanding = volume_ratio >= 1.35
    oi_not_against = oi_change_pct >= -0.5
    btc_aligned_long = btc in {"BULL", "BTC_TREND_UP"} or btc_trend_strength > 0.18
    btc_aligned_short = btc in {"BEAR", "BTC_TREND_DOWN"} or btc_trend_strength < -0.18
    btc_aligned = btc_aligned_long if side == "LONG" else btc_aligned_short
    btc_neutral = btc in {"NEUTRAL", "BTC_CHOP", "CHOP"} or btc_strength_abs < 0.12

    breakout_state = _upper((candles.get("1m") or {}).get("breakoutState"))
    five_breakout = _upper((candles.get("5m") or {}).get("breakoutState"))
    fifteen_breakout = _upper((candles.get("15m") or {}).get("breakoutState"))
    fakeout_risk = breakout_state == "FAKEOUT"
    breaks_range = breakout_state in {"BREAKOUT_UP", "BREAKOUT_DOWN"} or five_breakout in {
        "BREAKOUT_UP",
        "BREAKOUT_DOWN",
    }
    higher_trend_clear = fifteen_breakout in {"BREAKOUT_UP", "BREAKOUT_DOWN"} or btc_strength_abs >= 0.25
    pullback_zone = abs(_num((candles.get("1m") or {}).get("vwapDistancePct"), 0.0)) <= 0.18
    sweep_reversal = fakeout_risk or _upper((candles.get("1m") or {}).get("sweepState")) in {
        "SWEEP_HIGH_REJECT",
        "SWEEP_LOW_REJECT",
    }

    news_action = _upper(news.get("action"), "ALLOW")
    news_impact = _num(news.get("impactScore"), 0.0)
    news_risk = _upper(news.get("riskLevel"), "LOW")
    news_spike = news_action in {"REDUCE_AGGRESSION", "CONTEXT_ONLY"} and (
        news_impact >= 0.65 or news_risk in {"HIGH", "CRITICAL"}
    )

    drawdown_recovery = (
        _num(risk.get("maxDrawdownPct"), 0.0) >= 2.5
        or _num(risk.get("consecutiveLosses"), 0.0) >= 3
        or _num(risk.get("netPnlPct"), 0.0) <= -3.0
    )
    low_liquidity = spread >= 18 or liquidity < 0.35
    chaos = btc_volatility_pct >= 3.0 or (spread >= 12 and momentum_abs >= 0.9)
    alt_burst = (
        momentum_abs >= 0.55
        and volume_ratio >= 1.8
        and oi_not_against
        and spread <= 14
        and liquidity >= 0.45
    )
    btc_lead = btc_strength_abs >= 0.45 and alt_btc_correlation >= 0.55 and momentum_abs < btc_strength_abs
    chop = btc_neutral and btc_volatility_pct < 1.4 and not alt_burst

    if drawdown_recovery:
        regime = "RECOVERY_AFTER_DRAWDOWN"
    elif low_liquidity:
        regime = "LOW_LIQUIDITY"
    elif chaos:
        regime = "HIGH_VOLATILITY_CHAOS"
    elif news_spike:
        regime = "NEWS_SPIKE"
    elif alt_burst:
        regime = "ALT_MOMENTUM_BURST"
    elif btc_aligned_long and btc_trend_strength >= 0.18:
        regime = "BTC_TREND_UP"
    elif btc_aligned_short and btc_trend_strength <= -0.18:
        regime = "BTC_TREND_DOWN"
    elif chop:
        regime = "BTC_CHOP"
    else:
        regime = "BTC_CHOP"

    if regime in {"LOW_LIQUIDITY", "RECOVERY_AFTER_DRAWDOWN"}:
        playbook = "AVOID_MODE" if spread >= 25 or liquidity < 0.20 else "RANGE_QUICK_SCALP"
    elif regime == "HIGH_VOLATILITY_CHAOS":
        playbook = "AVOID_MODE" if not (alt_burst and volume_ratio >= 2.4) else "MOMENTUM_BREAKOUT_SCALP"
    elif regime == "NEWS_SPIKE":
        playbook = "MOMENTUM_BREAKOUT_SCALP" if alt_burst and breaks_range else "AVOID_MODE"
    elif btc_lead and btc_aligned:
        playbook = "BTC_LEAD_ALT_FOLLOW"
    elif sweep_reversal and volume_expanding and spread <= 12:
        playbook = "LIQUIDITY_SWEEP_REVERSAL"
    elif alt_burst and breaks_range and (btc_aligned or btc_neutral):
        playbook = "MOMENTUM_BREAKOUT_SCALP"
    elif higher_trend_clear and pullback_zone and btc_aligned:
        playbook = "PULLBACK_CONTINUATION"
    elif regime == "BTC_CHOP":
        playbook = "RANGE_QUICK_SCALP" if spread <= 8 and liquidity >= 0.55 else "AVOID_MODE"
    else:
        playbook = "MOMENTUM_BREAKOUT_SCALP" if alt_burst else "RANGE_QUICK_SCALP"

    allowed: list[str]
    blocked: list[str]
    if playbook == "MOMENTUM_BREAKOUT_SCALP":
        allowed = ["BREAKOUT_LONG", "FOLLOW_THROUGH_LONG"] if side == "LONG" else ["BREAKOUT_SHORT", "FOLLOW_THROUGH_SHORT"]
        blocked = ["MEAN_REVERSION_SHORT" if side == "LONG" else "MEAN_REVERSION_LONG"]
    elif playbook == "PULLBACK_CONTINUATION":
        allowed = ["PULLBACK_LONG", "CONTINUATION_LONG"] if side == "LONG" else ["PULLBACK_SHORT", "CONTINUATION_SHORT"]
        blocked = ["COUNTER_TREND_LONG" if side == "SHORT" else "COUNTER_TREND_SHORT"]
    elif playbook == "RANGE_QUICK_SCALP":
        allowed = ["RANGE_LONG", "RANGE_SHORT", "MEAN_REVERSION_LONG", "MEAN_REVERSION_SHORT"]
        blocked = ["WEAK_BREAKOUT_CHASE", "LATE_MOMENTUM_CHASE"]
    elif playbook == "LIQUIDITY_SWEEP_REVERSAL":
        allowed = ["SWEEP_REVERSAL_LONG", "SWEEP_REVERSAL_SHORT"]
        blocked = ["FOLLOW_THROUGH_AFTER_SWEEP"]
    elif playbook == "BTC_LEAD_ALT_FOLLOW":
        allowed = ["BTC_FOLLOW_LONG"] if side == "LONG" else ["BTC_FOLLOW_SHORT"]
        blocked = ["ALT_SOLO_COUNTER_TREND"]
    else:
        allowed = []
        blocked = [
            "BREAKOUT_LONG",
            "BREAKOUT_SHORT",
            "FOLLOW_THROUGH_LONG",
            "FOLLOW_THROUGH_SHORT",
            "WEAK_BREAKOUT_CHASE",
        ]

    score_adjustments = {
        "momentumBonus": 0.0,
        "volumeBonus": 0.0,
        "btcFollowBonus": 0.0,
        "rangeBonus": 0.0,
        "counterTrendPenalty": 0.0,
        "meanReversionPenalty": 0.0,
        "lowLiquidityPenalty": 0.0,
        "chaosPenalty": 0.0,
        "drawdownPenalty": 0.0,
        "minScoreBoost": 0.0,
    }
    if playbook == "MOMENTUM_BREAKOUT_SCALP":
        score_adjustments.update({"momentumBonus": 0.12, "volumeBonus": 0.08, "meanReversionPenalty": 0.14})
    elif playbook == "PULLBACK_CONTINUATION":
        score_adjustments.update({"momentumBonus": 0.06, "btcFollowBonus": 0.06, "counterTrendPenalty": 0.12})
    elif playbook == "RANGE_QUICK_SCALP":
        score_adjustments.update({"rangeBonus": 0.08, "momentumBonus": -0.03, "minScoreBoost": 0.03})
    elif playbook == "LIQUIDITY_SWEEP_REVERSAL":
        score_adjustments.update({"rangeBonus": 0.06, "counterTrendPenalty": 0.05})
    elif playbook == "BTC_LEAD_ALT_FOLLOW":
        score_adjustments.update({"btcFollowBonus": 0.12, "momentumBonus": 0.05, "counterTrendPenalty": 0.15})
    else:
        score_adjustments.update({"lowLiquidityPenalty": 0.12, "chaosPenalty": 0.10, "minScoreBoost": 0.16})

    if regime == "LOW_LIQUIDITY":
        score_adjustments["lowLiquidityPenalty"] = max(score_adjustments["lowLiquidityPenalty"], 0.12)
        score_adjustments["minScoreBoost"] = max(score_adjustments["minScoreBoost"], 0.10)
    if regime == "HIGH_VOLATILITY_CHAOS":
        score_adjustments["chaosPenalty"] = max(score_adjustments["chaosPenalty"], 0.14)
        score_adjustments["minScoreBoost"] = max(score_adjustments["minScoreBoost"], 0.12)
    if regime == "RECOVERY_AFTER_DRAWDOWN":
        score_adjustments["drawdownPenalty"] = 0.10
        score_adjustments["minScoreBoost"] = max(score_adjustments["minScoreBoost"], 0.08)
    if not btc_aligned and btc not in {"NEUTRAL", "BTC_CHOP", "CHOP"}:
        score_adjustments["counterTrendPenalty"] = max(score_adjustments["counterTrendPenalty"], 0.18)

    tp_sl = {
        "MOMENTUM_BREAKOUT_SCALP": (0.32, 0.42),
        "PULLBACK_CONTINUATION": (0.26, 0.34),
        "RANGE_QUICK_SCALP": (0.16, 0.24),
        "LIQUIDITY_SWEEP_REVERSAL": (0.22, 0.30),
        "BTC_LEAD_ALT_FOLLOW": (0.28, 0.38),
        "AVOID_MODE": (0.12, 0.18),
    }
    tp_pct, sl_pct = tp_sl[playbook]
    if regime == "ALT_MOMENTUM_BURST":
        tp_pct *= 1.18
    if regime in {"NEWS_SPIKE", "HIGH_VOLATILITY_CHAOS"}:
        sl_pct *= 0.85
    if regime == "LOW_LIQUIDITY":
        tp_pct *= 0.85

    max_positions = {
        "ALT_MOMENTUM_BURST": 8,
        "BTC_TREND_UP": 5,
        "BTC_TREND_DOWN": 5,
        "BTC_CHOP": 2,
        "NEWS_SPIKE": 3,
        "HIGH_VOLATILITY_CHAOS": 2,
        "LOW_LIQUIDITY": 1,
        "RECOVERY_AFTER_DRAWDOWN": 1,
    }[regime]
    stacking_bias = "ALLOW_IF_SCORE_STRONG"
    if regime == "ALT_MOMENTUM_BURST":
        stacking_bias = "ALLOW_AGGRESSIVE"
    elif regime in {"LOW_LIQUIDITY", "HIGH_VOLATILITY_CHAOS", "RECOVERY_AFTER_DRAWDOWN"}:
        stacking_bias = "LIMIT_OR_BLOCK"
    elif playbook == "RANGE_QUICK_SCALP":
        stacking_bias = "BLOCK_DEEP_STACKING"

    perf = _stats_from_performance(playbook_performance, playbook)
    if perf["trades"] < 10:
        size_multiplier = 0.45
        size_reason = "new_playbook_scout"
    elif perf["profitFactor"] is not None and _num(perf["profitFactor"], 0.0) >= 1.35:
        size_multiplier = 1.18
        size_reason = "historically_good_playbook"
    elif perf["winRate"] is not None and _num(perf["winRate"], 0.0) < 0.42:
        size_multiplier = 0.60
        size_reason = "recent_playbook_underperforming"
    else:
        size_multiplier = 1.0
        size_reason = "neutral_playbook_history"
    if regime in {"LOW_LIQUIDITY", "HIGH_VOLATILITY_CHAOS", "RECOVERY_AFTER_DRAWDOWN"}:
        size_multiplier = min(size_multiplier, 0.55)
        size_reason = f"{regime.lower()}_risk_reduction"
    if regime == "ALT_MOMENTUM_BURST" and volume_ratio >= 2.4 and momentum_abs >= 0.75:
        size_multiplier = max(size_multiplier, 1.12)
        size_reason = "validated_burst"

    confidence = 0.46
    confidence += min(0.18, momentum_abs * 0.16)
    confidence += min(0.14, max(0.0, volume_ratio - 1.0) * 0.08)
    confidence += 0.08 if btc_aligned else -0.06
    confidence += 0.06 if liquidity >= 0.6 and spread <= 10 else -0.07
    confidence += 0.05 if market_breadth >= 0.55 else -0.03
    confidence -= min(0.07, abs(funding_rate) * 120)
    if playbook == "AVOID_MODE":
        confidence = max(0.50, confidence)

    return {
        "regime": regime,
        "playbook": playbook,
        "allowedSetups": allowed,
        "blockedSetups": blocked,
        "scoreAdjustments": {k: round(v, 4) for k, v in score_adjustments.items() if abs(v) > 0.0001},
        "recommendedTpPct": round(tp_pct, 4),
        "recommendedSlPct": round(sl_pct, 4),
        "maxPositions": max_positions,
        "stackingBias": stacking_bias,
        "regimeConfidence": round(_clamp(confidence), 3),
        "playbookVersion": PLAYBOOK_VERSION,
        "sizing": {
            "sizeMultiplier": round(_clamp(size_multiplier, 0.25, 1.35), 3),
            "reason": size_reason,
            "history": perf,
        },
        "exitPolicy": {
            "letWinnerRun": playbook in {"MOMENTUM_BREAKOUT_SCALP", "BTC_LEAD_ALT_FOLLOW"},
            "quickTakeProfit": playbook == "RANGE_QUICK_SCALP",
            "tightTrailing": regime in {"NEWS_SPIKE", "HIGH_VOLATILITY_CHAOS"},
            "reduceTimeInPosition": regime == "LOW_LIQUIDITY",
            "breakevenFast": regime == "HIGH_VOLATILITY_CHAOS",
        },
        "context": {
            "symbol": symbol,
            "positionSide": side,
            "btcRegime": btc,
            "btcVolatilityPct": round(btc_volatility_pct, 4),
            "btcTrendStrength": round(btc_trend_strength, 4),
            "altBtcCorrelation": round(alt_btc_correlation, 4),
            "symbolMomentum": round(symbol_momentum, 4),
            "volumeRatio": round(volume_ratio, 4),
            "oiChangePct": round(oi_change_pct, 4),
            "spreadBps": round(spread, 4),
            "liquidityScore": round(liquidity, 4),
            "symbolRotationState": symbol_rotation_state,
            "marketBreadth": round(market_breadth, 4),
            "fundingRate": round(funding_rate, 8),
            "evaluatedAt": time.time(),
        },
    }

