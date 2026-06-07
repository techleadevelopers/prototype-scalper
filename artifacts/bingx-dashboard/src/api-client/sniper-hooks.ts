import { useMutation, useQuery } from "@tanstack/react-query";
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutopilotCycleSummary {
  cycle: number;
  startedAt: number;
  durationMs: number;
  candidates: number;
  attempted: number;
  placed: number;
  rejected: number;
  btcChangePct: number;
}

export interface AutopilotStatus {
  running: boolean;
  startedAt: number | null;
  uptimeMs: number | null;
  totalCycles: number;
  totalPlaced: number;
  sessionLossUsd: number;
  stopReason: string | null;
  lastCycle: AutopilotCycleSummary | null;
  recentHistory: AutopilotCycleSummary[];
  config: {
    intervalSec: number;
    maxCandidatesPerCycle: number;
    minCombinedScore: number;
    positionStackingEnabled: boolean;
    maxPositionsPerSymbol: number;
  };
}

export interface AutopilotStartResult {
  started: boolean;
  reason?: string;
  intervalMs?: number;
  sniperMinCombinedScore?: number;
  sniperMaxCandidatesPerCycle?: number;
  positionStackingEnabled?: boolean;
  maxPositionsPerSymbol?: number;
}

export interface AutopilotStopResult {
  stopped: boolean;
  reason?: string;
  totalCycles?: number;
  totalPlaced?: number;
}

export interface MassCandidate {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  combinedScore?: number;
  currentEv?: number;
  btcChangePct?: number;
}

export interface MassExecutionResult {
  total: number;
  filtered: number;
  attempted: number;
  placed: number;
  rejected: number;
  skippedNoHeadroom: number;
  skippedBelowScore: number;
  durationMs: number;
  capitalSnapshot: { openPositions: number; marginUtilization: number; equity: number } | null;
  results: Array<{
    index: number;
    symbol: string;
    side: string;
    placed: boolean;
    orderId: string | null;
    quantity: number | null;
    gateRejects: string[];
    observationMode: boolean;
    message: string;
    durationMs: number;
  }>;
}

// ── API functions ─────────────────────────────────────────────────────────────

export const getSniperAutopilotStatusUrl = () => `/api/bot/sniper/autopilot/status`;

export const getSniperAutopilotStatus = (): Promise<AutopilotStatus> =>
  customFetch<AutopilotStatus>(getSniperAutopilotStatusUrl(), { method: "GET" });

export const startSniperAutopilot = (): Promise<AutopilotStartResult> =>
  customFetch<AutopilotStartResult>("/api/bot/sniper/autopilot/start", {
    method: "POST",
    body: JSON.stringify({}),
  });

export const stopSniperAutopilot = (): Promise<AutopilotStopResult> =>
  customFetch<AutopilotStopResult>("/api/bot/sniper/autopilot/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });

export const executeSniperMass = (body: { candidates: MassCandidate[]; ordersPerSecond?: number }): Promise<MassExecutionResult> =>
  customFetch<MassExecutionResult>("/api/bot/sniper/mass", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ── React Query hooks ─────────────────────────────────────────────────────────

export const getSniperAutopilotStatusQueryKey = () => ["/api/bot/sniper/autopilot/status"] as const;

export function useGetSniperAutopilotStatus<TData = AutopilotStatus, TError = unknown>(
  options?: { query?: UseQueryOptions<AutopilotStatus, TError, TData> },
) {
  const qk = options?.query?.queryKey ?? getSniperAutopilotStatusQueryKey();
  return useQuery<AutopilotStatus, TError, TData>({
    queryKey: qk,
    queryFn: () => getSniperAutopilotStatus(),
    ...options?.query,
  });
}

export function useStartSniperAutopilot<TError = unknown>(
  options?: UseMutationOptions<AutopilotStartResult, TError, void>,
) {
  return useMutation<AutopilotStartResult, TError, void>({
    mutationFn: () => startSniperAutopilot(),
    ...options,
  });
}

export function useStopSniperAutopilot<TError = unknown>(
  options?: UseMutationOptions<AutopilotStopResult, TError, void>,
) {
  return useMutation<AutopilotStopResult, TError, void>({
    mutationFn: () => stopSniperAutopilot(),
    ...options,
  });
}

export function useExecuteSniperMass<TError = unknown>(
  options?: UseMutationOptions<MassExecutionResult, TError, { candidates: MassCandidate[]; ordersPerSecond?: number }>,
) {
  return useMutation<MassExecutionResult, TError, { candidates: MassCandidate[]; ordersPerSecond?: number }>({
    mutationFn: (body) => executeSniperMass(body),
    ...options,
  });
}
