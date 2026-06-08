"""
Judge Sniper — fatal-only hard blocks.

Answers ONE question: "Is this trade PHYSICALLY IMPOSSIBLE or CATASTROPHICALLY WRONG?"
NOT "Is this a good trade?" — that's Coach Ranker's domain.

Hard blocks are profile-independent: they fire the same in demo_learning_aggressive
as in conservative mode. Anything that is NOT a fatal error becomes a Coach penalty.

Fatal hard blocks:
  SIGNAL_EXPIRED          — signal stale before QB evaluated it
  HOUR_REJECT             — UTC hour is blacklisted
  SYMBOL_REJECT           — symbol not in allowlist
  DATA_STALE              — market snapshots stale (cannot trust timing)
  DATA_GAPPED             — snapshot continuity broken (cannot trust direction)
  SNIPER_SIDE_MISMATCH    — sniper direction conflicts with requested position side
  SNIPER_BLOCK_*          — sniper price/spread is catastrophically bad
  COST_EXCEEDS_TP         — TP is eaten by costs, trade can NEVER profit (net ≤ 0)
  EXTREME_TOXICITY        — VPIN > 0.85 (execution impossible at any reasonable price)
  LIQUIDITY_VOID          — spread so wide execution is physically impossible
  KILL_SWITCH_DAILY_LOSS  — daily P&L limit reached
  KILL_SWITCH_DRAWDOWN    — drawdown limit reached
  KILL_SWITCH_LOSS_STREAK — consecutive loss limit reached
  NEWS_HARD_BLOCK         — active high-impact scheduled event

NOT hard blocks (Coach Ranker penalties):
  EV negative with < 150 samples         cold start / learning
  Sharpe low with < 25 samples           cold start / learning
  Kelly low                              sizing guidance only
  Low regime confidence                  penalty -0.05
  ML unavailable / cold start            neutral (0.50)
  SNIPER_WAIT                            penalty -0.08
  Sentiment counter-trend                penalty (not block)
  Data delta divergence                  penalty -0.05
  Structural break                       penalty -0.05
  High volatility (VPIN 0.70–0.85)       penalty -0.06
  Correlation with open positions        penalty -0.05
  News reduce-aggression                 penalty -0.06
  BTC regime mismatch                    alignment score factor
  WR / PF / EV user config thresholds   ignored in demo_learning_aggressive
"""
from __future__ import annotations

import time
from typing import Any


# ---------------------------------------------------------------------------
# Helpers (duplicated from edge_gate so Judge has zero dependencies on it)
# ---------------------------------------------------------------------------

def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value) if value is not None else fallback
    except Exception:
        return fallback


def _list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value:
        return [x.strip() for x in value.split(",") if x.strip()]
    return []


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def judge_entry(
    *,
    symbol: str,
    position_side: str,
    hour_utc: int,
    config: dict,
    sniper: dict,
    data_quality: dict,
    net_target_pct: float,
    news_action: str = "allow",
    operational_risk: dict | None = None,
    signal_expired: bool = False,
) -> dict[str, Any]:
    """
    Apply fatal hard blocks only. Returns a judge verdict dict.

    Result keys:
      allow       — bool: False means trade must not proceed
      blocks      — list[str]: human-readable block reasons
      judgeVersion — str
      judgedAt    — float unix timestamp
    """
    blocks: list[str] = []
    op = operational_risk or {}

    # ── 1. Signal expired ───────────────────────────────────────────────────
    if signal_expired:
        blocks.append("SIGNAL_EXPIRED: signal expired before Judge evaluation")

    # ── 2. Hour blacklist ───────────────────────────────────────────────────
    hour_blacklist = [int(x) for x in _list(config.get("hourBlacklist"))]
    if hour_utc in hour_blacklist:
        blocks.append(f"HOUR_REJECT: UTC hour {hour_utc} is blacklisted")

    # ── 3. Symbol not in allowlist ──────────────────────────────────────────
    allowed_symbols = _list(config.get("allowedSymbols"))
    if allowed_symbols and symbol not in allowed_symbols:
        blocks.append(f"SYMBOL_REJECT: {symbol} not in allowlist")

    # ── 4. Data quality — stale or gapped ──────────────────────────────────
    if any(f.get("quality") == "STALE" for f in data_quality.values()):
        blocks.append("DATA_STALE: market snapshots are stale — cannot trust entry timing")
    if any(f.get("quality") == "GAPPED" for f in data_quality.values()):
        blocks.append("DATA_GAPPED: snapshot continuity degraded — cannot trust direction")

    # ── 5. Sniper hard blocks (price data / spread catastrophically bad) ─────
    sniper_decision = str(sniper.get("decision", ""))
    if sniper_decision.startswith("BLOCK_"):
        reasons = ",".join(sniper.get("reasons") or [])
        blocks.append(f"SNIPER_{sniper_decision}: {reasons}")

    # ── 6. Sniper direction mismatch (fatally wrong side) ───────────────────
    if sniper_decision == "ALLOW_LONG" and position_side != "LONG":
        blocks.append(
            f"SNIPER_SIDE_MISMATCH: sniper recommends LONG but entry is {position_side}"
        )
    elif sniper_decision == "ALLOW_SHORT" and position_side != "SHORT":
        blocks.append(
            f"SNIPER_SIDE_MISMATCH: sniper recommends SHORT but entry is {position_side}"
        )

    # ── 7. TP eaten by costs (net-negative, trade can never profit) ─────────
    if net_target_pct <= 0:
        blocks.append(
            f"COST_EXCEEDS_TP: net target {net_target_pct:.4f}% ≤ 0 after costs"
        )

    # ── 8. Extreme microstructure toxicity (VPIN > 0.85 = execution impossible) ─
    micro = data_quality.get("alt1m", {}).get("microstructure", {})
    toxicity = float(micro.get("toxicity_score", 0.0))
    if toxicity > 0.85:
        blocks.append(f"EXTREME_TOXICITY: VPIN {toxicity:.2f} > 0.85 — execution impossible")

    # ── 9. Liquidity void (spread so wide BingX will reject or slippage is fatal) ─
    lv = data_quality.get("alt1m", {}).get("liquidityVoid", {})
    if lv.get("void", False):
        spread_bps = lv.get("avg_spread_bps", 0)
        blocks.append(f"LIQUIDITY_VOID: spread {spread_bps:.0f}bps — execution physically impossible")

    # ── 10. Kill switches (session risk limits) ──────────────────────────────
    max_daily_loss = _num(config.get("maxDailyLossPct"), 0.0)
    max_drawdown = _num(config.get("maxDrawdownPct"), 0.0)
    max_losses = int(_num(config.get("maxConsecutiveLosses"), 0))

    net_pnl = float(op.get("netPnlPct", 0.0))
    cur_drawdown = float(op.get("maxDrawdownPct", 0.0))
    cur_streak = int(op.get("consecutiveLosses", 0))

    if max_daily_loss > 0 and net_pnl <= -max_daily_loss:
        blocks.append(f"KILL_SWITCH_DAILY_LOSS: session P&L {net_pnl:.2f}% ≤ -{max_daily_loss:.2f}%")
    if max_drawdown > 0 and cur_drawdown >= max_drawdown:
        blocks.append(f"KILL_SWITCH_DRAWDOWN: drawdown {cur_drawdown:.2f}% ≥ {max_drawdown:.2f}%")
    if max_losses > 0 and cur_streak >= max_losses:
        blocks.append(f"KILL_SWITCH_LOSS_STREAK: {cur_streak} consecutive losses ≥ limit {max_losses}")

    # ── 11. Hard news block (high-impact scheduled event) ───────────────────
    if news_action == "block":
        blocks.append("NEWS_HARD_BLOCK: active high-impact event blocks all entries")

    return {
        "allow": len(blocks) == 0,
        "blocks": blocks,
        "judgeVersion": "judge-sniper-v1",
        "judgedAt": time.time(),
    }


def judge_high_sample_context(
    *,
    net_ev_usdt: float,
    ev_samples: int,
    realized_score: float,
    rec_samples: int,
    rec_has_recommendation: bool,
) -> list[str]:
    """
    Additional hard blocks that only fire with LARGE confirmed-negative sample counts.
    These are allowed even in demo_learning_aggressive because they represent
    confirmed, statistically significant evidence of a dead context — not cold start.

    Thresholds: 150+ samples with confirmed negative EV OR confirmed toxic realized edge.
    """
    blocks: list[str] = []

    if ev_samples >= 150 and net_ev_usdt < -0.50:
        blocks.append(
            f"NET_EV_CONFIRMED_NEGATIVE: {net_ev_usdt:.4f} USDT "
            f"(n={ev_samples}, statistically confirmed)"
        )

    if rec_samples >= 150 and not rec_has_recommendation and realized_score < 0.25:
        blocks.append(
            f"REALIZED_EDGE_CONFIRMED_TOXIC: score {realized_score:.4f} "
            f"(n={rec_samples}, statistically confirmed)"
        )

    return blocks
