---
name: QB Gate Thresholds (alt-coin production)
description: Gate threshold values tuned for 24h stable operation on volatile alt-coins
---

## Thresholds (edge_gate.py)

| Gate | Old | New | Why |
|------|-----|-----|-----|
| HIGH_VOLATILITY_REJECT | 1.5% | 2.5% | TRUMP/MELANIA/VVV normal ATR exceeds 1.5% |
| LOW_REALIZED_SHARPE_REJECT min samples | 10 | 25 | Too few trades to compute reliable Sharpe |
| LOW_REALIZED_SHARPE_REJECT threshold | 0.5 | 0.3 | Allow startup phase with developing edge |
| LOW_REGIME_CONFIDENCE threshold | 0.5 | 0.4 | Ambiguous but not chaotic regimes should pass |
| requireFull15mContext default | True | False | Startup would block all entries for first 15min |

**Why:** Original thresholds were calibrated for liquid large-cap coins with long trade history. For a new system on volatile meme/alt coins (TRUMP, MELANIA, VVV, BEAT), these thresholds would block 90%+ of entries on startup. Lower thresholds allow the system to accumulate samples while still blocking genuinely dangerous conditions.

**How to apply:** If the system matures (100+ trades/symbol) and Sharpe consistently < 0.3, consider tightening back. HIGH_VOLATILITY should stay at 2.5% for TRUMP/MELANIA class assets.
