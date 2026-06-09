import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Clock3,
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
  BarChart2,
  Pause,
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
    return <Skeleton className="h-10 w-full rounded-xl" />;
  }
  if (!data) return null;

  const { direction, confidence, entryBias, indicators } = data;
  const dirColor = direction === "BULL" ? "text-green-400" : direction === "BEAR" ? "text-red-400" : "text-amber-400";
  const dirBorder = direction === "BULL" ? "border-green-500/25 bg-green-500/5" : direction === "BEAR" ? "border-red-500/25 bg-red-500/5" : "border-amber-500/25 bg-amber-500/5";
  const longPct = Math.round(entryBias.longWeight * 100);
  const shortPct = 100 - longPct;

  const chips: { label: string; value: number; unit: string }[] = [
    { label: "VWAP", value: indicators.vwapDeviation, unit: "%" },
    { label: "ΔVol", value: indicators.volumeDelta * 100, unit: "%" },
    { label: "M4h", value: indicators.momentum4h, unit: "%" },
    { label: "M24h", value: indicators.momentum24h, unit: "%" },
    { label: "Body", value: indicators.bodyBias * 100, unit: "%" },
  ];

  const breakoutLabel =
    indicators.highLowBreak === "BREAKOUT_UP" ? "↑ BRK UP" :
    indicators.highLowBreak === "BREAKOUT_DOWN" ? "↓ BRK DN" : "RANGE";
  const breakoutColor =
    indicators.highLowBreak === "BREAKOUT_UP" ? "text-green-400" :
    indicators.highLowBreak === "BREAKOUT_DOWN" ? "text-red-400" : "text-muted-foreground";

  return (
    <section className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 shadow-lg shadow-black/30 ${dirBorder}`}>
      <BarChart2 className="h-3 w-3 text-primary/60 shrink-0" />
      <span className="text-[11px] font-semibold text-muted-foreground">24h</span>
      <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-mono font-bold leading-4 ${dirColor}`}>
        {direction}
      </Badge>
      <span className="text-[10px] text-muted-foreground">{(confidence * 100).toFixed(0)}%</span>

      <div className="flex h-5 w-[140px] shrink-0 overflow-hidden rounded border border-border/30">
        <div
          className="flex items-center justify-center bg-green-500/20 text-[9px] font-bold text-green-400"
          style={{ width: `${longPct}%` }}
        >
          {longPct}%L
        </div>
        <div
          className="flex items-center justify-center bg-red-500/20 text-[9px] font-bold text-red-400"
          style={{ width: `${shortPct}%` }}
        >
          {shortPct}%S
        </div>
      </div>

      <span className="mx-0.5 h-3 w-px bg-border/40" />

      {chips.map((c) => (
        <span key={c.label} className={`font-mono text-[10px] ${c.value >= 0 ? "text-green-400" : "text-red-400"}`}>
          <span className="text-muted-foreground">{c.label} </span>
          {c.value >= 0 ? "+" : ""}{c.value.toFixed(2)}{c.unit}
        </span>
      ))}

      <span className={`font-mono text-[10px] ${breakoutColor}`}>{breakoutLabel}</span>

      <span className="ml-auto text-[9px] font-mono text-muted-foreground">
        EMA:{indicators.ema12vs24} · Pos:{(indicators.rangePosition * 100).toFixed(0)}% · Vol:{indicators.volumeTrend}
      </span>
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
  const { data, isLoading, dataUpdatedAt } = useQuery<ServiceStateSnapshot>({
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
  const colorClass = stateColors[state] ?? stateColors.HEALTHY;
  const icon = stateIcon[state] ?? stateIcon.HEALTHY;
  const btcAgeMs = data?.lastBtcPriceAt ? Date.now() - data.lastBtcPriceAt : null;
  const btcStale = btcAgeMs !== null && data?.staleDataThresholdMs ? btcAgeMs > data.staleDataThresholdMs : false;

  return (
    <PanelBox icon={<Gauge className="h-3.5 w-3.5 text-primary" />} title="Serviço">
      {!data ? (
        <p className="text-[10px] text-muted-foreground">Carregando...</p>
      ) : (
        <div className="space-y-2">
          <Row label="Estado" value={<span className={`font-mono font-bold text-xs flex items-center gap-1`}>{icon}{state}</span>} />
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

function StatusBadge({ ok, on, off }: { ok: boolean; on: string; off: string }) {
  return (
    <Badge
      variant="outline"
      className={`text-[10px] ${ok
        ? "border-green-500/40 bg-green-500/10 text-green-400"
        : "border-red-500/40 bg-red-500/10 text-red-400"}`}
    >
      {ok ? <CheckCircle2 className="mr-1 h-2.5 w-2.5" /> : <XCircle className="mr-1 h-2.5 w-2.5" />}
      {ok ? on : off}
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
      {typeof value === "string"
        ? <span className="font-mono text-xs">{value}</span>
        : value}
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
      <div className="p-3 space-y-2">
        {children}
      </div>
    </section>
  );
}

function FrameRow({ name, frame }: { name: string; frame: AnyRecord }) {
  const quality = String(frame?.quality ?? "NO_DATA");
  const healthy = quality === "GOOD";
  const changePct = Number(frame?.changePct ?? 0);
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
    refetchInterval: demoAnalysis?.connected ? 12_000 : 20_000,
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
  const trainingProgress = minimumTrainingSamples > 0
    ? Math.min(100, (trainingSamples / minimumTrainingSamples) * 100)
    : 0;
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
  const serviceError = quant?.errors.health ?? quant?.errors.edge ?? (!quant?.enabled ? "disabled" : null);

  return (
    <AppShell>
      <div className="mx-auto max-w-[1500px] space-y-4 p-4 md:p-5">
        {/* ── Header ── */}
        <header className="flex flex-wrap items-center gap-3 border-b border-border/30 pb-4">
          <div className="flex items-center gap-2 flex-1">
            <BrainCircuit className="h-4 w-4 text-primary" />
            <h1 className="text-base font-bold">IA Sniper</h1>
            <StatusBadge
              ok={Boolean(quant?.connected)}
              on="QB online"
              off={query.isFetching && !data ? "Conectando" : serviceError?.includes("aborted") ? "QB timeout" : "QB offline"}
            />
            <Badge variant="outline" className="font-mono text-[10px] uppercase">{quant?.gateMode ?? "—"}</Badge>
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

        {/* ── Sentiment strip ── */}
        <SentimentPanel symbol={symbol} />

        {/* ── Demo banner ── */}
        {demoAnalysis?.connected && (
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-blue-500/25 bg-blue-500/5 px-4 py-2.5 shadow shadow-black/20">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Operação</span>
            <span className="font-mono text-sm font-bold text-blue-400">VST DEMO</span>
            <span className="mx-1 h-3 w-px bg-border/40" />
            <span className="text-[10px] text-muted-foreground">PnL aberto</span>
            <span className={`font-mono text-sm font-bold ${openDemoPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {openDemoPnl >= 0 ? "+" : ""}{openDemoPnl.toFixed(4)} VST
            </span>
            <span className="mx-1 h-3 w-px bg-border/40" />
            <span className="text-[10px] text-muted-foreground">Posições</span>
            <span className="font-mono text-sm font-bold">{demoAnalysis.positions?.length ?? 0}</span>
          </div>
        )}

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
            {/* ── Decision bar ── */}
            <section className={`rounded-xl border-l-4 px-4 py-3 shadow-md shadow-black/25 ${
              allowed
                ? "border-green-500 bg-green-500/5"
                : "border-red-500 bg-red-500/5"
            }`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                    allowed ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                  }`}>
                    {allowed ? <Target className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
                  </div>
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Decisão</p>
                    <p className={`font-mono text-xl font-black leading-tight ${allowed ? "text-green-400" : "text-red-400"}`}>
                      {decision}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{data?.symbol} · {data?.positionSide} · BTC {data?.btcRegime}</p>
                  </div>
                </div>
                <div className="flex gap-5 text-right">
                  <div><p className="text-[9px] uppercase text-muted-foreground">Score</p><p className="font-mono text-base font-bold">{(score * 100).toFixed(1)}</p></div>
                  <div><p className="text-[9px] uppercase text-muted-foreground">Gate</p><p className="font-mono text-base font-bold">{quant?.gateMode}</p></div>
                  <div><p className="text-[9px] uppercase text-muted-foreground">Exec</p><p className={`font-mono text-base font-bold ${data?.executionEnabled ? "text-green-400" : "text-amber-400"}`}>{data?.executionEnabled ? "LIVE" : "OFF"}</p></div>
                </div>
              </div>
            </section>

            {/* ── Metrics row ── */}
            <section className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-8">
              <Metric label="P(hit)" value={`${(Number(economics.hitProbability ?? targetHit) * 100).toFixed(1)}%`} detail={`${signalSamples} amostras`} />
              <Metric label="EV líquido" value={`${num(economics.netEvUsdt, 4)}`} detail="USDT" tone={Number(economics.netEvUsdt) > 0 ? "good" : "bad"} />
              <Metric label="Alvo líq." value={`${num(economics.estimatedNetTargetUsdt, 4)}`} detail="USDT" />
              <Metric label="Perda est." value={`${num(economics.estimatedLossUsdt, 4)}`} detail="USDT" tone="bad" />
              <Metric label="Custos" value={pct(economics.estimatedCostPct, 3)} />
              <Metric label="Win rate" value={`${(Number(data?.telemetry.winRate ?? 0) * 100).toFixed(1)}%`} />
              <Metric label="Prof. factor" value={`${num(data?.telemetry.profitFactor, 2)}x`} />
              <Metric label="PnL real." value={`${num(data?.telemetry.netPnl, 4)}`} detail="USDT" tone={Number(data?.telemetry.netPnl) >= 0 ? "good" : "bad"} />
            </section>

            {/* ── Multiframe + Gate reasons ── */}
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
                  <div>
                    <p className="text-[9px] text-muted-foreground">Mov ALT</p>
                    <p className="font-mono text-xs font-bold">{pct(sniper.altFeatures?.price_change_pct)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground">Momentum</p>
                    <p className="font-mono text-xs font-bold uppercase">{sniper.altFeatures?.momentum_quality ?? "--"}</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground">Toxicidade</p>
                    <p className="font-mono text-xs font-bold">{num(sniper.altFeatures?.microstructure_toxicity, 3)}</p>
                  </div>
                </div>
              </PanelBox>

              <PanelBox
                icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
                title="Motivos do gate"
                badge={<Badge variant="outline" className="font-mono text-[10px]">{rejects.length}</Badge>}
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

            {/* ── Shadow learning + 4 panels ── */}
            <PanelBox
              icon={<BrainCircuit className="h-3.5 w-3.5 text-primary" />}
              title="Shadow ML"
              badge={
                <div className="flex items-center gap-1.5">
                  <StatusBadge
                    ok={Boolean(sampler.running)}
                    on="Ativo"
                    off={sampler.enabled === false ? "Off" : "Sem ciclo"}
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">{shadowSamplerSource?.observed ?? 0} obs</span>
                </div>
              }
            >
              <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
                <div className="space-y-2">
                  {/* Progress bar */}
                  <div>
                    <div className="mb-1 flex justify-between text-[10px]">
                      <span className="text-muted-foreground">Amostras</span>
                      <span className="font-mono">{trainingSamples}/{minimumTrainingSamples}</span>
                    </div>
                    <Progress value={shadow.available ? Math.min(100, modelProbability * 100) : trainingProgress} className="h-1.5" />
                  </div>
                  {/* Pipeline */}
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/20 p-2 text-center">
                    <div>
                      <div className="font-mono text-xs font-semibold">{shadow.signalPipeline?.pending ?? 0}</div>
                      <div className="text-[9px] text-muted-foreground">Pend.</div>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">{shadow.signalPipeline?.finalized ?? 0}</div>
                      <div className="text-[9px] text-muted-foreground">Final.</div>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">{trainingSamples}</div>
                      <div className="text-[9px] text-muted-foreground">Train.</div>
                    </div>
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

            {/* ── Bottom 4 panels ── */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <PanelBox icon={<Target className="h-3.5 w-3.5 text-primary" />} title="Memória sinais">
                <Row label="Contexto" value={String(signalSamples)} />
                <Row label="Target hit" value={`${(targetHit * 100).toFixed(1)}%`} />
                <Row label="Score" value={num(signalEdge.score, 3)} />
                <Row label="Veredito" value={<span className="font-mono text-xs uppercase">{signalEdge.verdict ?? "--"}</span>} />
              </PanelBox>

              <PanelBox icon={<ShieldAlert className="h-3.5 w-3.5 text-primary" />} title="Risco operacional">
                <Row label="PnL 24h" value={pct(operationalRisk.netPnlPct)} />
                <Row label="Drawdown" value={<span className="font-mono text-xs text-red-400">{pct(operationalRisk.maxDrawdownPct)}</span>} />
                <Row label="Loss streak" value={String(operationalRisk.consecutiveLosses ?? 0)} />
                <Row label="Trades" value={String(operationalRisk.trades ?? 0)} />
              </PanelBox>

              <PanelBox icon={<Gauge className="h-3.5 w-3.5 text-primary" />} title="Notícias / API">
                <Row label="QB" value={<span className={`flex items-center gap-1 text-xs ${quant?.connected ? "text-green-400" : "text-red-400"}`}>{quant?.connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{quant?.connected ? "ONLINE" : "OFFLINE"}</span>} />
                <Row label="News" value={<span className="font-mono text-xs uppercase">{news.action ?? "none"}</span>} />
                <Row label="Risk" value={<span className="font-mono text-xs uppercase">{news.riskLevel ?? news.risk_level ?? "LOW"}</span>} />
                <Row label="UTC" value={<span className="flex items-center gap-1 font-mono text-xs"><Clock3 className="h-2.5 w-2.5" />{data?.hourUtc}:00</span>} />
              </PanelBox>

              <ServiceStatePanel />
            </div>

            {/* ── Errors ── */}
            {quant && Object.keys(quant.errors).length > 0 && (
              <section className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <p className="font-mono text-[10px] text-muted-foreground">
                  {Object.entries(quant.errors).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
