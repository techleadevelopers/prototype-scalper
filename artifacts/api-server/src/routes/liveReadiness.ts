import { Router, type Request, type Response } from "express";
import { getBotConfig } from "../lib/botConfig";
import { loadClosedTrades } from "../lib/demoTradeStore";
import { buildLiveReadinessStatus } from "../lib/live_readiness";
import { getKillSwitchStatus } from "../lib/killSwitch";
import { getLiveWatcherStats } from "../lib/livePositionWatcher";
import { auditPipeline } from "../lib/pipelineAuditor";
import { exportAllOutcomes } from "../lib/telemetryStore";

const router = Router();

router.get("/live-readiness/status", async (_req: Request, res: Response) => {
  try {
    const status = buildLiveReadinessStatus({
      outcomes: exportAllOutcomes(),
      closedDemoTrades: await loadClosedTrades(5_000),
      config: getBotConfig(),
    });
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: "Failed to build live readiness status",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

router.get("/sniper/promotion/status", async (_req: Request, res: Response) => {
  try {
    const config = getBotConfig();
    const outcomes = exportAllOutcomes();
    const closedDemoTrades = await loadClosedTrades(5_000);
    const liveReadiness = buildLiveReadinessStatus({ outcomes, closedDemoTrades, config });
    const pipelineAudit = auditPipeline({ outcomes, closedDemoTrades });
    const killSwitch = getKillSwitchStatus();
    const liveWatcher = getLiveWatcherStats();

    const requiredEvidenceMissing = liveReadiness.blockedScopes
      .filter((scope) => scope.blockedReasons.some((reason) =>
        reason === "insufficient_demo_sample"
        || reason === "pipeline_integrity_degraded"
        || reason === "score_calibration_degraded"
        || reason === "exit_intelligence_unproven"
      ))
      .slice(0, 25)
      .map((scope) => ({
        scopeId: scope.id,
        symbol: scope.symbol,
        side: scope.side,
        missing: scope.blockedReasons,
      }));

    const demotionCandidates = [
      ...liveReadiness.approvedScopes,
      ...liveReadiness.blockedScopes,
    ]
      .filter((scope) =>
        scope.promotionState === "SUSPENDED"
        || scope.metrics.liveDrawdown > 0
        || scope.metrics.consecutiveLiveLosses > 0
        || scope.metrics.slippageLiveVsDemoBps > 0
        || scope.metrics.liveProfitFactor > 0 && scope.metrics.liveProfitFactor < 1,
      )
      .slice(0, 25);

    const recommendedNextAction = !killSwitch.entryAllowed
      ? "hold_all_new_promotions_until_kill_switch_clears"
      : pipelineAudit.health === "CRITICAL"
        ? "fix_pipeline_critical_gaps_before_live_promotion"
        : liveReadiness.approvedScopes.length > 0
          ? "promote_only_approved_scopes_one_state_at_a_time_starting_micro_live"
          : "continue_demo_or_shadow_collection_until_scope_evidence_is_sufficient";

    res.json({
      globalPromotionAllowed: false,
      approvedScopes: liveReadiness.approvedScopes,
      blockedScopes: liveReadiness.blockedScopes.slice(0, 100),
      nextPromotionCandidates: liveReadiness.blockedScopes
        .filter((scope) => scope.promotionState === "SHADOW_LIVE")
        .slice(0, 25),
      demotionCandidates,
      requiredEvidenceMissing,
      riskCaps: {
        MICRO_LIVE: {
          maxMargin: Number(process.env["LIVE_READINESS_MICRO_MAX_MARGIN"] ?? 1),
          maxPositions: 1,
          maxDailyLoss: Number(process.env["LIVE_READINESS_MICRO_DAILY_LOSS"] ?? 1),
          scoreMin: Number(process.env["LIVE_READINESS_MICRO_SCORE_MIN"] ?? 0.72),
        },
        LIMITED_LIVE: {
          maxMargin: Number(process.env["LIVE_READINESS_LIMITED_MAX_MARGIN"] ?? 2),
          maxPositions: Number(process.env["LIVE_READINESS_LIMITED_MAX_POSITIONS"] ?? 2),
          maxDailyLoss: Number(process.env["LIVE_READINESS_LIMITED_DAILY_LOSS"] ?? Math.max(0.5, config.maxSessionLoss * 0.25)),
          scoreMin: Number(process.env["LIVE_READINESS_LIMITED_SCORE_MIN"] ?? 0.74),
        },
        STANDARD_LIVE: {
          maxMargin: Number(process.env["LIVE_READINESS_STANDARD_MAX_MARGIN"] ?? config.marginPerTrade),
          maxPositions: Number(process.env["LIVE_READINESS_STANDARD_MAX_POSITIONS"] ?? 2),
          maxDailyLoss: Number(process.env["LIVE_READINESS_STANDARD_DAILY_LOSS"] ?? Math.max(1, config.maxSessionLoss * 0.5)),
          scoreMin: Number(process.env["LIVE_READINESS_STANDARD_SCORE_MIN"] ?? 0.78),
        },
      },
      recommendedNextAction,
      reasons: [
        liveReadiness.reason,
        `pipeline_${pipelineAudit.health.toLowerCase()}`,
        `kill_switch_${killSwitch.state.toLowerCase()}`,
      ],
      metricsByScope: {
        approved: liveReadiness.approvedScopes.map((scope) => ({ scopeId: scope.id, metrics: scope.metrics })),
        blocked: liveReadiness.blockedScopes.slice(0, 100).map((scope) => ({ scopeId: scope.id, metrics: scope.metrics })),
      },
      related: {
        liveReadiness: "/api/live-readiness/status",
        scoreCalibration: "/api/score-calibration/status",
        executionAudit: "/api/execution/audit",
        pipelineAudit: "/api/pipeline/audit",
        experiments: "/api/strategy-memory/status",
        regimePlaybook: "/api/symbol-rotation/status",
        liveWatcher: "/api/bot/watcher",
      },
      audits: {
        liveReadiness: {
          liveReady: liveReadiness.liveReady,
          readinessScore: liveReadiness.readinessScore,
          promotionStates: liveReadiness.promotionStates,
        },
        pipeline: {
          health: pipelineAudit.health,
          criticalGaps: pipelineAudit.criticalGaps.length,
          highGaps: pipelineAudit.highGaps.length,
          blockedFromLearning: pipelineAudit.blockedFromLearning,
          topIntegrityLossCauses: pipelineAudit.topIntegrityLossCauses,
        },
        killSwitch: {
          state: killSwitch.state,
          entryAllowed: killSwitch.entryAllowed,
          activeTriggers: killSwitch.activeTriggers,
          recommendedAction: killSwitch.recommendedAction,
        },
        liveWatcher: {
          running: liveWatcher.running,
          trackedEntries: liveWatcher.trackedEntries,
          lastPollAt: liveWatcher.lastPollAt,
          lastClosedAt: liveWatcher.lastClosedAt,
          lastError: liveWatcher.lastError,
        },
      },
      generatedAt: Date.now(),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to build sniper promotion status",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
