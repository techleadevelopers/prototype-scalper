from core.calibration_audit import chronological_split, run_calibration_audit


def _rows(count: int = 300):
    rows = []
    for index in range(count):
        probability = 0.2 + 0.6 * ((index % 10) / 9)
        rows.append({
            "signal_id": str(index),
            "symbol": f"S{index % 5}-USDT",
            "side": "LONG" if index % 2 else "SHORT",
            "source_type": "shadow_sampler",
            "strategy_version": "test-v1",
            "model_version": "test-v1",
            "predicted_probability": probability,
            "prediction_timestamp": float(index) + 0.1,
            "created_at": float(index),
            "finalized_at": float(index + 1),
            "target_configured_move_pct": 0.22,
            "estimated_cost_pct": 0.14,
            "hit_configured": int((index * 7) % 10 < probability * 10),
            "stopped": int((index * 7) % 10 >= probability * 10),
            "max_adverse_pct": -0.1,
            "features": {
                "optimal_score": probability,
                "target_probabilities": {"0.5": probability},
                "stop_move_pct": 0.55,
                "alt": {
                    "price_change_pct": probability,
                    "movement_state": "MOVE",
                    "btc_regime": "BULL",
                },
                "btc": {"price_change_pct": 0.1, "movement_state": "MOVE"},
            },
        })
    return rows


def test_chronological_partitions_do_not_overlap():
    train, calibration, evaluation = chronological_split(list(reversed(_rows())))
    assert train[-1]["created_at"] < calibration[0]["created_at"]
    assert calibration[-1]["created_at"] < evaluation[0]["created_at"]


def test_audit_compares_all_calibration_methods():
    report = run_calibration_audit(_rows(), bootstrap_iterations=120)
    assert report["periods"]["nonOverlapping"] is True
    assert report["samples"] == {
        "total": 300,
        "train": 180,
        "calibration": 60,
        "evaluation": 60,
    }
    assert set(report["methods"]) == {
        "rawProbability",
        "platt",
        "isotonic",
        "deterministicBaseline",
    }
