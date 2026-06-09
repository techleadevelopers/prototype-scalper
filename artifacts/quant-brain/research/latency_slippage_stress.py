from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
from typing import Any

from core.edge_gate import _ml_economic_gate, _risk_geometry_blocks
from core.shadow_model import predict_shadow
from research.walk_forward_evaluation import load_rows


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else fallback
    except Exception:
        return fallback


def _stress_row(row: dict[str, Any], latency_ms: int, slippage_pct: float) -> dict[str, Any]:
    stressed = dict(row)
    features = dict(row.get("features") or {})
    stressed["features"] = features
    base_cost = _num(row.get("estimated_cost_pct"), _num(features.get("estimated_cost_pct"), 0.0))
    latency_drag_pct = max(0.0, latency_ms - 50) / 1450 * slippage_pct
    stressed["estimated_cost_pct"] = base_cost + slippage_pct + latency_drag_pct
    features["estimated_cost_pct"] = stressed["estimated_cost_pct"]
    return stressed


def _gate_decision(row: dict[str, Any], config: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    shadow_ml = predict_shadow(row)
    stop_move_pct = _num((row.get("features") or {}).get("stop_move_pct"), 0.15)
    target_pct = _num(row.get("target_configured_move_pct"), 0.15)
    cost_pct = _num(row.get("estimated_cost_pct"), 0.0)
    probability = _num(shadow_ml.get("calibratedProbability"), 0.5)
    risk_blocks, risk_geometry = _risk_geometry_blocks(
        config=config,
        net_target_pct=target_pct - cost_pct,
        stop_move_pct=stop_move_pct,
        cost_pct=cost_pct,
        hit_probability=probability,
        ev_samples=max(10_000, int(shadow_ml.get("samples") or 0)),
        shadow_ml=shadow_ml,
        min_samples=1,
    )
    ml_blocks, ml_gate = _ml_economic_gate(
        config=config,
        shadow_ml=shadow_ml,
        risk_geometry=risk_geometry,
        current_profit_factor=config.get("currentProfitFactor", 2.0),
        drift_policy={"mlEnforcementAllowed": True, "newEntriesAllowed": True},
        correlation_penalty=1.0,
        regime_confidence=1.0,
    )
    blocks = risk_blocks + ml_blocks
    return len(blocks) == 0, {
        "blocks": blocks,
        "shadowMl": shadow_ml,
        "riskGeometry": risk_geometry,
        "mlEconomicGate": ml_gate,
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    rows = await load_rows(args.symbol, args.source_type, args.limit)
    if args.sample_size and len(rows) > args.sample_size:
        random.Random(args.seed).shuffle(rows)
        rows = rows[:args.sample_size]
    config = {
        "shadowMlEconomicGate": True,
        "mlEconomicMinProfitFactor": args.min_profit_factor,
        "currentProfitFactor": args.current_profit_factor,
        "mlEconomicMinRegimeConfidence": 0.0,
        "minRewardRiskRatio": args.min_reward_risk,
        "minProbabilityEdge": args.min_probability_edge,
    }
    latency_levels = [int(v) for v in args.latency_ms.split(",")]
    slippage_levels = [float(v) for v in args.slippage_pct.split(",")]
    grid = []
    first_full_block = None
    for latency_ms in latency_levels:
        for slippage_pct in slippage_levels:
            approved = 0
            reject_reasons: dict[str, int] = {}
            for row in rows:
                stressed = _stress_row(row, latency_ms, slippage_pct)
                allow, detail = _gate_decision(stressed, config)
                if allow:
                    approved += 1
                for reason in detail["blocks"]:
                    key = str(reason).split(":", 1)[0]
                    reject_reasons[key] = reject_reasons.get(key, 0) + 1
            blocked = len(rows) - approved
            block_rate = blocked / max(1, len(rows))
            cell = {
                "latencyMs": latency_ms,
                "adverseSlippagePct": slippage_pct,
                "signals": len(rows),
                "approved": approved,
                "blocked": blocked,
                "blockRate": round(block_rate, 6),
                "topRejects": dict(sorted(reject_reasons.items(), key=lambda item: item[1], reverse=True)[:5]),
            }
            if first_full_block is None and rows and approved == 0:
                first_full_block = cell
            grid.append(cell)
    return {
        "status": "OK" if rows else "NO_DATA",
        "symbol": args.symbol or "ALL",
        "sourceType": args.source_type or "ALL",
        "rowsLoaded": len(rows),
        "stressModel": "estimated_cost_pct += adverse_slippage_pct + latency_scaled_drag_pct",
        "firstFullBlock": first_full_block,
        "grid": grid,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Adversarial latency/slippage stress test for ML Economic Gate.")
    parser.add_argument("--symbol", default=None)
    parser.add_argument("--source-type", default=None)
    parser.add_argument("--limit", type=int, default=50000)
    parser.add_argument("--sample-size", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--latency-ms", default="50,100,250,500,750,1000,1250,1500")
    parser.add_argument("--slippage-pct", default="0.02,0.04,0.06,0.08,0.10")
    parser.add_argument("--min-profit-factor", type=float, default=1.10)
    parser.add_argument("--current-profit-factor", type=float, default=2.0)
    parser.add_argument("--min-reward-risk", type=float, default=0.75)
    parser.add_argument("--min-probability-edge", type=float, default=0.03)
    return parser.parse_args()


def main() -> None:
    print(json.dumps(asyncio.run(run(parse_args())), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
