/**
 * gridTriggerManager.ts — Tail Hunter Grid Strategy (ARM_TRIGGER_GRID)
 *
 * Recebe uma resposta ARM_TRIGGER_GRID do Quant Brain e executa a estratégia
 * de gatilhos em escada (wick hunting):
 *
 *   1. Coloca N ordens LIMIT Post-Only Maker (uma por nível do grid)
 *   2. Arma cada ordem no exhaustionTriggerManager com TTL coletivo
 *   3. Background poller: ao detectar fill de qualquer nível →
 *      ativa mux-lock + cancela os demais níveis (Single-Fill Guard)
 *
 * Integração com infraestrutura existente:
 *   - Mux-Lock: ativado por markTriggerFilled ao detectar posição aberta
 *   - Sector Cascade: cancelado antes de armar o grid
 *   - livePositionWatcher: cada nível registrado via registerLiveEntry
 *   - history_logger (QB): ARM_TRIGGER_GRID snapshot já gravado no QB
 *   - recordFillOutcome: chamado autonomamente pelo livePositionWatcher
 *
 * Contrato de Arquitetura:
 *   O QB é a única autoridade de geometria — triggerPrice / targetPrice /
 *   stopPrice nunca são recalculados aqui. allocationFactor distribui o
 *   totalMargin sem modificar a geometria de risco.
 */

import { bingxPost, bingxGet } from "./bingxHttp";
import {
  armLimitOrderExpiry,
  cancelSectorCascade,
  markTriggerFilled,
} from "./exhaustionTriggerManager";
import { registerLiveEntry, updateWatcherCreds } from "./livePositionWatcher";
import { logger } from "./logger";
import type { BtcRegime } from "./adaptiveEngine";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GridLevel {
  level: number;
  side: "LONG" | "SHORT";
  triggerPrice: number;
  targetPrice: number;
  stopPrice: number;
  allocationFactor: number; // 0..1 — soma de todos os níveis deve ser ≈ 1.0
}

export interface GridBrainResponse {
  decision: "ARM_TRIGGER_GRID";
  grid: GridLevel[];
  executionMetrics?: {
    recommendedLeverage?: number;
    gridStrategy?: string;
    expirationSeconds?: number;
  };
  metadata?: {
    signalId?: string;
    symbol?: string;
    sectorCluster?: string;
  };
}

export interface GridTriggerResult {
  levelsArmed: number;
  levelsFailed: number;
  orderIds: string[];
  triggerIds: string[];
  expirationMs: number;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const GRID_FILL_POLL_INTERVAL_MS = 5_000;
const GRID_DEFAULT_EXPIRATION_S  = 60;

// ── Core ───────────────────────────────────────────────────────────────────────

/**
 * processGridTrigger
 *
 * Ponto de entrada chamado por bot.ts quando qbDecision === "ARM_TRIGGER_GRID".
 * Não deve ser chamado se a resposta não for ARM_TRIGGER_GRID — verifica internamente.
 */
export async function processGridTrigger(params: {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  brainResponse: GridBrainResponse;
  totalMargin: number;
  leverage: number;
  signalId: string | undefined;
  sectorCluster: string | undefined;
  creds: { apiKey: string; secretKey: string };
  hourUtc?: number;
  btcRegime?: BtcRegime;
}): Promise<GridTriggerResult> {
  const {
    symbol, positionSide, brainResponse, totalMargin, leverage,
    signalId, sectorCluster, creds,
  } = params;

  if (brainResponse.decision !== "ARM_TRIGGER_GRID") {
    return { levelsArmed: 0, levelsFailed: 0, orderIds: [], triggerIds: [], expirationMs: 0 };
  }

  const grid = brainResponse.grid ?? [];
  const execMetrics = brainResponse.executionMetrics ?? {};
  const expirationSeconds = execMetrics.expirationSeconds ?? GRID_DEFAULT_EXPIRATION_S;
  const expirationMs = expirationSeconds * 1_000;
  const gridLeverage = execMetrics.recommendedLeverage ?? leverage;
  const gridStrategy = execMetrics.gridStrategy ?? "TAIL_HUNTER";
  const hourUtc = params.hourUtc ?? new Date().getUTCHours();
  const btcRegime: BtcRegime = params.btcRegime ?? "NEUTRAL";

  // ── Sector Cascade: cancela gatilhos pendentes do mesmo cluster ─────────────
  if (sectorCluster) {
    const cascade = cancelSectorCascade(symbol, sectorCluster);
    if (cascade.cancelled > 0) {
      logger.warn({
        msg: "GRID_SECTOR_CASCADE_CANCELLED",
        symbol, sectorCluster,
        cancelled: cascade.cancelled,
        ids: cascade.ids,
        gridStrategy,
      });
    }
  }

  const orderIds: string[] = [];
  const triggerIds: string[] = [];
  let levelsArmed = 0;
  let levelsFailed = 0;
  const now = Date.now();

  updateWatcherCreds(creds);

  for (const level of grid) {
    const levelMargin = totalMargin * Math.max(0.01, Math.min(1.0, level.allocationFactor));
    const qty = Math.floor((levelMargin * gridLeverage) / level.triggerPrice * 1_000) / 1_000;

    if (qty <= 0) {
      logger.warn({ msg: "GRID_LEVEL_QTY_ZERO", symbol, level: level.level, levelMargin, gridLeverage, triggerPrice: level.triggerPrice });
      levelsFailed++;
      continue;
    }

    let placedOrderId: string | undefined;

    try {
      const bxSide = positionSide === "LONG" ? "BUY" : "SELL";
      const data = await bingxPost(
        "/openApi/swap/v2/trade/order",
        {
          symbol,
          side: bxSide,
          positionSide,
          type: "LIMIT",
          quantity: qty,
          price: level.triggerPrice,
          leverage: gridLeverage,
          timeInForce: "GTX",             // Post-Only — Maker garantido
          stopLoss: level.stopPrice,
          takeProfit: level.targetPrice,
        },
        creds.apiKey,
        creds.secretKey,
      );

      if (data.code !== 0) {
        logger.error({
          msg: "GRID_ORDER_REJECTED",
          symbol, level: level.level,
          code: data.code, bxMsg: data.msg,
        });
        levelsFailed++;
        continue;
      }

      const order = ((data.data as Record<string, unknown>)?.order ?? {}) as Record<string, unknown>;
      placedOrderId = String(order.orderId ?? "");

      if (!placedOrderId) {
        logger.error({ msg: "GRID_ORDER_NO_ID", symbol, level: level.level });
        levelsFailed++;
        continue;
      }
    } catch (err) {
      logger.error({ msg: "GRID_ORDER_EXCEPTION", symbol, level: level.level, err: String(err) });
      levelsFailed++;
      continue;
    }

    orderIds.push(placedOrderId);

    // ── Arm expiry timer for this level ──────────────────────────────────────
    const triggerId = armLimitOrderExpiry({
      orderId: placedOrderId,
      symbol,
      direction: positionSide,
      triggerPrice: level.triggerPrice,
      exhaustionType: `GRID_${gridStrategy}_L${level.level}`,
      expirationMs,
      sectorCluster,
      signalId,
      cancelFn: async () => {
        await bingxPost(
          "/openApi/swap/v2/trade/cancel",
          { symbol, orderId: placedOrderId },
          creds.apiKey,
          creds.secretKey,
        ).catch(() => {});
      },
      checkPartialFillFn: async () => {
        try {
          const r = await bingxGet(
            "/openApi/swap/v2/trade/queryOrder",
            { symbol, orderId: placedOrderId },
            creds.apiKey,
            creds.secretKey,
          );
          const o = ((r.data as Record<string, unknown>)?.order) as Record<string, unknown> | undefined;
          if (o) {
            return {
              filledQty: parseFloat(String(o.executedQty ?? "0")),
              origQty: parseFloat(String(o.origQty ?? "0")),
            };
          }
        } catch { /* best-effort */ }
        return null;
      },
      onPartialFill: (filledQty: number, origQty: number) => {
        logger.warn({
          msg: "GRID_PARTIAL_FILL",
          symbol, level: level.level, orderId: placedOrderId,
          filledQty, origQty,
          ratio: origQty > 0 ? (filledQty / origQty).toFixed(3) : "?",
        });
      },
    });

    triggerIds.push(triggerId);
    levelsArmed++;

    // ── Register each level in livePositionWatcher ────────────────────────────
    const tpDistPct = positionSide === "LONG"
      ? ((level.targetPrice - level.triggerPrice) / level.triggerPrice) * 100
      : ((level.triggerPrice - level.targetPrice) / level.triggerPrice) * 100;
    const slDistPct = positionSide === "LONG"
      ? ((level.triggerPrice - level.stopPrice) / level.triggerPrice) * 100
      : ((level.stopPrice - level.triggerPrice) / level.triggerPrice) * 100;

    registerLiveEntry({
      entryOrderId: placedOrderId,
      symbol,
      positionSide,
      side: positionSide === "LONG" ? "BUY" : "SELL",
      expectedEntryPrice: level.triggerPrice,
      qty,
      leverage: gridLeverage,
      marginUsed: levelMargin,
      btcRegime,
      hourUtc,
      entryTime: now,
      expectedTpProfit: levelMargin * gridLeverage * (tpDistPct / 100),
      takeProfitPct: tpDistPct,
      stopLossPct: slDistPct,
      signalId,
      orderType: "LIMIT",
      featureVersion: `grid-${gridStrategy.toLowerCase()}-v1`,
    });

    logger.info({
      msg: "GRID_LEVEL_ARMED",
      symbol, level: level.level,
      triggerPrice: level.triggerPrice,
      targetPrice: level.targetPrice,
      stopPrice: level.stopPrice,
      allocationFactor: level.allocationFactor,
      qty, orderId: placedOrderId, triggerId,
      gridStrategy, expirationSeconds,
    });
  }

  // ── Background Fill Detector — Single-Fill Guard ───────────────────────────
  // Monitora posições a cada 5s durante o TTL do grid.
  // Ao detectar que QUALQUER nível abriu posição → markTriggerFilled no primeiro
  // triggerId disponível → mux-lock ativado → todos os outros gatilhos cancelados.
  if (triggerIds.length > 0) {
    const fillCheckDeadlineMs = now + expirationMs;
    void (async () => {
      while (Date.now() < fillCheckDeadlineMs) {
        await new Promise<void>((r) => setTimeout(r, GRID_FILL_POLL_INTERVAL_MS));
        try {
          const positions = await bingxGet(
            "/openApi/swap/v2/user/positions",
            {},
            creds.apiKey,
            creds.secretKey,
          );
          const positionList = ((positions.data as Record<string, unknown>)?.positions as unknown[]) ?? [];
          const isOpen = positionList.some((p) => {
            const pos = p as Record<string, unknown>;
            const amt = parseFloat(String(pos.positionAmt ?? "0"));
            return (
              String(pos.symbol ?? "").toUpperCase() === symbol.toUpperCase() &&
              String(pos.positionSide ?? "").toUpperCase() === positionSide.toUpperCase() &&
              amt !== 0
            );
          });
          if (isOpen) {
            // Primeiro fill detectado — activa mux-lock, cancela restantes
            markTriggerFilled(triggerIds[0]);
            logger.info({
              msg: "GRID_FILL_DETECTED",
              symbol, positionSide, gridStrategy,
              activeTriggers: triggerIds.length,
            });
            break;
          }
        } catch { /* best-effort — polling continua */ }
      }
    })();
  }

  return { levelsArmed, levelsFailed, orderIds, triggerIds, expirationMs };
}
