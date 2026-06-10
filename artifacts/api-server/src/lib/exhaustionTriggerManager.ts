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
 */

const TRIGGER_EXPIRATION_DEFAULT_MS =
  Math.max(5_000, parseInt(process.env["TRIGGER_EXPIRATION_SECONDS"] ?? "45", 10) * 1_000);

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
}

const _triggers = new Map<string, ExhaustionTriggerRecord>();

/**
 * Registra uma ordem LIMIT recém-colocada e arma um timer de cancelamento.
 *
 * O `cancelFn` deve chamar a API do exchange para cancelar a ordem se ela
 * ainda estiver aberta no momento da expiração.
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
  };

  _triggers.set(id, record);

  setTimeout(async () => {
    const t = _triggers.get(id);
    if (!t || t.status !== "PENDING") return;
    t.status = "EXPIRED";
    t.cancelledReason = `TTL_EXPIRED after ${expirationMs}ms`;
    try {
      await params.cancelFn();
    } catch {
      // Cancellation best-effort — order may have already filled or been rejected
    }
  }, expirationMs);

  return id;
}

/**
 * Marca um gatilho como preenchido (chamado quando a posição é confirmada).
 */
export function markTriggerFilled(id: string): void {
  const t = _triggers.get(id);
  if (t && t.status === "PENDING") {
    t.status = "PRESUMED_FILLED";
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
  };
}

/** Remove registros antigos (não-pendentes com mais de 10 minutos). */
function cleanupOldTriggers(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, t] of _triggers.entries()) {
    if (t.status !== "PENDING" && t.armedAt < cutoff) {
      _triggers.delete(id);
    }
  }
}

setInterval(cleanupOldTriggers, 60_000);
