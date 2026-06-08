from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def test_assignment_is_deterministic_for_signal_id():
    from core.experiment_engine import assign_signal_to_experiments

    payload = {"signalId": "sig-fixed-123", "symbol": "ETH-USDT", "positionSide": "LONG"}

    first = assign_signal_to_experiments(payload)
    second = assign_signal_to_experiments(payload)

    assert first == second
    assert {item["experimentId"] for item in first} >= {
        "EXP_EXIT_TRAILING",
        "EXP_STACKING_DEPTH",
        "EXP_AGGRESSIVE_THRESHOLD",
        "EXP_SYMBOL_ROTATION",
        "EXP_COACH_RANKER",
    }
    assert all(0 <= item["bucket"] <= 99 for item in first)


def test_stacking_depth_has_three_controlled_arms():
    from core.experiment_engine import experiment_definitions

    stacking = next(exp for exp in experiment_definitions() if exp.experiment_id == "EXP_STACKING_DEPTH")

    assert [arm.arm_id for arm in stacking.arms] == ["control", "treatment_a", "treatment_b"]
    assert stacking.arms[0].policy_overrides["maxStackingDepth"] == 1
    assert stacking.arms[1].policy_overrides["maxStackingDepth"] == 3
    assert stacking.arms[2].policy_overrides["maxStackingDepth"] == 5


def test_arm_metrics_profit_factor_drawdown_and_rates():
    from core.experiment_engine import _arm_metrics

    rows = [
        {"pnlUsdt": 2.0, "pnlPct": 1.0, "sourceId": "a", "exitReason": "TP", "slippageBps": 3, "mfePct": 1.4, "maePct": 0.2},
        {"pnlUsdt": -1.0, "pnlPct": -0.5, "sourceId": "b", "exitReason": "SL", "slippageBps": 5, "mfePct": 0.3, "maePct": 0.8},
        {"pnlUsdt": 3.0, "pnlPct": 1.5, "sourceId": "c", "exitReason": "TIMEOUT", "slippageBps": 4, "mfePct": 2.0, "maePct": 0.1},
    ]

    metrics = _arm_metrics(rows)

    assert metrics["trades"] == 3
    assert metrics["campaigns"] == 3
    assert metrics["winRate"] == 0.666667
    assert metrics["pnlUsdt"] == 4.0
    assert metrics["profitFactor"] == 5.0
    assert metrics["maxDrawdown"] == 1.0
    assert metrics["tpHitRate"] == 0.333333
    assert metrics["slHitRate"] == 0.333333
    assert metrics["timeoutRate"] == 0.333333
