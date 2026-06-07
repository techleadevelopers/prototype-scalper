import { getActiveModeId } from "./botModes";
import { z } from "zod";
import fs from "fs";
import path from "path";

/**
 * Bot configuration — ENV is the source of truth.
 * Runtime overrides (applied via PATCH /api/bot/config) take precedence
 * over ENV values and persist in memory until server restart.
 * Override keys must be a subset of the config object keys.
 *
 * Nível Máximo de Excelência:
 * - Schema validation com Zod
 * - Config versioning
 * - Hot reload support
 * - Quant Brain integration
 * - Audit logging
 * - Default cascade hierarchy
 */

// ========== SCHEMA VALIDATION ==========

export const BotConfigSchema = z.object({
  leverage: z.number().min(1).max(100).default(14),
  marginPerTrade: z.number().min(0.1).max(100).default(5),
  maxConcurrentPositions: z.number().min(1).max(50).default(10),
  maxMarginUtilization: z.number().min(0.1).max(1).default(0.5),
  takeProfitPct: z.number().min(0.05).max(5).default(0.15),
  stopLossPct: z.number().min(0.05).max(5).default(0.10),
  evMinThreshold: z.number().min(-1).max(10).default(0),
  winRateMin: z.number().min(0).max(1).default(0),
  profitFactorMin: z.number().min(0).max(10).default(0),
  btcRegimeRequired: z.boolean().default(false),
  allowCounterRegimeScalp: z.boolean().default(true),
  btcRegimeThresholdPct: z.number().min(0.1).max(5).default(0.5),
  allowedSymbols: z.array(z.string()).default([]),
  hourBlacklist: z.array(z.number().min(0).max(23)).default([]),
  orderType: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
  marginType: z.enum(["ISOLATED", "CROSS"]).default("ISOLATED"),
  allowExecution: z.boolean().default(false),
  maxSessionLoss: z.number().min(0).max(500).default(20),
  takerFeeBps: z.number().min(0).max(50).default(5),
  slippageBpsPerSide: z.number().min(0).max(50).default(2),
  estimatedFundingCostPct: z.number().min(0).max(5).default(0),
  minEdgeOverCostPct: z.number().min(0).max(1).default(0.03),
  signalDedupeSeconds: z.number().min(5).max(300).default(30),
  signalSourceType: z.enum(["hypothetical", "live"]).default("hypothetical"),
  requireFull15mContext: z.boolean().default(true),
  maxDailyLossPct: z.number().min(0).max(100).default(0),
  maxDrawdownPct: z.number().min(0).max(100).default(0),
  maxConsecutiveLosses: z.number().min(0).max(50).default(0),
  recentEdgeWindowHours: z.number().min(1).max(24).default(4),
  recentEdgeMinTrades: z.number().min(1).max(100).default(8),
  recentEdgeMinProfitFactor: z.number().min(0).max(10).default(0.8),
  recentEdgeMaxConsecutiveLosses: z.number().min(1).max(20).default(4),
  candleMinScore: z.number().min(0).max(1).default(0.5),
  candleMinSeparation: z.number().min(0).max(1).default(0.08),
  attachProtectionOrders: z.boolean().default(true),
  preventHedgedPositions: z.boolean().default(true),
  quantBrainGateMode: z.enum(["shadow", "enforce", "off"]).default("shadow"),
  loadedAt: z.string(),
  hasOverrides: z.boolean(),
  activeOverrides: z.array(z.string()),
  activeMode: z.string().nullable(),
  configVersion: z.number().default(1),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

// ========== ENVIRONMENT HELPERS ==========

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

function envList(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function envIntList(key: string, fallback: number[]): number[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
}

// ========== RUNTIME OVERRIDES ==========

export type ConfigOverrideKey = keyof Omit<BotConfig,
  "loadedAt" | "hasOverrides" | "activeOverrides" | "activeMode" | "configVersion"
>;

type OverrideStore = Partial<Record<ConfigOverrideKey, unknown>>;

const _overrides: OverrideStore = {};
const _overrideHistory: Array<{ timestamp: number; patch: OverrideStore }> = [];

// Config change listeners
type ConfigChangeListener = (config: BotConfig) => void;
const _listeners: ConfigChangeListener[] = [];

export function onConfigChange(listener: ConfigChangeListener): () => void {
  _listeners.push(listener);
  return () => {
    const index = _listeners.indexOf(listener);
    if (index > -1) _listeners.splice(index, 1);
  };
}

function notifyListeners(config: BotConfig): void {
  for (const listener of _listeners) {
    try {
      listener(config);
    } catch (err) {
      console.error("[botConfig] Listener error:", err);
    }
  }
}

// ========== OVERRIDE MANAGEMENT ==========

export function setConfigOverrides(patch: OverrideStore): void {
  // Validação antes de aplicar
  const validatedPatch: OverrideStore = {};

  for (const [key, value] of Object.entries(patch)) {
    const configKey = key as ConfigOverrideKey;
    const currentConfig = getRawConfig();

    // Valida tipo do valor
    const currentValue = (currentConfig as Record<ConfigOverrideKey, unknown>)[configKey];
    if (typeof value !== typeof currentValue && currentValue !== undefined) {
      console.warn(`[botConfig] Type mismatch for ${key}: expected ${typeof currentValue}, got ${typeof value}`);
      continue;
    }

    validatedPatch[configKey] = value;
  }

  Object.assign(_overrides, validatedPatch);

  // Registra no histórico
  _overrideHistory.push({
    timestamp: Date.now(),
    patch: { ...validatedPatch },
  });

  // Mantém apenas últimos 100 históricos
  while (_overrideHistory.length > 100) {
    _overrideHistory.shift();
  }

  // Notifica listeners
  const newConfig = getBotConfig();
  notifyListeners(newConfig);

  // Log para auditoria
  console.log(`[botConfig] Overrides applied: ${Object.keys(validatedPatch).join(", ")}`);
}

export function resetConfigOverrides(): void {
  const clearedKeys = Object.keys(_overrides) as ConfigOverrideKey[];

  for (const key of clearedKeys) {
    delete _overrides[key];
  }

  // Registra reset no histórico
  _overrideHistory.push({
    timestamp: Date.now(),
    patch: { _reset: true } as any,
  });

  // Notifica listeners
  const newConfig = getBotConfig();
  notifyListeners(newConfig);

  console.log(`[botConfig] Overrides cleared: ${clearedKeys.join(", ")}`);
}

export function getConfigOverrides(): OverrideStore {
  return { ..._overrides };
}

export function getOverrideHistory(): Array<{ timestamp: number; patch: OverrideStore }> {
  return [..._overrideHistory];
}

function ov<T>(key: ConfigOverrideKey, envValue: T): T {
  return key in _overrides ? (_overrides[key] as T) : envValue;
}

// ========== PERSISTENT STORAGE (OPTIONAL) ==========

const CONFIG_STATE_PATH = process.env.CONFIG_STATE_PATH || "./data/config-state.json";

export function persistConfigState(): void {
  try {
    const dir = path.dirname(CONFIG_STATE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const state = {
      overrides: _overrides,
      savedAt: Date.now(),
      version: 1,
    };

    fs.writeFileSync(CONFIG_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[botConfig] Failed to persist config state:", err);
  }
}

export function loadPersistedConfigState(): void {
  if (!process.env.LOAD_PERSISTED_CONFIG || process.env.LOAD_PERSISTED_CONFIG !== "true") {
    return;
  }

  try {
    if (fs.existsSync(CONFIG_STATE_PATH)) {
      const data = fs.readFileSync(CONFIG_STATE_PATH, "utf-8");
      const state = JSON.parse(data);

      if (state.overrides && typeof state.overrides === "object") {
        Object.assign(_overrides, state.overrides);
        console.log(`[botConfig] Loaded persisted config from ${CONFIG_STATE_PATH}`);
      }
    }
  } catch (err) {
    console.error("[botConfig] Failed to load persisted config:", err);
  }
}

// ========== QUANT BRAIN SYNC ==========

let _lastQuantBrainSync = 0;
let _quantBrainConfigCache: Partial<BotConfig> | null = null;

export async function syncWithQuantBrain(quantBrainUrl: string, apiToken?: string): Promise<boolean> {
  if (!quantBrainUrl) return false;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiToken) {
      headers["X-Quant-Brain-Token"] = apiToken;
    }

    const response = await fetch(`${quantBrainUrl}/edge/config/recommendations`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return false;

    const data = await response.json() as {
      recommendations?: Partial<Record<ConfigOverrideKey, unknown>>;
    };
    const recommendations = data.recommendations || {};

    // Aplica recomendações do Quant Brain
    const patch: OverrideStore = {};

    if (recommendations.leverage) patch.leverage = recommendations.leverage;
    if (recommendations.marginPerTrade) patch.marginPerTrade = recommendations.marginPerTrade;
    if (recommendations.takeProfitPct) patch.takeProfitPct = recommendations.takeProfitPct;
    if (recommendations.stopLossPct) patch.stopLossPct = recommendations.stopLossPct;

    if (Object.keys(patch).length > 0) {
      setConfigOverrides(patch);
      _quantBrainConfigCache = patch as Partial<BotConfig>;
    }

    _lastQuantBrainSync = Date.now();
    return true;
  } catch (err) {
    console.error("[botConfig] Quant Brain sync failed:", err);
    return false;
  }
}

export function getQuantBrainSyncStatus(): { lastSync: number; hasCache: boolean } {
  return {
    lastSync: _lastQuantBrainSync,
    hasCache: _quantBrainConfigCache !== null,
  };
}

// ========== RAW CONFIG (WITHOUT DERIVED FIELDS) ==========

function getRawConfig(): Omit<BotConfig, "loadedAt" | "hasOverrides" | "activeOverrides" | "activeMode" | "configVersion"> {
  return {
    leverage:               ov("leverage",               envNum("SCALP_LEVERAGE", 14)),
    marginPerTrade:         ov("marginPerTrade",         envNum("SCALP_MARGIN_PER_TRADE", 5)),
    maxConcurrentPositions: ov("maxConcurrentPositions", envNum("SCALP_MAX_CONCURRENT_POSITIONS", 10)),
    maxMarginUtilization:   ov("maxMarginUtilization",   envNum("SCALP_MAX_MARGIN_UTILIZATION", 0.5)),
    takeProfitPct:          ov("takeProfitPct",          envNum("SCALP_TAKE_PROFIT_PCT", 0.15)),
    stopLossPct:            ov("stopLossPct",            envNum("SCALP_STOP_LOSS_PCT", 0.10)),
    evMinThreshold:         ov("evMinThreshold",         envNum("SCALP_EV_MIN_THRESHOLD", 0.0)),
    winRateMin:             ov("winRateMin",             envNum("SCALP_WIN_RATE_MIN", 0.0)),
    profitFactorMin:        ov("profitFactorMin",        envNum("SCALP_PROFIT_FACTOR_MIN", 0.0)),
    btcRegimeRequired:      ov("btcRegimeRequired",      envBool("SCALP_BTC_REGIME_REQUIRED", false)),
    allowCounterRegimeScalp: ov("allowCounterRegimeScalp", envBool("SCALP_ALLOW_COUNTER_REGIME_SCALP", true)),
    btcRegimeThresholdPct:  ov("btcRegimeThresholdPct",  envNum("SCALP_BTC_REGIME_THRESHOLD_PCT", 0.5)),
    allowedSymbols:         ov("allowedSymbols",         envList("SCALP_SYMBOLS", [])),
    hourBlacklist:          ov("hourBlacklist",          envIntList("SCALP_HOUR_BLACKLIST", [])),
    orderType:              ov("orderType",              env("SCALP_ORDER_TYPE", "MARKET") as "MARKET" | "LIMIT"),
    marginType:             ov("marginType",             env("SCALP_MARGIN_TYPE", "ISOLATED") as "ISOLATED" | "CROSS"),
    allowExecution:         ov("allowExecution",         envBool("SCALP_ALLOW_EXECUTION", false)),
    maxSessionLoss:         ov("maxSessionLoss",         envNum("SCALP_MAX_SESSION_LOSS", 20)),
    takerFeeBps:            envNum("SCALP_TAKER_FEE_BPS", 5),
    slippageBpsPerSide:     envNum("SCALP_SLIPPAGE_BPS_PER_SIDE", 2),
    estimatedFundingCostPct: envNum("SCALP_ESTIMATED_FUNDING_COST_PCT", 0),
    minEdgeOverCostPct:     envNum("SCALP_MIN_EDGE_OVER_COST_PCT", 0.03),
    signalDedupeSeconds:    envNum("SCALP_SIGNAL_DEDUPE_SECONDS", 30),
    signalSourceType:       env("SCALP_SIGNAL_SOURCE_TYPE", "hypothetical") as "hypothetical" | "live",
    requireFull15mContext:  envBool("SCALP_REQUIRE_FULL_15M_CONTEXT", true),
    maxDailyLossPct:        envNum("SCALP_MAX_DAILY_LOSS_PCT", 0),
    maxDrawdownPct:         envNum("SCALP_MAX_DRAWDOWN_PCT", 0),
    maxConsecutiveLosses:   envNum("SCALP_MAX_CONSECUTIVE_LOSSES", 0),
    recentEdgeWindowHours:  envNum("SCALP_RECENT_EDGE_WINDOW_HOURS", 4),
    recentEdgeMinTrades:    envNum("SCALP_RECENT_EDGE_MIN_TRADES", 8),
    recentEdgeMinProfitFactor: envNum("SCALP_RECENT_EDGE_MIN_PROFIT_FACTOR", 0.8),
    recentEdgeMaxConsecutiveLosses: envNum("SCALP_RECENT_EDGE_MAX_CONSECUTIVE_LOSSES", 4),
    candleMinScore:         envNum("SCALP_CANDLE_MIN_SCORE", 0.5),
    candleMinSeparation:    envNum("SCALP_CANDLE_MIN_SEPARATION", 0.08),
    attachProtectionOrders: envBool("SCALP_ATTACH_PROTECTION_ORDERS", true),
    preventHedgedPositions: envBool("SCALP_PREVENT_HEDGED_POSITIONS", true),
    quantBrainGateMode:     env("QUANT_BRAIN_GATE_MODE", "shadow") as "shadow" | "enforce" | "off",
  };
}

// ========== VALIDATION ==========

export function validateConfig(config: unknown): { valid: boolean; errors: string[] } {
  const result = BotConfigSchema.safeParse(config);

  if (result.success) {
    return { valid: true, errors: [] };
  }

  const errors = result.error.errors.map((err) => `${err.path.join(".")}: ${err.message}`);
  return { valid: false, errors };
}

export function assertValidConfig(config: unknown): asserts config is BotConfig {
  const result = BotConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.errors.map(e => e.message).join(", ")}`);
  }
}

// ========== CONFIG DIFF ==========

export function getConfigDiff(oldConfig: BotConfig, newConfig: BotConfig): Partial<BotConfig> {
  const diff: Record<string, unknown> = {};

  for (const key of Object.keys(newConfig) as (keyof BotConfig)[]) {
    if (key === "loadedAt" || key === "activeOverrides" || key === "hasOverrides") continue;

    if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
      diff[key] = newConfig[key];
    }
  }

  return diff as Partial<BotConfig>;
}

// ========== MAIN CONFIG GETTER ==========

export function getBotConfig(): BotConfig {
  const raw = getRawConfig();
  const hasOverrides = Object.keys(_overrides).length > 0;
  const activeOverrides = Object.keys(_overrides) as ConfigOverrideKey[];
  const activeMode = getActiveModeId() ?? null;

  const config = {
    ...raw,
    loadedAt: new Date().toISOString(),
    hasOverrides,
    activeOverrides,
    activeMode,
    configVersion: 2,
  };

  // Validação final
  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error("[botConfig] Invalid config generated:", validation.errors);
  }

  return config;
}

// ========== CONFIG SUMMARY (FOR LOGGING) ==========

export function getConfigSummary(): string {
  const config = getBotConfig();
  const lines = [
    `📋 Bot Config Summary:`,
    `   Leverage: ${config.leverage}x`,
    `   Margin per trade: ${config.marginPerTrade} USDT`,
    `   Take profit: ${config.takeProfitPct}% | Stop loss: ${config.stopLossPct}%`,
    `   Max concurrent: ${config.maxConcurrentPositions}`,
    `   BTC regime required: ${config.btcRegimeRequired}`,
    `   Allow execution: ${config.allowExecution}`,
    `   Quant Brain mode: ${config.quantBrainGateMode}`,
    `   Recent edge guard: ${config.recentEdgeWindowHours}h / ${config.recentEdgeMinTrades} trades / PF ${config.recentEdgeMinProfitFactor}`,
    `   Candle confirmation: score ${config.candleMinScore} / separation ${config.candleMinSeparation}`,
    `   Exchange TP/SL attached: ${config.attachProtectionOrders}`,
    `   Allowed symbols: ${config.allowedSymbols.length > 0 ? config.allowedSymbols.join(", ") : "ALL"}`,
    `   Hour blacklist: ${config.hourBlacklist.join(", ") || "NONE"}`,
    `   Overrides active: ${config.hasOverrides ? config.activeOverrides.join(", ") : "NONE"}`,
    `   Active mode: ${config.activeMode || "none"}`,
  ];
  return lines.join("\n");
}

// ========== HEALTH CHECK ==========

export function getConfigHealth(): { healthy: boolean; issues: string[] } {
  const config = getBotConfig();
  const issues: string[] = [];

  if (config.leverage > 50) {
    issues.push(`High leverage (${config.leverage}x) may cause rapid liquidation`);
  }

  if (config.marginPerTrade > 20 && config.leverage > 20) {
    issues.push(`High notional exposure: ${config.marginPerTrade * config.leverage} USDT per trade`);
  }

  if (config.takeProfitPct <= config.stopLossPct) {
    issues.push(`Risk/reward ratio unfavorable: TP ${config.takeProfitPct}% < SL ${config.stopLossPct}%`);
  }

  if (config.maxDailyLossPct === 0 && config.maxDrawdownPct === 0) {
    issues.push(`No daily loss or drawdown limits configured`);
  }

  if (config.quantBrainGateMode === "off") {
    issues.push(`Quant Brain gate is disabled - edge validation turned off`);
  }

  if (!config.allowExecution && config.quantBrainGateMode === "enforce") {
    issues.push(`Allow execution is false but Quant Brain enforce mode is active`);
  }

  return {
    healthy: issues.length === 0,
    issues,
  };
}

// ========== HOT RELOAD SUPPORT ==========

let _hotReloadInterval: NodeJS.Timeout | null = null;
let _lastConfigHash = "";

function computeConfigHash(): string {
  const config = getBotConfig();
  return JSON.stringify({
    leverage: config.leverage,
    marginPerTrade: config.marginPerTrade,
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
    allowedSymbols: config.allowedSymbols,
    quantBrainGateMode: config.quantBrainGateMode,
  });
}

export function startHotReload(intervalMs: number = 10000): void {
  if (_hotReloadInterval) return;

  _lastConfigHash = computeConfigHash();

  _hotReloadInterval = setInterval(() => {
    const newHash = computeConfigHash();
    if (newHash !== _lastConfigHash) {
      _lastConfigHash = newHash;
      const newConfig = getBotConfig();
      notifyListeners(newConfig);
      console.log("[botConfig] Hot reload detected config change");
    }
  }, intervalMs);
}

export function stopHotReload(): void {
  if (_hotReloadInterval) {
    clearInterval(_hotReloadInterval);
    _hotReloadInterval = null;
  }
}

// ========== INITIALIZATION ==========

// Carrega configuração persistida se configurado
if (process.env.NODE_ENV === "production") {
  loadPersistedConfigState();
}

// Inicia hot reload em desenvolvimento
if (process.env.NODE_ENV === "development") {
  startHotReload(15000);
}

// Exporta função de inicialização para ser chamada no boot
export function initializeBotConfig(): void {
  const config = getBotConfig();
  const validation = validateConfig(config);

  if (!validation.valid) {
    console.error("[botConfig] Initialization failed:", validation.errors);
    throw new Error(`Invalid bot configuration: ${validation.errors.join(", ")}`);
  }

  const health = getConfigHealth();
  if (!health.healthy) {
    console.warn("[botConfig] Config health warnings:", health.issues);
  }

  console.log(getConfigSummary());

  // Salva estado inicial
  if (process.env.PERSIST_CONFIG_ON_START === "true") {
    persistConfigState();
  }
}
