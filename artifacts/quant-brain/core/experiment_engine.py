from __future__ import annotations

import hashlib
import math
import os
import random
import time
from dataclasses import dataclass
from typing import Any

from core.database import connect
from core import knowledge_base as kb
from core.score_calibration import run_score_calibration


ExperimentState = str


@dataclass(frozen=True)
class ExperimentArm:
    arm_id: str
    label: str
    allocation_start: int
    allocation_end: int
    policy_overrides: dict[str, Any]


@dataclass(frozen=True)
class ExperimentDefinition:
    experiment_id: str
    description: str
    policy_version: str
    state: ExperimentState
    arms: tuple[ExperimentArm, ...]
    guardrails: dict[str, float]
    promotion: dict[str, float]


DEFAULT_GUARDRAILS = {
    "maxTreatmentLossUsdt": float(os.environ.get("EXP_MAX_TREATMENT_LOSS_USDT", "25")),
    "maxDrawdownDeltaUsdt": float(os.environ.get("EXP_MAX_DRAWDOWN_DELTA_USDT", "15")),
    "maxAvgSlippageBps": float(os.environ.get("EXP_MAX_AVG_SLIPPAGE_BPS", "35")),
    "maxPipelineGapRate": float(os.environ.get("EXP_MAX_PIPELINE_GAP_RATE", "0.03")),
    "maxDuplicateRate": float(os.environ.get("EXP_MAX_DUPLICATE_RATE", "0.02")),
    "maxSessionLossUtilization": float(os.environ.get("EXP_MAX_SESSION_LOSS_UTILIZATION", "0.85")),
}

DEFAULT_PROMOTION = {
    "minSamplesPerArm": float(os.environ.get("EXP_MIN_SAMPLES_PER_ARM", "40")),
    "minProfitFactorLift": float(os.environ.get("EXP_MIN_PF_LIFT", "0.05")),
    "maxDrawdownWorseningUsdt": float(os.environ.get("EXP_MAX_PROMOTE_DD_WORSE_USDT", "5")),
    "minBootstrapConfidence": float(os.environ.get("EXP_MIN_BOOTSTRAP_CONF", "0.70")),
}


INITIAL_EXPERIMENTS: tuple[ExperimentDefinition, ...] = (
    ExperimentDefinition(
        experiment_id="EXP_EXIT_TRAILING",
        description="TP/SL fixo vs Exit Intelligence trailing/tighten",
        policy_version="exit-trailing-v1",
        state="RUNNING",
        arms=(
            ExperimentArm("control", "fixed_tp_sl", 0, 49, {"exitIntelligence": False, "trailing": False}),
            ExperimentArm("treatment", "exit_intelligence_trailing", 50, 99, {"exitIntelligence": True, "trailing": True}),
        ),
        guardrails=DEFAULT_GUARDRAILS,
        promotion=DEFAULT_PROMOTION,
    ),
    ExperimentDefinition(
        experiment_id="EXP_STACKING_DEPTH",
        description="Max stacking depth 1 vs 3 vs 5",
        policy_version="stacking-depth-v1",
        state="RUNNING",
        arms=(
            ExperimentArm("control", "max_depth_1", 0, 49, {"maxStackingDepth": 1}),
            ExperimentArm("treatment_a", "max_depth_3", 50, 74, {"maxStackingDepth": 3}),
            ExperimentArm("treatment_b", "max_depth_5", 75, 99, {"maxStackingDepth": 5}),
        ),
        guardrails=DEFAULT_GUARDRAILS,
        promotion=DEFAULT_PROMOTION,
    ),
    ExperimentDefinition(
        experiment_id="EXP_AGGRESSIVE_THRESHOLD",
        description="Min aggressiveScore 0.58 vs 0.52",
        policy_version="aggressive-threshold-v1",
        state="RUNNING",
        arms=(
            ExperimentArm("control", "min_score_0_58", 0, 49, {"minAggressiveScore": 0.58}),
            ExperimentArm("treatment", "min_score_0_52", 50, 99, {"minAggressiveScore": 0.52}),
        ),
        guardrails=DEFAULT_GUARDRAILS,
        promotion=DEFAULT_PROMOTION,
    ),
    ExperimentDefinition(
        experiment_id="EXP_SYMBOL_ROTATION",
        description="Equal symbols vs Adaptive Symbol Rotation",
        policy_version="symbol-rotation-v1",
        state="RUNNING",
        arms=(
            ExperimentArm("control", "equal_symbols", 0, 49, {"adaptiveSymbolRotation": False}),
            ExperimentArm("treatment", "adaptive_symbol_rotation", 50, 99, {"adaptiveSymbolRotation": True}),
        ),
        guardrails=DEFAULT_GUARDRAILS,
        promotion=DEFAULT_PROMOTION,
    ),
    ExperimentDefinition(
        experiment_id="EXP_COACH_RANKER",
        description="Legacy score ranking vs aggressiveScore ranking",
        policy_version="coach-ranker-ab-v1",
        state="RUNNING",
        arms=(
            ExperimentArm("control", "legacy_score_rank", 0, 49, {"rankBy": "score"}),
            ExperimentArm("treatment", "aggressive_score_rank", 50, 99, {"rankBy": "aggressiveScore"}),
        ),
        guardrails=DEFAULT_GUARDRAILS,
        promotion=DEFAULT_PROMOTION,
    ),
)


def experiment_definitions() -> tuple[ExperimentDefinition, ...]:
    return INITIAL_EXPERIMENTS


def _stable_bucket(key: str) -> int:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return int(digest[:12], 16) % 100


def assignment_key(payload: dict[str, Any]) -> str:
    for field in ("signalId", "signal_id", "campaignId", "campaign_id", "marketEventId", "sourceId", "source_id", "id"):
        value = payload.get(field)
        if value:
            return str(value)
    symbol = str(payload.get("symbol") or "unknown").upper()
    side = str(payload.get("positionSide") or payload.get("side") or "unknown").upper()
    hour = str(payload.get("hourUtc") or payload.get("hour_utc") or "")
    return f"{symbol}:{side}:{hour}"


def assign_experiment(experiment: ExperimentDefinition, key: str) -> dict[str, Any]:
    bucket = _stable_bucket(f"{experiment.experiment_id}:{key}")
    selected = experiment.arms[0]
    for arm in experiment.arms:
        if arm.allocation_start <= bucket <= arm.allocation_end:
            selected = arm
            break
    return {
        "experimentId": experiment.experiment_id,
        "experimentArm": selected.arm_id,
        "armLabel": selected.label,
        "policyVersion": experiment.policy_version,
        "state": experiment.state,
        "bucket": bucket,
        "policyOverrides": dict(selected.policy_overrides),
    }


def assign_signal_to_experiments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    key = assignment_key(payload)
    return [
        assign_experiment(experiment, key)
        for experiment in experiment_definitions()
        if experiment.state in {"RUNNING", "PROMOTED"}
    ]


def primary_assignment(assignments: list[dict[str, Any]], experiment_id: str | None = None) -> dict[str, Any] | None:
    if not assignments:
        return None
    if experiment_id:
        for assignment in assignments:
            if assignment["experimentId"] == experiment_id:
                return assignment
    return assignments[0]


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = _mean(values)
    return math.sqrt(sum((value - avg) ** 2 for value in values) / (len(values) - 1))


def _max_drawdown(values: list[float]) -> float:
    cumulative = 0.0
    peak = 0.0
    max_dd = 0.0
    for value in values:
        cumulative += value
        peak = max(peak, cumulative)
        max_dd = max(max_dd, peak - cumulative)
    return max_dd


def _profit_factor(values: list[float]) -> float:
    gross_profit = sum(value for value in values if value > 0)
    gross_loss = abs(sum(value for value in values if value < 0))
    if gross_loss == 0:
        return gross_profit if gross_profit > 0 else 0.0
    return gross_profit / gross_loss


def _sortino(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    downside = [min(0.0, value) for value in values]
    downside_dev = _std(downside)
    return _mean(values) / downside_dev if downside_dev > 0 else 0.0


def _confidence_interval(values: list[float]) -> dict[str, float]:
    if not values:
        return {"low": 0.0, "high": 0.0, "mean": 0.0}
    avg = _mean(values)
    if len(values) < 2:
        return {"low": round(avg, 6), "high": round(avg, 6), "mean": round(avg, 6)}
    margin = 1.96 * _std(values) / math.sqrt(len(values))
    return {"low": round(avg - margin, 6), "high": round(avg + margin, 6), "mean": round(avg, 6)}


def _bootstrap_pnl_confidence(values: list[float], control_avg: float = 0.0, rounds: int = 400) -> dict[str, Any]:
    if len(values) < 5:
        return {"confidence": 0.0, "low": 0.0, "high": 0.0, "reliable": False}
    rng = random.Random(hashlib.sha256(("bootstrap:" + ",".join(f"{v:.8f}" for v in values)).encode()).hexdigest())
    samples: list[float] = []
    for _ in range(rounds):
        sample = [values[rng.randrange(len(values))] for _ in values]
        samples.append(sum(sample))
    samples.sort()
    better = sum(1 for value in samples if value / len(values) > control_avg)
    return {
        "confidence": round(better / rounds, 4),
        "low": round(samples[int(rounds * 0.05)], 6),
        "high": round(samples[int(rounds * 0.95)], 6),
        "reliable": len(values) >= 20,
    }


def _arm_metrics(rows: list[dict[str, Any]], control_avg: float = 0.0) -> dict[str, Any]:
    pnl_values = [float(row.get("pnlUsdt") or 0.0) for row in rows]
    pnl_pct_values = [float(row.get("pnlPct") or 0.0) for row in rows]
    wins = sum(1 for value in pnl_values if value > 0)
    campaigns = {str(row.get("campaignId") or row.get("sourceId") or row.get("id") or "") for row in rows}
    campaigns.discard("")
    exit_reasons = [str(row.get("exitReason") or "").upper() for row in rows]
    slippages = [abs(float(row.get("slippageBps") or 0.0)) for row in rows]
    latencies = [float(row.get("latencyDragUsdt") or 0.0) for row in rows]
    mfe_values = [float(row.get("mfePct") or 0.0) for row in rows]
    mae_values = [float(row.get("maePct") or 0.0) for row in rows]
    sharpe_denominator = _std(pnl_values)
    score_quality = run_score_calibration(rows) if rows else {
        "scoreTruth": {"calibrationQuality": "INSUFFICIENT_DATA"},
        "bestScoringModel": None,
        "overconfidenceWarnings": [],
    }
    return {
        "trades": len(rows),
        "campaigns": len(campaigns),
        "winRate": round(wins / len(rows), 6) if rows else 0.0,
        "pnlUsdt": round(sum(pnl_values), 6),
        "profitFactor": round(_profit_factor(pnl_values), 6),
        "avgPnlPerTrade": round(_mean(pnl_values), 6),
        "maxDrawdown": round(_max_drawdown(pnl_values), 6),
        "avgMfe": round(_mean(mfe_values), 6),
        "avgMae": round(_mean(mae_values), 6),
        "tpHitRate": round(sum(1 for reason in exit_reasons if "TP" in reason) / len(rows), 6) if rows else 0.0,
        "slHitRate": round(sum(1 for reason in exit_reasons if "SL" in reason or "STOP" in reason) / len(rows), 6) if rows else 0.0,
        "timeoutRate": round(sum(1 for reason in exit_reasons if "TIMEOUT" in reason) / len(rows), 6) if rows else 0.0,
        "executionSlippage": round(_mean(slippages), 6),
        "latencyDrag": round(_mean(latencies), 6),
        "sharpe": round(_mean(pnl_values) / sharpe_denominator, 6) if sharpe_denominator > 0 else 0.0,
        "sortino": round(_sortino(pnl_values), 6),
        "confidenceInterval": _confidence_interval(pnl_values),
        "bootstrapPnlConfidence": _bootstrap_pnl_confidence(pnl_values, control_avg=control_avg),
        "avgPnlPct": round(_mean(pnl_pct_values), 6),
        "scoreCalibration": {
            "bestScoringModel": score_quality.get("bestScoringModel"),
            "scoreTruth": score_quality.get("scoreTruth"),
            "overconfidenceWarnings": score_quality.get("overconfidenceWarnings", []),
        },
    }


def _recommendation(experiment: ExperimentDefinition, arms: dict[str, dict[str, Any]]) -> str:
    control = arms.get("control") or {}
    control_trades = int(control.get("trades") or 0)
    if control_trades <= 0:
        return "continue"
    for arm_id, metrics in arms.items():
        if arm_id == "control":
            continue
        if _guardrail_triggered(experiment, control, metrics):
            return "stop"
        min_samples = int(experiment.promotion["minSamplesPerArm"])
        if control_trades < min_samples or int(metrics.get("trades") or 0) < min_samples:
            continue
        avg_better = float(metrics.get("avgPnlPerTrade") or 0) > float(control.get("avgPnlPerTrade") or 0)
        pf_better = float(metrics.get("profitFactor") or 0) >= float(control.get("profitFactor") or 0) + experiment.promotion["minProfitFactorLift"]
        dd_ok = float(metrics.get("maxDrawdown") or 0) <= float(control.get("maxDrawdown") or 0) + experiment.promotion["maxDrawdownWorseningUsdt"]
        conf = float((metrics.get("bootstrapPnlConfidence") or {}).get("confidence") or 0)
        if avg_better and pf_better and dd_ok and conf >= experiment.promotion["minBootstrapConfidence"]:
            return "promote"
    return "continue"


def _guardrail_triggered(
    experiment: ExperimentDefinition,
    control: dict[str, Any],
    treatment: dict[str, Any],
) -> bool:
    return (
        float(treatment.get("pnlUsdt") or 0) <= -experiment.guardrails["maxTreatmentLossUsdt"]
        or float(treatment.get("maxDrawdown") or 0) > float(control.get("maxDrawdown") or 0) + experiment.guardrails["maxDrawdownDeltaUsdt"]
        or float(treatment.get("executionSlippage") or 0) > experiment.guardrails["maxAvgSlippageBps"]
    )


async def ensure_experiment_tables() -> None:
    async with connect(kb.DB_PATH) as db:
        await db.executescript(
            """CREATE TABLE IF NOT EXISTS experiment_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                assignment_key TEXT NOT NULL,
                experiment_id TEXT NOT NULL,
                experiment_arm TEXT NOT NULL,
                policy_version TEXT NOT NULL,
                bucket INTEGER NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE(assignment_key, experiment_id)
            )"""
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_experiment_assignments_key "
            "ON experiment_assignments(assignment_key)"
        )
        await db.commit()


async def persist_assignments(payload: dict[str, Any], assignments: list[dict[str, Any]]) -> None:
    if not assignments:
        return
    key = assignment_key(payload)
    await ensure_experiment_tables()
    async with connect(kb.DB_PATH) as db:
        for assignment in assignments:
            await db.execute(
                """INSERT INTO experiment_assignments
                   (assignment_key, experiment_id, experiment_arm, policy_version, bucket, created_at)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(assignment_key, experiment_id) DO UPDATE SET
                     experiment_arm=excluded.experiment_arm,
                     policy_version=excluded.policy_version,
                     bucket=excluded.bucket""",
                (
                    key,
                    assignment["experimentId"],
                    assignment["experimentArm"],
                    assignment["policyVersion"],
                    int(assignment["bucket"]),
                    time.time(),
                ),
            )
        await db.commit()


async def infer_assignment_for_outcome(body: dict[str, Any]) -> dict[str, Any] | None:
    experiment_id = body.get("experimentId") or body.get("experiment_id")
    arm = body.get("experimentArm") or body.get("experiment_arm")
    policy_version = body.get("policyVersion") or body.get("policy_version")
    if experiment_id and arm:
        return {
            "experimentId": str(experiment_id),
            "experimentArm": str(arm),
            "policyVersion": str(policy_version or ""),
        }

    key = assignment_key(body)
    if key:
        await ensure_experiment_tables()
        async with connect(kb.DB_PATH) as db:
            row = await (await db.execute(
                """SELECT experiment_id, experiment_arm, policy_version
                   FROM experiment_assignments
                   WHERE assignment_key=?
                   ORDER BY id ASC
                   LIMIT 1""",
                (key,),
            )).fetchone()
        if row:
            return {
                "experimentId": str(row[0]),
                "experimentArm": str(row[1]),
                "policyVersion": str(row[2] or ""),
            }

    assignments = assign_signal_to_experiments(body)
    return primary_assignment(assignments)


async def experiment_status(days: int = 30) -> dict[str, Any]:
    await ensure_experiment_tables()
    since = time.time() - max(1, days) * 86400
    async with connect(kb.DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT source_id, symbol, side, pnl_pct, pnl_usdt, win,
                      btc_regime, slippage_bps, timestamp, experiment_id,
                      experiment_arm, policy_version, campaign_id, mfe_pct,
                      mae_pct, exit_reason, entry_aggressive_score,
                      execution_priority, coach_score, playbook_score,
                      playbook, ml_probability, COALESCE(regime, btc_regime)
               FROM trade_outcomes
               WHERE timestamp >= ? AND experiment_id IS NOT NULL AND experiment_id != ''
               ORDER BY timestamp ASC""",
            (since,),
        )).fetchall()

    normalized: list[dict[str, Any]] = []
    for row in rows:
        normalized.append({
            "sourceId": row[0],
            "symbol": row[1],
            "side": row[2],
            "pnlPct": float(row[3] or 0),
            "pnlUsdt": float(row[4] or 0),
            "win": int(row[5] or 0),
            "btcRegime": row[6],
            "slippageBps": float(row[7] or 0),
            "timestamp": float(row[8] or 0),
            "experimentId": row[9],
            "experimentArm": row[10],
            "policyVersion": row[11],
            "campaignId": row[12],
            "mfePct": float(row[13] or 0),
            "maePct": float(row[14] or 0),
            "exitReason": row[15],
            "aggressiveScore": float(row[16]) if row[16] is not None else None,
            "executionPriority": float(row[17]) if row[17] is not None else None,
            "coachScore": float(row[18]) if row[18] is not None else None,
            "playbookScore": float(row[19]) if row[19] is not None else None,
            "playbook": row[20],
            "mlProbability": float(row[21]) if row[21] is not None else None,
            "realizedPnl": float(row[4] or 0),
            "regime": row[22],
        })

    active: list[dict[str, Any]] = []
    for experiment in experiment_definitions():
        exp_rows = [row for row in normalized if row["experimentId"] == experiment.experiment_id]
        by_arm_rows = {
            arm.arm_id: [row for row in exp_rows if row["experimentArm"] == arm.arm_id]
            for arm in experiment.arms
        }
        control_avg = _mean([float(row["pnlUsdt"]) for row in by_arm_rows.get("control", [])])
        arm_metrics = {
            arm.arm_id: {
                "label": arm.label,
                "policyOverrides": arm.policy_overrides,
                **_arm_metrics(by_arm_rows.get(arm.arm_id, []), control_avg=control_avg),
            }
            for arm in experiment.arms
        }
        active.append({
            "experimentId": experiment.experiment_id,
            "description": experiment.description,
            "state": experiment.state,
            "policyVersion": experiment.policy_version,
            "arms": arm_metrics,
            "samples": sum(metrics["trades"] for metrics in arm_metrics.values()),
            "guardrails": experiment.guardrails,
            "promotionCriteria": experiment.promotion,
            "recommendation": _recommendation(experiment, arm_metrics),
        })

    return {
        "generatedAt": time.time(),
        "periodDays": days,
        "activeExperiments": active,
    }
