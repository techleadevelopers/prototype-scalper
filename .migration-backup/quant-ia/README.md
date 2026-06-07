# Intelligence Capture Edge - AI

is a standalone Python intelligence engine designed for edge intelligence, mathematical strategy validation, and positive Realized PnL optimization.

It analyzes historical and real-time transaction telemetry to detect edge drift, simulate gate rejections, identify toxic market contexts, and feed the BingX execution pipeline with high-probability parameters.

This is not an order execution service. It is the research, telemetry, and intelligence layer behind the execution stack.

## Objective

The objective is to transform raw market data and realized trade outcomes into actionable quantitative intelligence.

Quant Brain exists to answer operational questions:

- Which symbols are producing real edge after fees and losses?
- Which hours are toxic and should be blocked?
- Is BTC regime improving or destroying the current strategy?
- Is the edge stable, improving, or drifting down?
- Which setups should be rejected before capital is exposed?
- Which parameters should be sent to the execution backend?
- Is the bot producing positive Realized PnL or only high trade count?

The target is not prediction for its own sake. The target is positive realized PnL through measured, repeatable micro-edge.

## Core Design

```text
Market data
  -> feature extraction
  -> tactical anomaly detection
  -> knowledge base update
  -> strategic edge report
  -> AI analysis when configured
  -> parameter recommendations
  -> BingX execution pipeline
```

Quant Brain separates intelligence from execution:

- **Backend Node.js** signs orders, manages sessions, executes BingX calls, and stores realized trade telemetry.
- **Quant Brain Python** studies market behavior, realized outcomes, edge evolution, toxic contexts, and strategic recommendations.

## What It Does

### Real-Time Market Intelligence

The `FeatureEngine` monitors selected futures symbols and builds live snapshots with:

- price;
- price change;
- open interest movement;
- volume ratio;
- funding rate;
- approximate RSI;
- EMA state;
- BTC regime;
- anomaly flags.

These snapshots are exposed through the `/market/*` endpoints.

### Tactical Layer

The tactical layer looks for short-term patterns and active alerts.

It is used to detect conditions such as:

- unusual volume expansion;
- open interest displacement;
- BTC regime alignment;
- fast market anomalies;
- symbol-specific tactical opportunities.

Endpoints:

```text
GET  /tactical/alerts
POST /tactical/analyze
```

### Strategic Layer

The strategic layer looks at accumulated results over larger windows.

It evaluates:

- edge evolution;
- win rate migration;
- average PnL drift;
- symbol ranking;
- side-specific performance;
- structural changes in the strategy;
- long-term tactical decay.

Endpoints:

```text
GET  /strategic/report
GET  /strategic/edge-evolution
POST /strategic/analyze
POST /strategic/hypotheses
```

### Knowledge Base

The Knowledge Base stores operational observations and trade outcomes in SQLite.

It is the memory layer for:

- historical feature snapshots;
- observed tactical patterns;
- trade outcomes;
- symbol statistics;
- strategic insights;
- generated hypotheses.

Runtime database:

```text
data/knowledge.db
```

This file is private runtime data and must not be committed to Git.

Endpoints:

```text
GET  /kb/patterns
GET  /kb/observations
GET  /kb/insights
GET  /kb/stats
GET  /kb/stats/{symbol}
POST /kb/trades
GET  /kb/feature-history/{symbol}
```

## AI Analyst

Quant Brain can run AI-assisted analysis when `ANTHROPIC_API_KEY` is configured.

The AI layer is used for:

- tactical explanation of active alerts;
- weekly strategic review;
- hypothesis generation;
- detecting market regime changes;
- summarizing why edge may be improving or degrading.

Without `ANTHROPIC_API_KEY`, the system still runs the quantitative layers. AI endpoints return `ai_enabled: false` or operate without external model reasoning.

## Realized PnL Optimization

The engine is designed around Realized PnL, not theoretical signal quality.

Important metrics:

- realized PnL;
- win rate;
- average win;
- average loss;
- profit factor;
- edge drift;
- toxic hours;
- toxic symbols;
- BTC regime impact;
- fee drag;
- gate rejection quality.

The intended optimization loop:

```text
trade outcome
  -> knowledge base
  -> symbol/hour/regime statistics
  -> edge drift analysis
  -> gate recommendation
  -> backend execution parameters
  -> fewer low-quality entries
  -> higher realized PnL quality
```

## Gate Rejection Simulation

Quant Brain should be used to understand which filters would have prevented losing trades.

Examples:

- reject symbol after negative rolling PnL;
- reject trading hour with low win rate;
- reject BTC counter-regime entries;
- reject setups with poor historical profit factor;
- reject when recent edge drift is negative;
- reject when expected gain is smaller than fee/slippage cost.

This matters because the system target is not maximum activity. The target is maximum quality of accepted entries.

Available endpoint:

```text
GET /simulate/gate-rejections?days=30&min_avg_pnl=0
```

The response compares baseline PnL against hypothetical rejection gates by symbol, hour, and BTC regime.

## Entry Recommendation

The recommendation endpoint scores a pending entry using realized PnL history.

```text
POST /recommend/entry
```

Example payload:

```json
{
  "symbol": "ETH-USDT",
  "position_side": "LONG",
  "btc_regime": "BULL",
  "hour_utc": 14,
  "shadow_only": true
}
```

The endpoint returns:

- `shadowRecommendation`: whether the intelligence layer would allow the entry;
- `allow`: live gate result, disabled when `shadow_only=true`;
- `score`: 0-1 realized-edge score;
- `risk`: `shadow_only`, `scout`, `standard`, `aggressive`, or `reject`;
- `suggestedMarginUsdt`: suggested capital bucket: `0`, `0.50`, `1.00`, or `2.00`;
- `reasons`: audit trail for allow/reject;
- `stats`: symbol, cluster, regime, hour, and recent PnL statistics.

This should run in shadow mode until at least 100-300 closed trades prove that it improves net Realized PnL.

## Integration With BingX Execution Pipeline

Expected integration flow:

```text
BingX execution backend
  -> closes or records trade
  -> POST /kb/trades
  -> Quant Brain updates knowledge base
  -> strategic/tactical endpoints expose recommendations
  -> dashboard or backend reads recommendations
  -> execution gates are adjusted
```

The Node backend remains responsible for:

- session security;
- API key handling;
- HMAC signing;
- order submission;
- position management;
- immediate execution safety.

Quant Brain remains responsible for:

- analysis;
- edge intelligence;
- historical learning;
- AI-assisted reasoning;
- strategy validation.

## Requirements

Required:

- Python 3.11+
- pip or uv
- internet access for market data

Optional:

- `ANTHROPIC_API_KEY` for AI analysis
- persistent disk if deployed in cloud

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---:|---:|---|
| `PORT` | No | `9000` | HTTP port used by Uvicorn/FastAPI. |
| `ANTHROPIC_API_KEY` | No | empty | Enables AI analyst functionality. |
| `QUANT_BRAIN_API_TOKEN` | No | empty | Protects write/evaluation endpoints; use the same value in the backend. |

## Sniper Learning Safety

The primary learning label follows the executor's configured
`takeProfitPct` and `stopLossPct`. Fixed `0.50`, `1.00`, and `2.00` USDT
targets remain auxiliary opportunity metrics.

Signal outcomes:

- use executable ask entry / bid exit for long positions and the inverse for shorts;
- are limited to the first 300 seconds after the signal;
- record whether configured target or stop happened first;
- separate `ALLOW`, `WAIT`, and `BLOCK` samples;
- separate hypothetical candidates from executed outcomes;
- include fee, slippage, strategy version, and configuration identity.

The statistical model is shadow-only. Training uses temporal validation and
only persists a model when its calibrated Brier score beats the historical
baseline on the held-out period.

Endpoints:

```text
POST /signals/finalize
GET  /signals/edge/{symbol}
POST /models/sniper/train
GET  /models/sniper/status
POST /news/events
GET  /news/context/{symbol}
```

Example:

```env
PORT=9000
ANTHROPIC_API_KEY=
```

## Local Run

PowerShell:

```powershell
cd quant-brain
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
```

Healthcheck:

```text
GET http://localhost:9000/health
```

Expected response shape:

```json
{
  "status": "ok",
  "ai_enabled": false,
  "symbols_monitored": 10,
  "snapshots_cached": 10
}
```

## Run With Uvicorn

```powershell
uvicorn api.server:app --host 0.0.0.0 --port 9000
```

## Repository Rules

This directory is a standalone Git repository.

Commit from inside `quant-brain/`:

```powershell
cd quant-brain
git add .
git commit -m "feat: update quant brain"
git push
```

Do not commit:

```text
.env
.venv/
__pycache__/
data/knowledge.db
*.log
```

## Deployment Notes

For cloud deploy:

- configure the service root as `quant-brain`;
- install dependencies from `requirements.txt` or `pyproject.toml`;
- start with `python main.py` or `uvicorn api.server:app --host 0.0.0.0 --port $PORT`;
- configure `DATABASE_URL` with the same Railway Postgres used by the backend;
- set `QUANT_BRAIN_DB_SCHEMA=quant_brain` so Quant tables remain isolated;
- configure `ANTHROPIC_API_KEY` only in the cloud secret manager.

When `DATABASE_URL` or `QUANT_BRAIN_DATABASE_URL` is present, the service creates
and uses only the configured PostgreSQL schema. Without either variable it falls
back to `data/knowledge.db` for local development and tests.

Recommended Railway variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
QUANT_BRAIN_DB_SCHEMA=quant_brain
QUANT_BRAIN_DB_POOL_SIZE=5
QUANT_BRAIN_DB_COMMAND_TIMEOUT=30
DB_INIT_TIMEOUT_SECONDS=20
DB_INIT_RETRY_SECONDS=10
MODEL_MAINTENANCE_SECONDS=30
```

Using the same physical Postgres avoids another database service. Schema
isolation prevents Quant tables from mixing with backend tables. A dedicated
Postgres role can be added later for stricter permissions without changing the
application contract.

## Current Limitations

- SQLite is only the local fallback when PostgreSQL is not configured.
- No authentication layer is currently enforced by this service.
- CORS is permissive.
- AI analysis depends on Anthropic API availability.
- Recommendations are exposed through API but not yet enforced automatically by this service.

## Next Technical Advances

Priority improvements:

- add auth token between backend and Quant Brain;
- move `knowledge.db` to Postgres for durable cloud operation;
- add endpoint for explicit gate recommendations;
- add batch import from backend `telemetry.jsonl`;
- add fee/slippage-aware PnL normalization;
- add symbol toxicity scoring by rolling window;
- add hour blacklist recommendation endpoint;
- add BTC regime impact report by side;
- add backtest-style gate rejection simulator;
- add scheduled report export;
- add dashboard integration for strategic insights.

## Main Endpoints

```text
GET  /
GET  /health

GET  /market/snapshots
GET  /market/snapshots/{symbol}
GET  /market/anomalies

GET  /tactical/alerts
POST /tactical/analyze

GET  /strategic/report
GET  /strategic/edge-evolution
POST /strategic/analyze
POST /strategic/hypotheses

GET  /kb/patterns
GET  /kb/observations
GET  /kb/insights
GET  /kb/stats
GET  /kb/stats/{symbol}
POST /kb/trades
GET  /kb/feature-history/{symbol}

POST /recommend/entry
GET  /simulate/gate-rejections
```
