# ML Drift Thresholds

All thresholds are configurable through `.env`; values below are the selected defaults.

| Monitor | DEGRADED | SHADOW_ONLY |
|---|---:|---:|
| Feature PSI | `>= 0.10` | `>= 0.25` |
| Symbol JS divergence | `>= 0.10` | `>= 0.20` |
| Missingness increase | `>= 5%` | `>= 15%` |
| Volatility current/reference | `>= 1.50x` | `>= 2.00x` |
| Volume current/reference | `<= 0.50x` | `<= 0.25x` |
| Symbol-universe change | `>= 15%` | `>= 30%` |
| Prediction age | `>= 120s` | `>= 300s` |
| Brier score | `>= 0.22` | `>= 0.28` |
| Brier degradation vs reference | `>= 0.03` | `>= 0.07` |
| Expected calibration error | `>= 0.08` | `>= 0.15` |
| Predicted/observed probability gap | `>= 0.08` | `>= 0.15` |
| Rolling campaign expectancy | `<= 0.00%` | `<= -0.20%` |
| Profit Factor | `<= 1.10` | `<= 0.80` |
| Regime/direction expectancy, minimum 20 samples | n/a | `<= -0.20%` |

State selection is deterministic:

- `HEALTHY`: no warning or critical monitor.
- `DEGRADED`: at least one warning; stacking multiplier is `0.5`.
- `SHADOW_ONLY`: one drift domain is critical; ML enforcement is disabled and stacking is reduced to one entry.
- `PAUSED`: data drift and concept drift are both critical; no new entries.

Escalation requires two consecutive evaluations. Recovery requires three consecutive evaluations. TP/SL monitoring, reconciliation, outcome synchronization, and learning do not consult this state.
