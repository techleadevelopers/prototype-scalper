import { Router } from "express";
import { exportAllOutcomes } from "../lib/telemetryStore";
import { getQuantBrainExecutionAudit } from "../lib/quantBrainClient";

const router = Router();

router.get("/execution/audit", async (req, res) => {
  const hours = Math.max(1, Math.min(Number(req.query.hours ?? 24) || 24, 720));
  const quantAudit = await getQuantBrainExecutionAudit(hours);
  if (quantAudit) {
    res.json(quantAudit);
    return;
  }

  const since = Date.now() - hours * 3600_000;
  const trades = exportAllOutcomes().filter((outcome) => outcome.exitTime >= since);
  const latencies = trades
    .map((outcome) => {
      const start = outcome.signalCreatedAt ?? outcome.orderRequestedAt ?? outcome.entryTime;
      const end = outcome.positionConfirmedAt ?? outcome.orderAckAt ?? outcome.entryTime;
      return Math.max(0, end - start);
    })
    .sort((a, b) => a - b);
  const slippageBps = trades
    .map((outcome) => (outcome.slippagePctNotional ?? 0) * 10_000)
    .sort((a, b) => a - b);
  const p = (values: number[], q: number) => (
    values.length ? values[Math.min(values.length - 1, Math.floor(values.length * q))] : 0
  );
  const executionDragUsdt = trades.reduce((sum, outcome) => sum + (outcome.totalSlippage ?? 0), 0);
  const margin = trades.reduce((sum, outcome) => sum + outcome.marginUsed, 0);

  res.json({
    source: "backend-local-fallback",
    hours,
    totalTradesAudited: trades.length,
    avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    p95LatencyMs: p(latencies, 0.95),
    avgSlippageBps: slippageBps.length ? slippageBps.reduce((a, b) => a + b, 0) / slippageBps.length : 0,
    p95SlippageBps: p(slippageBps, 0.95),
    executionDragUsdt,
    executionDragPct: margin > 0 ? (executionDragUsdt / margin) * 100 : 0,
    worstSymbolsBySlippage: [],
    worstHoursByLatency: [],
    missedMoveRate: 0,
    tradesLostByStrategy: trades.filter((outcome) => outcome.realizedPnl < 0).length,
    tradesLostByExecution: 0,
    recommendedConfigChanges: [],
  });
});

export default router;
