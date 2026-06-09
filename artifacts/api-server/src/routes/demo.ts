import { Router } from "express";
import { createHmac, randomUUID } from "crypto";
import type { Request, Response } from "express";
import { getBotConfig } from "../lib/botConfig";
import { exportAllOutcomes, getEngine, recordTradeOutcome, updateTradeOutcome } from "../lib/telemetryStore";
import { evaluateQuantBrainEdge, getQuantBrainRecentTrades, quantBrainGateMode, syncQuantBrainOutcome } from "../lib/quantBrainClient";
import type { BtcRegime, TradeOutcome } from "../lib/adaptiveEngine";
import { feeDragRejectReason, getCorrelation } from "../lib/executionRisk";
import { buildTelemetryState } from "./telemetry";
import { computeCandleEdge, computeAllCandleEdges } from "../lib/candleEdge";
import {
  getTriggerConfig,
  setTriggerConfig,
  updateCurrentPrice,
  checkAndFireTriggers,
  isTriggerEnabled,
  snapshotReferencePrice,
  type TriggerSignal,
} from "../lib/triggerStrategy";
import type { ClusterKey } from "../lib/adaptiveEngine";
import {
  buildAttachedProtection,
  candleConfirmationRejects,
  recentPerformanceRejects,
  summarizeRecentPerformance,
} from "../lib/entryProtection";
import {
  initDemoTradeStore,
  persistOpenTrade,
  updateOpenTradeMfe,
  closeOpenTrade,
  getOpenTrades,
  getOpenTradeByOrderId,
  getOpenTradesAsMap,
  getClosedTradeIds,
  getCampaignOpenCount,
  getActiveCampaignId,
  getClosedTradesForCampaign,
  getOpenTradesBySymbolSide,
  buildCampaignOutcome,
  resolveCampaignId,
  loadClosedTrades,
  getCampaignSummary,
  archiveClosedIfNeeded,
} from "../lib/demoTradeStore";
import {
  buildStackingAudit,
  campaignControlCap,
  evaluateStackingInsertion,
} from "../lib/stackingPolicy";
import {
  applyAggressionToConfig,
  evaluateAggression,
  getAggressionStatus,
  recordAggressionCycleImpact,
  type AggressionCandidate,
} from "../lib/aggressionController";
import {
  getServiceState,
  isEntryAllowed,
  isExecutionAllowed,
  isFallbackMode,
  recordQbFailure,
  recordQbSuccess,
  recordApiError,
  recordApiSuccess,
  recordTradeLoss,
  recordTradeWin,
  recordBtcPriceUpdate,
  updateVstEquity,
  checkDataFreshness,
  resetServiceState,
  getConsecutiveLosses,
} from "../lib/serviceState";
import {
  createExecutionCredentials,
  endpointForCredentials,
  type ExecutionCredentials,
} from "../lib/executionSecurity";
import {
  createClientOrderId,
  getUnresolvedOrders,
  initVstOrderJournal,
  normalizeBingXOrderState,
  recordOrderRequested,
  updateOrderState,
} from "../lib/vstOrderJournal";
import { assertCampaignAccounting, assertExposureInvariant } from "../lib/vstAccounting";

function isDemoOutcome(outcome: TradeOutcome): boolean {
  return outcome.isDemo === true || outcome.source === "bingx-vst";
}

function withDeadline<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

// Initialise persistent demo trade store on module load, then restore runtime state
void initDemoTradeStore().then(() => {
  // Restore sniperOpenTrades from JSONL after restart — ensures monitor works immediately
  let restored = 0;
  for (const [orderId, storeEntry] of getOpenTradesAsMap()) {
    if (!sniperOpenTrades.has(orderId)) {
      sniperOpenTrades.set(orderId, {
        orderId: storeEntry.orderId,
        symbol: storeEntry.symbol,
        side: storeEntry.side,
        positionSide: storeEntry.positionSide,
        quantity: storeEntry.qty,
        entryPrice: storeEntry.entryPrice,
        expectedEntryPrice: storeEntry.expectedEntryPrice,
        entryTime: storeEntry.entryTime,
        hourUtc: storeEntry.hourUtc,
        btcRegime: storeEntry.btcRegime as BtcRegime,
        leverage: storeEntry.leverage,
        marginUsed: storeEntry.marginUsed,
        expectedTpProfit: storeEntry.marginUsed * storeEntry.leverage * (storeEntry.tpPct / 100),
      });
      restored++;
    }
  }
  if (restored > 0) {
    console.info(`[demo-sniper] restored ${restored} open trade(s) from demoTradeStore after restart`);
  }
}).catch((err) => {
  console.error("[demoTradeStore] init failed", err);
});
void initVstOrderJournal().catch((err) => {
  console.error("[vstOrderJournal] init failed", err);
});

interface DemoOpenTrade {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  expectedEntryPrice?: number | null;
  entryTime: number;
  hourUtc: number;
  btcRegime: BtcRegime;
  leverage: number;
  marginUsed: number;
  expectedTpProfit: number;
}

declare module "express-session" {
  interface SessionData {
    demoCredentials?: ExecutionCredentials;
    demoOpenTrades?: Record<string, DemoOpenTrade>;
  }
}

const router = Router();

// VST (demo) usa endpoint diferente da conta real
const BINGX_BASE = "https://open-api-vst.bingx.com";
const BINGX_DEMO_MIN_INTERVAL_MS = 160; // ~6 requests/s max, below common 10/s limits
const BINGX_DEMO_JITTER_MS = 90;
const BINGX_REQUEST_TIMEOUT_MS = 12_000;
const DEMO_RECONCILE_DELAYS_MS = [10_000, 30_000, 60_000];

let nextBingXRequestAt = 0;
const pendingDemoReconciliations = new Map<string, NodeJS.Timeout>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleBingX(): Promise<void> {
  const now = Date.now();
  const jitter = Math.floor(Math.random() * BINGX_DEMO_JITTER_MS);
  const waitMs = Math.max(0, nextBingXRequestAt - now) + jitter;
  nextBingXRequestAt = Math.max(now, nextBingXRequestAt) + BINGX_DEMO_MIN_INTERVAL_MS + jitter;
  if (waitMs > 0) await sleep(waitMs);
}

function readRateLimitHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("rate") ||
      normalized.includes("limit") ||
      normalized.includes("weight") ||
      normalized.includes("remaining") ||
      normalized.includes("reset") ||
      normalized.startsWith("x-bx")
    ) {
      result[key] = value;
    }
  });
  return result;
}

async function parseBingXResponse(res: globalThis.Response): Promise<Record<string, unknown>> {
  const rateLimitHeaders = readRateLimitHeaders(res.headers);
  const retryAfter = Number(res.headers.get("retry-after") ?? "0");

  if (retryAfter > 0) {
    nextBingXRequestAt = Math.max(nextBingXRequestAt, Date.now() + retryAfter * 1000);
  }

  const data = await res.json() as Record<string, unknown>;
  if (Object.keys(rateLimitHeaders).length > 0) {
    data._rateLimit = rateLimitHeaders;
  }
  return data;
}

function isBingXSuccess(data: Record<string, unknown>): boolean {
  return String(data.code) === "0";
}

async function fetchBingX(url: string, init: RequestInit): Promise<globalThis.Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS),
  });
}

function sign(params: Record<string, string | number | undefined>, secretKey: string): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secretKey).update(query).digest("hex");
}

async function bingxGet(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  await throttleBingX();
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetchBingX(url, { headers: { "X-BX-APIKEY": apiKey } });
  return parseBingXResponse(res);
}

async function bingxPost(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  await throttleBingX();
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetchBingX(url, {
    method: "POST",
    headers: { "X-BX-APIKEY": apiKey },
  });
  return parseBingXResponse(res);
}

function extractBingXOrder(data: Record<string, unknown>): Record<string, unknown> | null {
  const payload = data.data as Record<string, unknown> | undefined;
  const order = payload?.order ?? payload;
  return order && typeof order === "object" ? order as Record<string, unknown> : null;
}

async function queryOrderByClientOrderId(
  clientOrderId: string,
  creds: { apiKey: string; secretKey: string },
): Promise<Record<string, unknown> | null> {
  const data = await bingxGet(
    "/openApi/swap/v2/trade/order",
    { clientOrderID: clientOrderId },
    creds.apiKey,
    creds.secretKey,
  );
  return isBingXSuccess(data) ? extractBingXOrder(data) : null;
}

async function placeVstOrderIdempotently(input: {
  creds: { apiKey: string; secretKey: string };
  clientOrderId: string;
  campaignId: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  quantity: number;
  params: Record<string, string | number | undefined>;
}): Promise<Record<string, unknown>> {
  assertExposureInvariant(input.positionSide, input.side, input.quantity, 0);
  const intent = await recordOrderRequested({
    clientOrderId: input.clientOrderId,
    campaignId: input.campaignId,
    symbol: input.symbol,
    side: input.side,
    positionSide: input.positionSide,
    requestedQuantity: input.quantity,
  });

  if (intent.exchangeOrderId) {
    const existing = await queryOrderByClientOrderId(input.clientOrderId, input.creds);
    if (existing) return existing;
  }

  let data: Record<string, unknown>;
  try {
    data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      { ...input.params, clientOrderId: input.clientOrderId },
      input.creds.apiKey,
      input.creds.secretKey,
    );
  } catch (error) {
    const recovered = await queryOrderByClientOrderId(input.clientOrderId, input.creds).catch(() => null);
    if (!recovered) {
      await updateOrderState(input.clientOrderId, {
        state: "UNKNOWN",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`ambiguous placement for ${input.clientOrderId}; exchange query returned no order`);
    }
    data = { code: 0, data: { order: recovered } };
  }

  if (!isBingXSuccess(data)) {
    await updateOrderState(input.clientOrderId, {
      state: "REJECTED",
      lastError: String(data.msg ?? "BingX rejected order"),
    });
    throw new Error(String(data.msg ?? "BingX rejected order"));
  }

  let order = extractBingXOrder(data);
  if (!order?.orderId) {
    order = await queryOrderByClientOrderId(input.clientOrderId, input.creds).catch(() => null);
  }
  if (!order?.orderId) {
    await updateOrderState(input.clientOrderId, {
      state: "UNKNOWN",
      lastError: "successful response without exchange orderId",
    });
    throw new Error(`BingX accepted ${input.clientOrderId} without a queryable exchange orderId`);
  }

  const rawState = String(order.status ?? "").toUpperCase();
  const reportedFilled =
    parseNumberField(order, ["executedQty", "filledQty", "quantity"]) ?? 0;
  const filledQuantity = rawState === "FILLED" ? input.quantity : reportedFilled;
  await updateOrderState(input.clientOrderId, {
    exchangeOrderId: String(order.orderId),
    filledQuantity: Math.min(input.quantity, filledQuantity),
    state: normalizeBingXOrderState(order.status, filledQuantity, input.quantity),
    lastError: null,
  });
  return order;
}

async function reconcileUnresolvedVstOrders(
  creds: { apiKey: string; secretKey: string },
): Promise<void> {
  for (const intent of getUnresolvedOrders()) {
    const order = await queryOrderByClientOrderId(intent.clientOrderId, creds).catch(() => null);
    if (!order?.orderId) continue;
    const rawState = String(order.status ?? "").toUpperCase();
    const reportedFilled =
      parseNumberField(order, ["executedQty", "filledQty", "quantity"]) ?? 0;
    const filledQuantity =
      rawState === "FILLED" ? intent.requestedQuantity : reportedFilled;
    await updateOrderState(intent.clientOrderId, {
      exchangeOrderId: String(order.orderId),
      filledQuantity: Math.min(intent.requestedQuantity, filledQuantity),
      state: normalizeBingXOrderState(
        order.status,
        filledQuantity,
        intent.requestedQuantity,
      ),
      lastError: null,
    });
  }
}

function getDemoCredentials(req: Request): { apiKey: string; secretKey: string } | null {
  const credentials = req.session.demoCredentials;
  if (!credentials) return null;
  endpointForCredentials(credentials, "demo");
  return credentials;
}

async function fetchDemoBalance(apiKey: string, secretKey: string) {
  for (const path of [
    "/openApi/swap/v3/user/balance",
    "/openApi/swap/v2/user/balance",
  ]) {
    const data = await bingxGet(path, {}, apiKey, secretKey);
    if (!isBingXSuccess(data)) continue;
    const payload = (data.data as Record<string, unknown>) ?? {};
    const balance = (payload.balance ?? payload) as Record<string, string>;
    if (balance && typeof balance === "object") return balance;
  }
  return null;
}

function mapDemoPositions(rawPositions: Record<string, unknown>[]) {
  return rawPositions
    .map((p) => {
      const rawAmount =
        p.positionAmt ?? p.positionAmount ?? p.availableAmt ?? p.positionQty ?? p.quantity ?? p.qty ?? "0";
      const amount = parseFloat(String(rawAmount));
      const positionSide = normalizePositionSide(p, amount);
      return {
        symbol: String(p.symbol ?? ""),
        positionSide,
        positionAmt: String(rawAmount),
        entryPrice: String(p.avgPrice ?? p.entryPrice ?? "0"),
        markPrice: String(p.markPrice ?? "0"),
        unrealizedProfit: String(p.unrealizedProfit ?? "0"),
        leverage: String(p.leverage ?? "1"),
        marginType: String(p.marginType ?? "isolated"),
        initialMargin: String(p.initialMargin ?? "0"),
        _amount: amount,
      };
    })
    .filter((p) => p.symbol && p.positionSide && p._amount !== 0)
    .map(({ _amount, ...p }) => p);
}

function normalizePositionSide(
  position: Record<string, unknown>,
  amount: number,
): "LONG" | "SHORT" | "" {
  const rawSide = String(position.positionSide ?? position.posSide ?? position.side ?? "").toUpperCase();
  if (rawSide === "LONG" || rawSide === "SHORT") return rawSide;
  if (rawSide === "BUY") return "LONG";
  if (rawSide === "SELL") return "SHORT";
  if (amount > 0) return "LONG";
  if (amount < 0) return "SHORT";
  return "";
}

function getRawPositions(data: Record<string, unknown>): Record<string, unknown>[] {
  const payload = data.data;
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const nested = (payload as Record<string, unknown>).positions;
    if (Array.isArray(nested)) return nested as Record<string, unknown>[];
  }
  return [];
}

function reconcileSessionOpenTrades(
  req: Request,
  exchangePositions: Array<{
    symbol: string;
    positionSide: string;
    positionAmt?: string;
    entryPrice?: string;
    leverage?: string;
    initialMargin?: string;
  }>,
): void {
  const openTrades = req.session.demoOpenTrades ?? {};
  const confirmed = new Map(
    exchangePositions.map((position) => [
      demoTradeKey(position.symbol, position.positionSide),
      position,
    ]),
  );
  const now = Date.now();
  const remaining = Object.fromEntries(Object.entries(openTrades).flatMap(([key, trade]) => {
    const position = confirmed.get(key);
    if (!position && now - trade.entryTime >= 30_000) return [];
    if (!position) return [[key, trade]];

    const entryPrice = Number(position.entryPrice || 0) || trade.entryPrice;
    const quantity = Math.abs(Number(position.positionAmt || 0)) || trade.quantity;
    const leverage = Number(position.leverage || 0) || trade.leverage;
    const initialMargin = Number(position.initialMargin || 0);
    const marginUsed = initialMargin > 0 ? initialMargin : (entryPrice * quantity) / leverage;
    return [[key, {
      ...trade,
      entryPrice,
      quantity,
      leverage,
      marginUsed,
      expectedTpProfit: marginUsed * (getBotConfig().takeProfitPct / 100) * leverage,
    }]];
  }));
  req.session.demoOpenTrades = remaining;
}

function numericBalance(balance: Record<string, string> | null): number | null {
  if (!balance) return null;
  const value = Number(balance.balance ?? balance.equity ?? "");
  return Number.isFinite(value) ? value : null;
}

async function fetchSettledDemoBalance(
  creds: { apiKey: string; secretKey: string },
  before: number | null,
): Promise<number | null> {
  let latest: number | null = null;
  for (const delay of [350, 700, 1200]) {
    await sleep(delay);
    latest = numericBalance(await fetchDemoBalance(creds.apiKey, creds.secretKey));
    if (before !== null && latest !== null && Math.abs(latest - before) > 1e-10) return latest;
  }
  return latest;
}

function demoTradeKey(symbol: string, positionSide: string): string {
  return `${symbol.toUpperCase()}:${positionSide.toUpperCase()}`;
}

/**
 * Query BingX income history for canonical realized PnL after a position closes.
 * Falls back gracefully — caller always falls back to price estimate on null return.
 */
async function fetchBingXRealizedPnl(
  symbol: string,
  startTime: number,
  endTime: number,
  apiKey: string,
  secretKey: string,
): Promise<{ realizedPnl: number; fee: number } | null> {
  try {
    const data = await bingxGet(
      "/openApi/swap/v2/user/income",
      { symbol, incomeType: "REALIZED_PNL", startTime, endTime, limit: 50 },
      apiKey,
      secretKey,
    );
    if (!isBingXSuccess(data)) return null;
    const items = data.data as Record<string, unknown>[];
    if (!Array.isArray(items) || items.length === 0) return null;

    let realizedPnl = 0;
    let fee = 0;
    for (const item of items) {
      const income = parseFloat(String(item.income ?? "0"));
      const type = String(item.incomeType ?? "");
      if (type === "REALIZED_PNL") realizedPnl += income;
      else if (type === "COMMISSION") fee += Math.abs(income);
    }
    return realizedPnl !== 0 ? { realizedPnl, fee } : null;
  } catch {
    return null;
  }
}

function parseNumberField(
  record: Record<string, unknown> | undefined,
  fields: string[],
): number | null {
  if (!record) return null;
  for (const field of fields) {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

async function fetchDemoLastPrice(symbol: string): Promise<number | null> {
  try {
    const url = `${BINGX_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}`;
    const tickerData = (await (await fetchBingX(url, {})).json()) as Record<string, unknown>;
    if (!isBingXSuccess(tickerData)) return null;
    const ticker = (tickerData.data as Record<string, unknown>) ?? {};
    return parseNumberField(ticker, ["lastPrice", "markPrice", "price"]);
  } catch {
    return null;
  }
}

function inferBtcRegime(btcChangePct: number | undefined, thresholdPct: number): BtcRegime {
  if (btcChangePct === undefined) return "NEUTRAL";
  if (btcChangePct >= thresholdPct) return "BULL";
  if (btcChangePct <= -thresholdPct) return "BEAR";
  return "NEUTRAL";
}

function estimateGrossPnl(
  positionSide: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  quantity: number,
): number {
  return positionSide === "LONG"
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
}

function estimateExecutionSlippage(
  positionSide: "LONG" | "SHORT",
  expectedPrice: number | undefined,
  executedPrice: number,
  quantity: number,
  leg: "entry" | "exit",
): number {
  if (!expectedPrice || expectedPrice <= 0 || executedPrice <= 0 || quantity <= 0) return 0;
  const isLong = positionSide === "LONG";
  const adversePriceMove = leg === "entry"
    ? (isLong ? executedPrice - expectedPrice : expectedPrice - executedPrice)
    : (isLong ? expectedPrice - executedPrice : executedPrice - expectedPrice);
  return Math.max(0, adversePriceMove * quantity);
}

function resolveDemoRealizedPnl(
  grossPnl: number,
  balanceBefore: number | null,
  balanceAfter: number | null,
  orderFee: number,
): { realizedPnl: number; fee: number; source: "balance_delta" | "price_estimate" } {
  const settledPnl = balanceBefore !== null && balanceAfter !== null
    ? balanceAfter - balanceBefore
    : null;

  if (settledPnl !== null && Math.abs(settledPnl) > 1e-10) {
    return {
      realizedPnl: settledPnl,
      fee: Math.max(0, grossPnl - settledPnl),
      source: "balance_delta",
    };
  }

  const fee = Math.max(0, orderFee);
  return {
    realizedPnl: grossPnl - fee,
    fee,
    source: "price_estimate",
  };
}

function enqueueDemoPnlReconciliation(
  req: Request,
  creds: { apiKey: string; secretKey: string },
  outcome: TradeOutcome,
  balanceBefore: number | null,
  grossPnl: number,
): void {
  if (outcome.pnlSource !== "price_estimate" || balanceBefore === null) return;
  if (pendingDemoReconciliations.has(outcome.id)) return;

  const runAttempt = (attempt: number) => {
    const delay = DEMO_RECONCILE_DELAYS_MS[attempt] ?? DEMO_RECONCILE_DELAYS_MS[DEMO_RECONCILE_DELAYS_MS.length - 1];
    const timeout = setTimeout(async () => {
      pendingDemoReconciliations.delete(outcome.id);
      try {
        const latestBalance = numericBalance(await fetchDemoBalance(creds.apiKey, creds.secretKey));
        if (latestBalance === null) {
          if (attempt + 1 < DEMO_RECONCILE_DELAYS_MS.length) runAttempt(attempt + 1);
          return;
        }

        const settledPnl = latestBalance - balanceBefore;
        if (Math.abs(settledPnl) <= 1e-10) {
          if (attempt + 1 < DEMO_RECONCILE_DELAYS_MS.length) runAttempt(attempt + 1);
          return;
        }

        const fee = Math.max(0, grossPnl - settledPnl);
        const updated = await updateTradeOutcome(outcome.id, {
          realizedPnl: settledPnl,
          fee,
          pnlSource: "balance_delta",
          estimated: false,
        });
        if (!updated) {
          req.log.warn({ outcomeId: outcome.id }, "demo pnl reconciliation skipped because outcome was not found");
          return;
        }

        void syncQuantBrainOutcome(updated).then((result) => {
          if (!result.synced && result.error !== "missing QUANT_BRAIN_URL") {
            req.log.warn({ error: result.error, outcomeId: updated.id }, "quant brain reconciliation sync skipped");
          }
        });
        req.log.info(
          { outcomeId: updated.id, symbol: updated.symbol, estimatedPnl: outcome.realizedPnl, settledPnl, fee, attempt: attempt + 1 },
          "demo pnl reconciled from settled balance delta",
        );
      } catch (err) {
        req.log.warn({ err, outcomeId: outcome.id, attempt: attempt + 1 }, "demo pnl reconciliation failed");
        if (attempt + 1 < DEMO_RECONCILE_DELAYS_MS.length) runAttempt(attempt + 1);
      }
    }, delay);
    timeout.unref?.();
    pendingDemoReconciliations.set(outcome.id, timeout);
  };

  runAttempt(0);
}

function recoverDemoOpenTrade(
  position: {
    symbol: string;
    positionSide: string;
    positionAmt: string;
    entryPrice: string;
    leverage: string;
    initialMargin: string;
  },
  config: ReturnType<typeof getBotConfig>,
): DemoOpenTrade | null {
  const positionSide = position.positionSide === "SHORT" ? "SHORT" : "LONG";
  const quantity = Math.abs(Number(position.positionAmt || 0));
  const entryPrice = Number(position.entryPrice || 0);
  const leverage = Number(position.leverage || 0) || config.leverage;
  if (quantity <= 0 || entryPrice <= 0) return null;
  const reportedMargin = Number(position.initialMargin || 0);
  const marginUsed = reportedMargin > 0 ? reportedMargin : (entryPrice * quantity) / leverage;
  return {
    orderId: `vst-recovered:${position.symbol}:${positionSide}:${entryPrice}`,
    symbol: position.symbol,
    side: positionSide === "LONG" ? "BUY" : "SELL",
    positionSide,
    quantity,
    entryPrice,
    entryTime: Date.now(),
    hourUtc: new Date().getUTCHours(),
    btcRegime: "NEUTRAL",
    leverage,
    marginUsed,
    expectedTpProfit: marginUsed * (config.takeProfitPct / 100) * leverage,
  };
}

function shouldStopDemoPosition(
  position: {
    positionSide: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unrealizedProfit: string;
    initialMargin: string;
    leverage: string;
  },
  config: ReturnType<typeof getBotConfig>,
): { shouldClose: boolean; reason: string; pnl: number; adverseMovePct: number; maxLoss: number } {
  const pnl = Number(position.unrealizedProfit || "0");
  const entryPrice = Number(position.entryPrice || "0");
  const markPrice = Number(position.markPrice || "0");
  const qty = Math.abs(Number(position.positionAmt || "0"));
  const fallbackMargin = config.marginPerTrade;
  const margin = Number(position.initialMargin || "0") > 0 ? Number(position.initialMargin) : fallbackMargin;
  const leverage = Number(position.leverage || "0") > 0 ? Number(position.leverage) : config.leverage;
  const maxLoss = margin * leverage * (config.stopLossPct / 100);

  let adverseMovePct = 0;
  if (entryPrice > 0 && markPrice > 0) {
    adverseMovePct = position.positionSide === "LONG"
      ? Math.max(0, ((entryPrice - markPrice) / entryPrice) * 100)
      : Math.max(0, ((markPrice - entryPrice) / entryPrice) * 100);
  }

  const shouldClose =
    qty > 0 &&
    (
      pnl <= -Math.abs(maxLoss) ||
      adverseMovePct >= config.stopLossPct
    );

  const reason = pnl <= -Math.abs(maxLoss)
    ? `PNL_STOP: ${pnl.toFixed(4)} <= -${Math.abs(maxLoss).toFixed(4)}`
    : `PRICE_STOP: ${adverseMovePct.toFixed(3)}% >= ${config.stopLossPct}%`;

  return { shouldClose, reason, pnl, adverseMovePct, maxLoss };
}

function shouldTakeProfitDemoPosition(
  position: {
    positionSide: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unrealizedProfit: string;
    initialMargin: string;
    leverage: string;
  },
  config: ReturnType<typeof getBotConfig>,
): { shouldClose: boolean; reason: string; pnl: number; favorableMovePct: number; targetProfit: number } {
  const pnl = Number(position.unrealizedProfit || "0");
  const entryPrice = Number(position.entryPrice || "0");
  const markPrice = Number(position.markPrice || "0");
  const qty = Math.abs(Number(position.positionAmt || "0"));
  const fallbackMargin = config.marginPerTrade;
  const margin = Number(position.initialMargin || "0") > 0 ? Number(position.initialMargin) : fallbackMargin;
  const leverage = Number(position.leverage || "0") > 0 ? Number(position.leverage) : config.leverage;
  const targetProfit = margin * leverage * (config.takeProfitPct / 100);

  let favorableMovePct = 0;
  if (entryPrice > 0 && markPrice > 0) {
    favorableMovePct = position.positionSide === "LONG"
      ? Math.max(0, ((markPrice - entryPrice) / entryPrice) * 100)
      : Math.max(0, ((entryPrice - markPrice) / entryPrice) * 100);
  }

  const shouldClose =
    qty > 0 &&
    (
      pnl >= Math.abs(targetProfit) ||
      favorableMovePct >= config.takeProfitPct
    );

  const reason = pnl >= Math.abs(targetProfit)
    ? `PNL_TAKE_PROFIT: ${pnl.toFixed(4)} >= ${Math.abs(targetProfit).toFixed(4)}`
    : `PRICE_TAKE_PROFIT: ${favorableMovePct.toFixed(3)}% >= ${config.takeProfitPct}%`;

  return { shouldClose, reason, pnl, favorableMovePct, targetProfit };
}

async function closeDemoMarket(
  creds: { apiKey: string; secretKey: string },
  symbol: string,
  positionSide: "LONG" | "SHORT",
  quantity: number,
): Promise<Record<string, unknown>> {
  const closeSide = positionSide === "LONG" ? "SELL" : "BUY";
  return bingxPost(
    "/openApi/swap/v2/trade/order",
    { symbol, side: closeSide, positionSide, type: "MARKET", quantity },
    creds.apiKey,
    creds.secretKey,
  );
}

async function closeTriggeredDemoPositions(
  req: Request,
  creds: { apiKey: string; secretKey: string },
  positions: Array<{
    symbol: string;
    positionSide: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unrealizedProfit: string;
    initialMargin: string;
    leverage: string;
  }>,
  config: ReturnType<typeof getBotConfig>,
): Promise<Array<{
  symbol: string;
  positionSide: string;
  quantity: number;
  reason: string;
  pnl: number;
  orderId: string | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
}>> {
  const closed: Array<{
    symbol: string;
    positionSide: string;
    quantity: number;
    reason: string;
    pnl: number;
    orderId: string | null;
    balanceBefore: number | null;
    balanceAfter: number | null;
    telemetryId?: string;
    pnlSource?: "balance_delta" | "price_estimate";
    estimated?: boolean;
    reconciliationQueued?: boolean;
  }> = [];

  for (const position of positions) {
    const stop = shouldStopDemoPosition(position, config);
    const takeProfit = shouldTakeProfitDemoPosition(position, config);
    const closeSignal = stop.shouldClose
      ? { reason: stop.reason, pnl: stop.pnl, exitReason: "SL" as const }
      : takeProfit.shouldClose
        ? { reason: takeProfit.reason, pnl: takeProfit.pnl, exitReason: "TP" as const }
        : null;
    if (!closeSignal) continue;

    const positionSide = position.positionSide === "LONG" ? "LONG" : "SHORT";
    const quantity = Math.abs(Number(position.positionAmt || "0"));
    if (!quantity) continue;

    const balanceBefore = numericBalance(await fetchDemoBalance(creds.apiKey, creds.secretKey));
    const closeData = await closeDemoMarket(creds, position.symbol, positionSide, quantity);
    if (!isBingXSuccess(closeData)) {
      req.log.error({ closeData, position, closeSignal }, "demo risk close BingX error");
      continue;
    }

    const order = (closeData.data as Record<string, unknown>)?.order as Record<string, unknown> | undefined;
    const orderId = order?.orderId ? String(order.orderId) : null;
    const key = demoTradeKey(position.symbol, position.positionSide);
    const entry = req.session.demoOpenTrades?.[key] ?? recoverDemoOpenTrade(position, config);
    const exitPrice =
      parseNumberField(order, ["avgPrice", "price", "executedPrice"]) ??
      (Number(position.markPrice || "0") || await fetchDemoLastPrice(position.symbol));

    const balanceAfter = await fetchSettledDemoBalance(creds, balanceBefore);
    if (entry && exitPrice) {
      const closeQty = Math.min(quantity, entry.quantity);
      const grossPnl = estimateGrossPnl(entry.positionSide, entry.entryPrice, exitPrice, closeQty);
      const orderFee = parseNumberField(order, ["commission", "fee"]) ?? 0;
      const realized = resolveDemoRealizedPnl(grossPnl, balanceBefore, balanceAfter, orderFee);
      const expectedExitPrice = Number(position.markPrice || "0") || undefined;
      const entrySlippage = estimateExecutionSlippage(entry.positionSide, entry.expectedEntryPrice ?? undefined, entry.entryPrice, closeQty, "entry");
      const exitSlippage = estimateExecutionSlippage(entry.positionSide, expectedExitPrice, exitPrice, closeQty, "exit");
      const totalSlippage = entrySlippage + exitSlippage;
      const notional = entry.entryPrice * closeQty;
      const outcome = recordTradeOutcome({
        isDemo: true,
        source: "bingx-vst",
        entryOrderId: entry.orderId,
        exitOrderId: orderId ?? undefined,
        symbol: position.symbol,
        positionSide: entry.positionSide,
        side: entry.side,
        entryTime: entry.entryTime,
        exitTime: Date.now(),
        hourUtc: entry.hourUtc,
        btcRegime: entry.btcRegime,
        entryPrice: entry.entryPrice,
        exitPrice,
        qty: closeQty,
        leverage: entry.leverage,
        marginUsed: entry.marginUsed,
        grossPnl,
        fee: realized.fee,
        realizedPnl: realized.realizedPnl,
        pnlSource: realized.source,
        estimated: realized.source === "price_estimate",
        expectedEntryPrice: entry.expectedEntryPrice ?? undefined,
        expectedExitPrice,
        entrySlippage,
        exitSlippage,
        totalSlippage,
        slippagePctNotional: notional > 0 ? totalSlippage / notional : 0,
        exitReason: closeSignal.exitReason,
        expectedTpProfit: entry.expectedTpProfit,
      });
      const reconciliationQueued = realized.source === "price_estimate" && balanceBefore !== null;
      if (realized.source === "price_estimate") {
        req.log.warn(
          { symbol: position.symbol, positionSide, orderId, grossPnl, orderFee, balanceBefore, balanceAfter, outcomeId: outcome.id },
          "demo risk close recorded telemetry from price estimate because settled balance delta was unavailable",
        );
      }
      void syncQuantBrainOutcome(outcome).then((result) => {
        if (!result.synced && result.error !== "missing QUANT_BRAIN_URL") {
          req.log.warn({ error: result.error, outcomeId: outcome.id }, "quant brain sync skipped");
        }
      });
      enqueueDemoPnlReconciliation(req, creds, outcome, balanceBefore, grossPnl);
      closed.push({
        symbol: position.symbol,
        positionSide: position.positionSide,
        quantity,
        reason: closeSignal.reason,
        pnl: closeSignal.pnl,
        orderId,
        balanceBefore,
        balanceAfter,
        telemetryId: outcome.id,
        pnlSource: realized.source,
        estimated: realized.source === "price_estimate",
        reconciliationQueued,
      });
      const { [key]: _closed, ...remaining } = req.session.demoOpenTrades ?? {};
      req.session.demoOpenTrades = remaining;
      continue;
    }

    const { [key]: _closed, ...remaining } = req.session.demoOpenTrades ?? {};
    req.session.demoOpenTrades = remaining;

    closed.push({
      symbol: position.symbol,
      positionSide: position.positionSide,
      quantity,
      reason: closeSignal.reason,
      pnl: closeSignal.pnl,
      orderId,
      balanceBefore,
      balanceAfter,
    });
  }

  return closed;
}

/** POST /api/demo/connect - reuses credentials already stored by login. */
router.post("/demo/connect", async (req: Request, res: Response) => {
  const loginCredentials = req.session.liveCredentials;
  if (!loginCredentials) {
    res.status(400).json({
      connected: false,
      error: "Sessao de login nao encontrada. Entre novamente antes de ativar o Demo VST.",
    });
    return;
  }

  try {
    const credentials = createExecutionCredentials({
      environment: "demo",
      accountId: `demo-${loginCredentials.fingerprint}`,
      apiKey: loginCredentials.apiKey,
      secretKey: loginCredentials.secretKey,
      source: "demo-connect",
    });
    endpointForCredentials(credentials, "demo");
    const bal = await fetchDemoBalance(credentials.apiKey, credentials.secretKey);
    if (!bal) {
      res.status(401).json({ connected: false, error: "Conta demo VST não acessível com essas credenciais. Verifique se a conta demo está ativada no app BingX." });
      return;
    }

    req.session.demoCredentials = credentials;
    rememberTriggerCredentials(credentials);
    activateAutonomousTrigger(req.log);
    await reconcileUnresolvedVstOrders(credentials);

    const posData = await bingxGet(
      "/openApi/swap/v2/user/positions",
      {},
      credentials.apiKey,
      credentials.secretKey,
    );
    const positions = isBingXSuccess(posData) ? mapDemoPositions(getRawPositions(posData)) : [];
    if (isBingXSuccess(posData)) reconcileSessionOpenTrades(req, positions);

    res.json({
      connected: true,
      accountId: credentials.accountId,
      environment: credentials.environment,
      credentialFingerprint: credentials.fingerprint,
      balance: bal.balance ?? "0",
      equity: bal.equity ?? bal.balance ?? "0",
      availableBalance: bal.availableMargin ?? "0",
      usedMargin: bal.usedMargin ?? "0",
      unrealizedPnl: bal.unrealizedProfit ?? "0",
      openPositionsCount: positions.length,
      positions,
      positionsConfirmed: isBingXSuccess(posData),
      currency: bal.asset ?? "VST",
    });
  } catch (err) {
    req.log.error({ err }, "demo connect error");
    res.status(500).json({ connected: false, error: "Falha ao conectar ao servidor VST" });
  }
});

/** POST /api/demo/disconnect */
router.post("/demo/disconnect", (req: Request, res: Response) => {
  req.session.demoCredentials = undefined;
  req.session.demoOpenTrades = undefined;
  triggerExecutionCreds = null;
  res.json({ disconnected: true });
});

/** GET /api/demo/status */
router.get("/demo/status", async (req: Request, res: Response) => {
  const creds = getDemoCredentials(req);
  if (!creds) {
    res.json({ connected: false });
    return;
  }

  try {
    const [balData, posData] = await Promise.all([
      bingxGet("/openApi/swap/v2/user/balance", {}, creds.apiKey, creds.secretKey),
      bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey),
    ]);

    if (!isBingXSuccess(balData)) {
      res.json({ connected: false, error: "Could not fetch demo balance" });
      return;
    }

    const bal = ((balData.data as Record<string, unknown>)?.balance ?? {}) as Record<string, string>;
    const positions = isBingXSuccess(posData) ? mapDemoPositions(getRawPositions(posData)) : [];
    if (isBingXSuccess(posData)) reconcileSessionOpenTrades(req, positions);

    res.json({
      connected: true,
      balance: bal.balance ?? "0",
      equity: bal.equity ?? bal.balance ?? "0",
      availableBalance: bal.availableMargin ?? "0",
      usedMargin: bal.usedMargin ?? "0",
      unrealizedPnl: bal.unrealizedProfit ?? "0",
      openPositionsCount: positions.length,
      positions,
      positionsConfirmed: isBingXSuccess(posData),
      currency: bal.asset ?? "VST",
    });
  } catch (err) {
    req.log.error({ err }, "demo status error");
    res.json({ connected: false, error: "Status fetch failed" });
  }
});

/** GET /api/demo/positions */
router.get("/demo/positions", async (req: Request, res: Response) => {
  const creds = getDemoCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Demo not connected." });
    return;
  }

  try {
    const data = await bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey);
    if (!isBingXSuccess(data)) {
      res.status(502).json({ error: "BingX VST positions unavailable" });
      return;
    }
    const positions = mapDemoPositions(getRawPositions(data));
    reconcileSessionOpenTrades(req, positions);
    res.json(positions);
  } catch (err) {
    req.log.error({ err }, "demo positions error");
    res.status(500).json({ error: "Demo positions fetch failed" });
  }
});

/** GET /api/demo/analysis-state — read-only account + demo-scoped telemetry */
router.get("/demo/analysis-state", async (req: Request, res: Response) => {
  const creds = getDemoCredentials(req);
  if (!creds) {
    res.json({
      connected: false,
      positions: [],
      openUnrealizedPnl: 0,
      telemetry: await buildTelemetryState("demo"),
    });
    return;
  }

  try {
    const [balData, posData, telemetry] = await Promise.all([
      bingxGet("/openApi/swap/v2/user/balance", {}, creds.apiKey, creds.secretKey),
      bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey),
      buildTelemetryState("demo"),
    ]);

    if (!isBingXSuccess(balData)) {
      res.status(502).json({ connected: false, error: "Could not fetch demo balance", positions: [], telemetry });
      return;
    }

    const bal = ((balData.data as Record<string, unknown>)?.balance ?? {}) as Record<string, string>;
    const positions = isBingXSuccess(posData) ? mapDemoPositions(getRawPositions(posData)) : [];
    if (isBingXSuccess(posData)) reconcileSessionOpenTrades(req, positions);
    const openUnrealizedPnl = positions.reduce((sum, position) => {
      const pnl = Number(position.unrealizedProfit);
      return sum + (Number.isFinite(pnl) ? pnl : 0);
    }, 0);

    res.json({
      connected: true,
      balance: bal.balance ?? "0",
      equity: bal.equity ?? bal.balance ?? "0",
      availableBalance: bal.availableMargin ?? "0",
      usedMargin: bal.usedMargin ?? "0",
      unrealizedPnl: bal.unrealizedProfit ?? String(openUnrealizedPnl),
      openUnrealizedPnl,
      openPositionsCount: positions.length,
      positions,
      positionsConfirmed: isBingXSuccess(posData),
      currency: bal.asset ?? "VST",
      telemetry,
    });
  } catch (err) {
    req.log.error({ err }, "demo analysis state error");
    res.status(500).json({ connected: false, error: "Demo analysis state failed" });
  }
});

/** POST /api/demo/risk-check — auto-close demo positions that hit stop loss or take profit */
router.post("/demo/risk-check", async (req: Request, res: Response) => {
  const creds = getDemoCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Demo not connected." });
    return;
  }

  const config = getBotConfig();

  try {
    const data = await bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey);
    if (!isBingXSuccess(data)) {
      res.status(502).json({ error: "BingX VST positions unavailable" });
      return;
    }
    const positions = mapDemoPositions(getRawPositions(data));
    reconcileSessionOpenTrades(req, positions);
    const closed = await closeTriggeredDemoPositions(req, creds, positions, config);

    res.json({ checked: positions.length, closed });
  } catch (err) {
    req.log.error({ err }, "demo risk check error");
    res.status(500).json({ error: "Demo risk check failed" });
  }
});

/** POST /api/demo/order — gate evaluation + optional demo execution */
router.post("/demo/order", async (req: Request, res: Response) => {
  const creds = getDemoCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Demo not connected. Connect your VST account first." });
    return;
  }

  const config = getBotConfig();
  const {
    symbol,
    side,
    positionSide,
    quantity,
    currentEv,
    currentWinRate,
    currentProfitFactor,
    btcChangePct,
    lastPrice,
    execute,
    idempotencyKey,
  } = req.body as {
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    quantity?: number;
    currentEv?: number;
    currentWinRate?: number;
    currentProfitFactor?: number;
    btcChangePct?: number;
    lastPrice?: string | number;
    execute?: boolean;
    idempotencyKey?: string;
  };

  if (!symbol || !side || !positionSide) {
    res.status(400).json({ error: "symbol, side, and positionSide are required" });
    return;
  }

  const gateRejects: string[] = [];
  const currentHour = new Date().getUTCHours();
  const quantGateMode = quantBrainGateMode();
  let quantBrainEdge: unknown = null;
  const recentPerformance = summarizeRecentPerformance(
    getEngine().rawOutcomes().filter((outcome) => outcome.isDemo === true || outcome.source === "bingx-vst"),
    config,
  );
  gateRejects.push(...recentPerformanceRejects(recentPerformance, config));

  const candle = await computeCandleEdge(symbol, "5m");
  gateRejects.push(...candleConfirmationRejects(candle, positionSide, config));

  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(symbol)) {
    gateRejects.push(`SYMBOL_REJECT: ${symbol} not in allowlist`);
  }

  if (config.hourBlacklist.includes(currentHour)) {
    gateRejects.push(`HOUR_REJECT: UTC hour ${currentHour} is blacklisted`);
  }

  if (quantGateMode === "off" && config.btcRegimeRequired && btcChangePct !== undefined) {
    const absChange = Math.abs(btcChangePct);
    if (absChange < config.btcRegimeThresholdPct) {
      gateRejects.push(`REGIME_REJECT: BTC ${btcChangePct.toFixed(2)}% < ±${config.btcRegimeThresholdPct}%`);
    } else {
      const btcBull = btcChangePct > 0;
      const wantLong = positionSide === "LONG";
      if (!config.allowCounterRegimeScalp && btcBull !== wantLong) {
        gateRejects.push(`REGIME_DIRECTION: BTC ${btcBull ? "BULL" : "BEAR"} vs ${positionSide}`);
      }
    }
  }

  if (quantGateMode === "off" && config.evMinThreshold > 0 && currentEv !== undefined && currentEv < config.evMinThreshold) {
    gateRejects.push(`EV_REJECT: EV ${currentEv.toFixed(4)} < ${config.evMinThreshold.toFixed(4)}`);
  }

  const feeDragReject = quantGateMode === "off" ? feeDragRejectReason(currentEv, config.marginPerTrade, config) : null;
  if (feeDragReject) {
    gateRejects.push(feeDragReject);
  }

  if (quantGateMode === "off" && config.winRateMin > 0 && currentWinRate !== undefined && currentWinRate < config.winRateMin) {
    gateRejects.push(`WR_REJECT: WR ${(currentWinRate * 100).toFixed(1)}% < ${(config.winRateMin * 100).toFixed(1)}%`);
  }

  if (quantGateMode === "off" && config.profitFactorMin > 0 && currentProfitFactor !== undefined && currentProfitFactor < config.profitFactorMin) {
    gateRejects.push(`PF_REJECT: PF ${currentProfitFactor.toFixed(2)}x < ${config.profitFactorMin.toFixed(2)}x`);
  }

  if (quantGateMode === "shadow") {
    quantBrainEdge = {
      allow: true,
      gateRejects: [],
      authority: "backend-shadow-async",
      mode: "shadow_async",
    };
    void evaluateQuantBrainEdge({
      symbol,
      side,
      positionSide,
      hourUtc: currentHour,
      btcChangePct,
      currentEv,
      currentWinRate,
      currentProfitFactor,
      config,
      marketEventId: candle.marketEventId,
      featureVersion: "candle-edge-v1",
    }).then((edge) => {
      if (edge.error && edge.error !== "missing QUANT_BRAIN_URL") {
        req.log.warn({ error: edge.error, symbol, positionSide }, "quant brain edge unavailable");
      }
    }).catch((err) => {
      req.log.warn({
        error: err instanceof Error ? err.message : String(err),
        symbol,
        positionSide,
      }, "quant brain edge unavailable");
    });
  } else if (quantGateMode === "enforce") {
    const edge = await evaluateQuantBrainEdge({
      symbol,
      side,
      positionSide,
      hourUtc: currentHour,
      btcChangePct,
      currentEv,
      currentWinRate,
      currentProfitFactor,
      config,
      marketEventId: candle.marketEventId,
      featureVersion: "candle-edge-v1",
    });
    quantBrainEdge = edge;
    if (edge.error && edge.error !== "missing QUANT_BRAIN_URL") {
      req.log.warn({ error: edge.error, symbol, positionSide }, "quant brain edge unavailable");
      // Track QB failures for service state machine
      const isTimeout = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(edge.error ?? "");
      recordQbFailure(isTimeout ? "timeout" : "unavailable");
    } else if (!edge.error) {
      recordQbSuccess();
    }
    if (execute && edge.error) {
      gateRejects.push(`QUANT_UNAVAILABLE_REJECT: ${edge.error}`);
    }
    if (!edge.allow) {
      gateRejects.push(...edge.gateRejects.map((r) => `QUANT_${r}`));
    }
  }

  let openPositionsCount = 0;
  let marginUtilization = 0;
  let openPositions: ReturnType<typeof mapDemoPositions> = [];
  try {
    const [posData, balData] = await Promise.all([
      bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey),
      bingxGet("/openApi/swap/v2/user/balance", {}, creds.apiKey, creds.secretKey),
    ]);
    if (isBingXSuccess(posData)) {
      openPositions = mapDemoPositions(getRawPositions(posData));
      openPositionsCount = openPositions.length;
    }
    if (isBingXSuccess(balData)) {
      const bal = ((balData.data as Record<string, unknown>)?.balance ?? {}) as Record<string, string>;
      const usedMargin = parseFloat(bal.usedMargin ?? "0");
      const equity = parseFloat(bal.equity ?? "1");
      marginUtilization = equity > 0 ? usedMargin / equity : 0;
    }
  } catch {
    // non-fatal
  }

  const demoPositionLimit = Math.max(config.maxConcurrentPositions, DEMO_SNIPER_GLOBAL_MAX);
  if (openPositionsCount >= demoPositionLimit) {
    gateRejects.push(`CAPITAL_REJECT: ${openPositionsCount} positions >= demo max ${demoPositionLimit}`);
  }
  if (config.preventHedgedPositions && openPositions.some((position) => position.symbol === symbol)) {
    const sides = openPositions
      .filter((position) => position.symbol === symbol)
      .map((position) => position.positionSide)
      .join(",");
    gateRejects.push(`POSITION_CONFLICT_REJECT: ${symbol} already has open side ${sides}`);
  }
  if (marginUtilization > config.maxMarginUtilization) {
    gateRejects.push(`MARGIN_REJECT: ${(marginUtilization * 100).toFixed(1)}% > max ${(config.maxMarginUtilization * 100).toFixed(0)}%`);
  }

  if (!execute || gateRejects.length > 0) {
    const mode = !execute ? "observation" : "gate_reject";
    req.log.info({ symbol, side, positionSide, gateRejects, mode }, "demo order eval");
    res.status(gateRejects.length > 0 ? 403 : 200).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: quantity ?? null,
      gateRejects,
      quantBrainGateMode: quantGateMode,
      quantBrainEdge,
      recentPerformance,
      candleConfirmation: {
        suggestedSide: candle.suggestedSide,
        longScore: candle.longScore,
        shortScore: candle.shortScore,
        emaCross: candle.emaCross,
        volumeRatio: candle.volumeRatio,
      },
      observationMode: !execute,
      message: gateRejects.length > 0
        ? `BLOCKED by ${gateRejects.length} gate(s): ${gateRejects[0]}`
        : "All gates pass. Observation mode — set execute=true to fire on demo account.",
    });
    return;
  }

  let qty = quantity;
  let referencePrice = Number(lastPrice);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    referencePrice = Number(await fetchDemoLastPrice(symbol));
  }
  if (!qty) {
    try {
      if (referencePrice > 0) {
        qty = (config.marginPerTrade * config.leverage) / referencePrice;
        qty = Math.floor(qty * 1000) / 1000;
      }
    } catch {
      // use fallback
    }
  }

  if (!qty || qty <= 0) {
    res.status(400).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: null,
      gateRejects: ["QTY_REJECT: could not compute valid quantity"],
      quantBrainGateMode: quantGateMode,
      quantBrainEdge,
      observationMode: false,
      message: "Could not determine order quantity.",
    });
    return;
  }

  try {
    const protection = buildAttachedProtection(referencePrice, positionSide, config);
    const campaignId = resolveCampaignId(symbol, positionSide, Date.now());
    const clientOrderId = createClientOrderId(
      `manual:${symbol}:${positionSide}`,
      idempotencyKey,
    );
    const orderParams: Record<string, string | number | undefined> = {
      symbol,
      side,
      positionSide,
      type: config.orderType,
      quantity: qty,
      leverage: config.leverage,
      stopLoss: protection?.stopLoss,
      takeProfit: protection?.takeProfit,
    };
    const order = await placeVstOrderIdempotently({
      creds,
      clientOrderId,
      campaignId,
      symbol,
      side,
      positionSide,
      quantity: qty,
      params: orderParams,
    });
    const orderId = String(order.orderId);
    const expectedEntryPrice = parseNumberField({ lastPrice }, ["lastPrice"]) ?? undefined;
    const entryPrice =
      parseNumberField(order, ["avgPrice", "price", "executedPrice"]) ??
      expectedEntryPrice ??
      await fetchDemoLastPrice(symbol);

    if (entryPrice) {
      const marginUsed = (entryPrice * qty) / config.leverage;
      const openTrade: DemoOpenTrade = {
        orderId,
        symbol,
        side,
        positionSide,
        quantity: qty,
        entryPrice,
        expectedEntryPrice,
        entryTime: Date.now(),
        hourUtc: currentHour,
        btcRegime: inferBtcRegime(btcChangePct, config.btcRegimeThresholdPct),
        leverage: config.leverage,
        marginUsed,
        expectedTpProfit: marginUsed * (config.takeProfitPct / 100) * config.leverage,
      };
      req.session.demoOpenTrades = {
        ...(req.session.demoOpenTrades ?? {}),
        [demoTradeKey(symbol, positionSide)]: openTrade,
      };
    }

    req.log.info({
      symbol,
      side,
      positionSide,
      qty,
      orderId: order?.orderID ?? order?.orderId,
      attachedStopPrice: protection?.stopPrice,
      attachedTakeProfitPrice: protection?.takeProfitPrice,
    }, "demo order placed");
    res.json({
      placed: true,
      orderId,
      clientOrderId,
      symbol,
      side,
      quantity: qty,
      gateRejects: [],
      quantBrainGateMode: quantGateMode,
      quantBrainEdge,
      recentPerformance,
      protection: protection
        ? {
            attached: true,
            stopPrice: protection.stopPrice,
            takeProfitPrice: protection.takeProfitPrice,
          }
        : { attached: false },
      observationMode: false,
      message: `Demo order placed: ${side} ${qty} ${symbol} @ MARKET`,
    });
  } catch (err) {
    req.log.error({ err }, "demo order error");
    res.status(500).json({ error: "Demo order execution failed" });
  }
});

/** POST /api/demo/close */
router.post("/demo/close", async (req: Request, res: Response) => {
  const creds = getDemoCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Demo not connected." });
    return;
  }

  const { symbol, positionSide, quantity } = req.body as {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    quantity: string;
  };

  if (!symbol || !positionSide || !quantity) {
    res.status(400).json({ error: "symbol, positionSide, and quantity are required" });
    return;
  }

  const qty = Math.abs(parseFloat(quantity));
  if (!Number.isFinite(qty) || qty <= 0) {
    res.status(400).json({ error: "quantity must be greater than 0" });
    return;
  }

  const closeSide = positionSide === "LONG" ? "SELL" : "BUY";

  try {
    const positionsData = await bingxGet(
      "/openApi/swap/v2/user/positions",
      { symbol },
      creds.apiKey,
      creds.secretKey,
    );
    const positionBefore = isBingXSuccess(positionsData)
      ? mapDemoPositions(getRawPositions(positionsData)).find(
        (position) => position.symbol === symbol && position.positionSide === positionSide,
      )
      : undefined;
    const balanceBefore = numericBalance(await fetchDemoBalance(creds.apiKey, creds.secretKey));
    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      { symbol, side: closeSide, positionSide, type: "MARKET", quantity: qty },
      creds.apiKey,
      creds.secretKey,
    );

    if (!isBingXSuccess(data)) {
      res.status(500).json({
        placed: false,
        orderId: null,
        symbol,
        side: closeSide,
        quantity: qty,
        gateRejects: [],
        observationMode: false,
        message: `BingX error: ${(data.msg as string) ?? "unknown"}`,
      });
      return;
    }

    const order = (data.data as Record<string, unknown>)?.order as Record<string, unknown>;
    const orderId = String(order?.orderId ?? "");
    const balanceAfter = await fetchSettledDemoBalance(creds, balanceBefore);
    const key = demoTradeKey(symbol, positionSide);
    const entry = req.session.demoOpenTrades?.[key]
      ?? (positionBefore ? recoverDemoOpenTrade(positionBefore, getBotConfig()) : null);
    let telemetryRecorded = false;
    let telemetryId: string | null = null;
    let telemetryPnl: number | null = null;
    let telemetryPnlSource: "balance_delta" | "price_estimate" | null = null;
    let telemetryEstimated = false;
    let reconciliationQueued = false;

    if (entry) {
      const exitPrice =
        parseNumberField(order, ["avgPrice", "price", "executedPrice"]) ??
        await fetchDemoLastPrice(symbol);

      if (exitPrice) {
        const closeQty = Math.min(qty, entry.quantity);
        const expectedExitPrice = await fetchDemoLastPrice(symbol) ?? undefined;
        const grossPnl = estimateGrossPnl(
          entry.positionSide,
          entry.entryPrice,
          exitPrice,
          closeQty,
        );
        const exitFee = parseNumberField(order, ["commission", "fee"]) ?? 0;
        const realized = resolveDemoRealizedPnl(grossPnl, balanceBefore, balanceAfter, exitFee);
        const entrySlippage = estimateExecutionSlippage(entry.positionSide, entry.expectedEntryPrice ?? undefined, entry.entryPrice, closeQty, "entry");
        const exitSlippage = estimateExecutionSlippage(entry.positionSide, expectedExitPrice, exitPrice, closeQty, "exit");
        const totalSlippage = entrySlippage + exitSlippage;
        const notional = entry.entryPrice * closeQty;
        const outcome = recordTradeOutcome({
          isDemo: true,
          source: "bingx-vst",
          entryOrderId: entry.orderId,
          exitOrderId: orderId,
          symbol,
          positionSide: entry.positionSide,
          side: entry.side,
          entryTime: entry.entryTime,
          exitTime: Date.now(),
          hourUtc: entry.hourUtc,
          btcRegime: entry.btcRegime,
          entryPrice: entry.entryPrice,
          exitPrice,
          qty: closeQty,
          leverage: entry.leverage,
          marginUsed: entry.marginUsed,
          grossPnl,
          fee: realized.fee,
          realizedPnl: realized.realizedPnl,
          pnlSource: realized.source,
          estimated: realized.source === "price_estimate",
          expectedEntryPrice: entry.expectedEntryPrice ?? undefined,
          expectedExitPrice,
          entrySlippage,
          exitSlippage,
          totalSlippage,
          slippagePctNotional: notional > 0 ? totalSlippage / notional : 0,
          exitReason: "MANUAL",
          expectedTpProfit: entry.expectedTpProfit,
        });

        telemetryRecorded = true;
        telemetryId = outcome.id;
        telemetryPnl = outcome.realizedPnl;
        telemetryPnlSource = realized.source;
        telemetryEstimated = realized.source === "price_estimate";
        reconciliationQueued = telemetryEstimated && balanceBefore !== null;
        if (realized.source === "price_estimate") {
          req.log.warn(
            { symbol, positionSide, orderId, grossPnl, exitFee, balanceBefore, balanceAfter, outcomeId: outcome.id },
            "demo manual close recorded telemetry from price estimate because settled balance delta was unavailable",
          );
        }
        void syncQuantBrainOutcome(outcome).then((result) => {
          if (!result.synced && result.error !== "missing QUANT_BRAIN_URL") {
            req.log.warn({ error: result.error, outcomeId: outcome.id }, "quant brain sync skipped");
          }
        });
        enqueueDemoPnlReconciliation(req, creds, outcome, balanceBefore, grossPnl);

        if (closeQty >= entry.quantity) {
          const { [key]: _closed, ...remaining } = req.session.demoOpenTrades ?? {};
          req.session.demoOpenTrades = remaining;
        } else {
          req.session.demoOpenTrades = {
            ...(req.session.demoOpenTrades ?? {}),
            [key]: {
              ...entry,
              quantity: entry.quantity - closeQty,
              marginUsed: entry.marginUsed * ((entry.quantity - closeQty) / entry.quantity),
            },
          };
        }
      }
    }

    res.json({
      placed: true,
      orderId,
      symbol,
      side: closeSide,
      quantity: qty,
      gateRejects: [],
      observationMode: false,
      telemetryRecorded,
      telemetryId,
      realizedPnl: telemetryPnl,
      telemetryPnlSource,
      telemetryEstimated,
      reconciliationQueued,
      balanceBefore,
      balanceAfter,
      balanceDelta: balanceBefore !== null && balanceAfter !== null ? balanceAfter - balanceBefore : null,
      message: `Demo close placed: ${closeSide} ${quantity} ${symbol}`,
    });
  } catch (err) {
    req.log.error({ err }, "demo close error");
    res.status(500).json({ error: "Demo close failed" });
  }
});

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  DEMO SNIPER AUTOPILOT — score-tiered multi-asset placement                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

const DEMO_SNIPER_GLOBAL_MAX = parseInt(process.env["DEMO_SNIPER_GLOBAL_MAX"] ?? "50", 10);
const DEMO_SNIPER_PER_SYMBOL_MAX = parseInt(process.env["DEMO_SNIPER_PER_SYMBOL_MAX"] ?? "10", 10);
const DEMO_SNIPER_CYCLE_MS = parseInt(process.env["DEMO_SNIPER_CYCLE_MS"] ?? "30000", 10);
const DEMO_SNIPER_MONITOR_MS = parseInt(process.env["DEMO_SNIPER_MONITOR_MS"] ?? "12000", 10);
const DEMO_STACKING_COOLDOWN_MS = parseInt(process.env["DEMO_STACKING_COOLDOWN_MS"] ?? "60000", 10);
const DEMO_STACKING_MAX_CAMPAIGN_DRAWDOWN_PCT = parseFloat(
  process.env["DEMO_STACKING_MAX_CAMPAIGN_DRAWDOWN_PCT"] ?? "5",
);
const STALE_DATA_THRESHOLD_MS = parseInt(process.env["STALE_DATA_SHADOW_MS"] ?? "90000", 10);

interface DemoSniperPlacement {
  symbol: string;
  positionSide: string;
  score: number;
  tier: number;
}

interface DemoSniperCycleSummary {
  cycle: number;
  startedAt: number;
  durationMs: number;
  btcRegime: string;
  openTotal: number;
  scanned: number;
  placed: number;
  skipped: number;
  placements: DemoSniperPlacement[];
  aggressionState?: string;
  aggressionReason?: string;
}

interface DemoSniperState {
  running: boolean;
  startedAt: number | null;
  creds: { apiKey: string; secretKey: string } | null;
  placeHandle: NodeJS.Timeout | null;
  monitorHandle: NodeJS.Timeout | null;
  cycleCount: number;
  totalPlaced: number;
  stopReason: string | null;
  lastCycleAt: number | null;
  lastCycleSummary: DemoSniperCycleSummary | null;
  cycleHistory: DemoSniperCycleSummary[];
}

// Module-level open trade registry (survives session loss, keyed by orderId)
const sniperOpenTrades = new Map<string, DemoOpenTrade>();
const sniperRecordedIds = new Set<string>();

const demoSniper: DemoSniperState = {
  running: false,
  startedAt: null,
  creds: null,
  placeHandle: null,
  monitorHandle: null,
  cycleCount: 0,
  totalPlaced: 0,
  stopReason: null,
  lastCycleAt: null,
  lastCycleSummary: null,
  cycleHistory: [],
};
let demoPlacementInFlight = false;
let demoMonitorInFlight = false;
let demoSkippedPlacementOverlaps = 0;
let demoSkippedMonitorOverlaps = 0;

// ── Trigger/Gatilho cycle ────────────────────────────────────────────────────
const TRIGGER_CYCLE_MS = parseInt(process.env["TRIGGER_CYCLE_MS"] ?? "15000", 10);
let triggerCycleHandle: NodeJS.Timeout | null = null;
let triggerCycleFiring = false;
let triggerExecutionCreds: { apiKey: string; secretKey: string } | null = null;
let triggerLastCycleAt: number | null = null;
let triggerLastSkipReason: string | null = null;

function rememberTriggerCredentials(creds: { apiKey: string; secretKey: string }): void {
  triggerExecutionCreds = { apiKey: creds.apiKey, secretKey: creds.secretKey };
  triggerLastSkipReason = null;
}

function startTriggerCycleLoop(): void {
  if (triggerCycleHandle) return;
  triggerCycleHandle = setInterval(() => {
    if (triggerCycleFiring) return;
    triggerCycleFiring = true;
    runTriggerCycle().finally(() => { triggerCycleFiring = false; });
  }, TRIGGER_CYCLE_MS);
  triggerCycleHandle.unref?.();
}

function activateAutonomousTrigger(log?: Request["log"]): void {
  const sniperConfig = getBotConfig();
  setTriggerConfig({
    enabled: true,
    symbols: [],
    autoResetAfterFireMs: 10 * 60 * 1000,
  });
  void (async () => {
    for (const sym of sniperConfig.allowedSymbols) {
      try {
        const price = await fetchDemoLastPrice(sym);
        if (price && price > 0) snapshotReferencePrice(sym, price);
      } catch { /* trigger cycle retries on the next iteration */ }
    }
    log?.info(
      { symbols: sniperConfig.allowedSymbols },
      "[trigger] autonomous engine activated with SCALP_SYMBOLS",
    );
  })();
}

async function runDemoSniperCycleLocked(): Promise<void> {
  if (demoPlacementInFlight) {
    demoSkippedPlacementOverlaps++;
    return;
  }
  demoPlacementInFlight = true;
  try {
    await runDemoSniperCycle();
  } finally {
    demoPlacementInFlight = false;
  }
}

async function runDemoSniperMonitorLocked(): Promise<void> {
  if (demoMonitorInFlight) {
    demoSkippedMonitorOverlaps++;
    return;
  }
  demoMonitorInFlight = true;
  try {
    await runDemoSniperMonitor();
  } finally {
    demoMonitorInFlight = false;
  }
}

// ── Trigger/Gatilho cycle ────────────────────────────────────────────────────

async function runTriggerCycle(): Promise<void> {
  triggerLastCycleAt = Date.now();
  if (!isTriggerEnabled()) {
    triggerLastSkipReason = "TRIGGER_DISABLED";
    return;
  }
  const creds = demoSniper.creds ?? triggerExecutionCreds;
  if (!creds) {
    triggerLastSkipReason = "MISSING_DEMO_CREDENTIALS";
    return;
  }
  triggerLastSkipReason = null;

  const { apiKey, secretKey } = creds;
  const botConfig = getBotConfig();
  const triggerConfig = getTriggerConfig();
  const targetSymbols = triggerConfig.symbols.length > 0
    ? triggerConfig.symbols
    : botConfig.allowedSymbols;
  if (targetSymbols.length === 0) return;

  // 1. Update prices from VST ticker (rate-limited, fire in parallel with throttle)
  await Promise.allSettled(
    targetSymbols.map(async (sym) => {
      const price = await fetchDemoLastPrice(sym).catch(() => null);
      if (price && price > 0) updateCurrentPrice(sym, price);
    }),
  );

  // 2. Check for triggered signals
  const signals = checkAndFireTriggers();
  if (signals.length === 0) return;

  // 3. Place orders for each signal
  for (const signal of signals) {
    try {
      await executeTriggerSignal(signal, { apiKey, secretKey });
    } catch (err) {
      console.error(
        `[trigger] failed to place ${signal.direction} ${signal.symbol}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function executeTriggerSignal(
  signal: TriggerSignal,
  creds: { apiKey: string; secretKey: string },
): Promise<void> {
  const { symbol, direction, referencePrice, entryPrice: currentPrice, tpPct, slPct, triggerDropRisePct } = signal;
  const side: "BUY" | "SELL" = direction === "LONG" ? "BUY" : "SELL";
  const positionSide = direction;
  const hourUtc = new Date().getUTCHours();

  if (!currentPrice || currentPrice <= 0) return;

  // ── Gate 1: service state ─────────────────────────────────────────────────
  const svcState = getServiceState();
  if (svcState.state === "PAUSED") {
    console.info(`[trigger] skipping ${direction} ${symbol} — service PAUSED`);
    return;
  }

  const botConfig = getBotConfig();
  const engine = getEngine();

  // ── Gate 2: global position cap ───────────────────────────────────────────
  const openTrades = getOpenTrades();
  const globalOpen = openTrades.length;
  if (globalOpen >= DEMO_SNIPER_GLOBAL_MAX) {
    console.info(`[trigger] skipping ${direction} ${symbol} — global cap reached (${globalOpen})`);
    return;
  }

  // ── Gate 3: hedging guard ─────────────────────────────────────────────────
  if (botConfig.preventHedgedPositions) {
    const oppSide = direction === "LONG" ? "SHORT" : "LONG";
    const hasOpp = openTrades.some(
      (t) => t.symbol === symbol && t.positionSide === oppSide,
    );
    if (hasOpp) {
      console.info(`[trigger] skipping ${direction} ${symbol} — opposite position open`);
      return;
    }
  }

  // ── Gate 4: toxic symbol check ────────────────────────────────────────────
  const symProfile = engine.symbolProfile(symbol);
  if (symProfile?.isToxic) {
    console.info(`[trigger] skipping ${direction} ${symbol} — symbol is toxic`);
    return;
  }

  // ── Compute edge score from deviation magnitude + candle confirmation ─────
  // Deviation beyond the threshold is the primary signal. Bigger deviation = higher conviction.
  // Map: deviation at threshold = 0.65, deviation at 2× threshold = 0.85, 3× = 0.95
  const threshold = direction === "LONG" ? getTriggerConfig().longDropPct : getTriggerConfig().shortRisePct;
  const deviationRatio = threshold > 0 ? Math.min(triggerDropRisePct / threshold, 3.0) : 1.0;
  const deviationScore = 0.60 + (deviationRatio - 1.0) * 0.175; // 0.60 at 1×, 0.775 at 2×, 0.95 at 3×
  const clampedDeviationScore = Math.min(0.95, Math.max(0.60, deviationScore));

  // Blend with candle edge if available (non-blocking — fallback gracefully)
  let candleScore = clampedDeviationScore;
  try {
    const edge = await computeCandleEdge(symbol, "5m");
    const rawCandleScore = direction === "LONG" ? edge.longScore : edge.shortScore;
    // Weight: 60% deviation conviction, 40% candle confirmation
    candleScore = Math.min(0.98, clampedDeviationScore * 0.60 + rawCandleScore * 0.40);
  } catch { /* use deviation score alone */ }

  const clusterKey: ClusterKey = { symbol, positionSide, hourUtc, btcRegime: "NEUTRAL" };
  const clusterProfile = engine.clusterProfile(clusterKey);
  const ev = clusterProfile?.ev ?? symProfile?.ev ?? 0;
  const combinedScore = engine.combinedEdgeScore(clusterKey, ev, candleScore);

  // Minimum combined score gate (must clear 0.60 tier to be worth firing)
  if (combinedScore < 0.60) {
    console.info(`[trigger] skipping ${direction} ${symbol} — combined score too low (${combinedScore.toFixed(3)})`);
    return;
  }

  // ── Gate 5: QuantBrain advisory ───────────────────────────────────────────
  const entryNow = Date.now();
  const activeCampaignId = getActiveCampaignId(symbol, positionSide, entryNow);
  const campaignId = activeCampaignId ?? randomUUID();
  const openCampaignEntries = activeCampaignId
    ? getOpenTradesBySymbolSide(symbol, positionSide).filter((e) => e.campaignId === activeCampaignId)
    : [];
  const campaignSignalId = openCampaignEntries[0]?.signalId ?? `trigger-campaign:${campaignId}`;

  const quantEdge = await evaluateQuantBrainEdge({
    symbol,
    side,
    positionSide,
    hourUtc,
    btcChangePct: 0,
    currentEv: ev,
    currentWinRate: clusterProfile?.winRate ?? symProfile?.winRate ?? 0,
    currentProfitFactor: clusterProfile?.profitFactor ?? symProfile?.profitFactor ?? 0,
    config: botConfig,
    signalId: campaignSignalId,
    marketEventId: undefined,
    featureVersion: "trigger-deviation-v1",
    observationSourceType: "vst_campaign",
  });

  if (quantEdge.driftPolicy?.newEntriesAllowed === false) {
    console.info(`[trigger] skipping ${direction} ${symbol} — QB drift policy blocks new entries`);
    return;
  }

  const calibratedProbability = quantEdge.calibratedProbability ?? null;
  const uncertaintyType = quantEdge.uncertaintyType ?? (quantEdge.error ? "MODEL_UNAVAILABLE" : null);

  // ── Gate 6: stacking policy ───────────────────────────────────────────────
  const campaignMargin = openCampaignEntries.reduce((s, e) => s + e.marginUsed, 0);
  const campaignAdverseExcursion = Math.abs(openCampaignEntries.reduce((s, e) => s + Math.min(0, e.mae), 0));
  const campaignDrawdownPct = campaignMargin > 0 ? (campaignAdverseExcursion / campaignMargin) * 100 : 0;
  const stateFingerprint = `trigger:${symbol}:${positionSide}:${Math.round(triggerDropRisePct * 100)}`;

  const stackingGate = evaluateStackingInsertion({
    openEntries: openCampaignEntries,
    proposedSide: positionSide,
    edgeScore: combinedScore,
    calibratedProbability,
    uncertaintyType,
    marketEventId: null,
    stateFingerprint,
    now: entryNow,
    cooldownMs: DEMO_STACKING_COOLDOWN_MS,
    campaignCap: campaignControlCap(campaignId),
    proposedMargin: botConfig.marginPerTrade,
    campaignDrawdownPct,
    maxCampaignDrawdownPct: DEMO_STACKING_MAX_CAMPAIGN_DRAWDOWN_PCT,
    portfolioCapacityAvailable: globalOpen < DEMO_SNIPER_GLOBAL_MAX,
  });

  if (!stackingGate.allow) {
    console.info(`[trigger] stacking rejected ${direction} ${symbol} — ${JSON.stringify(stackingGate.rejects)}`);
    return;
  }

  // ── Execute order ─────────────────────────────────────────────────────────
  const qty = Math.floor(((botConfig.marginPerTrade * botConfig.leverage) / currentPrice) * 1000) / 1000;
  if (!qty || qty <= 0) return;

  const customConfig = { ...botConfig, takeProfitPct: tpPct, stopLossPct: slPct };
  const protection = buildAttachedProtection(currentPrice, positionSide, customConfig);

  const clientOrderId = createClientOrderId(
    `trigger:${symbol}:${positionSide}`,
    `${Math.round(triggerDropRisePct * 100)}:${entryNow}`,
  );

  const order = await placeVstOrderIdempotently({
    creds,
    clientOrderId,
    campaignId,
    symbol,
    side,
    positionSide,
    quantity: qty,
    params: {
      symbol,
      side,
      positionSide,
      type: botConfig.orderType,
      quantity: qty,
      leverage: botConfig.leverage,
      stopLoss: protection?.stopLoss,
      takeProfit: protection?.takeProfit,
    },
  });

  const orderId = String(order.orderId);
  const entryPrice = parseFloat(String(order.avgPrice ?? "")) || currentPrice;
  const btcRegime: BtcRegime = "NEUTRAL";

  sniperOpenTrades.set(orderId, {
    orderId,
    symbol,
    side,
    positionSide,
    quantity: qty,
    entryPrice,
    expectedEntryPrice: currentPrice,
    entryTime: entryNow,
    hourUtc,
    btcRegime,
    leverage: botConfig.leverage,
    marginUsed: botConfig.marginPerTrade,
    expectedTpProfit: botConfig.marginPerTrade * botConfig.leverage * (tpPct / 100),
  });

  await persistOpenTrade({
    campaignId,
    signalId: campaignSignalId,
    orderId,
    clientOrderId,
    symbol,
    side,
    positionSide,
    entryTime: entryNow,
    entryPrice,
    expectedEntryPrice: currentPrice,
    qty,
    leverage: botConfig.leverage,
    marginUsed: botConfig.marginPerTrade,
    notional: entryPrice * qty,
    tpPct,
    slPct,
    btcRegime,
    hourUtc,
    edgeScore: combinedScore,
    stackingDepth: stackingGate.depth,
    controlMaxEntries: campaignControlCap(campaignId),
    edgeAtInsertion: combinedScore,
    calibratedProbability,
    uncertaintyType,
    marketEventId: null,
    predictionId: quantEdge.predictionId ?? null,
    featureVersion: quantEdge.featureVersion ?? "trigger-deviation-v1",
    stateFingerprint,
    correlationAdjustedExposure: entryPrice * qty,
    modelVersion: quantEdge.modelVersion ?? "trigger-v1",
    fallbackMode: !quantEdge.available,
    mfe: 0,
    mae: 0,
    mfeAt: null,
    maeAt: null,
    lastMarkPrice: null,
    lastCheckedAt: null,
    closedAt: null,
  });

  console.info(
    `[trigger] FIRED ${direction} ${symbol}` +
    ` @ ${currentPrice.toFixed(4)} ref=${referencePrice.toFixed(4)}` +
    ` dev=${triggerDropRisePct.toFixed(2)}% score=${combinedScore.toFixed(3)}` +
    ` tp=${tpPct.toFixed(2)}% sl=${slPct.toFixed(2)}% qty=${qty} orderId=${orderId}`,
  );
}

/**
 * Base tier from signal score, then reduced proportionally when in a losing streak.
 *
 * Loss streak multipliers (applied after DEGRADED threshold is reached):
 *   0–3 consecutive losses:   full tier (multiplier 1.0)
 *   4–7 consecutive losses:   × 0.75 — mild caution
 *   8–11 consecutive losses:  × 0.50 — DEGRADED-range, halve stacking
 *   12–14 consecutive losses: × 0.25 — approaching PAUSE, minimal new exposure
 *   ≥15 consecutive losses:   tier is irrelevant — PAUSED blocks entries upstream
 *
 * Always returns ≥1 when the base tier is ≥1 so a high-confidence signal
 * can still fire once even during a drawdown phase.
 */
function scoreTierMaxEntries(score: number): number {
  let base: number;
  if (score < 0.60) return 0;
  else if (score < 0.70) base = 1;
  else if (score < 0.80) base = 3;
  else if (score < 0.90) base = 5;
  else base = 10;

  const streak = getConsecutiveLosses();
  let mult = 1.0;
  if (streak >= 12) mult = 0.25;
  else if (streak >= 8) mult = 0.50;
  else if (streak >= 4) mult = 0.75;

  return mult < 1.0 ? Math.max(1, Math.floor(base * mult)) : base;
}

async function runDemoSniperCycle(): Promise<void> {
  if (!demoSniper.running || !demoSniper.creds) return;

  // ── Service state gate ───────────────────────────────────────────────────
  // PAUSED: no new entries; monitoring continues via the separate monitor interval.
  // SHADOW_ONLY: cycle continues; isEntryAllowed() enforces per-campaign cap below.
  const svcState = getServiceState();
  if (svcState.state === "PAUSED") {
    console.info(`[demo-sniper] skipping placement cycle — PAUSED (${svcState.reason ?? "n/a"})`);
    return;
  }

  const config = getBotConfig();
  const engine = getEngine();
  const { apiKey, secretKey } = demoSniper.creds;
  const t0 = Date.now();
  demoSniper.cycleCount++;
  const cycleNum = demoSniper.cycleCount;

  // 1. Fetch BTC regime + open positions in parallel
  let btcChangePct = 0;
  let currentPositions: Array<{ symbol: string; positionSide: string; positionAmt: string }> = [];

  try {
    const [btcRes, posData] = await Promise.all([
      fetch(
        `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=BTC-USDT&timestamp=${Date.now()}`,
        { signal: AbortSignal.timeout(4000) },
      ).then((r) => r.json() as Promise<Record<string, unknown>>).catch(() => null),
      bingxGet("/openApi/swap/v2/user/positions", {}, apiKey, secretKey).catch(() => null),
    ]);
    if (btcRes && String(btcRes.code) === "0") {
      const d = (btcRes.data as Record<string, string>) ?? {};
      btcChangePct = parseFloat(d.priceChangePercent ?? "0") || 0;
      recordBtcPriceUpdate();
      recordApiSuccess();
    } else {
      recordApiError();
    }
    if (posData && isBingXSuccess(posData)) {
      currentPositions = (getRawPositions(posData) as Array<Record<string, unknown>>)
        .filter((p) => parseFloat(String(p.positionAmt ?? "0")) !== 0)
        .map((p) => ({
          symbol: String(p.symbol ?? ""),
          positionSide: String(p.positionSide ?? ""),
          positionAmt: String(p.positionAmt ?? "0"),
        }));
    }
  } catch { /* continue */ }

  const btcRegime = inferBtcRegime(btcChangePct, config.btcRegimeThresholdPct);
  const hourUtc = new Date().getUTCHours();
  // BingX can consolidate repeated fills into one symbol-side position.
  const globalOpen = Math.max(currentPositions.length, getOpenTrades().length);

  // ── VST equity for equity-relative circuit breakers ─────────────────────
  void fetchDemoBalance(apiKey, secretKey).then((bal) => {
    const eq = numericBalance(bal);
    if (eq !== null && eq > 0) updateVstEquity(eq);
  }).catch(() => {});

  // ── Archive closed JSONL if it has grown too large ───────────────────────
  void archiveClosedIfNeeded().catch(() => {});

  // ── Stale data gate — block entries when BTC price is too old ────────────
  const freshness = checkDataFreshness();
  if (!freshness.fresh) {
    const ageDesc = freshness.ageMs !== null ? `${freshness.ageMs}ms` : "never fetched";
    console.warn(`[demo-sniper] skipping entries — BTC price data stale (age: ${ageDesc}, threshold: ${STALE_DATA_THRESHOLD_MS}ms)`);
    demoSniper.lastCycleAt = Date.now();
    return;
  }

  if (globalOpen >= DEMO_SNIPER_GLOBAL_MAX) {
    demoSniper.lastCycleAt = Date.now();
    demoSniper.cycleHistory.push({
      cycle: cycleNum, startedAt: t0, durationMs: Date.now() - t0,
      btcRegime, openTotal: globalOpen, scanned: 0, placed: 0, skipped: 0, placements: [],
    });
    if (demoSniper.cycleHistory.length > 50) demoSniper.cycleHistory.shift();
    return;
  }

  // 2. Build per-(symbol, positionSide) open count from exchange
  const openCounts = new Map<string, number>();
  for (const p of currentPositions) {
    const k = `${p.symbol.toUpperCase()}:${p.positionSide.toUpperCase()}`;
    openCounts.set(k, (openCounts.get(k) ?? 0) + 1);
  }

  const symbols = config.allowedSymbols;
  if (symbols.length === 0) {
    demoSniper.lastCycleAt = Date.now();
    return;
  }

  // 3. Compute candle edges for all symbols
  const candleEdges = await computeAllCandleEdges(symbols, "5m").catch(() =>
    symbols.map((sym) => ({ symbol: sym, longScore: 0, shortScore: 0, emaCross: null, volumeRatio: 1 })),
  );

  // 4. Score all (symbol, side) pairs and build candidates
  interface ScoredCandidate {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    side: "BUY" | "SELL";
    score: number;
    tier: number;
    currentOpen: number;
    marketEventId?: string;
    stateFingerprint: string;
    currentEv: number;
    currentWinRate: number;
    currentProfitFactor: number;
  }

  const candidates: ScoredCandidate[] = [];
  const aggressionCandidates: AggressionCandidate[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const candle = candleEdges[i] as { longScore?: number; shortScore?: number; volumeRatio?: number } | undefined;
    if (!candle) continue;

    for (const ps of ["LONG", "SHORT"] as const) {
      // Single-side enforcement
      const oppKey = `${sym}:${ps === "LONG" ? "SHORT" : "LONG"}`;
      if (config.preventHedgedPositions && (openCounts.get(oppKey) ?? 0) > 0) continue;

      const clusterKey: ClusterKey = { symbol: sym, positionSide: ps, hourUtc, btcRegime };
      const symProfile = engine.symbolProfile(sym);
      if (symProfile?.isToxic) continue;

      const clusterProfile = engine.clusterProfile(clusterKey);
      const ev = clusterProfile?.ev ?? symProfile?.ev ?? 0;
      const candleScore = ps === "LONG" ? (candle.longScore ?? 0) : (candle.shortScore ?? 0);
      const combinedScore = engine.combinedEdgeScore(clusterKey, ev, candleScore);
      aggressionCandidates.push({
        symbol: sym,
        positionSide: ps,
        score: combinedScore,
        candleScore,
        volumeRatio: candle.volumeRatio,
      });

      const tier = scoreTierMaxEntries(combinedScore);
      if (tier === 0) continue;

      const posKey = `${sym}:${ps}`;
      const currentOpen = openCounts.get(posKey) ?? 0;
      if (currentOpen >= Math.min(tier, DEMO_SNIPER_PER_SYMBOL_MAX)) continue;

      const edge = candleEdges[i] as { marketEventId?: string } | undefined;
      candidates.push({
        symbol: sym,
        positionSide: ps,
        side: ps === "LONG" ? "BUY" : "SELL",
        score: combinedScore,
        tier,
        currentOpen,
        marketEventId: edge?.marketEventId,
        stateFingerprint: [
          edge?.marketEventId ?? "no-event",
          btcRegime,
          ps,
          combinedScore.toFixed(4),
        ].join(":"),
        currentEv: ev,
        currentWinRate: clusterProfile?.winRate ?? symProfile?.winRate ?? 0,
        currentProfitFactor: clusterProfile?.profitFactor ?? symProfile?.profitFactor ?? 0,
      });
    }
  }

  const aggression = evaluateAggression({
    config,
    outcomes: exportAllOutcomes().filter(isDemoOutcome),
    serviceState: getServiceState(),
    candidates: aggressionCandidates,
    btcRegime,
    btcChangePct,
    openPositionsCount: globalOpen,
    maxOpenPositions: DEMO_SNIPER_GLOBAL_MAX,
    dataFresh: freshness.fresh,
    apiHealthy: getServiceState().apiErrors < 5,
    executionHealthy: true,
    source: "demo",
  });
  if (aggression.aggressionState === "PAUSED") {
    demoSniper.lastCycleAt = Date.now();
    demoSniper.lastCycleSummary = {
      cycle: cycleNum,
      startedAt: t0,
      durationMs: Date.now() - t0,
      btcRegime,
      openTotal: globalOpen,
      scanned: candidates.length,
      placed: 0,
      skipped: candidates.length,
      placements: [],
      aggressionState: aggression.aggressionState,
      aggressionReason: aggression.reason,
    };
    demoSniper.cycleHistory.push(demoSniper.lastCycleSummary);
    if (demoSniper.cycleHistory.length > 50) demoSniper.cycleHistory.shift();
    return;
  }
  const aggressiveConfig = applyAggressionToConfig(config, aggression);

  // 5. Sort by score descending, allocate entries respecting caps
  candidates.sort((a, b) => b.score - a.score);

  const placements: DemoSniperPlacement[] = [];
  let placed = 0;
  let skipped = 0;
  let globalHeadroom = Math.min(DEMO_SNIPER_GLOBAL_MAX - globalOpen, aggression.maxPositionsThisCycle);
  // Per-cycle dedup: skip any candidate whose candle event was already processed
  // this cycle (prevents double-firing on the same closed candle).
  const cycleProcessedEventIds = new Set<string>();

  for (const c of candidates) {
    if (globalHeadroom <= 0) break;
    if (placed >= aggression.maxCandidatesThisCycle) break;
    if (c.score < aggression.minAggressiveScore) { skipped++; continue; }

    const posKey = `${c.symbol}:${c.positionSide}`;
    const entriesToAdd = Math.min(
      c.tier - c.currentOpen,
      Math.min(DEMO_SNIPER_PER_SYMBOL_MAX, aggression.symbolConcentrationLimit) - c.currentOpen,
      globalHeadroom,
    );

    // One insertion at most per symbol-side and market state in a cycle.
    for (let n = 0; n < Math.min(entriesToAdd, 1); n++) {
      if (globalHeadroom <= 0) break;

      // ── Per-entry entry-allowed check ──────────────────────────────────────
      // Dedup: skip if this candle event was already processed this cycle.
      if (c.marketEventId && cycleProcessedEventIds.has(`${c.symbol}:${c.positionSide}:${c.marketEventId}`)) {
        skipped++;
        break;
      }
      // SHADOW_ONLY: only first entry per campaign allowed.
      // Resolve campaign BEFORE fetching price (no network call yet).
      const entryNow = Date.now();
      const activeCampaignId = getActiveCampaignId(c.symbol, c.positionSide, entryNow);
      const campaignId = activeCampaignId ?? randomUUID();
      const openCampaignEntries = activeCampaignId
        ? getOpenTradesBySymbolSide(c.symbol, c.positionSide)
            .filter((entry) => entry.campaignId === activeCampaignId)
        : [];
      const campaignAlreadyHasEntry = openCampaignEntries.length > 0 || c.currentOpen > 0;
      if (!isEntryAllowed(campaignAlreadyHasEntry)) { skipped++; break; }
      if (!aggression.stackingAllowed && campaignAlreadyHasEntry) { skipped++; break; }

      const fallback = isFallbackMode();
      const campaignSignalId = openCampaignEntries[0]?.signalId ?? `vst-campaign:${campaignId}`;
      const quantEdge = await evaluateQuantBrainEdge({
        symbol: c.symbol,
        side: c.side,
        positionSide: c.positionSide,
        hourUtc,
        btcChangePct,
        currentEv: c.currentEv,
        currentWinRate: c.currentWinRate,
        currentProfitFactor: c.currentProfitFactor,
        config,
        signalId: campaignSignalId,
        marketEventId: c.marketEventId,
        featureVersion: "candle-edge-v1",
        observationSourceType: "vst_campaign",
      });
      const calibratedProbability = quantEdge.calibratedProbability ?? null;
      const uncertaintyType = quantEdge.uncertaintyType
        ?? (quantEdge.error ? "MODEL_UNAVAILABLE" : null);
      if (quantEdge.driftPolicy?.newEntriesAllowed === false) {
        skipped++;
        break;
      }

      const campaignMargin = openCampaignEntries.reduce((sum, entry) => sum + entry.marginUsed, 0);
      const campaignAdverseExcursion = Math.abs(
        openCampaignEntries.reduce((sum, entry) => sum + Math.min(0, entry.mae), 0),
      );
      const campaignDrawdownPct = campaignMargin > 0
        ? (campaignAdverseExcursion / campaignMargin) * 100
        : 0;
      const baseControlMaxEntries = campaignControlCap(campaignId);
      const driftStackingMultiplier = quantEdge.driftPolicy?.stackingMultiplier ?? 1;
      const adjustedControlCap = baseControlMaxEntries * driftStackingMultiplier;
      const controlMaxEntries =
        adjustedControlCap >= 10 ? 10
        : adjustedControlCap >= 5 ? 5
        : adjustedControlCap >= 3 ? 3
        : 1;
      const stackingGate = evaluateStackingInsertion({
        openEntries: openCampaignEntries,
        proposedSide: c.positionSide,
        edgeScore: c.score,
        calibratedProbability,
        uncertaintyType,
        marketEventId: c.marketEventId ?? null,
        stateFingerprint: c.stateFingerprint,
        now: entryNow,
        cooldownMs: Math.round(DEMO_STACKING_COOLDOWN_MS * aggression.cooldownMultiplier),
        campaignCap: controlMaxEntries,
        proposedMargin: aggressiveConfig.marginPerTrade,
        campaignDrawdownPct,
        maxCampaignDrawdownPct: DEMO_STACKING_MAX_CAMPAIGN_DRAWDOWN_PCT,
        portfolioCapacityAvailable:
          globalHeadroom > 0 && globalOpen + placed < DEMO_SNIPER_GLOBAL_MAX,
      });
      if (!stackingGate.allow) {
        console.info({
          symbol: c.symbol,
          positionSide: c.positionSide,
          campaignId,
          depth: stackingGate.depth,
          rejects: stackingGate.rejects,
        }, "[demo-sniper] stacking rejected");
        skipped++;
        break;
      }

      const price = await fetchDemoLastPrice(c.symbol).catch(() => null);
      if (!price || price <= 0) { skipped++; break; }

      const qty = Math.floor(((aggressiveConfig.marginPerTrade * aggressiveConfig.leverage) / price) * 1000) / 1000;
      if (!qty || qty <= 0) { skipped++; break; }

      const protection = buildAttachedProtection(price, c.positionSide, aggressiveConfig);
      const clientOrderId = createClientOrderId(
        `sniper:${c.symbol}:${c.positionSide}`,
        `${c.marketEventId ?? c.stateFingerprint}:${stackingGate.depth}`,
      );
      const notional = price * qty;
      const correlationSum = currentPositions.reduce(
        (sum, position) => sum + Math.max(0, getCorrelation(c.symbol, position.symbol)),
        0,
      );
      const correlationAdjustedExposure = notional * Math.sqrt(1 + 2 * correlationSum);

      try {
        const order = await placeVstOrderIdempotently({
          creds: { apiKey, secretKey },
          clientOrderId,
          campaignId,
          symbol: c.symbol,
          side: c.side,
          positionSide: c.positionSide,
          quantity: qty,
          params: {
            symbol: c.symbol,
            side: c.side,
            positionSide: c.positionSide,
            type: config.orderType,
            quantity: qty,
            leverage: aggressiveConfig.leverage,
            stopLoss: protection?.stopLoss,
            takeProfit: protection?.takeProfit,
          },
        });
        const orderId = String(order.orderId);
        const entryPrice = parseFloat(String(order.avgPrice ?? "")) || price;

        const entryTime = Date.now();
        sniperOpenTrades.set(orderId, {
          orderId,
          symbol: c.symbol,
          side: c.side,
          positionSide: c.positionSide,
          quantity: qty,
          entryPrice,
          expectedEntryPrice: price,
          entryTime,
          hourUtc,
          btcRegime,
          leverage: aggressiveConfig.leverage,
          marginUsed: aggressiveConfig.marginPerTrade,
          expectedTpProfit: aggressiveConfig.marginPerTrade * aggressiveConfig.leverage * (aggressiveConfig.takeProfitPct / 100),
        });

        // Persist to durable trade store — idempotent, survives server restarts
        await persistOpenTrade({
          campaignId,
          signalId: campaignSignalId,
          orderId,
          clientOrderId,
          symbol: c.symbol,
          side: c.side,
          positionSide: c.positionSide,
          entryTime,
          entryPrice,
          expectedEntryPrice: price,
          qty,
          leverage: aggressiveConfig.leverage,
          marginUsed: aggressiveConfig.marginPerTrade,
          notional: entryPrice * qty,
          tpPct: aggressiveConfig.takeProfitPct,
          slPct: aggressiveConfig.stopLossPct,
          btcRegime,
          hourUtc,
          edgeScore: c.score,
          stackingDepth: stackingGate.depth,
          controlMaxEntries,
          edgeAtInsertion: c.score,
          calibratedProbability,
          uncertaintyType,
          marketEventId: c.marketEventId ?? null,
          predictionId: quantEdge.predictionId ?? null,
          featureVersion: quantEdge.featureVersion ?? "candle-edge-v1",
          stateFingerprint: c.stateFingerprint,
          correlationAdjustedExposure,
          modelVersion: quantEdge.modelVersion
            ?? (fallback ? "shadow-baseline" : "sniper-v1"),
          fallbackMode: fallback || !quantEdge.available,
          mfe: 0,
          mae: 0,
          mfeAt: null,
          maeAt: null,
          lastMarkPrice: null,
          lastCheckedAt: null,
          closedAt: null,
        });

        if (c.marketEventId) {
          cycleProcessedEventIds.add(`${c.symbol}:${c.positionSide}:${c.marketEventId}`);
        }
        demoSniper.totalPlaced++;
        placed++;
        globalHeadroom--;
        openCounts.set(posKey, (openCounts.get(posKey) ?? 0) + 1);
        placements.push({ symbol: c.symbol, positionSide: c.positionSide, score: c.score, tier: c.tier });
      } catch { skipped++; }
    }
  }

  const summary: DemoSniperCycleSummary = {
    cycle: cycleNum,
    startedAt: t0,
    durationMs: Date.now() - t0,
    btcRegime,
    openTotal: globalOpen + placed,
    scanned: candidates.length,
    placed,
    skipped,
    placements,
    aggressionState: aggression.aggressionState,
    aggressionReason: aggression.reason,
  };
  recordAggressionCycleImpact(placed + skipped, placed);

  demoSniper.lastCycleAt = Date.now();
  demoSniper.lastCycleSummary = summary;
  demoSniper.cycleHistory.push(summary);
  if (demoSniper.cycleHistory.length > 50) demoSniper.cycleHistory.shift();
}

async function runDemoSniperMonitor(): Promise<void> {
  // Monitoring always runs — even in PAUSED / SHADOW_ONLY state.
  // isMonitoringAllowed() always returns true; it exists to make the intent explicit.
  if (!demoSniper.creds) return;
  const { apiKey, secretKey } = demoSniper.creds;
  const config = getBotConfig();

  // ── Sync any demoTradeStore entries missing from sniperOpenTrades ─────────
  // This handles two cases:
  //   1. Server restart (sniperOpenTrades restored from JSONL on init — should already be done)
  //   2. Crash between persistOpenTrade and sniperOpenTrades.set (race recovery)
  for (const storeEntry of getOpenTrades()) {
    if (!sniperOpenTrades.has(storeEntry.orderId)) {
      sniperOpenTrades.set(storeEntry.orderId, {
        orderId: storeEntry.orderId,
        symbol: storeEntry.symbol,
        side: storeEntry.side,
        positionSide: storeEntry.positionSide,
        quantity: storeEntry.qty,
        entryPrice: storeEntry.entryPrice,
        expectedEntryPrice: storeEntry.expectedEntryPrice,
        entryTime: storeEntry.entryTime,
        hourUtc: storeEntry.hourUtc,
        btcRegime: storeEntry.btcRegime as BtcRegime,
        leverage: storeEntry.leverage,
        marginUsed: storeEntry.marginUsed,
        expectedTpProfit: storeEntry.marginUsed * storeEntry.leverage * (storeEntry.tpPct / 100),
      });
    }
  }

  if (sniperOpenTrades.size === 0) return;

  let livePositions: Array<{ symbol: string; positionSide: string }>;
  const openMarkPrices = new Map<string, number>();
  try {
    const posData = await bingxGet("/openApi/swap/v2/user/positions", {}, apiKey, secretKey);
    if (!isBingXSuccess(posData)) return;
    const rawPositions = (getRawPositions(posData) as Array<Record<string, unknown>>)
      .filter((p) => parseFloat(String(p.positionAmt ?? "0")) !== 0);
    livePositions = rawPositions.map((p) => ({
      symbol: String(p.symbol ?? ""),
      positionSide: String(p.positionSide ?? ""),
    }));
    for (const p of rawPositions) {
      const markPrice = parseFloat(String(p.markPrice ?? p.currentPrice ?? "0"));
      if (markPrice > 0) {
        openMarkPrices.set(
          `${String(p.symbol ?? "").toUpperCase()}:${String(p.positionSide ?? "").toUpperCase()}`,
          markPrice,
        );
      }
    }
  } catch { return; }

  const openSet = new Set(
    livePositions.map((p) => `${p.symbol.toUpperCase()}:${p.positionSide.toUpperCase()}`),
  );

  // Campaigns whose last entry closed in this monitor pass — build campaign ML outcome
  const campaignsToClose = new Set<string>();
  const trackedQuantityByPosition = new Map<string, number>();
  for (const entry of sniperOpenTrades.values()) {
    const positionKey = `${entry.symbol.toUpperCase()}:${entry.positionSide.toUpperCase()}`;
    trackedQuantityByPosition.set(
      positionKey,
      (trackedQuantityByPosition.get(positionKey) ?? 0) + entry.quantity,
    );
  }
  const incomeByPosition = new Map<string, Promise<{ realizedPnl: number; fee: number } | null>>();

  for (const [orderId, entry] of sniperOpenTrades.entries()) {
    if (sniperRecordedIds.has(orderId)) { sniperOpenTrades.delete(orderId); continue; }
    const key = `${entry.symbol.toUpperCase()}:${entry.positionSide.toUpperCase()}`;

    if (openSet.has(key)) {
      // Still open — update MFE/MAE in durable store
      const storeEntry = getOpenTradeByOrderId(orderId);
      if (storeEntry) {
        const markPrice = openMarkPrices.get(key);
        if (markPrice && markPrice > 0) {
          void updateOpenTradeMfe(storeEntry.tradeId, markPrice).catch(() => {});
        }
      }
      continue;
    }

    // ── Position closed on exchange ─────────────────────────────────────────
    const exitTime = Date.now();
    const estimatedExitPrice = await fetchDemoLastPrice(entry.symbol).catch(() => null);
    if (!estimatedExitPrice) continue;

    // Attempt canonical PnL from BingX income API (covers entire position hold window)
    const windowStart = entry.entryTime - 10_000; // 10s before entry
    const windowEnd = exitTime + 60_000;           // 60s after detected close
    let incomePromise = incomeByPosition.get(key);
    if (!incomePromise) {
      incomePromise = fetchBingXRealizedPnl(
        entry.symbol, windowStart, windowEnd, apiKey, secretKey,
      );
      incomeByPosition.set(key, incomePromise);
    }
    const incomeData = await incomePromise;

    let exitPrice: number;
    let grossPnl: number;
    let fee: number;
    let realizedPnl: number;
    let pnlSource: "exchange_reported" | "balance_delta" | "price_estimate";
    let estimated: boolean;

    if (incomeData && incomeData.realizedPnl !== 0) {
      // Canonical exchange-reported values
      const trackedQuantity = trackedQuantityByPosition.get(key) ?? entry.quantity;
      const allocation = trackedQuantity > 0 ? entry.quantity / trackedQuantity : 0;
      realizedPnl = incomeData.realizedPnl * allocation;
      fee = incomeData.fee * allocation;
      grossPnl = realizedPnl + fee;
      exitPrice = estimatedExitPrice; // use last price for exit price (income API doesn't give it)
      pnlSource = "exchange_reported";
      estimated = false;
    } else {
      // Fallback: price-based estimate
      exitPrice = estimatedExitPrice;
      grossPnl = estimateGrossPnl(entry.positionSide, entry.entryPrice, exitPrice, entry.quantity);
      fee = Math.max(0, Math.abs(entry.marginUsed * entry.leverage) * 0.001);
      realizedPnl = grossPnl - fee;
      pnlSource = "price_estimate";
      estimated = true;
    }

    const favorableMovePct = entry.positionSide === "LONG"
      ? ((exitPrice - entry.entryPrice) / entry.entryPrice) * 100
      : ((entry.entryPrice - exitPrice) / entry.entryPrice) * 100;

    const exitReason: TradeOutcome["exitReason"] =
      favorableMovePct >= config.takeProfitPct * 0.7 ? "TP"
      : favorableMovePct <= -(config.stopLossPct * 0.7) ? "SL"
      : "MANUAL";

    try {
      // Record per-entry outcome in adaptive engine for EWMA/cluster learning (execution analysis).
      // This is NOT sent to QB — campaign-level outcome below is the ML training sample.
      recordTradeOutcome({
        isDemo: true,
        source: "bingx-vst",
        entryOrderId: entry.orderId,
        symbol: entry.symbol,
        positionSide: entry.positionSide,
        side: entry.side,
        entryTime: entry.entryTime,
        exitTime,
        hourUtc: entry.hourUtc,
        btcRegime: entry.btcRegime,
        entryPrice: entry.entryPrice,
        exitPrice,
        qty: entry.quantity,
        leverage: entry.leverage,
        marginUsed: entry.marginUsed,
        grossPnl,
        fee,
        realizedPnl,
        pnlSource,
        estimated,
        expectedEntryPrice: entry.expectedEntryPrice ?? undefined,
        exitReason,
        expectedTpProfit: entry.expectedTpProfit,
      });

      sniperRecordedIds.add(orderId);
      sniperOpenTrades.delete(orderId);

      // Close in durable store — idempotent
      const storeEntry = getOpenTradeByOrderId(orderId);
      if (storeEntry) {
        const closed = await closeOpenTrade(storeEntry.tradeId, {
          exitTime,
          exitPrice,
          expectedExitPrice: null,
          grossPnl,
          fee,
          entrySlippage: entry.expectedEntryPrice != null
            ? Math.abs(entry.entryPrice - entry.expectedEntryPrice) : 0,
          exitSlippage: 0,
          realizedPnl,
          pnlSource,
          estimated,
          exitReason,
          exitOrderId: null,
        }).catch(() => null);

        if (closed) {
          // Track which campaigns may now be fully closed
          if (getCampaignOpenCount(storeEntry.campaignId) === 0) {
            campaignsToClose.add(storeEntry.campaignId);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── Campaign-level ML outcomes ─────────────────────────────────────────────
  // For each fully-closed campaign: aggregate all entries → ONE ML sample → QB.
  // This prevents N correlated stacked entries from becoming N independent training labels.
  for (const campaignId of campaignsToClose) {
    try {
      const closedTrades = getClosedTradesForCampaign(campaignId);
      const co = buildCampaignOutcome(closedTrades);
      if (!co) continue;
      assertCampaignAccounting({
        campaignId,
        executionPnl: closedTrades.map((trade) => trade.realizedPnl),
        campaignPnl: co.realizedPnl,
        finalOutcomeCount: 1,
      });

      const dominantReason = (
        Object.entries(co.exitReasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "MANUAL"
      ) as "TP" | "SL" | "MANUAL";

      const mlOutcome: TradeOutcome = {
        id: `campaign:${campaignId}`,          // stable dedup key across restarts
        isDemo: true,
        source: "bingx-vst",
        symbol: co.symbol,
        positionSide: co.positionSide,
        side: co.side,
        entryTime: co.openedAt,
        exitTime: co.closedAt,
        hourUtc: co.hourUtc,
        btcRegime: co.btcRegime as BtcRegime,
        entryPrice: co.avgEntryPrice,
        exitPrice: co.avgExitPrice,
        qty: co.totalQty,
        leverage: closedTrades[0]?.leverage ?? 1,
        marginUsed: co.totalMarginUsed,
        grossPnl: co.grossPnl,
        fee: co.totalFee,
        realizedPnl: co.realizedPnl,
        pnlSource: co.pnlSource,
        estimated: co.estimated,
        exitReason: dominantReason,
        expectedTpProfit: 0,
        // Audit trail — aggregate campaign metrics
        mfe: co.mfe,
        mae: co.mae,
        holdDurationMs: co.holdDurationMs,
        entryCount: co.entryCount,
        modelVersion: co.modelVersion ?? undefined,
        signalId: co.signalId,
        marketEventId: co.marketEventId ?? undefined,
        predictionId: co.predictionId ?? undefined,
        campaignId: co.campaignId,
        clientOrderId: co.clientOrderId,
        exchangeOrderId: co.exchangeOrderId,
        featureVersion: co.featureVersion ?? undefined,
        labelVersion: "campaign-pnl-v1",
        sourceType: "demo",
      };

      // Single QB sync per campaign — the ML training boundary
      void syncQuantBrainOutcome(mlOutcome).catch(() => {});

      // Circuit breaker at campaign level
      if (co.realizedPnl > 0) recordTradeWin();
      else recordTradeLoss(co.realizedPnl);
    } catch { /* non-fatal */ }
  }
}

function stopDemoSniper(reason: string): void {
  if (demoSniper.placeHandle) { clearInterval(demoSniper.placeHandle); demoSniper.placeHandle = null; }
  if (demoSniper.monitorHandle) { clearInterval(demoSniper.monitorHandle); demoSniper.monitorHandle = null; }
  demoSniper.running = false;
  demoSniper.creds = null;
  demoSniper.stopReason = reason;
}

function getSniperStatus() {
  return {
    running: demoSniper.running,
    startedAt: demoSniper.startedAt,
    uptimeMs: demoSniper.startedAt ? Date.now() - demoSniper.startedAt : null,
    cycleCount: demoSniper.cycleCount,
    totalPlaced: demoSniper.totalPlaced,
    stopReason: demoSniper.stopReason,
    lastCycleAt: demoSniper.lastCycleAt,
    lastCycleSummary: demoSniper.lastCycleSummary,
    aggression: getAggressionStatus(),
    recentHistory: demoSniper.cycleHistory.slice(-10),
    openTrades: sniperOpenTrades.size,
    placementInFlight: demoPlacementInFlight,
    monitorInFlight: demoMonitorInFlight,
    skippedPlacementOverlaps: demoSkippedPlacementOverlaps,
    skippedMonitorOverlaps: demoSkippedMonitorOverlaps,
    trigger: {
      loopRunning: Boolean(triggerCycleHandle),
      enabled: isTriggerEnabled(),
      cycleMs: TRIGGER_CYCLE_MS,
      hasExecutionCredentials: Boolean(demoSniper.creds ?? triggerExecutionCreds),
      lastCycleAt: triggerLastCycleAt,
      lastSkipReason: triggerLastSkipReason,
    },
    config: {
      globalMax: DEMO_SNIPER_GLOBAL_MAX,
      perSymbolMax: DEMO_SNIPER_PER_SYMBOL_MAX,
      cycleMs: DEMO_SNIPER_CYCLE_MS,
      scoreTiers: "score<0.60→0, 0.60-0.69→1, 0.70-0.79→3, 0.80-0.89→5, ≥0.90→10",
    },
  };
}

startTriggerCycleLoop();

/** POST /api/demo/sniper/start */
router.post("/demo/sniper/start", (req: Request, res: Response) => {
  const creds = getDemoCredentials(req);
  if (!creds) { res.status(401).json({ error: "Demo not connected." }); return; }

  if (demoSniper.running) {
    res.json({ started: false, reason: "Sniper already running", ...getSniperStatus() });
    return;
  }

  demoSniper.running = true;
  demoSniper.startedAt = Date.now();
  demoSniper.creds = { ...creds };
  rememberTriggerCredentials(creds);
  demoSniper.cycleCount = 0;
  demoSniper.totalPlaced = 0;
  demoSniper.stopReason = null;
  demoSniper.lastCycleSummary = null;
  demoSniper.cycleHistory = [];

  runDemoSniperCycleLocked().catch(() => {});
  demoSniper.placeHandle = setInterval(() => { runDemoSniperCycleLocked().catch(() => {}); }, DEMO_SNIPER_CYCLE_MS);
  demoSniper.monitorHandle = setInterval(() => { runDemoSniperMonitorLocked().catch(() => {}); }, DEMO_SNIPER_MONITOR_MS);

  // ── Auto-activate trigger engine using SCALP_SYMBOLS as targets ───────────
  // The trigger fires when price deviates significantly from reference, feeding
  // signals through the full pipeline (QB, stacking, gates) — no manual enable needed.
  {
    const sniperConfig = getBotConfig();
    setTriggerConfig({
      enabled: true,
      symbols: [],                      // empty → runtime fallback to allowedSymbols
      autoResetAfterFireMs: 10 * 60 * 1000, // auto-reset reference 10 min after fire
    });
    // Snapshot reference prices fire-and-forget (non-blocking)
    void (async () => {
      for (const sym of sniperConfig.allowedSymbols) {
        try {
          const price = await fetchDemoLastPrice(sym);
          if (price && price > 0) snapshotReferencePrice(sym, price);
        } catch { /* skip — trigger cycle will retry on next iteration */ }
      }
      req.log.info(
        { symbols: sniperConfig.allowedSymbols },
        "[demo-sniper] trigger engine auto-activated with SCALP_SYMBOLS",
      );
    })();
  }

  startTriggerCycleLoop();

  req.log.info({ cycleMs: DEMO_SNIPER_CYCLE_MS, globalMax: DEMO_SNIPER_GLOBAL_MAX }, "[demo-sniper] started");
  res.json({ started: true, ...getSniperStatus() });
});

/** POST /api/demo/sniper/stop */
router.post("/demo/sniper/stop", (req: Request, res: Response) => {
  if (!demoSniper.running) {
    res.json({ stopped: false, reason: "Sniper not running", ...getSniperStatus() });
    return;
  }
  stopDemoSniper("MANUAL_STOP");
  req.log.info({ totalPlaced: demoSniper.totalPlaced, cycleCount: demoSniper.cycleCount }, "[demo-sniper] stopped");
  res.json({ stopped: true, ...getSniperStatus() });
});

/** GET /api/demo/sniper/status */
router.get("/demo/sniper/status", (_req: Request, res: Response) => {
  res.json({
    ...getSniperStatus(),
    openTradesList: Array.from(sniperOpenTrades.values()).map((t) => ({
      orderId: t.orderId,
      symbol: t.symbol,
      positionSide: t.positionSide,
      entryPrice: t.entryPrice,
      quantity: t.quantity,
      marginUsed: t.marginUsed,
      entryTime: t.entryTime,
      btcRegime: t.btcRegime,
    })),
  });
});

/** GET /api/demo/campaign — dual-view: per-entry + per-symbol aggregate */
router.get("/demo/campaign", async (_req: Request, res: Response) => {
  type CampaignReportOutcome = Pick<
    TradeOutcome,
    | "id"
    | "symbol"
    | "positionSide"
    | "entryTime"
    | "exitTime"
    | "entryPrice"
    | "exitPrice"
    | "realizedPnl"
    | "fee"
    | "grossPnl"
    | "exitReason"
    | "btcRegime"
    | "estimated"
    | "campaignId"
    | "entryCount"
  >;

  const [ledgerTrades, quantBrainDemoOutcomes] = await Promise.all([
    loadClosedTrades(10_000),
    withDeadline(getQuantBrainRecentTrades("demo", 2_000), [], 500),
  ]);
  const ledgerCampaignIds = new Set(ledgerTrades.map((trade) => trade.campaignId).filter(Boolean));
  const localCampaignIds = new Set<string>();
  const outcomesById = new Map<string, CampaignReportOutcome>();

  for (const trade of ledgerTrades) {
    if (trade.campaignId) localCampaignIds.add(trade.campaignId);
    outcomesById.set(`ledger:${trade.tradeId}`, {
      id: trade.tradeId,
      symbol: trade.symbol,
      positionSide: trade.positionSide,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      realizedPnl: trade.realizedPnl,
      fee: trade.fee,
      grossPnl: trade.grossPnl,
      exitReason: trade.exitReason,
      btcRegime: trade.btcRegime as BtcRegime,
      estimated: trade.estimated,
      campaignId: trade.campaignId,
      entryCount: 1,
    });
  }

  for (const outcome of getEngine().rawOutcomes()) {
    if (!isDemoOutcome(outcome)) continue;
    if (outcome.campaignId && ledgerCampaignIds.has(outcome.campaignId)) {
      continue;
    }
    if (outcome.campaignId) localCampaignIds.add(outcome.campaignId);
    outcomesById.set(`outcome:${outcome.id}`, outcome);
  }

  for (const outcome of quantBrainDemoOutcomes) {
    const campaignId = outcome.campaignId
      ?? (outcome.id.startsWith("campaign:") ? outcome.id.slice("campaign:".length) : undefined);
    if (!isDemoOutcome(outcome) && !campaignId) continue;
    if (campaignId && localCampaignIds.has(campaignId)) continue;
    outcomesById.set(`quant:${outcome.id}`, outcome);
    if (campaignId) localCampaignIds.add(campaignId);
  }

  const outcomes = Array.from(outcomesById.values())
    .sort((a, b) => (a.entryTime ?? 0) - (b.entryTime ?? 0));

  type SymbolCampaign = {
    symbol: string;
    trades: number;
    wins: number;
    totalPnl: number;
    totalFees: number;
    totalGrossPnl: number;
    holdTimes: number[];
    runningPnl: number;
    peakPnl: number;
    maxDrawdown: number;
    lastTradeAt: number;
    tpCount: number;
    slCount: number;
    entries: Array<{
      id: string;
      entryTime: number;
      exitTime: number;
      positionSide: string;
      entryPrice: number;
      exitPrice: number;
      realizedPnl: number;
      fee: number;
      grossPnl: number;
      exitReason: string;
      isWin: boolean;
      holdMs: number;
      btcRegime: string;
      estimated: boolean;
    }>;
  };

  const symbolMap = new Map<string, SymbolCampaign>();

  for (const o of outcomes) {
    if (!symbolMap.has(o.symbol)) {
      symbolMap.set(o.symbol, {
        symbol: o.symbol,
        trades: 0, wins: 0, totalPnl: 0, totalFees: 0, totalGrossPnl: 0,
        holdTimes: [], runningPnl: 0, peakPnl: 0, maxDrawdown: 0,
        lastTradeAt: 0, tpCount: 0, slCount: 0, entries: [],
      });
    }
    const s = symbolMap.get(o.symbol)!;
    const isWin = (o.realizedPnl ?? 0) > 0;
    const holdMs = (o.exitTime ?? 0) - (o.entryTime ?? 0);
    const tradeWeight = Math.max(1, Math.trunc(Number(o.entryCount ?? 1)));

    s.trades += tradeWeight;
    if (isWin) s.wins += tradeWeight;
    s.totalPnl += o.realizedPnl ?? 0;
    s.totalFees += o.fee ?? 0;
    s.totalGrossPnl += o.grossPnl ?? 0;
    if (holdMs > 0) s.holdTimes.push(holdMs);
    s.runningPnl += o.realizedPnl ?? 0;
    if (s.runningPnl > s.peakPnl) s.peakPnl = s.runningPnl;
    const dd = s.peakPnl - s.runningPnl;
    if (dd > s.maxDrawdown) s.maxDrawdown = dd;
    s.lastTradeAt = Math.max(s.lastTradeAt, o.exitTime ?? 0);
    if (o.exitReason === "TP") s.tpCount++;
    if (o.exitReason === "SL") s.slCount++;

    s.entries.push({
      id: o.id,
      entryTime: o.entryTime ?? 0,
      exitTime: o.exitTime ?? 0,
      positionSide: o.positionSide,
      entryPrice: o.entryPrice ?? 0,
      exitPrice: o.exitPrice ?? 0,
      realizedPnl: parseFloat((o.realizedPnl ?? 0).toFixed(4)),
      fee: parseFloat((o.fee ?? 0).toFixed(4)),
      grossPnl: parseFloat((o.grossPnl ?? 0).toFixed(4)),
      exitReason: o.exitReason ?? "UNKNOWN",
      isWin,
      holdMs,
      btcRegime: o.btcRegime ?? "NEUTRAL",
      estimated: o.estimated ?? false,
    });
  }

  const symbols = Array.from(symbolMap.values())
    .map((s) => ({
      symbol: s.symbol,
      trades: s.trades,
      wins: s.wins,
      losses: s.trades - s.wins,
      winRate: s.trades > 0 ? parseFloat((s.wins / s.trades).toFixed(4)) : 0,
      totalPnl: parseFloat(s.totalPnl.toFixed(4)),
      totalFees: parseFloat(s.totalFees.toFixed(4)),
      totalGrossPnl: parseFloat(s.totalGrossPnl.toFixed(4)),
      avgHoldMs: s.holdTimes.length > 0
        ? Math.round(s.holdTimes.reduce((a, b) => a + b, 0) / s.holdTimes.length) : 0,
      maxDrawdown: parseFloat(s.maxDrawdown.toFixed(4)),
      lastTradeAt: s.lastTradeAt,
      tpCount: s.tpCount,
      slCount: s.slCount,
      entries: s.entries.slice(-100),
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  const totalPnl = symbols.reduce((sum, s) => sum + s.totalPnl, 0);
  const totalTrades = symbols.reduce((sum, s) => sum + s.trades, 0);
  const totalWins = symbols.reduce((sum, s) => sum + s.wins, 0);
  const totalFees = symbols.reduce((sum, s) => sum + s.totalFees, 0);
  const maxDrawdown = Math.max(...symbols.map((s) => s.maxDrawdown), 0);

  res.json({
    summary: {
      totalTrades,
      totalWins,
      totalLosses: totalTrades - totalWins,
      winRate: totalTrades > 0 ? parseFloat((totalWins / totalTrades).toFixed(4)) : 0,
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      totalFees: parseFloat(totalFees.toFixed(4)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
      symbolCount: symbols.length,
      bestSymbol: symbols[0]?.symbol ?? null,
      worstSymbol: symbols[symbols.length - 1]?.symbol ?? null,
      sniperRunning: demoSniper.running,
      sniperOpenTrades: sniperOpenTrades.size,
      ledgerTrades: ledgerTrades.length,
      quantBrainTrades: quantBrainDemoOutcomes.length,
    },
    symbols,
  });
});

/**
 * GET /api/demo/campaign/summary
 * Campaign-level aggregated PnL backed by demoTradeStore closed JSONL.
 * Deduplicated by campaignId — each campaign appears exactly once regardless of how
 * many stacked entries it contained. This is the ground-truth view for ML validation.
 */
router.get("/demo/campaign/summary", async (_req: Request, res: Response) => {
  try {
    const [recent, quantBrainDemoOutcomes] = await Promise.all([
      loadClosedTrades(2000),
      withDeadline(getQuantBrainRecentTrades("demo", 2_000), [], 500),
    ]);

    // Group by campaignId — dedup at campaign level
    const campaignMap = new Map<string, typeof recent>();
    for (const t of recent) {
      const grp = campaignMap.get(t.campaignId) ?? [];
      grp.push(t);
      campaignMap.set(t.campaignId, grp);
    }

    const campaigns = Array.from(campaignMap.entries())
      .map(([, trades]) => buildCampaignOutcome(trades))
      .filter((co): co is NonNullable<typeof co> => co !== null)
      .sort((a, b) => b.closedAt - a.closedAt);
    const localCampaignIds = new Set(campaigns.map((campaign) => campaign.campaignId));

    for (const outcome of quantBrainDemoOutcomes) {
      const campaignId = outcome.campaignId
        ?? (outcome.id.startsWith("campaign:") ? outcome.id.slice("campaign:".length) : "");
      if (!campaignId || localCampaignIds.has(campaignId)) continue;
      if (!isDemoOutcome(outcome) && !outcome.id.startsWith("campaign:")) continue;

      campaigns.push({
        campaignId,
        signalId: outcome.signalId ?? campaignId,
        marketEventId: outcome.marketEventId ?? null,
        predictionId: outcome.predictionId ?? null,
        clientOrderId: outcome.clientOrderId ?? null,
        exchangeOrderId: outcome.exchangeOrderId ?? outcome.entryOrderId ?? outcome.id,
        featureVersion: outcome.featureVersion ?? null,
        symbol: outcome.symbol,
        positionSide: outcome.positionSide,
        side: outcome.side,
        entryCount: Math.max(1, Math.trunc(Number(outcome.entryCount ?? 1))),
        openedAt: outcome.entryTime,
        closedAt: outcome.exitTime,
        holdDurationMs: Math.max(0, outcome.holdDurationMs ?? (outcome.exitTime - outcome.entryTime)),
        totalQty: outcome.qty,
        totalNotional: outcome.notional ?? outcome.entryPrice * outcome.qty,
        totalMarginUsed: outcome.marginUsed,
        avgEntryPrice: outcome.entryPrice,
        avgExitPrice: outcome.exitPrice,
        grossPnl: outcome.grossPnl,
        totalFee: outcome.fee,
        realizedPnl: outcome.realizedPnl,
        mfe: outcome.mfe ?? 0,
        mae: outcome.mae ?? 0,
        exitReasons: { [outcome.exitReason ?? "MANUAL"]: 1 },
        btcRegime: outcome.btcRegime,
        hourUtc: outcome.hourUtc,
        fallbackMode: false,
        modelVersion: outcome.modelVersion ?? null,
        pnlSource: outcome.pnlSource ?? "balance_delta",
        estimated: outcome.estimated ?? false,
      });
      localCampaignIds.add(campaignId);
    }

    campaigns.sort((a, b) => b.closedAt - a.closedAt);

    const totalRealizedPnl = campaigns.reduce((s, c) => s + c.realizedPnl, 0);
    const totalFees = campaigns.reduce((s, c) => s + c.totalFee, 0);
    const wins = campaigns.filter((c) => c.realizedPnl > 0).length;
    const estimatedCount = campaigns.filter((c) => c.estimated).length;
    const exchangeReportedCount = campaigns.filter((c) => c.pnlSource === "exchange_reported").length;

    res.json({
      campaignCount: campaigns.length,
      wins,
      losses: campaigns.length - wins,
      winRate: campaigns.length > 0 ? parseFloat((wins / campaigns.length).toFixed(4)) : 0,
      totalRealizedPnl: parseFloat(totalRealizedPnl.toFixed(4)),
      totalFees: parseFloat(totalFees.toFixed(4)),
      estimatedCount,
      exchangeReportedCount,
      ledgerTrades: recent.length,
      quantBrainTrades: quantBrainDemoOutcomes.length,
      campaigns: campaigns.slice(0, 200).map((co) => ({
        campaignId: co.campaignId,
        symbol: co.symbol,
        positionSide: co.positionSide,
        entryCount: co.entryCount,
        openedAt: co.openedAt,
        closedAt: co.closedAt,
        holdDurationMs: co.holdDurationMs,
        avgEntryPrice: co.avgEntryPrice,
        avgExitPrice: co.avgExitPrice,
        realizedPnl: parseFloat(co.realizedPnl.toFixed(4)),
        grossPnl: parseFloat(co.grossPnl.toFixed(4)),
        totalFee: parseFloat(co.totalFee.toFixed(4)),
        pnlSource: co.pnlSource,
        estimated: co.estimated,
        exitReasons: co.exitReasons,
        btcRegime: co.btcRegime,
        hourUtc: co.hourUtc,
        fallbackMode: co.fallbackMode,
        mfe: co.mfe,
        mae: co.mae,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load campaign summary", detail: String(err) });
  }
});

/**
 * GET /api/demo/stacking/audit
 * Chronological 70/30 holdout analysis of marginal stacking depth.
 */
router.get("/demo/stacking/audit", async (_req: Request, res: Response) => {
  try {
    const trades = await loadClosedTrades(10_000);
    res.json(buildStackingAudit(trades));
  } catch (err) {
    res.status(500).json({ error: "Failed to build stacking audit", detail: String(err) });
  }
});

/**
 * GET /api/demo/model-readiness
 * Proxies QB's /model/readiness endpoint with a bounded timeout.
 * Returns a structured degraded response when QB is unavailable — never throws.
 */
router.get("/demo/model-readiness", async (_req: Request, res: Response) => {
  const qbBase = process.env["QUANT_BRAIN_URL"]?.trim().replace(/\/+$/, "") ?? null;
  if (!qbBase) {
    res.json({
      available: false,
      reason: "QUANT_BRAIN_URL not configured",
      model: null,
      sampleCount: null,
      calibrationBrier: null,
      walkthroughAuc: null,
      minSamplesRequired: null,
      ready: false,
    });
    return;
  }

  try {
    const token = process.env["QUANT_BRAIN_API_TOKEN"]?.trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-Quant-Brain-Token"] = token;

    const resp = await fetch(`${qbBase}/model/readiness`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      res.json({
        available: false,
        reason: `QB returned ${resp.status}`,
        model: null,
        sampleCount: null,
        calibrationBrier: null,
        walkthroughAuc: null,
        minSamplesRequired: null,
        ready: false,
      });
      return;
    }

    const data = await resp.json() as Record<string, unknown>;
    res.json({ available: true, ...data });
  } catch (err) {
    res.json({
      available: false,
      reason: String(err),
      model: null,
      sampleCount: null,
      calibrationBrier: null,
      walkthroughAuc: null,
      minSamplesRequired: null,
      ready: false,
    });
  }
});

export { router as demoRouter };
export default router;
