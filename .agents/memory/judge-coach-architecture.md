---
name: Judge-Coach QB Architecture
description: Two-layer QB decision split — Judge does fatal blocks, Coach scores/ranks. Critical for demo_learning_aggressive profile behavior.
---

## Rule

QB decisions are split into two independent layers:

**Judge Sniper** (`core/judge_sniper.py`) — fatal-only hard blocks, profile-independent:
- Data stale/gapped, sniper side mismatch, cost > TP (net ≤ 0)
- Extreme toxicity (VPIN > 0.85), liquidity void
- Kill switches (daily loss / drawdown / loss streak)
- Hard news block, signal expired, hour/symbol blacklist
- High-sample confirmed-negative contexts (150+ samples): `judge_high_sample_context()`

**Coach Ranker** (`core/coach_ranker.py`) — scores and penalizes, never blocks:
- `aggressiveScore` = momentum(35%) + candle(20%) + volumeOI(15%) + btcAlignment(10%) + freshData(10%) + realizedEdge(5%) + shadowML(5%) − penalties
- `learningScore` = blend of aggressiveScore + realized edge (0-49: pure aggressive, 50-149: 70/30, 150+: 50/50)
- `executionPriority` = aggressiveScore in demo_learning_aggressive; learningScore in balanced/conservative

**`evaluate_edge_gate()`** (`core/edge_gate.py`) calls both. `/cycle/rank` endpoint runs Judge+Coach on all cycle candidates in parallel and returns them sorted by executionPriority.

## demo_learning_aggressive behavior

Things that do NOT block in this profile (only penalize score):
- Sentiment counter-trend → penalty −0.08 to −0.12
- BTC regime direction (even when btcRegimeRequired=true) → BTC alignment score factor
- SNIPER_WAIT → penalty −0.08
- EV negative with < 150 samples → proportional penalty (0-49: none, 50-149: small)
- Sharpe < 0.3 with < 25 returns → penalty −0.05
- Low regime confidence → penalty −0.05
- WR / PF / EV user config thresholds (winRateMin, profitFactorMin, evMinThreshold) → IGNORED entirely
- Signal context edge degraded → penalty
- ML unavailable / cold start → neutral 0.50 contribution

**Why:** Demo VST phase is about generating real learning data at volume. Over-defensive blocking creates too few trades to train the sniper on, starving the ML model of outcomes. Fatal blocks still fire (we can't trade stale data or enter the wrong side), but everything else adjusts rank without vetoing.

## Response fields

New fields added to `/edge/evaluate` response:
- `judgeSniper` — `{allow, blocks, judgeVersion, judgedAt}`
- `coachRanker` — `{aggressiveScore, learningScore, executionPriority, scorePenalties, penaltyReasons, learningBlend, coachVersion}`
- `learningScore` — top-level float
- `executionPriority` — top-level float (also used as `score`)
- `mode` — `"judge-coach-dual-layer-v1"`

`/cycle/rank` response: `{ranked, blocked, totalCandidates, allowed, blockedCount, mode}`
