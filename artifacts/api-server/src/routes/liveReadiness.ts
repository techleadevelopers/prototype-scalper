import { Router, type Request, type Response } from "express";
import { getBotConfig } from "../lib/botConfig";
import { loadClosedTrades } from "../lib/demoTradeStore";
import { buildLiveReadinessStatus } from "../lib/live_readiness";
import { exportAllOutcomes } from "../lib/telemetryStore";

const router = Router();

router.get("/live-readiness/status", async (_req: Request, res: Response) => {
  try {
    const status = buildLiveReadinessStatus({
      outcomes: exportAllOutcomes(),
      closedDemoTrades: await loadClosedTrades(5_000),
      config: getBotConfig(),
    });
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: "Failed to build live readiness status",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
