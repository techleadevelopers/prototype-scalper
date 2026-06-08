import { Router, type IRouter, type Request, type Response } from "express";
import { auditPipeline } from "../lib/pipelineAuditor";
import { exportAllOutcomes } from "../lib/telemetryStore";
import { getOpenTrades, loadClosedTrades } from "../lib/demoTradeStore";

const router: IRouter = Router();

router.get("/pipeline/audit", async (_req: Request, res: Response) => {
  try {
    const report = auditPipeline({
      outcomes: exportAllOutcomes(),
      openDemoTrades: getOpenTrades(),
      closedDemoTrades: await loadClosedTrades(2_000),
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({
      error: "Failed to build pipeline audit",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
