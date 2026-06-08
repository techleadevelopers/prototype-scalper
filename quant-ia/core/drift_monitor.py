from __future__ import annotations

import math
import os
import time
from dataclasses import asdict, dataclass
from typing import Any, Iterable

from core import knowledge_base as kb


STATES = ("HEALTHY", "DEGRADED", "SHADOW_ONLY", "PAUSED")
SEVERITY = {state: index for index, state in enumerate(STATES)}


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class DriftConfig:
    reference_samples: int = _int_env("DRIFT_REFERENCE_SAMPLES", 500)
    current_samples: int = _int_env("DRIFT_CURRENT_SAMPLES", 100)
    min_samples: int = _int_env("DRIFT_MIN_SAMPLES", 50)
    bins: int = _int_env("DRIFT_BINS", 10)
    psi_warn: float = _float_env("DRIFT_PSI_WARN", 0.10)
    psi_critical: float = _float_env("DRIFT_PSI_CRITICAL", 0.25)
    js_warn: float = _float_env("DRIFT_JS_WARN", 0.10)
    js_critical: float = _float_env("DRIFT_JS_CRITICAL", 0.20)
    missing_warn: float = _float_env("DRIFT_MISSINGNESS_WARN", 0.05)
    missing_critical: float = _float_env("DRIFT_MISSINGNESS_CRITICAL", 0.15)
    volatility_warn: float = _float_env("DRIFT_VOLATILITY_RATIO_WARN", 1.50)
    volatility_critical: float = _float_env("DRIFT_VOLATILITY_RATIO_CRITICAL", 2.00)
    volume_warn: float = _float_env("DRIFT_VOLUME_RATIO_WARN", 0.50)
    volume_critical: float = _float_env("DRIFT_VOLUME_RATIO_CRITICAL", 0.25)
    universe_warn: float = _float_env("DRIFT_UNIVERSE_CHANGE_WARN", 0.15)
    universe_critical: float = _float_env("DRIFT_UNIVERSE_CHANGE_CRITICAL", 0.30)
    prediction_age_warn: int = _int_env("DRIFT_PREDICTION_AGE_WARN_SECONDS", 120)
    prediction_age_critical: int = _int_env("DRIFT_PREDICTION_AGE_CRITICAL_SECONDS", 300)
    brier_warn: float = _float_env("DRIFT_BRIER_WARN", 0.22)
    brier_critical: float = _float_env("DRIFT_BRIER_CRITICAL", 0.28)
    brier_delta_warn: float = _float_env("DRIFT_BRIER_DEGRADATION_WARN", 0.03)
    brier_delta_critical: float = _float_env("DRIFT_BRIER_DEGRADATION_CRITICAL", 0.07)
    ece_warn: float = _float_env("DRIFT_ECE_WARN", 0.08)
    ece_critical: float = _float_env("DRIFT_ECE_CRITICAL", 0.15)
    probability_gap_warn: float = _float_env("DRIFT_PROBABILITY_GAP_WARN", 0.08)
    probability_gap_critical: float = _float_env("DRIFT_PROBABILITY_GAP_CRITICAL", 0.15)
    expectancy_warn: float = _float_env("DRIFT_EXPECTANCY_WARN", 0.0)
    expectancy_critical: float = _float_env("DRIFT_EXPECTANCY_CRITICAL", -0.20)
    profit_factor_warn: float = _float_env("DRIFT_PROFIT_FACTOR_WARN", 1.10)
    profit_factor_critical: float = _float_env("DRIFT_PROFIT_FACTOR_CRITICAL", 0.80)
    segment_min_samples: int = _int_env("DRIFT_SEGMENT_MIN_SAMPLES", 20)
    segment_expectancy_critical: float = _float_env("DRIFT_SEGMENT_EXPECTANCY_CRITICAL", -0.20)
    breach_evaluations: int = _int_env("DRIFT_BREACH_EVALUATIONS", 2)
    recovery_evaluations: int = _int_env("DRIFT_RECOVERY_EVALUATIONS", 3)


def _finite(values: Iterable[Any]) -> list[float]:
    result = []
    for value in values:
        try:
            number = float(value)
            if math.isfinite(number):
                result.append(number)
        except (TypeError, ValueError):
            pass
    return result


def _mean(values: Iterable[Any]) -> float:
    numbers = _finite(values)
    return sum(numbers) / len(numbers) if numbers else 0.0


def _quantile(values: list[float], q: float) -> float:
    position = (len(values) - 1) * q
    lower, upper = math.floor(position), math.ceil(position)
    if lower == upper:
        return values[lower]
    return values[lower] * (upper - position) + values[upper] * (position - lower)


def _distribution(values: list[float], edges: list[float]) -> list[float]:
    counts = [0] * (len(edges) + 1)
    for value in values:
        index = 0
        while index < len(edges) and value > edges[index]:
            index += 1
        counts[index] += 1
    probabilities = [(count / max(1, len(values))) + 1e-6 for count in counts]
    total = sum(probabilities)
    return [value / total for value in probabilities]


def population_stability_index(reference: Iterable[Any], current: Iterable[Any], bins: int = 10) -> float:
    ref, cur = sorted(_finite(reference)), _finite(current)
    if len(ref) < 2 or not cur:
        return 0.0
    edges = sorted(set(_quantile(ref, index / bins) for index in range(1, bins)))
    p, q = _distribution(ref, edges), _distribution(cur, edges)
    return sum((b - a) * math.log(b / a) for a, b in zip(p, q))


def jensen_shannon_divergence(reference: Iterable[Any], current: Iterable[Any]) -> float:
    left = [str(value) for value in reference if value is not None]
    right = [str(value) for value in current if value is not None]
    keys = sorted(set(left) | set(right))
    if not keys:
        return 0.0
    p = [(left.count(key) / max(1, len(left))) + 1e-12 for key in keys]
    q = [(right.count(key) / max(1, len(right))) + 1e-12 for key in keys]
    p_total, q_total = sum(p), sum(q)
    p, q = [value / p_total for value in p], [value / q_total for value in q]
    midpoint = [(a + b) / 2 for a, b in zip(p, q)]
    kl = lambda a, b: sum(x * math.log(x / y, 2) for x, y in zip(a, b))
    return (kl(p, midpoint) + kl(q, midpoint)) / 2


def numerical_jensen_shannon(reference: Iterable[Any], current: Iterable[Any], bins: int = 10) -> float:
    ref, cur = sorted(_finite(reference)), _finite(current)
    if len(ref) < 2 or not cur:
        return 0.0
    edges = sorted(set(_quantile(ref, index / bins) for index in range(1, bins)))
    p, q = _distribution(ref, edges), _distribution(cur, edges)
    midpoint = [(a + b) / 2 for a, b in zip(p, q)]
    kl = lambda a, b: sum(x * math.log(x / y, 2) for x, y in zip(a, b))
    return (kl(p, midpoint) + kl(q, midpoint)) / 2


def brier_score(probabilities: Iterable[Any], outcomes: Iterable[Any]) -> float:
    pairs = list(zip(_finite(probabilities), _finite(outcomes)))
    return sum((max(0.0, min(1.0, p)) - y) ** 2 for p, y in pairs) / len(pairs) if pairs else 0.0


def expected_calibration_error(probabilities: Iterable[Any], outcomes: Iterable[Any], bins: int = 10) -> float:
    pairs = list(zip(_finite(probabilities), _finite(outcomes)))
    if not pairs:
        return 0.0
    result = 0.0
    for index in range(bins):
        lower, upper = index / bins, (index + 1) / bins
        bucket = [(p, y) for p, y in pairs if lower <= p < upper or (index == bins - 1 and p == 1)]
        if bucket:
            result += len(bucket) / len(pairs) * abs(_mean(p for p, _ in bucket) - _mean(y for _, y in bucket))
    return result


def rolling_expectancy(values: Iterable[Any]) -> float:
    return _mean(values)


def profit_factor(values: Iterable[Any]) -> float:
    numbers = _finite(values)
    gains = sum(value for value in numbers if value > 0)
    losses = abs(sum(value for value in numbers if value < 0))
    return gains / losses if losses else (999.0 if gains else 0.0)


def _high(value: float, warn: float, critical: float) -> str:
    return "critical" if value >= critical else "warn" if value >= warn else "ok"


def _low(value: float, warn: float, critical: float) -> str:
    return "critical" if value <= critical else "warn" if value <= warn else "ok"


def _metric(value: float, status: str, **extra: Any) -> dict[str, Any]:
    return {"value": round(value, 6), "status": status, **extra}


FEATURES = (
    "alt.price_change_pct", "alt.price_acceleration", "alt.volume_ratio",
    "alt.oi_change_pct", "alt.funding_rate", "alt.rsi", "alt.atr_pct",
    "alt.spread_bps", "btc.price_change_pct", "btc.volume_ratio",
    "btc.atr_pct", "btc.spread_bps",
)


def _feature(row: dict[str, Any], path: str) -> Any:
    scope, name = path.split(".", 1)
    return ((row.get("features") or {}).get(scope) or {}).get(name)


def evaluate_data_drift(rows: list[dict[str, Any]], config: DriftConfig, now: float) -> dict[str, Any]:
    required = config.reference_samples + config.current_samples
    if len(rows) < max(config.min_samples * 2, required):
        return {"status": "insufficient_data", "samples": len(rows), "metrics": {}}
    reference, current = rows[-required:-config.current_samples], rows[-config.current_samples:]
    metrics: dict[str, Any] = {}
    statuses: list[str] = []
    for name in FEATURES:
        ref_values, cur_values = [_feature(row, name) for row in reference], [_feature(row, name) for row in current]
        psi = population_stability_index(ref_values, cur_values, config.bins)
        js = numerical_jensen_shannon(ref_values, cur_values, config.bins)
        missing_delta = max(0.0, 1 - len(_finite(cur_values)) / len(cur_values) - (1 - len(_finite(ref_values)) / len(ref_values)))
        psi_status = _high(psi, config.psi_warn, config.psi_critical)
        js_status = _high(js, config.js_warn, config.js_critical)
        missing_status = _high(missing_delta, config.missing_warn, config.missing_critical)
        statuses.extend((psi_status, js_status, missing_status))
        metrics[name] = {
            "psi": _metric(psi, psi_status),
            "jsDivergence": _metric(js, js_status),
            "missingnessDelta": _metric(missing_delta, missing_status),
        }

    volatility_ratio = _mean(_feature(row, "alt.atr_pct") for row in current) / max(_mean(_feature(row, "alt.atr_pct") for row in reference), 1e-9)
    volume_ratio = _mean(_feature(row, "alt.volume_ratio") for row in current) / max(_mean(_feature(row, "alt.volume_ratio") for row in reference), 1e-9)
    volatility_status = _high(volatility_ratio, config.volatility_warn, config.volatility_critical)
    volume_status = "critical" if volume_ratio <= config.volume_critical else "warn" if volume_ratio <= config.volume_warn else "ok"
    metrics["volatility"] = _metric(volatility_ratio, volatility_status, unit="current/reference")
    metrics["volume"] = _metric(volume_ratio, volume_status, unit="current/reference")

    ref_symbols, cur_symbols = [row.get("symbol") for row in reference], [row.get("symbol") for row in current]
    ref_set, cur_set = set(ref_symbols), set(cur_symbols)
    universe_js = jensen_shannon_divergence(ref_symbols, cur_symbols)
    universe_change = len(ref_set ^ cur_set) / max(1, len(ref_set | cur_set))
    universe_statuses = (_high(universe_js, config.js_warn, config.js_critical), _high(universe_change, config.universe_warn, config.universe_critical))
    universe_status = max(universe_statuses, key=lambda item: ("ok", "warn", "critical").index(item))
    metrics["symbolUniverse"] = {
        "jsDivergence": round(universe_js, 6), "changeRatio": round(universe_change, 6),
        "status": universe_status, "added": sorted(cur_set - ref_set), "removed": sorted(ref_set - cur_set),
    }
    timestamps = _finite(row.get("prediction_timestamp") for row in current)
    prediction_age = now - max(timestamps) if timestamps else config.prediction_age_critical + 1
    age_status = _high(prediction_age, config.prediction_age_warn, config.prediction_age_critical)
    metrics["predictionAge"] = _metric(prediction_age, age_status, unit="seconds")
    statuses.extend((volatility_status, volume_status, universe_status, age_status))
    status = "critical" if "critical" in statuses else "warn" if "warn" in statuses else "ok"
    return {"status": status, "samples": len(rows), "referenceSamples": len(reference), "currentSamples": len(current), "metrics": metrics}


def _segments(rows: list[dict[str, Any]], config: DriftConfig) -> dict[str, Any]:
    report: dict[str, Any] = {}
    for field in ("btc_regime", "side"):
        groups: dict[str, list[float]] = {}
        for row in rows:
            groups.setdefault(str(row.get(field) or "UNKNOWN"), []).append(float(row.get("pnl_pct") or 0))
        report[field] = {
            key: {
                "samples": len(values), "expectancy": round(_mean(values), 6),
                "profitFactor": round(profit_factor(values), 6),
                "status": "critical" if len(values) >= config.segment_min_samples and _mean(values) <= config.segment_expectancy_critical else "ok",
            }
            for key, values in groups.items()
        }
    return report


def evaluate_concept_drift(signals: list[dict[str, Any]], trades: list[dict[str, Any]], config: DriftConfig) -> dict[str, Any]:
    predicted = [
        row for row in signals
        if row.get("predicted_probability") is not None and row.get("hit_configured") is not None
    ]
    if len(predicted) < config.min_samples:
        return {"status": "insufficient_data", "samples": len(predicted), "metrics": {}}
    window = min(config.current_samples, max(config.min_samples, len(predicted) // 3))
    baseline, current = predicted[:-window], predicted[-window:]
    probabilities, actuals = [row["predicted_probability"] for row in current], [row["hit_configured"] for row in current]
    current_brier = brier_score(probabilities, actuals)
    baseline_brier = brier_score([row["predicted_probability"] for row in baseline], [row["hit_configured"] for row in baseline]) if baseline else current_brier
    brier_delta = current_brier - baseline_brier
    ece = expected_calibration_error(probabilities, actuals, config.bins)
    probability_gap = abs(_mean(probabilities) - _mean(actuals))
    recent_trades = trades[-config.current_samples:]
    expectancy, pf = _mean(row.get("pnl_pct") for row in recent_trades), profit_factor(row.get("pnl_pct") for row in recent_trades)
    metrics = {
        "predictedVsObserved": {"predicted": round(_mean(probabilities), 6), "observed": round(_mean(actuals), 6), "gap": round(probability_gap, 6), "status": _high(probability_gap, config.probability_gap_warn, config.probability_gap_critical)},
        "brierScore": _metric(current_brier, _high(current_brier, config.brier_warn, config.brier_critical)),
        "brierDegradation": _metric(brier_delta, _high(brier_delta, config.brier_delta_warn, config.brier_delta_critical)),
        "calibrationError": _metric(ece, _high(ece, config.ece_warn, config.ece_critical)),
        "campaignExpectancy": _metric(expectancy, _low(expectancy, config.expectancy_warn, config.expectancy_critical), unit="pnl_pct"),
        "profitFactor": _metric(pf, _low(pf, config.profit_factor_warn, config.profit_factor_critical)),
        "segments": _segments(recent_trades, config),
    }
    statuses = [value["status"] for key, value in metrics.items() if key != "segments"]
    segment_critical = any(item["status"] == "critical" for dimension in metrics["segments"].values() for item in dimension.values())
    status = "critical" if "critical" in statuses or segment_critical else "warn" if "warn" in statuses else "ok"
    return {"status": status, "samples": len(predicted), "currentSamples": len(current), "tradeSamples": len(recent_trades), "metrics": metrics}


def target_state(data_status: str, concept_status: str) -> str:
    statuses = {data_status, concept_status}
    if data_status == "critical" and concept_status == "critical":
        return "PAUSED"
    if "critical" in statuses:
        return "SHADOW_ONLY"
    if "warn" in statuses:
        return "DEGRADED"
    return "HEALTHY"


class DriftStateMachine:
    def __init__(self, config: DriftConfig | None = None) -> None:
        self.config = config or DriftConfig()
        self.state, self.pending_state, self.pending_count = "HEALTHY", "HEALTHY", 0
        self.since = time.time()
        self.history: list[dict[str, Any]] = []

    def update(self, desired: str, now: float | None = None) -> str:
        if desired not in STATES:
            raise ValueError(f"invalid drift state: {desired}")
        now = now or time.time()
        if desired == self.state:
            self.pending_state, self.pending_count = desired, 0
            return self.state
        if desired != self.pending_state:
            self.pending_state, self.pending_count = desired, 1
        else:
            self.pending_count += 1
        required = self.config.breach_evaluations if SEVERITY[desired] > SEVERITY[self.state] else self.config.recovery_evaluations
        if self.pending_count >= required:
            self.history.append({"state": self.state, "at": self.since})
            self.history = self.history[-50:]
            self.state, self.since, self.pending_count = desired, now, 0
        return self.state

    def snapshot(self) -> dict[str, Any]:
        policy = {
            "HEALTHY": {"mlEnforcementAllowed": True, "stackingMultiplier": 1.0, "newEntriesAllowed": True},
            "DEGRADED": {"mlEnforcementAllowed": True, "stackingMultiplier": 0.5, "newEntriesAllowed": True},
            "SHADOW_ONLY": {"mlEnforcementAllowed": False, "stackingMultiplier": 0.0, "newEntriesAllowed": True},
            "PAUSED": {"mlEnforcementAllowed": False, "stackingMultiplier": 0.0, "newEntriesAllowed": False},
        }[self.state]
        return {"state": self.state, "since": self.since, "pendingState": self.pending_state, "pendingCount": self.pending_count, "policy": policy, "history": self.history[-20:]}


_machine = DriftStateMachine()


async def evaluate_drift(now: float | None = None) -> dict[str, Any]:
    now = now or time.time()
    signals, trades = await kb.get_drift_signal_rows(), await kb.get_drift_trade_rows()
    data = evaluate_data_drift(signals, _machine.config, now)
    concept = evaluate_concept_drift(signals, trades, _machine.config)
    desired = target_state(data["status"], concept["status"])
    _machine.update(desired, now)
    return {
        **_machine.snapshot(), "desiredState": desired, "evaluatedAt": now,
        "dataDrift": data, "conceptDrift": concept, "thresholds": asdict(_machine.config),
        "safetyIsolation": {"entryAndStackingOnly": True, "tpSlMonitoring": "unaffected", "reconciliation": "unaffected", "learning": "unaffected"},
    }


def drift_state_snapshot() -> dict[str, Any]:
    return _machine.snapshot()
