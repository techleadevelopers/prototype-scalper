import { createHash } from "crypto";
import type { DemoClosedTrade, DemoTradeEntry } from "./demoTradeStore";

export const STACKING_CONTROL_CAPS = [1, 3, 5, 10] as const;
export type StackingControlCap = typeof STACKING_CONTROL_CAPS[number];

export interface StackingGateInput {
  openEntries: DemoTradeEntry[];
  proposedSide: "LONG" | "SHORT";
  edgeScore: number;
  calibratedProbability: number | null;
  uncertaintyType: string | null;
  marketEventId: string | null;
  stateFingerprint: string;
  now: number;
  cooldownMs: number;
  campaignCap: StackingControlCap;
  proposedMargin: number;
  campaignDrawdownPct: number;
  maxCampaignDrawdownPct: number;
  portfolioCapacityAvailable: boolean;
}

export interface StackingGateResult {
  allow: boolean;
  depth: number;
  rejects: string[];
}

const ACCEPTABLE_UNCERTAINTY = new Set(["LOW", "NONE", "CALIBRATED"]);

export function campaignControlCap(campaignId: string): StackingControlCap {
  const byte = createHash("sha256").update(campaignId).digest()[0];
  return STACKING_CONTROL_CAPS[byte % STACKING_CONTROL_CAPS.length];
}

export function evaluateStackingInsertion(input: StackingGateInput): StackingGateResult {
  const sorted = [...input.openEntries].sort((a, b) => a.entryTime - b.entryTime);
  const depth = sorted.length + 1;
  const rejects: string[] = [];

  if (depth > input.campaignCap) {
    rejects.push(`CONTROL_CAP_REJECT: depth ${depth} exceeds campaign cap ${input.campaignCap}`);
  }
  if (!input.portfolioCapacityAvailable) {
    rejects.push("PORTFOLIO_CAPACITY_REJECT");
  }
  if (input.campaignDrawdownPct > input.maxCampaignDrawdownPct) {
    rejects.push(
      `CAMPAIGN_DRAWDOWN_REJECT: ${input.campaignDrawdownPct.toFixed(2)}% > ${input.maxCampaignDrawdownPct.toFixed(2)}%`,
    );
  }

  if (depth > 1) {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first.positionSide !== input.proposedSide) {
      rejects.push(`DIRECTION_REJECT: campaign ${first.positionSide} vs proposed ${input.proposedSide}`);
    }
    if (input.edgeScore + 1e-9 < (last.edgeScore ?? 0)) {
      rejects.push(
        `EDGE_DECAY_REJECT: ${input.edgeScore.toFixed(4)} < prior ${(last.edgeScore ?? 0).toFixed(4)}`,
      );
    }
    if (input.calibratedProbability === null || input.calibratedProbability < 0.55) {
      rejects.push("CALIBRATION_REJECT: stacking requires calibrated probability >= 0.55");
    }
    if (
      input.uncertaintyType
      && !ACCEPTABLE_UNCERTAINTY.has(input.uncertaintyType.toUpperCase())
    ) {
      rejects.push(`UNCERTAINTY_REJECT: ${input.uncertaintyType}`);
    }
    if (input.now - last.entryTime < input.cooldownMs) {
      rejects.push(`COOLDOWN_REJECT: ${input.now - last.entryTime}ms < ${input.cooldownMs}ms`);
    }
    if (input.marketEventId && last.marketEventId === input.marketEventId) {
      rejects.push(`DUPLICATE_EVENT_REJECT: ${input.marketEventId}`);
    }
    if (!input.marketEventId && last.stateFingerprint === input.stateFingerprint) {
      rejects.push("DUPLICATE_STATE_REJECT");
    }
    if (input.proposedMargin > last.marginUsed + 1e-9) {
      rejects.push(
        `MARTINGALE_REJECT: margin ${input.proposedMargin.toFixed(4)} > prior ${last.marginUsed.toFixed(4)}`,
      );
    }
  }

  return { allow: rejects.length === 0, depth, rejects };
}

function maxDrawdown(values: number[]): number {
  let running = 0;
  let peak = 0;
  let max = 0;
  for (const value of values) {
    running += value;
    peak = Math.max(peak, running);
    max = Math.max(max, peak - running);
  }
  return max;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function lowerConfidence95(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return avg - 1.96 * Math.sqrt(variance / values.length);
}

export interface StackingDepthAuditRow {
  depth: number;
  trainSamples: number;
  testSamples: number;
  incrementalPnl: number;
  marginalExpectancy: number;
  expectancyLower95: number | null;
  additionalDrawdown: number;
  meanEdgeAtInsertion: number;
  campaignContribution: number;
  meanMfe: number;
  meanMae: number;
  correlationAdjustedExposure: number;
  outOfSampleAddsValue: boolean | null;
  verdict: "ADDS_VALUE" | "DESTROYS_VALUE" | "INSUFFICIENT_OOS";
}

export interface StackingAuditReport {
  splitTimestamp: number | null;
  trainCampaigns: number;
  testCampaigns: number;
  controls: Array<{
    maxEntries: StackingControlCap;
    campaigns: number;
    pnl: number;
    expectancy: number;
    maxDrawdown: number;
  }>;
  depths: StackingDepthAuditRow[];
}

export function buildStackingAudit(trades: DemoClosedTrade[]): StackingAuditReport {
  const campaigns = new Map<string, DemoClosedTrade[]>();
  for (const trade of trades) {
    const group = campaigns.get(trade.campaignId) ?? [];
    group.push(trade);
    campaigns.set(trade.campaignId, group);
  }
  const ordered = Array.from(campaigns.values())
    .map((group) => [...group].sort((a, b) => a.entryTime - b.entryTime))
    .sort((a, b) => Math.max(...a.map((t) => t.exitTime)) - Math.max(...b.map((t) => t.exitTime)));
  const splitIndex = Math.floor(ordered.length * 0.7);
  const train = ordered.slice(0, splitIndex);
  const test = ordered.slice(splitIndex);

  const controls = STACKING_CONTROL_CAPS.map((maxEntries) => {
    const pnlByCampaign = test.map((group) =>
      group.slice(0, maxEntries).reduce((sum, trade) => sum + trade.realizedPnl, 0),
    );
    return {
      maxEntries,
      campaigns: test.length,
      pnl: pnlByCampaign.reduce((sum, pnl) => sum + pnl, 0),
      expectancy: mean(pnlByCampaign),
      maxDrawdown: maxDrawdown(pnlByCampaign),
    };
  });

  const depths: StackingDepthAuditRow[] = [];
  for (let depth = 1; depth <= 10; depth++) {
    const trainTrades = train.flatMap((group) => group[depth - 1] ? [group[depth - 1]] : []);
    const testTrades = test.flatMap((group) => group[depth - 1] ? [group[depth - 1]] : []);
    const pnl = testTrades.map((trade) => trade.realizedPnl);
    const priorCampaignPnl = test.map((group) =>
      group.slice(0, depth - 1).reduce((sum, trade) => sum + trade.realizedPnl, 0),
    );
    const withDepthCampaignPnl = test.map((group) =>
      group.slice(0, depth).reduce((sum, trade) => sum + trade.realizedPnl, 0),
    );
    const incrementalPnl = pnl.reduce((sum, value) => sum + value, 0);
    const totalCampaignPnl = withDepthCampaignPnl.reduce((sum, value) => sum + value, 0);
    const enoughOos = testTrades.length >= 20;
    const expectancyLower95 = lowerConfidence95(pnl);
    const addsValue = enoughOos && expectancyLower95 !== null ? expectancyLower95 > 0 : null;

    depths.push({
      depth,
      trainSamples: trainTrades.length,
      testSamples: testTrades.length,
      incrementalPnl,
      marginalExpectancy: mean(pnl),
      expectancyLower95,
      additionalDrawdown: Math.max(0, maxDrawdown(withDepthCampaignPnl) - maxDrawdown(priorCampaignPnl)),
      meanEdgeAtInsertion: mean(testTrades.map((trade) => trade.edgeAtInsertion ?? trade.edgeScore ?? 0)),
      campaignContribution: totalCampaignPnl !== 0 ? incrementalPnl / Math.abs(totalCampaignPnl) : 0,
      meanMfe: mean(testTrades.map((trade) => trade.mfe)),
      meanMae: mean(testTrades.map((trade) => trade.mae)),
      correlationAdjustedExposure: testTrades.reduce(
        (sum, trade) => sum + (trade.correlationAdjustedExposure ?? trade.notional),
        0,
      ),
      outOfSampleAddsValue: addsValue,
      verdict: addsValue === null ? "INSUFFICIENT_OOS" : addsValue ? "ADDS_VALUE" : "DESTROYS_VALUE",
    });
  }

  return {
    splitTimestamp: test[0]?.[0]?.entryTime ?? null,
    trainCampaigns: train.length,
    testCampaigns: test.length,
    controls,
    depths,
  };
}
