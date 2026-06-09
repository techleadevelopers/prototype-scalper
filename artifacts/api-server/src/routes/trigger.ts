/**
 * Trigger/Gatilho entry strategy — HTTP routes.
 *
 * GET  /api/demo/trigger/status          — estado atual por símbolo
 * POST /api/demo/trigger/enable          — ativa com configuração (snapshoteia preços)
 * POST /api/demo/trigger/disable         — desativa
 * POST /api/demo/trigger/snapshot        — re-captura preços de referência
 * POST /api/demo/trigger/reset/:symbol   — reseta estado de 1 símbolo (ou todos se omitido)
 *
 * O ciclo de monitoramento vive em demo.ts (runTriggerCycle), pois precisa de bingxPost/VST.
 */

import { Router, type Request, type Response } from "express";
import {
  getTriggerConfig,
  setTriggerConfig,
  getTriggerSummary,
  snapshotReferencePrice,
  resetTriggerState,
  isTriggerEnabled,
} from "../lib/triggerStrategy";
import { getBotConfig } from "../lib/botConfig";

const router = Router();

// ── Public API ────────────────────────────────────────────────────────────────

/** GET /api/demo/trigger/status */
router.get("/demo/trigger/status", (_req: Request, res: Response) => {
  res.json(getTriggerSummary());
});

/** POST /api/demo/trigger/enable */
router.post("/demo/trigger/enable", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const config = getTriggerConfig();
  const patch = {
    enabled: true,
    longDropPct: typeof body.longDropPct === "number" ? body.longDropPct : config.longDropPct,
    shortRisePct: typeof body.shortRisePct === "number" ? body.shortRisePct : config.shortRisePct,
    slPct: typeof body.slPct === "number" ? body.slPct : config.slPct,
    cooldownMs: typeof body.cooldownMs === "number" ? body.cooldownMs : config.cooldownMs,
    autoResetAfterFireMs: typeof body.autoResetAfterFireMs === "number"
      ? body.autoResetAfterFireMs : config.autoResetAfterFireMs,
    symbols: Array.isArray(body.symbols) ? (body.symbols as string[]) : config.symbols,
  };
  const newConfig = setTriggerConfig(patch);

  // Snapshot reference prices immediately using public BingX ticker
  const targetSymbols = newConfig.symbols.length > 0
    ? newConfig.symbols
    : getBotConfig().allowedSymbols;
  const snapshotted = await snapshotSymbolsFromPublicAPI(targetSymbols, newConfig.longDropPct, newConfig.shortRisePct);

  res.json({ enabled: true, config: newConfig, snapshotted, summary: getTriggerSummary() });
});

/** POST /api/demo/trigger/disable */
router.post("/demo/trigger/disable", (_req: Request, res: Response) => {
  setTriggerConfig({ enabled: false });
  res.json({ enabled: false, summary: getTriggerSummary() });
});

/** POST /api/demo/trigger/snapshot */
router.post("/demo/trigger/snapshot", async (_req: Request, res: Response) => {
  const config = getTriggerConfig();
  if (!config.enabled) {
    res.status(400).json({ error: "Trigger não está ativo. Ative primeiro via /enable." });
    return;
  }
  const targetSymbols = config.symbols.length > 0 ? config.symbols : getBotConfig().allowedSymbols;
  const snapshotted = await snapshotSymbolsFromPublicAPI(targetSymbols, config.longDropPct, config.shortRisePct);
  res.json({ snapshotted, summary: getTriggerSummary() });
});

/** POST /api/demo/trigger/reset/:symbol */
router.post("/demo/trigger/reset/:symbol", (req: Request, res: Response) => {
  const symbol = String(req.params["symbol"]);
  resetTriggerState(symbol);
  res.json({ reset: symbol, summary: getTriggerSummary() });
});

/** POST /api/demo/trigger/reset  (reset all) */
router.post("/demo/trigger/reset", (_req: Request, res: Response) => {
  resetTriggerState();
  res.json({ reset: "all", summary: getTriggerSummary() });
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function snapshotSymbolsFromPublicAPI(
  symbols: string[],
  longDropPct: number,
  shortRisePct: number,
): Promise<number> {
  let count = 0;
  await Promise.allSettled(
    symbols.map(async (sym) => {
      try {
        const res = await fetch(
          `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(sym)}&timestamp=${Date.now()}`,
          { signal: AbortSignal.timeout(5000) },
        );
        const data = await res.json() as Record<string, unknown>;
        if (String(data.code) === "0") {
          const d = (data.data as Record<string, string>) ?? {};
          const price = parseFloat(d.lastPrice ?? d.price ?? "0");
          if (price > 0) {
            snapshotReferencePrice(sym, price);
            count++;
          }
        }
      } catch { /* skip */ }
    }),
  );
  return count;
}

export default router;
