---
name: Shadow ML profitability tests
description: Durable rules for ML edge validation in scalp trading; breakeven math and threshold-scan design
---

## Rule: scalp breakeven is ~89.6% — not 50%

With default config (TP=0.22%, SL=0.55%, fees≈0.14% round-trip):
- Net TP = 0.22 - 0.14 = 0.08%
- Net SL = 0.55 + 0.14 = 0.69%
- Breakeven P = 0.69 / (0.08 + 0.69) ≈ 89.6%

The ML model cannot be evaluated with standard AUC-only criteria. A model with AUC=0.62 may still produce negative EV if its precision at any threshold never exceeds 89.6%.

**Why:** Classic brier-score improvement vs. baseline only asks "is this better than guessing?", not "is this profitable?". Scalp configs with tight TP and wide SL have a very high breakeven that standard ML metrics don't capture.

**How to apply:** After training, always run `_profitability_simulation()` which scans thresholds 0.50–0.90 and computes EV = P(hit)×net_tp − P(miss)×net_sl. Only set `profitabilityVerified=True` if best EV > 0. Save model if `improvesBaseline OR profitabilityVerified`.

## Rule: optimal threshold is per-dataset, not a constant

The threshold that maximizes EV changes with market regime and data distribution. Hard-coding 0.60 or 0.65 is wrong. The threshold scan computes it empirically from the actual test split, using the real TP/SL/cost stored in `signal_outcomes.features["stop_move_pct"]` and `target_configured_move_pct`.

**How to apply:** `_profitability_simulation` stores `optimalThreshold` in metadata. `predict_shadow` reads it and uses it for `isAboveOptimalThreshold` and `recommendation`. The dashboard shows it as "Threshold ótimo".

## Rule: stop_move_pct is in features JSON, not a top-level column

The stop loss percentage is stored in `signal_outcomes.features["stop_move_pct"]` (set by `record_signal_from_gate` from `config.stopLossPct`). It is NOT a top-level column in `signal_outcomes`. When computing EV in profitability simulation, extract it via `row["features"].get("stop_move_pct", DEFAULT_SL)`.
