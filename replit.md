# BingX Futures Dashboard

A professional futures trading dashboard for BingX, featuring real-time positions, orders, bot execution, adaptive telemetry, and demo trading.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/bingx-dashboard run dev` — run the frontend (port assigned by workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS v4, wouter, TanStack Query
- API: Express 5 + express-session (for BingX credential sessions)
- UI: shadcn/ui components, Recharts, Framer Motion
- Build: esbuild (CJS bundle for server)

## Where things live

- `artifacts/bingx-dashboard/src/` — React frontend source
- `artifacts/bingx-dashboard/src/pages/` — route pages (login, overview, positions, orders, analysis, bot, demo, intelligence, settings)
- `artifacts/bingx-dashboard/src/api-client/` — generated API client (hooks + custom fetch)
- `artifacts/api-server/src/routes/` — Express routes (bingx, bot, demo, telemetry, health)
- `artifacts/api-server/src/lib/` — backend libs (adaptiveEngine, botConfig, botModes, candleEdge, telemetryStore, quantBrainClient)
- `artifacts/api-server/src/app.ts` — Express app setup (sessions, CORS)

## Architecture decisions

- Frontend uses a self-contained local api-client (`src/api-client/`) with pre-generated hooks — no Orval codegen dependency for the frontend
- BingX credentials stored in server-side express-session (not localStorage) for security
- Adaptive trading engine (`adaptiveEngine.ts`) persists EWMA state to `telemetry.jsonl` on disk
- Bot config driven by ENV vars with in-memory runtime overrides via PATCH /api/bot/config
- Quant Brain integration is an optional advisory service with timeouts to prevent blocking trades

## Product

- Login with BingX API key/secret → dashboard with live account summary
- Positions, orders, and balance views with real-time data from BingX API
- Adaptive bot with scan/edge analysis, multiple execution modes (easy/standard/aggressive)
- Demo trading via BingX VST (demo account) with full telemetry tracking
- Intelligence page showing adaptive engine state, symbol profiles, and gate recommendations

## Gotchas

- Session secret defaults to a dev value — set `SESSION_SECRET` env var in production
- `SCALP_ALLOW_EXECUTION=true` env var required to enable live order execution (off by default)
- Quant Brain is an optional external service — app works fully without `QUANT_BRAIN_URL`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
