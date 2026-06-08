import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import pino from "pino";
import { sanitizeForOutput } from "./executionSecurity";

interface RequestContext {
  requestId: string;
}

export const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function getCurrentRequestId(): string | null {
  return asyncLocalStorage.getStore()?.requestId ?? null;
}

export function runWithRequestId<T>(
  requestId: string | undefined,
  fn: () => T,
): T {
  return asyncLocalStorage.run(
    { requestId: requestId || randomUUID().slice(0, 8) },
    fn,
  );
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-api-key",
      "req.headers.x-quant-brain-token",
      "password",
      "secret",
      "token",
      "apiKey",
      "secretKey",
      "*.apiKey",
      "*.secretKey",
      "*.token",
      "*.authorization",
      "**.apiKey",
      "**.secretKey",
      "**.token",
      "**.authorization",
      "**.signature",
    ],
    censor: "[REDACTED]",
  },
  serializers: {
    err: (err) => sanitizeForOutput(err),
  },
  mixin() {
    const requestId = getCurrentRequestId();
    return requestId ? { requestId } : {};
  },
});

export interface MetricData {
  name: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
}

export function logMetric(metric: MetricData): void {
  logger.info({ event: "metric", ...metric }, metric.name);
}

export interface AlertData {
  severity: "low" | "medium" | "high" | "critical";
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export function logAlert(alert: AlertData): void {
  const payload = { event: "alert", ...alert };
  if (alert.severity === "critical") logger.fatal(payload, alert.message);
  else if (alert.severity === "high") logger.error(payload, alert.message);
  else logger.warn(payload, alert.message);
}

export function measureTime<T>(name: string, fn: () => T): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    logMetric({ name: `duration.${name}`, value: performance.now() - startedAt, unit: "ms" });
  }
}

export async function measureTimeAsync<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    logMetric({ name: `duration.${name}`, value: performance.now() - startedAt, unit: "ms" });
  }
}

export default logger;
