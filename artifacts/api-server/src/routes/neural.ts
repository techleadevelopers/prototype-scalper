import { Router, type Request, type Response } from "express";

const router = Router();

const TIMEOUT_MS = 8000;
const STALE_TTL_MS = 5 * 60_000;
const neuralCache = new Map<string, { value: unknown; expiresAt: number; staleUntil: number }>();

function qbUrl(): string {
  return (process.env["QUANT_BRAIN_URL"]?.trim() || "http://localhost:9000").replace(/\/+$/, "");
}

function qbHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env["QUANT_BRAIN_API_TOKEN"]?.trim();
  if (token) headers["X-Quant-Brain-Token"] = token;
  return headers;
}

async function qbFetch(path: string, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${qbUrl()}${path}`, { headers: qbHeaders(), signal: ctrl.signal });
    if (!res.ok) throw new Error(`QB ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function qbCached(path: string, timeoutMs = TIMEOUT_MS, ttlMs = 15_000): Promise<unknown> {
  const now = Date.now();
  const cached = neuralCache.get(path);
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const value = await qbFetch(path, timeoutMs);
    neuralCache.set(path, {
      value,
      expiresAt: Date.now() + ttlMs,
      staleUntil: Date.now() + STALE_TTL_MS,
    });
    return value;
  } catch (error) {
    if (cached && cached.staleUntil > now) return {
      ...(typeof cached.value === "object" && cached.value !== null ? cached.value as Record<string, unknown> : { value: cached.value }),
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

// ── Knowledge Base ────────────────────────────────────────────────────────────

router.get("/neural/kb/stats", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/kb/stats?days=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/kb/patterns", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/kb/patterns?min_occurrences=1&limit=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/kb/trades/recent", async (req: Request, res: Response) => {
  const limit = Number(req.query["limit"] ?? 20);
  try { res.json(await qbCached(`/kb/trades/recent?limit=${limit}`)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/kb/insights", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/kb/insights?limit=5")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/kb/observations", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/kb/observations?hours=48&limit=30")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Learning & Metrics ────────────────────────────────────────────────────────

router.get("/neural/metrics/learning", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/metrics/learning?hours=48")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Shadow ML Model ───────────────────────────────────────────────────────────

router.get("/neural/models/sniper/status", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/models/sniper/status", 5000, 20_000)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/signals/shadow-sampler/status", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/signals/shadow-sampler/status")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Strategic ─────────────────────────────────────────────────────────────────

router.get("/neural/strategic/edge-evolution", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/strategic/edge-evolution?days=30", TIMEOUT_MS, 60_000)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Market Intelligence ───────────────────────────────────────────────────────

router.get("/neural/market/macro-regime", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/market/macro-regime")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/market/snapshots", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/market/snapshots", 3000, 5_000)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

router.get("/neural/market/anomalies", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/market/anomalies")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── BTC Commander (5m movement intelligence) ──────────────────────────────────

router.get("/neural/sniper/btc-commander", async (req: Request, res: Response) => {
  const window = Number(req.query["window_seconds"] ?? 300);
  try { res.json(await qbCached(`/sniper/btc-commander?window_seconds=${window}`, 3000, 5_000)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Tactical Alerts ───────────────────────────────────────────────────────────

router.get("/neural/tactical/alerts", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/tactical/alerts?max_age=300", 3000, 5_000)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Regime Playbook ───────────────────────────────────────────────────────────

router.get("/neural/regime-playbook/status", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/regime-playbook/status")); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Gate Simulation ───────────────────────────────────────────────────────────

router.get("/neural/simulate/gate-rejections", async (_req: Request, res: Response) => {
  try { res.json(await qbCached("/simulate/gate-rejections?days=30", TIMEOUT_MS, 60_000)); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});

// ── Health ────────────────────────────────────────────────────────────────────

router.get("/neural/health", async (_req: Request, res: Response) => {
  try {
    const live = await qbFetch("/health/live", 3000) as Record<string, unknown>;
    res.json({ ...live, online: true, qbUrlConfigured: Boolean(process.env["QUANT_BRAIN_URL"]?.trim()) });
  } catch (liveError) {
    try {
      const health = await qbFetch("/health", 5000) as Record<string, unknown>;
      res.json({ ...health, online: true, qbUrlConfigured: Boolean(process.env["QUANT_BRAIN_URL"]?.trim()) });
    } catch (healthError) {
      res.status(503).json({
        online: false,
        qbUrlConfigured: Boolean(process.env["QUANT_BRAIN_URL"]?.trim()),
        error: String(healthError),
        liveError: String(liveError),
      });
    }
  }
});

export default router;
