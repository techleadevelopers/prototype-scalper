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
 *   Isso evita correlação de posições simultâneas no mesmo movimento de mercado.
 *
 * Feature 3: Partial Fill Policy
 *   Quando o TTL dispara e a ordem foi parcialmente preenchida, o remainder
 *   é cancelado e um callback de partial fill é invocado para que o caller
 *   ajuste TP/SL proporcionalmente ao tamanho executado.
 */

const TRIGGER_EXPIRATION_DEFAULT_MS =
  Math.max(5_000, parseInt(process.env["TRIGGER_EXPIRATION_SECONDS"] ?? "45", 10) * 1_000);

// ── Mux-Lock: Single-Fill Execution Guard ────────────────────────────────────
// Após qualquer fill, bloqueia novas entradas por MUX_LOCK_CANDLES × 60s.
// Configurável via env MUX_LOCK_CANDLES (padrão: 2).
const MUX_LOCK_CANDLES = Math.max(1, parseInt(process.env["MUX_LOCK_CANDLES"] ?? "2", 10));
const MUX_LOCK_MS = MUX_LOCK_CANDLES * 60_000;

let _muxLockedUntil = 0;
let _muxLockReason = "";

// Internal cancelFn store (not exposed in public record interface)
const _cancelFns = new Map<string, () => Promise<void>>();

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
}

const _triggers = new Map<string, ExhaustionTriggerRecord>();

/**
 * Registra uma ordem LIMIT recém-colocada e arma um timer de cancelamento.
 *
 * O `cancelFn` deve chamar a API do exchange para cancelar a ordem se ela
 * ainda estiver aberta no momento da expiração.
 *
 * Feature 3: `checkPartialFillFn` (opcional) — chamado quando o TTL dispara.
 * Se retornar filledQty > 0, loga como PARTIAL_FILL_CANCELLED e invoca
 * `onPartialFill` para que o caller ajuste TP/SL proporcionalmente.
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
  };

  _triggers.set(id, record);
  _cancelFns.set(id, params.cancelFn);

  setTimeout(async () => {
    const t = _triggers.get(id);
    if (!t || t.status !== "PENDING") return;

    // ── Feature 3: Partial Fill Policy ─────────────────────────────────────
    // Antes de expirar, verifica se a ordem foi parcialmente preenchida.
    // Se sim, cancela o restante e notifica o caller para ajustar TP/SL.
    if (params.checkPartialFillFn) {
      try {
        const fillStatus = await params.checkPartialFillFn();
        if (fillStatus && fillStatus.filledQty > 0 && fillStatus.filledQty < fillStatus.origQty) {
          t.status = "EXPIRED";
          t.partialFilledQty = fillStatus.filledQty;
          t.origQty = fillStatus.origQty;
          t.cancelledReason = `PARTIAL_FILL_CANCELLED: ${fillStatus.filledQty}/${fillStatus.origQty} filled, remainder cancelled after TTL`;
          try {
            await params.cancelFn();
          } catch {
            // Best-effort
          }
          // Notify caller to resize TP/SL proportionally
          try {
            params.onPartialFill?.(fillStatus.filledQty, fillStatus.origQty);
          } catch {
            // Non-blocking
          }
          _cancelFns.delete(id);
          return;
        }
      } catch {
        // checkPartialFillFn failed — proceed to normal expiry
      }
    }

    t.status = "EXPIRED";
    t.cancelledReason = `TTL_EXPIRED after ${expirationMs}ms`;
    try {
      await params.cancelFn();
    } catch {
      // Cancellation best-effort — order may have already filled or been rejected
    }
    _cancelFns.delete(id);
  }, expirationMs);

  return id;
}

/**
 * Ativa o Mux-Lock: cancela todos os outros gatilhos pendentes e bloqueia
 * novas entradas por MUX_LOCK_MS (padrão: 2 velas de 1m = 2 minutos).
 *
 * Chamado internamente quando um gatilho é marcado como preenchido.
 */
export function activateMuxLock(reason: string): void {
  _muxLockedUntil = Date.now() + MUX_LOCK_MS;
  _muxLockReason = reason;

  // Cancel all OTHER pending triggers immediately
  const cancelPromises: Promise<void>[] = [];
  for (const [id, t] of _triggers.entries()) {
    if (t.status === "PENDING") {
      t.status = "CANCELLED";
      t.cancelledReason = `MUX_LOCK: cancelled by single-fill guard (${reason})`;
      const fn = _cancelFns.get(id);
      if (fn) {
        cancelPromises.push(fn().catch(() => {}));
        _cancelFns.delete(id);
      }
    }
  }
  // Fire-and-forget cancellations
  Promise.allSettled(cancelPromises).catch(() => {});
}

/**
 * Retorna true se o Mux-Lock estiver ativo (bloqueando novas entradas).
 */
export function isMuxLocked(): { locked: boolean; reason: string; remainingMs: number } {
  const now = Date.now();
  if (_muxLockedUntil > now) {
    return {
      locked: true,
      reason: _muxLockReason,
      remainingMs: _muxLockedUntil - now,
    };
  }
  return { locked: false, reason: "", remainingMs: 0 };
}

/**
 * Marca um gatilho como preenchido (chamado quando a posição é confirmada).
 *
 * Feature 1: Ao marcar como filled, ativa automaticamente o Mux-Lock,
 * cancelando todos os outros gatilhos pendentes e bloqueando novas entradas.
 */
export function markTriggerFilled(id: string): void {
  const t = _triggers.get(id);
  if (t && t.status === "PENDING") {
    t.status = "PRESUMED_FILLED";
    _cancelFns.delete(id);
    // ── Feature 1: Single-Fill Execution Guard ────────────────────────────
    // Fill confirmado → ativa mux lock por MUX_LOCK_CANDLES velas de 1m.
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
    const fn = _cancelFns.get(id);
    if (fn) {
      fn().catch(() => {});
      _cancelFns.delete(id);
    }
  }
}

/** Retorna todos os gatilhos ainda pendentes (não expirados nem preenchidos). */
export function getActiveTriggers(): ExhaustionTriggerRecord[] {
  return Array.from(_triggers.values()).filter((t) => t.status === "PENDING");
}

/** Retorna histórico recente de gatilhos (para diagnóstico). */
export function getTriggerHistory(limit = 50): ExhaustionTriggerRecord[] {
  const all = Array.from(_triggers.values());
  return all.slice(-limit);
}

/**
 * Retorna estatísticas agregadas de todos os gatilhos registrados nesta sessão.
 * Usado pelo endpoint /api/sniper/pnl/report para calcular fill rate real.
 */
export function getTriggerStats(): {
  totalArmed: number;
  pending: number;
  presumedFilled: number;
  expired: number;
  cancelled: number;
  fillRate: number;
  expiryRate: number;
  recentHistory: ExhaustionTriggerRecord[];
  muxLock: { locked: boolean; reason: string; remainingMs: number };
} {
  const all = Array.from(_triggers.values());
  const pending = all.filter((t) => t.status === "PENDING").length;
  const filled = all.filter((t) => t.status === "PRESUMED_FILLED").length;
  const expired = all.filter((t) => t.status === "EXPIRED").length;
  const cancelled = all.filter((t) => t.status === "CANCELLED").length;
  const resolved = filled + expired + cancelled;
  return {
    totalArmed: all.length,
    pending,
    presumedFilled: filled,
    expired,
    cancelled,
    fillRate: resolved > 0 ? filled / resolved : 0,
    expiryRate: resolved > 0 ? expired / resolved : 0,
    recentHistory: all.slice(-20),
    muxLock: isMuxLocked(),
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
