/**
 * nativeTriggerEngine.ts — Motor Nativo de Gatilhos Tail Hunter
 *
 * Implementa a lógica de gatilhos diretamente no backend, sem dependência
 * do Quant Brain. Porta a lógica de `build_sniper_tail_grid` do Python para
 * TypeScript puro.
 *
 * Estratégia:
 *   - Busca candles 5m do BingX (via computeCandleEdge — já existente)
 *   - Detecta queda/alta > threshold no período recente
 *   - Arma escada Tail Hunter com geometria idêntica ao QB
 *
 * LONG : entradas em quedas de 10%, 11%, 12% — pesos 20/30/50%
 * SHORT: entradas em altas de 20%, 21%, 22%, 24% — pesos 15/25/30/30%
 *
 * TP dinâmico: (baseTargetUsdt / triggerPrice) × 100, clamped 0.08%–3.00%
 * SL rigoroso: 2× TP (relação 2:1 perda:ganho)
 *
 * O Quant Brain continua ativo como camada observacional/shadow.
 * Este motor entra apenas quando o QB não retorna ARM_TRIGGER_GRID.
 */

import { randomUUID } from "node:crypto";
import { computeCandleEdge } from "./candleEdge";
import type { GridLevel, GridBrainResponse } from "./gridTriggerManager";
import { getSectorCluster } from "./sectorMap";
import { logger } from "./logger";

// ── Config (env-driven) ────────────────────────────────────────────────────────

const NATIVE_TRIGGER_ENABLED =
  (process.env["NATIVE_TRIGGER_ENABLED"] ?? "true") !== "false";

/** % de queda no período recente para disparar busca de LONG */
const LONG_DETECT_PCT = parseFloat(
  process.env["NATIVE_TRIGGER_LONG_DETECT_PCT"] ?? "2.0",
);

/** % de alta no período recente para disparar busca de SHORT */
const SHORT_DETECT_PCT = parseFloat(
  process.env["NATIVE_TRIGGER_SHORT_DETECT_PCT"] ?? "4.0",
);

/**
 * % do preço atual usado como base para cálculo do TP dinâmico.
 * Equivalente ao `base_target_usdt` do Python:
 *   baseTargetUsdt = currentPrice × (BASE_TP_PCT / 100)
 */
const BASE_TP_PCT = parseFloat(
  process.env["NATIVE_TRIGGER_BASE_TP_PCT"] ?? "0.50",
);

/** TTL das ordens LIMIT em segundos */
const EXPIRATION_SECONDS = parseInt(
  process.env["NATIVE_TRIGGER_EXPIRATION_SECONDS"] ?? "120",
  10,
);

/** Cooldown por símbolo/direção para evitar rajada de triggers (ms) */
const COOLDOWN_MS = parseInt(
  process.env["NATIVE_TRIGGER_COOLDOWN_MS"] ?? "60000",
  10,
);

// ── Estado interno ─────────────────────────────────────────────────────────────

const _lastFiredAt = new Map<string, number>(); // "BTC-USDT:LONG" → timestamp

// ── Interfaces públicas ────────────────────────────────────────────────────────

export interface NativeTriggerResult {
  fired: boolean;
  side?: "LONG" | "SHORT";
  currentPrice?: number;
  detectedMovePct?: number;
  atrPct?: number;
  grid?: GridLevel[];
  brainResponse?: GridBrainResponse;
  signalId?: string;
  reason?: string;
}

// ── Geometria do grid (idêntica ao Python build_sniper_tail_grid) ─────────────

/**
 * Gera a escada de gatilhos Tail Hunter.
 *
 * Ancorada no preço atual — os níveis são percentuais absolutos do preço corrente.
 *
 * LONG : 10%, 11%, 12% abaixo → pesos 20/30/50%
 * SHORT: 20%, 21%, 22%, 24% acima → pesos 15/25/30/30%
 */
function buildTailHunterGrid(
  currentPrice: number,
  side: "LONG" | "SHORT",
  atrPct: number = 0,
): GridLevel[] {
  if (currentPrice <= 0) return [];

  const baseTargetUsdt = currentPrice * (BASE_TP_PCT / 100);

  function levelGeometry(triggerP: number): { tpPct: number; slPct: number } {
    let rawTp = (baseTargetUsdt / triggerP) * 100;
    if (atrPct > 0) {
      rawTp = Math.max(rawTp, atrPct * 0.40); // mínimo 40% do ATR
    }
    const tp = Math.max(0.08, Math.min(3.00, rawTp));
    return { tpPct: tp, slPct: tp * 2.0 };
  }

  const levels: GridLevel[] = [];

  if (side === "LONG") {
    const drops   = [0.10, 0.11, 0.12];
    const weights = [0.20, 0.30, 0.50];

    for (let i = 0; i < drops.length; i++) {
      const triggerPrice = parseFloat((currentPrice * (1 - drops[i])).toFixed(6));
      const { tpPct, slPct } = levelGeometry(triggerPrice);
      levels.push({
        level:            i + 1,
        side:             "LONG",
        triggerPrice,
        targetPrice:      parseFloat((triggerPrice * (1 + tpPct / 100)).toFixed(6)),
        stopPrice:        parseFloat((triggerPrice * (1 - slPct / 100)).toFixed(6)),
        allocationFactor: weights[i],
      });
    }
  } else {
    const pumps   = [0.20, 0.21, 0.22, 0.24];
    const weights = [0.15, 0.25, 0.30, 0.30];

    for (let i = 0; i < pumps.length; i++) {
      const triggerPrice = parseFloat((currentPrice * (1 + pumps[i])).toFixed(6));
      const { tpPct, slPct } = levelGeometry(triggerPrice);
      levels.push({
        level:            i + 1,
        side:             "SHORT",
        triggerPrice,
        targetPrice:      parseFloat((triggerPrice * (1 - tpPct / 100)).toFixed(6)),
        stopPrice:        parseFloat((triggerPrice * (1 + slPct / 100)).toFixed(6)),
        allocationFactor: weights[i],
      });
    }
  }

  return levels;
}

/**
 * ATR-adaptive leverage — idêntico ao Python _compute_recommended_leverage.
 *   ATR = 0.5% → 20x
 *   ATR = 1.0% → 10x
 *   ATR = 2.0% → 5x
 *   ATR = 0.2% → 50x (cap)
 */
function computeRecommendedLeverage(atrPct: number): number {
  if (atrPct <= 0) return 20;
  const leverage = Math.round(0.10 / (atrPct / 100));
  return Math.max(5, Math.min(50, leverage));
}

// ── API pública ────────────────────────────────────────────────────────────────

/**
 * Avalia se um gatilho nativo deve disparar para o símbolo/direção.
 *
 * Usa o campo `recentMovePct` do CandleEdge (% de variação nos últimos 3-4
 * candles de 5m) como sinal de detecção. Quando o movimento supera o threshold
 * configuvável, arma a escada Tail Hunter sem chamar o Quant Brain.
 *
 * @param symbol       Ex: "BTC-USDT"
 * @param positionSide "LONG" | "SHORT"
 */
export async function evaluateNativeTrigger(
  symbol: string,
  positionSide: "LONG" | "SHORT",
): Promise<NativeTriggerResult> {
  if (!NATIVE_TRIGGER_ENABLED) {
    return { fired: false, reason: "NATIVE_TRIGGER_DISABLED" };
  }

  const cooldownKey = `${symbol}:${positionSide}`;
  const lastFired = _lastFiredAt.get(cooldownKey) ?? 0;
  const remaining = COOLDOWN_MS - (Date.now() - lastFired);
  if (remaining > 0) {
    return { fired: false, reason: `COOLDOWN:${Math.round(remaining / 1000)}s` };
  }

  try {
    const edge = await computeCandleEdge(symbol, "5m");
    if (!edge || edge.lastClose <= 0) {
      return { fired: false, reason: "NO_CANDLE_DATA" };
    }

    const currentPrice = edge.lastClose;
    const atrPct       = edge.atrPct ?? 0;
    const movePct      = edge.recentMovePct ?? 0;

    let shouldFire      = false;
    let detectedMovePct = 0;

    if (positionSide === "LONG" && movePct <= -LONG_DETECT_PCT) {
      shouldFire      = true;
      detectedMovePct = movePct;
    } else if (positionSide === "SHORT" && movePct >= SHORT_DETECT_PCT) {
      shouldFire      = true;
      detectedMovePct = movePct;
    }

    if (!shouldFire) {
      return {
        fired:  false,
        reason: `MOVE_BELOW_THRESHOLD:move=${movePct.toFixed(3)}% threshold=${positionSide === "LONG" ? -LONG_DETECT_PCT : SHORT_DETECT_PCT}%`,
      };
    }

    const grid = buildTailHunterGrid(currentPrice, positionSide, atrPct);
    if (grid.length === 0) {
      return { fired: false, reason: "GRID_EMPTY" };
    }

    const signalId      = randomUUID();
    const sectorCluster = getSectorCluster(symbol);

    const brainResponse: GridBrainResponse = {
      decision: "ARM_TRIGGER_GRID",
      grid,
      executionMetrics: {
        recommendedLeverage: computeRecommendedLeverage(atrPct),
        gridStrategy:        "TAIL_HUNTER_NATIVE",
        expirationSeconds:   EXPIRATION_SECONDS,
      },
      metadata: {
        signalId,
        symbol,
        sectorCluster,
      },
    };

    _lastFiredAt.set(cooldownKey, Date.now());

    logger.info(
      {
        symbol,
        positionSide,
        detectedMovePct: detectedMovePct.toFixed(3),
        currentPrice,
        atrPct:          atrPct.toFixed(3),
        levels:          grid.length,
        signalId,
        triggers:        grid.map((l) => `L${l.level}@${l.triggerPrice}`).join(" | "),
      },
      "[NATIVE_TRIGGER] 🎯 Grid Tail Hunter armado (sem Quant Brain)",
    );

    return {
      fired: true,
      side:             positionSide,
      currentPrice,
      detectedMovePct,
      atrPct,
      grid,
      brainResponse,
      signalId,
    };
  } catch (err) {
    logger.warn(
      { symbol, positionSide, err: String(err) },
      "[NATIVE_TRIGGER] Erro ao avaliar gatilho nativo",
    );
    return { fired: false, reason: `ERROR:${String(err)}` };
  }
}

/** Limpa o cooldown de um símbolo (ou todos) — útil para testes e reset manual. */
export function resetNativeTriggerCooldown(symbol?: string): void {
  if (symbol) {
    _lastFiredAt.delete(`${symbol}:LONG`);
    _lastFiredAt.delete(`${symbol}:SHORT`);
  } else {
    _lastFiredAt.clear();
  }
}

export function getNativeTriggerEnabled(): boolean {
  return NATIVE_TRIGGER_ENABLED;
}

/** Retorna o estado de cooldown de cada símbolo. */
export function getNativeTriggerCooldowns(): Record<string, { long: number; short: number }> {
  const now = Date.now();
  const out: Record<string, { long: number; short: number }> = {};
  for (const [key, ts] of _lastFiredAt.entries()) {
    const [sym, side] = key.split(":");
    if (!out[sym]) out[sym] = { long: 0, short: 0 };
    const remaining = Math.max(0, COOLDOWN_MS - (now - ts));
    if (side === "LONG") out[sym].long = remaining;
    else out[sym].short = remaining;
  }
  return out;
}

export function getNativeTriggerConfig(): {
  enabled: boolean;
  longDetectPct: number;
  shortDetectPct: number;
  baseTpPct: number;
  expirationSeconds: number;
  cooldownMs: number;
} {
  return {
    enabled:           NATIVE_TRIGGER_ENABLED,
    longDetectPct:     LONG_DETECT_PCT,
    shortDetectPct:    SHORT_DETECT_PCT,
    baseTpPct:         BASE_TP_PCT,
    expirationSeconds: EXPIRATION_SECONDS,
    cooldownMs:        COOLDOWN_MS,
  };
}
