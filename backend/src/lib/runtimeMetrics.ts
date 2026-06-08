import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

const requestLatencies: number[] = [];
const predictionAges: number[] = [];
const MAX_SAMPLES = 2_048;
const startedAt = Date.now();
const startedCpu = process.cpuUsage();

function remember(values: number[], value: number): void {
  values.push(value);
  if (values.length > MAX_SAMPLES) values.splice(0, values.length - MAX_SAMPLES);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile));
  return Number(ordered[index].toFixed(2));
}

function distribution(values: number[]) {
  return {
    samples: values.length,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length > 0 ? Number(Math.max(...values).toFixed(2)) : 0,
  };
}

export function beginRequestMeasurement(): () => void {
  const started = performance.now();
  return () => remember(requestLatencies, performance.now() - started);
}

export function recordPredictionExecutionAge(predictionTimestampSeconds?: number): void {
  if (!predictionTimestampSeconds) return;
  remember(predictionAges, Math.max(0, Date.now() - predictionTimestampSeconds * 1_000));
}

export function getRuntimeMetrics() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage(startedCpu);
  const uptimeSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
  const cpuSeconds = (cpu.user + cpu.system) / 1_000_000;
  return {
    uptimeSeconds: Number(uptimeSeconds.toFixed(3)),
    cpu: {
      userMicros: cpu.user,
      systemMicros: cpu.system,
      averagePercent: Number(((cpuSeconds / uptimeSeconds) * 100).toFixed(2)),
    },
    memory,
    requestLatencyMs: distribution(requestLatencies),
    predictionAgeAtExecutionMs: distribution(predictionAges),
    eventLoopDelayMs: {
      p50: Number((eventLoop.percentile(50) / 1_000_000).toFixed(2)),
      p95: Number((eventLoop.percentile(95) / 1_000_000).toFixed(2)),
      p99: Number((eventLoop.percentile(99) / 1_000_000).toFixed(2)),
      max: Number((eventLoop.max / 1_000_000).toFixed(2)),
    },
  };
}
