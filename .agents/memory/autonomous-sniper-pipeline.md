---
name: Autonomous Sniper 24h Pipeline
description: Quality filter + offline feedback loop for the shadow sampler; how the QB learns 24/7 without the bot being active
---

## Architecture

The QB runs 24/7 as an independent service analyzing all SHADOW_SAMPLER_SYMBOLS every cycle, regardless of whether the demo/live bot is active.

### Shadow Sampler Quality Filter
- `_sniper_quality_passes(sniper)` in `core/shadow_sampler.py`
- Passes if: `decision == "ARM_TRIGGER"` AND `score >= SHADOW_SAMPLER_MIN_SCORE` (default 0.55)
- `SHADOW_SAMPLER_ARM_ONLY=true` (default) — WAIT signals never count as intelligence
- ALL signals still saved to DB (negative examples needed for model training)
- Only ARM_TRIGGER + score≥threshold → `lastIntelligenceAnalyses` (shown on dashboard)
- State counters: `sniperFiltered`, `sniperPassed`, `lastIntelligenceAnalyses`
- Log line format: `intelligence=N/M concurrency=K` where N=passed, M=total symbols

### Offline Learner (`core/offline_learner.py`)
- Reads `trigger_outcomes.jsonl` written by Node.js (`exhaustionTriggerManager.ts`)
- Path configured via `TRIGGER_OUTCOMES_PATH` env — searches candidates if not set
- Checkpoint in `data/offline_learner_checkpoint.json` (keyed by `lastProcessedTs`) prevents double-processing
- `FILLED_AND_WON` → `kb.reconcile_signal_outcome(won=True)`
- `FILLED_AND_STOPPED`, `EXPIRED_UNFILLED` → `kb.reconcile_signal_outcome(won=False)`
- `PARTIAL_FILL_CANCELLED`, `SECTOR_CASCADE_CANCELLED` → skipped (no definitive PnL outcome)
- Only fires `train_shadow_model()` if `recorded >= OFFLINE_LEARNER_MIN_OUTCOMES_FOR_TRAIN` (default 20)

### Job Supervisor Registration
- `shadow_signal_sampler` — priority="normal", run_immediately=True, interval=SHADOW_SAMPLER_INTERVAL_SECONDS (60s)
- `offline_learner` — priority="low", run_immediately=False, interval=OFFLINE_LEARNER_INTERVAL_SECONDS (86400s = 24h)

### API Endpoints
- `GET /signals/shadow-sampler/intelligence` — filtered intelligence + sniper stats + offline learner status
- `POST /offline-learner/run` — manual trigger for debug
- `GET /offline-learner/status` — learner cycle stats

**Why:**
The sampler previously saved every LONG/SHORT for every symbol every cycle (100% noise). Quality filter ensures `lastIntelligenceAnalyses` only shows actionable ARM_TRIGGER setups. Training requires negative examples so all signals remain in DB — only the dashboard view is filtered.

**How to apply:**
- `SHADOW_SAMPLER_MIN_SCORE=0.0` disables score filter (saves all ARM_TRIGGER)
- `SHADOW_SAMPLER_ARM_ONLY=false` saves WAIT signals as intelligence too (not recommended)
- `TRIGGER_OUTCOMES_PATH` must match Node.js `TELEMETRY_DIR` on deployed infra
- `OFFLINE_LEARNER_MIN_OUTCOMES_FOR_TRAIN` can be lowered for faster retraining in early phases
