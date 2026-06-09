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

const SYMBOLS = ["BTC", "ETH", "SOL", "VVV", "TRUMP", "MELANIA", "BEAT", "NEAR", "HYPE", "POL"];

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
  if (secs < 60) return `${secs}s atrás`;
  if (secs < 3600) return `${Math.floor(secs / 60)}min atrás`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h atrás`;
  return `${Math.floor(secs / 86400)}d atrás`;
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

// ── QB online badge ───────────────────────────────────────────────────────────

function QBStatus() {
  const { data, isError } = useQuery({
    queryKey: ["neural-health"],
    queryFn: () => qbGet("/api/neural/health"),
    refetchInterval: 30_000,
    retry: 1,
  });
  const online = !isError && data;
  return (
    <div className={`flex items-center gap-1.5 text-[11px] font-mono ${online ? "text-green-400" : "text-red-400"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-green-400 animate-pulse" : "bg-red-500"}`} />
      {online ? "QUANT BRAIN ONLINE" : "QB OFFLINE"}
    </div>
  );
}

// ── Shadow ML card ────────────────────────────────────────────────────────────

function ShadowMLCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-shadow-status"],
    queryFn: () => qbGet("/api/neural/models/sniper/status"),
    refetchInterval: 60_000,
  });

  const status = (data as any) ?? {};
  const available = status.available ?? status.trained ?? false;
  const samples = status.samples ?? status.n_samples ?? 0;
  const brier = status.modelBrier ?? status.brier ?? null;
  const baselineBrier = status.baselineBrier ?? 0.25;
  const lastTrain = status.trained_at ?? status.trainedAt ?? null;
  const topFeatures: string[] = status.topFeatures ?? [];
  const improves = brier != null && brier < baselineBrier;

  const brierPct = brier != null ? Math.round((1 - brier / 0.25) * 100) : 0;

  return (
    <Card className="border border-violet-500/20 bg-gradient-to-br from-violet-950/40 via-background to-background shadow-lg shadow-violet-900/10">
      <CardContent className="p-4 space-y-3">
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

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted/20 p-2.5">
                <p className="text-[10px] text-muted-foreground mb-0.5">Amostras</p>
                <p className="text-lg font-mono font-bold text-foreground">{samples.toLocaleString()}</p>
                <p className="text-[9px] text-muted-foreground">mín. 300 p/ treinar</p>
              </div>
              <div className="rounded-lg bg-muted/20 p-2.5">
                <p className="text-[10px] text-muted-foreground mb-0.5">Brier Score</p>
                <p className={`text-lg font-mono font-bold ${brier != null ? (improves ? "text-green-400" : "text-amber-400") : "text-muted-foreground"}`}>
                  {brier != null ? brier.toFixed(4) : "—"}
                </p>
                <p className="text-[9px] text-muted-foreground">ref. aleat. = 0.25</p>
              </div>
            </div>

            {brier != null && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px]">
                  <span className="text-muted-foreground">Melhoria vs aleatório</span>
                  <span className={improves ? "text-green-400 font-mono" : "text-amber-400 font-mono"}>
                    {improves ? `+${brierPct}%` : "~0%"}
                  </span>
                </div>
                <Progress value={Math.max(0, Math.min(100, brierPct))} className="h-1.5 bg-muted/30" />
              </div>
            )}

            {topFeatures.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Top features</p>
                {topFeatures.slice(0, 5).map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm bg-violet-500/40 shrink-0" />
                    <span className="text-[10px] font-mono text-foreground/70 truncate">{f}</span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[10px] text-muted-foreground">
              Último treino: <span className="text-foreground/60 font-mono">{timeAgo(lastTrain)}</span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Win Rate matrix ───────────────────────────────────────────────────────────

function WinRateMatrix() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-kb-stats"],
    queryFn: () => qbGet("/api/neural/kb/stats"),
    refetchInterval: 60_000,
  });

  const stats: any[] = Array.isArray(data) ? data : [];

  const rows = SYMBOLS.map((sym) => {
    const entry = stats.find((s: any) => (s.symbol ?? "").replace("-USDT", "") === sym);
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
  }).sort((a, b) => b.totalTrades - a.totalTrades);

  return (
    <Card className="border border-border/30 bg-background/60">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-1.5 rounded-lg bg-blue-500/15">
            <BarChart2 className="h-4 w-4 text-blue-400" />
          </div>
          <span className="text-[12px] font-bold text-foreground/80 uppercase tracking-wider">Win Rate por Símbolo</span>
          <span className="text-[10px] text-muted-foreground ml-auto">últimos 30 dias</span>
        </div>

        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : (
          <div className="space-y-2">
            {rows.map(({ sym, longWR, longTrades, shortWR, shortTrades }) => (
              <div key={sym} className="grid grid-cols-[56px_1fr_1fr] gap-2 items-center">
                <span className="text-[11px] font-mono font-bold text-foreground/80">{sym}</span>
                {/* LONG */}
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[9px]">
                    <span className="text-green-400/70">LONG</span>
                    <span className={`font-mono ${longWR != null ? wrColor(longWR) : "text-muted-foreground"}`}>
                      {longWR != null ? `${longWR.toFixed(0)}%` : "—"} <span className="text-muted-foreground">({longTrades})</span>
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${longWR != null ? wrBarColor(longWR) : "bg-muted/20"}`}
                      style={{ width: `${longWR ?? 0}%` }}
                    />
                  </div>
                </div>
                {/* SHORT */}
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[9px]">
                    <span className="text-red-400/70">SHORT</span>
                    <span className={`font-mono ${shortWR != null ? wrColor(shortWR) : "text-muted-foreground"}`}>
                      {shortWR != null ? `${shortWR.toFixed(0)}%` : "—"} <span className="text-muted-foreground">({shortTrades})</span>
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${shortWR != null ? wrBarColor(shortWR) : "bg-muted/20"}`}
                      style={{ width: `${shortWR ?? 0}%` }}
                    />
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

// ── Edge Evolution ────────────────────────────────────────────────────────────

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

// ── Top Patterns ──────────────────────────────────────────────────────────────

function TopPatterns() {
  const { data, isLoading } = useQuery({
    queryKey: ["neural-kb-patterns"],
    queryFn: () => qbGet("/api/neural/kb/patterns"),
    refetchInterval: 120_000,
  });

  const patterns: any[] = Array.isArray(data) ? data : ((data as any)?.patterns ?? []);
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

// ── Recent Outcomes ───────────────────────────────────────────────────────────

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

// ── Learning Metrics ──────────────────────────────────────────────────────────

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
          sub: "no QB",
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

// ── Page ──────────────────────────────────────────────────────────────────────

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
              <p className="text-[11px] text-muted-foreground">aprendizado autônomo · sem IA externa</p>
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

        {/* How it learns banner */}
        <div className="rounded-xl border border-violet-500/20 bg-gradient-to-r from-violet-950/30 via-background to-background p-3 flex flex-wrap gap-4">
          {[
            { step: "1", text: "Trade fecha no Demo", color: "text-violet-400 bg-violet-500/15" },
            { step: "2", text: "PnL + features → QB", color: "text-blue-400 bg-blue-500/15" },
            { step: "3", text: "Knowledge Base grava padrão", color: "text-cyan-400 bg-cyan-500/15" },
            { step: "4", text: "Shadow ML retreina", color: "text-emerald-400 bg-emerald-500/15" },
            { step: "5", text: "Próxima entrada mais precisa", color: "text-green-400 bg-green-500/15" },
          ].map(({ step, text, color }) => (
            <div key={step} className="flex items-center gap-2">
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${color}`}>{step}</span>
              <span className="text-[11px] text-foreground/70">{text}</span>
            </div>
          ))}
        </div>

        {/* Learning Metrics */}
        <LearningMetrics key={`metrics-${refreshKey}`} />

        {/* Shadow ML + Win Rate side-by-side */}
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
          <ShadowMLCard key={`shadow-${refreshKey}`} />
          <WinRateMatrix key={`wr-${refreshKey}`} />
        </div>

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
