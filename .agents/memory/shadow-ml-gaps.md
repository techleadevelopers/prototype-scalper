---
name: Shadow ML operational heuristics
description: Durable lessons from diagnosing silent data-starvation in Shadow ML pipeline
---

## Rule: low-priority jobs with bounded semaphore starve silently

When `JOB_MAX_CONCURRENCY=2` and a "market"-priority job runs almost continuously, a single additional job can fully saturate the semaphore. Any "low"-priority job will be skipped forever with no error or warning.

**Why:** `job_supervisor._run_once` does `if semaphore.locked() and priority == "low": skip`. With 2 slots, tactical (market) + model_maintenance (low) = both taken = shadow_sampler always skipped.

**How to apply:** Data-collection jobs must use `priority="normal"` or higher. Reserve "low" only for genuinely optional work that is safe to skip indefinitely.

## Rule: run_immediately=False loses uptime on every restart

A 60s delay per restart turns a 60s sampling interval into effectively much longer when QB restarts periodically. First sample is always wasted.

**How to apply:** Data-collection jobs should use `run_immediately=True`.

## Rule: shadow ML feature additions need fallback defaults in _feature_dict

`signal_outcomes.features` is a JSON blob frozen at recording time. When new feature keys are added (e.g. `candle_regime`), old rows have no such key. `_feature_dict` must use `.get(key, default)` so old and new rows both produce valid training vectors.

**How to apply:** Whenever adding a feature to `CATEGORICAL_FEATURES` or `NUMERICAL_FEATURES`, ensure `_feature_dict` has a safe default for the missing key.
