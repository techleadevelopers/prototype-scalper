from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any, Callable

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.feature_extraction import DictVectorizer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import Pipeline

from core.shadow_model import _feature_dict


MIN_PARTITION_SAMPLES = 50
MIN_SUBGROUP_SAMPLES = 20


def chronological_split(
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    ordered = sorted(rows, key=lambda row: float(row.get("created_at", 0)))
    train_end = int(len(ordered) * 0.60)
    calibration_end = int(len(ordered) * 0.80)
    return ordered[:train_end], ordered[train_end:calibration_end], ordered[calibration_end:]


def _fit_raw_model(rows: list[dict[str, Any]], labels: np.ndarray) -> Pipeline:
    model = Pipeline([
        ("vectorizer", DictVectorizer(sparse=False)),
        ("classifier", GradientBoostingClassifier(
            n_estimators=200,
            learning_rate=0.04,
            max_depth=3,
            min_samples_leaf=8,
            subsample=0.75,
            random_state=42,
        )),
    ])
    model.fit([_feature_dict(row) for row in rows], labels)
    return model


def _predict(model: Pipeline, rows: list[dict[str, Any]]) -> np.ndarray:
    return model.predict_proba([_feature_dict(row) for row in rows])[:, 1]


def _deterministic_probability(row: dict[str, Any]) -> float:
    features = row.get("features") or {}
    probabilities = features.get("target_probabilities") or {}
    value = probabilities.get("configured", probabilities.get("0.5"))
    if value is None:
        value = features.get("optimal_score", 0.5)
    return float(np.clip(float(value or 0.5), 0.0, 1.0))


def expected_calibration_error(
    labels: np.ndarray,
    probability: np.ndarray,
    bins: int = 10,
) -> float:
    edges = np.linspace(0.0, 1.0, bins + 1)
    result = 0.0
    for index in range(bins):
        mask = (probability >= edges[index]) & (
            probability <= edges[index + 1]
            if index == bins - 1
            else probability < edges[index + 1]
        )
        if mask.any():
            result += float(mask.mean()) * abs(
                float(probability[mask].mean()) - float(labels[mask].mean())
            )
    return result


def _calibration_line(labels: np.ndarray, probability: np.ndarray) -> tuple[float | None, float | None]:
    if len(set(labels.tolist())) < 2:
        return None, None
    clipped = np.clip(probability, 1e-6, 1 - 1e-6)
    logits = np.log(clipped / (1 - clipped)).reshape(-1, 1)
    if float(np.std(logits)) == 0:
        return None, None
    model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=2000)
    model.fit(logits, labels)
    return float(model.coef_[0][0]), float(model.intercept_[0])


def _metrics(labels: np.ndarray, probability: np.ndarray) -> dict[str, Any]:
    slope, intercept = _calibration_line(labels, probability)
    two_classes = len(set(labels.tolist())) == 2
    return {
        "brier": round(float(brier_score_loss(labels, probability)), 6),
        "ece": round(expected_calibration_error(labels, probability), 6),
        "calibrationSlope": round(slope, 6) if slope is not None else None,
        "calibrationIntercept": round(intercept, 6) if intercept is not None else None,
        "prAuc": round(float(average_precision_score(labels, probability)), 6)
        if two_classes else None,
        "rocAuc": round(float(roc_auc_score(labels, probability)), 6)
        if two_classes else None,
    }


def _bootstrap_ci(
    labels: np.ndarray,
    probability: np.ndarray,
    metric: Callable[[np.ndarray, np.ndarray], float],
    iterations: int = 1000,
) -> list[float] | None:
    rng = np.random.default_rng(42)
    values: list[float] = []
    for _ in range(iterations):
        indices = rng.integers(0, len(labels), len(labels))
        sampled = labels[indices]
        if len(set(sampled.tolist())) < 2:
            continue
        value = float(metric(sampled, probability[indices]))
        if math.isfinite(value):
            values.append(value)
    if len(values) < 100:
        return None
    return [
        round(float(np.quantile(values, 0.025)), 6),
        round(float(np.quantile(values, 0.975)), 6),
    ]


def _pnl_proxy(row: dict[str, Any]) -> float:
    target = float(row.get("target_configured_move_pct") or 0.22)
    cost = float(row.get("estimated_cost_pct") or 0.0)
    stop = float((row.get("features") or {}).get("stop_move_pct") or 0.55)
    if int(row.get("hit_configured") or 0):
        return target - cost
    if int(row.get("stopped") or 0):
        return -(stop + cost)
    return min(0.0, float(row.get("max_adverse_pct") or 0.0)) - cost


def _financial_metrics(rows: list[dict[str, Any]], probability: np.ndarray) -> dict[str, Any]:
    pnl = np.asarray([
        _pnl_proxy(row)
        for row, value in zip(rows, probability)
        if value >= 0.5
    ])
    if not len(pnl):
        return {"trades": 0, "observedVst": False}
    gross_profit = float(pnl[pnl > 0].sum())
    gross_loss = abs(float(pnl[pnl < 0].sum()))
    equity = np.concatenate(([0.0], np.cumsum(pnl)))
    drawdown = equity - np.maximum.accumulate(equity)
    return {
        "trades": int(len(pnl)),
        "coverage": round(len(pnl) / len(rows), 4),
        "netExpectancyPct": round(float(pnl.mean()), 6),
        "profitFactor": round(gross_profit / gross_loss, 4) if gross_loss else None,
        "maxDrawdownPct": round(abs(float(drawdown.min())), 6),
        "observedVst": False,
        "note": "Signal-label path proxy, not realized campaign VST PnL.",
    }


def _score_buckets(rows: list[dict[str, Any]], probability: np.ndarray) -> list[dict[str, Any]]:
    result = []
    labels = np.asarray([int(row.get("hit_configured") or 0) for row in rows])
    for lower in np.arange(0.0, 1.0, 0.1):
        upper = lower + 0.1
        mask = (probability >= lower) & (
            probability <= upper if upper >= 1 else probability < upper
        )
        if mask.any():
            result.append({
                "bucket": f"{lower:.1f}-{upper:.1f}",
                "n": int(mask.sum()),
                "meanProbability": round(float(probability[mask].mean()), 4),
                "observedFrequency": round(float(labels[mask].mean()), 4),
                "gap": round(float(probability[mask].mean() - labels[mask].mean()), 4),
            })
    return result


def _group_value(row: dict[str, Any], dimension: str) -> str:
    features = row.get("features") or {}
    if dimension == "regime":
        return str((features.get("alt") or {}).get("btc_regime") or "UNKNOWN")
    if dimension == "modelVersion":
        return str(row.get("model_version") or row.get("strategy_version") or "UNKNOWN")
    if dimension == "fallbackVsMl":
        if row.get("predicted_probability") is None:
            return "NOT_RECORDED"
        version = str(row.get("model_version") or "")
        return "FALLBACK" if "baseline" in version else "ML"
    return str(row.get(dimension) or "UNKNOWN")


def _subgroups(
    rows: list[dict[str, Any]],
    labels: np.ndarray,
    probability: np.ndarray,
) -> dict[str, list[dict[str, Any]]]:
    report: dict[str, list[dict[str, Any]]] = {}
    for dimension in ("symbol", "side", "regime", "modelVersion", "source_type", "fallbackVsMl"):
        groups: dict[str, list[int]] = defaultdict(list)
        for index, row in enumerate(rows):
            groups[_group_value(row, dimension)].append(index)
        report[dimension] = []
        for value, indices in sorted(groups.items(), key=lambda item: len(item[1]), reverse=True):
            group_labels = labels[indices]
            group_probability = probability[indices]
            report[dimension].append({
                "value": value,
                "n": len(indices),
                "observedFrequency": round(float(group_labels.mean()), 4),
                "meanProbability": round(float(group_probability.mean()), 4),
                "brier": round(float(brier_score_loss(group_labels, group_probability)), 6),
                "supported": len(indices) >= MIN_SUBGROUP_SAMPLES
                and len(set(group_labels.tolist())) == 2,
            })
    return report


def _prediction_age(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        predicted_at = row.get("prediction_timestamp")
        created_at = row.get("created_at")
        if predicted_at is None or created_at is None:
            buckets["MISSING"].append(0.0)
            continue
        age = max(0.0, float(predicted_at) - float(created_at))
        bucket = "<5s" if age < 5 else "5-30s" if age < 30 else "30-120s" if age < 120 else ">=120s"
        buckets[bucket].append(age)
    return [
        {"bucket": bucket, "n": len(values), "meanAgeSeconds": round(float(np.mean(values)), 3)}
        for bucket, values in buckets.items()
    ]


def _concentration(rows: list[dict[str, Any]], probability: np.ndarray) -> dict[str, Any]:
    counters = {"symbol": Counter(), "side": Counter(), "regime": Counter()}
    total = 0.0
    for row, value in zip(rows, probability):
        if value < 0.5:
            continue
        contribution = max(0.0, _pnl_proxy(row))
        total += contribution
        counters["symbol"][str(row.get("symbol"))] += contribution
        counters["side"][str(row.get("side"))] += contribution
        counters["regime"][_group_value(row, "regime")] += contribution
    result: dict[str, Any] = {}
    for dimension, counter in counters.items():
        if total <= 0 or not counter:
            result[dimension] = None
            continue
        value, contribution = counter.most_common(1)[0]
        result[dimension] = {
            "value": value,
            "shareOfGrossProfit": round(contribution / total, 4),
        }
    result["concentrated"] = any(
        value and value["shareOfGrossProfit"] >= 0.60
        for value in result.values()
        if isinstance(value, dict)
    )
    return result


def run_calibration_audit(
    rows: list[dict[str, Any]],
    bootstrap_iterations: int = 1000,
) -> dict[str, Any]:
    usable = [
        row for row in rows
        if row.get("created_at") is not None and row.get("hit_configured") is not None
    ]
    train, calibration, evaluation = chronological_split(usable)
    samples = {
        "total": len(usable),
        "train": len(train),
        "calibration": len(calibration),
        "evaluation": len(evaluation),
    }
    if min(samples["train"], samples["calibration"], samples["evaluation"]) < MIN_PARTITION_SAMPLES:
        return {
            "status": "STATISTICALLY_UNSUPPORTED",
            "reason": "insufficient_chronological_partitions",
            "samples": samples,
        }

    labels = {
        "train": np.asarray([int(row["hit_configured"]) for row in train]),
        "calibration": np.asarray([int(row["hit_configured"]) for row in calibration]),
        "evaluation": np.asarray([int(row["hit_configured"]) for row in evaluation]),
    }
    if any(len(set(values.tolist())) < 2 for values in labels.values()):
        return {"status": "STATISTICALLY_UNSUPPORTED", "reason": "both_classes_required", "samples": samples}

    raw_model = _fit_raw_model(train, labels["train"])
    raw_calibration = _predict(raw_model, calibration)
    raw_evaluation = _predict(raw_model, evaluation)

    calibration_logits = np.log(
        np.clip(raw_calibration, 1e-6, 1 - 1e-6)
        / (1 - np.clip(raw_calibration, 1e-6, 1 - 1e-6))
    ).reshape(-1, 1)
    evaluation_logits = np.log(
        np.clip(raw_evaluation, 1e-6, 1 - 1e-6)
        / (1 - np.clip(raw_evaluation, 1e-6, 1 - 1e-6))
    ).reshape(-1, 1)
    platt = LogisticRegression(C=1e6, solver="lbfgs", max_iter=2000)
    platt.fit(calibration_logits, labels["calibration"])
    isotonic = IsotonicRegression(out_of_bounds="clip")
    isotonic.fit(raw_calibration, labels["calibration"])

    probabilities = {
        "rawProbability": raw_evaluation,
        "platt": platt.predict_proba(evaluation_logits)[:, 1],
        "isotonic": isotonic.predict(raw_evaluation),
        "deterministicBaseline": np.asarray([
            _deterministic_probability(row) for row in evaluation
        ]),
    }
    methods: dict[str, Any] = {}
    for name, probability in probabilities.items():
        methods[name] = _metrics(labels["evaluation"], probability)
        methods[name]["brierCi95"] = _bootstrap_ci(
            labels["evaluation"], probability, brier_score_loss, bootstrap_iterations
        )
        methods[name]["rocAucCi95"] = _bootstrap_ci(
            labels["evaluation"], probability, roc_auc_score, bootstrap_iterations
        )
        methods[name]["financial"] = _financial_metrics(evaluation, probability)

    best_method = min(methods, key=lambda name: methods[name]["brier"])
    best_probability = probabilities[best_method]
    status = "UNCERTAIN"
    if methods[best_method]["ece"] > 0.10:
        status = "UNCALIBRATED"
    if (
        methods[best_method]["brierCi95"]
        and methods[best_method]["brierCi95"][1] < methods["deterministicBaseline"]["brier"]
        and methods[best_method]["calibrationSlope"] is not None
        and 0.5 <= methods[best_method]["calibrationSlope"] <= 1.5
        and abs(methods[best_method]["calibrationIntercept"] or 0) <= 0.5
    ):
        status = "VALIDATED"

    subgroups = _subgroups(evaluation, labels["evaluation"], best_probability)
    unsupported = [
        f"{dimension}:{entry['value']}"
        for dimension, entries in subgroups.items()
        for entry in entries
        if not entry["supported"]
    ]
    concentration = _concentration(evaluation, best_probability)
    if status == "VALIDATED" and concentration["concentrated"]:
        status = "UNCERTAIN"

    return {
        "status": status,
        "bestMethod": best_method,
        "samples": samples,
        "deployedPredictionCoverage": round(
            sum(row.get("predicted_probability") is not None for row in usable) / len(usable),
            4,
        ),
        "periods": {
            "trainEnd": train[-1]["created_at"],
            "calibrationStart": calibration[0]["created_at"],
            "calibrationEnd": calibration[-1]["created_at"],
            "evaluationStart": evaluation[0]["created_at"],
            "evaluationEnd": evaluation[-1]["created_at"],
            "nonOverlapping": (
                train[-1]["created_at"] <= calibration[0]["created_at"]
                and calibration[-1]["created_at"] <= evaluation[0]["created_at"]
            ),
        },
        "methods": methods,
        "scoreBuckets": _score_buckets(evaluation, best_probability),
        "subgroups": subgroups,
        "predictionAge": _prediction_age(evaluation),
        "statisticallyUnsupportedSegments": unsupported,
        "performanceConcentration": concentration,
        "limitations": [
            "Historical deployed probabilities are sparse; comparison uses a chronological refit.",
            "Financial metrics are signal-label path proxies, not observed campaign VST PnL.",
            "Fallback versus ML is reliable only when prediction/model fields were persisted.",
        ],
    }
