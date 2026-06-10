/**
 * exhaustionTriggerManager.ts
 *
 * Gerencia ordens LIMIT armadas pelo Exhaustion Trigger system.
 *
 * Quando o QB detecta exaustão de microestrutura (1m/5m/15m) e retorna
 * executionType = "TRIGGER_LIMIT", o executeSingleOrder coloca uma ordem
 * LIMIT ao invés de MARKET — capturando a entrada no ponto matemático
 * exato de reversão.
 *
 * Este módulo:
 *   1. Registra a ordem pendente com TTL configurável (padrão 45s)
 *   2. Dispara cancelamento automático se a ordem não for preenchida
 *      dentro do prazo de expiração
 *   3. Expõe status para monitoramento e endpoints de diagnóstico
 *
 * Feature 1: Single-Fill Execution Guard (Mux-Lock)
 *   Quando qualquer gatilho é preenchido, o sistema cancela todos os outros
 *   gatilhos pendentes e bloqueia novas entradas por MUX_LOCK_CANDLES velas de 1m.
 *
 * Feature 3: Partial Fill Policy
 *   Quando o TTL dispara e a ordem foi parcialmente preenchida, o remainder
 *   é cancelado e um callback de partial fill é invocado.
 *
 * System 2: Sector Cluster Co-Movement Filter
 *   Antes de armar novo gatilho, cancela gatilhos pendentes do mesmo setor.
 *   Evita sobre-exposição por correlação de cluster (ex: NEAR+VVV ambos DEFI).
 *
 * System 3: Trigger Outcome Tagging (Feedback Loop)
 *   Persiste o desfecho de cada gatilho em trigger_outcomes.jsonl com tags
 *   EXPIRED_UNFILLED | PARTIAL_FILL_CANCELLED para retraining offline do QB.
 */

import * as nodeFs from "node:fs";
import { syncQuantBrainTriggerOutcome } from "./quantBrainClient";

// ── System 3: Non-blocking async write queue for trigger_outcomes.jsonl ──────
// PRODUÇÃO: appendFileSync bloquearia o event loop durante execução de trades.
// A fila assíncrona garante que escritas em disco NUNCA atrasem ordens.
const TRIGGER_OUTCOMES_MAX_LINES = Math.max(
  1_000,
  parseInt(process.env["TRIGGER_OUTCOMES_MAX_LINES"] ?? "50000", 10),
);

const _outcomesQueue: string[] = [];
let _outcomesFlushing = false;
let _outcomesTotalWritten = 0;

function _enqueueOutcomeWrite(outcome: Record<string, unknown>): void {
  const line = JSON.stringify(outcome);
  _outcomesQueue.push(line);
  _outcomesTotalWritten++;
  void syncQuantBrainTriggerOutcome(outcome);
  if (!_outcomesFlushing) {
    _outcomesFlushing = true;
    setImmediate(_flushOutcomesQueue);
  }
}

async function _flushOutcomesQueue(): Promise<void> {
  const batch = _outcomesQueue.splice(0);
  try {
    if (batch.length === 0) return;
    const dir = process.env["TELEMETRY_DIR"] ?? ".";
    const path = `${dir}/trigger_outcomes.jsonl`;
    await nodeFs.promises.appendFile(path, batch.join("\n") + "\n", "utf-8");
    // Rotação: verifica a cada 500 linhas escritas para evitar leituras frequentes
    if (_outcomesTotalWritten > 0 && _outcomesTotalWritten % 500 === 0) {
      await _maybeRotateOutcomesFile(path);
    }
  } catch {
    // Non-blocking — telemetry write failure must never affect trade execution
  } finally {
    _outcomesFlushing = false;
    if (_outcomesQueue.length > 0) {
      _outcomesFlushing = true;
      setImmediate(_flushOutcomesQueue);
    }
  }
}

async function _maybeRotateOutcomesFile(path: string): Promise<void> {
  try {
    // Só lê o arquivo se ele ultrapassou ~5MB (≈50k linhas de ~100 bytes)
    const stat = await nodeFs.promises.stat(path).catch(() => null);
    if (!stat || stat.size < 5 * 1024 * 1024) return;
    const content = await nodeFs.promises.readFile(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= TRIGGER_OUTCOMES_MAX_LINES) return;
    // Mantém as últimas MAX_LINES/2 entradas (comportamento de buffer circular)
    const keepLines = Math.floor(TRIGGER_OUTCOMES_MAX_LINES / 2);
    const trimmed = lines.slice(-keepLines).join("\n") + "\n";
    const tmp = `${path}.rot.tmp`;
    await nodeFs.promises.writeFile(tmp, trimmed, "utf-8");
    await nodeFs.promises.rename(tmp, path);
  } catch {
    // Rotation failure is non-fatal
  }
}

const TRIGGER_EXPIRATION_DEFAULT_MS =
  Math.max(5_000, parseInt(process.env["TRIGGER_EXPIRATION_SECONDS"] ?? "45", 10) * 1_000);

// ── Mux-Lock: Single-Fill Execution Guard ────────────────────────────────────
const MUX_LOCK_CANDLES = Math.max(1, parseInt(process.env["MUX_LOCK_CANDLES"] ?? "2", 10));
const MUX_LOCK_MS = MUX_LOCK_CANDLES * 60_000;

let _muxLockedUntil = 0;
let _muxLockReason = "";

const _cancelFns = new Map<string, () => Promise<void>>();

// ── System 2: Sector tracking ────────────────────────────────────────────────
// sectorCluster → Set<triggerId> — para cancelamento cascata por setor.
const _sectorTriggers = new Map<string, Set<string>>();

// ── System 3: Outcome tags ───────────────────────────────────────────────────
export type TriggerOutcomeTag =
  | "FILLED_AND_WON"
  | "FILLED_AND_STOPPED"
  | "EXPIRED_UNFILLED"
  | "PARTIAL_FILL_CANCELLED"
  | "SECTOR_CASCADE_CANCELLED";

export type TriggerStatus = "PENDING" | "CANCELLED" | "PRESUMED_FILLED" | "EXPIRED";
export type TriggerDirection = "LONG" | "SHORT";

export interface ExhaustionTriggerRecord {
  id: string;
  symbol: string;
  direction: TriggerDirection;
  orderId: string;
  triggerPrice: number;
  armedAt: number;
  expiresAt: number;
  status: TriggerStatus;
  cancelledReason?: string;
  exhaustionType?: string;
  partialFilledQty?: number;
  origQty?: number;
  // System 2
  sectorCluster?: string;
  // System 3
  signalId?: string;
  outcomeTag?: TriggerOutcomeTag;
}

const _triggers = new Map<string, ExhaustionTriggerRecord>();

// ── System 3: Outcome recording ──────────────────────────────────────────────
/**
 * Persiste o desfecho de um gatilho em trigger_outcomes.jsonl.
 * Usado pelo retraining offline do QB: se EXPIRED_UNFILLED é frequente
 * em determinado horário, o QB encurta a distância do trigger para aumentar
 * fill rate.
 */
export function recordTriggerOutcome(
  record: ExhaustionTriggerRecord,
  tag: TriggerOutcomeTag,
  meta?: { fillDurationMs?: number },
): void {
  try {
    const entry = {
      ts: Date.now(),
      id: record.id,
      signalId: record.signalId,
      symbol: record.symbol,
      direction: record.direction,
      sectorCluster: record.sectorCluster,
      triggerPrice: record.triggerPrice,
      expiresAt: record.expiresAt,
      armedAt: record.armedAt,
      tag,
      fillDurationMs: meta?.fillDurationMs,
    };
    // Enfileira escrita assíncrona — nunca bloqueia o event loop durante execução de trades
    _enqueueOutcomeWrite(entry);
  } catch {
    // Non-blocking — telemetry write failure must never affect execution
  }
}

/**
 * System 2: Sector Cluster Co-Movement Filter
 *
 * Cancela todos os gatilhos PENDING do mesmo sectorCluster antes de
 * armar um novo. Evita que o robô tome 3-4 stops simultâneos quando
 * moedas do mesmo nicho colapsam juntas.
 *
 * Regra: máximo 1 gatilho ativo por cluster de correlação.
 */
export function cancelSectorCascade(
  incomingSymbol: string,
  sectorCluster: string,
): { cancelled: number; ids: string[] } {
  const existingIds = _sectorTriggers.get(sectorCluster);
  if (!existingIds || existingIds.size === 0) return { cancelled: 0, ids: [] };

  const cancelled: string[] = [];
  for (const id of Array.from(existingIds)) {
    const t = _triggers.get(id);
    if (t && t.status === "PENDING" && t.symbol !== incomingSymbol) {
      t.status = "CANCELLED";
      t.cancelledReason = `SECTOR_CASCADE_CANCELLED: cluster=${sectorCluster} bloqueado por incoming=${incomingSymbol}`;
      t.outcomeTag = "SECTOR_CASCADE_CANCELLED";
      const fn = _cancelFns.get(id);
      if (fn) {
        fn().catch(() => {});
        _cancelFns.delete(id);
      }
      recordTriggerOutcome(t, "SECTOR_CASCADE_CANCELLED");
      cancelled.push(id);
    }
  }
  for (const id of cancelled) existingIds.delete(id);
  return { cancelled: cancelled.length, ids: cancelled };
}

/**
 * Registra uma ordem LIMIT recém-colocada e arma um timer de cancelamento.
 *
 * @returns ID do gatilho registrado
 */
export function armLimitOrderExpiry(params: {
  orderId: string;
  symbol: string;
  direction: TriggerDirection;
  triggerPrice: number;
  exhaustionType?: string;
  expirationMs?: number;
  cancelFn: () => Promise<void>;
  checkPartialFillFn?: () => Promise<{ filledQty: number; origQty: number } | null>;
  onPartialFill?: (filledQty: number, origQty: number) => void;
  // System 2
  sectorCluster?: string;
  // System 3
  signalId?: string;
}): string {
  const expirationMs = params.expirationMs ?? TRIGGER_EXPIRATION_DEFAULT_MS;
  const id = `${params.symbol}-${params.direction}-${params.orderId}`;
  const now = Date.now();

  const record: ExhaustionTriggerRecord = {
    id,
    symbol: params.symbol,
    direction: params.direction,
    orderId: params.orderId,
    triggerPrice: params.triggerPrice,
    armedAt: now,
    expiresAt: now + expirationMs,
    status: "PENDING",
    exhaustionType: params.exhaustionType,
    origQty: undefined,
    partialFilledQty: undefined,
    sectorCluster: params.sectorCluster,
    signalId: params.signalId,
  };

  _triggers.set(id, record);
  _cancelFns.set(id, params.cancelFn);

  // System 2: Track by sector cluster
  if (params.sectorCluster) {
    if (!_sectorTriggers.has(params.sectorCluster)) {
      _sectorTriggers.set(params.sectorCluster, new Set());
    }
    _sectorTriggers.get(params.sectorCluster)!.add(id);
  }

  setTimeout(async () => {
    const t = _triggers.get(id);
    if (!t || t.status !== "PENDING") return;

    // ── Feature 3: Partial Fill Policy ─────────────────────────────────────
    if (params.checkPartialFillFn) {
      try {
        const fillStatus = await params.checkPartialFillFn();
        if (fillStatus && fillStatus.filledQty > 0 && fillStatus.filledQty < fillStatus.origQty) {
          t.status = "EXPIRED";
          t.partialFilledQty = fillStatus.filledQty;
          t.origQty = fillStatus.origQty;
          t.cancelledReason = `PARTIAL_FILL_CANCELLED: ${fillStatus.filledQty}/${fillStatus.origQty} filled, remainder cancelled after TTL`;
          t.outcomeTag = "PARTIAL_FILL_CANCELLED";
          try {
            await params.cancelFn();
          } catch {
            // Best-effort
          }
          try {
            params.onPartialFill?.(fillStatus.filledQty, fillStatus.origQty);
          } catch {
            // Non-blocking
          }
          _cancelFns.delete(id);
          if (t.sectorCluster) _sectorTriggers.get(t.sectorCluster)?.delete(id);
          // System 3: Record partial fill outcome for QB retraining
          recordTriggerOutcome(t, "PARTIAL_FILL_CANCELLED");
          return;
        }
      } catch {
        // checkPartialFillFn failed — proceed to normal expiry
      }
    }

    t.status = "EXPIRED";
    t.cancelledReason = `TTL_EXPIRED after ${expirationMs}ms`;
    t.outcomeTag = "EXPIRED_UNFILLED";
    try {
      await params.cancelFn();
    } catch {
      // Cancellation best-effort
    }
    _cancelFns.delete(id);
    if (t.sectorCluster) _sectorTriggers.get(t.sectorCluster)?.delete(id);
    // System 3: Record expired outcome for QB retraining feedback loop
    recordTriggerOutcome(t, "EXPIRED_UNFILLED");
  }, expirationMs);

  return id;
}

/**
 * Ativa o Mux-Lock: cancela todos os outros gatilhos pendentes e bloqueia
 * novas entradas por MUX_LOCK_MS.
 */
export function activateMuxLock(reason: string): void {
  _muxLockedUntil = Date.now() + MUX_LOCK_MS;
  _muxLockReason = reason;

  const cancelPromises: Promise<void>[] = [];
  for (const [id, t] of _triggers.entries()) {
    if (t.status === "PENDING") {
      t.status = "CANCELLED";
      t.cancelledReason = `MUX_LOCK: cancelled by single-fill guard (${reason})`;
      if (t.sectorCluster) _sectorTriggers.get(t.sectorCluster)?.delete(id);
      const fn = _cancelFns.get(id);
      if (fn) {
        cancelPromises.push(fn().catch(() => {}));
        _cancelFns.delete(id);
      }
    }
  }
  Promise.allSettled(cancelPromises).catch(() => {});
}

/**
 * Retorna true se o Mux-Lock estiver ativo.
 */
export function isMuxLocked(): { locked: boolean; reason: string; remainingMs: number } {
  const now = Date.now();
  if (_muxLockedUntil > now) {
    return { locked: true, reason: _muxLockReason, remainingMs: _muxLockedUntil - now };
  }
  return { locked: false, reason: "", remainingMs: 0 };
}

/**
 * Marca um gatilho como preenchido → ativa automaticamente o Mux-Lock.
 */
export function markTriggerFilled(id: string): void {
  const t = _triggers.get(id);
  if (t && t.status === "PENDING") {
    t.status = "PRESUMED_FILLED";
    _cancelFns.delete(id);
    if (t.sectorCluster) _sectorTriggers.get(t.sectorCluster)?.delete(id);
    activateMuxLock(`filled:${t.symbol}:${t.direction}@${t.triggerPrice}`);
  }
}

/**
 * Cancela manualmente um gatilho pendente.
 */
export function cancelTrigger(id: string, reason: string): void {
  const t = _triggers.get(id);
  if (t && t.status === "PENDING") {
    t.status = "CANCELLED";
    t.cancelledReason = reason;
    if (t.sectorCluster) _sectorTriggers.get(t.sectorCluster)?.delete(id);
    const fn = _cancelFns.get(id);
    if (fn) {
      fn().catch(() => {});
      _cancelFns.delete(id);
    }
  }
}

/** Retorna todos os gatilhos ainda pendentes. */
export function getActiveTriggers(): ExhaustionTriggerRecord[] {
  return Array.from(_triggers.values()).filter((t) => t.status === "PENDING");
}

/** Retorna histórico recente de gatilhos (para diagnóstico). */
export function getTriggerHistory(limit = 50): ExhaustionTriggerRecord[] {
  const all = Array.from(_triggers.values());
  return all.slice(-limit);
}

/**
 * Gap 2 — Feedback loop FILLED_AND_WON / FILLED_AND_STOPPED.
 *
 * Chamado pelo livePositionWatcher após detectar o fechamento de uma posição live.
 * Persiste o desfecho real (TP hit → WON, SL/liquidated → STOPPED) em
 * trigger_outcomes.jsonl para que o offline_learner do QB reconcilie os outcomes
 * via kb.reconcile_signal_outcome(signalId, won=...).
 *
 * Regra de mapeamento:
 *   exitReason "TP"     → FILLED_AND_WON
 *   exitReason "SL"     → FILLED_AND_STOPPED
 *   exitReason "MANUAL" → não registrado (sem outcome de mercado definido)
 */
export function recordFillOutcome(
  signalId: string | undefined,
  symbol: string,
  direction: TriggerDirection,
  exitReason: "TP" | "SL" | "MANUAL",
  realizedPnl: number,
): void {
  if (exitReason === "MANUAL") return;
  if (!signalId) return;

  const tag: TriggerOutcomeTag = exitReason === "TP" ? "FILLED_AND_WON" : "FILLED_AND_STOPPED";
  try {
    const entry = {
      ts: Date.now(),
      signalId,
      symbol,
      direction,
      tag,
      realizedPnl,
    };
    _enqueueOutcomeWrite(entry);
  } catch {
    // Non-blocking — telemetry write failure must never affect trade execution
  }
}

/**
 * Retorna estatísticas agregadas de todos os gatilhos registrados nesta sessão.
 */
export function getTriggerStats(): {
  totalArmed: number;
  pending: number;
  presumedFilled: number;
  expired: number;
  cancelled: number;
  sectorCascadeCancelled: number;
  fillRate: number;
  expiryRate: number;
  recentHistory: ExhaustionTriggerRecord[];
  muxLock: { locked: boolean; reason: string; remainingMs: number };
  activeSectors: Record<string, number>;
} {
  const all = Array.from(_triggers.values());
  const pending = all.filter((t) => t.status === "PENDING").length;
  const filled = all.filter((t) => t.status === "PRESUMED_FILLED").length;
  const expired = all.filter((t) => t.status === "EXPIRED").length;
  const cancelled = all.filter((t) => t.status === "CANCELLED").length;
  const sectorCascadeCancelled = all.filter((t) => t.outcomeTag === "SECTOR_CASCADE_CANCELLED").length;
  const resolved = filled + expired + cancelled;
  // Active sector counts for monitoring
  const activeSectors: Record<string, number> = {};
  for (const [sector, ids] of _sectorTriggers.entries()) {
    if (ids.size > 0) activeSectors[sector] = ids.size;
  }
  return {
    totalArmed: all.length,
    pending,
    presumedFilled: filled,
    expired,
    cancelled,
    sectorCascadeCancelled,
    fillRate: resolved > 0 ? filled / resolved : 0,
    expiryRate: resolved > 0 ? expired / resolved : 0,
    recentHistory: all.slice(-20),
    muxLock: isMuxLocked(),
    activeSectors,
  };
}

/** Remove registros antigos (não-pendentes com mais de 10 minutos). */
function cleanupOldTriggers(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, t] of _triggers.entries()) {
    if (t.status !== "PENDING" && t.armedAt < cutoff) {
      _triggers.delete(id);
      _cancelFns.delete(id);
    }
  }
}

setInterval(cleanupOldTriggers, 60_000);
