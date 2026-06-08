---
name: Demo Sniper Validation Loop
description: G1–G19 gap fixes for the end-to-end sniper validation and learning loop; key architecture decisions and test isolation patterns.
---

## Key decisions

### Source of truth
demoTradeStore (JSONL) is the single source of truth. `sniperOpenTrades` (module Map) is a runtime cache, always restored from demoTradeStore on init and on each monitor pass. Never treat sniperOpenTrades as authoritative after a restart.

**Why:** G1/G2 — sniperOpenTrades was empty after restart, leaving the monitor blind to open positions.

### Restart recovery sequence
1. `initDemoTradeStore()` loads JSONL into `_openTrades` and rebuilds `_campaigns`
2. After init resolves, the module init block iterates `getOpenTradesAsMap()` and populates `sniperOpenTrades`
3. Monitor also syncs at the top of each pass (handles crash between persist and map.set)

### Campaign-level QB outcomes
sendcount ML sample per campaign to QB (id: `campaign:<campaignId>`), NOT per entry.
`recordTradeOutcome()` still runs per-entry for the adaptive engine (EWMA/cluster learning).
Only `syncQuantBrainOutcome()` is campaign-level to prevent correlated-entry data leakage.

**Why:** G14 — 10 stacked BTC LONG entries were becoming 10 independent ML training samples.

### Service state semantics
- PAUSED: skip placement cycle entirely; monitoring never stops
- SHADOW_ONLY: cycle continues but `isEntryAllowed(campaignHasEntry)` blocks second entry per campaign
- `isFallbackMode()` tags trades placed in SHADOW_ONLY with modelVersion="shadow-baseline"

### Canonical PnL
Monitor tries `fetchBingXRealizedPnl()` (income API) before falling back to price estimate.
Window: entryTime−10s → exitTime+60s. Field: `pnlSource` differentiates "exchange_reported" vs "price_estimate".

### Equity-relative circuit breakers
`updateVstEquity(equity)` must be called AFTER `recordTradeLoss()` for DEGRADED trigger (equity check recomputes rollingLossPct in updateVstEquity). PAUSED threshold also fires in recordTradeLoss directly.

### clientOrderId
All placements now include `clientOrderId: randomUUID()` persisted to demoTradeStore. Enables future fill reconciliation via BingX order history even if orderId lookup fails.

### JSONL idempotency
`persistOpenTrade`: skips if orderId already in `_openByOrderId` (inside write lock).
`closeOpenTrade`: skips if tradeId in `_closedTradeIds` (checked before and inside lock), returns cached result or null.

## Test isolation pattern
Use `setDataDir(tmpDir)` + `_resetStoreForTesting()` + `initDemoTradeStore()` in `beforeEach`.
`DATA_DIR` is now a function (not const) so the override takes effect at call time.

**Why:** DATA_DIR was captured at module load time; `process.chdir` had no effect.

## SCALP_ALLOW_EXECUTION scope
Only gates the scalp bot (`bot.ts`). Demo sniper posts directly to BingX VST endpoint — real-money execution is structurally impossible from demo.ts regardless of this flag.

## New endpoints (T004)
- `GET /api/demo/campaign/summary` — campaign-level PnL from JSONL, deduplicated by campaignId
- `GET /api/demo/model-readiness` — proxies QB `/model/readiness` with 5s timeout, never throws
