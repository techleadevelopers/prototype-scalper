import { apiUrl } from "@/lib/api-url";

export interface DemoPosition {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unrealizedProfit: string;
  leverage: string;
  marginType: string;
  initialMargin: string;
  source?: string;
}

export async function fetchTelemetryState(source: "demo" | "live" | "all" = "all"): Promise<unknown> {
  const response = await fetch(apiUrl(`/api/telemetry/state?source=${encodeURIComponent(source)}`), {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Telemetry state HTTP ${response.status}`);
  return response.json();
}

export async function fetchTelemetryExport(): Promise<unknown> {
  const response = await fetch(apiUrl("/api/telemetry/export"), {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Telemetry export HTTP ${response.status}`);
  return response.json();
}

export async function fetchDemoAnalysisState(): Promise<unknown> {
  const response = await fetch(apiUrl("/api/demo/analysis-state"), {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Demo analysis state HTTP ${response.status}`);
  return response.json();
}

export async function fetchDemoPositions(): Promise<DemoPosition[]> {
  const response = await fetch(apiUrl("/api/demo/positions"), {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Demo positions HTTP ${response.status}`);
  return response.json() as Promise<DemoPosition[]>;
}

export function sumDemoUnrealizedPnl(positions: DemoPosition[]): number {
  return positions.reduce((sum, position) => {
    const pnl = Number(position.unrealizedProfit);
    return sum + (Number.isFinite(pnl) ? pnl : 0);
  }, 0);
}
