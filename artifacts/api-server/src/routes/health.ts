import { Router, type IRouter } from "express";
import { getServiceState, pauseExecution, resetServiceState } from "../lib/serviceState";
import type { Request, Response } from "express";
import { getRuntimeMetrics } from "../lib/runtimeMetrics";
import { getQuantBrainOperationalStats, getQuantBrainQueueStats } from "../lib/quantBrainClient";
import { getLiveWatcherStats } from "../lib/livePositionWatcher";
import { getTelemetryStats } from "../lib/telemetryStore";
import { requireAdminAuthorization } from "../lib/executionSecurity";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/runtime/metrics", (_req: Request, res: Response) => {
  res.json({
    runtime: getRuntimeMetrics(),
    queues: {
      quantBrain: getQuantBrainQueueStats(),
      telemetry: getTelemetryStats(),
      positionProtection: getLiveWatcherStats(),
    },
    dependencies: {
      quantBrain: getQuantBrainOperationalStats(),
    },
  });
});

/** GET /api/service-state — public snapshot of service health state machine */
router.get("/service-state", (_req: Request, res: Response) => {
  res.json(getServiceState());
});

/** POST /api/service-state/pause — manually pause execution (ops use) */
router.post("/service-state/pause", requireAdminAuthorization, (req: Request, res: Response) => {
  pauseExecution("MANUAL_PAUSE");
  res.json({ ok: true, state: getServiceState() });
});

/** POST /api/service-state/reset — reset back to HEALTHY */
router.post("/service-state/reset", requireAdminAuthorization, (req: Request, res: Response) => {
  resetServiceState("MANUAL_RESET");
  res.json({ ok: true, state: getServiceState() });
});

export default router;
