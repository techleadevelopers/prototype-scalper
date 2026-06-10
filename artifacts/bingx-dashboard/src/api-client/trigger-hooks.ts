import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TriggerSymbolState {
  symbol: string;
  referencePrice: number;
  currentPrice: number | null;
  dropPct: number;
  risePct: number;
  longArmed: boolean;
  shortArmed: boolean;
  longTriggerPrice: number;
  shortTriggerPrice: number;
  longTpPct: number;
  shortTpPct: number;
  longFiredAt: number | null;
  shortFiredAt: number | null;
  secondsSinceSnapshot: number;
}

export interface TriggerStatus {
  enabled: boolean;
  symbolCount: number;
  longDropPct: number;
  shortRisePct: number;
  slPct: number;
  armedLong: number;
  armedShort: number;
  symbols: TriggerSymbolState[];
}

export interface TriggerEnableBody {
  longDropPct?: number;
  shortRisePct?: number;
  slPct?: number;
  cooldownMs?: number;
  autoResetAfterFireMs?: number;
  symbols?: string[];
}

export interface TriggerEnableResult {
  enabled: boolean;
  config: {
    longDropPct: number;
    shortRisePct: number;
    slPct: number;
    cooldownMs: number;
    symbols: string[];
  };
  snapshotted: number;
  summary: TriggerStatus;
}

export interface TriggerSnapshotResult {
  snapshotted: number;
  summary: TriggerStatus;
}

// ── API functions ─────────────────────────────────────────────────────────────

export const getTriggerStatusUrl = () => `/api/demo/trigger/status`;

export const getTriggerStatus = (): Promise<TriggerStatus> =>
  customFetch<TriggerStatus>(getTriggerStatusUrl(), { method: "GET" });

export const enableTrigger = (body: TriggerEnableBody): Promise<TriggerEnableResult> =>
  customFetch<TriggerEnableResult>("/api/demo/trigger/enable", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const disableTrigger = (): Promise<{ enabled: false; summary: TriggerStatus }> =>
  customFetch("/api/demo/trigger/disable", {
    method: "POST",
    body: JSON.stringify({}),
  });

export const snapshotTrigger = (): Promise<TriggerSnapshotResult> =>
  customFetch<TriggerSnapshotResult>("/api/demo/trigger/snapshot", {
    method: "POST",
    body: JSON.stringify({}),
  });

export const resetTriggerSymbol = (symbol?: string): Promise<{ reset: string; summary: TriggerStatus }> =>
  customFetch(`/api/demo/trigger/reset/${symbol ?? ""}`, {
    method: "POST",
    body: JSON.stringify({}),
  });

// ── React Query hooks ─────────────────────────────────────────────────────────

export const getTriggerStatusQueryKey = () => ["/api/demo/trigger/status"] as const;

export function useGetTriggerStatus<TData = TriggerStatus, TError = unknown>(
  options?: { query?: UseQueryOptions<TriggerStatus, TError, TData> },
) {
  const qk = options?.query?.queryKey ?? getTriggerStatusQueryKey();
  return useQuery<TriggerStatus, TError, TData>({
    queryKey: qk,
    queryFn: () => getTriggerStatus(),
    ...options?.query,
  });
}

export function useEnableTrigger<TError = unknown>(
  options?: UseMutationOptions<TriggerEnableResult, TError, TriggerEnableBody>,
) {
  return useMutation<TriggerEnableResult, TError, TriggerEnableBody>({
    mutationFn: (body) => enableTrigger(body),
    ...options,
  });
}

export function useDisableTrigger<TError = unknown>(
  options?: UseMutationOptions<{ enabled: false; summary: TriggerStatus }, TError, void>,
) {
  return useMutation<{ enabled: false; summary: TriggerStatus }, TError, void>({
    mutationFn: () => disableTrigger(),
    ...options,
  });
}

export function useSnapshotTrigger<TError = unknown>(
  options?: UseMutationOptions<TriggerSnapshotResult, TError, void>,
) {
  return useMutation<TriggerSnapshotResult, TError, void>({
    mutationFn: () => snapshotTrigger(),
    ...options,
  });
}

export function useResetTriggerSymbol<TError = unknown>(
  options?: UseMutationOptions<{ reset: string; summary: TriggerStatus }, TError, string | undefined>,
) {
  return useMutation<{ reset: string; summary: TriggerStatus }, TError, string | undefined>({
    mutationFn: (symbol) => resetTriggerSymbol(symbol),
    ...options,
  });
}

// ── Native Trigger Engine types ────────────────────────────────────────────────

export interface NativeGridLevel {
  level: number;
  side: string;
  triggerPrice: number;
  targetPrice: number;
  stopPrice: number;
  allocationFactor: number;
  distancePct: number;
}

export interface NativePendingOrder {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  triggerPrice: number;
  orderId: string;
  armedAt: number;
  expiresAt: number;
  sectorCluster?: string;
  signalId?: string;
  ttlRemainingMs: number;
}

export interface NativeTriggerSymbol {
  symbol: string;
  currentPrice: number;
  recentMovePct: number;
  atrPct: number;
  longCooldownMs: number;
  shortCooldownMs: number;
  wouldFireLong: boolean;
  wouldFireShort: boolean;
  longGrid: NativeGridLevel[];
  shortGrid: NativeGridLevel[];
}

export interface NativeTriggerStatus {
  generatedAt: number;
  config: {
    enabled: boolean;
    longDetectPct: number;
    shortDetectPct: number;
    baseTpPct: number;
    expirationSeconds: number;
    cooldownMs: number;
    brutalMode: boolean;
    levelsPerSide: number;
    totalLevels: number;
  };
  muxLock: {
    locked: boolean;
    reason: string;
    remainingMs: number;
  };
  pendingOrders: NativePendingOrder[];
  pendingLong: number;
  pendingShort: number;
  symbols: NativeTriggerSymbol[];
}

export const getNativeTriggerStatusQueryKey = () => ["/api/bot/native-trigger/status"] as const;

export const getNativeTriggerStatus = (): Promise<NativeTriggerStatus> =>
  customFetch<NativeTriggerStatus>("/api/bot/native-trigger/status", { method: "GET" });

export function useNativeTriggerStatus(): UseQueryResult<NativeTriggerStatus, unknown> {
  return useQuery<NativeTriggerStatus>({
    queryKey: getNativeTriggerStatusQueryKey(),
    queryFn: getNativeTriggerStatus,
    refetchInterval: 5000,
  });
}
