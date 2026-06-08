import crypto from "crypto";
import { getActiveModeId } from "./botModes";
import { getBotConfig, getConfigOverrides, getOverrideHistory, type BotConfig } from "./botConfig";
import { getCurrentQuantBrainDriftPolicy, getQuantBrainOperationalStats, QUANT_BRAIN_CONTRACT_VERSION } from "./quantBrainClient";

export const DEFAULT_BACKEND_POLICY_VERSION = "backend-policy-v1";
export const DEFAULT_STRATEGY_VERSION = "sniper-scalp-v1";
export const DEFAULT_SCORE_CALIBRATION_VERSION = "score-calibration-v1";
export const DEFAULT_SIZING_POLICY_VERSION = "position-sizing-v1";
export const DEFAULT_ROTATION_POLICY_VERSION = "symbol-rotation-v1";
export const DEFAULT_PLAYBOOK_VERSION = "regime-playbook-v1";

export interface EffectivePolicySnapshot {
  generatedAt: string;
  activeMode: string | null;
  activePolicyVersion: string;
  strategyVersion: string;
  scoreCalibrationVersion: string;
  sizingPolicyVersion: string;
  rotationPolicyVersion: string;
  playbookVersion: string;
  config: Omit<BotConfig, "loadedAt">;
  runtimeOverrides: Record<string, unknown>;
  envDerivedRiskCaps: Record<string, number | boolean | string | null>;
  quantBrain: {
    contractVersion: string;
    gateMode: string;
    driftPolicy: ReturnType<typeof getCurrentQuantBrainDriftPolicy>;
    operational: ReturnType<typeof getQuantBrainOperationalStats>;
    policyVersion: string | null;
    modelVersion: string | null;
    featureVersion: string | null;
    labelVersion: string | null;
  };
}

export interface PolicyStatus {
  currentConfigHash: string;
  activePolicyVersion: string;
  activeMode: string | null;
  runtimeOverrides: Record<string, unknown>;
  envDerivedRiskCaps: EffectivePolicySnapshot["envDerivedRiskCaps"];
  quantBrain: EffectivePolicySnapshot["quantBrain"];
  mismatchWarnings: string[];
  lastConfigChanges: ReturnType<typeof getOverrideHistory>;
  affectedScopes: string[];
  effectiveSnapshot: EffectivePolicySnapshot;
}

function envNum(key: string): number | null {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function envBool(key: string): boolean | null {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return null;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function hashEffectiveConfig(snapshot: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function getEnvDerivedRiskCaps(config = getBotConfig()): EffectivePolicySnapshot["envDerivedRiskCaps"] {
  return {
    positionSizingEnabled: envBool("POSITION_SIZING_ENABLED"),
    baseRiskPct: envNum("BASE_RISK_PCT"),
    maxRiskPctPerTrade: envNum("MAX_RISK_PCT_PER_TRADE"),
    maxTotalRiskPct: envNum("MAX_TOTAL_RISK_PCT"),
    maxSymbolRiskPct: envNum("MAX_SYMBOL_RISK_PCT"),
    maxSideRiskPct: envNum("MAX_SIDE_RISK_PCT"),
    maxTotalNotionalPct: envNum("MAX_TOTAL_NOTIONAL_PCT"),
    minFreeMarginAfterOrder: envNum("MIN_FREE_MARGIN_AFTER_ORDER"),
    minMargin: envNum("MIN_MARGIN"),
    allowExecution: config.allowExecution,
    maxSessionLoss: config.maxSessionLoss,
    maxDailyLossPct: config.maxDailyLossPct,
    maxDrawdownPct: config.maxDrawdownPct,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
  };
}

export function buildEffectivePolicySnapshot(config = getBotConfig()): EffectivePolicySnapshot {
  const { loadedAt: _loadedAt, ...stableConfig } = config;
  const operational = getQuantBrainOperationalStats();
  return {
    generatedAt: new Date().toISOString(),
    activeMode: getActiveModeId() ?? config.activeMode,
    activePolicyVersion: process.env["SNIPER_POLICY_VERSION"] ?? DEFAULT_BACKEND_POLICY_VERSION,
    strategyVersion: process.env["SNIPER_STRATEGY_VERSION"] ?? DEFAULT_STRATEGY_VERSION,
    scoreCalibrationVersion: process.env["SCORE_CALIBRATION_VERSION"] ?? DEFAULT_SCORE_CALIBRATION_VERSION,
    sizingPolicyVersion: process.env["SIZING_POLICY_VERSION"] ?? DEFAULT_SIZING_POLICY_VERSION,
    rotationPolicyVersion: process.env["ROTATION_POLICY_VERSION"] ?? DEFAULT_ROTATION_POLICY_VERSION,
    playbookVersion: process.env["PLAYBOOK_VERSION"] ?? DEFAULT_PLAYBOOK_VERSION,
    config: stableConfig,
    runtimeOverrides: getConfigOverrides(),
    envDerivedRiskCaps: getEnvDerivedRiskCaps(config),
    quantBrain: {
      contractVersion: QUANT_BRAIN_CONTRACT_VERSION,
      gateMode: operational.gateMode,
      driftPolicy: getCurrentQuantBrainDriftPolicy(),
      operational,
      policyVersion: process.env["QUANT_BRAIN_POLICY_VERSION"] ?? null,
      modelVersion: process.env["QUANT_BRAIN_MODEL_VERSION"] ?? null,
      featureVersion: process.env["QUANT_BRAIN_FEATURE_VERSION"] ?? null,
      labelVersion: process.env["QUANT_BRAIN_LABEL_VERSION"] ?? null,
    },
  };
}

function affectedScopes(snapshot: EffectivePolicySnapshot): string[] {
  const scopes = new Set<string>(["audit", "decision", "order", "outcome", "replay"]);
  const overrides = Object.keys(snapshot.runtimeOverrides);
  if (overrides.some((key) => /margin|leverage|risk|loss|max/i.test(key))) scopes.add("sizing");
  if (overrides.some((key) => /score|threshold|profit|winRate|candle/i.test(key))) scopes.add("gating");
  if (overrides.some((key) => /symbol|position|stacking|candidate/i.test(key))) scopes.add("rotation");
  if (snapshot.quantBrain.gateMode !== "off") scopes.add("quant-brain");
  return [...scopes].sort();
}

function mismatchWarnings(snapshot: EffectivePolicySnapshot): string[] {
  const warnings: string[] = [];
  if (snapshot.config.quantBrainGateMode !== snapshot.quantBrain.gateMode) {
    warnings.push(`QUANT_GATE_MODE_MISMATCH: config=${snapshot.config.quantBrainGateMode} runtime=${snapshot.quantBrain.gateMode}`);
  }
  if (snapshot.config.allowExecution && snapshot.config.signalSourceType !== "live") {
    warnings.push(`LIVE_EXECUTION_WITH_NON_LIVE_SIGNAL_SOURCE: ${snapshot.config.signalSourceType}`);
  }
  if (snapshot.config.allowExecution && !snapshot.quantBrain.operational.urlConfigured && snapshot.quantBrain.gateMode !== "off") {
    warnings.push("LIVE_EXECUTION_WITH_QUANT_BRAIN_URL_MISSING");
  }
  if (Object.keys(snapshot.runtimeOverrides).length > 0) {
    warnings.push(`RUNTIME_OVERRIDES_ACTIVE: ${Object.keys(snapshot.runtimeOverrides).sort().join(",")}`);
  }
  if (!snapshot.quantBrain.policyVersion) warnings.push("QUANT_BRAIN_POLICY_VERSION_UNDECLARED");
  if (!snapshot.quantBrain.modelVersion) warnings.push("QUANT_BRAIN_MODEL_VERSION_UNDECLARED");
  return warnings;
}

export function getPolicyStatus(): PolicyStatus {
  const snapshot = buildEffectivePolicySnapshot();
  const hashInput = {
    ...snapshot,
    generatedAt: undefined,
    quantBrain: {
      ...snapshot.quantBrain,
      operational: {
        enabled: snapshot.quantBrain.operational.enabled,
        gateMode: snapshot.quantBrain.operational.gateMode,
        urlConfigured: snapshot.quantBrain.operational.urlConfigured,
      },
    },
  };
  return {
    currentConfigHash: hashEffectiveConfig(hashInput),
    activePolicyVersion: snapshot.activePolicyVersion,
    activeMode: snapshot.activeMode,
    runtimeOverrides: snapshot.runtimeOverrides,
    envDerivedRiskCaps: snapshot.envDerivedRiskCaps,
    quantBrain: snapshot.quantBrain,
    mismatchWarnings: mismatchWarnings(snapshot),
    lastConfigChanges: getOverrideHistory().slice(-20),
    affectedScopes: affectedScopes(snapshot),
    effectiveSnapshot: snapshot,
  };
}
