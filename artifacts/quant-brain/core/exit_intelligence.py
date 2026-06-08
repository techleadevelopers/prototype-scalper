"""
Sniper Exit Intelligence — evaluates open positions and recommends exit actions.

Runs during the demo monitor cycle. Receives position context from Node.js
and fetches current market data internally to make real-time decisions.

Actions
-------
  HOLD                  — keep position as-is
  MOVE_STOP_TO_BREAKEVEN — move stop to entry price (protect capital)
  TIGHTEN_STOP          — reduce stop distance (lock in partial profit)
  TAKE_PARTIAL          — book partial profit, reduce exposure
  CLOSE_NOW             — close position immediately
  LET_WINNER_RUN        — extend TP, momentum still expanding
  CANCEL_STACKING       — block new adds to this campaign
  ALLOW_STACKING        — green-light next add to this campaign

Protection levels
-----------------
  normal   — standard monitoring
  elevated — near TP or momentum weakening
  critical — near stop or momentum reversed
"""
from __future__ import annotations

import time
from typing import Any

from core.movement_sniper import evaluate_sniper_window
from layers.tactical import get_snapshot_history


def _num(v: Any, fallback: float = 0.0) -> float:
    try:
        return float(v) if v is not None else fallback
    except Exception:
        return fallback


def _expected_duration_sec(tp_pct: float, aggressive_score: float) -> float:
    """
    Rough estimate of how long a trade should take to reach TP.
    Tighter TP + higher quality score = faster resolution.
    """
    base = max(60.0, tp_pct * 180)
    quality_factor = max(0.5, 1.6 - min(1.0, aggressive_score))
    return base * quality_factor


def evaluate_exit(
    *,
    symbol: str,
    position_side: str,
    entry_price: float,
    current_price: float,
    unrealized_pnl_pct: float,
    age_seconds: float,
    tp_pct: float,
    sl_pct: float,
    mfe_pct: float,
    mae_pct: float,
    aggressive_score: float = 0.5,
    campaign_depth: int = 1,
    campaign_drawdown_pct: float = 0.0,
    btc_regime: str = "NEUTRAL",
    regime_playbook: dict[str, Any] | None = None,
    playbook: str | None = None,
) -> dict[str, Any]:
    """
    Evaluate an open position and recommend an exit action.

    Parameters
    ----------
    mfe_pct             Max Favorable Excursion as % of margin (positive)
    mae_pct             Max Adverse Excursion as % of margin (negative or 0)
    unrealized_pnl_pct  Current unrealized P&L as % of margin
    campaign_drawdown_pct  Current campaign drawdown as % of margin (negative = loss)
    """
    playbook_ctx = regime_playbook or {}
    active_playbook = str(playbook or playbook_ctx.get("playbook") or "").upper()
    active_regime = str(playbook_ctx.get("regime") or "").upper()
    exit_policy = playbook_ctx.get("exitPolicy") or {}

    # ── Current market momentum via QB internal data ─────────────────────────
    target_moves: dict[str, float] = {
        "configured": tp_pct,
        "0.5": 0.5,
        "1.0": 1.0,
        "2.0": 2.0,
    }
    alt_history = get_snapshot_history(symbol, 900)
    btc_history = get_snapshot_history("BTC-USDT", 900)
    sniper: dict[str, Any] = evaluate_sniper_window(
        symbol, alt_history, btc_history, target_moves_pct=target_moves
    )

    momentum_score = _num(sniper.get("score"), 0.5)
    sniper_decision = str(sniper.get("decision") or "HOLD")

    # Spread from nested feature keys
    alt_features = sniper.get("altFeatures") or {}
    spread_bps = _num(alt_features.get("spread_bps")) or _num(
        ((sniper.get("altTimeframes") or {}).get("1m") or {}).get("spread_bps")
    )
    spread_spike = spread_bps > 30  # >30 bps = abnormal spread

    # ── Momentum alignment with position ─────────────────────────────────────
    want_long = position_side.upper() == "LONG"
    momentum_aligned = (
        (sniper_decision == "ALLOW_LONG" and want_long)
        or (sniper_decision == "ALLOW_SHORT" and not want_long)
    )
    momentum_reversed = (
        (sniper_decision == "ALLOW_LONG" and not want_long)
        or (sniper_decision == "ALLOW_SHORT" and want_long)
        or sniper_decision.startswith("BLOCK_")
    )
    momentum_waning = sniper_decision == "WAIT" or (
        momentum_score < 0.35 and not momentum_aligned
    )

    # ── Derived ratios ────────────────────────────────────────────────────────
    gave_back_pct = max(0.0, mfe_pct - unrealized_pnl_pct)
    gave_back_ratio = gave_back_pct / mfe_pct if mfe_pct > 0 else 0.0
    pnl_vs_tp = unrealized_pnl_pct / tp_pct if tp_pct > 0 else 0.0
    mfe_vs_tp = mfe_pct / tp_pct if tp_pct > 0 else 0.0
    expected_dur = _expected_duration_sec(tp_pct, aggressive_score)
    if active_playbook == "RANGE_QUICK_SCALP":
        expected_dur *= 0.65
    if active_regime == "LOW_LIQUIDITY" or exit_policy.get("reduceTimeInPosition"):
        expected_dur *= 0.55
    if active_regime == "NEWS_SPIKE":
        expected_dur *= 0.70
    age_ratio = age_seconds / max(expected_dur, 60)

    # ── Defaults ─────────────────────────────────────────────────────────────
    action = "HOLD"
    confidence = 0.50
    reason = "hold_monitoring"
    suggested_stop = sl_pct
    suggested_tp = tp_pct
    should_close = False
    protection_level = "normal"
    tp_rationale = "no_change"

    # =========================================================================
    # DECISION TREE  (evaluated top-to-bottom; first match wins)
    # =========================================================================

    # 1. CRITICAL — Gave back > 55 % of peak (and peak was meaningful)
    if active_regime == "LOW_LIQUIDITY" and age_ratio > 1.1 and unrealized_pnl_pct <= 0:
        action = "CLOSE_NOW"
        confidence = 0.82
        reason = "low_liquidity_time_risk"
        should_close = True
        protection_level = "critical"

    elif active_regime == "HIGH_VOLATILITY_CHAOS" and pnl_vs_tp >= 0.35:
        action = "MOVE_STOP_TO_BREAKEVEN"
        confidence = 0.82
        reason = "chaos_breakeven_fast"
        suggested_stop = 0.0
        protection_level = "elevated"
        tp_rationale = "chaos_fast_breakeven"

    elif active_regime == "NEWS_SPIKE" and mfe_vs_tp >= 0.35 and (momentum_waning or spread_spike):
        action = "TIGHTEN_STOP"
        confidence = 0.78
        reason = "news_spike_tight_trailing"
        suggested_stop = max(0.02, sl_pct * 0.35)
        protection_level = "elevated"
        tp_rationale = "news_tight_trailing"

    elif active_playbook == "RANGE_QUICK_SCALP" and pnl_vs_tp >= 0.82:
        action = "CLOSE_NOW"
        confidence = 0.80
        reason = "range_scalp_take_profit_fast"
        should_close = True
        protection_level = "elevated"
        tp_rationale = "range_fast_tp"

    elif mfe_vs_tp >= 0.80 and gave_back_ratio > 0.55:
        action = "CLOSE_NOW"
        confidence = 0.88
        reason = "gave_back_too_much_from_peak"
        should_close = True
        protection_level = "critical"

    # 2. CRITICAL — Timeout: 15 min with no edge and currently losing
    elif age_seconds > 900 and mfe_vs_tp < 0.12 and unrealized_pnl_pct <= 0:
        action = "CLOSE_NOW"
        confidence = 0.85
        reason = "timeout_no_edge"
        should_close = True
        protection_level = "critical"

    # 3. CRITICAL — Momentum fully reversed while already near stop
    elif momentum_reversed and unrealized_pnl_pct < -(sl_pct * 0.60):
        action = "CLOSE_NOW"
        confidence = 0.80
        reason = "momentum_reversed_near_stop"
        should_close = True
        protection_level = "critical"

    # 4. CRITICAL — Approaching SL with candle/direction confirmed against us
    elif unrealized_pnl_pct <= -(sl_pct * 0.72) and momentum_reversed:
        action = "CLOSE_NOW"
        confidence = 0.75
        reason = "near_stop_momentum_reversed"
        should_close = True
        protection_level = "critical"

    # 5. PROTECTION — ≥70 % of TP reached: lock in with breakeven stop
    elif pnl_vs_tp >= 0.70:
        action = "MOVE_STOP_TO_BREAKEVEN"
        confidence = 0.84
        reason = "near_tp_protect_capital"
        suggested_stop = 0.0  # breakeven = entry price
        protection_level = "elevated"
        tp_rationale = "protect_near_tp"

    # 6. PROTECTION — ≥50 % of TP + spread spike
    elif pnl_vs_tp >= 0.50 and spread_spike:
        action = "TIGHTEN_STOP"
        confidence = 0.72
        reason = "near_tp_spread_spike"
        suggested_stop = max(0.02, sl_pct * 0.40)
        protection_level = "elevated"
        tp_rationale = "tighten_spread_risk"

    # 7. PROTECTION — MFE ≥50 % of TP and momentum now waning/reversed
    elif mfe_vs_tp >= 0.50 and (momentum_waning or momentum_reversed):
        action = "TIGHTEN_STOP"
        confidence = 0.74
        reason = "peak_momentum_waning"
        suggested_stop = max(0.02, sl_pct * 0.45)
        protection_level = "elevated"
        tp_rationale = "lock_partial_gain"

    # 8. PROTECTION — Position aged beyond 1.5× expected and momentum stalled
    elif age_ratio > 1.5 and momentum_score < 0.30 and unrealized_pnl_pct > 0:
        action = "TIGHTEN_STOP"
        confidence = 0.65
        reason = "aged_position_momentum_stalled"
        suggested_stop = max(0.02, sl_pct * 0.50)
        protection_level = "elevated"
        tp_rationale = "time_exit_protection"

    # 9. PARTIAL TAKE — Near TP with deep campaign (≥3 stacks)
    elif pnl_vs_tp >= 0.65 and campaign_depth >= 3:
        action = "TAKE_PARTIAL"
        confidence = 0.67
        reason = "near_tp_campaign_depth_high"
        protection_level = "elevated"
        tp_rationale = "reduce_campaign_exposure"

    # 10. LET WINNER RUN — High quality setup, momentum still expanding
    elif (
        aggressive_score >= (0.70 if active_playbook in {"MOMENTUM_BREAKOUT_SCALP", "BTC_LEAD_ALT_FOLLOW"} else 0.75)
        and momentum_score >= 0.68
        and momentum_aligned
        and pnl_vs_tp < 0.55
        and not spread_spike
        and age_seconds < expected_dur * 0.80
        and active_playbook != "RANGE_QUICK_SCALP"
    ):
        action = "LET_WINNER_RUN"
        confidence = 0.62
        reason = "high_quality_momentum_expanding"
        suggested_tp = round(
            tp_pct * (1.45 if active_playbook in {"MOMENTUM_BREAKOUT_SCALP", "BTC_LEAD_ALT_FOLLOW"} else 1.35),
            4,
        )
        protection_level = "normal"
        tp_rationale = "extend_winner"

    # =========================================================================
    # STACKING decision (evaluated independently of main action)
    # =========================================================================
    should_stack = True
    stacking_action: str | None = None

    if campaign_drawdown_pct < -(sl_pct * 1.20):
        should_stack = False
        stacking_action = "CANCEL_STACKING"
    elif active_regime in {"HIGH_VOLATILITY_CHAOS", "LOW_LIQUIDITY", "RECOVERY_AFTER_DRAWDOWN"}:
        should_stack = False
        stacking_action = "CANCEL_STACKING"
    elif active_playbook == "RANGE_QUICK_SCALP" and campaign_depth >= 2:
        should_stack = False
        stacking_action = "CANCEL_STACKING"
    elif momentum_reversed or momentum_score < 0.28:
        should_stack = False
        stacking_action = "CANCEL_STACKING"
    elif campaign_depth >= 4:
        should_stack = False
        stacking_action = "CANCEL_STACKING"
    elif unrealized_pnl_pct > 0 and momentum_aligned and campaign_depth < 3:
        stacking_action = "ALLOW_STACKING"
    elif mfe_vs_tp > 0.25 and momentum_score >= 0.55 and campaign_depth < 3:
        stacking_action = "ALLOW_STACKING"

    # Main action can override stacking
    if action == "CANCEL_STACKING":
        should_stack = False
        stacking_action = "CANCEL_STACKING"
    elif action == "ALLOW_STACKING":
        should_stack = True
        stacking_action = "ALLOW_STACKING"

    return {
        "action": action,
        "confidence": round(confidence, 3),
        "reason": reason,
        "suggestedStopPct": round(suggested_stop, 4),
        "suggestedTakeProfitPct": round(suggested_tp, 4),
        "shouldClose": should_close,
        "shouldStack": should_stack,
        "stackingAction": stacking_action,
        "protectionLevel": protection_level,
        "adaptiveTpSl": {
            "tpPct": round(suggested_tp, 4),
            "slPct": round(suggested_stop, 4),
            "rationale": tp_rationale,
        },
        "context": {
            "momentumScore": round(momentum_score, 3),
            "sniperDecision": sniper_decision,
            "momentumAligned": momentum_aligned,
            "momentumReversed": momentum_reversed,
            "momentumWaning": momentum_waning,
            "spreadBps": round(spread_bps, 1),
            "spreadSpike": spread_spike,
            "pnlVsTp": round(pnl_vs_tp, 3),
            "mfeVsTp": round(mfe_vs_tp, 3),
            "gaveBackRatio": round(gave_back_ratio, 3),
            "ageRatio": round(age_ratio, 3),
            "expectedDurationSec": round(expected_dur, 1),
            "regime": active_regime or None,
            "playbook": active_playbook or None,
        },
        "version": "exit-intelligence-v2-playbook",
        "evaluatedAt": time.time(),
    }
