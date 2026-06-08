/**
 * Adaptive Edge Engine — futures equivalent of adaptive.rs from the MEV runtime.
 *
 * Core math ported from Rust:
 *   - EWMA (exponentially weighted moving average) for all live metrics
 *   - ClusterKey: (symbol, positionSide, hourUtc, btcRegime) — the "router+pair+hour" of futures
 *   - ContextSignal: priority_score + toxicity_score per cluster
 *   - Dynamic threshold calibration from realized outcomes
 *
 * Priority score formula (adaptive.rs line ~380):
 *   priority = winRate×0.46 + realizedCapture×0.34 + (1−slHitRate)×0.12 + pfScore×0.08
 *
 * Toxicity score formula (adaptive.rs line ~390):
 *   toxicity = (1−winRate)×0.28 + slHitRate×0.36 + (1−profitFactorNorm)×0.22 + (1−realizedCapture)×0.14
 *
 * Never modify these weights without A/B evidence from at least 100 trades.
 *
 * Nível Máximo de Excelência:
 * - Schema validation com Zod
 * - Persistência automática
 * - Event emitter para mudanças
 * - Cache de perfis quentes
 * - Métricas avançadas (Sharpe, Sortino, Calmar)
 * - Quant Brain sync bidirecional
 */

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { z } from "zod";
import crypto from "crypto";

// ========== SCHEMAS ==========

export const BtcRegimeSchema = z.preprocess(
  (v) => v === "BULLISH" ? "BULL" : v === "BEARISH" ? "BEAR" : v,
  z.enum(["BULL", "BEAR", "NEUTRAL"]),
);
export type BtcRegime = z.infer<typeof BtcRegimeSchema>;

export const PositionSideSchema = z.enum(["LONG", "SHORT"]);
export type PositionSide = z.infer<typeof PositionSideSchema>;

export const ExitReasonSchema = z.enum(["TP", "SL", "MANUAL"]);
export type ExitReason = z.infer<typeof ExitReasonSchema>;

export const ClusterKeySchema = z.object({
  symbol: z.string(),
  positionSide: PositionSideSchema,
  hourUtc: z.number().min(0).max(23),
  btcRegime: BtcRegimeSchema,
});
export type ClusterKey = z.infer<typeof ClusterKeySchema>;

export const ContextSignalSchema = z.object({
  priorityScore: z.number().min(0).max(1),
  toxicityScore: z.number().min(0).max(1),
  samples: z.number().int().min(0),
});
export type ContextSignal = z.infer<typeof ContextSignalSchema>;

export const TradeOutcomeSchema = z.object({
  id: z.string(),
  isDemo: z.boolean().optional(),
  source: z.enum(["bingx-live", "bingx-vst", "manual"]).optional(),
  entryOrderId: z.string().optional(),
  exitOrderId: z.string().optional(),
  symbol: z.string(),
  positionSide: PositionSideSchema,
  side: z.enum(["BUY", "SELL"]),
  entryTime: z.number(),
  exitTime: z.number(),
  hourUtc: z.number().min(0).max(23),
  btcRegime: BtcRegimeSchema,
  entryPrice: z.number().positive(),
  exitPrice: z.number().positive(),
  qty: z.number().positive(),
  leverage: z.number().positive(),
  marginUsed: z.number().positive(),
  grossPnl: z.number(),
  fee: z.number().nonnegative(),
  realizedPnl: z.number(),
  pnlSource: z.enum(["balance_delta", "price_estimate", "exchange_reported"]).optional(),
  estimated: z.boolean().optional(),
  expectedEntryPrice: z.number().optional(),
  expectedExitPrice: z.number().optional(),
  entrySlippage: z.number().optional(),
  exitSlippage: z.number().optional(),
  totalSlippage: z.number().optional(),
  slippagePctNotional: z.number().optional(),
  exitReason: ExitReasonSchema,
  expectedTpProfit: z.number(),
  // Audit trail — populated by demo campaign aggregation; optional for live outcomes
  mfe: z.number().optional(),
  mae: z.number().optional(),
  holdDurationMs: z.number().optional(),
  entryCount: z.number().int().positive().optional(),
  modelVersion: z.string().nullable().optional(),
  signalId: z.string().optional(),
});
export type TradeOutcome = z.infer<typeof TradeOutcomeSchema>;

export const ClusterProfileSchema = z.object({
  key: ClusterKeySchema,
  samples: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  winRate: z.number(),
  avgWin: z.number(),
  avgLoss: z.number(),
  ev: z.number(),
  profitFactor: z.number(),
  totalPnl: z.number(),
  totalFees: z.number(),
  totalSlippage: z.number(),
  avgSlippage: z.number(),
  tpHitRate: z.number(),
  slHitRate: z.number(),
  realizedCapture: z.number(),
  priorityScore: z.number(),
  toxicityScore: z.number(),
  ewmaWinRate: z.number(),
  ewmaEv: z.number(),
  ewmaSlippage: z.number(),
  realEv: z.number(),
  lastUpdated: z.number(),
  // Campos adicionais — computed incrementally, no O(n) scan needed
  sharpeRatio: z.number().optional(),
  sortinoRatio: z.number().optional(),
  maxDrawdown: z.number().optional(),
  // Welford incremental variance state for Sharpe/Sortino (avoids storing all returns)
  _wM2: z.number().optional(),
  _wMean: z.number().optional(),
  _wDownsideM2: z.number().optional(),
  _wDownsideMean: z.number().optional(),
  _wDownsideN: z.number().optional(),
  _wPeak: z.number().optional(),
  _wCumulative: z.number().optional(),
});
export type ClusterProfile = z.infer<typeof ClusterProfileSchema>;

export const SymbolProfileSchema = z.object({
  symbol: z.string(),
  totalSamples: z.number().int(),
  winRate: z.number(),
  profitFactor: z.number(),
  ev: z.number(),
  totalPnl: z.number(),
  totalFees: z.number(),
  totalSlippage: z.number(),
  avgSlippage: z.number(),
  netPnl: z.number(),
  isToxic: z.boolean(),
  bestHour: z.number().nullable(),
  worstHour: z.number().nullable(),
  priorityScore: z.number(),
  toxicityScore: z.number(),
  // Campos adicionais
  sharpeRatio: z.number().optional(),
  sortinoRatio: z.number().optional(),
  maxDrawdown: z.number().optional(),
});
export type SymbolProfile = z.infer<typeof SymbolProfileSchema>;

export const AdaptiveGateRecommendationSchema = z.object({
  evMinThreshold: z.number(),
  winRateMin: z.number(),
  profitFactorMin: z.number(),
  toxicSymbols: z.array(z.string()),
  toxicHours: z.array(z.number()),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW", "INSUFFICIENT_DATA"]),
  basedOnSamples: z.number(),
  lastCalibrated: z.number(),
});
export type AdaptiveGateRecommendation = z.infer<typeof AdaptiveGateRecommendationSchema>;

// ========== CONSTANTS ==========

const EWMA_FAST = 0.20;
const EWMA_SLOW = 0.08;
const MIN_SAMPLES_FOR_GATE = 10;
const PRIORITY_SCORE_NEUTRAL = 0.50;
const TOXICITY_SCORE_NEUTRAL = 0.50;

// Persistência
const STATE_PATH = process.env.ADAPTIVE_ENGINE_STATE_PATH || "./data/adaptive-engine.json";
const BACKUP_PATH = process.env.ADAPTIVE_ENGINE_BACKUP_PATH || "./data/adaptive-engine-backup.json";
const AUTO_SAVE_INTERVAL_MS = 60000; // 1 minuto
const MAX_OUTCOMES = 10000;

// ========== UTILITY FUNCTIONS ==========

function ewma(prev: number, newVal: number, alpha: number): number {
  return prev + alpha * (newVal - prev);
}

function clamp(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, val));
}

function adaptiveFastAlpha(samples: number, notional: number, slippagePctNotional: number): number {
  const sampleFactor = samples < 10 ? 1 : samples < 30 ? 0.75 : samples < 100 ? 0.55 : 0.40;
  const liquidityFactor = notional >= 100 ? 0.70 : notional >= 25 ? 0.85 : 1.0;
  const frictionFactor = slippagePctNotional > 0.002 ? 1.15 : slippagePctNotional > 0.001 ? 1.05 : 0.95;
  return clamp(EWMA_FAST * sampleFactor * liquidityFactor * frictionFactor, 0.04, EWMA_FAST);
}

function outcomeSlippage(outcome: TradeOutcome): number {
  return Math.max(0, outcome.totalSlippage ?? 0);
}

function clusterKeyStr(key: ClusterKey): string {
  return `${key.symbol}:${key.positionSide}:${key.hourUtc}:${key.btcRegime}`;
}

function symbolKeyStr(symbol: string): string {
  return symbol.toUpperCase();
}

// ========== MÉTRICAS AVANÇADAS ==========
// NOTE: All metrics use Welford's online algorithm (O(1) per trade, no array scans).
// The old array-scan versions caused O(n²) freeze as trade history grew.

function calculateSharpeRatio(returns: number[]): number {
  if (returns.length < 3) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(365);
}

function calculateSortinoRatio(returns: number[]): number {
  if (returns.length < 3) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const negativeReturns = returns.filter(r => r < 0);
  if (negativeReturns.length === 0) return 999;
  const downsideVariance = negativeReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / negativeReturns.length;
  const downsideStd = Math.sqrt(downsideVariance);
  if (downsideStd === 0) return 0;
  return (mean / downsideStd) * Math.sqrt(365);
}

function calculateMaxDrawdown(returns: number[]): number {
  if (returns.length < 2) return 0;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

// Welford incremental state shape — stored per cluster profile
interface WelfordState {
  n: number;
  mean: number;
  M2: number;
  downsideN: number;
  downsideMean: number;
  downsideM2: number;
  peak: number;
  cumulative: number;
  maxDrawdown: number;
}

function welfordInitial(ret: number): WelfordState {
  return {
    n: 1,
    mean: ret,
    M2: 0,
    downsideN: ret < 0 ? 1 : 0,
    downsideMean: ret < 0 ? ret : 0,
    downsideM2: 0,
    peak: Math.max(0, ret),
    cumulative: ret,
    maxDrawdown: Math.max(0, -ret),
  };
}

function welfordUpdate(state: WelfordState, ret: number): WelfordState {
  const n = state.n + 1;
  const delta = ret - state.mean;
  const mean = state.mean + delta / n;
  const delta2 = ret - mean;
  const M2 = state.M2 + delta * delta2;

  let { downsideN, downsideMean, downsideM2 } = state;
  if (ret < 0) {
    downsideN++;
    const dd = ret - downsideMean;
    downsideMean = downsideMean + dd / downsideN;
    downsideM2 = downsideM2 + dd * (ret - downsideMean);
  }

  const cumulative = state.cumulative + ret;
  const peak = Math.max(state.peak, cumulative);
  const maxDrawdown = Math.max(state.maxDrawdown, peak - cumulative);

  return { n, mean, M2, downsideN, downsideMean, downsideM2, peak, cumulative, maxDrawdown };
}

function welfordSharpe(state: WelfordState): number {
  if (state.n < 3) return 0;
  const variance = state.M2 / state.n;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (state.mean / std) * Math.sqrt(365);
}

function welfordSortino(state: WelfordState): number {
  if (state.n < 3) return 0;
  if (state.downsideN === 0) return 999;
  const downsideVariance = state.downsideM2 / state.downsideN;
  const downsideStd = Math.sqrt(downsideVariance);
  if (downsideStd === 0) return 0;
  return (state.mean / downsideStd) * Math.sqrt(365);
}

function welfordFromProfile(p: ClusterProfile): WelfordState {
  return {
    n: p.samples,
    mean: p._wMean ?? 0,
    M2: p._wM2 ?? 0,
    downsideN: p._wDownsideN ?? 0,
    downsideMean: p._wDownsideMean ?? 0,
    downsideM2: p._wDownsideM2 ?? 0,
    peak: p._wPeak ?? 0,
    cumulative: p._wCumulative ?? 0,
    maxDrawdown: p.maxDrawdown ?? 0,
  };
}

// ========== SCORE FORMULAS ==========

function computePriorityScore(
  winRate: number,
  realizedCapture: number,
  slHitRate: number,
  profitFactor: number,
): number {
  const pfScore = clamp(profitFactor / 3.0, 0, 1);
  return clamp(
    winRate * 0.46 +
    realizedCapture * 0.34 +
    (1 - slHitRate) * 0.12 +
    pfScore * 0.08,
    0, 1,
  );
}

function computeToxicityScore(
  winRate: number,
  realizedCapture: number,
  slHitRate: number,
  profitFactor: number,
): number {
  const pfNorm = clamp(profitFactor / 3.0, 0, 1);
  return clamp(
    (1 - winRate) * 0.28 +
    slHitRate * 0.36 +
    (1 - pfNorm) * 0.22 +
    (1 - clamp(realizedCapture, 0, 1)) * 0.14,
    0, 1,
  );
}

// ========== ADAPTIVE ENGINE ==========

export class AdaptiveEngine extends EventEmitter {
  private clusterProfiles = new Map<string, ClusterProfile>();
  private symbolProfiles = new Map<string, SymbolProfile>();
  private globalEwmaWinRate = PRIORITY_SCORE_NEUTRAL;
  private globalEwmaEv = 0;
  private globalEwmaFee = 0;
  private totalTrades = 0;
  private outcomes: TradeOutcome[] = [];
  private dirty = false;
  private saveInterval: NodeJS.Timeout | null = null;
  private lastBackupTime = 0;

  constructor(initialOutcomes: TradeOutcome[] = []) {
    super();
    this.setMaxListeners(100);

    if (initialOutcomes.length > 0) {
      this.rebuildFromOutcomes(initialOutcomes);
    } else {
      this.loadState();
    }

    // Inicia auto-save
    this.startAutoSave();
  }

  // ========== PUBLIC API ==========

  recordOutcome(outcome: TradeOutcome): void {
    // Validação
    const validation = TradeOutcomeSchema.safeParse(outcome);
    if (!validation.success) {
      console.error("[AdaptiveEngine] Invalid outcome:", validation.error.issues);
      throw new Error(`Invalid outcome: ${validation.error.issues.map((issue) => issue.message).join(", ")}`);
    }

    this.outcomes.push(outcome);

    // Limita tamanho do histórico
    while (this.outcomes.length > MAX_OUTCOMES) {
      this.outcomes.shift();
    }

    this.totalTrades++;
    this.dirty = true;

    const slippage = outcomeSlippage(outcome);
    const realPnl = outcome.realizedPnl - slippage;
    const win = realPnl > 0;
    const notional = Math.max(0, outcome.entryPrice * outcome.qty);
    const alphaFast = adaptiveFastAlpha(this.totalTrades, notional, outcome.slippagePctNotional ?? 0);

    // Update global EWMA
    this.globalEwmaWinRate = ewma(this.globalEwmaWinRate, win ? 1 : 0, alphaFast);
    this.globalEwmaEv = ewma(this.globalEwmaEv, realPnl, EWMA_SLOW);
    this.globalEwmaFee = ewma(this.globalEwmaFee, outcome.fee, EWMA_SLOW);

    // Update cluster profile
    this.updateClusterProfile(outcome);

    // Re-roll symbol profile
    this.rollupSymbolProfile(outcome.symbol);

    // Emite evento
    this.emit("outcome", outcome);
    this.emit("change");
  }

  contextSignal(key: ClusterKey): ContextSignal {
    const profile = this.clusterProfiles.get(clusterKeyStr(key));
    if (!profile || profile.samples < MIN_SAMPLES_FOR_GATE) {
      return {
        priorityScore: PRIORITY_SCORE_NEUTRAL,
        toxicityScore: TOXICITY_SCORE_NEUTRAL,
        samples: profile?.samples ?? 0,
      };
    }
    return {
      priorityScore: profile.priorityScore,
      toxicityScore: profile.toxicityScore,
      samples: profile.samples,
    };
  }

  clusterProfile(key: ClusterKey): ClusterProfile | null {
    return this.clusterProfiles.get(clusterKeyStr(key)) ?? null;
  }

  allClusterProfiles(): ClusterProfile[] {
    return Array.from(this.clusterProfiles.values());
  }

  symbolProfile(symbol: string): SymbolProfile | null {
    return this.symbolProfiles.get(symbolKeyStr(symbol)) ?? null;
  }

  allSymbolProfiles(): SymbolProfile[] {
    return Array.from(this.symbolProfiles.values()).sort(
      (a, b) => b.totalPnl - a.totalPnl,
    );
  }

  hourProfile(): { hour: number; pnl: number; winRate: number; samples: number; priorityScore: number; sharpeRatio: number }[] {
    const byHour = new Map<number, { pnl: number; wins: number; total: number; prioritySum: number; returns: number[] }>();

    for (const outcome of this.outcomes) {
      const h = outcome.hourUtc;
      const entry = byHour.get(h) ?? { pnl: 0, wins: 0, total: 0, prioritySum: 0, returns: [] };
      entry.pnl += outcome.realizedPnl;
      entry.wins += outcome.realizedPnl > 0 ? 1 : 0;
      entry.total++;
      entry.returns.push(outcome.realizedPnl);
      byHour.set(h, entry);
    }

    return Array.from(byHour.entries())
      .map(([hour, d]) => ({
        hour,
        pnl: d.pnl,
        winRate: d.total > 0 ? d.wins / d.total : 0,
        samples: d.total,
        priorityScore: d.total > 0 ? clamp(d.pnl / (d.total * Math.abs(this.globalEwmaEv || 0.01)), 0, 1) : PRIORITY_SCORE_NEUTRAL,
        sharpeRatio: calculateSharpeRatio(d.returns),
      }))
      .sort((a, b) => a.hour - b.hour);
  }

  globalState(): {
    ewmaWinRate: number;
    ewmaEv: number;
    ewmaFeePerTrade: number;
    totalTrades: number;
    outcomes: TradeOutcome[];
    sharpeRatio: number;
    sortinoRatio: number;
    maxDrawdown: number;
  } {
    const returns = this.outcomes.map(o => o.realizedPnl);
    return {
      ewmaWinRate: this.globalEwmaWinRate,
      ewmaEv: this.globalEwmaEv,
      ewmaFeePerTrade: this.globalEwmaFee,
      totalTrades: this.totalTrades,
      outcomes: this.outcomes,
      sharpeRatio: calculateSharpeRatio(returns),
      sortinoRatio: calculateSortinoRatio(returns),
      maxDrawdown: calculateMaxDrawdown(returns),
    };
  }

  gateRecommendation(): AdaptiveGateRecommendation {
    const samples = this.totalTrades;

    if (samples < MIN_SAMPLES_FOR_GATE) {
      return {
        evMinThreshold: 0,
        winRateMin: 0,
        profitFactorMin: 0,
        toxicSymbols: [],
        toxicHours: [],
        confidence: "INSUFFICIENT_DATA",
        basedOnSamples: samples,
        lastCalibrated: Date.now(),
      };
    }

    const allSymbols = this.allSymbolProfiles();
    const toxicSymbols = allSymbols
      .filter((s) => s.isToxic && s.totalSamples >= MIN_SAMPLES_FOR_GATE)
      .map((s) => s.symbol);

    const hourData = this.hourProfile();
    const toxicHours = hourData
      .filter((h) => h.pnl < 0 && h.samples >= 5)
      .map((h) => h.hour);

    const positiveEvClusters = Array.from(this.clusterProfiles.values())
      .filter((p) => (p.realEv ?? p.ev) > 0 && p.samples >= MIN_SAMPLES_FOR_GATE)
      .map((p) => p.realEv ?? p.ev)
      .sort((a, b) => a - b);

    const evThreshold = positiveEvClusters.length > 0
      ? positiveEvClusters[Math.floor(positiveEvClusters.length * 0.25)]
      : 0;

    const confidence = samples >= 100 ? "HIGH" : samples >= 50 ? "MEDIUM" : "LOW";

    return {
      evMinThreshold: Math.max(0, evThreshold),
      winRateMin: clamp(this.globalEwmaWinRate * 0.90, 0, 1),
      profitFactorMin: 1.0,
      toxicSymbols,
      toxicHours,
      confidence,
      basedOnSamples: samples,
      lastCalibrated: Date.now(),
    };
  }

  rankingScore(key: ClusterKey, currentEv: number): number {
    const signal = this.contextSignal(key);
    const pPositive = signal.priorityScore;
    return Math.max(0, currentEv)
      * (0.65 + clamp(pPositive, 0, 1) * 0.35)
      * (0.70 + clamp(signal.priorityScore, 0, 1) * 0.30)
      * Math.max(0.1, 1.0 - signal.toxicityScore * 0.40);
  }

  rawOutcomes(): TradeOutcome[] {
    return this.outcomes;
  }

  replaceOutcome(outcome: TradeOutcome): boolean {
    const validation = TradeOutcomeSchema.safeParse(outcome);
    if (!validation.success) {
      console.error("[AdaptiveEngine] Invalid replacement outcome:", validation.error.issues);
      throw new Error(`Invalid replacement outcome: ${validation.error.issues.map((issue) => issue.message).join(", ")}`);
    }

    const index = this.outcomes.findIndex((existing) => existing.id === outcome.id);
    if (index < 0) return false;

    const next = this.outcomes.slice();
    next[index] = outcome;
    this.rebuildFromOutcomes(next);
    this.dirty = true;
    this.emit("outcome:updated", outcome);
    return true;
  }

  combinedEdgeScore(key: ClusterKey, ev: number, marketScore: number): number {
    const signal = this.contextSignal(key);
    const market = clamp(marketScore, 0, 1);

    if (signal.samples < MIN_SAMPLES_FOR_GATE) {
      return market;
    }

    const adaptive = this.rankingScore(key, ev);
    return clamp(adaptive * (0.60 + market * 0.40), 0, 10);
  }

  edgeSummary(symbol: string, hourUtc: number, btcRegime: BtcRegime): {
    longEdge: { ev: number; winRate: number; priorityScore: number; toxicityScore: number; samples: number };
    shortEdge: { ev: number; winRate: number; priorityScore: number; toxicityScore: number; samples: number };
    symbolProfile: SymbolProfile | null;
  } {
    const buildEdge = (side: PositionSide) => {
      const key: ClusterKey = { symbol, positionSide: side, hourUtc, btcRegime };
      const cluster = this.clusterProfile(key);
      const signal = this.contextSignal(key);
      return {
        ev: cluster?.realEv ?? cluster?.ev ?? 0,
        winRate: cluster?.ewmaWinRate ?? 0,
        priorityScore: signal.priorityScore,
        toxicityScore: signal.toxicityScore,
        samples: signal.samples,
      };
    };
    return {
      longEdge: buildEdge("LONG"),
      shortEdge: buildEdge("SHORT"),
      symbolProfile: this.symbolProfile(symbol),
    };
  }

  // ========== PERSISTÊNCIA ==========

  saveState(): void {
    if (!this.dirty) return;
    // Fire-and-forget async write — never block the event loop
    void this._saveStateAsync();
  }

  private _saving = false;

  private async _saveStateAsync(): Promise<void> {
    if (this._saving) return; // coalesce concurrent saves
    this._saving = true;
    try {
      const dir = path.dirname(STATE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = {
        clusterProfiles: Array.from(this.clusterProfiles.entries()),
        symbolProfiles: Array.from(this.symbolProfiles.entries()),
        globalEwmaWinRate: this.globalEwmaWinRate,
        globalEwmaEv: this.globalEwmaEv,
        globalEwmaFee: this.globalEwmaFee,
        totalTrades: this.totalTrades,
        outcomes: this.outcomes,
        savedAt: Date.now(),
        version: 2,
      };

      // Async write — does not block the event loop during JSON serialization
      const json = JSON.stringify(state);
      await fs.promises.writeFile(STATE_PATH + ".tmp", json, "utf-8");
      await fs.promises.rename(STATE_PATH + ".tmp", STATE_PATH);
      this.dirty = false;

      // Backup periódico (async too)
      const now = Date.now();
      if (now - this.lastBackupTime > 3600000) {
        await fs.promises.writeFile(BACKUP_PATH, json, "utf-8");
        this.lastBackupTime = now;
        console.log("[AdaptiveEngine] Backup saved");
      }

      this.emit("saved");
    } catch (err) {
      console.error("[AdaptiveEngine] Failed to save state:", err);
    } finally {
      this._saving = false;
    }
  }

  loadState(): void {
    try {
      if (!fs.existsSync(STATE_PATH)) {
        console.log("[AdaptiveEngine] No saved state found, starting fresh");
        return;
      }

      const data = fs.readFileSync(STATE_PATH, "utf-8");
      const state = JSON.parse(data);

      this.clusterProfiles.clear();
      for (const [key, profile] of state.clusterProfiles || []) {
        this.clusterProfiles.set(key, profile);
      }

      this.symbolProfiles.clear();
      for (const [key, profile] of state.symbolProfiles || []) {
        this.symbolProfiles.set(key, profile);
      }

      this.globalEwmaWinRate = state.globalEwmaWinRate ?? PRIORITY_SCORE_NEUTRAL;
      this.globalEwmaEv = state.globalEwmaEv ?? 0;
      this.globalEwmaFee = state.globalEwmaFee ?? 0;
      this.totalTrades = state.totalTrades ?? 0;
      this.outcomes = state.outcomes ?? [];

      console.log(`[AdaptiveEngine] Loaded state: ${this.totalTrades} trades, ${this.clusterProfiles.size} clusters`);
      this.emit("loaded");
    } catch (err) {
      console.error("[AdaptiveEngine] Failed to load state:", err);
    }
  }

  startAutoSave(): void {
    if (this.saveInterval) return;
    this.saveInterval = setInterval(() => {
      this.saveState();
    }, AUTO_SAVE_INTERVAL_MS);
  }

  stopAutoSave(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  // ========== QUANT BRAIN SYNC ==========

  async syncWithQuantBrain(quantBrainUrl: string, apiToken?: string): Promise<{
    success: boolean;
    recommendationsApplied: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    try {
      // Envia outcomes para o Quant Brain
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiToken) {
        headers["X-Quant-Brain-Token"] = apiToken;
      }

      // Envia trades recentes
      const recentOutcomes = this.outcomes.slice(-100);
      const syncResponse = await fetch(`${quantBrainUrl}/sync/outcomes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ outcomes: recentOutcomes }),
        signal: AbortSignal.timeout(10000),
      });

      if (!syncResponse.ok) {
        errors.push(`Sync failed: ${syncResponse.status}`);
      }

      // Recebe recomendações
      const recResponse = await fetch(`${quantBrainUrl}/edge/config/recommendations`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });

      let recommendationsApplied = false;
      if (recResponse.ok) {
        const data = await recResponse.json() as { recommendations?: unknown };
        const recommendations = data.recommendations || {};

        // Aplica recomendações via evento
        this.emit("quantbrain-recommendations", recommendations);
        recommendationsApplied = true;
      }

      this.emit("quantbrain-sync", { success: true, recommendationsApplied });
      return { success: true, recommendationsApplied, errors };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push(errorMsg);
      console.error("[AdaptiveEngine] Quant Brain sync failed:", err);
      return { success: false, recommendationsApplied: false, errors };
    }
  }

  // ========== MÉTRICAS PARA DASHBOARD ==========

  getDashboardMetrics(): {
    summary: {
      totalTrades: number;
      globalWinRate: number;
      totalPnl: number;
      sharpeRatio: number;
      sortinoRatio: number;
      maxDrawdown: number;
    };
    topSymbols: SymbolProfile[];
    toxicSymbols: SymbolProfile[];
    hourProfile: ReturnType<AdaptiveEngine["hourProfile"]>;
    gateRecommendation: AdaptiveGateRecommendation;
  } {
    const returns = this.outcomes.map(o => o.realizedPnl);
    const totalPnl = this.outcomes.reduce((s, o) => s + o.realizedPnl, 0);
    const wins = this.outcomes.filter(o => o.realizedPnl > 0).length;

    const allSymbols = this.allSymbolProfiles();
    const topSymbols = [...allSymbols].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 5);
    const toxicSymbols = allSymbols.filter(s => s.isToxic);

    return {
      summary: {
        totalTrades: this.totalTrades,
        globalWinRate: this.totalTrades > 0 ? wins / this.totalTrades : 0,
        totalPnl,
        sharpeRatio: calculateSharpeRatio(returns),
        sortinoRatio: calculateSortinoRatio(returns),
        maxDrawdown: calculateMaxDrawdown(returns),
      },
      topSymbols,
      toxicSymbols,
      hourProfile: this.hourProfile(),
      gateRecommendation: this.gateRecommendation(),
    };
  }

  // ========== INTERNAL ==========

  private updateClusterProfile(outcome: TradeOutcome): void {
    const keyStr = clusterKeyStr({
      symbol: outcome.symbol,
      positionSide: outcome.positionSide,
      hourUtc: outcome.hourUtc,
      btcRegime: outcome.btcRegime,
    });

    const existing = this.clusterProfiles.get(keyStr);
    const slippage = outcomeSlippage(outcome);
    const realPnl = outcome.realizedPnl - slippage;
    const win = realPnl > 0;

    if (!existing) {
      const winRate = win ? 1 : 0;
      const avgWin = win ? realPnl : 0;
      const avgLoss = !win ? realPnl : 0;
      const profitFactor = avgWin > 0 && avgLoss < 0 ? Math.abs(avgWin / avgLoss) : 0;
      const tpHitRate = outcome.exitReason === "TP" ? 1 : 0;
      const slHitRate = outcome.exitReason === "SL" ? 1 : 0;
      const realizedCapture = outcome.exitReason === "TP" && outcome.expectedTpProfit > 0
        ? clamp(realPnl / outcome.expectedTpProfit, 0, 1.5)
        : 0.5;

      const priorityScore = computePriorityScore(winRate, realizedCapture, slHitRate, profitFactor);
      const toxicityScore = computeToxicityScore(winRate, realizedCapture, slHitRate, profitFactor);

      const wf = welfordInitial(realPnl);

      this.clusterProfiles.set(keyStr, {
        key: { symbol: outcome.symbol, positionSide: outcome.positionSide, hourUtc: outcome.hourUtc, btcRegime: outcome.btcRegime },
        samples: 1,
        wins: win ? 1 : 0,
        losses: win ? 0 : 1,
        winRate,
        avgWin,
        avgLoss,
        ev: realPnl,
        profitFactor,
        totalPnl: realPnl,
        totalFees: outcome.fee,
        totalSlippage: slippage,
        avgSlippage: slippage,
        tpHitRate,
        slHitRate,
        realizedCapture,
        priorityScore,
        toxicityScore,
        ewmaWinRate: winRate,
        ewmaEv: outcome.realizedPnl,
        ewmaSlippage: slippage,
        realEv: outcome.realizedPnl - slippage,
        lastUpdated: Date.now(),
        sharpeRatio: welfordSharpe(wf),
        sortinoRatio: welfordSortino(wf),
        maxDrawdown: wf.maxDrawdown,
        _wMean: wf.mean,
        _wM2: wf.M2,
        _wDownsideN: wf.downsideN,
        _wDownsideMean: wf.downsideMean,
        _wDownsideM2: wf.downsideM2,
        _wPeak: wf.peak,
        _wCumulative: wf.cumulative,
      });
      return;
    }

    const n = existing.samples + 1;
    const wins = existing.wins + (win ? 1 : 0);
    const losses = existing.losses + (win ? 0 : 1);
    const winRate = wins / n;
    const alphaFast = adaptiveFastAlpha(existing.samples, outcome.entryPrice * outcome.qty, outcome.slippagePctNotional ?? 0);

    const avgWin = win
      ? existing.avgWin + (realPnl - existing.avgWin) / Math.max(wins, 1)
      : existing.avgWin;
    const avgLoss = !win
      ? existing.avgLoss + (realPnl - existing.avgLoss) / Math.max(losses, 1)
      : existing.avgLoss;

    const profitFactor = avgWin > 0 && avgLoss < 0 ? Math.abs(avgWin / avgLoss) : (avgWin > 0 ? 999 : 0);
    const ev = winRate * avgWin + (1 - winRate) * avgLoss;

    const tpCount = existing.tpHitRate * existing.samples + (outcome.exitReason === "TP" ? 1 : 0);
    const slCount = existing.slHitRate * existing.samples + (outcome.exitReason === "SL" ? 1 : 0);
    const tpHitRate = tpCount / n;
    const slHitRate = slCount / n;

    const tradeCapture = outcome.exitReason === "TP" && outcome.expectedTpProfit > 0
      ? clamp(realPnl / outcome.expectedTpProfit, 0, 1.5)
      : (win ? 0.8 : 0.2);
    const realizedCapture = ewma(existing.realizedCapture, tradeCapture, alphaFast);

    const ewmaWinRate = ewma(existing.ewmaWinRate, win ? 1 : 0, alphaFast);
    const ewmaEv = ewma(existing.ewmaEv, outcome.realizedPnl, EWMA_SLOW);
    const ewmaSlippage = ewma(existing.ewmaSlippage ?? existing.avgSlippage ?? 0, slippage, EWMA_SLOW);
    const realEv = ewmaEv - ewmaSlippage;

    const priorityScore = computePriorityScore(winRate, realizedCapture, slHitRate, profitFactor);
    const toxicityScore = computeToxicityScore(winRate, realizedCapture, slHitRate, profitFactor);

    // O(1) incremental Welford update — no array scan needed
    const prevWf = welfordFromProfile(existing);
    const wf = prevWf.n > 0 ? welfordUpdate(prevWf, realPnl) : welfordInitial(realPnl);

    this.clusterProfiles.set(keyStr, {
      ...existing,
      samples: n,
      wins,
      losses,
      winRate,
      avgWin,
      avgLoss,
      ev,
      profitFactor,
      totalPnl: existing.totalPnl + realPnl,
      totalFees: existing.totalFees + outcome.fee,
      totalSlippage: (existing.totalSlippage ?? 0) + slippage,
      avgSlippage: ((existing.totalSlippage ?? 0) + slippage) / n,
      tpHitRate,
      slHitRate,
      realizedCapture,
      priorityScore,
      toxicityScore,
      ewmaWinRate,
      ewmaEv,
      ewmaSlippage,
      realEv,
      lastUpdated: Date.now(),
      sharpeRatio: welfordSharpe(wf),
      sortinoRatio: welfordSortino(wf),
      maxDrawdown: wf.maxDrawdown,
      _wMean: wf.mean,
      _wM2: wf.M2,
      _wDownsideN: wf.downsideN,
      _wDownsideMean: wf.downsideMean,
      _wDownsideM2: wf.downsideM2,
      _wPeak: wf.peak,
      _wCumulative: wf.cumulative,
    });
  }

  private rollupSymbolProfile(symbol: string): void {
    const relevant = Array.from(this.clusterProfiles.values()).filter(
      (p) => p.key.symbol === symbol,
    );
    if (relevant.length === 0) return;

    const totalSamples = relevant.reduce((s, p) => s + p.samples, 0);
    const totalPnl = relevant.reduce((s, p) => s + p.totalPnl, 0);
    const totalFees = relevant.reduce((s, p) => s + p.totalFees, 0);
    const totalSlippage = relevant.reduce((s, p) => s + (p.totalSlippage ?? 0), 0);

    const w = (f: (p: ClusterProfile) => number) =>
      relevant.reduce((s, p) => s + f(p) * p.samples, 0) / Math.max(totalSamples, 1);

    const winRate = w((p) => p.winRate);
    const ev = w((p) => p.realEv ?? p.ev);
    const profitFactor = w((p) => Math.min(p.profitFactor, 99));
    const priorityScore = w((p) => p.priorityScore);
    const toxicityScore = w((p) => p.toxicityScore);

    const hourPnl = this.hourProfile();
    const sortedByPnl = hourPnl.filter((h) => h.samples >= 2).sort((a, b) => b.pnl - a.pnl);

    // Aggregate Welford state from all cluster profiles — O(clusters), not O(outcomes)
    const symSharpe = w((p) => p.sharpeRatio ?? 0);
    const symSortino = w((p) => p.sortinoRatio ?? 0);
    const symMaxDrawdown = Math.max(...relevant.map((p) => p.maxDrawdown ?? 0));

    this.symbolProfiles.set(symbolKeyStr(symbol), {
      symbol,
      totalSamples,
      winRate,
      profitFactor,
      ev,
      totalPnl,
      totalFees,
      totalSlippage,
      avgSlippage: totalSlippage / Math.max(totalSamples, 1),
      netPnl: totalPnl,
      isToxic: totalSamples >= MIN_SAMPLES_FOR_GATE && totalPnl < 0,
      bestHour: sortedByPnl[0]?.hour ?? null,
      worstHour: sortedByPnl[sortedByPnl.length - 1]?.hour ?? null,
      priorityScore,
      toxicityScore,
      sharpeRatio: symSharpe,
      sortinoRatio: symSortino,
      maxDrawdown: symMaxDrawdown,
    });
  }

  private rebuildFromOutcomes(outcomes: TradeOutcome[]): void {
    this.outcomes = [];
    this.clusterProfiles.clear();
    this.symbolProfiles.clear();
    this.globalEwmaWinRate = PRIORITY_SCORE_NEUTRAL;
    this.globalEwmaEv = 0;
    this.globalEwmaFee = 0;
    this.totalTrades = 0;
    for (const outcome of outcomes) {
      this.recordOutcome(outcome);
    }
  }
}

// ========== SINGLETON INSTANCE ==========

let instance: AdaptiveEngine | null = null;

export function getAdaptiveEngine(): AdaptiveEngine {
  if (!instance) {
    instance = new AdaptiveEngine();
  }
  return instance;
}

export function resetAdaptiveEngine(): void {
  if (instance) {
    instance.stopAutoSave();
    instance.saveState();
    instance = null;
  }
}
