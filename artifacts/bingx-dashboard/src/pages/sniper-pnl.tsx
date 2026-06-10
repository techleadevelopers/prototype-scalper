import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Target,
  TrendingUp,
  TrendingDown,
  Zap,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  BarChart2,
  DollarSign,
  Percent,
  AlertTriangle,
  Play,
  Pause,
} from "lucide-react";
import AppShell from "@/components/app-shell";
import { apiUrl } from "@/lib/api-url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type AnyRecord = Record<string, any>;

function useSniperPnlReport(enabled = true) {
  return useQuery({
    queryKey: ["sniper-pnl-report"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/sniper/pnl/report"), { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<AnyRecord>;
    },
    refetchInterval: 15_000,
    enabled,
  });
}

function MetricCard({
  label,
  value,
  sub,
  icon: Icon,
  positive,
  neutral,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  positive?: boolean;
  neutral?: boolean;
}) {
  const color = neutral
    ? "text-slate-300"
    : positive === true
    ? "text-emerald-400"
    : positive === false
    ? "text-red-400"
    : "text-slate-300";

  return (
    <Card className="bg-slate-900 border-slate-700">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-slate-800">
            <Icon className="w-4 h-4 text-slate-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
            {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TriggerBar({
  filled,
  expired,
  cancelled,
  pending,
  total,
}: {
  filled: number;
  expired: number;
  cancelled: number;
  pending: number;
  total: number;
}) {
  if (total === 0) return <div className="h-3 rounded-full bg-slate-800 w-full" />;
  const filledPct = (filled / total) * 100;
  const expiredPct = (expired / total) * 100;
  const cancelledPct = (cancelled / total) * 100;
  const pendingPct = (pending / total) * 100;
  return (
    <div className="h-3 rounded-full overflow-hidden flex w-full">
      <div style={{ width: `${filledPct}%` }} className="bg-emerald-500" title={`Filled: ${filled}`} />
      <div style={{ width: `${expiredPct}%` }} className="bg-amber-500" title={`Expired: ${expired}`} />
      <div style={{ width: `${cancelledPct}%` }} className="bg-red-500" title={`Cancelled: ${cancelled}`} />
      <div style={{ width: `${pendingPct}%` }} className="bg-slate-600" title={`Pending: ${pending}`} />
    </div>
  );
}

function fmt(n: number, decimals = 2) {
  return n.toFixed(decimals);
}

function pnlColor(v: number) {
  return v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-slate-400";
}

export default function SniperPnlPage() {
  const { data, isLoading, refetch, dataUpdatedAt } = useSniperPnlReport();

  const live = data?.live as AnyRecord | undefined;
  const trigger = data?.triggerGeometry as AnyRecord | undefined;
  const bySymbol = (data?.bySymbol as AnyRecord[] | undefined) ?? [];
  const pilot = data?.autopilot as AnyRecord | undefined;
  const demo = data?.demo as AnyRecord | undefined;

  const updatedAt = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null;

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
              <DollarSign className="w-6 h-6 text-emerald-400" />
              Sniper P&L Real
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Lucratividade real do sistema ARM_TRIGGER — fill rate, Kelly efficiency e breakdown por ativo
            </p>
          </div>
          <div className="flex items-center gap-3">
            {updatedAt && (
              <span className="text-xs text-slate-500">Atualizado {updatedAt}</span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="border-slate-700 hover:border-slate-500"
              onClick={() => refetch()}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              Atualizar
            </Button>
          </div>
        </div>

        {/* Autopilot Status Bar */}
        {pilot && (
          <Card className="bg-slate-900 border-slate-700">
            <CardContent className="py-3 px-5">
              <div className="flex items-center gap-6 flex-wrap">
                <div className="flex items-center gap-2">
                  {pilot.running ? (
                    <Play className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Pause className="w-4 h-4 text-slate-500" />
                  )}
                  <span className={`text-sm font-semibold ${pilot.running ? "text-emerald-400" : "text-slate-500"}`}>
                    Autopilot {pilot.running ? "ATIVO" : "PARADO"}
                  </span>
                </div>
                {pilot.running && pilot.uptimeSec > 0 && (
                  <span className="text-xs text-slate-400">
                    Uptime: {Math.floor(pilot.uptimeSec / 60)}m {pilot.uptimeSec % 60}s
                  </span>
                )}
                <span className="text-xs text-slate-400">Ciclos: <b className="text-slate-200">{pilot.totalCycles}</b></span>
                <span className="text-xs text-slate-400">Ordens: <b className="text-slate-200">{pilot.totalPlaced}</b></span>
                {pilot.sessionLossUsd > 0 && (
                  <span className="text-xs text-red-400">Loss sessão: <b>-${fmt(pilot.sessionLossUsd)}</b></span>
                )}
                {pilot.stopReason && (
                  <Badge variant="destructive" className="text-xs">{pilot.stopReason}</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Live P&L Metrics Grid */}
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4" /> Live P&L
          </h2>
          {isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 bg-slate-800" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                label="P&L Líquido"
                value={`${(live?.netPnlUsdt ?? 0) >= 0 ? "+" : ""}$${fmt(live?.netPnlUsdt ?? 0)}`}
                icon={DollarSign}
                positive={(live?.netPnlUsdt ?? 0) > 0}
                sub={`${live?.totalTrades ?? 0} trades live`}
              />
              <MetricCard
                label="Win Rate"
                value={`${fmt(live?.winRate ?? 0)}%`}
                icon={Percent}
                positive={(live?.winRate ?? 0) > 50}
                sub={`${live?.wins ?? 0}W / ${live?.losses ?? 0}L`}
              />
              <MetricCard
                label="Profit Factor"
                value={fmt(live?.profitFactor ?? 0)}
                icon={BarChart2}
                positive={(live?.profitFactor ?? 0) >= 1.5}
                neutral={(live?.profitFactor ?? 0) === 0}
                sub={(live?.profitFactor ?? 0) >= 1.5 ? "Saudável" : (live?.profitFactor ?? 0) >= 1 ? "Marginal" : "Abaixo do breakeven"}
              />
              <MetricCard
                label="Avg P&L / Trade"
                value={`${(live?.avgPnlUsdt ?? 0) >= 0 ? "+" : ""}$${fmt(live?.avgPnlUsdt ?? 0)}`}
                icon={TrendingUp}
                positive={(live?.avgPnlUsdt ?? 0) > 0}
                sub={`Avg win $${fmt(live?.avgWinUsdt ?? 0)} / avg loss $${fmt(live?.avgLossUsdt ?? 0)}`}
              />
              <MetricCard
                label="Gross Win"
                value={`+$${fmt(live?.grossWinUsdt ?? 0)}`}
                icon={TrendingUp}
                positive
              />
              <MetricCard
                label="Gross Loss"
                value={`-$${fmt(live?.grossLossUsdt ?? 0)}`}
                icon={TrendingDown}
                positive={false}
              />
              <MetricCard
                label="Demo P&L"
                value={`${(demo?.netPnlUsdt ?? 0) >= 0 ? "+" : ""}$${fmt(demo?.netPnlUsdt ?? 0)}`}
                icon={Activity}
                positive={(demo?.netPnlUsdt ?? 0) > 0}
                neutral={(demo?.totalTrades ?? 0) === 0}
                sub={`${demo?.totalTrades ?? 0} trades VST`}
              />
              <MetricCard
                label="Demo Win Rate"
                value={`${fmt(demo?.winRate ?? 0)}%`}
                icon={Percent}
                positive={(demo?.winRate ?? 0) > 50}
                neutral={(demo?.totalTrades ?? 0) === 0}
              />
            </div>
          )}
        </div>

        {/* Trigger Geometry Fill Rate */}
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Target className="w-4 h-4" /> Geometria ARM_TRIGGER — Fill Rate
          </h2>
          <Card className="bg-slate-900 border-slate-700">
            <CardContent className="pt-5 pb-5 space-y-4">
              {isLoading ? (
                <Skeleton className="h-20 bg-slate-800" />
              ) : !trigger || trigger.totalArmed === 0 ? (
                <p className="text-sm text-slate-500 italic">
                  Nenhum gatilho ARM_TRIGGER registrado nesta sessão. Ative o autopilot no modo enforce para ver dados aqui.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-8 flex-wrap">
                    <div className="text-center">
                      <p className="text-2xl font-bold text-emerald-400 font-mono">
                        {fmt(trigger.fillRatePct)}%
                      </p>
                      <p className="text-xs text-slate-500">Fill Rate</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-amber-400 font-mono">
                        {fmt(trigger.expiryRatePct)}%
                      </p>
                      <p className="text-xs text-slate-500">Expiry Rate</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-slate-200 font-mono">{trigger.totalArmed}</p>
                      <p className="text-xs text-slate-500">Total Armados</p>
                    </div>
                    <div className="flex gap-4 items-center">
                      <span className="flex items-center gap-1 text-xs text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" /> {trigger.presumedFilled} filled
                      </span>
                      <span className="flex items-center gap-1 text-xs text-amber-400">
                        <Clock className="w-3.5 h-3.5" /> {trigger.expired} expired
                      </span>
                      <span className="flex items-center gap-1 text-xs text-red-400">
                        <XCircle className="w-3.5 h-3.5" /> {trigger.cancelled} cancelled
                      </span>
                      <span className="flex items-center gap-1 text-xs text-slate-400">
                        <Activity className="w-3.5 h-3.5" /> {trigger.pending} pending
                      </span>
                    </div>
                  </div>
                  <TriggerBar
                    filled={trigger.presumedFilled}
                    expired={trigger.expired}
                    cancelled={trigger.cancelled}
                    pending={trigger.pending}
                    total={trigger.totalArmed}
                  />
                  <div className="flex gap-4 text-xs text-slate-500">
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> Filled</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" /> Expirado (TTL)</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" /> Cancelado</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-slate-600 inline-block" /> Pendente</span>
                  </div>
                  {/* Recent trigger activity */}
                  {trigger.recentActivity?.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-slate-500 mb-2">Atividade recente</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-slate-500 border-b border-slate-800">
                              <th className="text-left pb-1 pr-3">Símbolo</th>
                              <th className="text-left pb-1 pr-3">Dir</th>
                              <th className="text-left pb-1 pr-3">Trigger $</th>
                              <th className="text-left pb-1 pr-3">Status</th>
                              <th className="text-left pb-1">TTL</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(trigger.recentActivity as AnyRecord[]).map((t: AnyRecord, i: number) => (
                              <tr key={i} className="border-b border-slate-800/50">
                                <td className="py-1 pr-3 font-mono text-slate-200">{t.symbol}</td>
                                <td className="py-1 pr-3">
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] px-1 py-0 border-0 ${t.direction === "LONG" ? "text-emerald-400 bg-emerald-900/30" : "text-red-400 bg-red-900/30"}`}
                                  >
                                    {t.direction}
                                  </Badge>
                                </td>
                                <td className="py-1 pr-3 font-mono text-slate-300">{t.triggerPrice?.toFixed(4)}</td>
                                <td className="py-1 pr-3">
                                  <span className={
                                    t.status === "PRESUMED_FILLED" ? "text-emerald-400" :
                                    t.status === "EXPIRED" ? "text-amber-400" :
                                    t.status === "CANCELLED" ? "text-red-400" :
                                    "text-slate-400"
                                  }>
                                    {t.status}
                                  </span>
                                </td>
                                <td className="py-1 text-slate-500">
                                  {t.expiresAt ? `${Math.round((t.expiresAt - t.armedAt) / 1000)}s` : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Symbol Breakdown */}
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <BarChart2 className="w-4 h-4" /> Breakdown por Símbolo (Live)
          </h2>
          <Card className="bg-slate-900 border-slate-700">
            <CardContent className="pt-4 pb-2">
              {isLoading ? (
                <Skeleton className="h-32 bg-slate-800" />
              ) : bySymbol.length === 0 ? (
                <p className="text-sm text-slate-500 italic py-4">
                  Nenhum trade live registrado. Ative o bot com SCALP_ALLOW_EXECUTION=true.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-800 text-xs">
                        <th className="text-left pb-2 pr-4">Símbolo</th>
                        <th className="text-left pb-2 pr-4">Side</th>
                        <th className="text-right pb-2 pr-4">Trades</th>
                        <th className="text-right pb-2 pr-4">Win Rate</th>
                        <th className="text-right pb-2 pr-4">P&L Net</th>
                        <th className="text-right pb-2">Profit Factor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bySymbol.map((row: AnyRecord) => (
                        <tr key={row.key} className="border-b border-slate-800/40 hover:bg-slate-800/30">
                          <td className="py-2 pr-4 font-mono text-slate-200 font-semibold">{row.symbol}</td>
                          <td className="py-2 pr-4">
                            <Badge
                              variant="outline"
                              className={`text-xs border-0 ${row.positionSide === "LONG" ? "text-emerald-400 bg-emerald-900/30" : "text-red-400 bg-red-900/30"}`}
                            >
                              {row.positionSide}
                            </Badge>
                          </td>
                          <td className="py-2 pr-4 text-right text-slate-300">{row.trades}</td>
                          <td className="py-2 pr-4 text-right">
                            <span className={row.winRate >= 0.5 ? "text-emerald-400" : "text-red-400"}>
                              {(row.winRate * 100).toFixed(1)}%
                            </span>
                          </td>
                          <td className={`py-2 pr-4 text-right font-mono font-semibold ${pnlColor(row.netPnl)}`}>
                            {row.netPnl >= 0 ? "+" : ""}${fmt(row.netPnl)}
                          </td>
                          <td className="py-2 text-right">
                            <span className={row.profitFactor >= 1.5 ? "text-emerald-400" : row.profitFactor >= 1 ? "text-amber-400" : "text-red-400"}>
                              {row.profitFactor === 99 ? "∞" : fmt(row.profitFactor)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Architecture notes */}
        <Card className="bg-slate-900 border-slate-700">
          <CardContent className="py-4 px-5">
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="space-y-1 text-xs text-slate-400">
                <p><span className="text-slate-200 font-semibold">Arquitetura de Execução:</span> Ordens LIMIT com <span className="text-amber-300 font-mono">timeInForce: GTX</span> (Post-Only Maker). BingX cancela automaticamente se a ordem cruzasse o spread.</p>
                <p><span className="text-slate-200 font-semibold">Geometria:</span> triggerPrice, targetPrice e stopPrice calculados exclusivamente pelo Quant Brain. O backend é executor puro.</p>
                <p><span className="text-slate-200 font-semibold">Fill Rate:</span> Ordens que expiram (TTL) sem fill são canceladas automaticamente — sem ordens fantasmas na pedra.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
