import { Router, type IRouter, type Request, type Response } from "express";
import { acknowledgeIncident, collectSniperIncidents, exportIncidentReport } from "../lib/incidentEngine";
import { requireAdminAuthorization } from "../lib/executionSecurity";

const router: IRouter = Router();

router.get("/incidents", async (_req: Request, res: Response) => {
  res.json({
    incidents: await collectSniperIncidents(),
  });
});

router.post("/incidents/:fingerprint/ack", requireAdminAuthorization, (req: Request, res: Response) => {
  const rawFingerprint = req.params.fingerprint;
  const fingerprint = Array.isArray(rawFingerprint) ? rawFingerprint[0] : rawFingerprint;
  const incident = fingerprint ? acknowledgeIncident(fingerprint) : null;
  if (!incident) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.json({ ok: true, incident });
});

router.get("/incidents/report", requireAdminAuthorization, async (_req: Request, res: Response) => {
  res.json(await exportIncidentReport());
});

export default router;
