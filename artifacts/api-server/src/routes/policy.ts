import { Router, type Request, type Response } from "express";
import { getPolicyStatus } from "../lib/policyManifest";

const router = Router();

router.get("/sniper/policy/status", (_req: Request, res: Response) => {
  res.json(getPolicyStatus());
});

export default router;
