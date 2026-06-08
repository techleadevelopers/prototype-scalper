from __future__ import annotations

import json
import math
import time
from collections import defaultdict
from typing import Any

from core.database import Row, connect
from core import knowledge_base as kb

QUALITY_LABELS = {
    "EXCELLENT_EXECUTION",
    "ACCEPTABLE_EXECUTION",
    "LATE_ENTRY",
    "BAD_SLIPPAGE",
    "SPREAD_TOO_WIDE",
    "MISSED_MOVE",
    "DUPLICATE_EXECUTION",
    "POSITION_NOT_CONFIRMED",
    "EXIT_MONITOR_LATE",
    "API_DELAY",
    "STRATEGY_LOSS_NOT_EXECUTION",
}

_CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS execution_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT UNIQUE,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    is_demo INTEGER DEFAULT 0,
    entry_slippage_bps REAL DEFAULT 0,
    exit_slippage_bps REAL DEFAULT 0,
    total_entry_latency_ms REAL DEFAULT 0,
    order_to_ack_ms REAL DEFAULT 0,
    spread_at_signal REAL DEFAULT 0,
    spread_at_entry REAL DEFAULT 0,
    spread_at_exit REAL DEFAULT 0,
    price_move_during_latency_pct REAL DEFAULT 0,
    latency_damage_pct REAL DEFAULT 0,
    execution_drag_usdt REAL DEFAULT 0,
    execution_drag_pct REAL DEFAULT 0,
    strategy_would_have_won INTEGER DEFAULT 0,
    execution_caused_loss INTEGER DEFAULT 0,
    execution_quality TEXT NOT NULL,
    hour_utc INTEGER DEFAULT 0,
    raw TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_audits_symbol_ts ON execution_audits(symbol, ts);
CREATE INDEX IF NOT EXISTS idx_execution_audits_quality ON execution_audits(execution_quality);
CREATE INDEX IF NOT EXISTS idx_execution_audits_hour ON execution_audits(hour_utc, ts);
"""


async def init_execution_auditor() -> None:
    async with connect(kb.DB_PATH) as db:
        await db.executescript(_CREATE_TABLES)
        await db.commit()


def _num(data: dict[str, Any], *keys: str, default: float = 0.0) -> float:
    for key in keys:
        value = data.get(key)
        if value is not None and value != "":
            try:
                value = float(value)
                if math.isfinite(value):
                    return value
            except Exception:
                pass
    return default


def _str(data: dict[str, Any], *keys: str, default: str = "") -> str:
    for key in keys:
        value = data.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return default


def _ms(data: dict[str, Any], *keys: str) -> float | None:
    value = _num(data, *keys, default=0.0)
    return value if value > 0 else None


def _latency(start: float | None, end: float | None) -> float:
    if start is None or end is None:
        return 0.0
    return max(0.0, end - start)


def _adverse_slippage_bps(side: str, expected: float, actual: float, leg: str) -> float:
    if expected <= 0 or actual <= 0:
        return 0.0
    long_side = side.upper() == "LONG"
    if leg == "entry":
        adverse = actual - expected if long_side else expected - actual
    else:
        adverse = expected - actual if long_side else actual - expected
    return max(0.0, adverse / expected * 10_000)


def _signed_move_pct(side: str, start: float, end: float) -> float:
    if start <= 0 or end <= 0:
        return 0.0
    raw = (end - start) / start * 100
    return raw if side.upper() == "LONG" else -raw


def audit_trade_payload(payload: dict[str, Any]) -> dict[str, Any]:
    side = _str(payload, "positionSide", "position_side", "side", default="LONG").upper()
    source_id = _str(payload, "id", "sourceId", "source_id", "exchangeOrderId", default="")
    expected_entry = _num(payload, "expectedEntryPrice", "expected_entry_price", "markPriceBeforeOrder", "entryPrice")
    actual_entry = _num(payload, "actualAvgEntryPrice", "actual_avg_entry_price", "entryPrice")
    expected_exit = _num(payload, "expectedExitPrice", "expected_exit_price", "exitPrice")
    actual_exit = _num(payload, "actualExitPrice", "actual_exit_price", "exitPrice")
    qty = _num(payload, "quantity", "qty")
    margin = _num(payload, "marginUsed", "margin_used")
    realized_pnl = _num(payload, "realizedPnl", "realized_pnl", "pnl_usdt")
    fee = _num(payload, "fee", "feePaidUsdt", "fee_paid_usdt")

    signal_at = _ms(payload, "signalCreatedAt", "signal_created_at")
    qb_at = _ms(payload, "qbEvaluatedAt", "qb_evaluated_at")
    requested_at = _ms(payload, "orderRequestedAt", "order_requested_at")
    sent_at = _ms(payload, "orderSentAt", "order_sent_at")
    ack_at = _ms(payload, "orderAckAt", "order_ack_at")
    confirmed_at = _ms(payload, "positionConfirmedAt", "position_confirmed_at")
    closed_at = _ms(payload, "positionClosedAt", "position_closed_at", "exitTime")
    monitor_close_at = _ms(payload, "monitorDetectedCloseAt", "monitor_detected_close_at")

    signal_to_order_ms = _latency(signal_at, requested_at)
    order_to_ack_ms = _latency(sent_at or requested_at, ack_at)
    ack_to_position_ms = _latency(ack_at, confirmed_at)
    total_entry_latency_ms = _latency(signal_at or requested_at, confirmed_at or ack_at)

    entry_slippage_bps = _num(payload, "entrySlippageBps", "entry_slippage_bps", default=-1)
    if entry_slippage_bps < 0:
        entry_slippage_bps = _adverse_slippage_bps(side, expected_entry, actual_entry, "entry")
    exit_slippage_bps = _num(payload, "exitSlippageBps", "exit_slippage_bps", default=-1)
    if exit_slippage_bps < 0:
        exit_slippage_bps = _adverse_slippage_bps(side, expected_exit, actual_exit, "exit")

    spread_signal = _num(payload, "spreadAtSignal", "spread_at_signal", "spreadBps", "spread_bps")
    spread_entry = _num(payload, "spreadAtEntry", "spread_at_entry", "spreadBps", "spread_bps")
    spread_exit = _num(payload, "spreadAtExit", "spread_at_exit")
    price_move_latency = _signed_move_pct(side, expected_entry, actual_entry)
    latency_damage_pct = max(0.0, price_move_latency)
    notional = actual_entry * qty
    execution_drag_usdt = ((entry_slippage_bps + exit_slippage_bps) / 10_000) * notional
    execution_drag_pct = (execution_drag_usdt / margin * 100) if margin > 0 else 0.0

    mfe = _num(payload, "mfe", "mfePct", "maxFavorablePct")
    expected_tp_profit = _num(payload, "expectedTpProfit", "expected_tp_profit")
    target_pct = (expected_tp_profit / margin * 100) if margin > 0 and expected_tp_profit > 0 else 0.0
    strategy_would_have_won = bool(mfe > 0 and target_pct > 0 and mfe >= target_pct)
    duplicate = bool(payload.get("duplicateExecution") or payload.get("duplicate_execution"))
    position_not_confirmed = confirmed_at is None and ack_at is not None
    exit_monitor_late = bool(monitor_close_at and closed_at and monitor_close_at - closed_at > 5_000)

    quality = "ACCEPTABLE_EXECUTION"
    if duplicate:
        quality = "DUPLICATE_EXECUTION"
    elif position_not_confirmed:
        quality = "POSITION_NOT_CONFIRMED"
    elif exit_monitor_late:
        quality = "EXIT_MONITOR_LATE"
    elif order_to_ack_ms >= 2_500:
        quality = "API_DELAY"
    elif spread_signal >= 8 or spread_entry >= 8:
        quality = "SPREAD_TOO_WIDE"
    elif entry_slippage_bps >= 8 or exit_slippage_bps >= 8:
        quality = "BAD_SLIPPAGE"
    elif total_entry_latency_ms >= 2_000:
        quality = "LATE_ENTRY"
    elif price_move_latency >= 0.08:
        quality = "MISSED_MOVE"
    elif realized_pnl < 0 and not strategy_would_have_won:
        quality = "STRATEGY_LOSS_NOT_EXECUTION"
    elif total_entry_latency_ms <= 400 and entry_slippage_bps <= 1.5 and spread_entry <= 2:
        quality = "EXCELLENT_EXECUTION"

    execution_caused_loss = bool(
        realized_pnl < 0
        and (
            strategy_would_have_won
            or quality in {"LATE_ENTRY", "MISSED_MOVE", "BAD_SLIPPAGE", "EXIT_MONITOR_LATE", "API_DELAY"}
            or execution_drag_usdt + fee >= abs(realized_pnl)
        )
    )

    return {
        "sourceId": source_id,
        "symbol": _str(payload, "symbol", default="").upper(),
        "side": side,
        "isDemo": bool(payload.get("isDemo", payload.get("is_demo", False))),
        "signalToOrderMs": round(signal_to_order_ms, 3),
        "orderToAckMs": round(order_to_ack_ms, 3),
        "ackToPositionMs": round(ack_to_position_ms, 3),
        "totalEntryLatencyMs": round(total_entry_latency_ms, 3),
        "expectedEntryPrice": expected_entry,
        "actualEntryPrice": actual_entry,
        "entrySlippagePct": round(entry_slippage_bps / 100, 6),
        "entrySlippageBps": round(entry_slippage_bps, 4),
        "expectedExitPrice": expected_exit,
        "actualExitPrice": actual_exit,
        "exitSlippagePct": round(exit_slippage_bps / 100, 6),
        "exitSlippageBps": round(exit_slippage_bps, 4),
        "spreadAtSignal": spread_signal,
        "spreadAtEntry": spread_entry,
        "spreadAtExit": spread_exit,
        "priceMoveDuringLatencyPct": round(price_move_latency, 6),
        "latencyDamagePct": round(latency_damage_pct, 6),
        "executionDragUsdt": round(execution_drag_usdt, 6),
        "executionDragPct": round(execution_drag_pct, 6),
        "strategyWouldHaveWon": strategy_would_have_won,
        "executionCausedLoss": execution_caused_loss,
        "executionQuality": quality,
        "hourUtc": int(payload.get("hourUtc", time.gmtime().tm_hour) or 0),
        "raw": payload,
    }


async def record_trade_audit(payload: dict[str, Any]) -> dict[str, Any]:
    await init_execution_auditor()
    audit = audit_trade_payload(payload)
    async with connect(kb.DB_PATH) as db:
        await db.execute(
            """INSERT INTO execution_audits
               (source_id, symbol, side, is_demo, entry_slippage_bps, exit_slippage_bps,
                total_entry_latency_ms, order_to_ack_ms, spread_at_signal, spread_at_entry,
                spread_at_exit, price_move_during_latency_pct, latency_damage_pct,
                execution_drag_usdt, execution_drag_pct, strategy_would_have_won,
                execution_caused_loss, execution_quality, hour_utc, raw, ts)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source_id) DO UPDATE SET
                 entry_slippage_bps=excluded.entry_slippage_bps,
                 exit_slippage_bps=excluded.exit_slippage_bps,
                 total_entry_latency_ms=excluded.total_entry_latency_ms,
                 execution_quality=excluded.execution_quality,
                 raw=excluded.raw,
                 ts=excluded.ts""",
            (
                audit["sourceId"] or None,
                audit["symbol"],
                audit["side"],
                1 if audit["isDemo"] else 0,
                audit["entrySlippageBps"],
                audit["exitSlippageBps"],
                audit["totalEntryLatencyMs"],
                audit["orderToAckMs"],
                audit["spreadAtSignal"],
                audit["spreadAtEntry"],
                audit["spreadAtExit"],
                audit["priceMoveDuringLatencyPct"],
                audit["latencyDamagePct"],
                audit["executionDragUsdt"],
                audit["executionDragPct"],
                1 if audit["strategyWouldHaveWon"] else 0,
                1 if audit["executionCausedLoss"] else 0,
                audit["executionQuality"],
                audit["hourUtc"],
                json.dumps(audit["raw"]),
                time.time(),
            ),
        )
        await db.commit()
    return audit


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(len(ordered) * pct))
    return round(float(ordered[idx]), 4)


def _avg(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


def _execution_adjuster(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_symbol: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_symbol[str(row["symbol"])].append(row)
    result = []
    for symbol, sym_rows in by_symbol.items():
        entry = [float(r["entry_slippage_bps"] or 0) for r in sym_rows]
        exit_ = [float(r["exit_slippage_bps"] or 0) for r in sym_rows]
        latency = [float(r["total_entry_latency_ms"] or 0) for r in sym_rows]
        missed = sum(1 for r in sym_rows if r["execution_quality"] in {"MISSED_MOVE", "LATE_ENTRY"})
        drag_pct = [float(r["execution_drag_pct"] or 0) for r in sym_rows]
        penalty = min(0.35, _avg(entry) / 100 + _avg(latency) / 20_000 + missed / max(1, len(sym_rows)) * 0.15)
        result.append({
            "symbol": symbol,
            "avgEntrySlippageBps": _avg(entry),
            "avgExitSlippageBps": _avg(exit_),
            "avgLatencyMs": _avg(latency),
            "missedMoveRate": round(missed / max(1, len(sym_rows)), 4),
            "executionProfitDragPct": _avg(drag_pct),
            "recommendedPenalty": round(penalty, 4),
            "recommendations": _recommendations(_avg(entry), _avg(exit_), _avg(latency), missed / max(1, len(sym_rows)), penalty),
        })
    return sorted(result, key=lambda x: x["recommendedPenalty"], reverse=True)


def _recommendations(entry_bps: float, exit_bps: float, latency_ms: float, missed_rate: float, penalty: float) -> list[str]:
    recs = []
    if penalty > 0:
        recs.append(f"increase_min_threshold_by_{round(penalty, 3)}")
        recs.append(f"reduce_priority_by_{round(penalty, 3)}")
        recs.append(f"reduce_size_multiplier_to_{round(max(0.25, 1 - penalty), 3)}")
    if entry_bps >= 5:
        recs.append("avoid_market_order_when_spread_is_wide")
    if latency_ms >= 1500 or missed_rate >= 0.2:
        recs.append("avoid_high_latency_hours")
    if exit_bps >= 5:
        recs.append("tighten_exit_monitoring")
    return recs


async def get_execution_audit_report(hours: int = 24) -> dict[str, Any]:
    await init_execution_auditor()
    since = time.time() - max(1, hours) * 3600
    async with connect(kb.DB_PATH) as db:
        db.row_factory = Row
        rows_raw = await (await db.execute(
            "SELECT * FROM execution_audits WHERE ts >= ? ORDER BY ts DESC",
            (since,),
        )).fetchall()
    rows = [dict(r) for r in rows_raw]
    latency = [float(r["total_entry_latency_ms"] or 0) for r in rows]
    slippage = [float(r["entry_slippage_bps"] or 0) + float(r["exit_slippage_bps"] or 0) for r in rows]
    drag_usdt = [float(r["execution_drag_usdt"] or 0) for r in rows]
    drag_pct = [float(r["execution_drag_pct"] or 0) for r in rows]
    lost_by_execution = sum(1 for r in rows if int(r["execution_caused_loss"] or 0) == 1)
    losses = [r for r in rows if _num(json.loads(r["raw"]), "realizedPnl", "realized_pnl", "pnl_usdt") < 0]
    missed = sum(1 for r in rows if r["execution_quality"] in {"MISSED_MOVE", "LATE_ENTRY"})

    symbol_slip = defaultdict(list)
    hour_latency = defaultdict(list)
    for r in rows:
        symbol_slip[r["symbol"]].append(float(r["entry_slippage_bps"] or 0) + float(r["exit_slippage_bps"] or 0))
        hour_latency[int(r["hour_utc"] or 0)].append(float(r["total_entry_latency_ms"] or 0))

    adjusters = _execution_adjuster(rows)
    return {
        "source": "quant-brain",
        "hours": hours,
        "totalTradesAudited": len(rows),
        "avgLatencyMs": _avg(latency),
        "p95LatencyMs": _percentile(latency, 0.95),
        "avgSlippageBps": _avg(slippage),
        "p95SlippageBps": _percentile(slippage, 0.95),
        "executionDragUsdt": round(sum(drag_usdt), 6),
        "executionDragPct": _avg(drag_pct),
        "worstSymbolsBySlippage": [
            {"symbol": sym, "avgSlippageBps": _avg(vals)}
            for sym, vals in sorted(symbol_slip.items(), key=lambda item: _avg(item[1]), reverse=True)[:10]
        ],
        "worstHoursByLatency": [
            {"hourUtc": hour, "avgLatencyMs": _avg(vals)}
            for hour, vals in sorted(hour_latency.items(), key=lambda item: _avg(item[1]), reverse=True)[:10]
        ],
        "missedMoveRate": round(missed / max(1, len(rows)), 4),
        "tradesLostByStrategy": max(0, len(losses) - lost_by_execution),
        "tradesLostByExecution": lost_by_execution,
        "executionEdgeAdjuster": adjusters,
        "recommendedConfigChanges": [
            rec
            for item in adjusters[:5]
            for rec in item["recommendations"]
        ][:20],
        "qualityBreakdown": dict(sorted(
            ((label, sum(1 for r in rows if r["execution_quality"] == label)) for label in QUALITY_LABELS),
            key=lambda item: item[1],
            reverse=True,
        )),
    }
