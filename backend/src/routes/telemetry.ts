import { Router } from "express";
import type { Request, Response } from "express";
import {
  getEngine,
  recordTradeOutcome,
  exportAllOutcomes,
  tradeCount,
} from "../lib/telemetryStore";
import { getQuantBrainRecentTrades, getQuantBrainTradeSummary, syncQuantBrainOutcome } from "../lib/quantBrainClient";
import { AdaptiveEngine } from "../lib/adaptiveEngine";
import type { BtcRegime, ExitReason, PositionSide, TradeOutcome } from "../lib/adaptiveEngine";

const router = Router();

type TelemetrySourceFilter = "all" | "demo" | "live";

function normalizeTelemetrySource(value: unknown): TelemetrySourceFilter {
  const raw = String(value ?? "all").trim().toLowerCase();
  return raw === "demo" || raw === "live" ? raw : "all";
}

function outcomeMatchesSource(outcome: TradeOutcome, source: TelemetrySourceFilter): boolean {
  if (source === "all") return true;
  const isDemo = outcome.isDemo === true || outcome.source === "bingx-vst";
  return source === "demo" ? isDemo : !isDemo;
}

function emptyGateRecommendation() {
  return {
    evMinThreshold: 0,
    winRateMin: 0,
    profitFactorMin: 0,
    toxicSymbols: [] as string[],
    toxicHours: [] as number[],
    confidence: "INSUFFICIENT_DATA" as const,
    basedOnSamples: 0,
    lastCalibrated: Date.now(),
  };
}

function mergeOutcomes(primary: TradeOutcome[], secondary: TradeOutcome[]): TradeOutcome[] {
  const byId = new Map<string, TradeOutcome>();
  for (const outcome of [...primary, ...secondary]) {
    const key = outcome.id || `${outcome.source ?? "unknown"}-${outcome.symbol}-${outcome.positionSide}-${outcome.exitTime}`;
    if (!byId.has(key)) byId.set(key, outcome);
  }
  return Array.from(byId.values()).sort((a, b) => b.exitTime - a.exitTime);
}

export async function buildTelemetryState(source: TelemetrySourceFilter = "all") {
  const engine = getEngine();
  const [quantTradeSummary, quantRecentTrades] = await Promise.all([
    getQuantBrainTradeSummary(),
    getQuantBrainRecentTrades(source, 500),
  ]);
  const localOutcomes = engine.rawOutcomes()
    .slice()
    .sort((a, b) => b.exitTime - a.exitTime)
    .filter((outcome) => outcomeMatchesSource(outcome, source));
  const outcomes = mergeOutcomes(
    localOutcomes,
    quantRecentTrades.filter((outcome) => outcomeMatchesSource(outcome, source)),
  );
  const recentOutcomes = outcomes.slice(0, 500);

  if (source === "all") {
    const global = engine.globalState();
    return {
      source,
      totalTrades: global.totalTrades,
      ewmaWinRate: global.ewmaWinRate,
      ewmaEv: global.ewmaEv,
      ewmaFeePerTrade: global.ewmaFeePerTrade,
      symbolProfiles: engine.allSymbolProfiles(),
      clusterProfiles: engine.allClusterProfiles(),
      hourProfile: engine.hourProfile(),
      gateRecommendation: engine.gateRecommendation(),
      recentOutcomes,
      quantTradeSummary,
    };
  }

  if (outcomes.length === 0) {
    return {
      source,
      totalTrades: 0,
      ewmaWinRate: 0,
      ewmaEv: 0,
      ewmaFeePerTrade: 0,
      symbolProfiles: [],
      clusterProfiles: [],
      hourProfile: [],
      gateRecommendation: emptyGateRecommendation(),
      recentOutcomes,
      quantTradeSummary,
    };
  }

  const scopedEngine = new AdaptiveEngine(outcomes);
  scopedEngine.stopAutoSave();
  const scopedGlobal = scopedEngine.globalState();
  return {
    source,
    totalTrades: scopedGlobal.totalTrades,
    ewmaWinRate: scopedGlobal.ewmaWinRate,
    ewmaEv: scopedGlobal.ewmaEv,
    ewmaFeePerTrade: scopedGlobal.ewmaFeePerTrade,
    symbolProfiles: scopedEngine.allSymbolProfiles(),
    clusterProfiles: scopedEngine.allClusterProfiles(),
    hourProfile: scopedEngine.hourProfile(),
    gateRecommendation: scopedEngine.gateRecommendation(),
    recentOutcomes,
    quantTradeSummary,
  };
}

/** GET /api/telemetry/state — full adaptive engine state for dashboard */
router.get("/telemetry/state", async (req: Request, res: Response) => {
  res.json(await buildTelemetryState(normalizeTelemetrySource(req.query.source)));
});

/** GET /api/telemetry/recommendation — adaptive gate recommendation only */
router.get("/telemetry/recommendation", (_req: Request, res: Response) => {
  res.json(getEngine().gateRecommendation());
});

/** POST /api/telemetry/outcome — record a realized trade outcome */
router.post("/telemetry/outcome", (req: Request, res: Response) => {
  const body = req.body as {
    id?: string;
    symbol: string;
    positionSide: PositionSide;
    side: "BUY" | "SELL";
    entryTime: number;
    exitTime: number;
    hourUtc?: number;
    btcRegime: BtcRegime;
    entryPrice: number;
    exitPrice: number;
    qty: number;
    leverage: number;
    marginUsed: number;
    grossPnl: number;
    fee: number;
    realizedPnl: number;
    exitReason: ExitReason;
    expectedTpProfit: number;
  };

  if (!body.symbol || body.entryPrice == null || body.exitPrice == null || body.realizedPnl == null) {
    res.status(400).json({ error: "symbol, entryPrice, exitPrice, realizedPnl are required" });
    return;
  }

  try {
    const outcome = recordTradeOutcome({
      ...body,
      hourUtc: body.hourUtc ?? new Date(body.entryTime).getUTCHours(),
    });
    void syncQuantBrainOutcome(outcome).then((result) => {
      if (!result.synced && result.error !== "missing QUANT_BRAIN_URL") {
        req.log.warn({ error: result.error, outcomeId: outcome.id }, "quant brain sync skipped");
      }
    });
    req.log.info({ symbol: outcome.symbol, pnl: outcome.realizedPnl, side: outcome.positionSide }, "telemetry outcome recorded");
    res.json({ recorded: true, id: outcome.id, totalTrades: tradeCount() });
  } catch (err) {
    req.log.error({ err }, "telemetry record error");
    res.status(500).json({ error: "Failed to record outcome" });
  }
});

/**
 * GET /api/telemetry/context — ContextSignal for a specific cluster.
 * Equivalent to adaptive_policy.context_signal(router, hour_utc) in Rust.
 * Frontend sends this before each potential entry to get priority/toxicity scores.
 */
router.get("/telemetry/context", (req: Request, res: Response) => {
  const { symbol, positionSide, hourUtc, btcRegime } = req.query as {
    symbol: string;
    positionSide: string;
    hourUtc: string;
    btcRegime: string;
  };
  if (!symbol || !positionSide || hourUtc == null || !btcRegime) {
    res.status(400).json({ error: "symbol, positionSide, hourUtc, btcRegime are required" });
    return;
  }
  const signal = getEngine().contextSignal({
    symbol,
    positionSide: positionSide as PositionSide,
    hourUtc: parseInt(hourUtc, 10),
    btcRegime: btcRegime as BtcRegime,
  });
  res.json(signal);
});

/** GET /api/telemetry/rank — ranking score for a pending entry */
router.get("/telemetry/rank", (req: Request, res: Response) => {
  const { symbol, positionSide, hourUtc, btcRegime, currentEv } = req.query as Record<string, string>;
  if (!symbol || !positionSide || hourUtc == null || !btcRegime || currentEv == null) {
    res.status(400).json({ error: "symbol, positionSide, hourUtc, btcRegime, currentEv are required" });
    return;
  }
  const score = getEngine().rankingScore(
    { symbol, positionSide: positionSide as PositionSide, hourUtc: parseInt(hourUtc, 10), btcRegime: btcRegime as BtcRegime },
    parseFloat(currentEv),
  );
  const signal = getEngine().contextSignal({
    symbol,
    positionSide: positionSide as PositionSide,
    hourUtc: parseInt(hourUtc, 10),
    btcRegime: btcRegime as BtcRegime,
  });
  res.json({ rankingScore: score, ...signal });
});

/** GET /api/telemetry/export — raw JSONL export of all outcomes */
router.get("/telemetry/export", async (_req: Request, res: Response) => {
  const [localOutcomes, quantRecentTrades] = await Promise.all([
    Promise.resolve(exportAllOutcomes()),
    getQuantBrainRecentTrades("all", 2_000),
  ]);
  res.json(mergeOutcomes(localOutcomes, quantRecentTrades));
});

export default router;
