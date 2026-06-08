---
name: Exit Intelligence System
description: Post-entry QB layer that evaluates open positions and recommends exit actions; integrates with demo monitor; feeds Coach Ranker learning via exit quality labels.
---

## Rule

Exit intelligence is a **separate layer from entry evaluation**. It runs inside `runDemoSniperMonitor()` for every open position, fire-and-forget, never blocking the monitor loop.

## Architecture

**QB modules:**
- `core/exit_intelligence.py` — `evaluate_exit()`: fetches current market data internally (sniper window + snapshot history); returns HOLD/MOVE_STOP_TO_BREAKEVEN/TIGHTEN_STOP/TAKE_PARTIAL/CLOSE_NOW/LET_WINNER_RUN/CANCEL_STACKING/ALLOW_STACKING
- `core/exit_learning.py` — `classify_exit_quality()` → PERFECT_EXIT/EARLY_EXIT/LATE_EXIT/BAD_ENTRY/STOP_TOO_WIDE/TP_TOO_SHORT/TIMEOUT_BAD/NORMAL_EXIT; `record_exit_outcome()` persists to DB

**QB endpoints:**
- `POST /exit/evaluate` — evaluates single open position; also persists recommendation to `exit_evaluations` table; returns HOLD fallback on any error (never 500)
- `POST /exit/record-outcome` — classifies + stores post-trade outcome in `exit_outcomes` table
- `GET /exit/stats?symbol=&side=&days=` — analytics by quality label and action

**DB tables (added to `knowledge.db`):**
- `exit_outcomes` — 1 row per closed trade: pnl_pct, mfe_pct, mae_pct, gave_back_pct, exit_quality, exit_action_taken, entry_aggressive_score
- `exit_evaluations` — 1 row per QB recommendation: action, confidence, reason, protection_level, momentum_score
- `trade_outcomes` migrations: +mfe_pct, +mae_pct, +gave_back_pct, +exit_quality, +exit_action_taken, +entry_aggressive_score

**Node.js client (`quantBrainClient.ts`):**
- `evaluateExit(input: ExitEvalInput)` — 4s timeout, returns `null` on QB down (never throws)
- `recordExitOutcome(payload)` — fire-and-forget, drops silently on QB down

## Key integration points in demo.ts

- `DemoOpenTrade.aggressiveScore?: number` — stored at order placement from `c.score`
- `sniperStackingBlockedCampaigns: Set<string>` — module-level; campaigns blocked from new adds by exit intelligence
- **Still-open branch** of monitor: calls `evaluateExit()` after `updateOpenTradeMfe()`
  - MFE/MAE converted: `mfePct = (storeEntry.mfe / entry.marginUsed) * 100` (demoTradeStore stores in USDT gross PnL)
  - Campaign depth: `getCampaignOpenCount(campaignId)` (sync, no args)
  - Campaign drawdown: sum of `t.mae` / sum of `t.marginUsed` from `getOpenTrades().filter(campaignId)` (sync)
  - If `shouldClose=true`: calls `closeDemoMarket(demoSniper.creds, ...)` auto-close
  - `stackingAction=CANCEL_STACKING` → adds to `sniperStackingBlockedCampaigns`
  - `stackingAction=ALLOW_STACKING` → removes from set
- **After trade close**: calls `recordExitOutcome()` with MFE/MAE from demoTradeStore before `closeOpenTrade()`
- **Stacking check in cycle**: `sniperStackingBlockedCampaigns.has(campaignIdPreview)` → blocks stack
- **Campaign fully closed**: `sniperStackingBlockedCampaigns.delete(campaignId)` cleanup

## getCampaignSummary gotcha

`getCampaignSummary()` is **async and takes NO arguments** — returns `Promise<Record<string, CampaignSummaryEntry>>`. Do NOT call it in synchronous paths or with a campaignId argument. Use `getCampaignOpenCount(campaignId)` (sync) for depth instead.

## Exit quality decision boundaries

| Label | Condition |
|---|---|
| PERFECT_EXIT | pnl_pct ≥ tp_pct × 0.85 |
| BAD_ENTRY | mfe_pct < tp_pct × 0.15 and (SL hit or timed out) |
| TIMEOUT_BAD | MANUAL/CLOSE_NOW + age > 1.8× expected + pnl ≤ 0 |
| STOP_TOO_WIDE | SL hit and mae_abs > sl_pct × 1.40 |
| LATE_EXIT | gave_back > mfe × 0.40 and mfe > tp × 0.30 |
| TP_TOO_SHORT | TP hit and mfe > tp × 1.60 |
| EARLY_EXIT | pnl > 0, mfe > pnl × 1.50, MANUAL/CLOSE_NOW |
| NORMAL_EXIT | fallback |
