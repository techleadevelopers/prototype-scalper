---
name: Live Position Watcher
description: Autonomous outcome auto-recording for live trades — how the AdaptiveEngine learns from real orders without manual input.
---

## What it does
`artifacts/api-server/src/lib/livePositionWatcher.ts` polls BingX positions every 15s.
When a tracked (symbol, positionSide) combo disappears (positionAmt → 0), it:
1. Fetches exit orders from `/openApi/swap/v2/trade/allOrders`
2. Pairs entries → exits oldest-to-oldest (handles stacking N entries per symbol/side)
3. Calls `buildOutcomeFromOrders` → `recordTradeOutcome` → `syncQuantBrainOutcome`

## Hook point
`executeSingleOrder` in `bot.ts` calls `registerLiveEntry` + `updateWatcherCreds` immediately after every successful BingX order placement. Covers all execution paths: autopilot, manual `/api/bot/order`, bulk, and sniper/mass.

## Key design decisions
- **Deduplication**: `recordedIds: Set<string>` keyed by entryOrderId — never double-record across poll cycles
- **Stacking**: entries grouped by (symbol, positionSide), sorted oldest→newest; matched to exits oldest→newest
- **No blocking**: watcher runs in background interval; `syncQuantBrainOutcome` is fire-and-forget
- **Stale eviction**: entries older than 24h without a detected close are evicted with a warning
- **Registry cap**: MAX_TRACKED_ENTRIES=500; oldest evicted if exceeded
- **Profit field filter**: prefers exit orders with `profit != null/0` (closing orders); falls back to all exits if none found

**Why:** `executeSingleOrder` is the single convergence point for all order paths — hooking there covers 100% of live trades without needing separate logic per route.

## Monitoring
`GET /api/bot/watcher` — returns running, pollCount, trackedEntries, outcomesRecorded, lastError, entry list.

## Exit reason inference
- `exitPrice >= entryPrice * (1 + 0.70 * takeProfitPct/100)` → TAKE_PROFIT
- `exitPrice <= entryPrice * (1 - 0.70 * stopLossPct/100)` → STOP_LOSS  
- Otherwise → UNKNOWN (manual close, liquidation, etc.)

## Credentials
The watcher has no credentials at startup (shows "missing" in /api/bot/watcher). They are populated on first successful order placement via `updateWatcherCreds`. Before first order, poll cycles are no-ops.
