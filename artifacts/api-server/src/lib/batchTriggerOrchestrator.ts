/**
 * batchTriggerOrchestrator.ts
 *
 * Orquestrador centralizado de gatilhos em lote para a lista de SYMBOLS do .env.
 *
 * Implementa duas barreiras de concorrência antes de chamar o pipeline QB:
 *   1. Mux-Lock global — após qualquer fill, bloqueia novas entradas por
 *      MUX_LOCK_CANDLES velas de 1m (evita colisões de margem em rajada).
 *   2. Teto de posições abertas — aborta sem chamar a API se o limite
 *      maxConcurrentPositions já foi atingido (preserva rate-limit BingX).
 *
 * Feature 1: Single-Fill Execution Guard (Mux-Lock)
 *   Quando um gatilho é armado com sucesso, o Mux-Lock global é ativado
 *   imediatamente, cancelando todos os gatilhos pendentes.
 *
 * Feature 3: Partial Fill Policy
 *   O monitor de ciclo de vida (`startTriggerLifecycleMonitor`) faz polling
 *   a cada 5 s para detectar preenchimento parcial ou expiração de TTL.
 */

import type { QuantBrainEdgeResult } from "./quantBrainClient";
import {
  activateMuxLock,
  armLimitOrderExpiry,
  isMuxLocked,
} from "./exhaustionTriggerManager";
import { logger } from "./logger";

const MUX_LOCK_CANDLES = Math.max(1, parseInt(process.env["MUX_LOCK_CANDLES"] ?? "2", 10));
const LIFECYCLE_POLL_MS = Math.max(
  1_000,
  parseInt(process.env["TRIGGER_LIFECYCLE_POLL_MS"] ?? "5000", 10),
);

export interface PlaceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  price?: number;
  quantity?: number;
  takeProfit?: number;
  stopLoss?: number;
  postOnly?: boolean;
}

export interface PlaceOrderResult {
  id: string;
  symbol: string;
  status: string;
  filledQty?: number;
  origQty?: number;
}

export type PlaceOrderFn = (params: PlaceOrderParams) => Promise<PlaceOrderResult>;
export type GetActivePositionsCountFn = () => Promise<number>;
export type CheckOrderStatusFn = (
  orderId: string,
  symbol: string,
) => Promise<{ filledQty: number; origQty: number } | null>;
export type CancelOrderFn = (orderId: string, symbol: string) => Promise<void>;

interface MuxLockState {
  isActive: boolean;
  expiresAt: number;
  triggeringSignalId: string | null;
}

export class BatchTriggerOrchestrator {
  private muxLock: MuxLockState = {
    isActive: false,
    expiresAt: 0,
    triggeringSignalId: null,
  };
  private activePositionsCount: number = 0;
  private readonly maxConcurrentPositions: number;
  private readonly placeOrderFn: PlaceOrderFn;
  private readonly getActivePositionsCountFn: GetActivePositionsCountFn;
  private readonly checkOrderStatusFn?: CheckOrderStatusFn;
  private readonly cancelOrderFn?: CancelOrderFn;

  constructor(options: {
    maxConcurrentPositions?: number;
    placeOrderFn: PlaceOrderFn;
    getActivePositionsCountFn: GetActivePositionsCountFn;
    checkOrderStatusFn?: CheckOrderStatusFn;
    cancelOrderFn?: CancelOrderFn;
  }) {
    this.maxConcurrentPositions = options.maxConcurrentPositions ?? 3;
    this.placeOrderFn = options.placeOrderFn;
    this.getActivePositionsCountFn = options.getActivePositionsCountFn;
    this.checkOrderStatusFn = options.checkOrderStatusFn;
    this.cancelOrderFn = options.cancelOrderFn;

    const lockDurationMs = MUX_LOCK_CANDLES * 60_000;
    logger.info(
      { muxLockCandles: MUX_LOCK_CANDLES, lockDurationMs, maxConcurrentPositions: this.maxConcurrentPositions },
      "[BATCH] Orquestrador iniciado",
    );
  }

  /**
   * Avalia e processa o sinal QB para um símbolo da lista do .env.
   * Aplica os dois hard gates antes de consumir a resposta QB.
   *
   * @param symbol  Símbolo normalizado (ex: "SOL-USDT")
   * @param signal  Resposta já obtida do Quant Brain (edge-v3)
   */
  public async handleMarketTick(symbol: string, signal: QuantBrainEdgeResult): Promise<void> {
    const now = Date.now();

    // ── HARD GATE 1: Mux-Lock global ─────────────────────────────────────────
    const muxStatus = isMuxLocked();
    if (muxStatus.locked) {
      logger.debug(
        { symbol, remainingMs: muxStatus.remainingMs, reason: muxStatus.reason },
        "[BATCH] Mux-Lock ativo — símbolo ignorado",
      );
      return;
    }

    // Sincroniza estado interno com o módulo de triggers
    if (this.muxLock.isActive && now >= this.muxLock.expiresAt) {
      this.muxLock.isActive = false;
      this.muxLock.triggeringSignalId = null;
      logger.debug("[MUX_LOCK] Barramento liberado automaticamente (estado interno).");
    }

    // ── HARD GATE 2: Teto de posições abertas ────────────────────────────────
    try {
      this.activePositionsCount = await this.getActivePositionsCountFn();
    } catch (err) {
      logger.warn({ symbol, err }, "[BATCH] Falha ao obter contagem de posições — gate ignorado");
    }

    if (this.activePositionsCount >= this.maxConcurrentPositions) {
      logger.debug(
        { symbol, activePositionsCount: this.activePositionsCount, maxConcurrentPositions: this.maxConcurrentPositions },
        "[BATCH] Teto de posições atingido — símbolo descartado",
      );
      return;
    }

    // ── PIPELINE QB ──────────────────────────────────────────────────────────
    if (signal.decision !== "ARM_TRIGGER") {
      logger.debug(
        { symbol, decision: signal.decision },
        "[BATCH] Decisão não é ARM_TRIGGER — nenhuma ação (ARM_TRIGGER_GRID tratado em bot.ts)",
      );
      return;
    }

    await this.armTriggerAndLock(symbol, signal);
  }

  /**
   * Arma o gatilho no BingX (ordem LIMIT Post-Only Maker) e ativa o Mux-Lock
   * imediatamente para bloquear novas entradas simultâneas.
   */
  private async armTriggerAndLock(symbol: string, signal: QuantBrainEdgeResult): Promise<void> {
    const geometry = signal.geometry ?? {
      side: signal.positionSide === "LONG" ? "LONG" : "SHORT",
      triggerPrice: signal.triggerPrice ?? null,
      targetPrice: signal.targetPrice ?? null,
      stopPrice: signal.stopPrice ?? null,
      expirationSeconds: signal.expirationSeconds ?? 30,
    };

    if (!geometry.triggerPrice || !geometry.targetPrice || !geometry.stopPrice) {
      logger.warn({ symbol, geometry }, "[BATCH] Geometria incompleta — armamento abortado");
      return;
    }

    const buySide = (geometry.side ?? signal.positionSide) === "LONG" ? "BUY" : "SELL";
    const expirationMs = (geometry.expirationSeconds ?? 30) * 1_000;

    try {
      const order = await this.placeOrderFn({
        symbol,
        side: buySide,
        type: "LIMIT",
        price: geometry.triggerPrice,
        takeProfit: geometry.targetPrice,
        stopLoss: geometry.stopPrice,
        postOnly: true,
      });

      // ── Feature 1: Mux-Lock síncrono ─────────────────────────────────────
      const lockDurationMs = MUX_LOCK_CANDLES * 60_000;
      this.muxLock = {
        isActive: true,
        expiresAt: Date.now() + lockDurationMs,
        triggeringSignalId: signal.signalId ?? null,
      };

      // Propaga o lock para o módulo centralizado de triggers
      activateMuxLock(
        `armed:${symbol}:${buySide}@${geometry.triggerPrice} signalId=${signal.signalId}`,
      );

      logger.info(
        {
          symbol,
          orderId: order.id,
          triggerPrice: geometry.triggerPrice,
          targetPrice: geometry.targetPrice,
          stopPrice: geometry.stopPrice,
          lockDurationMs,
          signalId: signal.signalId,
        },
        "[MUX_LOCK_ACTIVE] Gatilho armado. Bloqueio global ativado.",
      );

      // Registra o timer de expiração TTL (Feature 3 — partial fill policy)
      const triggerId = armLimitOrderExpiry({
        orderId: order.id,
        symbol,
        direction: buySide === "BUY" ? "LONG" : "SHORT",
        triggerPrice: geometry.triggerPrice,
        expirationMs,
        sectorCluster: signal.sectorCluster,
        signalId: signal.signalId,
        cancelFn: async () => {
          logger.info({ symbol, orderId: order.id }, "[BATCH] TTL expirado — cancelando ordem BingX");
          if (this.cancelOrderFn) {
            await this.cancelOrderFn(order.id, symbol);
          } else {
            logger.warn({ symbol, orderId: order.id }, "[BATCH] cancelOrderFn não injetada — ordem pode permanecer aberta");
          }
        },
        checkPartialFillFn: this.checkOrderStatusFn
          ? () => this.checkOrderStatusFn!(order.id, symbol)
          : undefined,
        onPartialFill: (filledQty, origQty) => {
          logger.warn(
            { symbol, orderId: order.id, filledQty, origQty },
            "[BATCH] Preenchimento parcial detectado — remainder cancelado via cancelFn",
          );
        },
      });

      // ── Feature 3: Background poll de ciclo de vida (5 s) ────────────────
      this.startTriggerLifecycleMonitor(symbol, order.id, triggerId, signal);
    } catch (error) {
      logger.error(
        { symbol, err: error instanceof Error ? error.message : String(error) },
        "[BATCH_ERROR] Falha ao armar gatilho",
      );
    }
  }

  /**
   * Monitor de ciclo de vida com polling a cada LIFECYCLE_POLL_MS (padrão 5 s).
   *
   * Verifica:
   *   • Preenchimento total → marca trigger como filled, Mux-Lock já ativado
   *   • Preenchimento parcial → cancela remainder (Feature 3)
   *   • TTL expirado → para o polling
   */
  private startTriggerLifecycleMonitor(
    symbol: string,
    orderId: string,
    triggerId: string,
    signal: QuantBrainEdgeResult,
  ): void {
    if (!this.checkOrderStatusFn) return;

    const expirationSeconds = signal.geometry?.expirationSeconds ?? signal.expirationSeconds ?? 30;
    const deadline = Date.now() + expirationSeconds * 1_000 + 5_000; // grace period

    const poll = async (): Promise<void> => {
      if (Date.now() > deadline) {
        logger.debug({ symbol, orderId, triggerId }, "[LIFECYCLE] TTL encerrado — polling parado");
        return;
      }

      try {
        const status = await this.checkOrderStatusFn!(orderId, symbol);
        if (!status) {
          setTimeout(poll, LIFECYCLE_POLL_MS);
          return;
        }

        const { filledQty, origQty } = status;

        if (origQty > 0 && filledQty >= origQty) {
          logger.info(
            { symbol, orderId, triggerId, filledQty, origQty },
            "[LIFECYCLE] Ordem preenchida completamente — Mux-Lock ativado",
          );
          return;
        }

        if (filledQty > 0 && filledQty < origQty) {
          logger.warn(
            { symbol, orderId, triggerId, filledQty, origQty },
            "[LIFECYCLE] Preenchimento parcial detectado no poll — cancelando remainder via BingX",
          );
          // Cancela o remainder imediatamente — não aguarda TTL
          if (this.cancelOrderFn) {
            this.cancelOrderFn(orderId, symbol).catch((err) => {
              logger.warn({ symbol, orderId, err: String(err) }, "[LIFECYCLE] Falha ao cancelar remainder");
            });
          }
          return;
        }

        setTimeout(poll, LIFECYCLE_POLL_MS);
      } catch (err) {
        logger.warn(
          { symbol, orderId, err: err instanceof Error ? err.message : String(err) },
          "[LIFECYCLE] Erro no poll — será retentado",
        );
        setTimeout(poll, LIFECYCLE_POLL_MS);
      }
    };

    setTimeout(poll, LIFECYCLE_POLL_MS);
  }

  /** Retorna o estado interno do Mux-Lock deste orquestrador. */
  public getMuxLockState(): Readonly<MuxLockState> {
    return { ...this.muxLock };
  }

  /** Retorna a última contagem de posições abertas consultada. */
  public getActivePositionsCount(): number {
    return this.activePositionsCount;
  }
}
