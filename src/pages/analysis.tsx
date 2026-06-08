import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetBingXTicker, getGetBingXTickerQueryKey,
} from "@/api-client";
import AppShell from "@/components/app-shell";
import { fetchDemoAnalysisState, fetchTelemetryExport, fetchTelemetryState, type DemoPosition } from "@/lib/demo-live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart3, Target, TrendingUp, Zap, AlertTriangle,
  Shield, Clock, Activity, ChevronRight, Brain, Cpu,
} from "lucide-react";

type WindowSize = 10 | 25 | 50 | 100;
type AnalysisSource = "DEMO" | "LIVE";

interface TelemetryOutcome {
  id: string;
  isDemo?: boolean;
  source?: "bingx-live" | "bingx-vst" | "manual";
  symbol: string;
  positionSide: "LONG" | "SHORT";
  side?: "BUY" | "SELL";
  entryTime?: number;
  exitTime: number;
  entryPrice?: number;
  exitPrice?: number;
  qty?: number;
  leverage?: number;
  marginUsed?: number;
  realizedPnl: number;
  grossPnl: number;
  fee: number;
  pnlSource?: "balance_delta" | "price_estimate";
  estimated?: boolean;
  exitReason?: "TP" | "SL" | "MANUAL";
}

interface TelemetryWithOutcomes {
  source?: "all" | "demo" | "live";
  totalTrades: number;
  ewmaWinRate: number;
  ewmaEv: number;
  ewmaFeePerTrade: number;
  symbolProfiles: Array<{
    symbol: string;
    totalSamples: number;
    priorityScore: number;
    toxicityScore: number;
    isToxic: boolean;
  }>;
  hourProfile: Array<{
    hour: number;
    pnl: number;
    winRate: number;
    samples: number;
  }>;
  gateRecommendation: {
    confidence: string;
    evMinThreshold: number;
    winRateMin: number;
    profitFactorMin: number;
    toxicSymbols: string[];
    toxicHours: number[];
    basedOnSamples: number;
  };
  recentOutcomes?: TelemetryOutcome[];
  quantTradeSummary?: {
    totalTrades: number;
    demoTrades: number;
    liveTrades: number;
    sources: Array<{
      source: string;
      isDemo: boolean;
      trades: number;
      wins: number;
      losses: number;
      pnlUsdt: number;
      positivePnlUsdt: number;
      negativePnlUsdt: number;
      lastTradeAt: number;
    }>;
  } | null;
}

interface DemoAnalysisState {
  connected: boolean;
  balance?: string;
  equity?: string;
  availableBalance?: string;
  usedMargin?: string;
  unrealizedPnl?: string;
  openUnrealizedPnl: number;
  openPositionsCount?: number;
  positions: DemoPosition[];
  positionsConfirmed?: boolean;
  currency?: string;
  telemetry: TelemetryWithOutcomes;
  error?: string;
}

function PnLBadge({ val, dec = 4 }: { val: number; dec?: number }) {
  if (val > 0) return <span className="text-green-400 font-mono font-bold">+{val.toFixed(dec)}</span>;
  if (val < 0) return <span className="text-red-400 font-mono font-bold">{val.toFixed(dec)}</span>;
  return <span className="text-muted-foreground font-mono">0.{"0".repeat(dec)}</span>;
}

function MiniBar({ ratio, color, label }: { ratio: number; color: string; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, Math.max(0, Math.abs(ratio) * 100))}%` }} />
      </div>
      {label && <span className="text-[10px] text-muted-foreground font-mono w-10 text-right">{label}</span>}
    </div>
  );
}

function toEpochMs(timestamp?: number) {
  const value = Number(timestamp ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 10_000_000_000 ? value : value * 1000;
}

function formatClock(timestamp?: number) {
  const epochMs = toEpochMs(timestamp);
  return epochMs > 0 ? new Date(epochMs).toLocaleTimeString() : "--";
}

function outcomeReturnPct(outcome: TelemetryOutcome) {
  const pnl = Number(outcome.realizedPnl || 0);
  const margin = Number(outcome.marginUsed || 0);
  if (!Number.isFinite(pnl) || !Number.isFinite(margin) || margin <= 0) return 0;
  return (pnl / margin) * 100;
}

function GateRow({ label, pass, reason }: { label: string; pass: boolean; reason: string }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border/20 last:border-0">
      <div className={`w-2 h-2 rounded-full shrink-0 ${pass ? "bg-green-500" : "bg-red-500"}`} />
      <span className="text-sm font-medium flex-1">{label}</span>
      <span className={`text-xs font-mono ${pass ? "text-green-400" : "text-red-400"}`}>{pass ? "PASS" : "REJECT"}</span>
      <span className="text-[11px] text-muted-foreground max-w-[200px] text-right">{reason}</span>
    </div>
  );
}

function ScoreBar({ score, invert = false }: { score: number; invert?: boolean }) {
  const effective = invert ? 1 - score : score;
  const color = effective > 0.65 ? "bg-green-400" : effective > 0.40 ? "bg-primary" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, score * 100)}%` }} />
      </div>
      <span className={`text-[10px] font-mono w-8 text-right ${color.replace("bg-", "text-")}`}>{(score * 100).toFixed(0)}</span>
    </div>
  );
}

function ConfidenceBadge({ c }: { c: string }) {
  const cls = c === "HIGH" ? "border-green-500/40 text-green-400"
    : c === "MEDIUM" ? "border-primary/40 text-primary"
    : c === "LOW" ? "border-orange-500/40 text-orange-400"
    : "border-border/40 text-muted-foreground";
  return <Badge variant="outline" className={`text-[9px] font-mono px-1.5 ${cls}`}>{c}</Badge>;
}

export default function AnalysisPage() {
  const [window, setWindow] = useState<WindowSize>(50);
  const [analysisSource, setAnalysisSource] = useState<AnalysisSource>("DEMO");

  const { data: btcTicker } = useGetBingXTicker(
    { symbol: "BTC-USDT" },
    { query: { refetchInterval: 5000, queryKey: getGetBingXTickerQueryKey({ symbol: "BTC-USDT" }) } }
  );
  const { data: demoAnalysis, isLoading: isLoadingDemoAnalysis } = useQuery({
    queryKey: ["demo-analysis-state"],
    queryFn: () => fetchDemoAnalysisState() as Promise<DemoAnalysisState>,
    refetchInterval: 10_000,
    placeholderData: (previousData) => previousData,
  });
  const { data: liveTelemetry, isLoading: isLoadingLiveTelemetry } = useQuery({
    queryKey: ["telemetry-state", "live"],
    queryFn: () => fetchTelemetryState("live") as Promise<TelemetryWithOutcomes>,
    enabled: analysisSource === "LIVE",
    refetchInterval: 10000,
    placeholderData: (previousData) => previousData,
  });
  const { data: telemetryExport = [] } = useQuery({
    queryKey: ["telemetry-export"],
    queryFn: () => fetchTelemetryExport() as Promise<TelemetryOutcome[]>,
    refetchInterval: 30_000,
    placeholderData: (previousData) => previousData,
  });

  const btcChange = btcTicker ? parseFloat(btcTicker.priceChangePercent) : 0;
  const btcRegime = btcChange >= 0.5 ? "BULL" : btcChange <= -0.5 ? "BEAR" : "NEUTRAL";
  const telemetry = analysisSource === "DEMO" ? demoAnalysis?.telemetry : liveTelemetry;
  const isLoading = analysisSource === "DEMO"
    ? isLoadingDemoAnalysis && !telemetry
    : isLoadingLiveTelemetry && !telemetry;
  const demoPositions = demoAnalysis?.positions ?? [];
  const openDemoPnl = demoAnalysis?.openUnrealizedPnl ?? 0;
  const demoConnected = demoAnalysis?.connected ?? false;
  const sortedDemoPositions = useMemo(() => (
    [...demoPositions].sort((a, b) => Math.abs(Number(b.unrealizedProfit || 0)) - Math.abs(Number(a.unrealizedProfit || 0)))
  ), [demoPositions]);
  const extendedTelemetry = telemetry;
  const sourceMatches = (outcome: TelemetryOutcome) => analysisSource === "DEMO"
    ? outcome.isDemo === true || outcome.source === "bingx-vst"
    : outcome.isDemo !== true && outcome.source !== "bingx-vst";
  const exportedOutcomes = Array.isArray(telemetryExport)
    ? telemetryExport.filter(sourceMatches)
    : [];
  const stateOutcomes = (extendedTelemetry?.recentOutcomes ?? [])
    .filter(sourceMatches);
  const outcomeById = new Map<string, TelemetryOutcome>();
  for (const outcome of [...exportedOutcomes, ...stateOutcomes]) {
    const key = outcome.id || `${outcome.source ?? "unknown"}-${outcome.symbol}-${outcome.positionSide}-${outcome.exitTime}`;
    outcomeById.set(key, outcome);
  }
  const recentOutcomes = Array.from(outcomeById.values())
    .sort((a, b) => toEpochMs(b.exitTime) - toEpochMs(a.exitTime));
  const closedLedger = recentOutcomes;
  const closedPositive = closedLedger.filter((outcome) => Number(outcome.realizedPnl) > 0);
  const closedNegative = closedLedger.filter((outcome) => Number(outcome.realizedPnl) < 0);
  const closedPositivePnl = closedPositive.reduce((sum, outcome) => sum + Number(outcome.realizedPnl || 0), 0);
  const closedNegativePnl = closedNegative.reduce((sum, outcome) => sum + Number(outcome.realizedPnl || 0), 0);
  const closedNetPnl = closedLedger.reduce((sum, outcome) => sum + Number(outcome.realizedPnl || 0), 0);
  const closedMargin = closedLedger.reduce((sum, outcome) => sum + Number(outcome.marginUsed || 0), 0);
  const closedNetReturnPct = closedMargin > 0 ? (closedNetPnl / closedMargin) * 100 : 0;
  const permanentLedger = useMemo(() => {
    const sources = extendedTelemetry?.quantTradeSummary?.sources ?? [];
    const selected = sources.filter((source) => analysisSource === "DEMO" ? source.isDemo : !source.isDemo);
    return selected.reduce((total, source) => ({
      trades: total.trades + source.trades,
      wins: total.wins + source.wins,
      losses: total.losses + source.losses,
      positive: total.positive + source.positivePnlUsdt,
      negative: total.negative + source.negativePnlUsdt,
      net: total.net + source.pnlUsdt,
    }), { trades: 0, wins: 0, losses: 0, positive: 0, negative: 0, net: 0 });
  }, [analysisSource, extendedTelemetry?.quantTradeSummary?.sources]);
  const realizedLedger = closedLedger.length > 0 ? {
    trades: closedLedger.length,
    wins: closedPositive.length,
    losses: closedNegative.length,
    positive: closedPositivePnl,
    negative: closedNegativePnl,
    net: closedNetPnl,
    netReturnPct: closedNetReturnPct,
    sourceLabel: "telemetry detalhado",
  } : {
    ...permanentLedger,
    netReturnPct: 0,
    sourceLabel: "Quant Brain",
  };
  const latestCloseTime = useMemo(() => {
    const sourceTimes = (extendedTelemetry?.quantTradeSummary?.sources ?? [])
      .filter((source) => analysisSource === "DEMO" ? source.isDemo : !source.isDemo)
      .map((source) => Number(source.lastTradeAt ?? 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    const recentTimes = recentOutcomes
      .map((outcome) => Number(outcome.exitTime ?? 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    const latest = Math.max(0, ...sourceTimes, ...recentTimes);
    if (!latest) return "--";
    return formatClock(latest);
  }, [analysisSource, extendedTelemetry?.quantTradeSummary?.sources, recentOutcomes]);

  const stats = useMemo(() => {
    if (recentOutcomes.length === 0) return null;

    const withProfit = recentOutcomes.map((outcome) => ({
      symbol: outcome.symbol,
      positionSide: outcome.positionSide,
      time: toEpochMs(outcome.exitTime),
      profit: String(outcome.realizedPnl),
      grossProfit: String(outcome.grossPnl),
      commission: String(outcome.fee),
    }));
    const filled = withProfit;
    const windowed = withProfit.slice(0, window);

    const profits = windowed.map((o) => parseFloat(o.profit!));
    const grossProfits = windowed.map((o) => parseFloat(o.grossProfit));
    const wins = profits.filter((p) => p > 0);
    const losses = profits.filter((p) => p < 0);
    const totalPnl = grossProfits.reduce((s, p) => s + p, 0);
    const totalFees = filled.slice(0, window).map((o) => parseFloat(o.commission ?? "0")).reduce((s, f) => s + Math.abs(f), 0);
    const netPnl = profits.reduce((s, p) => s + p, 0);
    const winRate = profits.length > 0 ? (wins.length / profits.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
    const grossWins = wins.reduce((sum, pnl) => sum + pnl, 0);
    const grossLosses = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Number.POSITIVE_INFINITY : 0;
    const ev = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;
    const bestTrade = profits.length > 0 ? Math.max(...profits) : 0;
    const worstTrade = profits.length > 0 ? Math.min(...profits) : 0;

    // Required WR to break even given avg win/loss ratio
    const breakEvenWR = Math.abs(avgLoss) > 0 ? (Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss))) * 100 : 0;

    // Per-symbol
    const bySymbol: Record<string, { pnl: number; count: number; wins: number; losses: number; fees: number }> = {};
    for (const o of windowed) {
      const sym = o.symbol;
      if (!bySymbol[sym]) bySymbol[sym] = { pnl: 0, count: 0, wins: 0, losses: 0, fees: 0 };
      const p = parseFloat(o.profit!);
      bySymbol[sym].pnl += p;
      bySymbol[sym].count++;
      bySymbol[sym].fees += Math.abs(parseFloat((o as { commission?: string | null }).commission ?? "0"));
      if (p > 0) bySymbol[sym].wins++;
      else bySymbol[sym].losses++;
    }
    const symbolRanking = Object.entries(bySymbol)
      .map(([sym, d]) => ({ sym, ...d, wr: d.count > 0 ? (d.wins / d.count) * 100 : 0, toxic: d.pnl < 0 }))
      .sort((a, b) => b.pnl - a.pnl);

    // Hour of day
    const byHour: Record<number, { pnl: number; count: number; wins: number }> = {};
    for (const o of windowed) {
      const h = new Date(o.time).getHours();
      if (!byHour[h]) byHour[h] = { pnl: 0, count: 0, wins: 0 };
      const p = parseFloat(o.profit!);
      byHour[h].pnl += p;
      byHour[h].count++;
      if (p > 0) byHour[h].wins++;
    }
    const hourData = Object.entries(byHour)
      .map(([h, d]) => ({ hour: Number(h), ...d, wr: d.count > 0 ? (d.wins / d.count) * 100 : 0 }))
      .sort((a, b) => a.hour - b.hour);

    // Rolling streaks
    let currentStreak = 0;
    let streakDir = 0;
    for (const p of profits) {
      const dir = p > 0 ? 1 : -1;
      if (streakDir === 0 || dir === streakDir) { currentStreak++; streakDir = dir; }
      else break;
    }

    // Long vs short performance
    const longs = windowed.filter((o) => o.positionSide === "LONG");
    const shorts = windowed.filter((o) => o.positionSide === "SHORT");
    const longPnl = longs.reduce((s, o) => s + parseFloat(o.profit!), 0);
    const shortPnl = shorts.reduce((s, o) => s + parseFloat(o.profit!), 0);
    const longWR = longs.length > 0 ? (longs.filter(o => parseFloat(o.profit!) > 0).length / longs.length) * 100 : 0;
    const shortWR = shorts.length > 0 ? (shorts.filter(o => parseFloat(o.profit!) > 0).length / shorts.length) * 100 : 0;

    return {
      profits, wins, losses, totalPnl, netPnl, totalFees, winRate, avgWin, avgLoss,
      profitFactor, ev, bestTrade, worstTrade, breakEvenWR, symbolRanking,
      hourData, currentStreak, streakDir, longs, shorts, longPnl, shortPnl, longWR, shortWR,
      filled, withProfit, windowed,
    };
  }, [recentOutcomes, window]);

  const edgeLabel = !stats ? "NO DATA"
    : stats.winRate >= 55 && stats.profitFactor >= 1.5 && stats.ev > 0 ? "STRONG EDGE"
    : stats.winRate >= 50 && stats.profitFactor >= 1.0 && stats.ev > 0 ? "MARGINAL EDGE"
    : "NEGATIVE EDGE / RECALIBRATE";

  const edgeColor = !stats ? "text-muted-foreground"
    : edgeLabel === "STRONG EDGE" ? "text-green-400"
    : edgeLabel === "MARGINAL EDGE" ? "text-primary"
    : "text-red-400";

  const edgeBorder = !stats ? "border-border/30"
    : edgeLabel === "STRONG EDGE" ? "border-green-500/40 bg-green-500/5"
    : edgeLabel === "MARGINAL EDGE" ? "border-primary/40 bg-primary/5"
    : "border-red-500/40 bg-red-500/5";

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Analysis — War Room</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Telemetry-driven edge calibration · pipeline: signal → EV gate → execution → realized PnL
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-7 overflow-hidden border border-border/60">
              {(["DEMO", "LIVE"] as AnalysisSource[]).map((source) => (
                <button
                  key={source}
                  type="button"
                  onClick={() => setAnalysisSource(source)}
                  className={`px-3 text-[10px] font-bold transition-colors ${
                    analysisSource === source
                      ? source === "DEMO" ? "bg-blue-500/15 text-blue-400" : "bg-green-500/15 text-green-400"
                      : "text-muted-foreground hover:bg-muted/30"
                  }`}
                >
                  {source === "DEMO" ? "VST DEMO" : "LIVE"}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">Últimos fechamentos:</span>
            {([10, 25, 50, 100] as WindowSize[]).map((w) => (
              <Button
                key={w}
                variant={window === w ? "default" : "outline"}
                size="sm"
                onClick={() => setWindow(w)}
                className={`h-7 w-12 text-xs font-mono ${window !== w ? "border-border/50 text-muted-foreground" : ""}`}
              >
                {w}
              </Button>
            ))}
          </div>
        </div>

        {demoConnected && (
          <div className="grid grid-cols-1 gap-3 border border-blue-500/25 bg-blue-500/5 p-4 sm:grid-cols-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Demo VST</p>
              <p className="mt-1 font-mono text-sm font-bold text-blue-400">ATIVA</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">PnL aberto</p>
              <p className={`mt-1 font-mono text-sm font-bold ${openDemoPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {openDemoPnl >= 0 ? "+" : ""}{openDemoPnl.toFixed(4)} VST
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Posições abertas</p>
              <p className="mt-1 font-mono text-sm font-bold">{demoPositions.length}</p>
            </div>
          </div>
        )}

        <Card className="border-border/60 bg-card/40">
          <CardHeader className="border-b border-border/40 px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Shield className="h-4 w-4 text-primary" />
                Controle permanente de PnL realizado
              </CardTitle>
              <Badge variant="outline" className="font-mono">{analysisSource}</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">PnL positivo</p>
              <p className="mt-1 font-mono text-2xl font-bold text-green-400">+{realizedLedger.positive.toFixed(4)}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{realizedLedger.wins} fechamentos positivos</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">PnL negativo</p>
              <p className="mt-1 font-mono text-2xl font-bold text-red-400">{realizedLedger.negative.toFixed(4)}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{realizedLedger.losses} fechamentos negativos</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Saldo líquido</p>
              <p className={`mt-1 font-mono text-2xl font-bold ${realizedLedger.net >= 0 ? "text-green-400" : "text-red-400"}`}>
                {realizedLedger.net >= 0 ? "+" : ""}{realizedLedger.net.toFixed(4)}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {closedLedger.length > 0 ? `${realizedLedger.netReturnPct >= 0 ? "+" : ""}${realizedLedger.netReturnPct.toFixed(2)}% sobre margem` : `Fonte: ${realizedLedger.sourceLabel}`}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Amostra realizada</p>
              <p className="mt-1 font-mono text-2xl font-bold">{realizedLedger.trades}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">Não depende da janela selecionada</p>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <Card className="border-border/60 bg-card/35">
            <CardHeader className="border-b border-border/40 px-5 py-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Activity className="h-4 w-4 text-primary" />
                  Posições abertas em tempo real
                </CardTitle>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {analysisSource === "DEMO" ? `${demoPositions.length} VST` : "LIVE"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {analysisSource !== "DEMO" ? (
                <div className="p-5 text-xs text-muted-foreground">Use VST DEMO para ver posições abertas consolidadas nesta tela.</div>
              ) : sortedDemoPositions.length === 0 ? (
                <div className="p-5 text-xs text-muted-foreground">Nenhuma posição demo aberta agora.</div>
              ) : (
                <div className="divide-y divide-border/30">
                  {sortedDemoPositions.slice(0, 8).map((position) => {
                    const pnl = Number(position.unrealizedProfit || 0);
                    const qty = Number(position.positionAmt || 0);
                    const entry = Number(position.entryPrice || 0);
                    const mark = Number(position.markPrice || 0);
                    const movePct = entry > 0 && mark > 0
                      ? ((mark - entry) / entry) * 100 * (position.positionSide === "SHORT" ? -1 : 1)
                      : 0;
                    return (
                      <div key={`${position.symbol}-${position.positionSide}-${position.entryPrice}`} className="grid grid-cols-[1fr_90px_90px_110px] items-center gap-3 px-5 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-bold">{position.symbol.replace("-USDT", "")}</span>
                            <Badge variant="outline" className={`border-0 text-[9px] ${position.positionSide === "LONG" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                              {position.positionSide}
                            </Badge>
                            <span className="font-mono text-[10px] text-muted-foreground">{Number.isFinite(qty) ? Math.abs(qty).toFixed(4) : "--"}</span>
                          </div>
                          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                            entry {Number.isFinite(entry) ? entry.toFixed(4) : "--"} · mark {Number.isFinite(mark) ? mark.toFixed(4) : "--"}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Move</p>
                          <p className={`font-mono text-xs font-bold ${movePct >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {movePct >= 0 ? "+" : ""}{movePct.toFixed(3)}%
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Lev</p>
                          <p className="font-mono text-xs font-bold">{position.leverage ?? "--"}x</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[9px] uppercase text-muted-foreground">Open PnL</p>
                          <p className={`font-mono text-sm font-bold ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {pnl >= 0 ? "+" : ""}{Number.isFinite(pnl) ? pnl.toFixed(4) : "0.0000"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/60 bg-card/35">
            <CardHeader className="border-b border-border/40 px-5 py-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Clock className="h-4 w-4 text-primary" />
                  Operacoes fechadas
                </CardTitle>
                <span className="font-mono text-[10px] text-muted-foreground">ultimo: {latestCloseTime}</span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {recentOutcomes.length > 0 ? (
                <div className="divide-y divide-border/30">
                  <div className="grid grid-cols-[86px_1fr_74px_82px_128px] items-center gap-3 px-5 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <span>Hora</span>
                    <span>Par / lado</span>
                    <span>Motivo</span>
                    <span>Fee</span>
                    <span className="text-right">PnL</span>
                  </div>
                  {recentOutcomes.slice(0, 100).map((outcome) => {
                    const pnl = Number(outcome.realizedPnl || 0);
                    const fee = Number(outcome.fee || 0);
                    const qty = Number(outcome.qty || 0);
                    const entry = Number(outcome.entryPrice || 0);
                    const exit = Number(outcome.exitPrice || 0);
                    const returnPct = outcomeReturnPct(outcome);
                    return (
                      <div key={outcome.id} className="grid grid-cols-[86px_1fr_74px_82px_128px] items-center gap-3 px-5 py-3">
                        <span className="font-mono text-[10px] text-muted-foreground">{formatClock(outcome.exitTime)}</span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-bold">{outcome.symbol.replace("-USDT", "")}</span>
                            <Badge variant="outline" className={`border-0 text-[9px] ${outcome.positionSide === "LONG" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                              {outcome.positionSide}
                            </Badge>
                            {Number.isFinite(qty) && qty > 0 && <span className="font-mono text-[10px] text-muted-foreground">{qty.toFixed(4)}</span>}
                          </div>
                          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                            entry {Number.isFinite(entry) && entry > 0 ? entry.toFixed(4) : "--"} / exit {Number.isFinite(exit) && exit > 0 ? exit.toFixed(4) : "--"}
                          </p>
                        </div>
                        <Badge variant="outline" className={`w-fit border-border/50 font-mono text-[9px] ${outcome.estimated ? "text-orange-300" : ""}`}>
                          {outcome.estimated ? "EST" : outcome.exitReason ?? "CLOSE"}
                        </Badge>
                        <span className="font-mono text-xs text-orange-300">{Number.isFinite(fee) ? fee.toFixed(4) : "0.0000"}</span>
                        <div className="text-right">
                          <p className={`font-mono text-sm font-bold ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {returnPct >= 0 ? "+" : ""}{returnPct.toFixed(2)}%
                          </p>
                          <p className={`mt-0.5 font-mono text-[10px] ${pnl >= 0 ? "text-green-300" : "text-red-300"}`}>
                            {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} {analysisSource === "DEMO" ? "VST" : "USDT"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-5">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <p className="text-[9px] uppercase text-muted-foreground">Fonte</p>
                      <p className="mt-1 font-mono text-xs font-bold">{analysisSource}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase text-muted-foreground">Ledger</p>
                      <p className="mt-1 font-mono text-xs font-bold">{permanentLedger.trades} trades</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase text-muted-foreground">Net</p>
                      <p className={`mt-1 font-mono text-xs font-bold ${permanentLedger.net >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {permanentLedger.net >= 0 ? "+" : ""}{permanentLedger.net.toFixed(4)}
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 border-t border-border/30 pt-3 text-xs text-muted-foreground">
                    O resumo permanente já chegou, mas o telemetry detalhado local ainda não tem fechamentos suficientes para montar ranking e gráficos.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32 rounded-lg" />)}
          </div>
        ) : !stats ? (
          <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
            <BarChart3 className="h-10 w-10 opacity-15" />
            <p className="text-sm">Nenhuma operação {analysisSource === "DEMO" ? "demo" : "live"} fechada ainda</p>
            <p className="text-xs opacity-60">O PnL aberto aparece acima; as métricas entram após o fechamento.</p>
          </div>
        ) : (
          <>
            {/* Pipeline status strip */}
            <div className={`flex items-center gap-3 px-5 py-3 rounded-lg border-2 ${edgeBorder}`}>
              <div className="flex items-center gap-2 shrink-0">
                <Zap className={`w-5 h-5 ${edgeColor}`} />
                <span className={`text-base font-black tracking-tight ${edgeColor}`}>{edgeLabel}</span>
              </div>
              <span className="text-muted-foreground/40">·</span>
              <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                <span>WR <span className={`font-mono font-bold ${stats.winRate >= 55 ? "text-green-400" : stats.winRate >= 50 ? "text-primary" : "text-red-400"}`}>{stats.winRate.toFixed(1)}%</span></span>
                <span>PF <span className={`font-mono font-bold ${stats.profitFactor >= 1.5 ? "text-green-400" : stats.profitFactor >= 1 ? "text-primary" : "text-red-400"}`}>{stats.profitFactor.toFixed(2)}x</span></span>
                <span>EV <span className={`font-mono font-bold ${stats.ev > 0 ? "text-green-400" : "text-red-400"}`}>{stats.ev >= 0 ? "+" : ""}{stats.ev.toFixed(4)}</span></span>
                <span>Break-even WR <span className="font-mono font-bold text-foreground">{stats.breakEvenWR.toFixed(1)}%</span></span>
                <span>Streak <span className={`font-mono font-bold ${stats.streakDir > 0 ? "text-green-400" : "text-red-400"}`}>{stats.streakDir > 0 ? "+" : "-"}{stats.currentStreak}</span></span>
              </div>
              <div className="ml-auto shrink-0">
                <Badge variant="outline" className={`text-[10px] font-mono ${btcRegime === "BULL" ? "border-green-500/40 text-green-400" : btcRegime === "BEAR" ? "border-red-500/40 text-red-400" : "border-border/50 text-muted-foreground"}`}>
                  BTC {btcRegime}
                </Badge>
              </div>
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="bg-card/50 border-border/50">
                <CardHeader className="pb-1 pt-4 px-4">
                  <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Target className="w-3 h-3" /> Win Rate
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className={`text-3xl font-bold font-mono ${stats.winRate >= 55 ? "text-green-400" : stats.winRate >= 50 ? "text-primary" : "text-red-400"}`}>
                    {stats.winRate.toFixed(1)}%
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">{stats.wins.length}W · {stats.losses.length}L · {stats.profits.length} trades</p>
                  <div className="mt-2">
                    <MiniBar ratio={stats.winRate / 100} color={stats.winRate >= 55 ? "bg-green-400" : stats.winRate >= 50 ? "bg-primary" : "bg-red-400"} label={`${stats.winRate.toFixed(0)}%`} />
                    <div className="relative mt-0.5">
                      <div className="absolute h-2 border-l border-dashed border-orange-400/60" style={{ left: `${stats.breakEvenWR}%` }} />
                    </div>
                    <p className="text-[9px] text-muted-foreground mt-1">Break-even at {stats.breakEvenWR.toFixed(0)}% <span className="text-orange-400">▲</span></p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card/50 border-border/50">
                <CardHeader className="pb-1 pt-4 px-4">
                  <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Zap className="w-3 h-3" /> Profit Factor
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className={`text-3xl font-bold font-mono ${stats.profitFactor >= 1.5 ? "text-green-400" : stats.profitFactor >= 1 ? "text-primary" : "text-red-400"}`}>
                    {stats.profitFactor > 0 ? stats.profitFactor.toFixed(2) : "—"}x
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                    <div>avg win: <span className="text-green-400 font-mono">+{stats.avgWin.toFixed(4)}</span></div>
                    <div>avg loss: <span className="text-red-400 font-mono">{stats.avgLoss.toFixed(4)}</span></div>
                  </div>
                  <div className="mt-2">
                    <MiniBar ratio={Math.min(stats.profitFactor / 3, 1)} color="bg-primary" label={`${stats.profitFactor.toFixed(1)}x`} />
                    <p className="text-[9px] text-muted-foreground mt-1">Target: 1.5x minimum for sniper</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card/50 border-border/50">
                <CardHeader className="pb-1 pt-4 px-4">
                  <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <TrendingUp className="w-3 h-3" /> Realized PnL
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className={`text-3xl font-bold font-mono ${stats.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {stats.totalPnl >= 0 ? "+" : ""}{stats.totalPnl.toFixed(4)}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                    <div>fee drag: <span className="text-orange-400 font-mono">−{stats.totalFees.toFixed(4)}</span></div>
                    <div>net: <span className={`font-mono font-semibold ${stats.netPnl >= 0 ? "text-green-400" : "text-red-400"}`}>{stats.netPnl >= 0 ? "+" : ""}{stats.netPnl.toFixed(4)}</span></div>
                  </div>
                  <p className="text-[9px] text-muted-foreground mt-2">Últimos {Math.min(window, stats.profits.length)} fechamentos {analysisSource.toLowerCase()}</p>
                </CardContent>
              </Card>

              <Card className="bg-card/50 border-border/50">
                <CardHeader className="pb-1 pt-4 px-4">
                  <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Activity className="w-3 h-3" /> Expected Value / Trade
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className={`text-3xl font-bold font-mono ${stats.ev > 0 ? "text-green-400" : "text-red-400"}`}>
                    {stats.ev >= 0 ? "+" : ""}{stats.ev.toFixed(4)}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    EV = (WR × avgW) + (LR × avgL)
                  </p>
                  <div className="mt-2 space-y-0.5">
                    <div className="text-[10px] text-muted-foreground">Best: <span className="text-green-400 font-mono">+{stats.bestTrade.toFixed(4)}</span></div>
                    <div className="text-[10px] text-muted-foreground">Worst: <span className="text-red-400 font-mono">{stats.worstTrade.toFixed(4)}</span></div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Long vs Short regime */}
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "LONG Performance", pnl: stats.longPnl, wr: stats.longWR, count: stats.longs.length, color: "green" },
                { label: "SHORT Performance", pnl: stats.shortPnl, wr: stats.shortWR, count: stats.shorts.length, color: "red" },
              ].map(({ label, pnl, wr, count, color }) => (
                <Card key={label} className="bg-card/50 border-border/50">
                  <CardContent className="px-5 py-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded ${color === "green" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>{label}</span>
                        <span className="text-xs text-muted-foreground">{count} trades</span>
                      </div>
                      <PnLBadge val={pnl} />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Win rate</span>
                        <span className={`font-mono font-bold ${wr >= 50 ? "text-green-400" : "text-red-400"}`}>{wr.toFixed(1)}%</span>
                      </div>
                      <MiniBar ratio={wr / 100} color={wr >= 55 ? "bg-green-400" : wr >= 50 ? "bg-primary" : "bg-red-400"} />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Adaptive Gate Simulation */}
              <Card className="border-border/50 bg-card/30">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Shield className="w-4 h-4 text-primary" /> Adaptive Gate Status
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground">Current entry conditions based on telemetry</p>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-0">
                  <GateRow
                    label="EV Gate"
                    pass={stats.ev > 0}
                    reason={stats.ev > 0 ? `EV = +${stats.ev.toFixed(4)} per trade` : `EV = ${stats.ev.toFixed(4)} — recalibrate`}
                  />
                  <GateRow
                    label="Win Rate Gate"
                    pass={stats.winRate >= stats.breakEvenWR}
                    reason={`${stats.winRate.toFixed(1)}% ≥ ${stats.breakEvenWR.toFixed(1)}% break-even`}
                  />
                  <GateRow
                    label="Profit Factor Gate"
                    pass={stats.profitFactor >= 1.0}
                    reason={`PF = ${stats.profitFactor.toFixed(2)}x (target: ≥1.5)`}
                  />
                  <GateRow
                    label="BTC Regime Gate"
                    pass={btcRegime !== "NEUTRAL"}
                    reason={`BTC ${btcChange >= 0 ? "+" : ""}${btcChange.toFixed(2)}% — regime: ${btcRegime}`}
                  />
                  <GateRow
                    label="Fee Drag Gate"
                    pass={stats.totalPnl > stats.totalFees}
                    reason={`gross ${stats.totalPnl.toFixed(4)} vs fees ${stats.totalFees.toFixed(4)}`}
                  />
                  <div className="mt-3 pt-3 border-t border-border/20">
                    <p className="text-[10px] text-muted-foreground">
                      Limiares calibrados pelos últimos <span className="text-foreground font-mono">{Math.min(window, stats.profits.length)}</span> fechamentos.
                      Uma janela maior dá estabilidade; uma menor reage mais rápido.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Symbol toxicity */}
              <Card className="border-border/50 bg-card/30">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-orange-400" /> Symbol Toxicity
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground">Symbols with negative cumulative PnL → avoid</p>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-2.5">
                  {stats.symbolRanking.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No data</p>
                  ) : stats.symbolRanking.map(({ sym, pnl, count, wr, toxic }) => (
                    <div key={sym} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-sm">{sym}</span>
                          {toxic && <Badge variant="outline" className="text-[8px] px-1 py-0 border-red-500/40 text-red-400">TOXIC</Badge>}
                          <span className="text-[10px] text-muted-foreground">{count}t · {wr.toFixed(0)}%WR</span>
                        </div>
                        <PnLBadge val={pnl} />
                      </div>
                      <MiniBar
                        ratio={Math.abs(pnl) / (Math.max(...stats.symbolRanking.map((s) => Math.abs(s.pnl))) || 1)}
                        color={pnl >= 0 ? "bg-green-400/50" : "bg-red-400/50"}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Hour of day */}
              <Card className="border-border/50 bg-card/30">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary" /> Hour Toxicity
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground">Which hours produce positive edge</p>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  {stats.hourData.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No data</p>
                  ) : (
                    <div className="space-y-1.5">
                      {stats.hourData.sort((a, b) => b.pnl - a.pnl).slice(0, 8).map(({ hour, pnl, count, wr }) => (
                        <div key={hour} className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-muted-foreground w-8">{String(hour).padStart(2, "0")}h</span>
                          <div className="flex-1">
                            <MiniBar
                              ratio={Math.abs(pnl) / (Math.max(...stats.hourData.map((h) => Math.abs(h.pnl))) || 1)}
                              color={pnl >= 0 ? "bg-green-400/60" : "bg-red-400/60"}
                            />
                          </div>
                          <span className={`text-[10px] font-mono w-16 text-right ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {pnl >= 0 ? "+" : ""}{pnl.toFixed(3)}
                          </span>
                          <span className="text-[9px] text-muted-foreground w-12 text-right">{wr.toFixed(0)}%WR</span>
                          <span className="text-[9px] text-muted-foreground w-6 text-right">{count}t</span>
                        </div>
                      ))}
                      <p className="text-[10px] text-muted-foreground pt-2 border-t border-border/20">
                        Avoid trading in red hours. Restrict to top 3 performing hours for sniper mode.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* ── Adaptive Engine Panel ───────────────────────────────────── */}
            {telemetry && (
              <div className="space-y-4">
                {/* Header strip */}
                <div className="flex items-center gap-2 pt-2">
                  <Brain className="w-4 h-4 text-primary shrink-0" />
                  <h2 className="text-sm font-bold tracking-tight">Adaptive Engine</h2>
                  <span className="text-[10px] text-muted-foreground">— EWMA learning from realized outcomes · ClusterKey=(symbol, side, hour, regime)</span>
                  <div className="ml-auto flex items-center gap-2">
                    <ConfidenceBadge c={telemetry.gateRecommendation.confidence} />
                    <span className="text-[10px] text-muted-foreground font-mono">{telemetry.totalTrades} samples</span>
                  </div>
                </div>

                {/* EWMA snapshot + gate recommendation */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  {/* EWMA live state */}
                  <Card className="border-primary/20 bg-primary/5">
                    <CardHeader className="px-4 pt-4 pb-2">
                      <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Cpu className="w-3 h-3" /> EWMA State (live)
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-3">
                      <div>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-muted-foreground">EWMA Win Rate</span>
                          <span className={`font-mono font-bold ${telemetry.ewmaWinRate >= 0.55 ? "text-green-400" : telemetry.ewmaWinRate >= 0.50 ? "text-primary" : "text-red-400"}`}>
                            {(telemetry.ewmaWinRate * 100).toFixed(1)}%
                          </span>
                        </div>
                        <ScoreBar score={telemetry.ewmaWinRate} />
                        <p className="text-[9px] text-muted-foreground mt-1">α=0.20 fast EWMA · updates each trade</p>
                      </div>
                      <div>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-muted-foreground">EWMA EV / trade</span>
                          <span className={`font-mono font-bold ${telemetry.ewmaEv > 0 ? "text-green-400" : "text-red-400"}`}>
                            {telemetry.ewmaEv >= 0 ? "+" : ""}{telemetry.ewmaEv.toFixed(4)}
                          </span>
                        </div>
                        <MiniBar ratio={Math.min(Math.abs(telemetry.ewmaEv) / 0.05, 1)} color={telemetry.ewmaEv > 0 ? "bg-green-400" : "bg-red-400"} />
                        <p className="text-[9px] text-muted-foreground mt-1">α=0.08 slow EWMA · cross-session smoothing</p>
                      </div>
                      <div className="flex justify-between text-xs pt-1 border-t border-border/20">
                        <span className="text-muted-foreground">Avg fee / trade</span>
                        <span className="font-mono text-orange-400">−{telemetry.ewmaFeePerTrade.toFixed(4)}</span>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Gate recommendation */}
                  <Card className="border-border/50 bg-card/30">
                    <CardHeader className="px-4 pt-4 pb-2">
                      <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                        <Shield className="w-3 h-3 text-primary" /> Adaptive Gate Recommendation
                        <ConfidenceBadge c={telemetry.gateRecommendation.confidence} />
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-2">
                      {telemetry.gateRecommendation.confidence === "INSUFFICIENT_DATA" ? (
                        <div className="flex flex-col items-center gap-2 py-4 text-muted-foreground">
                          <Brain className="w-6 h-6 opacity-20" />
                          <p className="text-xs">Need {10 - telemetry.totalTrades} more trades for recommendations</p>
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-3 gap-2 text-center">
                            {[
                              { label: "EV min", val: telemetry.gateRecommendation.evMinThreshold.toFixed(4), env: "EV_MIN_THRESHOLD" },
                              { label: "WR min", val: `${(telemetry.gateRecommendation.winRateMin * 100).toFixed(0)}%`, env: "WIN_RATE_MIN" },
                              { label: "PF min", val: `${telemetry.gateRecommendation.profitFactorMin.toFixed(1)}x`, env: "PROFIT_FACTOR_MIN" },
                            ].map(({ label, val, env }) => (
                              <div key={env} className="bg-muted/20 rounded-md px-2 py-2">
                                <div className="text-base font-bold font-mono text-primary">{val}</div>
                                <div className="text-[9px] text-muted-foreground">{label}</div>
                              </div>
                            ))}
                          </div>
                          {telemetry.gateRecommendation.toxicSymbols.length > 0 && (
                            <div className="pt-2 space-y-1">
                              <p className="text-[10px] text-muted-foreground">Toxic symbols (auto-blacklist):</p>
                              <div className="flex flex-wrap gap-1">
                                {telemetry.gateRecommendation.toxicSymbols.map((s) => (
                                  <Badge key={s} variant="outline" className="text-[9px] border-red-500/40 text-red-400 font-mono">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {telemetry.gateRecommendation.toxicHours.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-[10px] text-muted-foreground">Toxic hours UTC:</p>
                              <div className="flex flex-wrap gap-1">
                                {telemetry.gateRecommendation.toxicHours.map((h) => (
                                  <Badge key={h} variant="outline" className="text-[9px] border-orange-500/40 text-orange-400 font-mono">{String(h).padStart(2, "0")}h</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          <p className="text-[9px] text-muted-foreground border-t border-border/20 pt-2">
                            Based on {telemetry.gateRecommendation.basedOnSamples} samples · set as ENV to lock in
                          </p>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  {/* Symbol profiles from adaptive engine */}
                  <Card className="border-border/50 bg-card/30">
                    <CardHeader className="px-4 pt-4 pb-2">
                      <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Activity className="w-3 h-3" /> Symbol Priority / Toxicity Scores
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      {telemetry.symbolProfiles.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-3">No symbol profiles yet — trade to populate</p>
                      ) : (
                        <div className="space-y-3">
                          {telemetry.symbolProfiles.slice(0, 6).map((sp) => (
                            <div key={sp.symbol} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-mono font-bold">{sp.symbol}</span>
                                  {sp.isToxic && <Badge variant="outline" className="text-[8px] px-1 py-0 border-red-500/40 text-red-400">TOXIC</Badge>}
                                  <span className="text-[9px] text-muted-foreground">{sp.totalSamples}t</span>
                                </div>
                                <div className="flex items-center gap-2 text-[9px] font-mono">
                                  <span className="text-green-400">P:{(sp.priorityScore * 100).toFixed(0)}</span>
                                  <span className="text-red-400">T:{(sp.toxicityScore * 100).toFixed(0)}</span>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-1">
                                <ScoreBar score={sp.priorityScore} />
                                <ScoreBar score={sp.toxicityScore} invert />
                              </div>
                            </div>
                          ))}
                          <p className="text-[9px] text-muted-foreground pt-1 border-t border-border/20">
                            Priority = WR×0.46 + realizedCapture×0.34 + (1−SLrate)×0.12 + PF×0.08
                          </p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Hour profile from adaptive engine */}
                {telemetry.hourProfile.length > 0 && (
                  <Card className="border-border/50 bg-card/30">
                    <CardHeader className="px-4 pt-4 pb-2">
                      <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Clock className="w-3 h-3" /> Adaptive Hour Profile (UTC) — EWMA-weighted across all sessions
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      <div className="grid grid-cols-12 gap-1">
                        {Array.from({ length: 24 }, (_, h) => {
                          const hp = telemetry.hourProfile.find((x) => x.hour === h);
                          const pnl = hp?.pnl ?? 0;
                          const samples = hp?.samples ?? 0;
                          const wr = hp?.winRate ?? 0;
                          const maxAbs = Math.max(...telemetry.hourProfile.map((x) => Math.abs(x.pnl)), 0.001);
                          const heightPct = samples > 0 ? Math.min(100, Math.abs(pnl) / maxAbs * 100) : 5;
                          return (
                            <div key={h} className="flex flex-col items-center gap-1" title={`${String(h).padStart(2, "0")}:00 UTC | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} | WR: ${(wr * 100).toFixed(0)}% | ${samples} trades`}>
                              <div className="w-full flex flex-col-reverse" style={{ height: 40 }}>
                                {samples > 0 && (
                                  <div
                                    className={`w-full rounded-sm transition-all ${pnl >= 0 ? "bg-green-500/50" : "bg-red-500/50"}`}
                                    style={{ height: `${heightPct}%` }}
                                  />
                                )}
                              </div>
                              <span className="text-[8px] font-mono text-muted-foreground">{String(h).padStart(2, "0")}</span>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-2">
                        Green = positive PnL hours · Red = negative · Height = relative magnitude · Hover for details
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* Rolling trade stream */}
            <Card className="border-border/50 bg-card/30">
              <CardHeader className="px-4 pt-4 pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ChevronRight className="w-4 h-4 text-primary" /> Trade Stream — Last {Math.min(window, stats.windowed.length)} Closed
                </CardTitle>
                <p className="text-[10px] text-muted-foreground">Sequence of realized outcomes — spot edge drift early</p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex flex-wrap gap-1.5">
                  {stats.windowed.map((o, i) => {
                    const p = parseFloat(o.profit!);
                    return (
                      <div
                        key={i}
                        title={`${o.symbol} ${o.positionSide} | ${p >= 0 ? "+" : ""}${p.toFixed(4)} USDT`}
                        className={`w-5 h-5 rounded-sm flex items-center justify-center text-[8px] font-bold transition-opacity hover:opacity-80 cursor-default ${p > 0 ? "bg-green-500/30 text-green-400" : "bg-red-500/30 text-red-400"}`}
                      >
                        {p > 0 ? "W" : "L"}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-6 mt-3 pt-3 border-t border-border/20 text-xs text-muted-foreground">
                  <span>Long fills: <span className="text-foreground font-mono">{stats.longs.length}</span></span>
                  <span>Short fills: <span className="text-foreground font-mono">{stats.shorts.length}</span></span>
                  <span>Fonte: <span className="text-primary font-mono">{analysisSource}</span></span>
                  <span className="ml-auto">
                    Net after fees: <span className={`font-mono font-bold ${stats.netPnl >= 0 ? "text-green-400" : "text-red-400"}`}>{stats.netPnl >= 0 ? "+" : ""}{stats.netPnl.toFixed(4)}</span>
                  </span>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
