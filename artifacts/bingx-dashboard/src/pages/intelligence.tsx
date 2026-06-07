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
  Target,
  TrendingDown,
  TrendingUp,
  Wifi,
  WifiOff,
  XCircle,
  BarChart2,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    return (
      <section className="border border-border/50 bg-card/25 p-4">
        <div className="flex items-center gap-2 mb-4">
          <BarChart2 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Sentimento 24h · Viés Direcional</h2>
        </div>
        <Skeleton className="h-20 w-full" />
      </section>
    );
  }

  if (!data) return null;

  const { direction, confidence, biasRatio, entryBias, indicators, error } = data;
  const dirColor = direction === "BULL" ? "text-green-400" : direction === "BEAR" ? "text-red-400" : "text-amber-400";
  const dirBg = direction === "BULL" ? "bg-green-500/10 border-green-500/30" : direction === "BEAR" ? "bg-red-500/10 border-red-500/30" : "bg-amber-500/10 border-amber-500/30";
  const longPct = Math.round(entryBias.longWeight * 100);
  const shortPct = 100 - longPct;

  const bars: { label: string; value: number; unit: string; bullish: boolean }[] = [
    { label: "Desvio VWAP", value: indicators.vwapDeviation, unit: "%", bullish: indicators.vwapDeviation >= 0 },
    { label: "Delta vol", value: indicators.volumeDelta * 100, unit: "%", bullish: indicators.volumeDelta >= 0 },
    { label: "Mom 4h", value: indicators.momentum4h, unit: "%", bullish: indicators.momentum4h >= 0 },
    { label: "Mom 24h", value: indicators.momentum24h, unit: "%", bullish: indicators.momentum24h >= 0 },
    { label: "Bias body", value: indicators.bodyBias * 100, unit: "%", bullish: indicators.bodyBias >= 0 },
  ];

  return (
    <section className={`border p-4 ${dirBg}`}>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <BarChart2 className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Sentimento 24h · Viés Direcional</h2>
        <Badge variant="outline" className={`font-mono font-bold ${dirColor}`}>{direction}</Badge>
        <span className="text-xs text-muted-foreground ml-1">confiança {(confidence * 100).toFixed(0)}%</span>
        {error && <span className="text-[9px] text-amber-400 ml-auto font-mono">⚠ {error}</span>}
      </div>

      <div className="grid gap-5 sm:grid-cols-[1fr_1.2fr]">
        {/* Bias distribution bar */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Distribuição de entradas recomendada</p>
          <div className="flex h-8 w-full overflow-hidden rounded-md border border-border/40">
            <div
              className="flex items-center justify-center bg-green-500/25 text-[11px] font-bold text-green-400 transition-all"
              style={{ width: `${longPct}%` }}
            >
              {longPct >= 20 ? `${longPct}% L` : ""}
            </div>
            <div
              className="flex items-center justify-center bg-red-500/25 text-[11px] font-bold text-red-400 transition-all"
              style={{ width: `${shortPct}%` }}
            >
              {shortPct >= 20 ? `${shortPct}% S` : ""}
            </div>
          </div>
          <div className="flex justify-between mt-1.5">
            <span className="font-mono text-[10px] text-green-400">{longPct}% LONG</span>
            <span className="font-mono text-[10px] text-red-400">{shortPct}% SHORT</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="border border-border/30 rounded p-2">
              <p className="text-[8px] uppercase text-muted-foreground">EMA 12/24</p>
              <p className={`font-mono text-xs font-bold ${indicators.ema12vs24 === "BULL" ? "text-green-400" : indicators.ema12vs24 === "BEAR" ? "text-red-400" : "text-muted-foreground"}`}>
                {indicators.ema12vs24}
              </p>
            </div>
            <div className="border border-border/30 rounded p-2">
              <p className="text-[8px] uppercase text-muted-foreground">Posição</p>
              <p className="font-mono text-xs font-bold">{(indicators.rangePosition * 100).toFixed(0)}%</p>
              <p className="text-[7px] text-muted-foreground">{indicators.rangePosition > 0.65 ? "topo" : indicators.rangePosition < 0.35 ? "fundo" : "meio"}</p>
            </div>
            <div className="border border-border/30 rounded p-2">
              <p className="text-[8px] uppercase text-muted-foreground">Vol trend</p>
              <p className={`font-mono text-xs font-bold ${indicators.volumeTrend === "RISING" ? "text-green-400" : indicators.volumeTrend === "FALLING" ? "text-red-400" : "text-muted-foreground"}`}>
                {indicators.volumeTrend === "RISING" ? "↑" : indicators.volumeTrend === "FALLING" ? "↓" : "—"} {indicators.volumeTrend}
              </p>
            </div>
          </div>
        </div>

        {/* Indicator bars */}
        <div className="space-y-2">
          {bars.map((bar) => {
            const absVal = Math.abs(bar.value);
            const pct = Math.min(100, absVal * 5);
            return (
              <div key={bar.label}>
                <div className="flex justify-between mb-0.5">
                  <span className="text-[10px] text-muted-foreground">{bar.label}</span>
                  <span className={`font-mono text-[10px] font-bold ${bar.bullish ? "text-green-400" : "text-red-400"}`}>
                    {bar.value >= 0 ? "+" : ""}{bar.value.toFixed(3)}{bar.unit}
                  </span>
                </div>
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/30">
                  <div
                    className={`h-full rounded-full ${bar.bullish ? "bg-green-500/60" : "bg-red-500/60"}`}
                    style={{ width: `${pct}%`, marginLeft: bar.bullish ? "50%" : `${50 - pct / 2}%`, maxWidth: "50%" }}
                  />
                </div>
              </div>
            );
          })}
          <div className="mt-1">
            <div className="flex justify-between mb-0.5">
              <span className="text-[10px] text-muted-foreground">Breakout</span>
              <span className={`font-mono text-[10px] font-bold ${indicators.highLowBreak === "BREAKOUT_UP" ? "text-green-400" : indicators.highLowBreak === "BREAKOUT_DOWN" ? "text-red-400" : "text-muted-foreground"}`}>
                {indicators.highLowBreak === "BREAKOUT_UP" ? "↑ BREAKOUT UP" : indicators.highLowBreak === "BREAKOUT_DOWN" ? "↓ BREAKOUT DOWN" : "RANGE BOUND"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <p className="mt-3 text-[9px] text-muted-foreground">
        Baseado em {data.candles24h} candles 1h · {data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : "--"} · Cache 5min
      </p>
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
  const params = new URLSearchParams({
    symbol,
    side,
    btcChangePct: String(btcChangePct),
    source,
  });
  const response = await fetch(apiUrl(`/api/bot/intelligence?${params}`), {
    credentials: "include",
  });
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

function StatusBadge({ ok, on, off }: { ok: boolean; on: string; off: string }) {
  return (
    <Badge
      variant="outline"
      className={ok
        ? "border-green-500/40 bg-green-500/10 text-green-400"
        : "border-red-500/40 bg-red-500/10 text-red-400"}
    >
      {ok ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <XCircle className="mr-1 h-3 w-3" />}
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
  const color = tone === "good"
    ? "text-green-400"
    : tone === "bad"
      ? "text-red-400"
      : tone === "warn"
        ? "text-amber-400"
        : "text-foreground";
  return (
    <Card className="rounded-lg border-border/50 bg-card/40">
      <CardContent className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`mt-1 font-mono text-xl font-bold ${color}`}>{value}</p>
        {detail && <p className="mt-1 text-[10px] text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

function FrameRow({ name, frame }: { name: string; frame: AnyRecord }) {
  const quality = String(frame?.quality ?? "NO_DATA");
  const healthy = quality === "GOOD";
  return (
    <div className="grid grid-cols-[52px_1fr_1fr_1fr_90px] items-center gap-3 border-b border-border/30 py-3 last:border-0">
      <span className="font-mono text-xs font-bold">{name}</span>
      <span className={`font-mono text-xs ${Number(frame?.changePct ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
        {pct(frame?.changePct)}
      </span>
      <span className="font-mono text-xs">{num(frame?.volumeRatioAvg, 2)}x vol</span>
      <span className="truncate text-xs text-muted-foreground">{frame?.breakoutState ?? "NO_DATA"}</span>
      <Badge
        variant="outline"
        className={healthy
          ? "justify-center border-green-500/30 text-green-400"
          : "justify-center border-amber-500/30 text-amber-400"}
      >
        {quality}
      </Badge>
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

  const lastUpdated = useMemo(() => {
    if (!quant?.checkedAt) return "--";
    return new Date(quant.checkedAt).toLocaleTimeString();
  }, [quant?.checkedAt]);
  const serviceError = quant?.errors.health
    ?? quant?.errors.edge
    ?? (!quant?.enabled ? "disabled" : null);

  return (
    <AppShell>
      <div className="mx-auto max-w-[1500px] space-y-5 p-4 md:p-6">
        <header className="flex flex-col gap-4 border-b border-border/40 pb-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-bold">IA Sniper</h1>
              <StatusBadge
                ok={Boolean(quant?.connected)}
                on="Quant online"
                off={query.isFetching && !data ? "Conectando" : serviceError?.includes("aborted") ? "Quant timeout" : "Quant offline"}
              />
              <Badge variant="outline" className="font-mono uppercase">{quant?.gateMode ?? "unknown"}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Decisão operacional, economia líquida, memória pós-sinal e qualidade multiframe
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(data?.symbols?.length ? data.symbols : [symbol]).map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex h-9 overflow-hidden rounded-lg border border-border/60">
              {(["LONG", "SHORT"] as Side[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setSide(item)}
                  className={`px-4 text-xs font-bold transition-colors ${
                    side === item
                      ? item === "LONG" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                      : "text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            <Button variant="outline" size="icon" onClick={() => query.refetch()} disabled={query.isFetching} title="Atualizar">
              <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
            </Button>
            <span className="font-mono text-[10px] text-muted-foreground">{lastUpdated}</span>
          </div>
        </header>

        <SentimentPanel symbol={symbol} />

        {demoAnalysis?.connected && (
          <section className="grid grid-cols-1 gap-3 border border-blue-500/25 bg-blue-500/5 p-4 sm:grid-cols-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Operação</p>
              <p className="mt-1 font-mono text-sm font-bold text-blue-400">VST DEMO ATIVA</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">PnL aberto</p>
              <p className={`mt-1 font-mono text-sm font-bold ${openDemoPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {openDemoPnl >= 0 ? "+" : ""}{openDemoPnl.toFixed(4)} VST
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Posições</p>
              <p className="mt-1 font-mono text-sm font-bold">{demoAnalysis.positions?.length ?? 0} abertas</p>
            </div>
          </section>
        )}

        {query.isPending && !data ? (
          <div className="grid gap-4 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-lg" />)}
          </div>
        ) : query.isError ? (
          <div className="border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-400">
            Não foi possível consultar a central IA: {query.error.message}
          </div>
        ) : (
          <>
            <section className={`border-l-4 px-5 py-4 ${
              allowed ? "border-green-500 bg-green-500/5" : "border-red-500 bg-red-500/5"
            }`}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-4">
                  <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${
                    allowed ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                  }`}>
                    {allowed ? <Target className="h-6 w-6" /> : <ShieldAlert className="h-6 w-6" />}
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Decisão autoritativa</p>
                    <p className={`font-mono text-2xl font-black ${allowed ? "text-green-400" : "text-red-400"}`}>
                      {decision}
                    </p>
                    <p className="text-xs text-muted-foreground">{data?.symbol} · {data?.positionSide} · BTC {data?.btcRegime}</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-5 text-right">
                  <div><p className="text-[9px] uppercase text-muted-foreground">Score</p><p className="font-mono text-lg font-bold">{(score * 100).toFixed(1)}</p></div>
                  <div><p className="text-[9px] uppercase text-muted-foreground">Gate</p><p className="font-mono text-lg font-bold">{quant?.gateMode}</p></div>
                  <div><p className="text-[9px] uppercase text-muted-foreground">Execução</p><p className={`font-mono text-lg font-bold ${data?.executionEnabled ? "text-green-400" : "text-amber-400"}`}>{data?.executionEnabled ? "LIVE" : "OFF"}</p></div>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
              <Metric label="P(hit)" value={`${(Number(economics.hitProbability ?? targetHit) * 100).toFixed(1)}%`} detail={`${signalSamples} amostras`} />
              <Metric label="EV líquido" value={`${num(economics.netEvUsdt, 4)} USDT`} tone={Number(economics.netEvUsdt) > 0 ? "good" : "bad"} />
              <Metric label="Alvo líquido" value={`${num(economics.estimatedNetTargetUsdt, 4)} USDT`} />
              <Metric label="Perda estimada" value={`${num(economics.estimatedLossUsdt, 4)} USDT`} tone="bad" />
              <Metric label="Custos" value={pct(economics.estimatedCostPct, 3)} />
              <Metric label="Win rate" value={`${(Number(data?.telemetry.winRate ?? 0) * 100).toFixed(1)}%`} />
              <Metric label="Profit factor" value={`${num(data?.telemetry.profitFactor, 2)}x`} />
              <Metric label="PnL realizado" value={`${num(data?.telemetry.netPnl, 4)} USDT`} tone={Number(data?.telemetry.netPnl) >= 0 ? "good" : "bad"} />
            </section>

            <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
              <section className="border border-border/50 bg-card/25">
                <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    <h2 className="text-sm font-semibold">Contexto multiframe</h2>
                  </div>
                  <span className="text-[10px] text-muted-foreground">movimento · volume · breakout · qualidade</span>
                </div>
                <div className="px-4">
                  <FrameRow name="1m" frame={frames["1m"] ?? {}} />
                  <FrameRow name="5m" frame={frames["5m"] ?? {}} />
                  <FrameRow name="15m" frame={frames["15m"] ?? {}} />
                </div>
                <div className="grid gap-3 border-t border-border/40 p-4 sm:grid-cols-3">
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Movimento ALT</p>
                    <p className="mt-1 font-mono text-sm font-bold">{pct(sniper.altFeatures?.price_change_pct)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Momentum</p>
                    <p className="mt-1 font-mono text-sm font-bold uppercase">{sniper.altFeatures?.momentum_quality ?? "--"}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Toxicidade micro</p>
                    <p className="mt-1 font-mono text-sm font-bold">{num(sniper.altFeatures?.microstructure_toxicity, 3)}</p>
                  </div>
                </div>
              </section>

              <section className="border border-border/50 bg-card/25">
                <div className="flex items-center gap-2 border-b border-border/40 px-4 py-3">
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                  <h2 className="text-sm font-semibold">Motivos do gate</h2>
                  <Badge variant="outline" className="ml-auto font-mono">{rejects.length}</Badge>
                </div>
                <div className="max-h-[280px] overflow-auto p-3">
                  {(rejects.length ? rejects : reasons).length === 0 ? (
                    <div className="flex items-center gap-2 p-3 text-xs text-green-400">
                      <CheckCircle2 className="h-4 w-4" /> Nenhuma rejeição ativa
                    </div>
                  ) : (rejects.length ? rejects : reasons).map((reason, index) => (
                    <div key={`${reason}-${index}`} className="flex gap-2 border-b border-border/30 px-2 py-2.5 last:border-0">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                      <span className="break-words font-mono text-[10px] leading-relaxed">{reason}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <section className="border border-border/50 bg-card/25">
              <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-4 py-3">
                <BrainCircuit className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Aprendizado shadow 24h</h2>
                <StatusBadge
                  ok={Boolean(sampler.running)}
                  on="Sampler ativo"
                  off={sampler.enabled === false ? "Sampler off" : "Sem ciclo"}
                />
                <Badge variant="outline" className="ml-auto font-mono">
                  {shadowSamplerSource?.observed ?? 0} observados
                </Badge>
              </div>
              <div className="grid gap-4 p-4 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                  <Metric label="Ciclos" value={`${sampler.cycles ?? 0}`} detail={`a cada ${sampler.intervalSeconds ?? "--"}s`} />
                  <Metric label="Registrados" value={`${sampler.recorded ?? 0}`} detail={`${sampler.attempted ?? 0} tentativas`} />
                  <Metric label="Pendentes" value={`${shadowSamplerSource?.pending ?? 0}`} detail={`${shadowSamplerSource?.finalized ?? 0} finalizados`} />
                  <Metric
                    label="Hit sampler"
                    value={`${shadowSamplerSource?.finalized ? ((Number(shadowSamplerSource.hits ?? 0) / Number(shadowSamplerSource.finalized)) * 100).toFixed(1) : "0.0"}%`}
                    detail={`${shadowSamplerSource?.hits ?? 0} hit · ${shadowSamplerSource?.misses ?? 0} miss`}
                  />
                </div>
                <div className="border border-border/40 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Última análise capturada</p>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {lastSamplerAnalysis.capturedAt ? new Date(Number(lastSamplerAnalysis.capturedAt) * 1000).toLocaleTimeString() : "--"}
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <div>
                      <p className="text-[9px] uppercase text-muted-foreground">Símbolo</p>
                      <p className="mt-1 font-mono text-sm font-bold">{lastSamplerAnalysis.symbol ?? "--"} {lastSamplerAnalysis.fallbackSide ?? ""}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase text-muted-foreground">Decisão</p>
                      <p className="mt-1 font-mono text-sm font-bold uppercase">{lastSamplerAnalysis.decision ?? "--"}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase text-muted-foreground">Score</p>
                      <p className="mt-1 font-mono text-sm font-bold">{num(lastSamplerAnalysis.score, 3)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase text-muted-foreground">Momentum</p>
                      <p className="mt-1 font-mono text-sm font-bold uppercase">{lastSamplerAnalysis.momentumQuality ?? "--"}</p>
                    </div>
                  </div>
                  <div className="mt-3 border-t border-border/30 pt-3">
                    <p className="line-clamp-2 font-mono text-[10px] text-muted-foreground">
                      {(Array.isArray(lastSamplerAnalysis.reasons) ? lastSamplerAnalysis.reasons : []).join(" · ") || "Sem análise shadow capturada ainda"}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-4">
              <section className="border border-border/50 p-4">
                <div className="mb-4 flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Shadow ML</h2>
                  <StatusBadge
                    ok={Boolean(shadow.available)}
                    on="Disponível"
                    off={trainingSamples < minimumTrainingSamples ? "Coletando" : "Sem modelo"}
                  />
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Probabilidade</span><span className="font-mono">{(modelProbability * 100).toFixed(1)}%</span></div>
                  <Progress value={shadow.available ? modelProbability * 100 : trainingProgress} />
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Amostras</span>
                    <span className="font-mono">{trainingSamples}/{minimumTrainingSamples}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Classes</span>
                    <span className="font-mono">{shadow.hits ?? 0} hit · {shadow.misses ?? 0} miss</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Observados</span>
                    <span className="font-mono">
                      {shadow.signalPipeline?.observed ?? 0} · {shadow.signalPipeline?.pending ?? 0} pendentes
                    </span>
                  </div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">AUC</span><span className="font-mono">{num(shadow.rocAuc, 3)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Baseline</span><span className={shadow.improvesBaseline ? "text-green-400" : "text-amber-400"}>{shadow.improvesBaseline ? "SUPERADO" : "PENDENTE"}</span></div>
                </div>
              </section>

              <section className="border border-border/50 p-4">
                <div className="mb-4 flex items-center gap-2">
                  <Target className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Memória de sinais</h2>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Contexto</span><span className="font-mono">{signalSamples}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Target hit</span><span className="font-mono">{(targetHit * 100).toFixed(1)}%</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Score</span><span className="font-mono">{num(signalEdge.score, 3)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Veredito</span><span className="font-mono uppercase">{signalEdge.verdict ?? "--"}</span></div>
                </div>
              </section>

              <section className="border border-border/50 p-4">
                <div className="mb-4 flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Risco operacional</h2>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">PnL 24h</span><span className="font-mono">{pct(operationalRisk.netPnlPct)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Drawdown</span><span className="font-mono text-red-400">{pct(operationalRisk.maxDrawdownPct)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Loss streak</span><span className="font-mono">{operationalRisk.consecutiveLosses ?? 0}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Trades</span><span className="font-mono">{operationalRisk.trades ?? 0}</span></div>
                </div>
              </section>

              <section className="border border-border/50 p-4">
                <div className="mb-4 flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Serviço e notícias</h2>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">API</span><span className="flex items-center gap-1">{quant?.connected ? <Wifi className="h-3 w-3 text-green-400" /> : <WifiOff className="h-3 w-3 text-red-400" />}{quant?.connected ? "ONLINE" : "OFFLINE"}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">News action</span><span className="font-mono uppercase">{news.action ?? "none"}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Risk level</span><span className="font-mono uppercase">{news.riskLevel ?? news.risk_level ?? "LOW"}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Hora UTC</span><span className="flex items-center gap-1 font-mono"><Clock3 className="h-3 w-3" />{data?.hourUtc}:00</span></div>
                </div>
              </section>
            </div>

            {quant && Object.keys(quant.errors).length > 0 && (
              <section className="border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-400" />
                  <div>
                    <p className="text-xs font-semibold text-amber-400">Dados parcialmente indisponíveis</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {Object.entries(quant.errors).map(([key, value]) => `${key}: ${value}`).join(" · ")}
                    </p>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
