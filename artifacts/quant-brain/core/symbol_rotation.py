"""
Adaptive Symbol Rotation.

Ranks allowed symbols so sniper execution concentrates on pairs with the best
recent payout, execution quality, momentum, and side-specific edge.
"""
from __future__ import annotations

from typing import Any


WINDOWS = {
    "momentum": "15m",
    "execution": "1h",
    "tactical": "4h",
    "stability": "24h",
}


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value) if value is not None else fallback
    except Exception:
        return fallback


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _state(
    *,
    score: float,
    profit_factor: float,
    samples_4h: int,
    samples_24h: int,
    execution_quality: float,
    momentum: float,
    drawdown_penalty: float,
    slippage_penalty: float,
    toxic_penalty: float,
    recent_pnl: float,
) -> str:
    severe_penalty = drawdown_penalty + slippage_penalty + toxic_penalty
    if samples_24h >= 8 and recent_pnl < 0 and (drawdown_penalty >= 0.22 or toxic_penalty >= 0.18 or severe_penalty >= 0.35):
        return "PAUSED"
    if samples_4h >= 4 and recent_pnl < 0 and score < 0.42:
        return "RECOVERY"
    if samples_4h >= 4 and profit_factor >= 1.6 and execution_quality >= 0.65 and momentum >= 0.60 and score >= 0.70:
        return "HOT"
    if score < 0.45 or slippage_penalty >= 0.16:
        return "REDUCED"
    return "ACTIVE"


def _max_positions(state: str, default_max: int = 2) -> int:
    if state == "HOT":
        return max(default_max, 5)
    if state == "ACTIVE":
        return max(default_max, 3)
    if state in {"REDUCED", "RECOVERY"}:
        return 1
    return 0


def _side_bias(long_score: float, short_score: float) -> str:
    if long_score > short_score + 0.08:
        return "LONG"
    if short_score > long_score + 0.08:
        return "SHORT"
    return "NEUTRAL"


def _reason(state: str, side_bias: str, avg_slippage_bps: float, valid_signal_rate: float) -> str:
    if state == "PAUSED":
        return "paused_recent_drawdown_or_toxic_execution"
    if state == "RECOVERY":
        return "recovery_after_weak_recent_performance"
    if state == "HOT":
        return "high_recent_pf_low_slippage"
    if avg_slippage_bps > 8:
        return "reduced_elevated_slippage"
    if valid_signal_rate < 0.45:
        return "reduced_low_valid_signal_rate"
    if side_bias != "NEUTRAL":
        return f"active_{side_bias.lower()}_side_bias"
    return "active_balanced_rotation"


def rank_symbols(
    *,
    allowed_symbols: list[str],
    performance: dict[str, dict[str, Any]] | None = None,
    market: dict[str, dict[str, Any]] | None = None,
    open_positions: dict[str, int] | None = None,
    default_max_positions: int = 2,
) -> dict[str, Any]:
    """
    Build the rotation contract.

    performance[symbol] may contain:
      recentPnlUsdt, pnl24hUsdt, profitFactor4h, winRate4h, coachScoreAvg,
      executionQualityScore, avgSlippageBps, drawdownUsdt, toxicContextScore,
      validSignalRate, longScore, shortScore, samples4h, samples24h

    market[symbol] may contain:
      currentMomentumScore, liquidityScore, spreadScore, volumeRatio
    """
    performance = performance or {}
    market = market or {}
    open_positions = open_positions or {}
    ranking: list[dict[str, Any]] = []

    for raw_symbol in allowed_symbols:
        symbol = str(raw_symbol).upper()
        perf = performance.get(symbol, {})
        mkt = market.get(symbol, {})

        recent_pnl = _num(perf.get("recentPnlUsdt"))
        profit_factor = _num(perf.get("profitFactor4h"), 1.0)
        coach_score = _clamp(_num(perf.get("coachScoreAvg"), 0.5))
        execution_quality = _clamp(_num(perf.get("executionQualityScore"), 0.65))
        momentum = _clamp(_num(mkt.get("currentMomentumScore"), _num(mkt.get("momentumScore"), 0.5)))
        liquidity = _clamp(_num(mkt.get("liquidityScore"), _num(mkt.get("volumeRatio"), 1.0) / 2.5))
        drawdown = max(0.0, _num(perf.get("drawdownUsdt")))
        avg_slippage_bps = max(0.0, _num(perf.get("avgSlippageBps")))
        toxic_context = _clamp(_num(perf.get("toxicContextScore"), 0.0))
        valid_signal_rate = _clamp(_num(perf.get("validSignalRate"), coach_score))

        recent_pnl_score = _clamp(0.5 + recent_pnl / 20.0)
        pf_score = _clamp(profit_factor / 2.5)
        drawdown_penalty = _clamp(drawdown / 20.0) * 0.25
        slippage_penalty = _clamp(avg_slippage_bps / 18.0) * 0.20
        toxic_penalty = _clamp((toxic_context - 0.60) / 0.40) * 0.22 if toxic_context >= 0.70 else 0.0

        rotation_score = _clamp(
            recent_pnl_score * 0.25
            + pf_score * 0.20
            + coach_score * 0.20
            + execution_quality * 0.15
            + momentum * 0.10
            + liquidity * 0.10
            - drawdown_penalty
            - slippage_penalty
            - toxic_penalty
        )

        long_score = _clamp(_num(perf.get("longScore"), coach_score))
        short_score = _clamp(_num(perf.get("shortScore"), coach_score))
        side_bias = _side_bias(long_score, short_score)
        state = _state(
            score=rotation_score,
            profit_factor=profit_factor,
            samples_4h=int(_num(perf.get("samples4h"), 0)),
            samples_24h=int(_num(perf.get("samples24h"), 0)),
            execution_quality=execution_quality,
            momentum=momentum,
            drawdown_penalty=drawdown_penalty,
            slippage_penalty=slippage_penalty,
            toxic_penalty=toxic_penalty,
            recent_pnl=recent_pnl,
        )

        ranking.append({
            "symbol": symbol,
            "state": state,
            "sideBias": side_bias,
            "longScore": round(long_score, 4),
            "shortScore": round(short_score, 4),
            "rotationScore": round(rotation_score, 4),
            "allocationWeight": 0.0,
            "maxPositions": _max_positions(state, default_max_positions),
            "currentOpenPositions": int(open_positions.get(symbol, 0)),
            "recommendedPosition": (
                "increase" if state == "HOT"
                else "normal" if state == "ACTIVE"
                else "small" if state in {"REDUCED", "RECOVERY"}
                else "none"
            ),
            "reason": _reason(state, side_bias, avg_slippage_bps, valid_signal_rate),
            "windows": WINDOWS,
            "metrics": {
                "recentPnlUsdt": round(recent_pnl, 4),
                "pnl24hUsdt": round(_num(perf.get("pnl24hUsdt")), 4),
                "winRate4h": round(_clamp(_num(perf.get("winRate4h"), 0.5)), 4),
                "profitFactor4h": round(min(profit_factor, 99.0), 3),
                "coachScoreAvg": round(coach_score, 4),
                "executionQualityScore": round(execution_quality, 4),
                "currentMomentumScore": round(momentum, 4),
                "liquidityScore": round(liquidity, 4),
                "validSignalRate": round(valid_signal_rate, 4),
                "drawdownUsdt": round(drawdown, 4),
                "avgSlippageBps": round(avg_slippage_bps, 2),
                "toxicContextScore": round(toxic_context, 4),
            },
        })

    ranking.sort(key=lambda item: item["rotationScore"], reverse=True)
    allocatable = [item for item in ranking if item["state"] != "PAUSED" and item["maxPositions"] > 0]
    total_score = sum(max(0.05, item["rotationScore"]) for item in allocatable)
    if total_score > 0:
        for item in allocatable:
            item["allocationWeight"] = round(max(0.05, item["rotationScore"]) / total_score, 4)

    return {
        "activeSymbols": [item["symbol"] for item in ranking if item["state"] in {"HOT", "ACTIVE"}],
        "reducedSymbols": [item["symbol"] for item in ranking if item["state"] in {"REDUCED", "RECOVERY"}],
        "pausedSymbols": [item["symbol"] for item in ranking if item["state"] == "PAUSED"],
        "ranking": ranking,
    }
