---
name: Shadow ML Gaps Fix
description: Root causes of 0/300 samples in Shadow ML and what was fixed
---

## Root causes found (all caused 0/300 samples)

1. **priority="low" skipped by semaphore** — job_supervisor skips low-priority jobs when semaphore is full. With max_concurrent=2 and tactical_market_cycle running almost constantly, shadow sampler was being skipped. Fixed: priority="normal".

2. **run_immediately=False** — sampler waited 60s after every restart before first run. Fixed: run_immediately=True.

3. **timeout=25s too short** — 10 symbols × sniper eval + bootstrap DB writes can exceed 25s. Fixed: default 60s.

4. **Zero logging** — all failures were completely silent. Fixed: log.info at start/end of each cycle.

## Feature gaps fixed

5. **No macro candle regime** — 1h/4h/1d BTC bias (LONG/SHORT/NEUTRAL), correctionRisk, trendScore were not in the ML feature set. These are highly predictive for scalp entry quality. Fixed: added to `candle_regime` key in features dict saved to signal_outcomes, extracted in shadow_model._feature_dict.

6. **candleRegime not captured** — signal_learning.record_signal_from_gate didn't include `sniper.get("candleRegime", {})` in features. Fixed.

## How to verify working

QB logs should show: `[shadow_sampler] INFO Shadow sampler cycle=N done: attempted=18 recorded=X skipped=Y`

After ~75 minutes: `trainingSamplesAvailable` > 0, rising toward 300.
After ~2h: model training triggers automatically (`needs_initial_train=True`).

**Why:** The semaphore skip was the primary root cause — tactical loop (priority="market") runs every 15s and holds the semaphore slot, leaving only 1 slot for 3 low-priority jobs (shadow_sampler, model_maintenance, macro_candle). When model_maintenance also ran, the semaphore was full and shadow_sampler was always skipped.
