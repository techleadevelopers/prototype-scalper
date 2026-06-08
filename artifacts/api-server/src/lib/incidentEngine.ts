import { auditPipeline } from "./pipelineAuditor";
import { getOpenTrades, loadClosedTrades } from "./demoTradeStore";
import { exportAllOutcomes } from "./telemetryStore";
import { getKillSwitchStatus } from "./killSwitch";
import { getLiveWatcherStats } from "./livePositionWatcher";
import {
  getQuantBrainOperationalStats,
  getQuantBrainQueueStats,
  getQuantBrainScoreCalibrationStatus,
} from "./quantBrainClient";

export type IncidentSeverity = "INFO" | "WARN" | "CRITICAL";
export type IncidentStatus = "ACTIVE" | "RESOLVED";

export interface IncidentInput {
  severity: IncidentSeverity;
  fingerprint: string;
  title: string;
  metric: string;
  suggestedAction: string;
  subsystem: string;
  detail?: Record<string, unknown>;
  ttlMs?: number;
  cooldownMs?: number;
}

export interface Incident extends IncidentInput {
  id: string;
  status: IncidentStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
}

const incidents = new Map<string, Incident>();
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_INCIDENTS = 500;

function prune(now = Date.now()): void {
  for (const [fingerprint, incident] of incidents.entries()) {
    const ttlMs = incident.ttlMs ?? DEFAULT_TTL_MS;
    if (incident.status === "ACTIVE" && now - incident.lastSeenAt > ttlMs) {
      incident.status = "RESOLVED";
      incident.resolvedAt = now;
    }
    if (incident.status === "RESOLVED" && incident.resolvedAt && now - incident.resolvedAt > 24 * 60 * 60_000) {
      incidents.delete(fingerprint);
    }
  }
  while (incidents.size > MAX_INCIDENTS) {
    const oldest = [...incidents.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!oldest) break;
    incidents.delete(oldest.fingerprint);
  }
}

export function upsertIncident(input: IncidentInput, now = Date.now()): Incident {
  prune(now);
  const existing = incidents.get(input.fingerprint);
  if (existing) {
    existing.severity = input.severity;
    existing.title = input.title;
    existing.metric = input.metric;
    existing.suggestedAction = input.suggestedAction;
    existing.subsystem = input.subsystem;
    existing.detail = input.detail;
    existing.ttlMs = input.ttlMs;
    existing.cooldownMs = input.cooldownMs;
    existing.status = "ACTIVE";
    existing.resolvedAt = null;
    const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (now - existing.lastSeenAt >= cooldownMs) existing.occurrences += 1;
    existing.lastSeenAt = now;
    return existing;
  }

  const incident: Incident = {
    ...input,
    id: input.fingerprint,
    status: "ACTIVE",
    firstSeenAt: now,
    lastSeenAt: now,
    occurrences: 1,
    acknowledgedAt: null,
    resolvedAt: null,
  };
  incidents.set(input.fingerprint, incident);
  return incident;
}

export function acknowledgeIncident(fingerprint: string, now = Date.now()): Incident | null {
  const incident = incidents.get(fingerprint);
  if (!incident) return null;
  incident.acknowledgedAt = now;
  return incident;
}

export function listIncidents(): Incident[] {
  prune();
  return [...incidents.values()].sort((a, b) => {
    const severity = { CRITICAL: 3, WARN: 2, INFO: 1 };
    return severity[b.severity] - severity[a.severity] || b.lastSeenAt - a.lastSeenAt;
  });
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

export async function collectSniperIncidents(): Promise<Incident[]> {
  const now = Date.now();
  const killSwitch = getKillSwitchStatus();
  const watcher = getLiveWatcherStats();
  const quantQueue = getQuantBrainQueueStats();
  const quantOps = getQuantBrainOperationalStats();
  const outcomes = exportAllOutcomes();

  if (killSwitch.state === "HARD_PAUSE") {
    upsertIncident({
      severity: "CRITICAL",
      fingerprint: "kill-switch:hard-pause",
      title: "Kill switch is in HARD_PAUSE",
      metric: "killSwitch.state",
      suggestedAction: "Keep exits and watcher running; investigate drawdown, slippage, data integrity, and service state before reset.",
      subsystem: "killSwitch",
      detail: { state: killSwitch.state, reason: killSwitch.reason, triggers: killSwitch.activeTriggers },
    }, now);
  }

  const watcherLagMs = watcher.lastPollAt ? now - watcher.lastPollAt : Number.POSITIVE_INFINITY;
  const watcherCriticalLagMs = Math.max(60_000, watcher.pollIntervalMs * 5);
  if (watcher.running && watcherLagMs > watcherCriticalLagMs) {
    upsertIncident({
      severity: "CRITICAL",
      fingerprint: "watcher:critical-lag",
      title: "Live position watcher lag is critical",
      metric: "watcher.lastPollAt",
      suggestedAction: "Verify BingX private API health and watcher credentials; do not resume new entries until polling recovers.",
      subsystem: "livePositionWatcher",
      detail: { watcherLagMs, pollIntervalMs: watcher.pollIntervalMs, lastError: watcher.lastError },
    }, now);
  }

  if ((!watcher.running || watcher.credentials === "missing") && watcher.trackedEntries > 0) {
    upsertIncident({
      severity: "CRITICAL",
      fingerprint: "watcher:unprotected-live-position",
      title: "Tracked live positions are not covered by the watcher",
      metric: "watcher.trackedEntries",
      suggestedAction: "Restore watcher credentials/startup before opening new entries; inspect open positions manually.",
      subsystem: "livePositionWatcher",
      detail: { running: watcher.running, credentials: watcher.credentials, trackedEntries: watcher.trackedEntries },
    }, now);
  }

  if (quantQueue.pendingOutcomes >= quantQueue.maxPendingOutcomes * 0.8 || quantQueue.flushFailures > 0) {
    upsertIncident({
      severity: quantQueue.pendingOutcomes >= quantQueue.maxPendingOutcomes ? "CRITICAL" : "WARN",
      fingerprint: "quant-brain:outbox-growing",
      title: "Quant Brain outbox is growing or failing to flush",
      metric: "quantBrain.pendingOutcomes",
      suggestedAction: "Check Quant Brain availability and flush failures; preserve outbox history before manual intervention.",
      subsystem: "quantBrainClient",
      detail: quantQueue,
    }, now);
  }

  if (quantOps.gateMode === "enforce" && (!quantOps.urlConfigured || quantOps.lastRequestErrorAt)) {
    upsertIncident({
      severity: "CRITICAL",
      fingerprint: "quant-brain:offline-enforce",
      title: "Quant Brain is unavailable while gate mode is enforce",
      metric: "quantBrain.lastRequestErrorAt",
      suggestedAction: "Switch to shadow/micro mode or restore Quant Brain before allowing live entries.",
      subsystem: "quantBrainClient",
      detail: quantOps,
    }, now);
  }

  if (quantOps.timeoutRate >= 0.10 && quantOps.requestTimeoutCount >= 3) {
    upsertIncident({
      severity: "WARN",
      fingerprint: "quant-brain:timeout-rate",
      title: "Quant Brain timeout rate is elevated",
      metric: "quantBrain.timeoutRate",
      suggestedAction: "Lower dependency on enforce gates or investigate sidecar/network latency.",
      subsystem: "quantBrainClient",
      detail: quantOps,
    }, now);
  }

  const slippageP95Bps = p95(outcomes.map((outcome) => (outcome.slippagePctNotional ?? 0) * 10_000));
  if (slippageP95Bps >= 15) {
    upsertIncident({
      severity: slippageP95Bps >= 30 ? "CRITICAL" : "WARN",
      fingerprint: "execution:slippage-p95-high",
      title: "Execution slippage p95 is elevated",
      metric: "execution.p95SlippageBps",
      suggestedAction: "Reduce size, avoid thin symbols, and review market order usage before resuming normal aggression.",
      subsystem: "execution",
      detail: { slippageP95Bps },
    }, now);
  }

  const recent = outcomes.filter((outcome) => now - outcome.exitTime <= 60 * 60_000);
  const executionDrag = recent.reduce((sum, outcome) => sum + Math.max(0, outcome.totalSlippage ?? 0), 0);
  const realizedLoss = recent.reduce((sum, outcome) => sum + Math.max(0, -outcome.realizedPnl), 0);
  if (realizedLoss > 0 && executionDrag / realizedLoss >= 0.35 && executionDrag >= 1) {
    upsertIncident({
      severity: "WARN",
      fingerprint: "execution:loss-spike",
      title: "Execution drag is a large share of recent losses",
      metric: "execution.executionDragToLoss",
      suggestedAction: "Pause new entries and inspect latency, spread, slippage and symbol liquidity.",
      subsystem: "execution",
      detail: { executionDrag, realizedLoss, ratio: executionDrag / realizedLoss },
    }, now);
  }

  const pipeline = auditPipeline({
    outcomes,
    openDemoTrades: getOpenTrades(),
    closedDemoTrades: await loadClosedTrades(2_000),
  });
  if (pipeline.health === "CRITICAL") {
    upsertIncident({
      severity: "CRITICAL",
      fingerprint: "pipeline:integrity-critical",
      title: "Pipeline integrity is critical",
      metric: "pipeline.criticalGaps",
      suggestedAction: "Block new entries until duplicate IDs, orphan positions, and learning blockers are reconciled.",
      subsystem: "pipeline",
      detail: {
        criticalGaps: pipeline.criticalGaps.length,
        duplicateExecutions: pipeline.duplicateExecutions,
        topIntegrityLossCauses: pipeline.topIntegrityLossCauses,
      },
    }, now);
  }

  if (pipeline.duplicateExecutions > 0) {
    upsertIncident({
      severity: "CRITICAL",
      fingerprint: "pipeline:duplicate-execution-claim",
      title: "Duplicate execution identifiers detected",
      metric: "pipeline.duplicateExecutions",
      suggestedAction: "Stop new entries and reconcile marketEventId/clientOrderId before learning or replay.",
      subsystem: "pipeline",
      detail: { duplicateExecutions: pipeline.duplicateExecutions },
    }, now);
  }

  const scoreCalibration = await getQuantBrainScoreCalibrationStatus(30, 5000).catch((error: unknown) => ({ error }));
  const scoreTruth = (scoreCalibration as { scoreTruth?: { calibrationQuality?: string; overconfidence?: boolean } }).scoreTruth;
  if (scoreTruth?.calibrationQuality === "BAD" || scoreTruth?.overconfidence === true) {
    upsertIncident({
      severity: "WARN",
      fingerprint: "quant-brain:score-calibration-bad",
      title: "Score calibration is bad or overconfident",
      metric: "scoreCalibration.scoreTruth",
      suggestedAction: "Raise sniper thresholds or force shadow/micro mode until calibration improves.",
      subsystem: "quantBrain",
      detail: { scoreTruth },
    }, now);
  }

  return listIncidents();
}

export async function exportIncidentReport() {
  const activeIncidents = await collectSniperIncidents();
  return {
    generatedAt: Date.now(),
    activeIncidents,
    killSwitch: getKillSwitchStatus(),
    watcher: getLiveWatcherStats(),
    quantBrain: {
      queue: getQuantBrainQueueStats(),
      operational: getQuantBrainOperationalStats(),
    },
  };
}

export function _resetIncidentEngineForTesting(): void {
  incidents.clear();
}
