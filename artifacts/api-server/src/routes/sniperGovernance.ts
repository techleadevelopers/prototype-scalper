import { Router, type Request, type Response } from "express";
import { getBotConfig } from "../lib/botConfig";
import { loadClosedTrades } from "../lib/demoTradeStore";
import { buildLiveReadinessStatus } from "../lib/live_readiness";
import { getQuantBrainScoreCalibrationStatus } from "../lib/quantBrainClient";
import { buildSniperGovernanceStatus } from "../lib/sniperGovernance";
import { buildStrategyMemoryStatus } from "../lib/strategyMemory";
import { exportAllOutcomes } from "../lib/telemetryStore";

const router = Router();

router.get("/sniper/governance/status", async (_req: Request, res: Response) => {
  try {
    const outcomes = exportAllOutcomes();
    const closedDemoTrades = await loadClosedTrades(5_000);
    const strategyMemory = buildStrategyMemoryStatus({ outcomes });
    const liveReadiness = buildLiveReadinessStatus({
      outcomes,
      closedDemoTrades,
      config: getBotConfig(),
    });
    const scoreCalibration = await getQuantBrainScoreCalibrationStatus(30, 5_000);

    res.json(buildSniperGovernanceStatus({
      outcomes,
      strategyMemory,
      liveReadiness,
      scoreCalibration,
    }));
  } catch (err) {
    res.status(500).json({
      error: "Failed to build sniper governance status",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
