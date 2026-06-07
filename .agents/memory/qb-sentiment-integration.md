---
name: QB Sentiment Integration
description: How the 24h sentiment engine (sentimentEngine.ts) feeds into QB edge gate decisions
---

## Rule
sentimentContext is fetched from sentimentEngine.ts alongside the capital gate (parallel fetch), then passed to evaluateQuantBrainEdge as sentimentContext field. QB edge_gate.py reads and acts on it.

## Sentiment Counter Gate
- Triggers when: `sentiment_counter && confidence >= 0.75 && biasRatio >= 0.72`
- Reject string: `SENTIMENT_COUNTER_REJECT: 24h bias {DIR} ({conf}% conf, {bias}% weight) conflicts with {side}`
- Only blocks strongly-biased counter-trend entries (e.g. BEAR 80%+ → no LONG)

## Score Adjustment
- Aligned (BULL+LONG or BEAR+SHORT): `score *= 1 + confidence * 0.15` (max +15% boost)
- Counter: `score *= 1 - confidence * 0.10` (up to -10% penalty)
- Applied AFTER regime/correlation adjustments

## Cache Key
sentimentKey = `{direction}:{biasRatio*10 rounded}` added to QB edge cache key to avoid stale BULL/BEAR served from wrong sentiment state.

**Why:** Without sentiment in cache key, a shift from BULL→BEAR would serve cached BULL-state QB results for up to 5s.

## QB Returns sentimentContext
edge_gate.py returns `sentimentContext: {direction, confidence, biasRatio, aligned, counter}` for observability in intelligence page.
