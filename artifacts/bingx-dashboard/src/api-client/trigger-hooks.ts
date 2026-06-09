import { useMutation, useQuery } from "@tanstack/react-query";
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
