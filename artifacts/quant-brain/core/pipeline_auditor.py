"""Pipeline integrity checks for learning ingestion.

The Node backend is the primary execution auditor. This module is the last
line of defense for Quant Brain endpoints so direct writes cannot train on
broken trade lineage.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LearningEligibility:
    learning_eligible: bool
    blocked_reasons: list[str]


def _num(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def _source_type(payload: dict[str, Any]) -> str:
    explicit = str(payload.get("sourceType") or payload.get("source_type") or "").lower()
    if explicit in {"demo", "live", "hypothetical", "shadow"}:
        return explicit
    source = str(payload.get("source") or "").lower()
    is_demo = bool(payload.get("isDemo", payload.get("is_demo", False)))
    if source == "bingx-vst" or is_demo:
        return "demo"
    if source == "bingx-live":
        return "live"
    return "unknown"


def has_environment_mismatch(payload: dict[str, Any]) -> bool:
    source = str(payload.get("source") or "").lower()
    is_demo = bool(payload.get("isDemo", payload.get("is_demo", False)))
    source_type = _source_type(payload)
    if source == "bingx-vst" and source_type == "live":
        return True
    if source == "bingx-live" and source_type == "demo":
        return True
    if is_demo and source_type == "live":
        return True
    if (not is_demo) and source_type == "demo":
        return True
    return False


def entry_side_matches_position(payload: dict[str, Any]) -> bool:
    position_side = str(payload.get("positionSide") or payload.get("position_side") or "").upper()
    side = str(payload.get("entrySide") or payload.get("side") or "").upper()
    if position_side == "LONG":
        return side in {"BUY", "LONG"}
    if position_side == "SHORT":
        return side in {"SELL", "SHORT"}
    return False


def validate_learning_eligibility(payload: dict[str, Any]) -> LearningEligibility:
    reasons: list[str] = []

    signal_id = payload.get("signalId") or payload.get("signal_id")
    market_event_id = payload.get("marketEventId") or payload.get("market_event_id")
    entry_price = _num(payload.get("entryPrice", payload.get("entry_price")))
    exit_price = _num(payload.get("exitPrice", payload.get("exit_price")))
    entry_time = _num(payload.get("entryTime", payload.get("entry_time")))
    exit_time = _num(payload.get("exitTime", payload.get("exit_time")))
    realized = _num(payload.get("realizedPnl", payload.get("realized_pnl", payload.get("pnl_usdt"))))
    pnl_pct = _num(payload.get("pnl_pct"))

    if not signal_id:
        reasons.append("missing_signalId")
    if not market_event_id:
        reasons.append("missing_marketEventId")
    if not entry_side_matches_position(payload):
        reasons.append("side_mismatch")
    if entry_price is None or entry_price <= 0:
        reasons.append("missing_entryPrice")
    if exit_price is None or exit_price <= 0:
        reasons.append("missing_exitPrice")
    if entry_time is None or entry_time <= 0:
        reasons.append("missing_entryTimestamp")
    if exit_time is None or exit_time <= 0:
        reasons.append("missing_exitTimestamp")
    if realized is None and pnl_pct is None:
        reasons.append("invalid_outcome")
    if has_environment_mismatch(payload):
        reasons.append("environment_mismatch")

    return LearningEligibility(not reasons, reasons)
