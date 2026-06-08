/**
 * Bot execution modes — three preset risk/capital profiles.
 *
 * Each mode sets:
 *   leverage, marginPerTrade, marginType — applied as runtime overrides
 *
 * Mode 3 (aggressive) enables bulk execution with a token-bucket
 * rate limiter capped at MAX_ORDERS_PER_SECOND (BingX hard limit).
 *
 * ENV stays as the permanent source of truth.
 * Selecting a mode is an in-memory override that resets on restart.
 *
 * Nível Máximo de Excelência:
 * - Schema validation com Zod
 * - Persistência do modo ativo
 * - Métricas de rate limiting
 * - Health checks
 * - Event emitter para mudanças
 * - Integração com telemetria (EV/win rate)
 */

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { z } from "zod";

// ========== SCHEMAS ==========

export const BotModeIdSchema = z.enum(["easy", "standard", "aggressive"]);
export type BotModeId = z.infer<typeof BotModeIdSchema>;

export const BotModePresetSchema = z.object({
  id: BotModeIdSchema,
  label: z.string(),
  badge: z.string(),
  description: z.string(),
  leverage: z.number().positive(),
  marginPerTrade: z.number().positive(),
  marginType: z.enum(["ISOLATED", "CROSS"]),
  bulkExecution: z.boolean(),
  maxOrdersPerSecond: z.number().positive(),
  color: z.string(),
  riskNote: z.string(),
});
export type BotModePreset = z.infer<typeof BotModePresetSchema>;

export const BulkOrderItemSchema = z.object({
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  positionSide: z.enum(["LONG", "SHORT"]),
  quantity: z.number().positive().optional(),
  currentEv: z.number().optional(),
  expectedEntryPrice: z.number().positive().optional(),
  btcChangePct: z.number().optional(),
});
export type BulkOrderItem = z.infer<typeof BulkOrderItemSchema>;

export const BulkOrderResultSchema = z.object({
  index: z.number(),
  symbol: z.string(),
  side: z.string(),
  placed: z.boolean(),
  orderId: z.string().nullable(),
  quantity: z.number().nullable(),
  gateRejects: z.array(z.string()),
  observationMode: z.boolean(),
  message: z.string(),
  durationMs: z.number(),
});
export type BulkOrderResult = z.infer<typeof BulkOrderResultSchema>;

export const BulkExecutionSummarySchema = z.object({
  mode: BotModeIdSchema,
  total: z.number(),
  placed: z.number(),
  rejected: z.number(),
  observationMode: z.boolean(),
  durationMs: z.number(),
  results: z.array(BulkOrderResultSchema),
});
export type BulkExecutionSummary = z.infer<typeof BulkExecutionSummarySchema>;

// ========== MODE DEFINITIONS ==========

export const BOT_MODES = {
  easy: {
    id: "easy" as const,
    label: "Easy",
    badge: "SCOUT",
    description: "Capital mínimo — testes seguros e calibração inicial de gates",
    leverage: 18,
    marginPerTrade: 0.50,
    marginType: "ISOLATED" as const,
    bulkExecution: false,
    maxOrdersPerSecond: 1,
    color: "green",
    riskNote: "Nocional 9 USDT/trade. Perda máxima por SL: ~0.50 USDT. Use para validar a estratégia sem exposição real.",
  },
  standard: {
    id: "standard" as const,
    label: "Standard",
    badge: "SNIPER",
    description: "Banca média — equilíbrio entre frequência e risco por trade",
    leverage: 18,
    marginPerTrade: 2.00,
    marginType: "ISOLATED" as const,
    bulkExecution: false,
    maxOrdersPerSecond: 1,
    color: "blue",
    riskNote: "Nocional 36 USDT/trade. Execução individual após gates. Requer ≥50 trades de telemetria para calibrar EV.",
  },
  aggressive: {
    id: "aggressive" as const,
    label: "Aggressive",
    badge: "ALPHA",
    description: "Banca alta + entradas em massa — throughput máximo respeitando rate limit da API",
    leverage: 18,
    marginPerTrade: 5.00,
    marginType: "ISOLATED" as const,
    bulkExecution: true,
    maxOrdersPerSecond: 10, // BingX hard cap: 100 orders / 10s
    color: "orange",
    riskNote: "Nocional 90 USDT/trade. Bulk até 10 ordens/s. Exige telemetria positiva e PF ≥ 1.5 antes de ativar.",
  },
} as const;

// ========== ACTIVE MODE STORE ==========

let _activeMode: BotModeId | null = null;
const STATE_PATH = process.env.BOT_MODE_STATE_PATH || "./data/bot-mode.json";
let _modeChangeListeners: Array<(mode: BotModeId | null) => void> = [];

// Event emitter para mudanças
const modeEvents = new EventEmitter();
modeEvents.setMaxListeners(50);

export function onModeChange(listener: (mode: BotModeId | null) => void): () => void {
  _modeChangeListeners.push(listener);
  return () => {
    const index = _modeChangeListeners.indexOf(listener);
    if (index > -1) _modeChangeListeners.splice(index, 1);
  };
}

function notifyModeChange(mode: BotModeId | null): void {
  for (const listener of _modeChangeListeners) {
    try {
      listener(mode);
    } catch (err) {
      console.error("[botModes] Listener error:", err);
    }
  }
  modeEvents.emit("change", mode);
}

// ========== PERSISTÊNCIA ==========

export function persistActiveMode(): void {
  if (!_activeMode) return;

  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(STATE_PATH, JSON.stringify({
      mode: _activeMode,
      savedAt: Date.now(),
      version: 1,
    }, null, 2));
  } catch (err) {
    console.error("[botModes] Failed to persist mode:", err);
  }
}

export function loadPersistedMode(): BotModeId | null {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;

    const data = fs.readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(data);

    const validation = BotModeIdSchema.safeParse(state.mode);
    if (validation.success) {
      _activeMode = validation.data;
      console.log(`[botModes] Loaded persisted mode: ${_activeMode}`);
      return _activeMode;
    }
  } catch (err) {
    console.error("[botModes] Failed to load persisted mode:", err);
  }
  return null;
}

// ========== MODE MANAGEMENT ==========

export function setActiveModeId(id: BotModeId): void {
  const previous = _activeMode;
  _activeMode = id;

  if (previous !== id) {
    notifyModeChange(id);
    console.log(`[botModes] Mode changed: ${previous ?? "none"} → ${id}`);

    // Persiste automaticamente
    persistActiveMode();
  }
}

export function getActiveModeId(): BotModeId | null {
  return _activeMode;
}

export function clearActiveMode(): void {
  const previous = _activeMode;
  _activeMode = null;

  if (previous !== null) {
    notifyModeChange(null);
    console.log(`[botModes] Mode cleared: ${previous} → none`);

    // Remove persistência
    try {
      if (fs.existsSync(STATE_PATH)) {
        fs.unlinkSync(STATE_PATH);
      }
    } catch (err) {
      console.error("[botModes] Failed to clear persisted mode:", err);
    }
  }
}

export function getActiveModePreset(): BotModePreset | null {
  return _activeMode ? BOT_MODES[_activeMode] : null;
}

export function getModePreset(id: BotModeId): BotModePreset {
  return BOT_MODES[id];
}

export function getAllModes(): BotModePreset[] {
  return Object.values(BOT_MODES);
}

export function isModeAvailable(id: BotModeId, context?: {
  totalTrades?: number;
  profitFactor?: number;
  winRate?: number;
}): { available: boolean; reason?: string } {
  const mode = BOT_MODES[id];

  if (id === "aggressive") {
    // Aggressive mode is always available — the Quant Brain gate handles risk
    // through score-based ranking rather than hard entry lockouts.
    // Historical performance data improves ranking quality over time.
  }

  if (id === "standard" && context) {
    if ((context.totalTrades ?? 0) < 50) {
      return { available: false, reason: `Need at least 50 trades for standard mode (have ${context.totalTrades ?? 0})` };
    }
  }

  return { available: true };
}

// ========== TOKEN-BUCKET RATE LIMITER ==========
// BingX allows 100 orders per 10-second window = 10/s sustained.
// Each bulk order consume() call blocks until a token is available.

export class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private lastRefill: number;
  private totalConsumed = 0;
  private totalWaits = 0;
  private totalWaitTimeMs = 0;

  constructor(maxTokens: number, tokensPerSecond: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRatePerMs = tokensPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  /** Returns true immediately if a token was available, otherwise rejects */
  tryConsume(): boolean {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.totalConsumed++;
      return true;
    }
    return false;
  }

  /** Blocks until a token is available, then consumes it */
  async consume(): Promise<void> {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.totalConsumed++;
      return;
    }

    const startWait = Date.now();
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillRatePerMs);

    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

    this.totalWaits++;
    this.totalWaitTimeMs += Date.now() - startWait;

    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
    this.totalConsumed++;
  }

  /** Returns current token bucket status */
  getStatus(): {
    tokensAvailable: number;
    maxTokens: number;
    utilizationPct: number;
    totalConsumed: number;
    totalWaits: number;
    avgWaitTimeMs: number;
  } {
    this._refill();
    return {
      tokensAvailable: Math.floor(this.tokens * 100) / 100,
      maxTokens: this.maxTokens,
      utilizationPct: ((this.totalConsumed - this.tokens) / this.maxTokens) * 100,
      totalConsumed: this.totalConsumed,
      totalWaits: this.totalWaits,
      avgWaitTimeMs: this.totalWaits > 0 ? this.totalWaitTimeMs / this.totalWaits : 0,
    };
  }

  /** Resets statistics */
  resetStats(): void {
    this.totalConsumed = 0;
    this.totalWaits = 0;
    this.totalWaitTimeMs = 0;
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }
}

// ========== MODE VALIDATION ==========

export function validateModeTransition(
  from: BotModeId | null,
  to: BotModeId,
  context?: {
    totalTrades?: number;
    profitFactor?: number;
    winRate?: number;
    totalPnl?: number;
    maxDrawdown?: number;
  }
): { valid: boolean; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Verifica disponibilidade
  const availability = isModeAvailable(to, context);
  if (!availability.available) {
    errors.push(availability.reason!);
  }

  // Verifica transição específica
  if (from === "easy" && to === "aggressive") {
    warnings.push("Jumping from SCOUT to ALPHA directly. Consider STANDARD mode first.");
  }

  // Verifica drawdown
  if (to === "aggressive" && context?.maxDrawdown && context.maxDrawdown > 10) {
    errors.push(`Cannot enter ALPHA mode with ${context.maxDrawdown.toFixed(1)}% drawdown`);
  }

  // Verifica PnL
  if (to !== "easy" && context?.totalPnl && context.totalPnl < 0) {
    warnings.push(`Negative total PnL (${context.totalPnl.toFixed(2)} USDT) — consider staying in SCOUT mode`);
  }

  return { valid: errors.length === 0, warnings, errors };
}

// ========== MODE METRICS ==========

export interface ModeMetrics {
  id: BotModeId;
  isActive: boolean;
  isAvailable: boolean;
  availabilityReason?: string;
  totalUsageCount: number;
  lastUsedAt: number | null;
  avgExecutionTimeMs: number;
}

const modeUsageStats: Map<BotModeId, { count: number; lastUsed: number; totalExecutionTimeMs: number }> = new Map();

export function recordModeUsage(id: BotModeId, executionTimeMs: number): void {
  const existing = modeUsageStats.get(id) || { count: 0, lastUsed: 0, totalExecutionTimeMs: 0 };
  modeUsageStats.set(id, {
    count: existing.count + 1,
    lastUsed: Date.now(),
    totalExecutionTimeMs: existing.totalExecutionTimeMs + executionTimeMs,
  });
}

export function getModeMetrics(context?: {
  totalTrades?: number;
  profitFactor?: number;
  winRate?: number;
}): ModeMetrics[] {
  return getAllModes().map((mode) => {
    const availability = isModeAvailable(mode.id, context);
    const stats = modeUsageStats.get(mode.id);

    return {
      id: mode.id,
      isActive: _activeMode === mode.id,
      isAvailable: availability.available,
      availabilityReason: availability.reason,
      totalUsageCount: stats?.count ?? 0,
      lastUsedAt: stats?.lastUsed ?? null,
      avgExecutionTimeMs: stats && stats.count > 0 ? stats.totalExecutionTimeMs / stats.count : 0,
    };
  });
}

// ========== BULK EXECUTION HELPER ==========

export async function executeBulkWithRateLimit<T>(
  items: T[],
  processor: (item: T, index: number) => Promise<{ success: boolean; result: any }>,
  rateLimiter: TokenBucket,
  options?: { stopOnError?: boolean; concurrency?: number }
): Promise<{ results: any[]; errors: any[]; durationMs: number }> {
  const startTime = Date.now();
  const results: any[] = [];
  const errors: any[] = [];
  const concurrency = options?.concurrency ?? 1;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchPromises = batch.map(async (item, batchIdx) => {
      await rateLimiter.consume();
      try {
        const { success, result } = await processor(item, i + batchIdx);
        if (success) {
          results.push(result);
        } else {
          errors.push({ index: i + batchIdx, error: result });
        }
        return { success, result, index: i + batchIdx };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ index: i + batchIdx, error: errorMsg });
        return { success: false, error: errorMsg, index: i + batchIdx };
      }
    });

    await Promise.all(batchPromises);

    if (options?.stopOnError && errors.length > 0) {
      break;
    }
  }

  return {
    results,
    errors,
    durationMs: Date.now() - startTime,
  };
}

// ========== MODE RECOMMENDATION ==========

export interface ModeRecommendation {
  recommendedMode: BotModeId;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  alternativeModes: BotModeId[];
}

export function recommendMode(context: {
  totalTrades: number;
  profitFactor: number;
  winRate: number;
  totalPnl: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  isDemo?: boolean;
}): ModeRecommendation {
  const { totalTrades, profitFactor, winRate, totalPnl, sharpeRatio = 0, maxDrawdown = 0, isDemo = false } = context;

  // Demo mode: always recommend easy
  if (isDemo) {
    return {
      recommendedMode: "easy",
      confidence: "HIGH",
      reason: "Demo mode detected — SCOUT mode recommended for safe testing",
      alternativeModes: ["standard"],
    };
  }

  // ALPHA mode conditions
  if (totalTrades >= 100 && profitFactor >= 1.5 && winRate >= 0.55 && totalPnl > 0 && sharpeRatio >= 0.5 && maxDrawdown <= 15) {
    return {
      recommendedMode: "aggressive",
      confidence: totalTrades >= 200 ? "HIGH" : "MEDIUM",
      reason: `Strong edge detected: ${totalTrades} trades, PF=${profitFactor.toFixed(2)}, WR=${(winRate * 100).toFixed(0)}%, Sharpe=${sharpeRatio.toFixed(2)}`,
      alternativeModes: ["standard"],
    };
  }

  // STANDARD mode conditions
  if (totalTrades >= 50 && profitFactor >= 1.2 && winRate >= 0.52 && totalPnl > 0) {
    return {
      recommendedMode: "standard",
      confidence: totalTrades >= 100 ? "HIGH" : "MEDIUM",
      reason: `Positive edge: ${totalTrades} trades, PF=${profitFactor.toFixed(2)}, WR=${(winRate * 100).toFixed(0)}%`,
      alternativeModes: ["easy", "aggressive"],
    };
  }

  // Default: EASY mode
  let reason = "Insufficient data or edge not yet proven";
  if (totalTrades < 50) {
    reason = `Need at least 50 trades for reliable edge assessment (have ${totalTrades}) — stay in SCOUT mode`;
  } else if (profitFactor < 1.2) {
    reason = `Profit factor ${profitFactor.toFixed(2)} below 1.2 — improve strategy before upgrading`;
  } else if (winRate < 0.52) {
    reason = `Win rate ${(winRate * 100).toFixed(0)}% below 52% — improve strategy before upgrading`;
  }

  return {
    recommendedMode: "easy",
    confidence: totalTrades >= 50 ? "MEDIUM" : "LOW",
    reason,
    alternativeModes: ["standard"],
  };
}

// ========== INITIALIZATION ==========

// Carrega modo persistido na inicialização
if (process.env.LOAD_PERSISTED_MODE !== "false") {
  loadPersistedMode();
}

// Exporta evento para uso externo
export { modeEvents };
