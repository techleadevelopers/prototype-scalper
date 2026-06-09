from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.feature_extraction import DictVectorizer
from sklearn.metrics import brier_score_loss, confusion_matrix, roc_auc_score
from sklearn.pipeline import Pipeline

from core import knowledge_base as kb
from core.database import Row, connect
from core.shadow_model import _feature_dict


@dataclass(frozen=True)
class Fold:
    index: int
    train_start: float
    train_end: float
    test_start: float
    test_end: float


def _finite_float(value: Any, fallback: float = 0.0) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else fallback
    except Exception:
        return fallback


async def load_rows(symbol: str | None, source_type: str | None, limit: int) -> list[dict[str, Any]]:
    clauses = ["finalized=1", "hit_configured IS NOT NULL"]
    params: list[Any] = []
    if symbol:
        clauses.append("symbol=?")
        params.append(symbol.upper())
    if source_type:
        clauses.append("source_type=?")
        params.append(source_type)
    params.append(max(1, limit))
    async with connect(kb.DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            f"""SELECT *
                FROM signal_outcomes
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at ASC
                LIMIT ?""",
            tuple(params),
        )).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["features"] = json.loads(item.get("features") or "{}")
        result.append(item)
    return result


def build_folds(rows: list[dict[str, Any]], train_days: float, test_days: float, step_days: float) -> list[Fold]:
    if not rows:
        return []
    start = float(rows[0]["created_at"])
    end = float(rows[-1]["created_at"])
    train = train_days * 86400
    test = test_days * 86400
    step = step_days * 86400
    folds: list[Fold] = []
    cursor = start
    index = 0
    while cursor + train + test <= end + 1e-9:
        folds.append(Fold(index, cursor, cursor + train, cursor + train, cursor + train + test))
        cursor += step
        index += 1
    if not folds and len(rows) >= 80:
        n = len(rows)
        for index, ratio in enumerate((0.5, 0.6, 0.7, 0.8)):
            train_end_idx = int(n * ratio)
            test_end_idx = min(n, train_end_idx + max(10, n // 10))
            if test_end_idx > train_end_idx:
                folds.append(Fold(
                    index,
                    float(rows[0]["created_at"]),
                    float(rows[train_end_idx - 1]["created_at"]),
                    float(rows[train_end_idx]["created_at"]),
                    float(rows[test_end_idx - 1]["created_at"]),
                ))
    return folds


def split_with_embargo(
    rows: list[dict[str, Any]],
    fold: Fold,
    embargo_minutes: float,
    min_train_samples: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    embargo = embargo_minutes * 60
    test = [r for r in rows if fold.test_start <= float(r["created_at"]) < fold.test_end]
    train = [
        r for r in rows
        if fold.train_start <= float(r["created_at"]) < fold.train_end
        and not (fold.test_start - embargo <= float(r["created_at"]) <= fold.test_start + embargo)
        and not (fold.test_end - embargo <= float(r["created_at"]) <= fold.test_end + embargo)
    ]
    if len(train) < min_train_samples:
        return [], []
    if len({int(r["hit_configured"] or 0) for r in train}) < 2:
        return [], []
    if len({int(r["hit_configured"] or 0) for r in test}) < 2:
        return [], []
    return train, test


def build_model(random_state: int) -> Pipeline:
    return Pipeline([
        ("vectorizer", DictVectorizer(sparse=True)),
        ("classifier", RandomForestClassifier(
            n_estimators=500,
            max_depth=8,
            min_samples_leaf=6,
            class_weight="balanced_subsample",
            random_state=random_state,
            n_jobs=1,
        )),
    ])


def row_profit(row: dict[str, Any], probability: float, threshold: float) -> tuple[float, float]:
    target = _finite_float(row.get("target_configured_move_pct"), 0.0)
    cost = _finite_float(row.get("estimated_cost_pct"), 0.0)
    stop = _finite_float((row.get("features") or {}).get("stop_move_pct"), max(target, 0.15))
    net_win = max(0.0, target - cost)
    net_loss = stop + cost
    if probability < threshold:
        return 0.0, 0.0
    win = int(row.get("hit_configured") or 0) == 1
    payoff_ratio = net_win / max(net_loss, 1e-9)
    raw_kelly = probability - (1.0 - probability) / max(payoff_ratio, 1e-9)
    kelly_weight = max(0.0, min(0.25, raw_kelly))
    pnl = net_win if win else -net_loss
    return pnl * kelly_weight, abs(pnl * kelly_weight)


def evaluate_fold(fold: Fold, train: list[dict[str, Any]], test: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    model = build_model(42 + fold.index)
    x_train = [_feature_dict(row) for row in train]
    y_train = np.asarray([int(row.get("hit_configured") or 0) for row in train])
    x_test = [_feature_dict(row) for row in test]
    y_test = np.asarray([int(row.get("hit_configured") or 0) for row in test])
    model.fit(x_train, y_train)
    probabilities = model.predict_proba(x_test)[:, 1]
    predicted = (probabilities >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_test, predicted, labels=[0, 1]).ravel()
    pnl = [row_profit(row, float(prob), threshold)[0] for row, prob in zip(test, probabilities)]
    gross_profit = sum(v for v in pnl if v > 0)
    gross_loss = abs(sum(v for v in pnl if v < 0))
    return {
        "fold": fold.index,
        "trainSamples": len(train),
        "testSamples": len(test),
        "trainStart": fold.train_start,
        "trainEnd": fold.train_end,
        "testStart": fold.test_start,
        "testEnd": fold.test_end,
        "brier": round(float(brier_score_loss(y_test, probabilities)), 6),
        "auc": round(float(roc_auc_score(y_test, probabilities)), 6),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "approvedTrades": int(predicted.sum()),
        "approvalRate": round(float(predicted.mean()), 6),
        "profitFactor": round(gross_profit / gross_loss, 6) if gross_loss > 0 else None,
        "kellyWeightedPnlPct": round(sum(pnl), 6),
    }


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    if not results:
        return {"status": "NO_VALID_FOLDS"}
    confusion = {"tn": 0, "fp": 0, "fn": 0, "tp": 0}
    for result in results:
        for key in confusion:
            confusion[key] += int(result["confusion"][key])
    briers = [float(r["brier"]) for r in results]
    aucs = [float(r["auc"]) for r in results]
    pnl = [float(r["kellyWeightedPnlPct"]) for r in results]
    return {
        "status": "OK",
        "folds": len(results),
        "confusion": confusion,
        "avgBrier": round(statistics.mean(briers), 6),
        "medianBrier": round(statistics.median(briers), 6),
        "avgAuc": round(statistics.mean(aucs), 6),
        "kellyWeightedPnlPct": round(sum(pnl), 6),
        "foldResults": results,
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    rows = await load_rows(args.symbol, args.source_type, args.limit)
    folds = build_folds(rows, args.train_days, args.test_days, args.step_days)
    results = []
    for fold in folds:
        train, test = split_with_embargo(rows, fold, args.embargo_minutes, args.min_train_samples)
        if not train or not test:
            continue
        results.append(evaluate_fold(fold, train, test, args.threshold))
    summary = summarize(results)
    summary.update({
        "symbol": args.symbol or "ALL",
        "sourceType": args.source_type or "ALL",
        "rowsLoaded": len(rows),
        "embargoMinutes": args.embargo_minutes,
        "threshold": args.threshold,
    })
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Purged walk-forward validation for Quant Brain shadow features.")
    parser.add_argument("--symbol", default=None)
    parser.add_argument("--source-type", default=None)
    parser.add_argument("--embargo-minutes", type=float, default=15.0)
    parser.add_argument("--train-days", type=float, default=3.0)
    parser.add_argument("--test-days", type=float, default=1.0)
    parser.add_argument("--step-days", type=float, default=1.0)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--min-train-samples", type=int, default=50)
    parser.add_argument("--limit", type=int, default=50000)
    return parser.parse_args()


def main() -> None:
    print(json.dumps(asyncio.run(run(parse_args())), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
