from __future__ import annotations

from fastapi import HTTPException

from core import knowledge_base as kb
from core.experiment_engine import infer_assignment_for_outcome
from core.execution_auditor import record_trade_audit
from core.pipeline_auditor import validate_learning_eligibility


def _first_payload_value(payload: dict, *fields: str, default=None):
    for field in fields:
        value = payload.get(field)
        if value is not None:
            return value
    return default


def _float_or_none(value):
    if value is None:
        return None
    return float(value)


def _str_or_none(value):
    if value is None:
        return None
    text = str(value)
    return text if text else None


def payload_source_id(payload: dict) -> str:
    for field in ("sourceId", "source_id", "id", "campaignId", "campaign_id", "signalId", "signal_id"):
        value = payload.get(field)
        if value is not None and str(value).strip():
            return str(value)
    return ""


async def trade_outcome_exists(source_id: str) -> bool:
    if not source_id:
        return False
    async with kb.connect(kb.DB_PATH) as db:
        row = await (await db.execute(
            "SELECT 1 FROM trade_outcomes WHERE source_id=? LIMIT 1",
            (source_id,),
        )).fetchone()
    return row is not None


def trade_payload_to_record_args(payload: dict, experiment: dict | None = None) -> dict:
    experiment = experiment or {}
    side = _first_payload_value(payload, "positionSide", "position_side", "side")
    pnl_pct = payload.get("pnl_pct", payload.get("pnlPct"))
    if pnl_pct is None:
        realized_pnl = float(_first_payload_value(payload, "realizedPnl", "realized_pnl", default=0))
        margin_used = float(_first_payload_value(payload, "marginUsed", "margin_used", default=0))
        pnl_pct = (realized_pnl / margin_used * 100) if margin_used > 0 else realized_pnl

    pnl_usdt = _first_payload_value(payload, "pnl_usdt", "realizedPnl", "realized_pnl", default=0)
    policy_version = _first_payload_value(payload, "policyVersion", "policy_version")

    return {
        "source_id": payload_source_id(payload) or None,
        "source": str(payload.get("source") or "manual"),
        "is_demo": bool(_first_payload_value(payload, "isDemo", "is_demo", default=False)),
        "symbol": payload["symbol"],
        "side": side,
        "pnl_pct": float(pnl_pct),
        "pnl_usdt": float(pnl_usdt) if pnl_usdt else 0.0,
        "entry_price": float(_first_payload_value(payload, "entry_price", "entryPrice", default=0)),
        "exit_price": float(_first_payload_value(payload, "exit_price", "exitPrice", default=0)),
        "oi_change": float(_first_payload_value(payload, "oi_change", "oiChange", default=0)),
        "funding": float(_first_payload_value(payload, "funding", "fundingRate", default=0)),
        "volume_ratio": float(_first_payload_value(payload, "volume_ratio", "volumeRatio", default=1)),
        "btc_regime": _first_payload_value(payload, "btc_regime", "btcRegime", "regime", default="NEUTRAL"),
        "rsi": float(_first_payload_value(payload, "rsi", "rsiAtEntry", default=50)),
        "ema_cross": _first_payload_value(payload, "ema_cross", "emaCross", default="FLAT"),
        "slippage_bps": float(_first_payload_value(payload, "slippage_bps", "slippageBps", default=0)),
        "fee_paid_usdt": float(_first_payload_value(payload, "fee_paid_usdt", "feePaidUsdt", default=0)),
        "experiment_id": _str_or_none(experiment.get("experimentId") or _first_payload_value(payload, "experimentId", "experiment_id")),
        "experiment_arm": _str_or_none(experiment.get("experimentArm") or _first_payload_value(payload, "experimentArm", "experiment_arm")),
        "policy_version": _str_or_none(policy_version),
        "campaign_id": _str_or_none(_first_payload_value(payload, "campaignId", "campaign_id")),
        "mfe_pct": _float_or_none(_first_payload_value(payload, "mfePct", "mfe_pct", "mfe")),
        "mae_pct": _float_or_none(_first_payload_value(payload, "maePct", "mae_pct", "mae")),
        "exit_reason": _str_or_none(_first_payload_value(payload, "exitReason", "exit_reason")),
        "latency_drag_usdt": _float_or_none(_first_payload_value(payload, "latencyDragUsdt", "latency_drag_usdt")),
        "regime": _first_payload_value(payload, "regime"),
        "playbook": _first_payload_value(payload, "playbook"),
        "setup_type": _first_payload_value(payload, "setupType", "setup_type", "setup"),
        "regime_confidence": _float_or_none(_first_payload_value(payload, "regimeConfidence", "regime_confidence")),
        "playbook_version": _str_or_none(_first_payload_value(payload, "playbookVersion", "playbook_version")),
        "stacking_depth": int(_first_payload_value(payload, "stackingDepth", "stacking_depth", default=1)),
        "execution_priority": _float_or_none(_first_payload_value(payload, "executionPriority", "execution_priority", "score")),
        "coach_score": _float_or_none(_first_payload_value(payload, "coachScore", "coach_score", "executionPriority", "score")),
        "playbook_score": _float_or_none(_first_payload_value(payload, "playbookScore", "playbook_score")),
        "ml_probability": _float_or_none(_first_payload_value(payload, "mlProbability", "calibratedProbability", "calibrated_probability")),
        "execution_quality": _float_or_none(_first_payload_value(payload, "executionQuality", "execution_quality")),
        "signal_id": _str_or_none(_first_payload_value(payload, "signalId", "signal_id")) or "",
        "entry_aggressive_score": _float_or_none(_first_payload_value(payload, "aggressiveScore", "entryAggressiveScore", "entry_aggressive_score")),
        "risk_tier": _first_payload_value(payload, "risk_tier", "riskTier"),
        "size_multiplier": _float_or_none(_first_payload_value(payload, "sizeMultiplier", "size_multiplier")),
        "size_reason": _first_payload_value(payload, "size_reason", "sizeReason"),
        "recommended_margin": _float_or_none(_first_payload_value(payload, "recommendedMargin", "recommended_margin")),
        "recommended_leverage": _float_or_none(_first_payload_value(payload, "recommendedLeverage", "recommended_leverage")),
        "max_loss_if_stop": _float_or_none(_first_payload_value(payload, "maxLossIfStop", "max_loss_if_stop")),
        "notional": _float_or_none(_first_payload_value(payload, "notional")),
        "strategy_version": _str_or_none(_first_payload_value(payload, "strategyVersion", "strategy_version")),
        "config_version": _str_or_none(_first_payload_value(payload, "configVersion", "config_version")),
        "model_version": _str_or_none(_first_payload_value(payload, "modelVersion", "model_version")),
        "label_version": _str_or_none(_first_payload_value(payload, "labelVersion", "label_version")),
        "market_event_id": _str_or_none(_first_payload_value(payload, "marketEventId", "market_event_id")),
        "source_type": _str_or_none(_first_payload_value(payload, "sourceType", "source_type")),
        "sizing": _first_payload_value(payload, "sizing"),
    }


async def record_trade(body: dict) -> dict:
    required = ["symbol"]
    for r in required:
        if r not in body:
            raise HTTPException(400, f"Campo obrigatorio: {r}")
    source_id = payload_source_id(body)
    if not source_id:
        raise HTTPException(400, "Required field: sourceId")
    eligibility = validate_learning_eligibility(body)
    if not eligibility.learning_eligible:
        raise HTTPException(
            422,
            {
                "error": "pipeline_integrity_blocked",
                "blockedReasons": eligibility.blocked_reasons,
            },
        )
    side = body.get("positionSide") or body.get("position_side") or body.get("side")
    if not side:
        raise HTTPException(400, "Required field: side or positionSide")
    pnl_pct = body.get("pnl_pct")
    if pnl_pct is None:
        realized_pnl = float(body.get("realizedPnl", body.get("realized_pnl", 0)))
        margin_used = float(body.get("marginUsed", body.get("margin_used", 0)))
        pnl_pct = (realized_pnl / margin_used * 100) if margin_used > 0 else realized_pnl

    pnl_usdt = body.get("pnl_usdt", body.get("realizedPnl", 0))
    experiment = await infer_assignment_for_outcome(body) or {}
    duplicate = await trade_outcome_exists(source_id)

    record_args = trade_payload_to_record_args(body, experiment)
    recorded = await kb.record_trade_outcome(**record_args)
    execution_audit = await record_trade_audit(body)

    return {
        "ok": True,
        "sourceId": source_id,
        "recorded": bool(recorded or duplicate),
        "duplicate": duplicate,
        "symbol": body["symbol"],
        "pnl_pct": float(record_args["pnl_pct"]),
        "experiment": experiment,
        "executionAudit": execution_audit,
    }


async def record_trades_batch(body: list[dict]) -> dict:
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array")
    results = []
    for item in body[:200]:
        if not isinstance(item, dict):
            continue
        side = item.get("positionSide") or item.get("position_side") or item.get("side")
        if not item.get("symbol") or not side:
            continue
        source_id = payload_source_id(item)
        eligibility = validate_learning_eligibility(item)
        if not eligibility.learning_eligible:
            results.append({
                "sourceId": source_id,
                "recorded": False,
                "duplicate": False,
                "blockedReasons": eligibility.blocked_reasons,
            })
            continue
        experiment = await infer_assignment_for_outcome(item) or {}
        duplicate = await trade_outcome_exists(source_id)
        record_args = trade_payload_to_record_args(item, experiment)
        if duplicate and _first_payload_value(item, "policyVersion", "policy_version") is None:
            record_args["policy_version"] = None
        recorded = await kb.record_trade_outcome(**record_args)
        audit = await record_trade_audit(item)
        results.append({
            "sourceId": str(record_args.get("source_id") or source_id),
            "recorded": bool(recorded or duplicate),
            "duplicate": duplicate,
            "blockedReasons": [],
            "experiment": experiment,
            "executionQuality": audit["executionQuality"],
        })
    return {"ok": True, "count": len(results), "results": results, "items": results}
