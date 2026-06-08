"""
Sniper Exit Learning — post-trade quality classification and outcome recording.

Classifies each exit into a quality label that feeds the Coach Ranker,
teaching the system not just where to enter, but how and when to exit.

Exit Quality Labels
-------------------
  PERFECT_EXIT   closed near the optimal exit point (≥85 % of TP)
  EARLY_EXIT     closed profitably but momentum continued significantly
  LATE_EXIT      gave back > 40 % of MFE peak before closing
  BAD_ENTRY      never had meaningful favorable excursion
  STOP_TOO_WIDE  adverse excursion much larger than stop suggested
  TP_TOO_SHORT   TP was hit but price continued ≥ 60 % further
  TIMEOUT_BAD    timed out in flat/losing position
  NORMAL_EXIT    standard close, no strong quality signal
"""
from __future__ import annotations

import time
from typing import Any

from core import knowledge_base as kb


def classify_exit_quality(
    *,
    pnl_pct: float,
    mfe_pct: float,
    mae_pct: float,
    tp_pct: float,
    sl_pct: float,
    exit_reason: str,
    age_seconds: float,
    expected_duration_sec: float = 300,
) -> str:
    """
    Classify the quality of a closed trade based on excursion and outcome metrics.

    Parameters
    ----------
    mae_pct  Pass as positive magnitude (abs value), or the function takes abs internally.
    """
    mae_abs = abs(mae_pct)
    gave_back_pct = max(0.0, mfe_pct - pnl_pct)
    reason_up = exit_reason.upper()

    # PERFECT_EXIT — closed within 85 % of the configured TP
    if pnl_pct >= tp_pct * 0.85:
        return "PERFECT_EXIT"

    # BAD_ENTRY — MFE never exceeded 15 % of TP (entry had no edge)
    if mfe_pct < tp_pct * 0.15:
        if reason_up in ("SL", "SL_HIT"):
            return "BAD_ENTRY"
        if age_seconds > expected_duration_sec and pnl_pct <= 0:
            return "BAD_ENTRY"

    # TIMEOUT_BAD — held way too long without edge, ended flat or losing
    if (
        reason_up in ("TIMEOUT", "MANUAL", "CLOSE_NOW")
        and age_seconds > expected_duration_sec * 1.8
        and pnl_pct <= 0
    ):
        return "TIMEOUT_BAD"

    # STOP_TOO_WIDE — adverse excursion was ≥ 140 % of the configured SL
    if reason_up in ("SL", "SL_HIT") and mae_abs > sl_pct * 1.40:
        return "STOP_TOO_WIDE"

    # LATE_EXIT — gave back more than 40 % of the MFE peak
    if pnl_pct > 0 and mfe_pct > tp_pct * 0.30 and gave_back_pct > mfe_pct * 0.40:
        return "LATE_EXIT"

    # TP_TOO_SHORT — hit TP but MFE kept going ≥ 60 % beyond TP
    if reason_up in ("TP", "TP_HIT") and mfe_pct > tp_pct * 1.60:
        return "TP_TOO_SHORT"

    # EARLY_EXIT — closed in profit but MFE was ≥ 50 % higher than final close
    if pnl_pct > 0 and mfe_pct > pnl_pct * 1.50 and reason_up in ("MANUAL", "CLOSE_NOW"):
        return "EARLY_EXIT"

    return "NORMAL_EXIT"


async def record_exit_outcome(
    *,
    source_id: str,
    symbol: str,
    side: str,
    is_demo: bool = True,
    entry_price: float = 0.0,
    exit_price: float = 0.0,
    pnl_pct: float,
    mfe_pct: float,
    mae_pct: float,
    age_seconds: float,
    tp_pct: float,
    sl_pct: float,
    exit_reason: str,
    exit_action_taken: str = "",
    entry_aggressive_score: float = 0.0,
    btc_regime: str = "NEUTRAL",
    hour_utc: int = 0,
    campaign_id: str = "",
    expected_duration_sec: float = 300,
) -> dict[str, Any]:
    """
    Classify and persist a post-trade exit outcome.
    Returns the quality label and ancillary stats.
    """
    gave_back_pct = max(0.0, mfe_pct - pnl_pct)

    exit_quality = classify_exit_quality(
        pnl_pct=pnl_pct,
        mfe_pct=mfe_pct,
        mae_pct=mae_pct,
        tp_pct=tp_pct,
        sl_pct=sl_pct,
        exit_reason=exit_reason,
        age_seconds=age_seconds,
        expected_duration_sec=expected_duration_sec,
    )

    await kb.record_exit_outcome_row(
        source_id=source_id,
        symbol=symbol,
        side=side,
        is_demo=1 if is_demo else 0,
        entry_price=entry_price,
        exit_price=exit_price,
        pnl_pct=pnl_pct,
        mfe_pct=mfe_pct,
        mae_pct=mae_pct,
        gave_back_pct=gave_back_pct,
        age_seconds=age_seconds,
        tp_pct=tp_pct,
        sl_pct=sl_pct,
        exit_quality=exit_quality,
        exit_reason=exit_reason,
        exit_action_taken=exit_action_taken,
        entry_aggressive_score=entry_aggressive_score,
        btc_regime=btc_regime,
        hour_utc=hour_utc,
        campaign_id=campaign_id,
    )

    return {
        "exitQuality": exit_quality,
        "gaveBackPct": round(gave_back_pct, 4),
        "sourceId": source_id,
        "symbol": symbol,
        "side": side,
    }


async def record_exit_evaluation(
    *,
    source_id: str,
    symbol: str,
    side: str,
    action: str,
    confidence: float,
    reason: str,
    suggested_stop_pct: float,
    suggested_tp_pct: float,
    should_close: bool,
    should_stack: bool,
    protection_level: str,
    unrealized_pnl_pct: float,
    mfe_pct: float,
    age_seconds: float,
    momentum_score: float,
) -> None:
    """Store a QB exit recommendation for later outcome correlation."""
    await kb.record_exit_evaluation_row(
        source_id=source_id,
        symbol=symbol,
        side=side,
        action=action,
        confidence=confidence,
        reason=reason,
        suggested_stop_pct=suggested_stop_pct,
        suggested_tp_pct=suggested_tp_pct,
        should_close=1 if should_close else 0,
        should_stack=1 if should_stack else 0,
        protection_level=protection_level,
        unrealized_pnl_pct=unrealized_pnl_pct,
        mfe_pct=mfe_pct,
        age_seconds=age_seconds,
        momentum_score=momentum_score,
    )


async def get_exit_stats(
    symbol: str | None = None,
    side: str | None = None,
    days: int = 30,
) -> dict[str, Any]:
    """
    Exit quality analytics — win-rate / PnL / MFE averages by action and label.
    Feeds the Coach Ranker learning signal.
    """
    return await kb.query_exit_stats(symbol=symbol, side=side, days=days)
