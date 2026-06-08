from __future__ import annotations

import time
import unittest

from core.drift_monitor import (
    DriftConfig,
    DriftStateMachine,
    brier_score,
    evaluate_concept_drift,
    evaluate_data_drift,
    expected_calibration_error,
    jensen_shannon_divergence,
    numerical_jensen_shannon,
    population_stability_index,
    profit_factor,
    rolling_expectancy,
    target_state,
)


def _signal(index: int, shifted: bool = False, bad_prediction: bool = False) -> dict:
    cycle = index % 10
    hit = 1 if cycle < 7 else 0
    probability = (0.20 if hit else 0.85) if bad_prediction else (0.75 if hit else 0.25)
    level = 3.0 + cycle * 0.1 if shifted else 1.0 + cycle * 0.01
    return {
        "symbol": "XRP-USDT" if shifted else ("ETH-USDT" if index % 2 else "BTC-USDT"),
        "side": "LONG" if index % 2 else "SHORT",
        "hit_configured": hit,
        "predicted_probability": probability,
        "prediction_timestamp": time.time() - 10,
        "features": {
            "alt": {
                "price_change_pct": level,
                "price_acceleration": level / 2,
                "volume_ratio": 0.15 if shifted else 1.2,
                "oi_change_pct": level,
                "funding_rate": 0.0001,
                "rsi": 55,
                "atr_pct": 3.0 if shifted else 1.0,
                "spread_bps": level,
            },
            "btc": {
                "price_change_pct": level / 2,
                "volume_ratio": 1.1,
                "atr_pct": level,
                "spread_bps": level,
            },
        },
    }


class DriftMetricTest(unittest.TestCase):
    def test_metric_formulas(self) -> None:
        self.assertAlmostEqual(brier_score([0.8, 0.2], [1, 0]), 0.04)
        self.assertAlmostEqual(expected_calibration_error([0.8, 0.2], [1, 0], bins=2), 0.2)
        self.assertAlmostEqual(rolling_expectancy([1, -0.5, 0.5]), 1 / 3)
        self.assertAlmostEqual(profit_factor([2, 1, -1]), 3.0)
        self.assertLess(population_stability_index(range(100), range(100)), 0.01)
        self.assertGreater(population_stability_index(range(100), range(200, 300)), 0.25)
        self.assertGreater(numerical_jensen_shannon(range(100), range(200, 300)), 0.20)
        self.assertGreater(jensen_shannon_divergence(["A"] * 50, ["B"] * 50), 0.9)

    def test_synthetic_data_drift_is_critical(self) -> None:
        config = DriftConfig(reference_samples=100, current_samples=50, min_samples=25)
        rows = [_signal(index) for index in range(100)]
        rows.extend(_signal(index, shifted=True) for index in range(50))
        report = evaluate_data_drift(rows, config, time.time())
        self.assertEqual(report["status"], "critical")
        self.assertEqual(report["metrics"]["symbolUniverse"]["removed"], ["BTC-USDT", "ETH-USDT"])
        self.assertGreater(report["metrics"]["alt.atr_pct"]["psi"]["value"], config.psi_critical)

    def test_historical_walk_forward_concept_drift(self) -> None:
        config = DriftConfig(current_samples=60, min_samples=30)
        signals = [_signal(index) for index in range(120)]
        signals.extend(_signal(index, bad_prediction=True) for index in range(60))
        trades = [
            {
                "pnl_pct": 0.25 if index < 120 else -0.30,
                "side": "LONG" if index % 2 else "SHORT",
                "btc_regime": "BULL" if index % 2 else "BEAR",
            }
            for index in range(180)
        ]
        report = evaluate_concept_drift(signals, trades, config)
        self.assertEqual(report["status"], "critical")
        self.assertGreater(report["metrics"]["brierDegradation"]["value"], config.brier_delta_critical)
        self.assertLessEqual(report["metrics"]["campaignExpectancy"]["value"], config.expectancy_critical)
        self.assertLessEqual(report["metrics"]["profitFactor"]["value"], config.profit_factor_critical)


class DriftStateMachineTest(unittest.TestCase):
    def test_deterministic_targets(self) -> None:
        self.assertEqual(target_state("ok", "ok"), "HEALTHY")
        self.assertEqual(target_state("warn", "ok"), "DEGRADED")
        self.assertEqual(target_state("critical", "ok"), "SHADOW_ONLY")
        self.assertEqual(target_state("critical", "critical"), "PAUSED")

    def test_hysteresis_prevents_oscillation(self) -> None:
        machine = DriftStateMachine(DriftConfig(breach_evaluations=2, recovery_evaluations=3))
        self.assertEqual(machine.update("DEGRADED"), "HEALTHY")
        self.assertEqual(machine.update("HEALTHY"), "HEALTHY")
        self.assertEqual(machine.update("DEGRADED"), "HEALTHY")
        self.assertEqual(machine.update("DEGRADED"), "DEGRADED")
        self.assertEqual(machine.update("HEALTHY"), "DEGRADED")
        self.assertEqual(machine.update("HEALTHY"), "DEGRADED")
        self.assertEqual(machine.update("HEALTHY"), "HEALTHY")

    def test_policy_is_entry_only(self) -> None:
        machine = DriftStateMachine(DriftConfig(breach_evaluations=1))
        machine.update("PAUSED")
        policy = machine.snapshot()["policy"]
        self.assertFalse(policy["newEntriesAllowed"])
        self.assertFalse(policy["mlEnforcementAllowed"])
        self.assertEqual(policy["stackingMultiplier"], 0.0)


if __name__ == "__main__":
    unittest.main()
