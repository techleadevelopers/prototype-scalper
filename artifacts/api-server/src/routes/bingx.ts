import { Router } from "express";
import { createHmac } from "crypto";
import type { Request, Response } from "express";
import {
  createExecutionCredentials,
  credentialFingerprint,
  endpointForCredentials,
  isLiveExecutionConfigured,
  type ExecutionCredentials,
} from "../lib/executionSecurity";

const router = Router();

declare module "express-session" {
  interface SessionData {
    liveCredentials?: ExecutionCredentials;
  }
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
  baseUrl: string,
) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${baseUrl}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    headers: { "X-BX-APIKEY": apiKey },
  });
  return res.json() as Promise<Record<string, unknown>>;
}

function getCredentials(req: Request): ExecutionCredentials | null {
  return req.session.liveCredentials ?? null;
}

router.get("/bingx/market/ticker", async (req: Request, res: Response) => {
  const symbol = (req.query.symbol as string) ?? "BTC-USDT";
  try {
    const timestamp = Date.now();
    const url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}&timestamp=${timestamp}`;
    const data = (await (await fetch(url)).json()) as Record<string, unknown>;
    if (data.code !== 0) {
      res.status(500).json({ error: (data.msg as string) ?? "BingX API error" });
      return;
    }
    const t = data.data as Record<string, string>;
    res.json({
      symbol: t.symbol ?? symbol,
      lastPrice: t.lastPrice ?? "0",
      priceChange: t.priceChange ?? "0",
      priceChangePercent: t.priceChangePercent ?? "0",
      highPrice: t.highPrice ?? "0",
      lowPrice: t.lowPrice ?? "0",
      volume: t.volume ?? "0",
      quoteVolume: t.quoteVolume ?? "0",
    });
  } catch (err) {
    req.log.error({ err }, "BingX ticker error");
    res.status(500).json({ error: "Failed to fetch ticker" });
  }
});

router.post("/bingx/connect", async (req: Request, res: Response) => {
  const { apiKey, secretKey, environment, accountId } = req.body as {
    apiKey?: string;
    secretKey?: string;
    environment?: string;
    accountId?: string;
  };
  if (!apiKey || !secretKey || (environment && environment !== "live")) {
    res.status(400).json({ error: 'apiKey and secretKey are required; environment must be "live" when provided.' });
    return;
  }
  try {
    // Connecting only verifies credentials and creates a browser session.
    // Real-money order routes independently enforce the live deployment,
    // configured account identity, and execution confirmation.
    const resolvedAccountId = accountId?.trim() || `session-${credentialFingerprint(apiKey)}`;
    if (isLiveExecutionConfigured() && resolvedAccountId !== process.env.LIVE_ACCOUNT_ID?.trim()) {
      res.status(403).json({ error: "Live credentials must declare the approved LIVE_ACCOUNT_ID." });
      return;
    }
    const credentials = createExecutionCredentials({
      environment: "live",
      accountId: resolvedAccountId,
      apiKey,
      secretKey,
      source: "live-connect",
    });
    const baseUrl = endpointForCredentials(credentials, "live");
    const data = await bingxGet("/openApi/swap/v2/user/balance", {}, apiKey, secretKey, baseUrl);
    if (data.code !== 0) {
      res.status(401).json({ error: (data.msg as string) ?? "Invalid credentials" });
      return;
    }
    req.session.liveCredentials = credentials;
    res.json({
      connected: true,
      accountId: credentials.accountId,
      environment: credentials.environment,
      credentialFingerprint: credentials.fingerprint,
    });
  } catch (err) {
    req.log.error({ err }, "BingX connect error");
    res.status(500).json({ error: "Failed to connect to BingX" });
  }
});

router.post("/bingx/disconnect", (req: Request, res: Response) => {
  req.session.liveCredentials = undefined;
  res.json({ disconnected: true });
});

router.get("/bingx/balance", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected. Please provide your API credentials." });
    return;
  }
  try {
    const data = await bingxGet("/openApi/swap/v2/user/balance", {}, creds.apiKey, creds.secretKey, endpointForCredentials(creds, "live"));
    if (data.code !== 0) {
      res.status(401).json({ error: (data.msg as string) ?? "BingX API error" });
      return;
    }
    const bal = (data.data as Record<string, unknown>)?.balance as Record<string, string>;
    res.json({
      totalWalletBalance: bal?.balance ?? "0",
      totalUnrealizedProfit: bal?.unrealizedProfit ?? "0",
      totalMarginBalance: bal?.equity ?? "0",
      availableBalance: bal?.availableMargin ?? "0",
      totalPositionInitialMargin: bal?.usedMargin ?? "0",
      currency: "USDT",
    });
  } catch (err) {
    req.log.error({ err }, "BingX balance error");
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

router.get("/bingx/positions", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected. Please provide your API credentials." });
    return;
  }
  try {
    const data = await bingxGet(
      "/openApi/swap/v2/user/positions",
      {},
      creds.apiKey,
      creds.secretKey,
      endpointForCredentials(creds, "live"),
    );
    if (data.code !== 0) {
      res.status(401).json({ error: (data.msg as string) ?? "BingX API error" });
      return;
    }
    const positions = ((data.data as unknown[]) ?? []) as Record<string, unknown>[];
    const mapped = positions
      .filter((p) => parseFloat(String(p.positionAmt ?? "0")) !== 0)
      .map((p) => ({
        symbol: p.symbol,
        positionSide: p.positionSide,
        positionAmt: String(p.positionAmt ?? "0"),
        entryPrice: String(p.avgPrice ?? "0"),
        markPrice: String(p.markPrice ?? "0"),
        unrealizedProfit: String(p.unrealizedProfit ?? "0"),
        liquidationPrice: String(p.liquidationPrice ?? "0"),
        leverage: String(p.leverage ?? "1"),
        marginType: String(p.marginType ?? "cross"),
        initialMargin: String(p.initialMargin ?? "0"),
      }));
    res.json(mapped);
  } catch (err) {
    req.log.error({ err }, "BingX positions error");
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

router.get("/bingx/orders", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Not connected. Please provide your API credentials." });
    return;
  }
  const symbol = req.query.symbol as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  try {
    const params: Record<string, string | number | undefined> = { limit };
    if (symbol) params.symbol = symbol;
    const data = await bingxGet(
      "/openApi/swap/v2/trade/allOrders",
      params,
      creds.apiKey,
      creds.secretKey,
      endpointForCredentials(creds, "live"),
    );
    if (data.code !== 0) {
      res.status(401).json({ error: (data.msg as string) ?? "BingX API error" });
      return;
    }
    const orders = ((data.data as Record<string, unknown>)?.orders as unknown[]) ?? [];
    const mapped = (orders as Record<string, unknown>[]).map((o) => ({
      orderId: String(o.orderId ?? ""),
      symbol: String(o.symbol ?? ""),
      side: String(o.side ?? ""),
      positionSide: String(o.positionSide ?? ""),
      type: String(o.type ?? ""),
      origQty: String(o.origQty ?? "0"),
      price: String(o.price ?? "0"),
      avgPrice: String(o.avgPrice ?? "0"),
      stopPrice: o.stopPrice ? String(o.stopPrice) : null,
      status: String(o.status ?? ""),
      time: Number(o.time ?? 0),
      profit: o.profit ? String(o.profit) : null,
      commission: o.commission ? String(o.commission) : null,
    }));
    res.json(mapped);
  } catch (err) {
    req.log.error({ err }, "BingX orders error");
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

router.get("/bingx/summary", async (req: Request, res: Response) => {
  const creds = getCredentials(req);
  if (!creds) {
    res.json({
      connected: false,
      totalBalance: "0",
      availableBalance: "0",
      totalUnrealizedPnl: "0",
      recentRealizedPnl: "0",
      lastRealizedPnl: "0",
      openPositionsCount: 0,
      totalMarginUsed: "0",
      currency: "USDT",
    });
    return;
  }
  try {
    const [balData, posData, orderData] = await Promise.all([
      bingxGet("/openApi/swap/v2/user/balance", {}, creds.apiKey, creds.secretKey, endpointForCredentials(creds, "live")),
      bingxGet("/openApi/swap/v2/user/positions", {}, creds.apiKey, creds.secretKey, endpointForCredentials(creds, "live")),
      bingxGet("/openApi/swap/v2/trade/allOrders", { limit: 50 }, creds.apiKey, creds.secretKey, endpointForCredentials(creds, "live")),
    ]);

    const bal = (balData.code === 0
      ? ((balData.data as Record<string, unknown>)?.balance as Record<string, string>)
      : null) ?? {};

    const positions =
      posData.code === 0
        ? ((posData.data as unknown[]) ?? []) as Record<string, unknown>[]
        : [];

    const openPositions = positions.filter(
      (p) => parseFloat(String(p.positionAmt ?? "0")) !== 0,
    );

    const totalUnrealizedPnl = openPositions.reduce(
      (sum, p) => sum + parseFloat(String(p.unrealizedProfit ?? "0")),
      0,
    );

    const orders =
      orderData.code === 0
        ? (((orderData.data as Record<string, unknown>)?.orders as unknown[]) ?? []) as Record<string, unknown>[]
        : [];
    const filledOrders = orders
      .filter((order) => String(order.status ?? "").toUpperCase() === "FILLED")
      .sort((a, b) => Number(b.time ?? 0) - Number(a.time ?? 0));
    const realizedOrders = filledOrders
      .map((order) => Number(order.profit ?? "0"))
      .filter((profit) => Number.isFinite(profit) && profit !== 0);
    const recentRealizedPnl = realizedOrders.reduce((sum, profit) => sum + profit, 0);
    const lastRealizedPnl = realizedOrders[0] ?? 0;

    res.json({
      connected: true,
      totalBalance: bal.balance ?? "0",
      availableBalance: bal.availableMargin ?? "0",
      totalUnrealizedPnl: totalUnrealizedPnl.toFixed(4),
      recentRealizedPnl: recentRealizedPnl.toFixed(4),
      lastRealizedPnl: lastRealizedPnl.toFixed(4),
      openPositionsCount: openPositions.length,
      totalMarginUsed: bal.usedMargin ?? "0",
      currency: "USDT",
    });
  } catch (err) {
    req.log.error({ err }, "BingX summary error");
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

export default router;
