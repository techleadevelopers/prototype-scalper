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

// ── Knowledge Base ────────────────────────────────────────────────────────────

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

router.get("/neural/kb/insights", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/kb/insights?limit=5")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/kb/observations", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/kb/observations?hours=48&limit=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Learning & Metrics ────────────────────────────────────────────────────────

router.get("/neural/metrics/learning", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/metrics/learning?hours=48")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Shadow ML Model ───────────────────────────────────────────────────────────

router.get("/neural/models/sniper/status", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/models/sniper/status")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/signals/shadow-sampler/status", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/signals/shadow-sampler/status")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Strategic ─────────────────────────────────────────────────────────────────

router.get("/neural/strategic/edge-evolution", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/strategic/edge-evolution?days=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Market Intelligence ───────────────────────────────────────────────────────

router.get("/neural/market/macro-regime", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/market/macro-regime")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/market/snapshots", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/market/snapshots")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/market/anomalies", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/market/anomalies")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── BTC Commander (5m movement intelligence) ──────────────────────────────────

router.get("/neural/sniper/btc-commander", async (req: Request, res: Response) => {
  const window = Number(req.query["window_seconds"] ?? 300);
  try { res.json(await qbFetch(`/sniper/btc-commander?window_seconds=${window}`)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Tactical Alerts ───────────────────────────────────────────────────────────

router.get("/neural/tactical/alerts", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/tactical/alerts?max_age=300")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Regime Playbook ───────────────────────────────────────────────────────────

router.get("/neural/regime-playbook/status", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/regime-playbook/status")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Gate Simulation ───────────────────────────────────────────────────────────

router.get("/neural/simulate/gate-rejections", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/simulate/gate-rejections?days=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Health ────────────────────────────────────────────────────────────────────

router.get("/neural/health", async (_req: Request, res: Response) => {
  try { res.json(await qbFetch("/health")); }
  catch (e) { res.status(503).json({ error: String(e), online: false }); }
});

export default router;
