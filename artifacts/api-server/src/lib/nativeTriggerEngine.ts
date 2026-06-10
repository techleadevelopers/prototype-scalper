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

/**
 * Modo brutal: ativa grid de 20 níveis por símbolo (10 LONG + 10 SHORT).
 * Ligado automaticamente quando o Sniper Copilot está ativo.
 * Pode ser forçado via env: NATIVE_TRIGGER_BRUTAL_MODE=true
 */
const BRUTAL_MODE_ENV =
  (process.env["NATIVE_TRIGGER_BRUTAL_MODE"] ?? "false") === "true";

// ── Estado interno ─────────────────────────────────────────────────────────────

const _lastFiredAt = new Map<string, number>(); // "BTC-USDT:LONG" → timestamp
let _sniperCopilotActive = BRUTAL_MODE_ENV;

/** Chamado pelo Sniper Copilot ao iniciar/parar para ativar o modo brutal. */
export function setSniperCopilotActive(active: boolean): void {
  _sniperCopilotActive = active || BRUTAL_MODE_ENV;
}

export function isBrutalModeActive(): boolean {
  return _sniperCopilotActive;
}

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

// ── Grid geometry tables ───────────────────────────────────────────────────────

/** Grid padrão: 3 LONG + 4 SHORT = 7 níveis por símbolo */
const STANDARD_LONG_DROPS   = [0.10, 0.11, 0.12];
const STANDARD_LONG_WEIGHTS = [0.20, 0.30, 0.50];
const STANDARD_SHORT_PUMPS   = [0.20, 0.21, 0.22, 0.24];
const STANDARD_SHORT_WEIGHTS = [0.15, 0.25, 0.30, 0.30];

/**
 * Grid brutal (Sniper Copilot ativo): 10 LONG + 10 SHORT = 20 níveis por símbolo.
 * Cobertura ampla: LONG de -10% a -22%, SHORT de +20% a +40%.
 * Pesos centralizados para cobrir toda a escada de forma eficiente.
 */
const BRUTAL_LONG_DROPS   = [0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.19, 0.22];
const BRUTAL_LONG_WEIGHTS = [0.05, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.13, 0.12];
const BRUTAL_SHORT_PUMPS   = [0.20, 0.21, 0.22, 0.24, 0.26, 0.28, 0.30, 0.33, 0.36, 0.40];
const BRUTAL_SHORT_WEIGHTS = [0.07, 0.08, 0.10, 0.12, 0.13, 0.13, 0.12, 0.10, 0.08, 0.07];

/**
 * Gera a escada de gatilhos Tail Hunter.
 *
 * Modo padrão : 3 LONG (−10/−11/−12%) + 4 SHORT (+20/+21/+22/+24%) = 7 níveis
 * Modo brutal : 10 LONG (−10%…−22%) + 10 SHORT (+20%…+40%) = 20 níveis
 *               Ativado quando o Sniper Copilot está rodando.
 */
function buildTailHunterGrid(
  currentPrice: number,
  side: "LONG" | "SHORT",
  atrPct: number = 0,
  brutal = _sniperCopilotActive,
): GridLevel[] {
  if (currentPrice <= 0) return [];

  const baseTargetUsdt = currentPrice * (BASE_TP_PCT / 100);

  function levelGeometry(triggerP: number): { tpPct: number; slPct: number } {
    let rawTp = (baseTargetUsdt / triggerP) * 100;
    if (atrPct > 0) {
      rawTp = Math.max(rawTp, atrPct * 0.40);
    }
    const tp = Math.max(0.08, Math.min(3.00, rawTp));
    return { tpPct: tp, slPct: tp * 2.0 };
  }

  const drops   = side === "LONG"
    ? (brutal ? BRUTAL_LONG_DROPS   : STANDARD_LONG_DROPS)
    : (brutal ? BRUTAL_SHORT_PUMPS  : STANDARD_SHORT_PUMPS);
  const weights = side === "LONG"
    ? (brutal ? BRUTAL_LONG_WEIGHTS : STANDARD_LONG_WEIGHTS)
    : (brutal ? BRUTAL_SHORT_WEIGHTS : STANDARD_SHORT_WEIGHTS);

  const levels: GridLevel[] = [];

  for (let i = 0; i < drops.length; i++) {
    const triggerPrice = parseFloat(
      (side === "LONG"
        ? currentPrice * (1 - drops[i])
        : currentPrice * (1 + drops[i])
      ).toFixed(6),
    );
    const { tpPct, slPct } = levelGeometry(triggerPrice);
    levels.push({
      level:            i + 1,
      side,
      triggerPrice,
      targetPrice: parseFloat(
        (side === "LONG"
          ? triggerPrice * (1 + tpPct / 100)
          : triggerPrice * (1 - tpPct / 100)
        ).toFixed(6),
      ),
      stopPrice: parseFloat(
        (side === "LONG"
          ? triggerPrice * (1 - slPct / 100)
          : triggerPrice * (1 + slPct / 100)
        ).toFixed(6),
      ),
      allocationFactor: weights[i],
    });
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
  brutalMode: boolean;
  levelsPerSide: number;
  totalLevels: number;
} {
  const brutal = _sniperCopilotActive;
  return {
    enabled:           NATIVE_TRIGGER_ENABLED,
    longDetectPct:     LONG_DETECT_PCT,
    shortDetectPct:    SHORT_DETECT_PCT,
    baseTpPct:         BASE_TP_PCT,
    expirationSeconds: EXPIRATION_SECONDS,
    cooldownMs:        COOLDOWN_MS,
    brutalMode:        brutal,
    levelsPerSide:     brutal ? 10 : (3 + 4) / 2,   // informativo
    totalLevels:       brutal ? 20 : 7,
  };
}

/** Retorna as tabelas de drops/pesos para uso externo (endpoint de preview). */
export function getTailHunterGridTables(brutal = _sniperCopilotActive): {
  longDrops: number[];
  longWeights: number[];
  shortPumps: number[];
  shortWeights: number[];
} {
  return {
    longDrops:    brutal ? BRUTAL_LONG_DROPS    : STANDARD_LONG_DROPS,
    longWeights:  brutal ? BRUTAL_LONG_WEIGHTS  : STANDARD_LONG_WEIGHTS,
    shortPumps:   brutal ? BRUTAL_SHORT_PUMPS   : STANDARD_SHORT_PUMPS,
    shortWeights: brutal ? BRUTAL_SHORT_WEIGHTS : STANDARD_SHORT_WEIGHTS,
  };
}
