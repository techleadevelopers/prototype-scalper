---
name: Demo Sniper Autopilot
description: Score-tiered multi-asset demo autopilot and campaign reporting added to demo.ts
---

## Architecture

The demo sniper is a module-level autonomous loop in `artifacts/api-server/src/routes/demo.ts`.

**Key design decision**: autopilot-placed demo trades are tracked in `sniperOpenTrades: Map<string, DemoOpenTrade>` (keyed by orderId) — completely separate from the session-based `req.session.demoOpenTrades` (keyed by `SYMBOL:SIDE`). This allows multiple entries per symbol+side without session context in the async loop.

**Why:** The `setInterval` cycle has no `req` object, so it can't read/write session. The module-level map survives session expiry. Manual demo trades still use session; sniper trades use the Map.

## Score Tier Allocation

```
scoreTierMaxEntries(score):
  < 0.60 → 0
  0.60–0.69 → 1
  0.70–0.79 → 3
  0.80–0.89 → 5
  ≥ 0.90 → 10
```

Per-symbol cap: `DEMO_SNIPER_PER_SYMBOL_MAX` (default 10, ENV override).
Global cap: `DEMO_SNIPER_GLOBAL_MAX` (default 50, ENV override).
Single-side enforcement: if opposite side is open for a symbol and `preventHedgedPositions=true`, skip.

## Cycle Flow

1. Fetch BTC price (live endpoint, not VST) + current VST open positions in parallel
2. Build `openCounts: Map<"SYMBOL:SIDE", number>` from exchange
3. `computeAllCandleEdges(symbols, "5m")` for all configured symbols
4. Score each (symbol, positionSide) using `engine.combinedEdgeScore(clusterKey, ev, candleScore)`
5. `symbolProfile.isToxic` check → skip toxic
6. Sort by combinedScore descending, allocate `entriesNeeded = min(tier - currentOpen, perSymbolMax - currentOpen, globalHeadroom)`
7. `bingxPost("/openApi/swap/v2/trade/order", ...)` with TP/SL protection
8. Register in `sniperOpenTrades`

## Monitor Loop

Polls VST positions every `DEMO_SNIPER_MONITOR_MS` (default 12s). For any entry in `sniperOpenTrades` no longer present on exchange, fetches last price and calls `recordTradeOutcome` (pnlSource: "price_estimate", estimated: true). Uses `sniperRecordedIds: Set<string>` to prevent double-recording.

## Campaign Endpoint

`GET /api/demo/campaign` — filters `getEngine().rawOutcomes()` where `isDemo === true || source === "bingx-vst"`, groups by symbol, computes per-symbol: trades, wins, winRate, totalPnl, totalFees, totalGrossPnl, avgHoldMs, maxDrawdown, tpCount, slCount, entries (last 100). Returns summary + per-symbol array sorted by totalPnl descending. Each symbol includes full entry list for per-entry drill-down.

## New Routes

- `POST /api/demo/sniper/start` — requires demo connected (getDemoCredentials), stores creds in demoSniper.creds
- `POST /api/demo/sniper/stop` — MANUAL_STOP reason
- `GET /api/demo/sniper/status` — includes openTradesList from sniperOpenTrades map
- `GET /api/demo/campaign` — dual-view reporting

## ENV Vars

- `DEMO_SNIPER_GLOBAL_MAX` (default 50)
- `DEMO_SNIPER_PER_SYMBOL_MAX` (default 10)
- `DEMO_SNIPER_CYCLE_MS` (default 30000)
- `DEMO_SNIPER_MONITOR_MS` (default 12000)

## Frontend

Sniper Autopilot card (left column, shown when demoConnected) — purple theme, start/stop button, cycle stats grid, last cycle summary with placements list. Campaign Reporting card (below main 3-col grid) — summary metrics header + expandable symbol table with per-entry rows.
