import { Router, type Request, type Response } from "express";
import { getBotConfig } from "../lib/botConfig";
import { exportAllOutcomes } from "../lib/telemetryStore";
import { getServiceState } from "../lib/serviceState";
import { getMarketDataQualityStatus } from "../lib/marketDataQuality";
import { getLiveWatcherStats } from "../lib/livePositionWatcher";
import { getKillSwitchStatus } from "../lib/killSwitch";
import { getAggressionStatus } from "../lib/aggressionController";

const router = Router();

function isDemoOutcome(outcome: { isDemo?: boolean; source?: string }): boolean {
  return outcome.isDemo === true || outcome.source === "bingx-vst";
}

router.get("/kill-switch/status", (_req: Request, res: Response) => {
  const config = getBotConfig();
  const serviceState = getServiceState();
  const marketDataQuality = getMarketDataQualityStatus();
  const watcher = getLiveWatcherStats();
  const aggression = getAggressionStatus();
  const outcomes = exportAllOutcomes().filter((outcome) => !isDemoOutcome(outcome));
  const now = Date.now();
  const lastWatcherClose = Number((watcher as { lastClosedAt?: number }).lastClosedAt ?? 0);
  const exitMonitorDelayMs = lastWatcherClose > 0 ? Math.max(0, now - lastWatcherClose) : 0;

  const decision = getKillSwitchStatus({
    outcomes,
    config,
    serviceState,
    dataQuality: {
      stale: marketDataQuality.metrics.stale,
      invalid: marketDataQuality.metrics.invalid,
      missing: marketDataQuality.metrics.missing,
      duplicates: marketDataQuality.metrics.duplicates,
      incidents: marketDataQuality.incidents,
      activeExecutionClaims: marketDataQuality.activeExecutionClaims,
    },
    pipeline: {
      dataFresh: serviceState.lastBtcPriceAt === null ? true : now - serviceState.lastBtcPriceAt <= serviceState.staleDataThresholdMs,
      integrityOk: serviceState.state !== "PAUSED",
      scoreCalibrationHealthy: true,
      symbolRotationHealthy: true,
      exitMonitorDelayMs,
    },
    maxSessionLossRemaining: config.maxSessionLoss,
    marketRegime: aggression.aggressionState === "PAUSED" ? "HIGH_VOLATILITY_CHAOS" : "NEUTRAL",
  });

  res.json(decision);
});

export default router;
