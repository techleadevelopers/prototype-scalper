import type { BotConfig } from "./botConfig";
import type { BtcRegime, PositionSide, TradeOutcome } from "./adaptiveEngine";
import type { DemoClosedTrade } from "./demoTradeStore";
import { auditPipeline } from "./pipelineAuditor";

export type PromotionState =
  | "DEMO_ONLY"
  | "SHADOW_LIVE"
  | "MICRO_LIVE"
  | "LIMITED_LIVE"
  | "STANDARD_LIVE"
  | "SUSPENDED";

export interface ReadinessScopeInput {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: PositionSide;
  playbook?: string | null;
  btcRegime?: BtcRegime | null;
  score?: number | null;
  context?: string | null;
  stackingDepth?: number | null;
  exitPolicy?: string | null;
  positionSizingTier?: string | null;
}

export interface ReadinessMetrics {
  demoTrades: number;
  demoPnl: number;
  demoProfitFactor: number;
  demoDrawdown: number;
  liveTrades: number;
  livePnl: number;
  liveProfitFactor: number;
  liveDrawdown: number;
  liveShadowTrades: number;
  liveShadowPnl: number;
  slippageLiveVsDemoBps: number;
  executionQuality: number;
  scoreCalibration: number;
  exitQuality: number;
  pipelineIntegrity: number;
  consecutiveLiveLosses: number;
}

export interface ApprovedReadinessScope {
  id: string;
  symbol: string;
  side: PositionSide;
  playbook: string;
  regime: string;
  scoreBucket: string;
  context: string;
  stackingDepth: number;
  exitPolicy: string;
  positionSizingTier: string;
  promotionState: PromotionState;
  readinessScore: number;
  maxMargin: number;
  maxPositions: number;
  maxDailyLoss: number;
  allowedScoreMin: number;
  killSwitchSensitivity: "HIGH" | "MEDIUM" | "LOW";
  metrics: ReadinessMetrics;
  reason: string;
  recommendations: string[];
}

export interface BlockedReadinessScope extends ApprovedReadinessScope {
  blockedReasons: string[];
}

export interface LiveReadinessStatus {
  liveReady: boolean;
  readinessScore: number;
  approvedScopes: ApprovedReadinessScope[];
  blockedScopes: BlockedReadinessScope[];
  reason: string;
  generatedAt: number;
  promotionStates: Record<PromotionState, number>;
  recommendations: string[];
}

export interface ReadinessDecision {
  allowed: boolean;
  readinessScopeId: string | null;
  promotionState: PromotionState;
  readinessScore: number;
  maxMargin: number;
  maxPositions: number;
  maxDailyLoss: number;
  allowedScoreMin: number;
  reason: string;
  gateRejects: string[];
}

interface NormalizedTrade {
  symbol: string;
  positionSide: PositionSide;
  side: "BUY" | "SELL";
  playbook: string;
  btcRegime: BtcRegime | "UNKNOWN";
  scoreBucket: string;
  context: string;
  stackingDepth: number;
  exitPolicy: string;
  positionSizingTier: string;
  realizedPnl: number;
  marginUsed: number;
  exitReason: string;
  totalSlippage: number;
  slippagePctNotional: number;
  entryTime: number;
  exitTime: number;
  isLive: boolean;
  isShadow: boolean;
  sideMismatch: boolean;
  executionDelayMs: number;
}

const PROMOTION_ORDER: PromotionState[] = [
  "DEMO_ONLY",
  "SHADOW_LIVE",
  "MICRO_LIVE",
  "LIMITED_LIVE",
  "STANDARD_LIVE",
  "SUSPENDED",
];

const DEFAULT_PLAYBOOK = "MOMENTUM_BREAKOUT_SCALP";
const DEFAULT_CONTEXT = "SNIPER_SCALP";
const DEFAULT_EXIT_POLICY = "TP_SL_PROTECTED";
const DEFAULT_TIER = "MICRO";

function envNum(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scoreBucket(score: number | null | undefined): string {
  if (!Number.isFinite(score ?? NaN)) return "SCORE_UNKNOWN";
  const floored = Math.floor(clamp(score!, 0, 1) * 10) / 10;
  return `SCORE_${floored.toFixed(1)}_${(floored + 0.1).toFixed(1)}`;
}

function scoreBucketMin(bucket: string): number {
  const match = /^SCORE_(\d\.\d)_/.exec(bucket);
  return match ? Number(match[1]) : envNum("LIVE_READINESS_DEFAULT_SCORE_MIN", 0.72);
}

function scopeId(parts: {
  symbol: string;
  positionSide: string;
  playbook: string;
  btcRegime: string;
  scoreBucket: string;
  context: string;
  stackingDepth: number;
  exitPolicy: string;
  positionSizingTier: string;
}): string {
  return [
    parts.symbol.toUpperCase(),
    parts.positionSide.toUpperCase(),
    parts.playbook.toUpperCase(),
    parts.btcRegime.toUpperCase(),
    parts.scoreBucket.toUpperCase(),
    parts.context.toUpperCase(),
    `D${parts.stackingDepth}`,
    parts.exitPolicy.toUpperCase(),
    parts.positionSizingTier.toUpperCase(),
  ].join(":");
}

function sideForPosition(positionSide: PositionSide): "BUY" | "SELL" {
  return positionSide === "LONG" ? "BUY" : "SELL";
}

function asPlaybook(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "sniper-v1" || raw === "candle-edge-v1") return DEFAULT_PLAYBOOK;
  return raw.toUpperCase();
}

function normalizeTelemetryOutcome(outcome: TradeOutcome): NormalizedTrade {
  const maybe = outcome as TradeOutcome & {
    playbook?: string;
    readinessScopeId?: string;
    promotionState?: PromotionState;
    stackingDepth?: number;
    exitPolicy?: string;
  };
  const score = outcome.recommendedMargin ? outcome.recommendedMargin / Math.max(outcome.marginUsed, 0.0001) : undefined;
  const isLive = outcome.source === "bingx-live" || outcome.sourceType === "live" || outcome.isDemo === false;
  return {
    symbol: outcome.symbol.toUpperCase(),
    positionSide: outcome.positionSide,
    side: outcome.side,
    playbook: asPlaybook(maybe.playbook ?? outcome.strategyVersion ?? outcome.featureVersion),
    btcRegime: outcome.btcRegime,
    scoreBucket: scoreBucket(score),
    context: String(outcome.sourceType ?? (isLive ? "LIVE_EXECUTION" : DEFAULT_CONTEXT)).toUpperCase(),
    stackingDepth: Math.max(1, maybe.stackingDepth ?? outcome.entryCount ?? 1),
    exitPolicy: String(maybe.exitPolicy ?? DEFAULT_EXIT_POLICY).toUpperCase(),
    positionSizingTier: String(outcome.riskTier ?? DEFAULT_TIER).toUpperCase(),
    realizedPnl: outcome.realizedPnl,
    marginUsed: outcome.marginUsed,
    exitReason: outcome.exitReason,
    totalSlippage: Math.max(0, outcome.totalSlippage ?? 0),
    slippagePctNotional: Math.max(0, outcome.slippagePctNotional ?? 0),
    entryTime: outcome.entryTime,
    exitTime: outcome.exitTime,
    isLive,
    isShadow: outcome.sourceType === "shadow",
    sideMismatch: sideForPosition(outcome.positionSide) !== outcome.side,
    executionDelayMs: Math.max(0, (outcome.positionConfirmedAt ?? outcome.orderAckAt ?? outcome.entryTime) - (outcome.signalCreatedAt ?? outcome.orderRequestedAt ?? outcome.entryTime)),
  };
}

function normalizeDemoTrade(trade: DemoClosedTrade): NormalizedTrade {
  return {
    symbol: trade.symbol.toUpperCase(),
    positionSide: trade.positionSide,
    side: trade.side,
    playbook: DEFAULT_PLAYBOOK,
    btcRegime: (trade.btcRegime as BtcRegime | undefined) ?? "UNKNOWN",
    scoreBucket: scoreBucket(trade.edgeScore),
    context: DEFAULT_CONTEXT,
    stackingDepth: Math.max(1, trade.stackingDepth ?? 1),
    exitPolicy: DEFAULT_EXIT_POLICY,
    positionSizingTier: DEFAULT_TIER,
    realizedPnl: trade.realizedPnl,
    marginUsed: trade.marginUsed,
    exitReason: trade.exitReason,
    totalSlippage: Math.max(0, trade.totalSlippage ?? 0),
    slippagePctNotional: Math.max(0, trade.slippagePctNotional ?? 0),
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    isLive: false,
    isShadow: false,
    sideMismatch: sideForPosition(trade.positionSide) !== trade.side,
    executionDelayMs: 0,
  };
}

function profitFactor(trades: NormalizedTrade[]): number {
  const grossWin = trades.filter((t) => t.realizedPnl > 0).reduce((sum, t) => sum + t.realizedPnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.realizedPnl < 0).reduce((sum, t) => sum + t.realizedPnl, 0));
  if (grossWin > 0 && grossLoss === 0) return 999;
  return grossLoss > 0 ? grossWin / grossLoss : 0;
}

function maxDrawdown(trades: NormalizedTrade[]): number {
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    cumulative += trade.realizedPnl;
    peak = Math.max(peak, cumulative);
    drawdown = Math.max(drawdown, peak - cumulative);
  }
  return drawdown;
}

function consecutiveLosses(trades: NormalizedTrade[]): number {
  let losses = 0;
  for (const trade of [...trades].sort((a, b) => b.exitTime - a.exitTime)) {
    if (trade.realizedPnl < 0) losses++;
    else break;
  }
  return losses;
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function metricsFor(scopeTrades: NormalizedTrade[], pipelineIntegrity: number): ReadinessMetrics {
  const demo = scopeTrades.filter((trade) => !trade.isLive && !trade.isShadow);
  const live = scopeTrades.filter((trade) => trade.isLive);
  const shadow = scopeTrades.filter((trade) => trade.isShadow);
  const demoSlippage = avg(demo.map((trade) => trade.slippagePctNotional * 10_000));
  const liveSlippage = avg(live.map((trade) => trade.slippagePctNotional * 10_000));
  const liveDelay = avg(live.map((trade) => trade.executionDelayMs));
  const allWithScores = scopeTrades.filter((trade) => trade.scoreBucket !== "SCORE_UNKNOWN");
  const winRateByScoreKnown = allWithScores.length
    ? allWithScores.filter((trade) => trade.realizedPnl > 0).length / allWithScores.length
    : 0.5;
  const tpRate = scopeTrades.length
    ? scopeTrades.filter((trade) => trade.exitReason === "TP").length / scopeTrades.length
    : 0;

  return {
    demoTrades: demo.length,
    demoPnl: round(demo.reduce((sum, trade) => sum + trade.realizedPnl, 0)),
    demoProfitFactor: round(profitFactor(demo)),
    demoDrawdown: round(maxDrawdown(demo)),
    liveTrades: live.length,
    livePnl: round(live.reduce((sum, trade) => sum + trade.realizedPnl, 0)),
    liveProfitFactor: round(profitFactor(live)),
    liveDrawdown: round(maxDrawdown(live)),
    liveShadowTrades: shadow.length,
    liveShadowPnl: round(shadow.reduce((sum, trade) => sum + trade.realizedPnl, 0)),
    slippageLiveVsDemoBps: round(live.length ? liveSlippage - demoSlippage : 0, 2),
    executionQuality: round(clamp(1 - liveDelay / envNum("LIVE_READINESS_MAX_EXEC_DELAY_MS", 1_500), 0, 1)),
    scoreCalibration: round(clamp(1 - Math.abs(winRateByScoreKnown - 0.55) / 0.55, 0, 1)),
    exitQuality: round(clamp(tpRate, 0, 1)),
    pipelineIntegrity,
    consecutiveLiveLosses: consecutiveLosses(live),
  };
}

function readinessScore(metrics: ReadinessMetrics): number {
  const sampleScore = clamp(metrics.demoTrades / envNum("LIVE_READINESS_MIN_DEMO_TRADES", 20), 0, 1);
  const pnlScore = metrics.demoPnl > 0 ? 1 : 0;
  const pfScore = clamp(metrics.demoProfitFactor / envNum("LIVE_READINESS_MIN_DEMO_PF", 1.25), 0, 1);
  const ddLimit = envNum("LIVE_READINESS_MAX_DEMO_DRAWDOWN_USDT", 10);
  const ddScore = clamp(1 - metrics.demoDrawdown / Math.max(ddLimit, 0.0001), 0, 1);
  const slipScore = clamp(1 - Math.max(0, metrics.slippageLiveVsDemoBps) / envNum("LIVE_READINESS_MAX_SLIPPAGE_DEGRADATION_BPS", 5), 0, 1);

  return round(
    sampleScore * 0.18 +
    pnlScore * 0.16 +
    pfScore * 0.16 +
    ddScore * 0.12 +
    metrics.scoreCalibration * 0.12 +
    metrics.pipelineIntegrity * 0.12 +
    metrics.executionQuality * 0.08 +
    metrics.exitQuality * 0.06,
  );
}

function degradeState(base: PromotionState, metrics: ReadinessMetrics): PromotionState {
  const maxLiveDd = envNum("LIVE_READINESS_MAX_LIVE_DRAWDOWN_USDT", 4);
  const maxLosses = envNum("LIVE_READINESS_MAX_CONSECUTIVE_LIVE_LOSSES", 3);
  const minLivePf = envNum("LIVE_READINESS_MIN_LIVE_PF", 0.9);
  const critical =
    metrics.pipelineIntegrity < 0.8 ||
    metrics.executionQuality < 0.4 ||
    metrics.slippageLiveVsDemoBps > envNum("LIVE_READINESS_CRITICAL_SLIPPAGE_DEGRADATION_BPS", 12);
  if (critical) return "SUSPENDED";
  if (metrics.liveTrades === 0) return base;
  const degradeBy =
    (metrics.liveDrawdown > maxLiveDd ? 1 : 0) +
    (metrics.consecutiveLiveLosses >= maxLosses ? 1 : 0) +
    (metrics.liveProfitFactor > 0 && metrics.liveProfitFactor < minLivePf ? 1 : 0);
  const ordered: PromotionState[] = ["DEMO_ONLY", "SHADOW_LIVE", "MICRO_LIVE", "LIMITED_LIVE", "STANDARD_LIVE"];
  const index = ordered.indexOf(base);
  if (index < 0) return base;
  return ordered[clamp(index - degradeBy, 0, ordered.length - 1)];
}

function promotionState(score: number, metrics: ReadinessMetrics): PromotionState {
  if (metrics.pipelineIntegrity < 0.65) return "SUSPENDED";
  if (score >= 0.90 && metrics.demoTrades >= envNum("LIVE_READINESS_STANDARD_TRADES", 80) && metrics.liveTrades >= 30) {
    return degradeState("STANDARD_LIVE", metrics);
  }
  if (score >= 0.82 && metrics.demoTrades >= envNum("LIVE_READINESS_LIMITED_TRADES", 40)) {
    return degradeState("LIMITED_LIVE", metrics);
  }
  if (score >= envNum("LIVE_READINESS_APPROVAL_SCORE", 0.72)) return degradeState("MICRO_LIVE", metrics);
  if (metrics.demoTrades >= Math.floor(envNum("LIVE_READINESS_MIN_DEMO_TRADES", 20) * 0.5)) return "SHADOW_LIVE";
  return "DEMO_ONLY";
}

function constraintsFor(state: PromotionState, config: BotConfig, scoreMin: number): {
  maxMargin: number;
  maxPositions: number;
  maxDailyLoss: number;
  allowedScoreMin: number;
  killSwitchSensitivity: "HIGH" | "MEDIUM" | "LOW";
} {
  const liveMarginBase = Math.max(0.1, config.marginPerTrade);
  if (state === "STANDARD_LIVE") {
    return {
      maxMargin: round(Math.min(liveMarginBase, envNum("LIVE_READINESS_STANDARD_MAX_MARGIN", liveMarginBase))),
      maxPositions: Math.min(config.maxPositionsPerSymbol, envNum("LIVE_READINESS_STANDARD_MAX_POSITIONS", 2)),
      maxDailyLoss: round(envNum("LIVE_READINESS_STANDARD_DAILY_LOSS", Math.max(1, config.maxSessionLoss * 0.5))),
      allowedScoreMin: round(Math.max(scoreMin, envNum("LIVE_READINESS_STANDARD_SCORE_MIN", 0.78)), 2),
      killSwitchSensitivity: "LOW",
    };
  }
  if (state === "LIMITED_LIVE") {
    return {
      maxMargin: round(Math.min(liveMarginBase * 0.5, envNum("LIVE_READINESS_LIMITED_MAX_MARGIN", 2))),
      maxPositions: Math.min(config.maxPositionsPerSymbol, envNum("LIVE_READINESS_LIMITED_MAX_POSITIONS", 2)),
      maxDailyLoss: round(envNum("LIVE_READINESS_LIMITED_DAILY_LOSS", Math.max(0.5, config.maxSessionLoss * 0.25))),
      allowedScoreMin: round(Math.max(scoreMin, envNum("LIVE_READINESS_LIMITED_SCORE_MIN", 0.74)), 2),
      killSwitchSensitivity: "MEDIUM",
    };
  }
  return {
    maxMargin: round(Math.min(liveMarginBase * 0.25, envNum("LIVE_READINESS_MICRO_MAX_MARGIN", 1))),
    maxPositions: 1,
    maxDailyLoss: round(envNum("LIVE_READINESS_MICRO_DAILY_LOSS", 1)),
    allowedScoreMin: round(Math.max(scoreMin, envNum("LIVE_READINESS_MICRO_SCORE_MIN", 0.72)), 2),
    killSwitchSensitivity: "HIGH",
  };
}

function blockedReasons(metrics: ReadinessMetrics, state: PromotionState, score: number, scopeTrades: NormalizedTrade[]): string[] {
  const reasons: string[] = [];
  if (state === "SUSPENDED") reasons.push("critical_live_or_pipeline_failure");
  if (metrics.demoTrades < envNum("LIVE_READINESS_MIN_DEMO_TRADES", 20)) reasons.push("insufficient_demo_sample");
  if (metrics.demoPnl <= 0) reasons.push("demo_pnl_not_positive");
  if (metrics.demoProfitFactor < envNum("LIVE_READINESS_MIN_DEMO_PF", 1.25)) reasons.push("demo_profit_factor_below_minimum");
  if (metrics.demoDrawdown > envNum("LIVE_READINESS_MAX_DEMO_DRAWDOWN_USDT", 10)) reasons.push("demo_drawdown_too_high");
  if (metrics.scoreCalibration < envNum("LIVE_READINESS_MIN_SCORE_CALIBRATION", 0.55)) reasons.push("score_calibration_degraded");
  if (metrics.pipelineIntegrity < envNum("LIVE_READINESS_MIN_PIPELINE_INTEGRITY", 0.9)) reasons.push("pipeline_integrity_degraded");
  if (metrics.executionQuality < envNum("LIVE_READINESS_MIN_EXECUTION_QUALITY", 0.65)) reasons.push("execution_quality_degraded");
  if (metrics.slippageLiveVsDemoBps > envNum("LIVE_READINESS_MAX_SLIPPAGE_DEGRADATION_BPS", 5)) reasons.push("slippage_worse_than_demo");
  if (metrics.exitQuality < envNum("LIVE_READINESS_MIN_EXIT_QUALITY", 0.3)) reasons.push("exit_intelligence_unproven");
  if (scopeTrades.some((trade) => trade.sideMismatch)) reasons.push("side_mismatch_detected");
  if (score < envNum("LIVE_READINESS_APPROVAL_SCORE", 0.72)) reasons.push("readiness_score_below_approval");
  return reasons;
}

function buildRecommendations(reasons: string[]): string[] {
  const mapping: Record<string, string> = {
    insufficient_demo_sample: "Keep scope in demo until the minimum sample is reached.",
    demo_pnl_not_positive: "Do not promote until demo PnL is positive for this exact setup.",
    demo_profit_factor_below_minimum: "Improve playbook or score threshold before live exposure.",
    demo_drawdown_too_high: "Reduce stacking depth, margin, or loosen exits only after new demo validation.",
    score_calibration_degraded: "Recalibrate score buckets before live promotion.",
    pipeline_integrity_degraded: "Fix pipeline gaps before using real money.",
    execution_quality_degraded: "Keep shadow/live audit enabled and investigate order latency.",
    slippage_worse_than_demo: "Lower margin or avoid low-liquidity windows for this scope.",
    exit_intelligence_unproven: "Require TP/SL outcome tracking before promotion.",
    side_mismatch_detected: "Block live until LONG/BUY and SHORT/SELL mapping is clean.",
    readiness_score_below_approval: "Keep scope in shadow or demo.",
    critical_live_or_pipeline_failure: "Suspend scope and require manual review.",
  };
  return Array.from(new Set(reasons.map((reason) => mapping[reason] ?? reason)));
}

function scopeMatchesTrade(scope: ReadinessScopeInput, trade: NormalizedTrade): boolean {
  return trade.symbol === scope.symbol.toUpperCase() && trade.positionSide === scope.positionSide;
}

export function buildLiveReadinessStatus(input: {
  outcomes: TradeOutcome[];
  closedDemoTrades: DemoClosedTrade[];
  config: BotConfig;
}): LiveReadinessStatus {
  const pipeline = auditPipeline({ outcomes: input.outcomes, closedDemoTrades: input.closedDemoTrades });
  const totalGaps = pipeline.criticalGaps.length + pipeline.highGaps.length + pipeline.mediumGaps.length;
  const pipelineIntegrity = pipeline.health === "CRITICAL"
    ? 0.55
    : pipeline.health === "DEGRADED"
      ? clamp(1 - totalGaps / Math.max(50, pipeline.totalOutcomes + input.closedDemoTrades.length), 0.7, 0.95)
      : 1;

  const trades = [
    ...input.closedDemoTrades.map(normalizeDemoTrade),
    ...input.outcomes.map(normalizeTelemetryOutcome),
  ];
  const byScope = new Map<string, NormalizedTrade[]>();
  for (const trade of trades) {
    const id = scopeId(trade);
    const existing = byScope.get(id) ?? [];
    existing.push(trade);
    byScope.set(id, existing);
  }

  const approvedScopes: ApprovedReadinessScope[] = [];
  const blockedScopes: BlockedReadinessScope[] = [];
  const promotionStates = Object.fromEntries(PROMOTION_ORDER.map((state) => [state, 0])) as Record<PromotionState, number>;

  for (const [id, scopeTrades] of byScope.entries()) {
    const first = scopeTrades[0];
    const metrics = metricsFor(scopeTrades, pipelineIntegrity);
    const score = readinessScore(metrics);
    const state = promotionState(score, metrics);
    promotionStates[state]++;
    const scoreMin = Math.max(scoreBucketMin(first.scoreBucket), envNum("LIVE_READINESS_DEFAULT_SCORE_MIN", 0.72));
    const constraints = constraintsFor(state, input.config, scoreMin);
    const reasons = blockedReasons(metrics, state, score, scopeTrades);
    const base: ApprovedReadinessScope = {
      id,
      symbol: first.symbol,
      side: first.positionSide,
      playbook: first.playbook,
      regime: first.btcRegime,
      scoreBucket: first.scoreBucket,
      context: first.context,
      stackingDepth: first.stackingDepth,
      exitPolicy: first.exitPolicy,
      positionSizingTier: first.positionSizingTier,
      promotionState: state,
      readinessScore: score,
      ...constraints,
      metrics,
      reason: reasons.length === 0 ? "demo_validated_positive_pf_low_slippage" : reasons[0],
      recommendations: buildRecommendations(reasons),
    };
    if (["MICRO_LIVE", "LIMITED_LIVE", "STANDARD_LIVE"].includes(state) && reasons.length === 0) {
      approvedScopes.push(base);
    } else {
      blockedScopes.push({ ...base, blockedReasons: reasons.length ? reasons : ["scope_not_live_promoted"] });
    }
  }

  approvedScopes.sort((a, b) => b.readinessScore - a.readinessScore);
  blockedScopes.sort((a, b) => b.readinessScore - a.readinessScore);
  const readinessScoreValue = approvedScopes.length
    ? avg(approvedScopes.map((scope) => scope.readinessScore))
    : avg(blockedScopes.slice(0, 10).map((scope) => scope.readinessScore));
  const recommendations = Array.from(new Set(blockedScopes.flatMap((scope) => scope.recommendations))).slice(0, 10);

  return {
    liveReady: approvedScopes.length > 0,
    readinessScore: round(readinessScoreValue || 0),
    approvedScopes,
    blockedScopes,
    reason: approvedScopes.length > 0 ? "granular_scopes_ready_for_selective_live" : "no_scope_meets_live_promotion_criteria",
    generatedAt: Date.now(),
    promotionStates,
    recommendations,
  };
}

export function evaluateLiveReadinessForOrder(input: {
  status: LiveReadinessStatus;
  order: ReadinessScopeInput;
  config: BotConfig;
  openSameSidePositions?: number;
}): ReadinessDecision {
  const symbol = input.order.symbol.toUpperCase();
  const score = input.order.score ?? 0;
  const candidates = input.status.approvedScopes.filter((scope) =>
    scope.symbol === symbol &&
    scope.side === input.order.positionSide &&
    scope.playbook === asPlaybook(input.order.playbook ?? DEFAULT_PLAYBOOK) &&
    (input.order.btcRegime ? scope.regime === input.order.btcRegime : true),
  );
  const scope = candidates
    .filter((candidate) => score >= candidate.allowedScoreMin)
    .sort((a, b) => b.readinessScore - a.readinessScore)[0];

  if (!scope) {
    const blocked = input.status.blockedScopes.find((candidate) =>
      candidate.symbol === symbol && candidate.side === input.order.positionSide,
    );
    return {
      allowed: false,
      readinessScopeId: blocked?.id ?? null,
      promotionState: blocked?.promotionState ?? "DEMO_ONLY",
      readinessScore: blocked?.readinessScore ?? 0,
      maxMargin: 0,
      maxPositions: 0,
      maxDailyLoss: 0,
      allowedScoreMin: blocked?.allowedScoreMin ?? envNum("LIVE_READINESS_DEFAULT_SCORE_MIN", 0.72),
      reason: blocked?.reason ?? "scope_not_approved_for_live",
      gateRejects: [`LIVE_READINESS_REJECT: ${blocked?.reason ?? "scope_not_approved_for_live"}`],
    };
  }

  if ((input.openSameSidePositions ?? 0) >= scope.maxPositions) {
    return {
      allowed: false,
      readinessScopeId: scope.id,
      promotionState: scope.promotionState,
      readinessScore: scope.readinessScore,
      maxMargin: scope.maxMargin,
      maxPositions: scope.maxPositions,
      maxDailyLoss: scope.maxDailyLoss,
      allowedScoreMin: scope.allowedScoreMin,
      reason: "live_readiness_scope_position_limit",
      gateRejects: [`LIVE_READINESS_POSITION_REJECT: ${scope.symbol} ${scope.side} at ${input.openSameSidePositions}/${scope.maxPositions}`],
    };
  }

  return {
    allowed: true,
    readinessScopeId: scope.id,
    promotionState: scope.promotionState,
    readinessScore: scope.readinessScore,
    maxMargin: scope.maxMargin,
    maxPositions: scope.maxPositions,
    maxDailyLoss: scope.maxDailyLoss,
    allowedScoreMin: scope.allowedScoreMin,
    reason: scope.reason,
    gateRejects: [],
  };
}
