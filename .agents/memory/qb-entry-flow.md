---
name: QB Entry Gate Flow
description: How QB is integrated into the trade entry pipeline (single order + bulk)
---

## Single Order (/api/bot/order)
Capital gate fetches (positions + balance) run in parallel with sentimentEngine.getMarketSentiment.
After capital gate, QB evaluateQuantBrainEdge is called with the already-fetched sentimentContext.
- Shadow mode: QB rejects logged, not blocking. Response includes `qbShadowRejects[]`
- Enforce mode: QB rejects added to `gateRejects[]` → blocks the order

## Bulk (executeSingleOrder)
- Enforce mode: sentiment fetched, QB awaited, rejects block the individual order
- Shadow mode: QB evaluation fire-and-forget (no await) — avoids adding latency per bulk order

## QB Gate Mode (QUANT_BRAIN_GATE_MODE)
- `off` — QB not called
- `shadow` — QB called, rejects logged but not blocking (default)
- `enforce` — QB rejects block trades including SENTIMENT_COUNTER_REJECT

**Why:** Shadow mode allows calibration without risk. Enforce mode is only for live trading after validating QB has good signal quality. The `qbShadowRejects` field in the order response enables monitoring what QB would have blocked.
