import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getServiceState, pauseExecution, resetServiceState } from "../lib/serviceState";
import type { Request, Response } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/** GET /api/service-state — public snapshot of service health state machine */
router.get("/service-state", (_req: Request, res: Response) => {
  res.json(getServiceState());
});

/** POST /api/service-state/pause — manually pause execution (ops use) */
router.post("/service-state/pause", (req: Request, res: Response) => {
  pauseExecution("MANUAL_PAUSE");
  res.json({ ok: true, state: getServiceState() });
});

/** POST /api/service-state/reset — reset back to HEALTHY */
router.post("/service-state/reset", (req: Request, res: Response) => {
  resetServiceState("MANUAL_RESET");
  res.json({ ok: true, state: getServiceState() });
});

export default router;
