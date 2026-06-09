from __future__ import annotations

from core.training_serving_skew import compare_vectors, feature_hash
from research.walk_forward_evaluation import Fold, split_with_embargo


def test_training_serving_skew_tolerance() -> None:
    left = {"a": 1.0, "b": 2.0, "side": "LONG"}
    right = {"a": 1.0 + 5e-7, "b": 2.0, "side": "LONG"}
    max_diff, mismatches = compare_vectors(left, right)
    assert max_diff < 1e-6
    assert mismatches == []

    max_diff, mismatches = compare_vectors(left, {**right, "b": 2.001})
    assert max_diff > 1e-6
    assert mismatches[0]["feature"] == "b"


def test_feature_hash_is_order_independent() -> None:
    assert feature_hash({"b": 2, "a": 1}) == feature_hash({"a": 1, "b": 2})


def test_walk_forward_embargo_purges_boundary_samples() -> None:
    rows = [
        {"created_at": float(i * 60), "hit_configured": i % 2, "features": {}}
        for i in range(100)
    ]
    fold = Fold(index=0, train_start=0, train_end=3600, test_start=3600, test_end=5400)
    train, test = split_with_embargo(rows, fold, embargo_minutes=15, min_train_samples=10)

    assert test
    assert train
    assert all(float(row["created_at"]) < 2700 for row in train)
    assert all(3600 <= float(row["created_at"]) < 5400 for row in test)
