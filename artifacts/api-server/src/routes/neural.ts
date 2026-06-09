import { Router, type Request, type Response } from "express";

const router = Router();

const QB_URL = process.env["QUANT_BRAIN_URL"]?.trim() || "http://localhost:9000";
const TIMEOUT_MS = 8000;

async function qbFetch(path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${QB_URL}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`QB ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

router.get("/neural/kb/stats", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/kb/stats?days=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/kb/patterns", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/kb/patterns?min_occurrences=1&limit=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/kb/trades/recent", async (req: Request, res: Response) => {
  const limit = Number(req.query["limit"] ?? 20);
  try { res.json(await qbFetch(`/kb/trades/recent?limit=${limit}`)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/metrics/learning", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/metrics/learning?hours=48")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/models/sniper/status", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/models/sniper/status")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/strategic/edge-evolution", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/strategic/edge-evolution?days=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/health", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/health")); }
  catch (e) { res.status(503).json({ error: String(e), online: false }); }
});

export default router;
