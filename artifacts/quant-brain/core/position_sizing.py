"""
Capital compounding / position sizing engine.

The engine scales margin from realized account equity and current edge quality.
It never increases size because the previous trade lost.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, asdict
from typing import Any, Literal

RiskTier = Literal["MICRO", "SCOUT", "BASE", "BOOST", "AGGRESSIVE", "MAX_SNIPER"]

TIER_MULTIPLIER: dict[RiskTier, float] = {
    "MICRO": 0.25,
    "SCOUT": 0.50,
    "BASE": 1.00,
    "BOOST": 1.25,
    "AGGRESSIVE": 1.50,
    "MAX_SNIPER": 2.00,
}
TIER_ORDER: list[RiskTier] = ["MICRO", "SCOUT", "BASE", "BOOST", "AGGRESSIVE", "MAX_SNIPER"]


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value) if value is not None else fallback
    except Exception:
        return fallback


def _bool_env(key: str, fallback: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return fallback
    return raw.lower() in ("1", "true", "yes", "on")


def _env_num(key: str, fallback: float) -> float:
    return _num(os.environ.get(key), fallback)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


@dataclass(frozen=True)
class PositionSizingConfig:
    enabled: bool
    min_margin: float
    base_risk_pct: float
    max_risk_pct_per_trade: float
    max_total_risk_pct: float
    max_symbol_risk_pct: float
    max_concurrent_positions: int
    max_margin_utilization: float
    demo_learning_aggressive: bool


def load_config(config: dict | None = None) -> PositionSizingConfig:
    config = config or {}
    arm = str(config.get("experimentArm") or os.environ.get("EXPERIMENT_ARM", "")).lower()
    aggressive = arm == "demo_learning_aggressive" or str(config.get("activeMode", "")).lower() == "aggressive"
    return PositionSizingConfig(
        enabled=_bool_env("POSITION_SIZING_ENABLED", True),
        min_margin=_env_num("MIN_MARGIN", _num(config.get("marginPerTrade"), 5.0)),
        base_risk_pct=_env_num("BASE_RISK_PCT", 0.005),
        max_risk_pct_per_trade=_env_num("MAX_RISK_PCT_PER_TRADE", 0.025 if aggressive else 0.015),
        max_total_risk_pct=_env_num("MAX_TOTAL_RISK_PCT", 0.12 if aggressive else 0.08),
        max_symbol_risk_pct=_env_num("MAX_SYMBOL_RISK_PCT", 0.05 if aggressive else 0.03),
        max_concurrent_positions=int(_env_num("MAX_CONCURRENT_POSITIONS", _num(config.get("maxConcurrentPositions"), 10))),
        max_margin_utilization=_env_num("MAX_MARGIN_UTILIZATION", _num(config.get("maxMarginUtilization"), 0.5)),
        demo_learning_aggressive=aggressive,
    )


def _initial_tier(score: float, rotation_state: str, slippage_bps: float) -> RiskTier | str:
    if score < 0.55:
        return "NO_TRADE"
    if score >= 0.85 and rotation_state == "HOT" and slippage_bps <= 3:
        return "MAX_SNIPER"
    if score >= 0.78:
        return "BOOST" if rotation_state == "REDUCED" else "AGGRESSIVE"
    if score >= 0.68:
        return "BASE" if rotation_state == "REDUCED" else "BOOST"
    return "BASE" if score >= 0.62 else "SCOUT"


def _shift(tier: RiskTier, delta: int) -> RiskTier:
    idx = TIER_ORDER.index(tier)
    return TIER_ORDER[int(_clamp(idx + delta, 0, len(TIER_ORDER) - 1))]


def calculate_position_size(payload: dict) -> dict:
    cfg = load_config(payload.get("config") or {})
    equity = max(0.0, _num(payload.get("accountEquity") or payload.get("equity"), 0.0))
    available = _num(payload.get("availableMargin"), float("inf"))
    leverage = max(1, int(round(_num(payload.get("leverageFallback") or payload.get("leverage"), 14))))
    stop_loss_pct = max(0.01, _num(payload.get("stopLossPct"), 0.10))
    score = _clamp(_num(payload.get("aggressiveScore"), 0.0), 0.0, 1.0)
    base_margin = max(cfg.min_margin, equity * cfg.base_risk_pct, _num(payload.get("baseMarginFallback"), 0.0))
    slippage_bps = max(0.0, _num(payload.get("executionSlippageBps"), 0.0))
    reasons: list[str] = []
    rejects: list[str] = []

    if not cfg.enabled:
        return _decision("BASE", 1.0, base_margin, leverage, stop_loss_pct, base_margin, True, ["fixed_sizing_disabled"], [], payload)

    tier = _initial_tier(score, str(payload.get("symbolRotationState") or payload.get("rotationState") or "ACTIVE").upper(), slippage_bps)
    if tier == "NO_TRADE":
        return _decision("NO_TRADE", 0.0, 0.0, leverage, stop_loss_pct, base_margin, False, ["score_below_trade_floor"], ["SCORE_REJECT"], payload)

    rotation = str(payload.get("symbolRotationState") or payload.get("rotationState") or "ACTIVE").upper()
    if rotation == "HOT":
        reasons.append("hot_symbol")
    if rotation in ("REDUCED", "RECOVERY"):
        tier = _shift(tier, -2)
        reasons.append("symbol_reduced")
    if str(payload.get("aggressionState") or "").upper() == "DEFENSIVE":
        tier = _shift(tier, -2)
        reasons.append("defensive_state")
    if _num(payload.get("profitFactor"), 1.0) >= 1.6 and _num(payload.get("recentWinRate"), 0.5) >= 0.56:
        tier = _shift(tier, 1)
        reasons.append("recent_edge_good")
    if payload.get("exitPreservingProfit"):
        tier = _shift(tier, 1)
        reasons.append("exit_preserving_profit")
    if _num(payload.get("drawdown"), 0.0) > max(2.0, equity * 0.02):
        tier = _shift(tier, -1)
        reasons.append("drawdown_elevated")
    if slippage_bps > 6:
        tier = _shift(tier, -1)
        reasons.append("slippage_high")
    if payload.get("dataQualityDegraded"):
        tier = _shift(tier, -2)
        reasons.append("data_quality_degraded")

    depth = max(1, int(_num(payload.get("campaignDepth"), 1)))
    if depth == 2:
        tier = _shift(tier, -1)
        reasons.append("depth_2_no_pyramid")
    elif depth >= 3 and _num(payload.get("campaignPnl"), 0.0) <= 0:
        tier = _shift(tier, -2)
        reasons.append("deep_negative_campaign")

    multiplier = TIER_MULTIPLIER[tier]
    margin = base_margin * multiplier
    previous = payload.get("previousEntryMargin")
    if depth > 1 and previous is not None and _num(payload.get("campaignPnl"), 0.0) <= 0 and margin > _num(previous):
        margin = _num(previous)
        multiplier = margin / max(base_margin, 0.000001)
        reasons.append("martingale_guard")

    max_margin_by_trade_risk = (equity * cfg.max_risk_pct_per_trade) / (leverage * (stop_loss_pct / 100)) if equity > 0 else margin
    if margin > max_margin_by_trade_risk:
        margin = max_margin_by_trade_risk
        multiplier = margin / max(base_margin, 0.000001)
        reasons.append("per_trade_risk_cap")
    if margin > available:
        margin = max(0.0, available)
        multiplier = margin / max(base_margin, 0.000001)
        reasons.append("available_margin_cap")

    open_positions = payload.get("currentOpenPositions") or []
    risk = margin * leverage * (stop_loss_pct / 100)
    open_risk = sum(_num(p.get("marginUsed")) * _num(p.get("leverage"), leverage) * (stop_loss_pct / 100) for p in open_positions if isinstance(p, dict))
    symbol = str(payload.get("symbol", "")).upper()
    symbol_risk = risk + sum(
        _num(p.get("marginUsed")) * _num(p.get("leverage"), leverage) * (stop_loss_pct / 100)
        for p in open_positions
        if isinstance(p, dict) and str(p.get("symbol", "")).upper() == symbol
    )
    used_margin = sum(_num(p.get("marginUsed")) for p in open_positions if isinstance(p, dict))
    total_risk_pct = (open_risk + risk) / equity if equity > 0 else 0
    symbol_risk_pct = symbol_risk / equity if equity > 0 else 0
    margin_utilization_after = (used_margin + margin) / equity if equity > 0 else 0
    if len(open_positions) >= cfg.max_concurrent_positions:
        rejects.append("SIZE_CAPITAL_REJECT")
    if total_risk_pct > cfg.max_total_risk_pct:
        rejects.append("SIZE_TOTAL_RISK_REJECT")
    if symbol_risk_pct > cfg.max_symbol_risk_pct:
        rejects.append("SIZE_SYMBOL_RISK_REJECT")
    if margin_utilization_after > cfg.max_margin_utilization:
        rejects.append("SIZE_MARGIN_UTILIZATION_REJECT")
    if margin <= 0:
        rejects.append("SIZE_MARGIN_REJECT")

    if not reasons:
        reasons.append(f"{str(tier).lower()}_score_band")
    return _decision(tier, multiplier, margin, leverage, stop_loss_pct, base_margin, not rejects, reasons, rejects, payload)


def _decision(tier: str, multiplier: float, margin: float, leverage: int, stop_loss_pct: float, base_margin: float,
              approved: bool, reasons: list[str], rejects: list[str], payload: dict) -> dict:
    max_loss = margin * leverage * (stop_loss_pct / 100)
    return {
        "recommendedMargin": _round(max(0.0, margin)),
        "recommendedLeverage": leverage,
        "riskTier": tier,
        "sizeMultiplier": _round(max(0.0, multiplier)),
        "reason": "_".join(reasons),
        "sizeReason": "_".join(reasons),
        "maxLossIfStop": _round(max_loss),
        "notional": _round(margin * leverage),
        "baseMargin": _round(base_margin),
        "approved": approved,
        "gateRejects": rejects,
        "diagnostics": {
            "score": _round(_num(payload.get("aggressiveScore")), 4),
            "recentWinRate": _round(_num(payload.get("recentWinRate"), 0.5), 4),
            "profitFactor": _round(_num(payload.get("profitFactor"), 1.0), 4),
            "generatedAt": time.time(),
        },
    }


def build_status(trades: list[dict], equity: float, config: dict | None = None) -> dict:
    cfg = load_config(config or {})
    base_margin = max(cfg.min_margin, equity * cfg.base_risk_pct, _num((config or {}).get("marginPerTrade"), 0.0))
    by_tier: dict[str, dict[str, float]] = {}
    curve = []
    running_equity = equity
    for idx, trade in enumerate(trades[-500:], start=1):
        tier = str(trade.get("riskTier") or "UNSIZED")
        row = by_tier.setdefault(tier, {"trades": 0, "wins": 0, "pnl": 0.0, "drawdown": 0.0, "peak": 0.0, "cum": 0.0})
        pnl = _num(trade.get("realizedPnl") or trade.get("pnl_usdt"))
        row["trades"] += 1
        row["wins"] += 1 if pnl > 0 else 0
        row["pnl"] += pnl
        row["cum"] += pnl
        row["peak"] = max(row["peak"], row["cum"])
        row["drawdown"] = max(row["drawdown"], row["peak"] - row["cum"])
        running_equity += pnl
        curve.append({"trade": idx, "equity": _round(running_equity), "baseMargin": _round(max(cfg.min_margin, running_equity * cfg.base_risk_pct))})
    return {
        "enabled": cfg.enabled,
        "baseMargin": _round(base_margin),
        "equityUsed": _round(equity),
        "sizeTierDistribution": {k: int(v["trades"]) for k, v in by_tier.items()},
        "pnlByRiskTier": {k: _round(v["pnl"]) for k, v in by_tier.items()},
        "winRateByRiskTier": {k: _round(v["wins"] / v["trades"], 4) if v["trades"] else 0 for k, v in by_tier.items()},
        "drawdownByRiskTier": {k: _round(v["drawdown"]) for k, v in by_tier.items()},
        "compoundingCurve": curve,
        "recommendedConfig": asdict(cfg),
    }
