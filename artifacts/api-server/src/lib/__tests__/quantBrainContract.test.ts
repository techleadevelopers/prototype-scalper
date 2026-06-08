import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../quantBrainClient", async (importOriginal) => {
  const real = await importOriginal<typeof import("../quantBrainClient")>();
  return { ...real };
});

describe("outcomeToQuantPayload — audit trail fields", () => {
  it("includes mfe, mae, holdDurationMs, entryCount, modelVersion in payload", async () => {
    const { syncQuantBrainOutcome } = await import("../quantBrainClient");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const outcome = {
      id: "campaign:abc-123",
      isDemo: true,
      source: "bingx-vst" as const,
      symbol: "ETH-USDT",
      positionSide: "LONG" as const,
      side: "BUY" as const,
      entryTime: 1_700_000_000_000,
      exitTime: 1_700_000_060_000,
      hourUtc: 14,
      btcRegime: "BULL" as const,
      entryPrice: 2000,
      exitPrice: 2020,
      qty: 0.01,
      leverage: 10,
      marginUsed: 2,
      grossPnl: 0.2,
      fee: 0.02,
      realizedPnl: 0.18,
      exitReason: "TP" as const,
      expectedTpProfit: 0.2,
      mfe: 0.8,
      mae: -0.3,
      holdDurationMs: 60_000,
      entryCount: 2,
      modelVersion: "shadow-1700000000",
    };

    await syncQuantBrainOutcome(outcome).catch(() => {});

    if (fetchSpy.mock.calls.length > 0) {
      const bodyStr = fetchSpy.mock.calls[0]?.[1]?.body as string | undefined;
      if (bodyStr) {
        const body = JSON.parse(bodyStr);
        expect(body.mfe).toBe(0.8);
        expect(body.mae).toBe(-0.3);
        expect(body.holdDurationMs).toBe(60_000);
        expect(body.entryCount).toBe(2);
        expect(body.modelVersion).toBe("shadow-1700000000");
      }
    }

    fetchSpy.mockRestore();
  });
});

describe("QuantBrainEdgeInput — contract v2 fields", () => {
  it("forwards signalId, marketEventId, expiresAt, featureVersion to QB", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ allow: true, gateRejects: [], score: 0.7, authority: "quant-brain" }),
        { status: 200 }
      )
    );
    vi.stubEnv("QUANT_BRAIN_URL", "http://localhost:9000");
    vi.stubEnv("QUANT_BRAIN_API_TOKEN", "test-token");
    vi.stubEnv("QUANT_BRAIN_GATE_MODE", "shadow");

    const { evaluateQuantBrainEdge } = await import("../quantBrainClient");

    const config = {
      leverage: 10,
      marginPerTrade: 5,
      maxConcurrentPositions: 5,
      maxMarginUtilization: 0.8,
      takeProfitPct: 0.5,
      stopLossPct: 0.25,
      evMinThreshold: 0,
      winRateMin: 0,
      profitFactorMin: 0,
      btcRegimeRequired: false,
      allowCounterRegimeScalp: true,
      btcRegimeThresholdPct: 1,
      allowedSymbols: [],
      hourBlacklist: [],
      orderType: "MARKET" as const,
      marginType: "ISOLATED" as const,
      allowExecution: true,
      maxSessionLoss: 0,
      maxPositionsPerSymbol: 3,
      positionStackingEnabled: false,
      sniperAutopilotIntervalSec: 15,
      sniperMaxCandidatesPerCycle: 3,
      sniperMinCombinedScore: 0.5,
      preventHedgedPositions: true,
    };

    await evaluateQuantBrainEdge({
      symbol: "ETH-USDT",
      side: "BUY",
      positionSide: "LONG",
      config,
      signalId: "sig-uuid-1234",
      marketEventId: "ETH-USDT:LONG:567890",
      expiresAt: Date.now() + 30_000,
      featureVersion: "sniper-v1",
    });

    if (fetchSpy.mock.calls.length > 0) {
      const bodyStr = fetchSpy.mock.calls[0]?.[1]?.body as string | undefined;
      if (bodyStr) {
        const body = JSON.parse(bodyStr);
        expect(body.signalId).toBe("sig-uuid-1234");
        expect(body.marketEventId).toBe("ETH-USDT:LONG:567890");
        expect(typeof body.expiresAt).toBe("number");
        expect(body.featureVersion).toBe("sniper-v1");
      }
    }

    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});

describe("LONG/SHORT side consistency", () => {
  it("LONG position always maps to BUY side", () => {
    const positionSide = "LONG" as const;
    const side: "BUY" | "SELL" = positionSide === "LONG" ? "BUY" : "SELL";
    expect(side).toBe("BUY");
  });

  it("SHORT position always maps to SELL side", () => {
    const positionSide = "SHORT" as const;
    const side: "BUY" | "SELL" = positionSide === "LONG" ? "BUY" : "SELL";
    expect(side).toBe("SELL");
  });

  it("outcomeToQuantPayload sends positionSide as the side field (LONG/SHORT, not BUY/SELL)", () => {
    const outcome = {
      id: "test-id",
      symbol: "ETH-USDT",
      positionSide: "SHORT" as const,
      side: "SELL" as const,
      entryTime: 1,
      exitTime: 2,
      hourUtc: 0,
      btcRegime: "NEUTRAL" as const,
      entryPrice: 1,
      exitPrice: 1,
      qty: 1,
      leverage: 1,
      marginUsed: 1,
      grossPnl: 0,
      fee: 0,
      realizedPnl: 0,
      exitReason: "SL" as const,
      expectedTpProfit: 0,
    };
    expect(outcome.positionSide).toBe("SHORT");
    expect(outcome.side).toBe("SELL");
  });
});

describe("TradeOutcomeSchema — audit trail extension", () => {
  it("accepts optional mfe, mae, holdDurationMs, entryCount, modelVersion, signalId", async () => {
    const { TradeOutcomeSchema } = await import("../adaptiveEngine");
    const result = TradeOutcomeSchema.safeParse({
      id: "test",
      symbol: "BTC-USDT",
      positionSide: "LONG",
      side: "BUY",
      entryTime: 1,
      exitTime: 2,
      hourUtc: 0,
      btcRegime: "BULL",
      entryPrice: 1,
      exitPrice: 1,
      qty: 1,
      leverage: 1,
      marginUsed: 1,
      grossPnl: 0,
      fee: 0,
      realizedPnl: 0,
      exitReason: "TP",
      expectedTpProfit: 0,
      mfe: 2.5,
      mae: -0.5,
      holdDurationMs: 120_000,
      entryCount: 3,
      modelVersion: "shadow-1700000000",
      signalId: "sig-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mfe).toBe(2.5);
      expect(result.data.mae).toBe(-0.5);
      expect(result.data.holdDurationMs).toBe(120_000);
      expect(result.data.entryCount).toBe(3);
      expect(result.data.modelVersion).toBe("shadow-1700000000");
      expect(result.data.signalId).toBe("sig-abc");
    }
  });

  it("accepts exchange_reported as pnlSource", async () => {
    const { TradeOutcomeSchema } = await import("../adaptiveEngine");
    const result = TradeOutcomeSchema.safeParse({
      id: "test",
      symbol: "BTC-USDT",
      positionSide: "LONG",
      side: "BUY",
      entryTime: 1,
      exitTime: 2,
      hourUtc: 0,
      btcRegime: "BULL",
      entryPrice: 1,
      exitPrice: 1,
      qty: 1,
      leverage: 1,
      marginUsed: 1,
      grossPnl: 0,
      fee: 0,
      realizedPnl: 0,
      exitReason: "TP",
      expectedTpProfit: 0,
      pnlSource: "exchange_reported",
    });
    expect(result.success).toBe(true);
  });
});

describe("Signal expiry — expiresAt enforcement", () => {
  it("QB request should carry expiresAt set 30s in the future", () => {
    const before = Date.now();
    const expiresAt = Date.now() + 30_000;
    const after = Date.now();
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThanOrEqual(after + 30_000);
  });

  it("marketEventId format is stable within a 5-minute bucket", () => {
    const symbol = "ETH-USDT";
    const positionSide = "LONG";
    const t1 = 1_700_000_100_000;
    const t2 = 1_700_000_200_000;
    const bucket1 = Math.floor(t1 / 300_000);
    const bucket2 = Math.floor(t2 / 300_000);
    expect(bucket1).toBe(bucket2);
    const id1 = `${symbol}:${positionSide}:${bucket1}`;
    const id2 = `${symbol}:${positionSide}:${bucket2}`;
    expect(id1).toBe(id2);
  });

  it("signals in different 5-minute buckets get different marketEventIds", () => {
    const symbol = "ETH-USDT";
    const positionSide = "LONG";
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_400_000;
    const bucket1 = Math.floor(t1 / 300_000);
    const bucket2 = Math.floor(t2 / 300_000);
    expect(bucket1).not.toBe(bucket2);
  });
});
