import { useEffect, useMemo, useState } from "react";
import { PieChart, Pie, Cell } from "recharts";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  Gauge,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Target,
  TrendingDown,
  TrendingUp,
  Wifi,
  WifiOff,
  XCircle,
  Pause,
  Clock,
  Zap,
  BarChart2,
  Crosshair,
  Layers,
  ChevronDown,
  ChevronUp,
  Sparkles,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";
import {
  getGetBingXTickerQueryKey,
  useGetBingXTicker,
} from "@/api-client";
import AppShell from "@/components/app-shell";
import { apiUrl } from "@/lib/api-url";
import { fetchDemoAnalysisState } from "@/lib/demo-live";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Side = "LONG" | "SHORT";
type AnyRecord = Record<string, any>;

interface SentimentIndicators {
  vwapDeviation: number;
  volumeDelta: number;
  momentum4h: number;
  momentum24h: number;
  ema12vs24: string;
  rangePosition: number;
  bodyBias: number;
  volumeTrend: string;
  highLowBreak: string;
}

interface SentimentResult {
  symbol: string;
  direction: "BULL" | "BEAR" | "NEUTRAL";
  confidence: number;
  biasRatio: number;
  dominantSide: "LONG" | "SHORT" | "NEUTRAL";
  entryBias: { longWeight: number; shortWeight: number };
  indicators: SentimentIndicators;
  candles24h: number;
  fetchedAt: number;
  error?: string;
}

async function fetchSentiment(symbol: string): Promise<SentimentResult> {
  const res = await fetch(apiUrl(`/api/bot/sentiment?symbol=${encodeURIComponent(symbol)}`), {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Sentiment HTTP ${res.status}`);
  return await res.json() as SentimentResult;
}

function SentimentPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["sentiment", symbol],
    queryFn: () => fetchSentiment(symbol),
    refetchInterval: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
    retry: 1,
  });

  if (isLoading && !data) {
    return <Skeleton className="h-[72px] w-full rounded-xl" />;
  }
  if (!data) return null;

  const { direction, confidence, entryBias, indicators, fetchedAt, candles24h } = data;
  const dirColor = direction === "BULL" ? "text-green-400" : direction === "BEAR" ? "text-red-400" : "text-amber-400";
  const dirBorder = direction === "BULL" ? "border-green-500/25 bg-green-500/5" : direction === "BEAR" ? "border-red-500/25 bg-red-500/5" : "border-amber-500/25 bg-amber-500/5";
  const longPct = Math.round(entryBias.longWeight * 100);
  const shortPct = 100 - longPct;

  // CORRIGIDO: usar valores em INGLÊS do backend para breakout
  const breakoutLabel =
    indicators.highLowBreak === "BREAKOUT_UP" ? "↑ Rompimento" :
    indicators.highLowBreak === "BREAKOUT_DOWN" ? "↓ Quebra baixo" : "Faixa/Range";
  const breakoutColor =
    indicators.highLowBreak === "BREAKOUT_UP" ? "text-green-400" :
    indicators.highLowBreak === "BREAKOUT_DOWN" ? "text-red-400" : "text-muted-foreground";

  const metrics: { label: string; tooltip: string; value: number; unit: string }[] = [
    { label: "VWAP", tooltip: "Desvio do preço médio ponderado por volume", value: indicators.vwapDeviation, unit: "%" },
    { label: "Δ Volume", tooltip: "Variação do volume nas últimas 24h", value: indicators.volumeDelta * 100, unit: "%" },
    { label: "Mom. 4h", tooltip: "Momentum de preço nas últimas 4 horas", value: indicators.momentum4h, unit: "%" },
    { label: "Mom. 24h", tooltip: "Momentum de preço nas últimas 24 horas", value: indicators.momentum24h, unit: "%" },
    { label: "Corpo vela", tooltip: "Viés do corpo das velas", value: indicators.bodyBias * 100, unit: "%" },
  ];

  const emaColor = indicators.ema12vs24 === "BULL" ? "text-green-400" : indicators.ema12vs24 === "BEAR" ? "text-red-400" : "text-amber-400";
  const volColor = indicators.volumeTrend === "RISING" ? "text-green-400" : indicators.volumeTrend === "FALLING" ? "text-red-400" : "text-muted-foreground";
  
  // CORRIGIDO: rangePosNum para número, rangePos para string com %
  const rangePosNum = indicators.rangePosition * 100;
  const rangePos = `${Math.round(rangePosNum)}%`;
  const rangePosColor = indicators.rangePosition > 0.7 ? "text-green-400" : indicators.rangePosition < 0.3 ? "text-red-400" : "text-amber-400";
  
  const dirBgColor = direction === "BULL" ? "bg-green-500/15" : direction === "BEAR" ? "bg-red-500/15" : "bg-muted/30";
  const dirConfidenceColor = direction === "BULL" ? "bg-green-500" : direction === "BEAR" ? "bg-red-500" : "bg-muted-foreground";
  
  // CORRIGIDO: usar indicators.highLowBreak (inglês) para cor de fundo
  const breakoutBgColor = indicators.highLowBreak === "BREAKOUT_UP" ? "bg-green-500/15" : indicators.highLowBreak === "BREAKOUT_DOWN" ? "bg-red-500/15" : "bg-muted/20";
  const emaBgColor = indicators.ema12vs24 === "BULL" ? "bg-green-500/15" : indicators.ema12vs24 === "BEAR" ? "bg-red-500/15" : "bg-muted/20";
  const volBgColor = indicators.volumeTrend === "RISING" ? "bg-green-500/15" : indicators.volumeTrend === "FALLING" ? "bg-red-500/15" : "bg-muted/20";

  return (
    <section className={`rounded-xl border shadow-md shadow-black/20 overflow-hidden transition-all hover:shadow-lg ${dirBorder}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/15 bg-muted/5">
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded-md ${dirBgColor}`}>
            <TrendingUp className={`h-3.5 w-3.5 ${dirColor}`} />
          </div>
          <span className="text-[11px] font-bold text-foreground/80 uppercase tracking-wider">Sentimento 24h</span>
          <Badge variant="outline" className={`px-2 py-0.5 text-[10px] font-mono font-bold border-0 ${dirBgColor} ${dirColor}`}>
            {direction}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground">Confiança</span>
            <div className="w-16 h-1.5 bg-muted/30 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${dirConfidenceColor}`} style={{ width: `${confidence * 100}%` }} />
            </div>
            <span className="text-[10px] font-mono font-bold text-foreground/70">{(confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="flex items-center gap-1 text-[9px] text-muted-foreground/50">
            <Clock className="h-2.5 w-2.5" />
            <span>{new Date(fetchedAt).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>

      {/* Grid 2 colunas */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/15">
        
        {/* Coluna esquerda - Viés */}
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">VIÉS DE ENTRADA</span>
            <span className="text-[8px] text-muted-foreground/50 font-mono">proporção long vs short</span>
          </div>

          {/* Donut chart + barra lado a lado */}
          <div className="flex items-center gap-3">
            {/* Donut chart animado */}
            <div className="relative flex-shrink-0" style={{ width: 56, height: 56 }}>
              <PieChart width={56} height={56}>
                <Pie
                  data={[
                    { name: "LONG", value: longPct },
                    { name: "SHORT", value: shortPct },
                  ]}
                  cx={27}
                  cy={27}
                  innerRadius={18}
                  outerRadius={26}
                  startAngle={90}
                  endAngle={-270}
                  paddingAngle={longPct > 0 && shortPct > 0 ? 2 : 0}
                  dataKey="value"
                  isAnimationActive={true}
                  animationBegin={0}
                  animationDuration={900}
                  animationEasing="ease-out"
                  stroke="none"
                >
                  <Cell fill={longPct >= shortPct ? "#16a34a" : "#22c55e"} opacity={0.85} />
                  <Cell fill={shortPct > longPct ? "#dc2626" : "#ef4444"} opacity={0.75} />
                </Pie>
              </PieChart>
              {/* Porcentagem dominante no centro */}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className={`text-[10px] font-bold leading-none tabular-nums ${longPct >= shortPct ? "text-green-400" : "text-red-400"}`}>
                  {longPct >= shortPct ? longPct : shortPct}%
                </span>
                <span className={`text-[7px] font-semibold leading-none mt-0.5 ${longPct >= shortPct ? "text-green-500/70" : "text-red-500/70"}`}>
                  {longPct >= shortPct ? "L" : "S"}
                </span>
              </div>
            </div>

            {/* Barra + breakout */}
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="relative h-8 w-full overflow-hidden rounded-md border border-border/30 bg-muted/10">
                <div
                  className="absolute inset-y-0 left-0 flex items-center justify-end pr-2 bg-gradient-to-r from-green-600/80 to-green-500/60 text-[10px] font-bold text-white shadow-sm transition-all duration-500"
                  style={{ width: `${longPct}%` }}
                >
                  {longPct >= 28 && <span>{longPct}% LONG</span>}
                </div>
                <div
                  className="absolute inset-y-0 right-0 flex items-center justify-start pl-2 bg-gradient-to-l from-red-600/80 to-red-500/60 text-[10px] font-bold text-white shadow-sm transition-all duration-500"
                  style={{ width: `${shortPct}%` }}
                >
                  {shortPct >= 28 && <span>{shortPct}% SHORT</span>}
                </div>
                {longPct < 28 && shortPct < 28 && (
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                    {longPct}% L · {shortPct}% S
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <span className="text-[8px] text-muted-foreground/60">Long</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    <span className="text-[8px] text-muted-foreground/60">Short</span>
                  </div>
                </div>
                <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${breakoutBgColor}`}>
                  <Zap className={`h-2.5 w-2.5 ${breakoutColor}`} />
                  <span className={`text-[9px] font-mono font-bold ${breakoutColor}`}>{breakoutLabel}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Coluna direita - Métricas */}
        <div className="p-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {metrics.map((m) => (
              <div key={m.label} className="flex items-center justify-between group" title={m.tooltip}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${m.value >= 0 ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-[9px] text-muted-foreground font-medium whitespace-nowrap">{m.label}</span>
                </div>
                <span className={`font-mono text-[10px] font-bold tabular-nums ${m.value >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {m.value >= 0 ? "+" : ""}{m.value.toFixed(2)}{m.unit}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-border/15 bg-muted/8">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[9px] text-muted-foreground">EMA</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ${emaColor} ${emaBgColor}`}>
              {indicators.ema12vs24}
            </span>
          </div>
          <div className="w-px h-3 bg-border/30" />
          <div className="flex items-center gap-1.5">
            <Target className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[9px] text-muted-foreground">Pos. faixa</span>
            <div className="w-12 h-1 bg-muted/30 rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all ${rangePosNum >= 70 ? 'bg-green-500' : rangePosNum <= 30 ? 'bg-red-500' : 'bg-yellow-500'}`}
                style={{ width: `${Math.min(100, Math.max(0, rangePosNum))}%` }}
              />
            </div>
            <span className={`text-[9px] font-mono font-bold ${rangePosColor}`}>{rangePos}</span>
          </div>
          <div className="w-px h-3 bg-border/30" />
          <div className="flex items-center gap-1.5">
            <BarChart2 className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[9px] text-muted-foreground">Volume</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ${volColor} ${volBgColor}`}>
              {indicators.volumeTrend}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className={`w-1.5 h-1.5 rounded-full ${candles24h >= 24 ? 'bg-green-500' : 'bg-yellow-500'}`} />
          <span className="text-[8px] text-muted-foreground/50 font-mono">{candles24h}/24 candles</span>
        </div>
      </div>
    </section>
  );
}

interface IntelligenceResponse {
  symbol: string;
  positionSide: Side;
  btcRegime: string;
  hourUtc: number;
  symbols: string[];
  executionEnabled: boolean;
  telemetrySource?: "all" | "demo" | "live";
  telemetry: {
    samples: number;
    priorityScore: number;
    toxicityScore: number;
    ev: number;
    winRate: number;
    profitFactor: number;
    netPnl: number;
    isToxic: boolean;
  };
  quantBrain: {
    connected: boolean;
    enabled: boolean;
    gateMode: "off" | "shadow" | "enforce";
    checkedAt: number;
    edge: AnyRecord;
    health: AnyRecord | null;
    model: AnyRecord | null;
    signalEdge: AnyRecord | null;
    newsContext: AnyRecord | null;
    errors: Record<string, string>;
  };
}

interface DemoAnalysisState {
  connected?: boolean;
  openUnrealizedPnl?: number;
  positions?: unknown[];
}

async function fetchIntelligence(symbol: string, side: Side, btcChangePct: number, source: "all" | "demo" | "live") {
  const params = new URLSearchParams({ symbol, side, btcChangePct: String(btcChangePct), source });
  const response = await fetch(apiUrl(`/api/bot/intelligence?${params}`), { credentials: "include" });
  if (!response.ok) throw new Error(`Intelligence HTTP ${response.status}`);
  return await response.json() as IntelligenceResponse;
}

function pct(value: unknown, digits = 2) {
  const number = Number(value ?? 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function num(value: unknown, digits = 3) {
  return Number(value ?? 0).toFixed(digits);
}

interface ServiceStateSnapshot {
  state: "HEALTHY" | "DEGRADED" | "SHADOW_ONLY" | "PAUSED";
  reason: string | null;
  since: number;
  qbFailures: number;
  apiErrors: number;
  consecutiveLosses: number;
  rollingLossPnl: number;
  lastBtcPriceAt: number | null;
  staleDataThresholdMs: number;
  history: Array<{ state: string; reason: string | null; at: number }>;
}

function ServiceStatePanel() {
  const { data, isLoading } = useQuery<ServiceStateSnapshot>({
    queryKey: ["service-state"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/service-state"), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ServiceStateSnapshot>;
    },
    refetchInterval: 5_000,
    placeholderData: (prev) => prev,
    retry: 2,
  });

  const stateColors: Record<string, string> = {
    HEALTHY: "text-green-400",
    DEGRADED: "text-amber-400",
    SHADOW_ONLY: "text-orange-400",
    PAUSED: "text-red-400",
  };
  const stateIcon: Record<string, React.ReactNode> = {
    HEALTHY: <ShieldCheck className="h-3.5 w-3.5 text-green-400" />,
    DEGRADED: <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />,
    SHADOW_ONLY: <ShieldOff className="h-3.5 w-3.5 text-orange-400" />,
    PAUSED: <Pause className="h-3.5 w-3.5 text-red-400" />,
  };

  const state = data?.state ?? "HEALTHY";
  const icon = stateIcon[state] ?? stateIcon.HEALTHY;
  const btcAgeMs = data?.lastBtcPriceAt ? Date.now() - data.lastBtcPriceAt : null;
  const btcStale = btcAgeMs !== null && data?.staleDataThresholdMs ? btcAgeMs > data.staleDataThresholdMs : false;

  return (
    <PanelBox icon={<Gauge className="h-3.5 w-3.5 text-primary" />} title="Serviço">
      {!data ? (
        <p className="text-[10px] text-muted-foreground">Carregando...</p>
      ) : (
        <div className="space-y-2">
          <Row label="Estado" value={<span className="font-mono font-bold text-xs flex items-center gap-1">{icon}{state}</span>} />
          {data.reason && <Row label="Motivo" value={<span className="font-mono text-[10px] uppercase">{data.reason}</span>} />}
          <Row label="QB falhas" value={<span className={`font-mono text-xs ${data.qbFailures >= 3 ? "text-amber-400" : ""}`}>{data.qbFailures}</span>} />
          <Row label="Losses" value={<span className={`font-mono text-xs ${data.consecutiveLosses >= 4 ? "text-red-400" : ""}`}>{data.consecutiveLosses}</span>} />
          <Row label="PnL acum." value={<span className={`font-mono text-xs ${data.rollingLossPnl < 0 ? "text-red-400" : "text-green-400"}`}>{data.rollingLossPnl >= 0 ? "+" : ""}${data.rollingLossPnl.toFixed(2)}</span>} />
          {btcStale && <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[9px] text-amber-400">⚠ BTC price stale</div>}
          {(state === "SHADOW_ONLY" || state === "PAUSED") && (
            <div className="rounded border border-red-500/30 bg-red-500/5 px-2 py-1 text-[9px] text-red-400">⛔ Entradas bloqueadas</div>
          )}
        </div>
      )}
    </PanelBox>
  );
}

function StatusBadge({ ok, on, off, tone = ok ? "ok" : "bad" }: { ok: boolean; on: string; off: string; tone?: "ok" | "warn" | "bad" }) {
  const toneClass = tone === "ok"
    ? "border-green-500/40 bg-green-500/10 text-green-400"
    : tone === "warn"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
      : "border-red-500/40 bg-red-500/10 text-red-400";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] ${toneClass}`}
    >
      {tone === "warn"
        ? <Clock className="mr-1 h-2.5 w-2.5" />
        : ok ? <CheckCircle2 className="mr-1 h-2.5 w-2.5" /> : <XCircle className="mr-1 h-2.5 w-2.5" />}
      {tone === "warn" ? off : ok ? on : off}
    </Badge>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "good" | "bad" | "warn";
}) {
  const color = tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-400" : "text-foreground";
  return (
    <div className="rounded-xl border border-border/40 bg-card/50 px-3 py-2.5 shadow shadow-black/20">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 font-mono text-base font-bold leading-tight ${color}`}>{value}</p>
      {detail && <p className="mt-0.5 text-[9px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {typeof value === "string" ? <span className="font-mono text-xs">{value}</span> : value}
    </div>
  );
}

function PanelBox({ icon, title, badge, children }: { icon?: React.ReactNode; title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/40 bg-card/40 shadow-md shadow-black/20 overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-border/30 px-3 py-2.5">
        {icon}
        <h2 className="text-xs font-semibold">{title}</h2>
        {badge && <div className="ml-auto">{badge}</div>}
      </div>
      <div className="p-3 space-y-2">{children}</div>
    </section>
  );
}

function FrameRow({ name, frame }: { name: string; frame: AnyRecord }) {
  const quality = String(frame?.quality ?? "NO_DATA");
  const hasData = quality !== "NO_DATA" && frame && Object.keys(frame).length > 0;
  const healthy = quality === "GOOD";
  const changePct = Number(frame?.changePct ?? 0);

  if (!hasData) {
    return (
      <div className="grid grid-cols-[36px_1fr] items-center gap-2 border-b border-border/20 py-2 last:border-0 opacity-40">
        <span className="font-mono text-[11px] font-bold text-muted-foreground">{name}</span>
        <span className="text-[10px] text-muted-foreground italic">aguardando dados...</span>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[36px_1fr_1fr_70px] items-center gap-2 border-b border-border/20 py-2 last:border-0">
      <span className="font-mono text-[11px] font-bold text-muted-foreground">{name}</span>
      <span className={`font-mono text-[11px] ${changePct >= 0 ? "text-green-400" : "text-red-400"}`}>
        {pct(frame?.changePct)}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">{num(frame?.volumeRatioAvg, 2)}x vol</span>
      <span className={`text-[10px] text-right ${healthy ? "text-green-400" : "text-amber-400"}`}>{quality}</span>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 10000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}
function scoreColor(s: number) {
  if (s >= 0.75) return "text-emerald-400";
  if (s >= 0.60) return "text-amber-400";
  return "text-muted-foreground/70";
}
function scoreBg(s: number) {
  if (s >= 0.75) return "bg-emerald-500/15 border-emerald-500/25";
  if (s >= 0.60) return "bg-amber-500/15 border-amber-500/25";
  return "bg-muted/15 border-border/20";
}

// ─── SniperOpportunityCard ────────────────────────────────────────────────────
function SniperOpportunityCard({ opp }: { opp: {
  symbol: string; side: string; confluence_score: number;
  confidence: number; entry_price: number; signals: string[]; signal_details: Record<string, { score: number; label?: string; vol_ratio?: number }>
}}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = opp.side === "LONG";
  const token = opp.symbol.replace("-USDT", "");

  return (
    <div className={`rounded-xl border overflow-hidden ${scoreBg(opp.confluence_score)}`}>
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-white/3 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${isLong ? "bg-emerald-500/20" : "bg-rose-500/20"}`}>
          {isLong ? <ArrowUpFromLine className="w-3 h-3 text-emerald-400" /> : <ArrowDownToLine className="w-3 h-3 text-rose-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-foreground">{token}</span>
            <span className={`text-[9px] font-bold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>{opp.side}</span>
          </div>
          <div className="text-[9px] text-muted-foreground/60 truncate">
            {opp.signals.slice(0, 3).join(" · ")}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-mono text-sm font-bold ${scoreColor(opp.confluence_score)}`}>
            {(opp.confluence_score * 100).toFixed(0)}
          </div>
          <div className="text-[8px] text-muted-foreground/50">score</div>
        </div>
        <div className="text-right shrink-0 hidden sm:block">
          <div className="font-mono text-xs text-foreground/80">{fmtPrice(opp.entry_price)}</div>
          <div className="text-[8px] text-muted-foreground/50">entrada</div>
        </div>
        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground/40 shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground/40 shrink-0" />}
      </div>

      {expanded && (
        <div className="border-t border-white/5 px-3 py-2.5 space-y-1.5 bg-black/15">
          <div className="grid grid-cols-3 gap-2 text-center mb-2">
            <div>
              <div className="text-[8px] text-muted-foreground/50 uppercase">Confluência</div>
              <div className={`font-mono text-sm font-bold ${scoreColor(opp.confluence_score)}`}>{(opp.confluence_score * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground/50 uppercase">Confiança</div>
              <div className="font-mono text-sm font-bold text-foreground/80">{(opp.confidence * 100).toFixed(0)}%</div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground/50 uppercase">Preço</div>
              <div className="font-mono text-xs font-bold text-foreground/80">{fmtPrice(opp.entry_price)}</div>
            </div>
          </div>
          <div className="text-[9px] text-muted-foreground/50 font-semibold uppercase tracking-wider mb-1">Sinais ativos</div>
          <div className="flex flex-wrap gap-1">
            {opp.signals.map((sig, i) => (
              <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${
                isLong ? "bg-emerald-500/10 text-emerald-400/80" : "bg-rose-500/10 text-rose-400/80"
              }`}>{sig}</span>
            ))}
          </div>
          {Object.entries(opp.signal_details).length > 0 && (
            <div className="pt-1.5 space-y-1">
              {Object.entries(opp.signal_details).map(([key, detail]) => (
                <div key={key} className="flex justify-between text-[9px]">
                  <span className="text-muted-foreground/55 capitalize">{key.replace(/_/g, " ")}</span>
                  <span className={`font-mono ${scoreColor(detail.score)}`}>{(detail.score * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MassEntryZoneCard ────────────────────────────────────────────────────────
function MassEntryZoneCard({ zone }: { zone: {
  symbol: string; side: string; base_price: number; total_confluence: number;
  strategy: string; levels: Array<{ index: number; label: string; price: number; position_weight_pct: number; trigger_deviation_pct: number }>
}}) {
  const isLong = zone.side === "LONG";
  const token = zone.symbol.replace("-USDT", "");

  return (
    <div className={`rounded-xl border overflow-hidden ${isLong ? "border-emerald-500/20 bg-emerald-950/15" : "border-rose-500/20 bg-rose-950/15"}`}>
      <div className="px-3 py-2 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className={`w-3.5 h-3.5 ${isLong ? "text-emerald-400" : "text-rose-400"}`} />
          <span className="font-mono text-xs font-bold text-foreground">{token}</span>
          <span className={`text-[9px] font-bold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>{zone.side}</span>
          <span className="text-[9px] text-muted-foreground/50">{zone.strategy}</span>
        </div>
        <span className={`font-mono text-xs font-bold ${scoreColor(zone.total_confluence)}`}>
          {(zone.total_confluence * 100).toFixed(0)}%
        </span>
      </div>
      <div className="px-3 py-2.5 space-y-2">
        {zone.levels.map((lv) => (
          <div key={lv.index} className="flex items-center gap-2">
            <div className={`w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center shrink-0 ${
              lv.index === 0
                ? isLong ? "bg-emerald-500/30 text-emerald-300" : "bg-rose-500/30 text-rose-300"
                : "bg-muted/20 text-muted-foreground/60"
            }`}>
              {lv.index + 1}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-muted-foreground/60">{lv.label}</span>
                <span className="font-mono text-[10px] text-foreground/80">{fmtPrice(lv.price)}</span>
              </div>
              <div className="h-1 mt-1 bg-black/20 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${isLong ? "bg-emerald-500/60" : "bg-rose-500/60"}`}
                  style={{ width: `${lv.position_weight_pct}%` }}
                />
              </div>
              <div className="text-[8px] text-muted-foreground/40 mt-0.5">
                {lv.position_weight_pct}% do capital · desvio {lv.trigger_deviation_pct}%
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SniperEntrySection ───────────────────────────────────────────────────────
function SniperEntrySection() {
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiMassText, setAiMassText] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"sniper" | "mass">("sniper");

  const oppsQ = useQuery({
    queryKey: ["sniper-entry-opportunities"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/neural/sniper/entry-opportunities"), { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{
        count: number; threshold: number; timestamp: number;
        opportunities: Array<{
          symbol: string; side: string; confluence_score: number;
          confidence: number; entry_price: number; signals: string[];
          signal_details: Record<string, { score: number }>; timestamp: number;
        }>;
        market_context: Record<string, { rsi: number; volume_ratio: number; btc_regime: string }>;
      }>;
    },
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const zonesQ = useQuery({
    queryKey: ["sniper-mass-entry-zones"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/neural/sniper/mass-entry-zones"), { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{
        count: number; timestamp: number;
        zones: Array<{
          symbol: string; side: string; base_price: number;
          total_confluence: number; strategy: string;
          levels: Array<{ index: number; label: string; price: number; position_weight_pct: number; trigger_deviation_pct: number }>;
        }>;
      }>;
    },
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const sniperMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(apiUrl("/api/neural/analyst/sniper"), { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { full_text?: string };
      return d.full_text ?? "Sem resposta";
    },
    onSuccess: (text) => setAiText(text),
  });

  const massMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(apiUrl("/api/neural/analyst/mass-entry"), { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { full_text?: string };
      return d.full_text ?? "Sem resposta";
    },
    onSuccess: (text) => setAiMassText(text),
  });

  const opps  = oppsQ.data?.opportunities ?? [];
  const zones = zonesQ.data?.zones ?? [];

  return (
    <section className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Crosshair className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold text-foreground">Entradas Sniper</h2>
          <span className="text-[10px] text-muted-foreground/50">Confluência multi-sinal · Independente do gatilho</span>
        </div>
        <div className="flex items-center gap-2">
          {oppsQ.isFetching && <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground/40" />}
          <div className="flex rounded-lg border border-border/30 overflow-hidden">
            {(["sniper", "mass"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 text-[10px] font-semibold transition-colors ${
                  activeTab === tab ? "bg-primary/15 text-primary" : "text-muted-foreground/60 hover:bg-muted/20"
                }`}
              >
                {tab === "sniper" ? `Precisão (${opps.length})` : `Massa (${zones.length})`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activeTab === "sniper" && (
        <div className="space-y-3">
          {opps.length === 0 ? (
            <div className="rounded-xl border border-border/15 bg-card/5 flex items-center justify-center py-8 gap-3">
              <Crosshair className="w-5 h-5 text-muted-foreground/20" />
              <div className="text-[12px] text-muted-foreground/40">
                Nenhuma oportunidade sniper ativa — aguardando confluência de sinais
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
              {opps.map((opp, i) => (
                <SniperOpportunityCard key={`${opp.symbol}-${opp.side}-${i}`} opp={opp} />
              ))}
            </div>
          )}

          {/* AI Analysis */}
          <div className="rounded-xl border border-border/15 bg-card/5 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/10">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-primary/70" />
                <span className="text-[10px] font-semibold text-muted-foreground/70">Análise IA Sniper</span>
              </div>
              <button
                type="button"
                onClick={() => sniperMut.mutate()}
                disabled={sniperMut.isPending}
                className="flex items-center gap-1 text-[10px] text-primary/70 hover:text-primary transition-colors disabled:opacity-40"
              >
                <RefreshCw className={`w-3 h-3 ${sniperMut.isPending ? "animate-spin" : ""}`} />
                {sniperMut.isPending ? "Analisando..." : "Analisar agora"}
              </button>
            </div>
            <div className="px-3 py-2.5">
              {aiText ? (
                <pre className="text-[10px] text-foreground/70 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">{aiText}</pre>
              ) : (
                <p className="text-[10px] text-muted-foreground/40 italic">
                  Clique em "Analisar agora" para gerar análise das oportunidades sniper com IA.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "mass" && (
        <div className="space-y-3">
          {zones.length === 0 ? (
            <div className="rounded-xl border border-border/15 bg-card/5 flex items-center justify-center py-8 gap-3">
              <Layers className="w-5 h-5 text-muted-foreground/20" />
              <div className="text-[12px] text-muted-foreground/40">
                Nenhuma zona de entrada em massa (requer score ≥ 60% em pelo menos 1 símbolo)
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
              {zones.map((z, i) => (
                <MassEntryZoneCard key={`${z.symbol}-${z.side}-${i}`} zone={z} />
              ))}
            </div>
          )}

          {/* AI Mass Entry */}
          <div className="rounded-xl border border-border/15 bg-card/5 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/10">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-primary/70" />
                <span className="text-[10px] font-semibold text-muted-foreground/70">Aprovação IA — Entrada em Massa</span>
              </div>
              <button
                type="button"
                onClick={() => massMut.mutate()}
                disabled={massMut.isPending}
                className="flex items-center gap-1 text-[10px] text-primary/70 hover:text-primary transition-colors disabled:opacity-40"
              >
                <RefreshCw className={`w-3 h-3 ${massMut.isPending ? "animate-spin" : ""}`} />
                {massMut.isPending ? "Processando..." : "Gerar plano"}
              </button>
            </div>
            <div className="px-3 py-2.5">
              {aiMassText ? (
                <pre className="text-[10px] text-foreground/70 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">{aiMassText}</pre>
              ) : (
                <p className="text-[10px] text-muted-foreground/40 italic">
                  Clique em "Gerar plano" para a IA aprovar e ajustar os pesos de cada zona de entrada em massa.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default function IntelligencePage() {
  const [symbol, setSymbol] = useState("BTC-USDT");
  const [side, setSide] = useState<Side>("LONG");
  const { data: demoAnalysis } = useQuery<DemoAnalysisState>({
    queryKey: ["intelligence-demo-analysis-state"],
    queryFn: () => fetchDemoAnalysisState() as Promise<DemoAnalysisState>,
    refetchInterval: 10_000,
    placeholderData: (previousData) => previousData,
  });
  const { data: btcTicker } = useGetBingXTicker(
    { symbol: "BTC-USDT" },
    {
      query: {
        queryKey: getGetBingXTickerQueryKey({ symbol: "BTC-USDT" }),
        refetchInterval: 5_000,
      },
    },
  );
  const btcChangePct = Number(btcTicker?.priceChangePercent ?? 0);
  const intelligenceSource: "all" | "demo" = demoAnalysis?.connected ? "demo" : "all";
  const query = useQuery({
    queryKey: ["bot-intelligence", symbol, side, intelligenceSource],
    queryFn: () => fetchIntelligence(symbol, side, btcChangePct, intelligenceSource),
    refetchInterval: demoAnalysis?.connected ? 60_000 : 90_000,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });

  useEffect(() => {
    const symbols = query.data?.symbols;
    if (symbols?.length && !symbols.includes(symbol)) setSymbol(symbols[0]);
  }, [query.data?.symbols, symbol]);

  const data = query.data;
  const quant = data?.quantBrain;
  const edge = quant?.edge ?? {};
  const sniper = edge.sniper ?? {};
  const economics = edge.economics ?? {};
  const operationalRisk = edge.operationalRisk ?? {};
  const shadow = edge.shadowMl ?? quant?.model ?? {};
  const sampler = shadow.shadowSampler ?? {};
  const samplerAnalyses: AnyRecord[] = Array.isArray(sampler.lastAnalyses) ? sampler.lastAnalyses : [];
  const lastSamplerAnalysis = samplerAnalyses[0] ?? {};
  const signalSources: AnyRecord[] = Array.isArray(shadow.signalSources) ? shadow.signalSources : [];
  const shadowSamplerSource = signalSources.find((item) => item.sourceType === "shadow_sampler");
  const signalEdge = edge.signalEdge ?? quant?.signalEdge ?? {};
  const news = edge.newsContext ?? quant?.newsContext ?? {};
  const frames = sniper.altTimeframes ?? {};
  const decision = String(sniper.decision ?? (edge.allow ? "ALLOW" : "WAIT"));
  const allowed = Boolean(edge.allow);
  const rejects: string[] = Array.isArray(edge.gateRejects) ? edge.gateRejects : [];
  const reasons: string[] = Array.isArray(sniper.reasons) ? sniper.reasons : [];
  const modelProbability = Number(shadow.calibratedProbability ?? shadow.rocAuc ?? 0);
  const trainingSamples = Number(shadow.trainingSamplesAvailable ?? shadow.samples ?? 0);
  const minimumTrainingSamples = Number(shadow.minSamples ?? 300);
  const trainingProgress = minimumTrainingSamples > 0 ? Math.min(100, (trainingSamples / minimumTrainingSamples) * 100) : 0;
  const score = Number(edge.score ?? 0);
  const signalSamples = Number(signalEdge?.context?.samples ?? signalEdge?.symbolSide?.samples ?? signalEdge?.samples ?? 0);
  const targetHit = Number(signalEdge?.context?.hit_configured ?? signalEdge?.symbolSide?.hit_configured ?? 0);
  const openDemoPnl = Number(demoAnalysis?.openUnrealizedPnl ?? 0);

  const samplesPerHour = (() => {
    const cycles = Number(sampler.cycles ?? 0);
    const recorded = Number(sampler.recorded ?? 0);
    const interval = Number(sampler.intervalSeconds ?? 60);
    return cycles > 0 ? Math.round((recorded / cycles) * (3600 / interval)) : 0;
  })();
  const pendingSamples = Number((shadow.signalPipeline ?? {}).pending ?? 0);
  const etaLabel = (() => {
    if (shadow.available) return null;
    if (trainingSamples + pendingSamples >= minimumTrainingSamples) return "<5 min";
    if (samplesPerHour <= 0) return null;
    const samplesNeeded = Math.max(0, minimumTrainingSamples - trainingSamples - pendingSamples);
    const h = samplesNeeded / samplesPerHour;
    if (h < 1 / 6) return "<10 min";
    if (h < 1) return `~${Math.round(h * 60)} min`;
    return `~${h.toFixed(1)} h`;
  })();
  const optimalThreshold = Number(shadow.optimalThreshold ?? 0);
  const expectedValuePct = Number(shadow.expectedValuePct ?? 0);
  const profitabilityVerified = Boolean(shadow.profitabilityVerified);
  const simulatedWinRate = Number(shadow.simulatedWinRate ?? 0);
  const breakevenWinRate = Number(shadow.breakevenWinRate ?? 0);
  const dataQualityScore = Number((shadow.dataQuality as AnyRecord | undefined)?.score ?? 0);

  const lastUpdated = useMemo(() => {
    if (!quant?.checkedAt) return "--";
    return new Date(quant.checkedAt).toLocaleTimeString();
  }, [quant?.checkedAt]);
  const serviceError = quant?.errors.health ?? quant?.errors.edge ?? quant?.errors.service ?? (!quant?.enabled ? "disabled" : null);
  const qbSlow = /timeout|aborted|intelligence/i.test(String(serviceError ?? ""));
  const qbAnalysis = qbSlow && quant?.enabled !== false;
  const qbReachable = Boolean(quant?.connected) || qbAnalysis;

  return (
    <AppShell>
      <div className="mx-auto max-w-[1500px] space-y-4 p-4 md:p-5">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-3 border-b border-border/30 pb-4">
          <div className="flex items-center gap-2 flex-1">
            <BrainCircuit className="h-4 w-4 text-primary" />
            <h1 className="text-base font-bold">IA Sniper</h1>
            <StatusBadge
              ok={qbReachable}
              on="QB online"
              off={query.isFetching && !data ? "Conectando" : qbAnalysis ? "QB analysis" : "QB offline"}
              tone={qbAnalysis ? "warn" : qbReachable ? "ok" : "bad"}
            />
            <Badge variant="outline" className="font-mono text-[10px] uppercase">{quant?.gateMode ?? "—"}</Badge>
            {demoAnalysis?.connected && (
              <span className="flex items-center gap-1.5 rounded-md border border-blue-500/25 bg-blue-500/8 px-2 py-0.5 ml-1">
                <span className="text-[9px] font-bold text-blue-400 uppercase tracking-wide">VST</span>
                <span className="h-2.5 w-px bg-border/40" />
                <span className={`font-mono text-[10px] font-bold tabular-nums ${openDemoPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {openDemoPnl >= 0 ? "+" : ""}{openDemoPnl.toFixed(3)}
                </span>
                <span className="h-2.5 w-px bg-border/40" />
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{demoAnalysis.positions?.length ?? 0} pos</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(data?.symbols?.length ? data.symbols : [symbol]).map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex h-8 overflow-hidden rounded-lg border border-border/60">
              {(["LONG", "SHORT"] as Side[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setSide(item)}
                  className={`px-3 text-[11px] font-bold transition-colors ${
                    side === item
                      ? item === "LONG" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                      : "text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => query.refetch()} disabled={query.isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
            </Button>
            <span className="font-mono text-[9px] text-muted-foreground">{lastUpdated}</span>
          </div>
        </header>

        {/* Sentiment Panel */}
        <SentimentPanel symbol={symbol} />

        {query.isPending && !data ? (
          <div className="grid gap-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
          </div>
        ) : query.isError ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
            Erro: {query.error.message}
          </div>
        ) : (
          <>
            {/* Decision bar */}
            <section className={`flex flex-wrap items-center gap-3 rounded-xl border-l-4 px-4 py-2.5 shadow-md shadow-black/25 ${
              allowed ? "border-green-500 bg-green-500/5" : "border-red-500 bg-red-500/5"
            }`}>
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${allowed ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                {allowed ? <Target className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
              </div>
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground leading-none mb-0.5">Decisão</p>
                <p className={`font-mono text-lg font-black leading-tight ${allowed ? "text-green-400" : "text-red-400"}`}>{decision}</p>
              </div>
              <span className="text-[10px] text-muted-foreground">{data?.symbol} · {data?.positionSide} · BTC {data?.btcRegime}</span>
              <div className="ml-auto flex items-center gap-5">
                <div className="text-right"><p className="text-[9px] uppercase text-muted-foreground">Score</p><p className="font-mono text-sm font-bold">{(score * 100).toFixed(1)}</p></div>
                <div className="text-right"><p className="text-[9px] uppercase text-muted-foreground">Gate QB</p><p className="font-mono text-sm font-bold">{quant?.gateMode ?? "—"}</p></div>
                <div className="text-right"><p className="text-[9px] uppercase text-muted-foreground">Execução</p><p className={`font-mono text-sm font-bold ${data?.executionEnabled ? "text-green-400" : "text-amber-400"}`}>{data?.executionEnabled ? "LIVE" : "DESLIG."}</p></div>
              </div>
            </section>

            {/* Metrics row */}
            <section className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-8">
              <Metric label="P(acerto)" value={`${(Number(economics.hitProbability ?? targetHit) * 100).toFixed(1)}%`} detail={`${signalSamples} amostras`} />
              <Metric label="EV líquido" value={`${num(economics.netEvUsdt, 4)}`} detail="USDT" tone={Number(economics.netEvUsdt) > 0 ? "good" : "bad"} />
              <Metric label="Ganho est." value={`${num(economics.estimatedNetTargetUsdt, 4)}`} detail="USDT" />
              <Metric label="Perda est." value={`${num(economics.estimatedLossUsdt, 4)}`} detail="USDT" tone="bad" />
              <Metric label="Taxas" value={pct(economics.estimatedCostPct, 3)} />
              <Metric label="Taxa acerto" value={`${(Number(data?.telemetry.winRate ?? 0) * 100).toFixed(1)}%`} />
              <Metric label="Fat. lucro" value={`${num(data?.telemetry.profitFactor, 2)}x`} />
              <Metric label="PnL acum." value={`${num(data?.telemetry.netPnl, 4)}`} detail="USDT" tone={Number(data?.telemetry.netPnl) >= 0 ? "good" : "bad"} />
            </section>

            {/* Multiframe + Gate reasons */}
            <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
              <PanelBox
                icon={<Activity className="h-3.5 w-3.5 text-primary" />}
                title="Multiframe"
                badge={<span className="text-[9px] text-muted-foreground">mov · vol · breakout · qual</span>}
              >
                <FrameRow name="1m" frame={frames["1m"] ?? {}} />
                <FrameRow name="5m" frame={frames["5m"] ?? {}} />
                <FrameRow name="15m" frame={frames["15m"] ?? {}} />
                <div className="mt-1 grid grid-cols-3 gap-2 border-t border-border/20 pt-2 text-center">
                  <div><p className="text-[9px] text-muted-foreground">Mov ALT</p><p className="font-mono text-xs font-bold">{pct(sniper.altFeatures?.price_change_pct)}</p></div>
                  <div><p className="text-[9px] text-muted-foreground">Momentum</p><p className="font-mono text-xs font-bold uppercase">{sniper.altFeatures?.momentum_quality ?? "--"}</p></div>
                  <div><p className="text-[9px] text-muted-foreground">Toxicidade</p><p className="font-mono text-xs font-bold">{num(sniper.altFeatures?.microstructure_toxicity, 3)}</p></div>
                </div>
              </PanelBox>

              <PanelBox
                icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
                title="Por que bloqueou"
                badge={<Badge variant="outline" className="font-mono text-[10px]">{rejects.length} bloqueio{rejects.length !== 1 ? "s" : ""}</Badge>}
              >
                <div className="max-h-[180px] overflow-auto custom-scrollbar">
                  {(rejects.length ? rejects : reasons).length === 0 ? (
                    <div className="flex items-center gap-1.5 py-1 text-[11px] text-green-400">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Nenhuma rejeição
                    </div>
                  ) : (rejects.length ? rejects : reasons).map((reason, i) => (
                    <div key={`${reason}-${i}`} className="flex gap-1.5 border-b border-border/20 py-1.5 last:border-0">
                      <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                      <span className="break-words font-mono text-[9px] leading-relaxed">{reason}</span>
                    </div>
                  ))}
                </div>
              </PanelBox>
            </div>

            {/* Shadow learning */}
            <PanelBox
              icon={<BrainCircuit className="h-3.5 w-3.5 text-primary" />}
              title="Shadow ML"
              badge={
                <div className="flex items-center gap-1.5">
                  <StatusBadge ok={Boolean(sampler.running)} on="Ativo" off={sampler.enabled === false ? "Off" : "Sem ciclo"} />
                  <span className="font-mono text-[10px] text-muted-foreground">{shadowSamplerSource?.observed ?? 0} obs</span>
                </div>
              }
            >
              <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
                <div className="space-y-2">
                  <div>
                    <div className="mb-1 flex justify-between text-[10px]">
                      <span className="text-muted-foreground">Amostras</span>
                      <span className="font-mono">{trainingSamples}/{minimumTrainingSamples}</span>
                    </div>
                    <Progress value={shadow.available ? Math.min(100, modelProbability * 100) : trainingProgress} className="h-1.5" />
                  </div>
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/20 p-2 text-center">
                    <div><div className="font-mono text-xs font-semibold">{shadow.signalPipeline?.pending ?? 0}</div><div className="text-[9px] text-muted-foreground">Pend.</div></div>
                    <div><div className="font-mono text-xs font-semibold">{shadow.signalPipeline?.finalized ?? 0}</div><div className="text-[9px] text-muted-foreground">Final.</div></div>
                    <div><div className="font-mono text-xs font-semibold">{trainingSamples}</div><div className="text-[9px] text-muted-foreground">Train.</div></div>
                  </div>
                  {!shadow.available && (
                    <div className="space-y-1.5">
                      <Row label="Velocidade" value={samplesPerHour > 0 ? `${samplesPerHour}/h` : "--"} />
                      {etaLabel && <Row label="ETA" value={<span className="font-mono text-xs text-amber-400">{etaLabel}</span>} />}
                      <Row label="Classes" value={`${shadow.hits ?? 0}h · ${shadow.misses ?? 0}m`} />
                    </div>
                  )}
                  {shadow.available && (
                    <div className="space-y-1.5">
                      <Row label="AUC ROC" value={num(shadow.rocAuc, 3)} />
                      <Row label="Threshold" value={optimalThreshold > 0 ? `${(optimalThreshold * 100).toFixed(0)}%` : "--"} />
                      <Row label="EV sim." value={<span className={`font-mono text-xs ${expectedValuePct > 0 ? "text-green-400" : "text-red-400"}`}>{optimalThreshold > 0 ? `${expectedValuePct >= 0 ? "+" : ""}${(expectedValuePct * 100).toFixed(3)}%` : "--"}</span>} />
                      <Row label="Edge" value={<span className={`text-xs font-semibold ${profitabilityVerified ? "text-green-400" : "text-amber-400"}`}>{profitabilityVerified ? "✓ VERIFICADO" : "PENDENTE"}</span>} />
                    </div>
                  )}
                </div>

                {/* Last capture */}
                <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[9px] font-semibold uppercase text-muted-foreground">Última captura</p>
                    <span className="font-mono text-[9px] text-muted-foreground">
                      {lastSamplerAnalysis.capturedAt ? new Date(Number(lastSamplerAnalysis.capturedAt) * 1000).toLocaleTimeString() : "--"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    <Row label="Símbolo" value={<span className="font-mono text-xs font-bold">{lastSamplerAnalysis.symbol ?? "--"}</span>} />
                    <Row label="Decisão" value={<span className="font-mono text-xs font-bold uppercase">{lastSamplerAnalysis.decision ?? "--"}</span>} />
                    <Row label="Score" value={num(lastSamplerAnalysis.score, 3)} />
                    <Row label="Momentum" value={<span className="font-mono text-xs uppercase">{lastSamplerAnalysis.momentumQuality ?? "--"}</span>} />
                  </div>
                  <p className="mt-2 line-clamp-2 border-t border-border/20 pt-2 font-mono text-[9px] text-muted-foreground">
                    {(Array.isArray(lastSamplerAnalysis.reasons) ? lastSamplerAnalysis.reasons : []).join(" · ") || "Sem análise shadow capturada"}
                  </p>
                </div>
              </div>
            </PanelBox>

            {/* ── Sniper Entry Opportunities ── */}
            <SniperEntrySection />

            {/* Bottom 4 panels */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <PanelBox icon={<Target className="h-3.5 w-3.5 text-primary" />} title="Histórico de sinais">
                <Row label="Amostras" value={String(signalSamples)} />
                <Row label="Acerto alvo" value={`${(targetHit * 100).toFixed(1)}%`} />
                <Row label="Score" value={num(signalEdge.score, 3)} />
                <Row label="Veredito" value={<span className="font-mono text-xs uppercase">{signalEdge.verdict ?? "--"}</span>} />
              </PanelBox>

              <PanelBox icon={<ShieldAlert className="h-3.5 w-3.5 text-primary" />} title="Gestão de risco">
                <Row label="PnL 24h" value={pct(operationalRisk.netPnlPct)} />
                <Row label="Drawdown máx." value={<span className="font-mono text-xs text-red-400">{pct(operationalRisk.maxDrawdownPct)}</span>} />
                <Row label="Perdas seguidas" value={String(operationalRisk.consecutiveLosses ?? 0)} />
                <Row label="Operações" value={String(operationalRisk.trades ?? 0)} />
              </PanelBox>

              <PanelBox icon={<Gauge className="h-3.5 w-3.5 text-primary" />} title="Status QB / Notícias">
                <Row label="Quant Brain" value={<span className={`flex items-center gap-1 text-xs ${quant?.connected ? "text-green-400" : qbAnalysis ? "text-amber-400" : "text-red-400"}`}>{quant?.connected ? <Wifi className="h-3 w-3" /> : qbAnalysis ? <Clock className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{quant?.connected ? "ONLINE" : qbAnalysis ? "ANALYSIS" : "OFFLINE"}</span>} />
                {serviceError && <Row label="Detalhe" value={<span className={`max-w-[140px] truncate font-mono text-[10px] ${qbAnalysis ? "text-amber-400" : "text-red-400"}`}>{qbAnalysis ? "edge em analise/descanso" : serviceError}</span>} />}
                <Row label="Notícias" value={<span className="font-mono text-xs uppercase">{news.action ?? "none"}</span>} />
                <Row label="Risco notícia" value={<span className="font-mono text-xs uppercase">{news.riskLevel ?? news.risk_level ?? "LOW"}</span>} />
                <Row label="Hora UTC" value={<span className="flex items-center gap-1 font-mono text-xs"><Clock className="h-2.5 w-2.5" />{data?.hourUtc}:00</span>} />
              </PanelBox>

              <ServiceStatePanel />
            </div>

            {/* Errors */}
            {(() => {
              const realErrors = quant ? Object.entries(quant.errors).filter(([, v]) => !/aborted|timeout/i.test(String(v))) : [];
              if (realErrors.length === 0) return null;
              return (
                <section className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {realErrors.map(([k, v]) => `${k}: ${v}`).join(" · ")}
                  </p>
                </section>
              );
            })()}
          </>
        )}
      </div>
    </AppShell>
  );
}
