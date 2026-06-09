import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Brain,
  Cpu,
  TrendingUp,
  TrendingDown,
  Zap,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Minus,
  Layers,
  Database,
  BarChart2,
  Sparkles,
  Radio,
  Radar,
  ArrowUpRight,
  ArrowDownRight,
  Wind,
  Triangle,
  FlaskConical,
  Eye,
} from "lucide-react";
import AppShell from "@/components/app-shell";
import { apiUrl } from "@/lib/api-url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

// ── helpers ───────────────────────────────────────────────────────────────────

async function qbGet(path: string) {
  const res = await fetch(apiUrl(path), { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function pct(v: number | undefined | null, digits = 1) {
  if (v == null || isNaN(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

function fmt(v: number | undefined | null, digits = 4) {
  if (v == null || isNaN(v)) return "—";
  return v >= 0 ? `+${v.toFixed(digits)}` : v.toFixed(digits);
}

function timeAgo(ts: number | null | undefined) {
  if (!ts) return "—";
  const secs = Math.floor((Date.now() / 1000) - ts);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}min`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function wrColor(wr: number) {
  if (wr >= 60) return "text-green-400";
  if (wr >= 45) return "text-amber-400";
  return "text-red-400";
}

function wrBarColor(wr: number) {
  if (wr >= 60) return "bg-green-500";
  if (wr >= 45) return "bg-amber-500";
  return "bg-red-500";
}

function sourceObserved(sources: unknown, sourceType: string) {
  if (Array.isArray(sources)) {
    const row = sources.find((item: any) => item?.sourceType === sourceType);
    return Number(row?.observed ?? 0);
  }
  const record = sources as Record<string, any> | undefined;
  return Number(record?.[sourceType] ?? record?.shadow ?? 0);
}

// ── QB online badge ───────────────────────────────────────────────────────────

function QBStatus() {
  const { data, isError } = useQuery({
    queryKey: ["neural-health"],
    queryFn: () => qbGet("/api/neural/health"),
    refetchInterval: 30_000,
    retry: 1,
  });
  const online = !isError && Boolean((data as any)?.online ?? data);
  return (
    <div className={`flex items-center gap-1.5 text-[11px] font-mono ${online ? "text-green-400" : "text-red-400"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-green-400 animate-pulse" : "bg-red-500"}`} />
      {online ? "QB ONLINE" : "QB OFFLINE"}
    </div>
  );
}

// ── IA 24h Learning Status ─────────────────────────────────────────────────────

function IALearningStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-shadow-status"],
    queryFn: () => qbGet("/api/neural/models/sniper/status"),
    refetchInterval: 30_000,
  });

  const d = (data as any) ?? {};
  const sampler = d.shadowSampler ?? {};
  const pipeline = d.signalPipeline ?? {};
  const sources = d.signalSources ?? [];
  const velocity = d.learningVelocity ?? {};
  const available = d.available ?? d.trained ?? false;
  const samples = d.samples ?? d.n_samples ?? 0;
  const samplesRemaining = d.samplesRemaining ?? Math.max(0, 300 - samples);
  const samplesPerHour = velocity.samplesPerHour ?? 0;
  const etaHours = velocity.etaHours ?? null;
  const cycles = velocity.cycles ?? sampler.cycles ?? 0;
  const pending = pipeline.pending ?? 0;
  const finalized = pipeline.finalized ?? 0;
  const sourceShadow = sourceObserved(sources, "shadow_sampler");

  const items = [
    {
      label: "Modelo",
      value: available ? "TREINADO" : "PENDENTE",
      color: available ? "text-green-400" : "text-amber-400",
      icon: Brain,
      iconColor: "text-violet-400",
      bg: "bg-violet-500/10",
    },
    {
      label: "Amostras",
      value: `${samples.toLocaleString()} / 300`,
      color: samples >= 300 ? "text-green-400" : "text-foreground/80",
      icon: Database,
      iconColor: "text-blue-400",
      bg: "bg-blue-500/10",
    },
    {
      label: "Velocidade",
      value: samplesPerHour > 0 ? `${samplesPerHour}/h` : "—",
      color: samplesPerHour > 0 ? "text-cyan-400" : "text-muted-foreground",
      icon: Zap,
      iconColor: "text-cyan-400",
      bg: "bg-cyan-500/10",
    },
    {
      label: "ETA Treino",
      value: available ? "Completo" : etaHours != null ? `~${etaHours}h` : "—",
      color: available ? "text-green-400" : "text-muted-foreground",
      icon: FlaskConical,
      iconColor: "text-emerald-400",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Ciclos Sampler",
      value: cycles > 0 ? cycles.toLocaleString() : "—",
      color: "text-foreground/70",
      icon: Radio,
      iconColor: "text-violet-400",
      bg: "bg-violet-500/10",
    },
    {
      label: "Pipeline",
      value: `${pending} pend · ${finalized} fin`,
      color: "text-foreground/60",
      icon: Activity,
      iconColor: "text-amber-400",
      bg: "bg-amber-500/10",
    },
    {
      label: "Sinais Shadow",
      value: sourceShadow > 0 ? sourceShadow.toLocaleString() : "—",
      color: "text-foreground/60",
      icon: Eye,
      iconColor: "text-fuchsia-400",
      bg: "bg-fuchsia-500/10",
    },
    {
      label: "Faltam",
      value: samplesRemaining > 0 ? `${samplesRemaining} amostras` : "0 ✓",
      color: samplesRemaining === 0 ? "text-green-400" : "text-muted-foreground",
      icon: Sparkles,
      iconColor: "text-yellow-400",
      bg: "bg-yellow-500/10",
    },
  ];

  return (
    <div className="rounded-xl border border-violet-500/15 bg-gradient-to-r from-violet-950/20 via-background to-background p-3">
      <div className="flex items-center gap-2 mb-2.5">
        <div className="p-1 rounded-md bg-violet-500/15">
          <Radio className="h-3.5 w-3.5 text-violet-400 animate-pulse" />
        </div>
        <span className="text-[11px] font-bold text-foreground/70 uppercase tracking-wider">IA Aprendendo 24h · Autônomo</span>
        <span className="text-[10px] text-muted-foreground/50 ml-auto">sem depender do Demo ativo</span>
      </div>
      {isLoading ? (
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
          {items.map(({ label, value, color, icon: Icon, iconColor, bg }) => (
            <div key={label} className="rounded-lg bg-muted/10 border border-border/20 px-2 py-1.5">
              <div className="flex items-center gap-1 mb-0.5">
                <div className={`p-0.5 rounded ${bg}`}>
                  <Icon className={`h-2.5 w-2.5 ${iconColor}`} />
                </div>
                <span className="text-[8px] text-muted-foreground/60 uppercase truncate">{label}</span>
              </div>
              <span className={`text-[10px] font-mono font-bold ${color}`}>{value}</span>
            </div>
          ))}
        </div>
      )}
      {!isLoading && samples < 300 && samplesPerHour > 0 && (
        <div className="mt-2 space-y-1">
          <div className="flex justify-between text-[9px] text-muted-foreground/50">
            <span>Progresso para treino Shadow ML</span>
            <span className="font-mono">{Math.min(100, Math.round((samples / 300) * 100))}%</span>
          </div>
          <Progress value={Math.min(100, (samples / 300) * 100)} className="h-1 bg-muted/20" />
        </div>
      )}
    </div>
  );
}

// ── BTC Commander (5m Movement Intelligence) ──────────────────────────────────

function BTCCommander() {
  const { data: cmdData, isLoading: cmdLoading } = useQuery({
    queryKey: ["neural-btc-commander"],
    queryFn: () => qbGet("/api/neural/sniper/btc-commander"),
    refetchInterval: 10_000,
  });

  const { data: macroData, isLoading: macroLoading } = useQuery({
    queryKey: ["neural-macro-regime"],
    queryFn: () => qbGet("/api/neural/market/macro-regime"),
    refetchInterval: 30_000,
  });

  const cmd = (cmdData as any) ?? {};
  const commander = cmd.commander ?? {};
  const features = cmd.features ?? {};
  const macro = (macroData as any) ?? {};

  const commanderClass: string = commander.classification ?? commander.class ?? "—";
  const momentum5m: number | null = features.momentum_5m ?? features.momentumPct ?? null;
  const volumeRatio: number | null = features.volume_ratio ?? features.volumeRatio ?? null;
  const oiChange: number | null = features.oi_change_pct ?? features.oiChangePct ?? null;
  const spread: number | null = features.spread_bps ?? null;
  const rsi: number | null = features.rsi ?? null;
  const fundingRate: number | null = features.funding_rate ?? features.fundingRate ?? null;
  const bias1h: string = macro.bias_1h ?? macro.hourBias ?? macro.h1Bias ?? "—";
  const bias4h: string = macro.bias_4h ?? macro.h4Bias ?? "—";
  const bias1d: string = macro.bias_1d ?? macro.dailyBias ?? "—";
  const correctionRisk: string = macro.correction_risk ?? macro.correctionRisk ?? "—";
  const candleRegime: string = macro.regime ?? macro.candleRegime ?? "—";

  const cmdColor =
    commanderClass.includes("UP") || commanderClass.includes("BULL") ? "text-green-400" :
    commanderClass.includes("DOWN") || commanderClass.includes("BEAR") ? "text-red-400" :
    "text-amber-400";

  const biasColor = (b: string) =>
    b === "BULL" || b === "UP" || b === "LONG" ? "text-green-400" :
    b === "BEAR" || b === "DOWN" || b === "SHORT" ? "text-red-400" :
    "text-amber-400";

  const isLoading = cmdLoading || macroLoading;

  return (
    <Card className="border border-blue-500/20 bg-gradient-to-br from-blue-950/30 via-background to-background">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-500/15">
              <Radar className="h-4 w-4 text-blue-400" />
            </div>
            <div>
              <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">BTC Commander</span>
              <span className="ml-2 text-[9px] text-muted-foreground/50">5m movement · edge de movimento</span>
            </div>
          </div>
          {!isLoading && (
            <span className={`text-[11px] font-mono font-bold ${cmdColor}`}>{commanderClass || "—"}</span>
          )}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Features 5m */}
            <div className="rounded-lg bg-muted/10 border border-border/20 p-2.5 space-y-1.5">
              <p className="text-[9px] text-blue-400/70 font-bold uppercase tracking-wider mb-1">Movimento 5m · BTC</p>
              {[
                { label: "Momentum", value: momentum5m != null ? `${momentum5m >= 0 ? "+" : ""}${momentum5m.toFixed(3)}%` : "—", color: momentum5m != null ? (momentum5m >= 0 ? "text-green-400" : "text-red-400") : "text-muted-foreground" },
                { label: "Volume Ratio", value: volumeRatio != null ? `${volumeRatio.toFixed(2)}x` : "—", color: (volumeRatio ?? 0) > 1.2 ? "text-green-400" : "text-muted-foreground" },
                { label: "OI Change", value: oiChange != null ? `${oiChange >= 0 ? "+" : ""}${oiChange.toFixed(2)}%` : "—", color: oiChange != null ? (oiChange >= 0 ? "text-green-400" : "text-red-400") : "text-muted-foreground" },
                { label: "RSI", value: rsi != null ? rsi.toFixed(1) : "—", color: rsi != null ? (rsi > 70 ? "text-red-400" : rsi < 30 ? "text-green-400" : "text-foreground/70") : "text-muted-foreground" },
                { label: "Funding", value: fundingRate != null ? `${(fundingRate * 100).toFixed(4)}%` : "—", color: "text-muted-foreground" },
                { label: "Spread", value: spread != null ? `${spread.toFixed(1)} bps` : "—", color: "text-muted-foreground" },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex justify-between items-center">
                  <span className="text-[9px] text-muted-foreground/60">{label}</span>
                  <span className={`text-[10px] font-mono font-bold ${color}`}>{value}</span>
                </div>
              ))}
            </div>

            {/* Macro Regime */}
            <div className="rounded-lg bg-muted/10 border border-border/20 p-2.5 space-y-1.5">
              <p className="text-[9px] text-amber-400/70 font-bold uppercase tracking-wider mb-1">Regime Macro · Candle IA</p>
              {[
                { label: "Bias 1H", value: bias1h, color: biasColor(bias1h) },
                { label: "Bias 4H", value: bias4h, color: biasColor(bias4h) },
                { label: "Bias 1D", value: bias1d, color: biasColor(bias1d) },
                { label: "Regime", value: candleRegime, color: "text-foreground/70" },
                { label: "Risco Correção", value: correctionRisk, color: correctionRisk === "HIGH" || correctionRisk === "CRITICAL" ? "text-red-400" : correctionRisk === "LOW" ? "text-green-400" : "text-amber-400" },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex justify-between items-center">
                  <span className="text-[9px] text-muted-foreground/60">{label}</span>
                  <span className={`text-[10px] font-mono font-bold ${color}`}>{value || "—"}</span>
                </div>
              ))}
              {/* Sync indicator */}
              <div className="flex items-center gap-1 pt-1 border-t border-border/15">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
                <span className="text-[8px] text-muted-foreground/40">Edge injetado em candles + indicadores</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Alertas Táticos ───────────────────────────────────────────────────────────

function TacticalAlerts() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-tactical-alerts"],
    queryFn: () => qbGet("/api/neural/tactical/alerts"),
    refetchInterval: 15_000,
  });

  const alerts: any[] = (data as any)?.alerts ?? [];
  const count: number = (data as any)?.count ?? 0;

  if (!isLoading && alerts.length === 0) return null;

  return (
    <Card className="border border-amber-500/20 bg-gradient-to-br from-amber-950/20 via-background to-background">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-amber-500/15">
            <AlertCircle className="h-4 w-4 text-amber-400" />
          </div>
          <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">Alertas Táticos</span>
          {count > 0 && (
            <Badge variant="outline" className="ml-auto text-[10px] bg-amber-500/10 text-amber-400 border-0">
              {count} ativo{count !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          <div className="space-y-1.5">
            {alerts.slice(0, 6).map((a, i) => {
              const sym = (a.symbol ?? "").replace("-USDT", "");
              const wr = a.win_rate_past ?? null;
              const ret = a.avg_return_past ?? null;
              const conf = a.confidence ?? null;
              return (
                <div key={i} className="flex items-start gap-2 rounded-lg border border-amber-500/10 bg-amber-500/5 px-3 py-2">
                  <Zap className="h-3 w-3 text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-mono font-bold text-foreground/80">{sym}</span>
                      <span className="text-[9px] text-amber-400/70 bg-amber-500/10 px-1 rounded">{a.alert_type ?? "—"}</span>
                      {conf != null && <span className="text-[9px] text-muted-foreground ml-auto">{(conf * 100).toFixed(0)}% conf</span>}
                    </div>
                    <p className="text-[10px] text-muted-foreground/70 truncate">{a.message ?? "—"}</p>
                  </div>
                  {(wr != null || ret != null) && (
                    <div className="text-right shrink-0">
                      {wr != null && <p className={`text-[10px] font-mono font-bold ${wr >= 0.6 ? "text-green-400" : wr >= 0.45 ? "text-amber-400" : "text-red-400"}`}>{(wr * 100).toFixed(0)}% WR</p>}
                      {ret != null && <p className={`text-[9px] font-mono ${ret >= 0 ? "text-green-400/70" : "text-red-400/70"}`}>{fmt(ret, 3)}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Regime Playbook (Market State) ────────────────────────────────────────────

function RegimePlaybook() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-regime-playbook"],
    queryFn: () => qbGet("/api/neural/regime-playbook/status"),
    refetchInterval: 30_000,
  });

  const d = (data as any) ?? {};
  const regimeCurrent: Record<string, number> = d.regimeCurrent ?? {};
  const activeBySymbol: Record<string, any> = d.activeBySymbol ?? {};
  const regimeEntries = Object.entries(regimeCurrent).sort((a, b) => b[1] - a[1]);
  const symbolEntries = Object.entries(activeBySymbol).slice(0, 8);

  if (!isLoading && regimeEntries.length === 0) return null;

  const regimeColor = (r: string) =>
    r === "TRENDING" || r === "MOMENTUM" ? "text-green-400 bg-green-500/10" :
    r === "RANGING" ? "text-amber-400 bg-amber-500/10" :
    r === "LOW_LIQUIDITY" || r === "AVOID" ? "text-red-400 bg-red-500/10" :
    "text-muted-foreground bg-muted/10";

  const playbookShort = (p: string) =>
    p?.replace("_SCALP", "").replace("_MODE", "").replace("_CONTINUATION", "").replace("MOMENTUM_BREAKOUT", "BREAKOUT") ?? "—";

  return (
    <Card className="border border-border/30 bg-background/60">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-500/15">
            <Triangle className="h-4 w-4 text-cyan-400" />
          </div>
          <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">Regime Playbook</span>
          <span className="text-[10px] text-muted-foreground ml-auto">estado de mercado agora</span>
        </div>

        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
        ) : (
          <>
            {/* Regime summary */}
            <div className="flex flex-wrap gap-2">
              {regimeEntries.map(([regime, count]) => (
                <div key={regime} className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono font-bold ${regimeColor(regime)}`}>
                  {regime.replace("_", " ")} <span className="opacity-60">×{count}</span>
                </div>
              ))}
            </div>
            {/* Per-symbol playbook */}
            <div className="grid grid-cols-2 gap-1">
              {symbolEntries.map(([sym, info]) => {
                const s = sym.replace("-USDT", "");
                const playbook: string = info?.playbook ?? "—";
                const regime: string = info?.regime ?? "—";
                return (
                  <div key={sym} className="flex items-center justify-between rounded px-2 py-1 bg-muted/10 text-[10px]">
                    <span className="font-mono font-bold text-foreground/70 w-10">{s}</span>
                    <span className={`text-[9px] px-1 rounded ${regimeColor(regime)}`}>{regime.slice(0, 8)}</span>
                    <span className="text-[9px] text-muted-foreground/50 truncate max-w-[70px]">{playbookShort(playbook)}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Shadow ML + Win Rate consolidado ──────────────────────────────────────────

function ShadowMLAndWinRate() {
  const { data: shadowData, isLoading: shadowLoading } = useQuery({
    queryKey: ["neural-shadow-status"],
    queryFn: () => qbGet("/api/neural/models/sniper/status"),
    refetchInterval: 60_000,
  });

  const { data: kbData, isLoading: kbLoading } = useQuery({
    queryKey: ["neural-kb-stats"],
    queryFn: () => qbGet("/api/neural/kb/stats"),
    refetchInterval: 60_000,
  });

  const { data: cfgData } = useQuery({
    queryKey: ["bot-config-symbols"],
    queryFn: () => fetch(apiUrl("/api/bot/config"), { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const status = (shadowData as any) ?? {};
  const available = status.available ?? status.trained ?? false;
  const samples = status.samples ?? status.n_samples ?? 0;
  const brier = status.modelBrier ?? status.brier ?? null;
  const baselineBrier = status.baselineBrier ?? 0.25;
  const lastTrain = status.trained_at ?? status.trainedAt ?? null;
  const topFeatures: string[] = status.topFeatures ?? [];
  const improves = brier != null && brier < baselineBrier;
  const brierPct = brier != null ? Math.round((1 - brier / 0.25) * 100) : 0;

  const rawAllowed: string[] = (cfgData as any)?.allowedSymbols ?? [];
  const allowedSymbols: string[] =
    rawAllowed.length > 0
      ? rawAllowed.map((s) => s.replace("-USDT", "").replace("USDT", ""))
      : [];

  // KB stats: QB returns {period_days, symbols: [...]} or plain array
  const rawStats = kbData as any;
  const stats: any[] = Array.isArray(rawStats)
    ? rawStats
    : Array.isArray(rawStats?.symbols)
    ? rawStats.symbols
    : [];

  const rows = allowedSymbols
    .map((sym) => {
      const entry = stats.find(
        (s: any) =>
          (s.symbol ?? "").replace("-USDT", "").replace("USDT", "") === sym
      );
      const long = entry?.sides?.LONG ?? entry?.sides?.long ?? {};
      const short = entry?.sides?.SHORT ?? entry?.sides?.short ?? {};
      return {
        sym,
        longWR: long.win_rate ?? null,
        longTrades: long.trades ?? 0,
        shortWR: short.win_rate ?? null,
        shortTrades: short.trades ?? 0,
        totalTrades: (long.trades ?? 0) + (short.trades ?? 0),
      };
    })
    .sort((a, b) => b.totalTrades - a.totalTrades);

  return (
    <Card className="border border-violet-500/20 bg-gradient-to-br from-violet-950/30 via-background to-background shadow-lg shadow-violet-900/10">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-violet-500/15">
              <Brain className="h-4 w-4 text-violet-400" />
            </div>
            <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">Shadow ML</span>
          </div>
          <Badge
            variant="outline"
            className={`text-[10px] font-mono border-0 px-2 ${available ? "bg-green-500/15 text-green-400" : "bg-amber-500/15 text-amber-400"}`}
          >
            {available ? "TREINADO" : "PENDENTE"}
          </Badge>
        </div>

        {shadowLoading ? (
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-muted/20 p-2.5">
              <p className="text-[9px] text-muted-foreground mb-0.5">Amostras</p>
              <p className="text-base font-mono font-bold text-foreground">{samples.toLocaleString()}</p>
              <p className="text-[9px] text-muted-foreground">mín. 300</p>
            </div>
            <div className="rounded-lg bg-muted/20 p-2.5">
              <p className="text-[9px] text-muted-foreground mb-0.5">Brier Score</p>
              <p className={`text-base font-mono font-bold ${brier != null ? (improves ? "text-green-400" : "text-amber-400") : "text-muted-foreground"}`}>
                {brier != null ? brier.toFixed(4) : "—"}
              </p>
              <p className="text-[9px] text-muted-foreground">ref. = 0.25</p>
            </div>
            <div className="rounded-lg bg-muted/20 p-2.5">
              <p className="text-[9px] text-muted-foreground mb-0.5">Melhoria</p>
              <p className={`text-base font-mono font-bold ${improves ? "text-green-400" : "text-muted-foreground"}`}>
                {brier != null ? (improves ? `+${brierPct}%` : "~0%") : "—"}
              </p>
              <p className="text-[9px] text-muted-foreground">{timeAgo(lastTrain)} atrás</p>
            </div>
          </div>
        )}

        {brier != null && (
          <Progress value={Math.max(0, Math.min(100, brierPct))} className="h-1 bg-muted/30" />
        )}

        {topFeatures.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {topFeatures.slice(0, 6).map((f) => (
              <span key={f} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300/70 border border-violet-500/15">
                {f}
              </span>
            ))}
          </div>
        )}

        {/* Divider */}
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-border/20" />
          <div className="flex items-center gap-1.5">
            <BarChart2 className="h-3 w-3 text-blue-400" />
            <span className="text-[10px] font-bold text-foreground/60 uppercase tracking-wider">Win Rate por Símbolo</span>
            <span className="text-[9px] text-muted-foreground/50">
              {allowedSymbols.length > 0
                ? `${allowedSymbols.length} ativos · SCALP_SYMBOLS`
                : "aguardando config"}
            </span>
          </div>
          <div className="h-px flex-1 bg-border/20" />
        </div>

        {kbLoading || !cfgData ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : allowedSymbols.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground">
            <p className="text-[11px]">SCALP_SYMBOLS não configurado</p>
            <p className="text-[10px] mt-1 opacity-60">Defina a variável de ambiente SCALP_SYMBOLS</p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map(({ sym, longWR, longTrades, shortWR, shortTrades }) => (
              <div key={sym} className="grid grid-cols-[52px_1fr_1fr] gap-2 items-center">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-mono font-bold text-foreground/80">{sym}</span>
                  {available && (longTrades + shortTrades) > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400/60 shrink-0" title="Shadow ML ativo" />
                  )}
                </div>
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[9px]">
                    <span className="text-green-400/70">LONG</span>
                    <span className={`font-mono ${longWR != null ? wrColor(longWR) : "text-muted-foreground"}`}>
                      {longWR != null ? `${longWR.toFixed(0)}%` : "—"} <span className="text-muted-foreground">({longTrades})</span>
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${longWR != null ? wrBarColor(longWR) : "bg-muted/20"}`} style={{ width: `${longWR ?? 0}%` }} />
                  </div>
                </div>
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[9px]">
                    <span className="text-red-400/70">SHORT</span>
                    <span className={`font-mono ${shortWR != null ? wrColor(shortWR) : "text-muted-foreground"}`}>
                      {shortWR != null ? `${shortWR.toFixed(0)}%` : "—"} <span className="text-muted-foreground">({shortTrades})</span>
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${shortWR != null ? wrBarColor(shortWR) : "bg-muted/20"}`} style={{ width: `${shortWR ?? 0}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Edge Evolution ─────────────────────────────────────────────────────────────

function EdgeEvolution() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-edge-evolution"],
    queryFn: () => qbGet("/api/neural/strategic/edge-evolution"),
    refetchInterval: 120_000,
  });

  const evolutions: any[] = (data as any)?.evolutions ?? [];
  const improving = evolutions.filter((e) => e.trend === "IMPROVING" || e.delta_wr > 0);
  const deteriorating = evolutions.filter((e) => e.trend === "DETERIORATING" || e.delta_wr < -5);

  if (isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (!evolutions.length) return null;

  return (
    <Card className="border border-border/30 bg-background/60">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 rounded-lg bg-amber-500/15">
            <Activity className="h-4 w-4 text-amber-400" />
          </div>
          <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">Evolução de Edge</span>
          <span className="text-[10px] text-muted-foreground ml-auto">30 dias · 1ª vs 2ª metade</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-green-400 font-bold mb-2 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Melhorando ({improving.length})
            </p>
            <div className="space-y-1">
              {improving.length === 0 && <p className="text-[10px] text-muted-foreground">Sem dados suficientes</p>}
              {improving.slice(0, 5).map((e) => (
                <div key={`${e.symbol}-${e.side}`} className="flex items-center justify-between text-[10px] bg-green-500/5 rounded px-2 py-1">
                  <span className="font-mono font-bold">{e.symbol?.replace("-USDT", "")} <span className="text-green-400/70">{e.side}</span></span>
                  <span className="font-mono text-green-400">{e.wr_early?.toFixed(0)}% → {e.wr_late?.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] text-red-400 font-bold mb-2 flex items-center gap-1">
              <TrendingDown className="h-3 w-3" /> Deteriorando ({deteriorating.length})
            </p>
            <div className="space-y-1">
              {deteriorating.length === 0 && <p className="text-[10px] text-muted-foreground">Nenhum detectado</p>}
              {deteriorating.slice(0, 5).map((e) => (
                <div key={`${e.symbol}-${e.side}`} className="flex items-center justify-between text-[10px] bg-red-500/5 rounded px-2 py-1">
                  <span className="font-mono font-bold">{e.symbol?.replace("-USDT", "")} <span className="text-red-400/70">{e.side}</span></span>
                  <span className="font-mono text-red-400">{e.wr_early?.toFixed(0)}% → {e.wr_late?.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Top Patterns ───────────────────────────────────────────────────────────────

function TopPatterns() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-kb-patterns"],
    queryFn: () => qbGet("/api/neural/kb/patterns"),
    refetchInterval: 120_000,
  });

  const rawPatterns = data as any;
  const patterns: any[] = Array.isArray(rawPatterns)
    ? rawPatterns
    : Array.isArray(rawPatterns?.patterns)
    ? rawPatterns.patterns
    : [];
  const sorted = [...patterns].sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0));

  return (
    <Card className="border border-border/30 bg-background/60">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 rounded-lg bg-cyan-500/15">
            <Layers className="h-4 w-4 text-cyan-400" />
          </div>
          <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">Padrões Acumulados</span>
          <Badge variant="outline" className="ml-auto text-[10px] bg-cyan-500/10 text-cyan-400 border-0">
            {patterns.length} padrões
          </Badge>
        </div>

        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
        ) : patterns.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Database className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-[12px]">Sem padrões acumulados ainda</p>
            <p className="text-[11px] mt-1 opacity-70">Feche mais trades no Demo para popular</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border/20">
                  <th className="text-left text-muted-foreground font-medium py-1.5 pr-3">Padrão</th>
                  <th className="text-left text-muted-foreground font-medium py-1.5 pr-3">Símbolo</th>
                  <th className="text-right text-muted-foreground font-medium py-1.5 pr-3">Ocorr.</th>
                  <th className="text-right text-muted-foreground font-medium py-1.5 pr-3">WR%</th>
                  <th className="text-right text-muted-foreground font-medium py-1.5">Ret. médio</th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 15).map((p, i) => {
                  const wr = (p.win_rate ?? 0) * 100;
                  return (
                    <tr key={i} className="border-b border-border/10 hover:bg-muted/10 transition-colors">
                      <td className="py-1.5 pr-3 font-mono text-foreground/80 max-w-[140px] truncate">{p.name ?? "—"}</td>
                      <td className="py-1.5 pr-3 font-mono font-bold text-foreground/70">
                        {(p.symbol ?? "").replace("-USDT", "")}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono">{p.occurrences ?? 0}</td>
                      <td className={`py-1.5 pr-3 text-right font-mono font-bold ${wrColor(wr)}`}>
                        {pct(wr, 0)}
                      </td>
                      <td className={`py-1.5 text-right font-mono ${(p.avg_return ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {fmt(p.avg_return)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Recent Outcomes ────────────────────────────────────────────────────────────

function RecentOutcomes() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-trades-recent"],
    queryFn: () => qbGet("/api/neural/kb/trades/recent?limit=20"),
    refetchInterval: 30_000,
  });

  const trades: any[] = Array.isArray(data) ? data : ((data as any)?.trades ?? []);

  return (
    <Card className="border border-border/30 bg-background/60">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 rounded-lg bg-emerald-500/15">
            <Zap className="h-4 w-4 text-emerald-400" />
          </div>
          <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">Outcomes Recentes</span>
          <span className="text-[10px] text-muted-foreground ml-auto">alimentando aprendizado</span>
        </div>

        {isLoading ? (
          <div className="space-y-1.5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
        ) : trades.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-[12px]">Sem trades registrados ainda</p>
            <p className="text-[11px] mt-1 opacity-70">Opere no Demo Lab para gerar dados</p>
          </div>
        ) : (
          <div className="space-y-1">
            {trades.map((t, i) => {
              const win = t.win ?? (t.pnl_pct ?? 0) > 0;
              const pnlPct = t.pnl_pct ?? t.pnl ?? 0;
              const pnlUsdt = t.pnl_usdt ?? t.realized_pnl ?? null;
              const sym = (t.symbol ?? "").replace("-USDT", "");
              const side = t.side ?? t.positionSide ?? "?";
              const ts = t.recorded_at ?? t.closed_at ?? t.created_at ?? null;
              return (
                <div key={i} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] border ${win ? "border-green-500/15 bg-green-500/5" : "border-red-500/15 bg-red-500/5"}`}>
                  {win
                    ? <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
                    : <AlertCircle className="h-3 w-3 text-red-400 shrink-0" />
                  }
                  <span className="font-mono font-bold text-foreground/80 w-14">{sym}</span>
                  <span className={`text-[10px] px-1 rounded font-mono ${side === "LONG" ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"}`}>{side}</span>
                  <span className={`font-mono ml-auto font-bold ${win ? "text-green-400" : "text-red-400"}`}>
                    {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                  </span>
                  {pnlUsdt != null && (
                    <span className={`font-mono text-[10px] ${win ? "text-green-400/70" : "text-red-400/70"}`}>
                      {pnlUsdt >= 0 ? "+" : ""}{Number(pnlUsdt).toFixed(2)}$
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground">{timeAgo(ts)}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Learning Metrics ───────────────────────────────────────────────────────────

function LearningMetrics() {
  const { data } = useQuery({
    queryKey: ["neural-metrics"],
    queryFn: () => qbGet("/api/neural/metrics/learning"),
    refetchInterval: 60_000,
  });

  const d = (data as any) ?? {};
  const totalTrades = d.total_trades ?? d.totalTrades ?? 0;
  const totalWins = d.total_wins ?? d.totalWins ?? 0;
  const avgScore = d.avg_score ?? d.avgScore ?? null;
  const buckets: any[] = d.score_buckets ?? d.scoreBuckets ?? [];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        {
          label: "Total Trades",
          value: totalTrades.toLocaleString(),
          sub: "no KB",
          icon: Database,
          color: "text-blue-400",
          bg: "bg-blue-500/10",
        },
        {
          label: "Wins",
          value: totalTrades > 0 ? `${totalWins} (${((totalWins / totalTrades) * 100).toFixed(0)}%)` : "—",
          sub: "trades vencedores",
          icon: CheckCircle2,
          color: "text-green-400",
          bg: "bg-green-500/10",
        },
        {
          label: "Score Médio QB",
          value: avgScore != null ? avgScore.toFixed(3) : "—",
          sub: "0=ruim 1=ótimo",
          icon: Cpu,
          color: "text-violet-400",
          bg: "bg-violet-500/10",
        },
        {
          label: "Score Buckets",
          value: buckets.length > 0 ? `${buckets.length} faixas` : "—",
          sub: "estratificação",
          icon: Sparkles,
          color: "text-cyan-400",
          bg: "bg-cyan-500/10",
        },
      ].map(({ label, value, sub, icon: Icon, color, bg }) => (
        <Card key={label} className="border border-border/25 bg-background/50">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <div className={`p-1 rounded-md ${bg}`}>
                <Icon className={`h-3.5 w-3.5 ${color}`} />
              </div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
            </div>
            <p className={`text-xl font-mono font-bold ${color}`}>{value}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function NeuralPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <AppShell>
      <div className="flex flex-col gap-5 p-4 md:p-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-violet-500/20 to-blue-500/10 border border-violet-500/20">
              <Brain className="h-5 w-5 text-violet-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-foreground">Neural Engine</h1>
              <p className="text-[11px] text-muted-foreground">aprendizado autônomo · 24h · edge acumulado em candles</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <QBStatus />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px] border-border/40"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Atualizar
            </Button>
          </div>
        </div>

        {/* IA 24h Status — learning pipeline em tempo real */}
        <IALearningStatus key={`ia-${refreshKey}`} />

        {/* BTC Commander + Tactical Alerts */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
          <BTCCommander key={`btc-${refreshKey}`} />
          <TacticalAlerts key={`alerts-${refreshKey}`} />
        </div>

        {/* Regime Playbook */}
        <RegimePlaybook key={`regime-${refreshKey}`} />

        {/* Learning Metrics */}
        <LearningMetrics key={`metrics-${refreshKey}`} />

        {/* Shadow ML + Win Rate consolidado */}
        <ShadowMLAndWinRate key={`shadow-wr-${refreshKey}`} />

        {/* Edge Evolution */}
        <EdgeEvolution key={`edge-${refreshKey}`} />

        {/* Patterns + Outcomes side-by-side */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <TopPatterns key={`patterns-${refreshKey}`} />
          <RecentOutcomes key={`outcomes-${refreshKey}`} />
        </div>
      </div>
    </AppShell>
  );
}
