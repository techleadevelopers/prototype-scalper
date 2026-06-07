import { Router } from "express";
import { createHmac } from "crypto";
import type { Request, Response } from "express";
import { getBotConfig } from "../lib/botConfig";
import { getEngine, recordTradeOutcome, updateTradeOutcome } from "../lib/telemetryStore";
import { evaluateQuantBrainEdge, quantBrainGateMode, syncQuantBrainOutcome } from "../lib/quantBrainClient";
import type { BtcRegime, TradeOutcome } from "../lib/adaptiveEngine";
import { feeDragRejectReason } from "../lib/executionRisk";
import { buildTelemetryState } from "./telemetry";
import { computeCandleEdge } from "../lib/candleEdge";
import {
  buildAttachedProtection,
  candleConfirmationRejects,
  recentPerformanceRejects,
  summarizeRecentPerformance,
} from "../lib/entryProtection";

interface DemoOpenTrade {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  expectedEntryPrice?: number;
  entryTime: number;
  hourUtc: number;
  btcRegime: BtcRegime;
  leverage: number;
  marginUsed: number;
  expectedTpProfit: number;
}

declare module "express-session" {
  interface SessionData {
    demoApiKey?: string;
    demoSecretKey?: string;
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

function getDemoCredentials(req: Request): { apiKey: string; secretKey: string } | null {
  const { demoApiKey, demoSecretKey } = req.session;
  if (!demoApiKey || !demoSecretKey) return null;
  return { apiKey: demoApiKey, secretKey: demoSecretKey };
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
      const entrySlippage = estimateExecutionSlippage(entry.positionSide, entry.expectedEntryPrice, entry.entryPrice, closeQty, "entry");
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
        expectedEntryPrice: entry.expectedEntryPrice,
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

/** POST /api/demo/connect — usa as credenciais já salvas na sessão principal */
router.post("/demo/connect", async (req: Request, res: Response) => {
  // Reutiliza as credenciais da conta real já autenticadas (mesmas chaves, endpoint VST)
  const { bingxApiKey, bingxSecretKey } = req.session as { bingxApiKey?: string; bingxSecretKey?: string };

  if (!bingxApiKey || !bingxSecretKey) {
    res.status(401).json({ connected: false, error: "Conecte sua conta BingX primeiro na aba principal antes de ativar o modo demo." });
    return;
  }

  try {
    const bal = await fetchDemoBalance(bingxApiKey, bingxSecretKey);
    if (!bal) {
      res.status(401).json({ connected: false, error: "Conta demo VST não acessível com essas credenciais. Verifique se a conta demo está ativada no app BingX." });
      return;
    }

    req.session.demoApiKey = bingxApiKey;
    req.session.demoSecretKey = bingxSecretKey;

    const posData = await bingxGet("/openApi/swap/v2/user/positions", {}, bingxApiKey, bingxSecretKey);
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
    req.log.error({ err }, "demo connect error");
    res.status(500).json({ connected: false, error: "Falha ao conectar ao servidor VST" });
  }
});

/** POST /api/demo/disconnect */
router.post("/demo/disconnect", (req: Request, res: Response) => {
  req.session.demoApiKey = undefined;
  req.session.demoSecretKey = undefined;
  req.session.demoOpenTrades = undefined;
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
    });
    quantBrainEdge = edge;
    if (edge.error && edge.error !== "missing QUANT_BRAIN_URL") {
      req.log.warn({ error: edge.error, symbol, positionSide }, "quant brain edge unavailable");
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

  if (openPositionsCount >= config.maxConcurrentPositions) {
    gateRejects.push(`CAPITAL_REJECT: ${openPositionsCount} positions >= max ${config.maxConcurrentPositions}`);
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
    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      orderParams,
      creds.apiKey,
      creds.secretKey,
    );

    if (!isBingXSuccess(data)) {
      req.log.error({ data }, "demo order BingX error");
      res.status(500).json({
        placed: false,
        orderId: null,
        symbol,
        side,
        quantity: qty,
        gateRejects: [],
        observationMode: false,
        message: `BingX error: ${(data.msg as string) ?? "unknown"}`,
      });
      return;
    }

    const order = (data.data as Record<string, unknown>)?.order as Record<string, unknown>;
    const orderId = String(order?.orderId ?? "");
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
        const entrySlippage = estimateExecutionSlippage(entry.positionSide, entry.expectedEntryPrice, entry.entryPrice, closeQty, "entry");
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
          expectedEntryPrice: entry.expectedEntryPrice,
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

export { router as demoRouter };
export default router;
