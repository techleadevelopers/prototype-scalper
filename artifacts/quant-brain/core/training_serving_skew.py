from __future__ import annotations

import json
import math
import time
import hashlib
from typing import Any

from core import knowledge_base as kb
from core.database import Row, connect
from core.shadow_model import _feature_dict

SKEW_TOLERANCE = 1e-6


def canonical_feature_vector(row: dict[str, Any]) -> dict[str, Any]:
    raw = _feature_dict(row)
    vector: dict[str, Any] = {}
    for key in sorted(raw):
        value = raw[key]
        if isinstance(value, bool):
            vector[key] = int(value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            numeric = float(value)
            vector[key] = 0.0 if abs(numeric) == 0 else numeric
        elif value is None:
            vector[key] = ""
        else:
            vector[key] = str(value)
    return vector


def feature_hash(vector: dict[str, Any]) -> str:
    encoded = json.dumps(vector, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def compare_vectors(
    serving: dict[str, Any],
    recalculated: dict[str, Any],
    *,
    tolerance: float = SKEW_TOLERANCE,
) -> tuple[float, list[dict[str, Any]]]:
    max_abs_diff = 0.0
    mismatches: list[dict[str, Any]] = []
    for key in sorted(set(serving) | set(recalculated)):
        left = serving.get(key)
        right = recalculated.get(key)
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            diff = abs(float(left) - float(right))
            if not math.isfinite(diff):
                diff = float("inf")
            max_abs_diff = max(max_abs_diff, diff)
            if diff > tolerance:
                mismatches.append({"feature": key, "serving": left, "recalculated": right, "absDiff": diff})
        elif left != right:
            max_abs_diff = max(max_abs_diff, float("inf"))
            mismatches.append({"feature": key, "serving": left, "recalculated": right, "absDiff": None})
    return max_abs_diff, mismatches


async def record_serving_vector(
    *,
    signal_id: str,
    prediction_id: str | None,
    row: dict[str, Any],
    model_version: str | None,
    feature_version: str | None,
) -> dict[str, Any]:
    if not signal_id:
        return {"recorded": False, "reason": "missing_signal_id"}
    vector = canonical_feature_vector(row)
    digest = feature_hash(vector)
    async with connect(kb.DB_PATH) as db:
        await db.execute(
            """INSERT INTO training_serving_feature_audits
               (signal_id, prediction_id, phase, model_version, feature_version,
                feature_hash, vector_json, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                signal_id,
                prediction_id,
                "serving",
                model_version,
                feature_version,
                digest,
                json.dumps(vector, sort_keys=True, separators=(",", ":"), ensure_ascii=True),
                "RECORDED",
                time.time(),
            ),
        )
        await db.commit()
    return {"recorded": True, "featureHash": digest, "featureCount": len(vector)}


async def audit_finalized_signal(signal: dict[str, Any]) -> dict[str, Any]:
    signal_id = str(signal.get("signal_id") or "")
    if not signal_id:
        return {"status": "SKIPPED", "reason": "missing_signal_id"}
    row = {
        "symbol": signal.get("symbol", ""),
        "side": signal.get("side", ""),
        "context_key": signal.get("context_key", ""),
        "decision_group": signal.get("decision_group", "UNKNOWN"),
        "target_configured_move_pct": signal.get("target_configured_move_pct", 0),
        "estimated_cost_pct": signal.get("estimated_cost_pct", 0),
        "features": signal.get("features") or {},
    }
    recalculated = canonical_feature_vector(row)
    recalculated_hash = feature_hash(recalculated)

    async with connect(kb.DB_PATH) as db:
        db.row_factory = Row
        serving_row = await (await db.execute(
            """SELECT *
               FROM training_serving_feature_audits
               WHERE signal_id=? AND phase='serving'
               ORDER BY created_at DESC
               LIMIT 1""",
            (signal_id,),
        )).fetchone()
        if serving_row is None:
            status = "MISSING_SERVING_VECTOR"
            max_abs_diff = None
            mismatches: list[dict[str, Any]] = []
        else:
            serving = json.loads(dict(serving_row)["vector_json"])
            max_abs_diff, mismatches = compare_vectors(serving, recalculated)
            status = "OK" if not mismatches else "CRITICAL_SKEW"

        await db.execute(
            """INSERT INTO training_serving_feature_audits
               (signal_id, prediction_id, phase, model_version, feature_version,
                feature_hash, vector_json, max_abs_diff, mismatched_features, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                signal_id,
                dict(serving_row).get("prediction_id") if serving_row is not None else None,
                "finalized_recalc",
                dict(serving_row).get("model_version") if serving_row is not None else None,
                signal.get("feature_version"),
                recalculated_hash,
                json.dumps(recalculated, sort_keys=True, separators=(",", ":"), ensure_ascii=True),
                max_abs_diff,
                json.dumps(mismatches[:50], sort_keys=True, separators=(",", ":"), ensure_ascii=True),
                status,
                time.time(),
            ),
        )
        await db.commit()

    return {
        "status": status,
        "signalId": signal_id,
        "featureHash": recalculated_hash,
        "maxAbsDiff": max_abs_diff,
        "mismatches": mismatches[:10],
    }


async def skew_status(limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit or 20), 200))
    async with connect(kb.DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            """SELECT signal_id, prediction_id, phase, model_version, feature_hash,
                      max_abs_diff, mismatched_features, status, created_at
               FROM training_serving_feature_audits
               ORDER BY created_at DESC
               LIMIT ?""",
            (limit,),
        )).fetchall()
        critical = await (await db.execute(
            """SELECT COUNT(*)
               FROM training_serving_feature_audits
               WHERE status='CRITICAL_SKEW'"""
        )).fetchone()
    return {
        "tolerance": SKEW_TOLERANCE,
        "criticalSkewCount": int(critical[0] or 0),
        "recent": [dict(row) for row in rows],
    }
