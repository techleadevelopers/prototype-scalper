from __future__ import annotations

import math
import time
from collections import defaultdict
from typing import Any


BUCKETS: tuple[tuple[float, float | None, str], ...] = (
    (0.50, 0.55, "0.50-0.55"),
    (0.55, 0.60, "0.55-0.60"),
    (0.60, 0.65, "0.60-0.65"),
    (0.65, 0.70, "0.65-0.70"),
    (0.70, 0.75, "0.70-0.75"),
    (0.75, 0.80, "0.75-0.80"),
    (0.80, 0.85, "0.80-0.85"),
    (0.85, 0.90, "0.85-0.90"),
    (0.90, None, "0.90+"),
)

MIN_SCORE = 0.50


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else fallback
    except Exception:
        return fallback


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value)) if math.isfinite(value) else lo


def _round(value: float | None, digits: int = 6) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def _bucket_label(score: float) -> str | None:
    if score < MIN_SCORE:
        return None
    for lower, upper, label in BUCKETS:
        if score >= lower and (upper is None or score < upper):
            return label
    return None


def _profit_factor(values: list[float]) -> float | None:
    gross_profit = sum(value for value in values if value > 0)
    gross_loss = abs(sum(value for value in values if value < 0))
    if gross_loss <= 0:
        return None if gross_profit <= 0 else 999.0
    return gross_profit / gross_loss


def _learning_strength(samples: int) -> dict[str, Any]:
    if samples < 50:
        return {"level": "OBSERVE", "canAutoAdjust": False, "multiplier": 0.0}
    if samples < 150:
        return {"level": "WEAK", "canAutoAdjust": False, "multiplier": 0.25}
    if samples < 500:
        return {"level": "MODERATE", "canAutoAdjust": True, "multiplier": 0.60}
    return {"level": "CONFIDENT", "canAutoAdjust": True, "multiplier": 1.0}


def _quality(ece: float | None, monotonicity: float, samples: int) -> str:
    if samples < 50:
        return "INSUFFICIENT_DATA"
    if ece is not None and ece <= 0.05 and monotonicity >= 0.75:
        return "GOOD"
    if ece is not None and ece <= 0.10 and monotonicity >= 0.55:
        return "OK"
    if ece is not None and ece > 0.16:
        return "BAD"
    return "WEAK"


def _bucket_metrics(rows: list[dict[str, Any]], score_field: str) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {label: [] for _, _, label in BUCKETS}
    for row in rows:
        label = _bucket_label(_num(row.get(score_field), -1.0))
        if label:
            grouped[label].append(row)

    result: list[dict[str, Any]] = []
    for lower, upper, label in BUCKETS:
        bucket_rows = grouped[label]
        pnl = [_num(row.get("realizedPnl"), 0.0) for row in bucket_rows]
        wins = [value > 0 for value in pnl]
        exit_reasons = [str(row.get("exitReason") or "").upper() for row in bucket_rows]
        scores = [_num(row.get(score_field), 0.0) for row in bucket_rows]
        actual_wr = sum(1 for win in wins if win) / len(bucket_rows) if bucket_rows else 0.0
        expected_wr = sum(scores) / len(scores) if scores else (lower if upper is None else (lower + upper) / 2)
        slippage = [_num(row.get("slippageBps"), 0.0) for row in bucket_rows]
        latency = [_num(row.get("latencyDragUsdt"), 0.0) for row in bucket_rows]
        result.append({
            "bucket": label,
            "lower": lower,
            "upper": upper,
            "trades": len(bucket_rows),
            "winRate": _round(actual_wr, 6),
            "pnlUsdt": _round(sum(pnl), 6),
            "avgPnl": _round(sum(pnl) / len(pnl), 6) if pnl else 0.0,
            "profitFactor": _round(_profit_factor(pnl), 6),
            "tpHitRate": _round(sum(1 for reason in exit_reasons if "TP" in reason) / len(bucket_rows), 6) if bucket_rows else 0.0,
            "slHitRate": _round(sum(1 for reason in exit_reasons if "SL" in reason or "STOP" in reason) / len(bucket_rows), 6) if bucket_rows else 0.0,
            "avgMfe": _round(sum(_num(row.get("mfePct"), _num(row.get("mfe"), 0.0)) for row in bucket_rows) / len(bucket_rows), 6) if bucket_rows else 0.0,
            "avgMae": _round(sum(_num(row.get("maePct"), _num(row.get("mae"), 0.0)) for row in bucket_rows) / len(bucket_rows), 6) if bucket_rows else 0.0,
            "executionDrag": _round(sum(slippage) / len(slippage), 6) if slippage else 0.0,
            "latencyDragUsdt": _round(sum(latency) / len(latency), 6) if latency else 0.0,
            "expectedWinRate": _round(expected_wr, 6),
            "actualWinRate": _round(actual_wr, 6),
            "calibrationGap": _round(expected_wr - actual_wr, 6),
        })
    return result


def _ece(buckets: list[dict[str, Any]], total: int) -> float | None:
    supported = [b for b in buckets if int(b["trades"]) > 0]
    if not supported or total <= 0:
        return None
    return sum((int(b["trades"]) / total) * abs(float(b["calibrationGap"])) for b in supported)


def _brier(rows: list[dict[str, Any]], score_field: str) -> float | None:
    pairs = [
        (_clamp(_num(row.get(score_field), -1.0)), 1.0 if _num(row.get("realizedPnl"), 0.0) > 0 else 0.0)
        for row in rows
        if row.get(score_field) is not None and _num(row.get(score_field), -1.0) >= 0
    ]
    if not pairs:
        return None
    return sum((prob - outcome) ** 2 for prob, outcome in pairs) / len(pairs)


def _monotonicity(buckets: list[dict[str, Any]]) -> float:
    supported = [b for b in buckets if int(b["trades"]) >= 5]
    if len(supported) < 2:
        return 0.0
    pairs = 0
    ordered = 0
    for i in range(len(supported) - 1):
        a = float(supported[i]["avgPnl"])
        b = float(supported[i + 1]["avgPnl"])
        pairs += 1
        if b >= a:
            ordered += 1
    return ordered / max(1, pairs)


def _best_and_toxic(buckets: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    supported = [b for b in buckets if int(b["trades"]) >= 5]
    if not supported:
        return None, None
    best = max(supported, key=lambda b: (float(b["avgPnl"]), float(b["profitFactor"] or 0)))
    toxic_candidates = [b for b in supported if float(b["pnlUsdt"]) < 0 or float(b["avgPnl"]) < 0]
    toxic = min(toxic_candidates, key=lambda b: float(b["avgPnl"])) if toxic_candidates else None
    return str(best["bucket"]), str(toxic["bucket"]) if toxic else None


def _thresholds(buckets: list[dict[str, Any]], strength: dict[str, Any]) -> dict[str, Any]:
    supported = [b for b in buckets if int(b["trades"]) >= 5]
    profitable = [b for b in supported if float(b["avgPnl"]) > 0 and float(b["pnlUsdt"]) > 0]
    toxic = [b for b in supported if float(b["avgPnl"]) < 0 or float(b["pnlUsdt"]) < 0]
    min_score = 0.58
    if toxic:
        first_good = next((b for b in supported if float(b["lower"]) >= float(toxic[0]["lower"]) and float(b["avgPnl"]) > 0), None)
        if first_good:
            min_score = float(first_good["lower"])
        else:
            min_score = min(0.90, max(float(b["upper"] or 0.92) for b in toxic))
    elif profitable:
        min_score = min(float(b["lower"]) for b in profitable)

    boost = 0.76
    high_pf = [
        b for b in profitable
        if (float(b["profitFactor"] or 0) >= 1.4 and int(b["trades"]) >= 5)
    ]
    if high_pf:
        boost = float(max(high_pf, key=lambda b: float(b["avgPnl"]))["lower"])

    scale = float(strength["multiplier"])
    return {
        "minAggressiveScore": _round(0.58 + (min_score - 0.58) * scale, 4),
        "minStackingScore": _round(0.68 + (max(min_score + 0.08, 0.68) - 0.68) * scale, 4),
        "minBoostScore": _round(0.76 + (boost - 0.76) * scale, 4),
        "maxSniperScore": _round(0.92, 4),
        "learningSafety": strength,
    }


def _segment_penalties(rows: list[dict[str, Any]], key: str, min_rows: int, strength: dict[str, Any]) -> dict[str, float]:
    grouped: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        value = str(row.get(key) or "UNKNOWN").upper()
        grouped[value].append(_num(row.get("realizedPnl"), 0.0))
    penalties: dict[str, float] = {}
    scale = float(strength["multiplier"])
    for value, pnl in grouped.items():
        if len(pnl) < min_rows:
            continue
        pf = _profit_factor(pnl) or 0.0
        avg = sum(pnl) / len(pnl)
        if avg < 0 or pf < 0.85:
            penalties[value] = _round(min(0.20, (0.05 + abs(avg) * 0.02) * scale), 4) or 0.0
    return penalties


def _calibration_for_model(rows: list[dict[str, Any]], score_field: str) -> dict[str, Any]:
    usable = [row for row in rows if row.get(score_field) is not None and _num(row.get(score_field), -1.0) >= MIN_SCORE]
    buckets = _bucket_metrics(usable, score_field)
    ece = _ece(buckets, len(usable))
    brier = _brier(usable, score_field)
    monotonicity = _monotonicity(buckets)
    overconfidence = bool(ece is not None and any(
        int(b["trades"]) >= 5 and float(b["expectedWinRate"]) - float(b["actualWinRate"]) >= 0.12
        for b in buckets
    ))
    underconfidence = bool(any(
        int(b["trades"]) >= 5 and float(b["actualWinRate"]) - float(b["expectedWinRate"]) >= 0.12
        for b in buckets
    ))
    best, toxic = _best_and_toxic(buckets)
    return {
        "scoreField": score_field,
        "samples": len(usable),
        "buckets": buckets,
        "calibrationError": _round(ece, 6),
        "expectedCalibrationError": _round(ece, 6),
        "brierScore": _round(brier, 6),
        "monotonicityScore": _round(monotonicity, 6),
        "overconfidencePenalty": _round(max(0.0, (ece or 0.0) - 0.05), 6),
        "overconfidence": overconfidence,
        "underconfidence": underconfidence,
        "bestBucket": best,
        "toxicBucket": toxic,
        "calibrationQuality": _quality(ece, monotonicity, len(usable)),
    }


def _chart_data(buckets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "bucket": b["bucket"],
            "trades": b["trades"],
            "score": _round(float(b["expectedWinRate"]), 4),
            "winRate": b["actualWinRate"],
            "pnlUsdt": b["pnlUsdt"],
            "avgPnl": b["avgPnl"],
            "profitFactor": b["profitFactor"],
        }
        for b in buckets
    ]


def _experiment_quality(rows: list[dict[str, Any]], best_field: str) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        experiment_id = str(row.get("experimentId") or "")
        arm = str(row.get("experimentArm") or "")
        if experiment_id and arm:
            grouped[(experiment_id, arm)].append(row)
    result = []
    for (experiment_id, arm), arm_rows in sorted(grouped.items()):
        model = _calibration_for_model(arm_rows, best_field)
        result.append({
            "experimentId": experiment_id,
            "experimentArm": arm,
            "trades": len(arm_rows),
            "scoreQuality": model["calibrationQuality"],
            "monotonicityScore": model["monotonicityScore"],
            "expectedCalibrationError": model["expectedCalibrationError"],
            "overconfidence": model["overconfidence"],
            "rankingImproved": bool(model["monotonicityScore"] and float(model["monotonicityScore"]) >= 0.6),
            "falseConfidence": bool(model["overconfidence"] and float(model["monotonicityScore"] or 0) < 0.5),
        })
    return result


def run_score_calibration(rows: list[dict[str, Any]]) -> dict[str, Any]:
    normalized = [row for row in rows if row.get("realizedPnl") is not None]
    models = [
        _calibration_for_model(normalized, field)
        for field in ("aggressiveScore", "executionPriority", "coachScore", "playbookScore", "mlProbability")
    ]
    best_model = max(
        models,
        key=lambda model: (
            float(model["monotonicityScore"] or 0),
            -float(model["expectedCalibrationError"] if model["expectedCalibrationError"] is not None else 9),
            int(model["samples"]),
        ),
    )
    strength = _learning_strength(len(normalized))
    thresholds = _thresholds(best_model["buckets"], strength)
    best_bucket, toxic_bucket = best_model["bestBucket"], best_model["toxicBucket"]
    recommended_min = thresholds["minAggressiveScore"]
    recommended_boost = thresholds["minBoostScore"]
    score_truth = {
        "isMonotonic": float(best_model["monotonicityScore"] or 0) >= 0.70,
        "calibrationQuality": best_model["calibrationQuality"],
        "overconfidence": bool(best_model["overconfidence"]),
        "underconfidence": bool(best_model["underconfidence"]),
        "bestBucket": best_bucket,
        "toxicBucket": toxic_bucket,
        "recommendedMinScore": recommended_min,
        "recommendedBoostScore": recommended_boost,
    }
    warnings = []
    if best_model["overconfidence"]:
        warnings.append("high_score_overconfidence_detected")
    if toxic_bucket:
        warnings.append(f"negative_expectancy_bucket:{toxic_bucket}")
    if len(normalized) < 50:
        warnings.append("learning_safety_observe_only")

    return {
        "generatedAt": time.time(),
        "samples": len(normalized),
        "scoreTruth": score_truth,
        "buckets": best_model["buckets"],
        "models": {str(model["scoreField"]): model for model in models},
        "bestScoringModel": best_model["scoreField"],
        "recommendedThresholds": {
            **thresholds,
            "scorePenaltyBySymbol": _segment_penalties(normalized, "symbol", 10, strength),
            "scorePenaltyByPlaybook": _segment_penalties(normalized, "playbook", 10, strength),
            "scorePenaltyByRegime": _segment_penalties(normalized, "regime", 10, strength),
        },
        "overconfidenceWarnings": warnings,
        "scoreVsActualPnlChartData": _chart_data(best_model["buckets"]),
        "experiments": _experiment_quality(normalized, str(best_model["scoreField"])),
    }


def calibrate_score(raw_score: float, status: dict[str, Any]) -> float:
    truth = status.get("scoreTruth") or {}
    thresholds = status.get("recommendedThresholds") or {}
    ece = _num((status.get("models") or {}).get(status.get("bestScoringModel"), {}).get("expectedCalibrationError"), 0.0)
    score = _clamp(raw_score - max(0.0, ece * 0.5))
    if truth.get("overconfidence") and score >= _num(thresholds.get("minBoostScore"), 0.76):
        score -= 0.06
    return _clamp(score)
