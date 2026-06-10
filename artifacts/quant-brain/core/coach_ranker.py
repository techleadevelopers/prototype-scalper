"""
Coach Ranker — scores, ranks, and teaches the system.

Responsible for:
  • Receiving all cycle candidates and ranking them by execution priority
  • Computing aggressiveScore, learningScore, executionPriority per candidate
  • Applying SOFT penalties (never hard blocks — floor is 0.0)
  • Favouring setups with real momentum, volume/OI, candle alignment, fresh data
  • Penalizing bad setups without blocking early
  • Learning per symbol / side / regime / hour / context via the penalty signal

Scoring formula (demo_learning_aggressive primary):
  aggressiveScore = momentum(35%) + candle(20%) + volumeOI(15%)
                  + btcAlignment(10%) + freshData(10%)
                  + realizedEdge(5%) + shadowML(5%) − penalties

  learningScore   = blended aggressiveScore + realized-edge data as sample count grows
                  — 0-49 samples: pure aggressiveScore (learning phase)
                  — 50-149: 70% aggressive + 30% realized
                  — 150+:   50% aggressive + 50% realized

  executionPriority = aggressiveScore in demo_learning_aggressive
                    = learningScore   in balanced / conservative

The Coach NEVER blocks. Any situation that warrants blocking is the Judge's job.
"""
from __future__ import annotations

import os
from typing import Any
from core.score_calibration import calibrate_score


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value) if value is not None else fallback
    except Exception:
        return fallback


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _env_float(key: str, fallback: float) -> float:
    return _num(os.environ.get(key), fallback)


def _shadow_ml_authority(shadow_ml: dict) -> float:
    """
    Progressive ML authority. Cold/weak models keep the legacy 5% influence;
    calibrated, profitable models can ramp to 30% without disabling hard gates.
    """
    if not shadow_ml.get("available") or shadow_ml.get("calibratedProbability") is None:
        return 0.05

    min_weight = _clamp(_env_float("COACH_SHADOW_ML_MIN_WEIGHT", 0.05), 0.0, 0.30)
    max_weight = _clamp(_env_float("COACH_SHADOW_ML_MAX_WEIGHT", 0.30), min_weight, 0.40)
    samples = max(
        _num(shadow_ml.get("samples"), 0.0),
        _num(shadow_ml.get("trainingSamples"), 0.0),
        _num(shadow_ml.get("trainSamples"), 0.0) + _num(shadow_ml.get("testSamples"), 0.0),
    )
    brier = _num(shadow_ml.get("modelBrier"), _num(shadow_ml.get("brier"), 1.0))
    auc = _num(shadow_ml.get("rocAuc"), 0.5)
    profitable = bool(shadow_ml.get("profitabilityVerified", False))
    uncertainty = str(shadow_ml.get("uncertaintyType", "")).upper()

    sample_factor = _clamp((samples - 100.0) / 350.0, 0.0, 1.0)
    brier_factor = _clamp((0.22 - brier) / 0.10, 0.0, 1.0)
    auc_factor = _clamp((auc - 0.55) / 0.20, 0.0, 1.0)
    quality = 0.50 * sample_factor + 0.30 * brier_factor + 0.20 * auc_factor
    if profitable:
        quality = max(quality, 0.70)
    if uncertainty not in {"STRONG_EVIDENCE", "WEAK_EVIDENCE"}:
        quality *= 0.35

    return _clamp(min_weight + (max_weight - min_weight) * quality, min_weight, max_weight)


# ---------------------------------------------------------------------------
# Core scoring
# ---------------------------------------------------------------------------

def compute_aggressive_score(
    *,
    sniper: dict,
    signal_edge: dict,
    shadow_ml: dict,
    btc_regime: str,
    data_quality: dict,
    position_side: str,
    score_penalties: float = 0.0,
    score_adjustments: dict[str, Any] | None = None,
) -> float:
    """
    Momentum-first composite score [0, 1].

    Weights:
      momentum      35%  (sniper 0-1 score: price accel + RSI + spread)
      candle        20%  (candle pattern confirmation)
      volumeOI      15%  (volume ratio + OI change)
      btcAlignment  10%  (regime match; counter-regime penalised, not blocked)
      freshData     10%  (avg coverage across 1m/5m/BTC)
      realizedEdge   5%  (historical target-hit rate; neutral at cold start)
      shadowML       5%  (calibrated probability; neutral when model unavailable)
    """
    alt_features = sniper.get("altFeatures") or {}
    btc_features = sniper.get("btcFeatures") or {}
    adjustments = score_adjustments or {}

    # 1. Momentum
    momentum_score = max(0.0, min(1.0, float(sniper.get("score", 0.0))))
    momentum_score = max(0.0, min(1.0, momentum_score + _num(adjustments.get("momentumBonus"), 0.0)))

    # 2. Candle alignment
    candle_score = max(0.0, min(1.0, float(sniper.get("candleScore", momentum_score * 0.85))))

    # 3. Volume / OI
    volume_ratio = float(alt_features.get("volume_ratio", 1.0))
    oi_change_pct = float(alt_features.get("oi_change_pct", 0.0))
    volume_oi_score = min(1.0, max(0.0,
        0.50
        + min(0.30, (volume_ratio - 1.0) * 0.15)
        + min(0.20, abs(oi_change_pct) * 0.05)
    ))
    volume_oi_score = max(0.0, min(1.0, volume_oi_score + _num(adjustments.get("volumeBonus"), 0.0)))

    # 4. BTC alignment (counter-regime allowed, just lower score)
    want_long = position_side == "LONG"
    btc_price_change = float(btc_features.get("price_change_pct", 0.0))
    if btc_regime == "BULL" and want_long:
        btc_alignment = 0.80
    elif btc_regime == "BEAR" and not want_long:
        btc_alignment = 0.80
    elif btc_regime == "NEUTRAL":
        btc_alignment = 0.50
    else:
        btc_alignment = 0.38
    if abs(btc_price_change) > 0.5:
        btc_alignment = min(1.0, btc_alignment + 0.10)
    btc_alignment = max(0.0, min(1.0, btc_alignment + _num(adjustments.get("btcFollowBonus"), 0.0)))

    # 5. Data freshness
    coverages = [
        float((data_quality.get("alt1m") or {}).get("coveragePct", 0.0)),
        float((data_quality.get("alt5m") or {}).get("coveragePct", 0.0)),
        float((data_quality.get("btc1m") or {}).get("coveragePct", 0.0)),
    ]
    fresh_data_score = sum(coverages) / max(len(coverages), 1)

    # 6. Realized edge (neutral at cold start < 5 samples)
    edge_score = float(signal_edge.get("score", 0.5))
    edge_samples = int((signal_edge.get("symbolSide") or {}).get("samples", 0))
    realized_edge_score = 0.50 if edge_samples < 5 else max(0.0, min(1.0, edge_score))

    # 7. Shadow ML (neutral when no model yet)
    if shadow_ml.get("available") and shadow_ml.get("calibratedProbability") is not None:
        shadow_ml_score = max(0.0, min(1.0, float(shadow_ml["calibratedProbability"])))
    else:
        shadow_ml_score = 0.50

    shadow_ml_weight = _shadow_ml_authority(shadow_ml)
    traditional_weight = 1.0 - shadow_ml_weight
    traditional_score = (
        momentum_score        * 0.35
        + candle_score        * 0.20
        + volume_oi_score     * 0.15
        + btc_alignment       * 0.10
        + fresh_data_score    * 0.10
        + realized_edge_score * 0.10
    )
    raw = traditional_score * traditional_weight + shadow_ml_score * shadow_ml_weight
    playbook_bonus = _num(adjustments.get("rangeBonus"), 0.0)
    return max(0.0, min(1.0, raw + playbook_bonus - score_penalties))


def _soft_penalties(
    *,
    sniper: dict,
    signal_edge: dict,
    shadow_ml: dict,
    data_quality: dict,
    recommendation: dict,
    realized_sharpe: float,
    correlation_penalty: float,
    regime_confidence: float,
    ev_bootstrap: dict,
    net_ev_usdt: float,
    news_action: str,
    sentiment_counter: bool,
    sentiment_confidence: float,
    position_side: str,
    score_adjustments: dict[str, Any] | None = None,
) -> tuple[float, list[str]]:
    """
    Compute cumulative soft penalties [0, 0.80] and their reasons.
    No blocking here — just penalty accumulation.
    """
    penalties = 0.0
    reasons: list[str] = []
    adjustments = score_adjustments or {}

    def add(amount: float, reason: str) -> None:
        nonlocal penalties
        penalties += amount
        reasons.append(f"{reason}(-{amount:.3f})")

    # SNIPER_WAIT — momentum is inconclusive but not zero
    if sniper.get("decision") == "WAIT":
        add(0.08, "sniper_wait")

    # Sentiment counter-trend (was hard block in old code — now Coach penalty only)
    if sentiment_counter and sentiment_confidence >= 0.6:
        p = min(0.12, sentiment_confidence * 0.15)
        add(p, "sentiment_counter")

    # EV: 0-49 samples = pure learning, 50-149 = small penalty, 150+ = larger penalty
    # Fix 1 (Cold Start Protection): penalidade proporcional à confiança estatística.
    # Rampa suave: a(n) = min(1, (n-50)/100) → a=0 em n=50, a=1 em n≥150.
    # Evita que sequências ruins iniciais destruam ativos promissores antes dos
    # 150 samples necessários para evidência estatisticamente sólida.
    eff_stats = (
        signal_edge.get("context", {})
        if int((signal_edge.get("context") or {}).get("samples", 0)) >= int(signal_edge.get("minSamples", 8))
        else signal_edge.get("symbolSide", {})
    )
    ev_samples = int(eff_stats.get("samples", 0))
    if 50 <= ev_samples < 150 and net_ev_usdt < 0:
        _ev_confidence = min(1.0, (ev_samples - 50) / 100.0)  # 0→1 rampa
        p = min(0.12, abs(net_ev_usdt) * 0.30) * _ev_confidence
        if p > 0.005:  # threshold mínimo para evitar ruído
            add(p, f"ev_negative_emerging(n={ev_samples},conf={_ev_confidence:.2f})")
    # 150+ samples is handled by judge_high_sample_context (hard block there)

    # Signal context quality degraded
    # Fix 1: mínimo 50 samples (era 30) para declarar contexto tóxico com penalidade cheia
    se_samples = int((signal_edge.get("symbolSide") or {}).get("samples", 0))
    if signal_edge.get("verdict") == "toxic_context":
        if se_samples >= 50 and float(signal_edge.get("score", 1.0)) < 0.20:
            add(0.12, f"signal_context_toxic(n={se_samples})")
        elif se_samples >= 15:
            add(0.05, f"signal_context_weak(n={se_samples})")
        # < 15 samples: sem penalidade — insuficiente para determinar toxicidade

    # Realized edge degraded (50-149 samples range; 150+ is handled by Judge)
    rec_samples = int((recommendation.get("stats", {}).get("symbolSide", {}) or {}).get("samples", 0))
    if 50 <= rec_samples < 150 and not recommendation.get("shadowRecommendation"):
        realized_score = float(recommendation.get("score", 0.5))
        _rec_confidence = min(1.0, (rec_samples - 50) / 100.0)  # rampa 0→1
        p = max(0.0, (0.5 - realized_score) * 0.20) * _rec_confidence
        if p > 0.005:
            add(p, f"realized_edge_weak(n={rec_samples},conf={_rec_confidence:.2f})")

    # Low Sharpe — only meaningful after 25+ real trades
    if len(recommendation.get("returns", [])) >= 25 and realized_sharpe < 0.3:
        add(0.05, f"low_sharpe(sharpe={realized_sharpe:.2f})")

    # Low regime confidence
    if regime_confidence < 0.4:
        add(0.05, f"low_regime_conf(conf={regime_confidence:.2f})")

    # High toxicity (0.70-0.85; above 0.85 is Judge's hard block)
    micro = data_quality.get("alt1m", {}).get("microstructure", {})
    toxicity = float(micro.get("toxicity_score", 0.0))
    if 0.70 < toxicity <= 0.85:
        add(0.06, f"flow_toxicity(vpin={toxicity:.2f})")

    # Delta divergence
    dd = data_quality.get("alt1m", {}).get("deltaDivergence", {})
    if dd.get("divergence", False):
        add(0.05, "delta_divergence")

    # Structural break
    sb = data_quality.get("alt5m", {}).get("structuralBreak", {})
    if sb.get("break_detected", False):
        add(0.05, "structural_break")

    # Bootstrap EV confidence low (only after reliable threshold)
    if ev_bootstrap.get("reliable") and float(ev_bootstrap.get("ev_positive_confidence", 1.0)) < 0.8:
        add(0.05, "ev_bootstrap_low")

    # Correlation with open positions
    if correlation_penalty < 0.7:
        add(0.05, "correlation_penalty")

    # News — reduce aggression signal
    if news_action == "reduce_aggression":
        add(0.06, "news_risk")

    for key, label in (
        ("counterTrendPenalty", "playbook_counter_trend"),
        ("meanReversionPenalty", "playbook_mean_reversion"),
        ("lowLiquidityPenalty", "playbook_low_liquidity"),
        ("chaosPenalty", "playbook_chaos"),
        ("drawdownPenalty", "playbook_drawdown_recovery"),
    ):
        amount = _num(adjustments.get(key), 0.0)
        if amount > 0:
            add(min(0.20, amount), label)

    return min(penalties, 0.80), reasons


def score_candidate(
    *,
    symbol: str,
    position_side: str,
    risk_profile: str,
    sniper: dict,
    signal_edge: dict,
    shadow_ml: dict,
    btc_regime: str,
    data_quality: dict,
    recommendation: dict,
    operational_risk: dict,
    realized_sharpe: float,
    correlation_penalty: float,
    regime_confidence: float,
    ev_bootstrap: dict,
    net_ev_usdt: float,
    news_action: str = "allow",
    sentiment_counter: bool = False,
    sentiment_confidence: float = 0.0,
    sentiment_aligned: bool = False,
    regime_playbook: dict[str, Any] | None = None,
    score_calibration: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Score a single candidate. Never blocks — only adjusts rank.

    Returns:
      aggressiveScore     float [0, 1]  — momentum-first composite
      learningScore       float [0, 1]  — realized-edge blended as samples grow
      executionPriority   float [0, 1]  — final sort key for the cycle
      scorePenalties      float         — total soft penalty applied
      penaltyReasons      list[str]     — per-factor penalty breakdown
      learningBlend       str           — describes the blend regime
      coachVersion        str
    """
    is_aggressive = risk_profile in ("aggressive", "sniper_max", "demo_learning_aggressive")
    score_adjustments = (regime_playbook or {}).get("scoreAdjustments") or {}

    penalties, penalty_reasons = _soft_penalties(
        sniper=sniper,
        signal_edge=signal_edge,
        shadow_ml=shadow_ml,
        data_quality=data_quality,
        recommendation=recommendation,
        realized_sharpe=realized_sharpe,
        correlation_penalty=correlation_penalty,
        regime_confidence=regime_confidence,
        ev_bootstrap=ev_bootstrap,
        net_ev_usdt=net_ev_usdt,
        news_action=news_action,
        sentiment_counter=sentiment_counter,
        sentiment_confidence=sentiment_confidence,
        position_side=position_side,
        score_adjustments=score_adjustments,
    )

    aggressive_score = compute_aggressive_score(
        sniper=sniper,
        signal_edge=signal_edge,
        shadow_ml=shadow_ml,
        btc_regime=btc_regime,
        data_quality=data_quality,
        position_side=position_side,
        score_penalties=penalties,
        score_adjustments=score_adjustments,
    )

    # ── Learning score — blended as realized data accumulates ───────────────
    rec_samples = int((recommendation.get("stats", {}).get("symbolSide", {}) or {}).get("samples", 0))
    rec_score = float(recommendation.get("score", 0.5))

    if rec_samples < 50:
        # Fix 1: Bayesian smoothing toward neutral prior (0.50) at cold start.
        # Evita que sequências ruins iniciais destruam ativos antes de atingir
        # 50 amostras. À medida que amostras crescem, o peso do prior cai para 0.
        # prior_weight = (1 - n/50) * 0.25  → max 25% prior em n=0, zero em n≥50.
        _cold_start_prior_w = max(0.0, (1.0 - rec_samples / 50.0) * 0.25)
        learning_score = (1.0 - _cold_start_prior_w) * aggressive_score + _cold_start_prior_w * 0.50
        blend = f"cold_start_bayesian(n={rec_samples},prior={_cold_start_prior_w:.2f})"
    elif rec_samples < 150:
        w_real = 0.30
        learning_score = (1 - w_real) * aggressive_score + w_real * rec_score
        blend = f"blended_30pct(n={rec_samples})"
    else:
        w_real = 0.50
        learning_score = (1 - w_real) * aggressive_score + w_real * rec_score
        blend = f"realized_50pct(n={rec_samples})"
    learning_score = max(0.0, min(1.0, learning_score))

    # ── Execution priority — final sort key ─────────────────────────────────
    # demo_learning_aggressive: momentum is king → aggressiveScore
    # balanced / conservative: realized edge matters → learningScore
    base_priority = aggressive_score if is_aggressive else learning_score

    # Sentiment adjustment on priority (small signal boost/dampen, not blocking)
    if sentiment_aligned and sentiment_confidence > 0.3:
        base_priority = min(1.0, base_priority * (1.0 + sentiment_confidence * 0.12))
    elif sentiment_counter and sentiment_confidence > 0.3:
        base_priority = base_priority * (1.0 - sentiment_confidence * 0.08)
    execution_priority = max(0.0, min(1.0, base_priority))
    min_score_boost = _num(score_adjustments.get("minScoreBoost"), 0.0)
    if min_score_boost > 0:
        execution_priority = max(0.0, execution_priority - min(0.20, min_score_boost))
    calibrated_score = calibrate_score(execution_priority, score_calibration) if score_calibration else execution_priority
    calibration_actions: list[str] = []
    if score_calibration:
        truth = score_calibration.get("scoreTruth") or {}
        recommended = score_calibration.get("recommendedThresholds") or {}
        if truth.get("overconfidence") and execution_priority >= float(recommended.get("minBoostScore", 0.76)):
            calibration_actions.append("reduce_priority_overconfidence")
        if calibrated_score < execution_priority - 0.03:
            calibration_actions.append("use_calibrated_score_for_sizing")
        execution_priority = calibrated_score

    return {
        "aggressiveScore": round(aggressive_score, 4),
        "learningScore": round(learning_score, 4),
        "executionPriority": round(execution_priority, 4),
        "calibratedScore": round(calibrated_score, 4),
        "calibrationActions": calibration_actions,
        "scorePenalties": round(penalties, 4),
        "penaltyReasons": penalty_reasons,
        "learningBlend": blend,
        "regime": (regime_playbook or {}).get("regime"),
        "playbook": (regime_playbook or {}).get("playbook"),
        "allowedSetups": (regime_playbook or {}).get("allowedSetups", []),
        "blockedSetups": (regime_playbook or {}).get("blockedSetups", []),
        "scoreAdjustments": score_adjustments,
        "coachVersion": "coach-ranker-v2-playbook",
    }


def rank_candidates(candidates: list[dict]) -> list[dict]:
    """
    Sort a list of scored candidates by executionPriority descending.
    Each candidate must have a "coaching" sub-dict with "executionPriority".
    """
    return sorted(
        candidates,
        key=lambda c: float((c.get("coaching") or {}).get("executionPriority", 0.0)),
        reverse=True,
    )
