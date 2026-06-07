import { Router } from "express";
import { createHmac } from "crypto";
import type { Request, Response } from "express";
import { getBotConfig, setConfigOverrides, resetConfigOverrides } from "../lib/botConfig";
import {
  BOT_MODES, type BotModeId, type BulkOrderItem, type BulkOrderResult, type BulkExecutionSummary,
  TokenBucket, setActiveModeId, getActiveModeId, getActiveModePreset, clearActiveMode,
} from "../lib/botModes";
import { exportAllOutcomes, getEngine } from "../lib/telemetryStore";
import { AdaptiveEngine, type BtcRegime, type ClusterKey, type PositionSide, type TradeOutcome } from "../lib/adaptiveEngine";
import { computeAllCandleEdges, computeCandleEdge, type CandleInterval } from "../lib/candleEdge";
import { feeDragRejectReason, maxCorrelatedBulkOrders } from "../lib/executionRisk";
import { getQuantBrainIntelligence } from "../lib/quantBrainClient";
import { getMarketSentiment, getMarketSentimentBulk, type SentimentResult } from "../lib/sentimentEngine";
import {
  buildAttachedProtection,
  candleConfirmationRejects,
  recentPerformanceRejects,
  summarizeRecentPerformance,
} from "../lib/entryProtection";

const router = Router();

const BINGX_BASE = "https://open-api.bingx.com";

type TelemetrySourceFilter = "all" | "demo" | "live";

function normalizeTelemetrySource(value: unknown): TelemetrySourceFilter {
  const raw = String(value ?? "all").trim().toLowerCase();
  return raw === "demo" || raw === "live" ? raw : "all";
}

function isDemoOutcome(outcome: TradeOutcome): boolean {
  return outcome.isDemo === true || outcome.source === "bingx-vst";
}

function getTelemetryEngineForSource(source: TelemetrySourceFilter): AdaptiveEngine {
  if (source === "all") return getEngine();
  const outcomes = exportAllOutcomes().filter((outcome) => (
    source === "demo" ? isDemoOutcome(outcome) : !isDemoOutcome(outcome)
  ));
  const engine = new AdaptiveEngine(outcomes);
  engine.stopAutoSave();
  return engine;
}

function sign(params: Record<string, string | number | undefined>, secretKey: string): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secretKey).update(query).digest("hex");
}

const BINGX_REQUEST_TIMEOUT_MS = Number(process.env["BINGX_REQUEST_TIMEOUT_MS"] ?? 8_000);

async function bingxPost(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-BX-APIKEY": apiKey },
    signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function bingxGet(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    headers: { "X-BX-APIKEY": apiKey },
    signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

function getCredentials(req: Request): { apiKey: string; secretKey: string } | null {
  const { bingxApiKey, bingxSecretKey } = req.session;
  if (!bingxApiKey || !bingxSecretKey) return null;
  return { apiKey: bingxApiKey, secretKey: bingxSecretKey };
}

/** GET /api/bot/config — current bot configuration from ENV */
router.get("/bot/config", (_req: Request, res: Response) => {
  res.json(getBotConfig());
});

/** PATCH /api/bot/config/override — apply runtime overrides (in-memory) */
router.patch("/bot/config/override", (req: Request, res: Response) => {
  const patch = req.body as Record<string, unknown>;
  const allowed = [
    "leverage", "marginPerTrade", "maxConcurrentPositions", "maxMarginUtilization",
    "takeProfitPct", "stopLossPct", "evMinThreshold", "winRateMin", "profitFactorMin",
    "btcRegimeRequired", "allowCounterRegimeScalp", "btcRegimeThresholdPct", "allowedSymbols", "hourBlacklist",
    "orderType", "marginType", "allowExecution", "maxSessionLoss",
  ];
  const safe: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in patch) safe[key] = patch[key];
  }
  setConfigOverrides(safe);
  req.log.info({ overrides: safe }, "bot config override applied");
  res.json(getBotConfig());
});

/** POST /api/bot/config/override/reset — clear all runtime overrides */
router.post("/bot/config/override/reset", (_req: Request, res: Response) => {
  resetConfigOverrides();
  res.json(getBotConfig());
});

/** POST /api/bot/order — place scalp entry order with all gate checks */
router.post("/bot/order", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected. Please provide your API credentials." });
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
  } = req.body as {
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    quantity?: number;
    currentEv?: number;
    currentWinRate?: number;
    currentProfitFactor?: number;
    btcChangePct?: number;
  };

  if (!symbol || !side || !positionSide) {
    res.status(400).json({ error: "symbol, side, and positionSide are required" });
    return;
  }

  // ── Gate evaluation pipeline ────────────────────────────────────────────────
  const gateRejects: string[] = [];
  const currentHour = new Date().getUTCHours();
  const recentPerformance = summarizeRecentPerformance(
    getEngine().rawOutcomes().filter((outcome) => !isDemoOutcome(outcome)),
    config,
  );
  gateRejects.push(...recentPerformanceRejects(recentPerformance, config));
  const candle = await computeCandleEdge(symbol, "5m");
  gateRejects.push(...candleConfirmationRejects(candle, positionSide, config));

  // Gate 1: master kill switch
  if (!config.allowExecution) {
    // observation mode — evaluate all gates but never send
  }

  // Gate 2: symbol allowlist
  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(symbol)) {
    gateRejects.push(`SYMBOL_REJECT: ${symbol} not in allowlist [${config.allowedSymbols.join(",")}]`);
  }

  // Gate 3: hour blacklist
  if (config.hourBlacklist.includes(currentHour)) {
    gateRejects.push(`HOUR_REJECT: UTC hour ${currentHour} is blacklisted`);
  }

  // Gate 4: BTC regime gate
  if (config.btcRegimeRequired && btcChangePct !== undefined) {
    const absChange = Math.abs(btcChangePct);
    if (absChange < config.btcRegimeThresholdPct) {
      gateRejects.push(
        `REGIME_REJECT: BTC change ${btcChangePct.toFixed(2)}% < threshold ±${config.btcRegimeThresholdPct}%`,
      );
    } else {
      // Ensure direction agreement
      const btcBull = btcChangePct > 0;
      const wantLong = positionSide === "LONG";
      if (!config.allowCounterRegimeScalp && btcBull !== wantLong) {
        gateRejects.push(
          `REGIME_DIRECTION: BTC ${btcBull ? "BULL" : "BEAR"} but entry is ${positionSide}`,
        );
      }
    }
  }

  // Gate 5: EV gate
  if (config.evMinThreshold > 0 && currentEv !== undefined) {
    if (currentEv < config.evMinThreshold) {
      gateRejects.push(
        `EV_REJECT: EV ${currentEv.toFixed(4)} < threshold ${config.evMinThreshold.toFixed(4)}`,
      );
    }
  }

  const feeDragReject = feeDragRejectReason(currentEv, config.marginPerTrade, config);
  if (feeDragReject) {
    gateRejects.push(feeDragReject);
  }

  // Gate 6: win rate gate
  if (config.winRateMin > 0 && currentWinRate !== undefined) {
    if (currentWinRate < config.winRateMin) {
      gateRejects.push(
        `WR_REJECT: WR ${(currentWinRate * 100).toFixed(1)}% < min ${(config.winRateMin * 100).toFixed(1)}%`,
      );
    }
  }

  // Gate 7: profit factor gate
  if (config.profitFactorMin > 0 && currentProfitFactor !== undefined) {
    if (currentProfitFactor < config.profitFactorMin) {
      gateRejects.push(
        `PF_REJECT: PF ${currentProfitFactor.toFixed(2)}x < min ${config.profitFactorMin.toFixed(2)}x`,
      );
    }
  }

  // Gate 8: capital gate — check open position count + margin
  let openPositionsCount = 0;
  let marginUtilization = 0;
  let openPositions: Record<string, unknown>[] = [];
  try {
    const [posData, balData] = await Promise.all([
      bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey),
      bingxGet("/openApi/swap/v2/user/balance", {}, creds.apiKey, creds.secretKey),
    ]);
    if (posData.code === 0) {
      openPositions = ((posData.data as unknown[]) ?? []) as Record<string, unknown>[];
      openPositions = openPositions.filter((p) => parseFloat(String(p.positionAmt ?? "0")) !== 0);
      openPositionsCount = openPositions.length;
    }
    if (balData.code === 0) {
      const bal = ((balData.data as Record<string, unknown>)?.balance ?? {}) as Record<string, string>;
      const usedMargin = parseFloat(bal.usedMargin ?? "0");
      const equity = parseFloat(bal.equity ?? "1");
      marginUtilization = equity > 0 ? usedMargin / equity : 0;
    }
  } catch {
    // non-fatal — proceed without capital gate if fetch fails
  }

  if (openPositionsCount >= config.maxConcurrentPositions) {
    gateRejects.push(
      `CAPITAL_REJECT: ${openPositionsCount} open positions >= max ${config.maxConcurrentPositions}`,
    );
  }
  if (
    config.preventHedgedPositions
    && openPositions.some((position) => String(position.symbol ?? "").toUpperCase() === symbol.toUpperCase())
  ) {
    gateRejects.push(`POSITION_CONFLICT_REJECT: ${symbol} already has an open position`);
  }
  if (marginUtilization > config.maxMarginUtilization) {
    gateRejects.push(
      `MARGIN_REJECT: margin utilization ${(marginUtilization * 100).toFixed(1)}% > max ${(config.maxMarginUtilization * 100).toFixed(0)}%`,
    );
  }

  // ── Observation mode ────────────────────────────────────────────────────────
  if (!config.allowExecution) {
    req.log.info({ symbol, side, positionSide, gateRejects, observationMode: true }, "bot order observation");
    res.status(200).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: quantity ?? null,
      gateRejects,
      observationMode: true,
      message: gateRejects.length > 0
        ? `BLOCKED by ${gateRejects.length} gate(s). Also observation mode (SCALP_ALLOW_EXECUTION=false).`
        : "All gates pass. Observation mode active — set SCALP_ALLOW_EXECUTION=true to execute.",
    });
    return;
  }

  // ── Gate blocked ────────────────────────────────────────────────────────────
  if (gateRejects.length > 0) {
    req.log.info({ symbol, side, positionSide, gateRejects }, "bot order gate reject");
    res.status(403).json({
      placed: false,
      orderId: null,
      symbol,
      side,
      quantity: quantity ?? null,
      gateRejects,
      observationMode: false,
      message: `REJECTED by ${gateRejects.length} gate(s): ${gateRejects[0]}`,
    });
    return;
  }

  // ── Compute quantity if not provided ────────────────────────────────────────
  let qty = quantity;
  if (!qty) {
    // Fetch mark price to compute qty = (marginPerTrade × leverage) / markPrice
    try {
      const timestamp = Date.now();
      const url = `${BINGX_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}&timestamp=${timestamp}`;
      const tickerData = (await (await fetch(url)).json()) as Record<string, unknown>;
      if (tickerData.code === 0) {
        const t = (tickerData.data as Record<string, string>) ?? {};
        const markPrice = parseFloat(t.lastPrice ?? "0");
        if (markPrice > 0) {
          qty = (config.marginPerTrade * config.leverage) / markPrice;
          // Round to reasonable precision
          qty = Math.floor(qty * 1000) / 1000;
        }
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
      observationMode: false,
      message: "Could not determine order quantity. Provide quantity explicitly.",
    });
    return;
  }

  // ── Execute order ────────────────────────────────────────────────────────────
  try {
    const orderParams: Record<string, string | number> = {
      symbol,
      side,
      positionSide,
      type: config.orderType,
      quantity: qty,
      leverage: config.leverage,
    };

    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      orderParams,
      creds.apiKey,
      creds.secretKey,
    );

    if (data.code !== 0) {
      req.log.error({ data }, "BingX order error");
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
    req.log.info({ symbol, side, positionSide, qty, orderId: order?.orderId }, "bot order placed");

    res.json({
      placed: true,
      orderId: String(order?.orderId ?? ""),
      symbol,
      side,
      quantity: qty,
      gateRejects: [],
      observationMode: false,
      message: `Order placed: ${side} ${qty} ${symbol} @ MARKET`,
    });
  } catch (err) {
    req.log.error({ err }, "bot order execution error");
    res.status(500).json({ error: "Order execution failed" });
  }
});

/** POST /api/bot/close — close an open position */
router.post("/bot/close", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected." });
    return;
  }

  const config = getBotConfig();
  const { symbol, positionSide, quantity } = req.body as {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    quantity: string;
  };

  if (!symbol || !positionSide || !quantity) {
    res.status(400).json({ error: "symbol, positionSide, and quantity are required" });
    return;
  }

  // Closing a LONG = SELL; closing a SHORT = BUY
  const closeSide = positionSide === "LONG" ? "SELL" : "BUY";

  if (!config.allowExecution) {
    res.json({
      placed: false,
      orderId: null,
      symbol,
      side: closeSide,
      quantity: parseFloat(quantity),
      gateRejects: [],
      observationMode: true,
      message: "Observation mode — set SCALP_ALLOW_EXECUTION=true to execute close.",
    });
    return;
  }

  try {
    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      {
        symbol,
        side: closeSide,
        positionSide,
        type: "MARKET",
        quantity: parseFloat(quantity),
      },
      creds.apiKey,
      creds.secretKey,
    );

    if (data.code !== 0) {
      res.status(500).json({
        placed: false,
        orderId: null,
        symbol,
        side: closeSide,
        quantity: parseFloat(quantity),
        gateRejects: [],
        observationMode: false,
        message: `BingX error: ${(data.msg as string) ?? "unknown"}`,
      });
      return;
    }

    const order = (data.data as Record<string, unknown>)?.order as Record<string, unknown>;
    res.json({
      placed: true,
      orderId: String(order?.orderId ?? ""),
      symbol,
      side: closeSide,
      quantity: parseFloat(quantity),
      gateRejects: [],
      observationMode: false,
      message: `Close order placed: ${closeSide} ${quantity} ${symbol}`,
    });
  } catch (err) {
    req.log.error({ err }, "bot close error");
    res.status(500).json({ error: "Close order failed" });
  }
});


const BINGX_PUBLIC_BASE = "https://open-api.bingx.com";
const BINGX_RATE_LIMIT = 10; // max orders/second

function bulkCorrelationKey(order: BulkOrderItem): string {
  const regime =
    order.btcChangePct === undefined ? "UNKNOWN" :
    order.btcChangePct > 0 ? "BTC_BULL" :
    order.btcChangePct < 0 ? "BTC_BEAR" :
    "BTC_NEUTRAL";
  return `${regime}:${order.positionSide}`;
}

function buildBulkCorrelationRejects(orders: BulkOrderItem[], maxPerCluster: number): Map<number, string[]> {
  const seenByCluster = new Map<string, number>();
  const rejects = new Map<number, string[]>();

  orders.forEach((order, index) => {
    const key = bulkCorrelationKey(order);
    const seen = seenByCluster.get(key) ?? 0;
    if (seen >= maxPerCluster) {
      rejects.set(index, [
        `CORRELATION_REJECT: bulk cluster ${key} already has ${maxPerCluster} active orders`,
      ]);
      return;
    }
    seenByCluster.set(key, seen + 1);
  });

  return rejects;
}

/**
 * GET /api/bot/sentiment — 24h directional bias engine per symbol.
 *
 * Returns SentimentResult for each allowed symbol:
 *   direction: BULL | BEAR | NEUTRAL
 *   confidence: 0-1
 *   biasRatio: 0.5 = neutral; 0.72 = 72% weight to dominantSide
 *   entryBias: { longWeight, shortWeight } for bulk order distribution
 *   indicators: vwapDeviation, volumeDelta, momentum4h, momentum24h, ema12vs24, etc.
 *
 * Use biasRatio to tilt bulk entry distribution:
 *   BULL 0.75 → 75% of bulk slots are LONG, 25% SHORT
 *   BEAR 0.70 → 70% SHORT, 30% LONG
 */
router.get("/bot/sentiment", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const symbols = config.allowedSymbols.length > 0 ? config.allowedSymbols : [];
  const single = req.query.symbol as string | undefined;

  if (single) {
    const result = await getMarketSentiment(single);
    res.json(result);
    return;
  }

  if (symbols.length === 0) {
    res.json({ symbols: [], fetchedAt: Date.now() });
    return;
  }

  const results = await getMarketSentimentBulk(symbols);

  const overallScore = results.reduce((acc, r) => {
    const w = r.confidence;
    return acc + (r.direction === "BULL" ? w : r.direction === "BEAR" ? -w : 0);
  }, 0) / Math.max(1, results.length);

  const portfolioBias: "BULL" | "BEAR" | "NEUTRAL" =
    overallScore > 0.08 ? "BULL" : overallScore < -0.08 ? "BEAR" : "NEUTRAL";

  const portfolioBiasRatio = Math.max(0.5, Math.min(0.80, 0.5 + Math.abs(overallScore) * 2.5));

  res.json({
    symbols: results,
    portfolioBias,
    portfolioBiasRatio,
    fetchedAt: Date.now(),
  });
});

/** GET /api/bot/scan — parallel multi-symbol scan with adaptive ranking */
router.get("/bot/scan", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const engine = getEngine();

  const btcChangePct = req.query.btcChangePct !== undefined
    ? parseFloat(String(req.query.btcChangePct))
    : 0;
  const positionSideFilter = (req.query.positionSide as string | undefined) ?? "BOTH";

  const btcRegime: BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";

  const currentHourUtc = new Date().getUTCHours();

  // Which symbols to scan — if allowlist empty, nothing to scan
  const symbols = config.allowedSymbols.length > 0 ? config.allowedSymbols : [];

  if (symbols.length === 0) {
    res.json({
      scanTime: Date.now(),
      btcRegime,
      btcChangePct,
      currentHourUtc,
      symbols: [],
      candidateCount: 0,
      maxOrdersPerSecond: BINGX_RATE_LIMIT,
    });
    return;
  }

  // Determine which sides to evaluate. In BOTH mode we keep both sides visible
  // so the edge engine can choose contrarian scalp entries after extreme moves.
  const sides: PositionSide[] =
    positionSideFilter === "LONG" ? ["LONG"] :
    positionSideFilter === "SHORT" ? ["SHORT"] :
    ["LONG", "SHORT"];

  // Fetch tickers AND sentiment in parallel — both public endpoints
  const [tickerResults, sentimentResults] = await Promise.all([
    Promise.allSettled(
      symbols.map(async (sym) => {
        const url = `${BINGX_PUBLIC_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(sym)}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const json = await resp.json() as Record<string, unknown>;
        if (json.code !== 0) throw new Error(`ticker error ${sym}: ${json.msg}`);
        const d = (json.data as Record<string, unknown>) ?? {};
        return {
          symbol: sym,
          lastPrice: String(d.lastPrice ?? "0"),
          priceChangePct: parseFloat(String(d.priceChangePercent ?? "0")),
        };
      })
    ),
    getMarketSentimentBulk(symbols).catch(() => symbols.map((s) => ({
      symbol: s, direction: "NEUTRAL" as const, confidence: 0, biasRatio: 0.5,
      dominantSide: "NEUTRAL" as const, entryBias: { longWeight: 0.5, shortWeight: 0.5 },
      indicators: { vwapDeviation: 0, volumeDelta: 0, momentum4h: 0, momentum24h: 0,
        ema12vs24: "FLAT" as const, rangePosition: 0.5, bodyBias: 0, volumeTrend: "FLAT" as const,
        highLowBreak: "RANGE_BOUND" as const },
      candles24h: 0, fetchedAt: Date.now(),
    }))),
  ]);

  const sentimentBySymbol = new Map<string, SentimentResult>(
    sentimentResults.map((r) => [r.symbol, r])
  );

  // Build ScanSymbol entries for each symbol × each applicable side
  const scanSymbols: Array<{
    symbol: string;
    positionSide: PositionSide;
    lastPrice: string;
    priceChangePct: number;
    rankingScore: number;
    priorityScore: number;
    toxicityScore: number;
    ewmaWinRate: number;
    ev: number;
    samples: number;
    gatePass: boolean;
    gateRejects: string[];
    isCandidate: boolean;
    isToxic: boolean;
  }> = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const tickerResult = tickerResults[i];
    const ticker = tickerResult.status === "fulfilled" ? tickerResult.value : null;

    for (const side of sides) {
      const gateRejects: string[] = [];

      // Gate: hour blacklist
      if (config.hourBlacklist.includes(currentHourUtc)) {
        gateRejects.push(`HOUR_REJECT: UTC hour ${currentHourUtc} is blacklisted`);
      }

      // Gate: BTC regime required
      if (config.btcRegimeRequired && btcRegime === "NEUTRAL") {
        gateRejects.push(`REGIME_REJECT: BTC regime is NEUTRAL (${btcChangePct.toFixed(2)}% < ±${config.btcRegimeThresholdPct}%)`);
      }

      // Gate: regime direction agreement
      if (config.btcRegimeRequired && !config.allowCounterRegimeScalp && btcRegime !== "NEUTRAL") {
        const want = side === "LONG" ? "BULL" : "BEAR";
        if (btcRegime !== want) {
          gateRejects.push(`REGIME_DIRECTION: BTC ${btcRegime} but setup is ${side}`);
        }
      }

      // Get adaptive context
      const clusterKey: ClusterKey = { symbol: sym, positionSide: side, hourUtc: currentHourUtc, btcRegime };
      const signal = engine.contextSignal(clusterKey);
      const symProfile = engine.symbolProfile(sym);
      const clusterProfile = engine.clusterProfile(clusterKey);

      const isToxic = symProfile?.isToxic ?? false;
      const ev = clusterProfile?.ev ?? symProfile?.ev ?? 0;
      const ewmaWinRate = clusterProfile?.ewmaWinRate ?? (symProfile?.winRate ?? 0.5);
      const priorityScore = signal.priorityScore;
      const toxicityScore = signal.toxicityScore;

      // Gate: toxicity
      if (isToxic) {
        gateRejects.push(`TOXICITY_REJECT: ${sym} has negative realized PnL (${symProfile?.totalSamples ?? 0} trades)`);
      }

      // Gate: EV threshold
      if (config.evMinThreshold > 0 && signal.samples >= 10 && ev < config.evMinThreshold) {
        gateRejects.push(`EV_REJECT: EV ${ev.toFixed(4)} < threshold ${config.evMinThreshold.toFixed(4)}`);
      }

      const feeDragReject = feeDragRejectReason(ev, config.marginPerTrade, config);
      if (signal.samples >= 10 && feeDragReject) {
        gateRejects.push(feeDragReject);
      }

      // Gate: win rate
      if (config.winRateMin > 0 && signal.samples >= 10 && ewmaWinRate < config.winRateMin) {
        gateRejects.push(`WR_REJECT: WR ${(ewmaWinRate * 100).toFixed(1)}% < min ${(config.winRateMin * 100).toFixed(1)}%`);
      }

      // Gate: no ticker data
      if (!ticker) {
        gateRejects.push(`TICKER_FAIL: could not fetch price for ${sym}`);
      }

      const gatePass = gateRejects.length === 0;

      const sentiment = sentimentBySymbol.get(sym);
      const sentimentDirection = sentiment?.direction ?? "NEUTRAL";
      const sentimentBiasRatio = sentiment?.biasRatio ?? 0.5;
      const sentimentConfidence = sentiment?.confidence ?? 0;

      // Sentiment-aware ranking boost: if this side aligns with dominant sentiment, boost rank
      const sentimentAligned =
        (side === "LONG" && sentimentDirection === "BULL") ||
        (side === "SHORT" && sentimentDirection === "BEAR");
      const sentimentBoost = sentimentAligned && sentimentConfidence > 0.3
        ? sentimentConfidence * 0.15
        : !sentimentAligned && sentimentConfidence > 0.4
          ? -sentimentConfidence * 0.10
          : 0;
      const sentimentAdjustedRank = gatePass
        ? Math.max(0, engine.rankingScore(clusterKey, Math.max(0, ev)) + sentimentBoost)
        : 0;

      scanSymbols.push({
        symbol: sym,
        positionSide: side,
        lastPrice: ticker?.lastPrice ?? "0",
        priceChangePct: ticker?.priceChangePct ?? 0,
        rankingScore: sentimentAdjustedRank,
        priorityScore,
        toxicityScore,
        ewmaWinRate,
        ev,
        samples: signal.samples,
        gatePass,
        gateRejects,
        isCandidate: gatePass,
        isToxic,
        sentiment: {
          direction: sentimentDirection,
          confidence: sentimentConfidence,
          biasRatio: sentimentBiasRatio,
          dominantSide: sentiment?.dominantSide ?? "NEUTRAL",
          aligned: sentimentAligned,
          longWeight: sentiment?.entryBias.longWeight ?? 0.5,
          shortWeight: sentiment?.entryBias.shortWeight ?? 0.5,
          vwapDeviation: sentiment?.indicators.vwapDeviation ?? 0,
          momentum24h: sentiment?.indicators.momentum24h ?? 0,
        },
      });
    }
  }

  // Sort by rankingScore descending, then by priorityScore
  scanSymbols.sort((a, b) => {
    if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore;
    return b.priorityScore - a.priorityScore;
  });

  const candidateCount = scanSymbols.filter((s) => s.isCandidate).length;

  // Portfolio-level directional bias from sentiment
  const sentimentScores = sentimentResults.map((r) => {
    const w = r.confidence;
    return r.direction === "BULL" ? w : r.direction === "BEAR" ? -w : 0;
  });
  const portfolioSentimentScore = sentimentScores.reduce((a, b) => a + b, 0) / Math.max(1, sentimentScores.length);
  const portfolioBias: "BULL" | "BEAR" | "NEUTRAL" =
    portfolioSentimentScore > 0.08 ? "BULL" : portfolioSentimentScore < -0.08 ? "BEAR" : "NEUTRAL";
  const portfolioBiasRatio = Math.max(0.5, Math.min(0.80, 0.5 + Math.abs(portfolioSentimentScore) * 2.5));
  const recommendedLongPct = portfolioBias === "BULL" ? portfolioBiasRatio : portfolioBias === "BEAR" ? 1 - portfolioBiasRatio : 0.5;

  res.json({
    scanTime: Date.now(),
    btcRegime,
    btcChangePct,
    currentHourUtc,
    symbols: scanSymbols,
    candidateCount,
    maxOrdersPerSecond: BINGX_RATE_LIMIT,
    portfolioBias,
    portfolioBiasRatio,
    recommendedLongPct,
    recommendedShortPct: 1 - recommendedLongPct,
  });
});

/**
 * GET /api/bot/edge
 *
 * Full Edge Telemetry for all target symbols — combines:
 *   1. CandleEdge: EMA9/21 cross, RSI14, ATR14, volume surge (real-time market)
 *   2. AdaptiveEngine: EWMA win rate, EV, priority/toxicity scores (learned telemetry)
 *   3. Combined edge score: adaptiveRanking × (0.60 + marketScore × 0.40)
 *
 * Equivalent to how the Rust runtime fuses priority_score + sizing_score + liquidity_distortion_score.
 *
 * Query params:
 *   interval  — candle interval: 1m | 3m | 5m | 15m  (default: 5m)
 *   btcChangePct — BTC % change for regime detection (default: 0)
 */
router.get("/bot/edge", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const engine = getEngine();

  const interval = (req.query.interval as CandleInterval | undefined) ?? "5m";
  const validIntervals: CandleInterval[] = ["1m", "3m", "5m", "15m"];
  const safeInterval: CandleInterval = validIntervals.includes(interval) ? interval : "5m";

  const btcChangePct = req.query.btcChangePct !== undefined
    ? parseFloat(String(req.query.btcChangePct))
    : 0;

  const btcRegime: BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";

  const currentHourUtc = new Date().getUTCHours();
  const symbols = config.allowedSymbols.length > 0 ? config.allowedSymbols : [];

  if (symbols.length === 0) {
    res.json({ edgeTime: Date.now(), btcRegime, currentHourUtc, interval: safeInterval, symbols: [] });
    return;
  }

  // Fetch candles for all symbols in parallel
  const candleEdges = await computeAllCandleEdges(symbols, safeInterval);

  // Build per-symbol edge report
  const edgeSymbols = symbols.map((sym, i) => {
    const candle = candleEdges[i];
    const adaptive = engine.edgeSummary(sym, currentHourUtc, btcRegime);

    // Combined scores for LONG and SHORT
    const longKey: ClusterKey = { symbol: sym, positionSide: "LONG", hourUtc: currentHourUtc, btcRegime };
    const shortKey: ClusterKey = { symbol: sym, positionSide: "SHORT", hourUtc: currentHourUtc, btcRegime };

    const longCombined  = engine.combinedEdgeScore(longKey,  adaptive.longEdge.ev,  candle.longScore);
    const shortCombined = engine.combinedEdgeScore(shortKey, adaptive.shortEdge.ev, candle.shortScore);

    // Best side from combined score
    const bestSide: PositionSide | "NEUTRAL" =
      longCombined > shortCombined && longCombined > 0.01 ? "LONG" :
      shortCombined > longCombined && shortCombined > 0.01 ? "SHORT" : "NEUTRAL";

    // ATR-based TP/SL suggestions (dynamic sizing like Rust's self_slippage_bps)
    const atrTpSuggestion  = candle.atr14 > 0 && candle.lastClose > 0
      ? parseFloat(((candle.atr14 * 1.5 / candle.lastClose) * 100).toFixed(3))
      : config.takeProfitPct;
    const atrSlSuggestion  = candle.atr14 > 0 && candle.lastClose > 0
      ? parseFloat(((candle.atr14 * 1.0 / candle.lastClose) * 100).toFixed(3))
      : config.stopLossPct;

    return {
      symbol: sym,
      // ── Market indicators (CandleEdge) ────────────────────────────────────
      market: {
        lastClose: candle.lastClose,
        interval: candle.interval,
        ema9: candle.ema9,
        ema21: candle.ema21,
        emaCross: candle.emaCross,
        emaCrossPct: parseFloat(candle.emaCrossPct.toFixed(4)),
        rsi14: parseFloat(candle.rsi14.toFixed(2)),
        atr14: candle.atr14,
        atrPct: parseFloat(candle.atrPct.toFixed(3)),
        volumeRatio: parseFloat(candle.volumeRatio.toFixed(2)),
        lastCandleMovePct: parseFloat(candle.lastCandleMovePct.toFixed(3)),
        recentMovePct: parseFloat(candle.recentMovePct.toFixed(3)),
        reversalScore: parseFloat(candle.reversalScore.toFixed(4)),
        longScore: parseFloat(candle.longScore.toFixed(4)),
        shortScore: parseFloat(candle.shortScore.toFixed(4)),
        suggestedSide: candle.suggestedSide,
        candleError: candle.error ?? null,
      },
      // ── Adaptive telemetry (learned from trade history) ───────────────────
      adaptive: {
        long: {
          samples: adaptive.longEdge.samples,
          ewmaWinRate: parseFloat((adaptive.longEdge.winRate * 100).toFixed(1)),
          ev: parseFloat(adaptive.longEdge.ev.toFixed(4)),
          priorityScore: parseFloat(adaptive.longEdge.priorityScore.toFixed(4)),
          toxicityScore: parseFloat(adaptive.longEdge.toxicityScore.toFixed(4)),
        },
        short: {
          samples: adaptive.shortEdge.samples,
          ewmaWinRate: parseFloat((adaptive.shortEdge.winRate * 100).toFixed(1)),
          ev: parseFloat(adaptive.shortEdge.ev.toFixed(4)),
          priorityScore: parseFloat(adaptive.shortEdge.priorityScore.toFixed(4)),
          toxicityScore: parseFloat(adaptive.shortEdge.toxicityScore.toFixed(4)),
        },
        symbol: adaptive.symbolProfile
          ? {
              totalSamples: adaptive.symbolProfile.totalSamples,
              netPnl: parseFloat(adaptive.symbolProfile.netPnl.toFixed(4)),
              winRate: parseFloat((adaptive.symbolProfile.winRate * 100).toFixed(1)),
              profitFactor: parseFloat(adaptive.symbolProfile.profitFactor.toFixed(2)),
              isToxic: adaptive.symbolProfile.isToxic,
              bestHour: adaptive.symbolProfile.bestHour,
              worstHour: adaptive.symbolProfile.worstHour,
            }
          : null,
      },
      // ── Combined edge (market × telemetry fusion) ─────────────────────────
      combined: {
        longScore:  parseFloat(longCombined.toFixed(6)),
        shortScore: parseFloat(shortCombined.toFixed(6)),
        bestSide,
        // ATR-driven dynamic TP/SL suggestion (% of price)
        atrTpSuggestionPct: atrTpSuggestion,
        atrSlSuggestionPct: atrSlSuggestion,
      },
    };
  });

  // Sort by max(longCombined, shortCombined) descending — best edge first
  edgeSymbols.sort((a, b) =>
    Math.max(b.combined.longScore, b.combined.shortScore) -
    Math.max(a.combined.longScore, a.combined.shortScore),
  );

  res.json({
    edgeTime: Date.now(),
    btcRegime,
    btcChangePct,
    currentHourUtc,
    interval: safeInterval,
    totalSymbols: symbols.length,
    globalTelemetry: (() => {
      const g = engine.globalState();
      return {
        totalTrades: g.totalTrades,
        ewmaWinRate: parseFloat((g.ewmaWinRate * 100).toFixed(1)),
        ewmaEv: parseFloat(g.ewmaEv.toFixed(4)),
        ewmaFeePerTrade: parseFloat(g.ewmaFeePerTrade.toFixed(4)),
      };
    })(),
    gateRecommendation: engine.gateRecommendation(),
    symbols: edgeSymbols,
  });
});

/** GET /api/bot/intelligence - consolidated operational view of Quant Brain. */
router.get("/bot/intelligence", async (req: Request, res: Response) => {
  const config = getBotConfig();
  const source = normalizeTelemetrySource(req.query.source);
  const engine = getTelemetryEngineForSource(source);
  const requestedSymbol = String(req.query.symbol ?? config.allowedSymbols[0] ?? "BTC-USDT").toUpperCase();
  const symbol = requestedSymbol.endsWith("-USDT") ? requestedSymbol : `${requestedSymbol}-USDT`;
  const positionSide: PositionSide = String(req.query.side ?? "LONG").toUpperCase() === "SHORT"
    ? "SHORT"
    : "LONG";
  const btcChangePct = Number(req.query.btcChangePct ?? 0);
  const btcRegime: BtcRegime =
    btcChangePct >= config.btcRegimeThresholdPct ? "BULL" :
    btcChangePct <= -config.btcRegimeThresholdPct ? "BEAR" : "NEUTRAL";
  const hourUtc = new Date().getUTCHours();
  const clusterKey: ClusterKey = { symbol, positionSide, hourUtc, btcRegime };
  const cluster = engine.clusterProfile(clusterKey);
  const symbolProfile = engine.symbolProfile(symbol);
  const context = engine.contextSignal(clusterKey);

  const intelligence = await getQuantBrainIntelligence({
    symbol,
    side: positionSide === "LONG" ? "BUY" : "SELL",
    positionSide,
    hourUtc,
    btcChangePct,
    currentEv: cluster?.ev ?? symbolProfile?.ev ?? 0,
    currentWinRate: cluster?.ewmaWinRate ?? symbolProfile?.winRate ?? 0.5,
    currentProfitFactor: cluster?.profitFactor ?? symbolProfile?.profitFactor ?? 0,
    config,
  });

  res.json({
    symbol,
    positionSide,
    btcRegime,
    hourUtc,
    symbols: config.allowedSymbols,
    executionEnabled: config.allowExecution,
    telemetrySource: source,
    telemetry: {
      samples: context.samples,
      priorityScore: context.priorityScore,
      toxicityScore: context.toxicityScore,
      ev: cluster?.ev ?? symbolProfile?.ev ?? 0,
      winRate: cluster?.ewmaWinRate ?? symbolProfile?.winRate ?? 0.5,
      profitFactor: cluster?.profitFactor ?? symbolProfile?.profitFactor ?? 0,
      netPnl: symbolProfile?.netPnl ?? 0,
      isToxic: symbolProfile?.isToxic ?? false,
    },
    quantBrain: intelligence,
  });
});

// ── Bot Modes ─────────────────────────────────────────────────────────────────

/** GET /api/bot/modes — list all available mode presets */
router.get("/bot/modes", (_req: Request, res: Response) => {
  res.json({
    modes: Object.values(BOT_MODES),
    activeMode: getActiveModeId(),
  });
});

/** POST /api/bot/mode — activate a mode (applies runtime overrides) */
router.post("/bot/mode", (req: Request, res: Response) => {
  const { mode } = req.body as { mode: string };
  if (!mode || !(mode in BOT_MODES)) {
    res.status(400).json({
      error: `Unknown mode: "${mode}". Valid: ${Object.keys(BOT_MODES).join(", ")}`,
    });
    return;
  }
  const id = mode as BotModeId;
  const preset = BOT_MODES[id];
  setActiveModeId(id);
  setConfigOverrides({
    leverage: preset.leverage,
    marginPerTrade: preset.marginPerTrade,
    marginType: preset.marginType,
  });
  req.log.info({ mode: id, preset }, "bot mode activated");
  res.json({ activeMode: id, preset, config: getBotConfig() });
});

/** POST /api/bot/mode/reset — clear active mode and related overrides */
router.post("/bot/mode/reset", (_req: Request, res: Response) => {
  clearActiveMode();
  resetConfigOverrides();
  res.json({ activeMode: null, config: getBotConfig() });
});

// ── Shared order executor (gate checks + BingX call) ─────────────────────────

async function executeSingleOrder(
  item: BulkOrderItem,
  index: number,
  creds: { apiKey: string; secretKey: string },
  config: ReturnType<typeof getBotConfig>,
  preGateRejects: string[] = [],
): Promise<BulkOrderResult> {
  const t0 = Date.now();
  const { symbol, side, positionSide, btcChangePct } = item;
  const gateRejects: string[] = [...preGateRejects];
  const currentHour = new Date().getUTCHours();

  // Gate: symbol allowlist
  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(symbol)) {
    gateRejects.push(`SYMBOL_REJECT: ${symbol} not in allowlist`);
  }
  // Gate: hour blacklist
  if (config.hourBlacklist.includes(currentHour)) {
    gateRejects.push(`HOUR_REJECT: UTC hour ${currentHour} is blacklisted`);
  }
  // Gate: BTC regime
  if (config.btcRegimeRequired && btcChangePct !== undefined) {
    const abs = Math.abs(btcChangePct);
    if (abs < config.btcRegimeThresholdPct) {
      gateRejects.push(`REGIME_REJECT: BTC ${btcChangePct.toFixed(2)}% < ±${config.btcRegimeThresholdPct}%`);
    } else {
      const btcBull = btcChangePct > 0;
      const wantLong = positionSide === "LONG";
      if (!config.allowCounterRegimeScalp && btcBull !== wantLong) {
        gateRejects.push(`REGIME_DIRECTION: BTC ${btcBull ? "BULL" : "BEAR"} but entry is ${positionSide}`);
      }
    }
  }

  const feeDragReject = feeDragRejectReason(item.currentEv, config.marginPerTrade, config);
  if (feeDragReject) {
    gateRejects.push(feeDragReject);
  }

  // Observation mode short-circuit
  if (!config.allowExecution) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: null, gateRejects, observationMode: true,
      message: gateRejects.length > 0
        ? `BLOCKED by ${gateRejects.length} gate(s). Observation mode.`
        : "All gates pass. Observation mode — set SCALP_ALLOW_EXECUTION=true.",
      durationMs: Date.now() - t0,
    };
  }

  // Gate blocked
  if (gateRejects.length > 0) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: null, gateRejects, observationMode: false,
      message: `REJECTED: ${gateRejects[0]}`,
      durationMs: Date.now() - t0,
    };
  }

  // Compute qty from mark price
  let qty = item.quantity;
  if (!qty) {
    try {
      const url = `${BINGX_BASE}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}&timestamp=${Date.now()}`;
      const json = (await (await fetch(url)).json()) as Record<string, unknown>;
      if (json.code === 0) {
        const d = (json.data as Record<string, string>) ?? {};
        const markPrice = parseFloat(d.lastPrice ?? "0");
        if (markPrice > 0) qty = Math.floor((config.marginPerTrade * config.leverage) / markPrice * 1000) / 1000;
      }
    } catch { /* fallthrough */ }
  }

  if (!qty || qty <= 0) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: null, gateRejects: ["QTY_REJECT: could not compute quantity"],
      observationMode: false,
      message: "Could not determine order quantity.",
      durationMs: Date.now() - t0,
    };
  }

  // Place order
  try {
    const data = await bingxPost(
      "/openApi/swap/v2/trade/order",
      { symbol, side, positionSide, type: config.orderType, quantity: qty, leverage: config.leverage },
      creds.apiKey, creds.secretKey,
    );
    if (data.code !== 0) {
      return {
        index, symbol, side, placed: false, orderId: null,
        quantity: qty, gateRejects: [], observationMode: false,
        message: `BingX error: ${(data.msg as string) ?? "unknown"}`,
        durationMs: Date.now() - t0,
      };
    }
    const order = ((data.data as Record<string, unknown>)?.order ?? {}) as Record<string, unknown>;
    return {
      index, symbol, side, placed: true, orderId: String(order.orderId ?? ""),
      quantity: qty, gateRejects: [], observationMode: false,
      message: `Placed: ${side} ${qty} ${symbol}`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      index, symbol, side, placed: false, orderId: null,
      quantity: qty, gateRejects: [], observationMode: false,
      message: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t0,
    };
  }
}

/** POST /api/bot/order/bulk — rate-limited bulk execution for Aggressive mode
 *
 *  Accepts up to 50 orders in one request, executes them sequentially through
 *  a token-bucket rate limiter so BingX's 10 orders/second cap is respected.
 *  Each order runs through the full gate pipeline before hitting the exchange.
 */
router.post("/bot/order/bulk", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected." });
    return;
  }

  const { orders, ordersPerSecond = 10 } = req.body as {
    orders: BulkOrderItem[];
    ordersPerSecond?: number;
  };

  if (!Array.isArray(orders) || orders.length === 0) {
    res.status(400).json({ error: "orders must be a non-empty array" });
    return;
  }
  if (orders.length > 50) {
    res.status(400).json({ error: "Max 50 orders per bulk request" });
    return;
  }

  const rps = Math.min(Math.max(1, ordersPerSecond), 10); // clamp 1–10
  const bucket = new TokenBucket(rps, rps);
  const config = getBotConfig();
  const activeMode = getActiveModeId();
  const t0 = Date.now();
  const results: BulkOrderResult[] = [];
  const correlationRejects = buildBulkCorrelationRejects(orders, maxCorrelatedBulkOrders());

  req.log.info({ count: orders.length, rps, activeMode, correlationRejected: correlationRejects.size }, "bulk execution started");

  for (let i = 0; i < orders.length; i++) {
    await bucket.consume(); // respect rate limit
    const result = await executeSingleOrder(orders[i], i, creds, config, correlationRejects.get(i) ?? []);
    results.push(result);
  }

  const placed = results.filter((r) => r.placed).length;
  const summary: BulkExecutionSummary = {
    mode: activeMode ?? "aggressive",
    total: orders.length,
    placed,
    rejected: orders.length - placed,
    observationMode: !config.allowExecution,
    durationMs: Date.now() - t0,
    results,
  };

  req.log.info({ placed, total: orders.length, durationMs: summary.durationMs }, "bulk execution complete");
  res.json(summary);
});

export default router;
