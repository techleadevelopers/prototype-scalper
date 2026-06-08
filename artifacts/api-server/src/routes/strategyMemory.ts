import { Router, type IRouter, type Request, type Response } from "express";
import { buildStrategyMemoryStatus } from "../lib/strategyMemory";
import { exportAllOutcomes } from "../lib/telemetryStore";

const router: IRouter = Router();

router.get("/strategy-memory/status", (_req: Request, res: Response) => {
  try {
    res.json(buildStrategyMemoryStatus({
      outcomes: exportAllOutcomes(),
    }));
  } catch (err) {
    res.status(500).json({
      error: "Failed to build strategy memory status",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
