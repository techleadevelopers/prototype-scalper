import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBotConfig,
  useGetBotModes,
  useGetBingXSummary,
  useGetBingXTicker,
  usePatchBotConfig,
  useResetBotConfigOverrides,
  useSetBotMode,
  useResetBotMode,
  getGetBingXTickerQueryKey,
  getGetBingXSummaryQueryKey,
  getGetBotConfigQueryKey,
  getGetBotModesQueryKey,
  useGetSniperAutopilotStatus,
  useStartSniperAutopilot,
  useStopSniperAutopilot,
  getSniperAutopilotStatusQueryKey,
} from "@/api-client";
import AppShell from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Bot, ShieldCheck, ShieldOff, Zap, Target, DollarSign,
  Clock, AlertTriangle, CheckCircle, XCircle, ChevronRight,
  SlidersHorizontal, RotateCcw, Pencil, Info, Layers, Flame, Crosshair, Binoculars,
  Play, Square, Activity, Timer, TrendingUp,
} from "lucide-react";

function Row({ label, value, mono = false, highlight, overridden }: {
  label: string; value: React.ReactNode; mono?: boolean;
  highlight?: "green" | "red" | "orange" | "dim"; overridden?: boolean;
}) {
  const colors: Record<string, string> = {
    green: "text-green-400", red: "text-red-400", orange: "text-orange-400", dim: "text-muted-foreground",
  };
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/20 last:border-0">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {overridden && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 uppercase tracking-wide">override</span>
        )}
      </div>
      <span className={`text-xs font-semibold ${mono ? "font-mono" : ""} ${highlight ? colors[highlight] : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

function GateIndicator({ pass, label, detail }: { pass: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/15 last:border-0">
      {pass
        ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
        : <XCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">{detail}</p>
      </div>
      <span className={`text-[10px] font-mono shrink-0 ${pass ? "text-green-400" : "text-muted-foreground"}`}>
        {pass ? "ACTIVE" : "OFF"}
      </span>
    </div>
  );
}

function Pipeline({ steps }: { steps: { label: string; desc: string; blocked?: boolean }[] }) {
  return (
    <div className="space-y-0">
      {steps.map((step, i) => (
        <div key={i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${step.blocked ? "bg-red-500/20 text-red-400" : "bg-primary/20 text-primary"}`}>
              {i + 1}
            </div>
            {i < steps.length - 1 && <div className="w-px flex-1 bg-border/30 my-1" />}
          </div>
          <div className="pb-4">
            <p className={`text-xs font-semibold ${step.blocked ? "text-red-400" : "text-foreground"}`}>{step.label}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{step.desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Override form field ───────────────────────────────────────────────────────
function OverrideField({
  label, envKey, value, type = "number", step, min, max, onChange,
}: {
  label: string; envKey: string; value: string; type?: string;
  step?: string; min?: string; max?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Input
        type={type}
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-8 text-xs font-mono"
        placeholder={envKey}
      />
    </div>
  );
}

export default function BotPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: summary } = useGetBingXSummary({ query: { queryKey: getGetBingXSummaryQueryKey(), refetchInterval: 30000 } });
  const { data: config, isLoading } = useGetBotConfig({ query: { queryKey: getGetBotConfigQueryKey(), refetchInterval: 10000 } });
  const { data: btcTicker } = useGetBingXTicker(
    { symbol: "BTC-USDT" },
    { query: { refetchInterval: 5000, queryKey: getGetBingXTickerQueryKey({ symbol: "BTC-USDT" }) } }
  );

  const { data: modesData } = useGetBotModes({ query: { queryKey: getGetBotModesQueryKey(), refetchInterval: 15000 } });
  const patchMutation = usePatchBotConfig();
  const resetMutation = useResetBotConfigOverrides();
  const setModeMutation = useSetBotMode();
  const resetModeMutation = useResetBotMode();

  // ── Sniper Autopilot ──────────────────────────────────────────────────────
  const { data: autopilotStatus, refetch: refetchAutopilot } = useGetSniperAutopilotStatus({
    query: {
      queryKey: getSniperAutopilotStatusQueryKey(),
      refetchInterval: (q) => (q.state.data?.running ? 3000 : 8000),
    },
  });
  const startAutopilotMutation = useStartSniperAutopilot();
  const stopAutopilotMutation = useStopSniperAutopilot();

  function handleStartAutopilot() {
    startAutopilotMutation.mutate(undefined, {
      onSuccess: (res) => {
        refetchAutopilot();
        if (res.started) {
          toast({ title: "Autopilot iniciado", description: `Ciclos a cada ${(res.intervalMs ?? 0) / 1000}s · score ≥ ${res.sniperMinCombinedScore}` });
        } else {
          toast({ title: "Autopilot já rodando", description: res.reason, variant: "destructive" });
        }
      },
      onError: () => toast({ title: "Erro ao iniciar autopilot", variant: "destructive" }),
    });
  }

  function handleStopAutopilot() {
    stopAutopilotMutation.mutate(undefined, {
      onSuccess: (res) => {
        refetchAutopilot();
        toast({ title: "Autopilot parado", description: `${res.totalCycles} ciclos · ${res.totalPlaced} ordens colocadas` });
      },
      onError: () => toast({ title: "Erro ao parar autopilot", variant: "destructive" }),
    });
  }

  // ── Override form state (pre-filled from current config) ──────────────────
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [form, setForm] = useState({
    leverage: "",
    marginPerTrade: "",
    takeProfitPct: "",
    stopLossPct: "",
    maxConcurrentPositions: "",
    maxMarginUtilization: "",
    maxSessionLoss: "",
  });

  useEffect(() => {
    if (config && !overrideOpen) {
      setForm({
        leverage: String(config.leverage),
        marginPerTrade: String(config.marginPerTrade),
        takeProfitPct: String(config.takeProfitPct),
        stopLossPct: String(config.stopLossPct),
        maxConcurrentPositions: String(config.maxConcurrentPositions),
        maxMarginUtilization: String(config.maxMarginUtilization),
        maxSessionLoss: String(config.maxSessionLoss),
      });
    }
  }, [config, overrideOpen]);

  useEffect(() => {
    if (summary && !summary.connected) setLocation("/");
  }, [summary, setLocation]);

  function handleActivateMode(mode: string) {
    setModeMutation.mutate(
      { data: { mode: mode as "easy" | "standard" | "aggressive" } },
      {
        onSuccess: (res) => {
          queryClient.setQueryData(getGetBotConfigQueryKey(), res.config);
          const preset = modesData?.modes.find(m => m.id === res.activeMode);
          toast({
            title: `Modo ${preset?.badge ?? res.activeMode?.toUpperCase()} ativado`,
            description: `${preset?.marginPerTrade} USDT × ${preset?.leverage}× isolado${preset?.bulkExecution ? " · bulk execution" : ""}`,
          });
        },
        onError: () => toast({ title: "Erro ao ativar modo", variant: "destructive" }),
      }
    );
  }

  function handleResetMode() {
    resetModeMutation.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.setQueryData(getGetBotConfigQueryKey(), res.config);
        toast({ title: "Modo resetado", description: "Config voltou aos valores do ENV" });
      },
    });
  }

  function handleApplyOverride() {
    const patch: Record<string, number> = {};
    const fields: [string, string][] = [
      ["leverage", form.leverage],
      ["marginPerTrade", form.marginPerTrade],
      ["takeProfitPct", form.takeProfitPct],
      ["stopLossPct", form.stopLossPct],
      ["maxConcurrentPositions", form.maxConcurrentPositions],
      ["maxMarginUtilization", form.maxMarginUtilization],
      ["maxSessionLoss", form.maxSessionLoss],
    ];
    for (const [key, val] of fields) {
      const n = parseFloat(val);
      if (!isNaN(n)) patch[key] = n;
    }
    patchMutation.mutate(
      { data: patch },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetBotConfigQueryKey(), updated);
          toast({ title: "Override aplicado", description: `${updated.activeOverrides?.length ?? 0} parâmetro(s) sobrescrito(s) em runtime` });
          setOverrideOpen(false);
        },
        onError: () => toast({ title: "Erro", description: "Não foi possível aplicar override", variant: "destructive" }),
      }
    );
  }

  function handleReset() {
    resetMutation.mutate(undefined, {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetBotConfigQueryKey(), updated);
        toast({ title: "Overrides resetados", description: "Config voltou aos valores do ENV" });
        setOverrideOpen(false);
      },
    });
  }

  const btcChange = btcTicker ? parseFloat(btcTicker.priceChangePercent) : 0;
  const btcRegime = btcChange >= (config?.btcRegimeThresholdPct ?? 0.5)
    ? "BULL"
    : btcChange <= -(config?.btcRegimeThresholdPct ?? 0.5)
    ? "BEAR"
    : "NEUTRAL";

  const ov = new Set(config?.activeOverrides ?? []);

  const pipelineSteps = config
    ? [
        {
          label: "BTC Regime Gate",
          desc: config.btcRegimeRequired
            ? `Requires ±${config.btcRegimeThresholdPct}% BTC move — current: ${btcChange >= 0 ? "+" : ""}${btcChange.toFixed(2)}% (${btcRegime})`
            : "Disabled — entries allowed regardless of BTC direction",
          blocked: config.btcRegimeRequired && btcRegime === "NEUTRAL",
        },
        {
          label: "EV Gate",
          desc: config.evMinThreshold > 0
            ? `Requires EV ≥ ${config.evMinThreshold.toFixed(4)} per trade (calibrate from Analysis)`
            : "Disabled — no minimum EV required",
        },
        {
          label: "Win Rate Gate",
          desc: config.winRateMin > 0
            ? `Requires WR ≥ ${(config.winRateMin * 100).toFixed(1)}% from rolling telemetry`
            : "Disabled",
        },
        {
          label: "Profit Factor Gate",
          desc: config.profitFactorMin > 0
            ? `Requires PF ≥ ${config.profitFactorMin.toFixed(2)}x`
            : "Disabled",
        },
        {
          label: "Symbol Gate",
          desc: config.allowedSymbols.length > 0
            ? `Allowlist: ${config.allowedSymbols.join(", ")}`
            : "Disabled — all symbols allowed",
        },
        {
          label: "Hour Blacklist Gate",
          desc: config.hourBlacklist.length > 0
            ? `Blocked UTC hours: ${config.hourBlacklist.join(", ")}`
            : "Disabled — all hours allowed",
        },
        {
          label: "Capital Gate",
          desc: `Max ${config.maxConcurrentPositions} positions · max ${(config.maxMarginUtilization * 100).toFixed(0)}% margin utilization`,
        },
        {
          label: config.allowExecution ? "✓ EXECUTE ORDER" : "BLOCKED — Observation Mode",
          desc: config.allowExecution
            ? `SCALP_ALLOW_EXECUTION=true → orders sent to BingX`
            : "SCALP_ALLOW_EXECUTION=false → gates evaluated, nothing sent",
          blocked: !config.allowExecution,
        },
      ]
    : [];

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[1200px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Bot — Execution Engine</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              ENV = base · overrides em runtime via painel abaixo · reset zera tudo
            </p>
          </div>
          <div className="flex items-center gap-3">
            {config?.hasOverrides && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-yellow-500/30 bg-yellow-500/5">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                <span className="text-[10px] text-yellow-400 font-semibold">{config.activeOverrides?.length} override{(config.activeOverrides?.length ?? 0) > 1 ? "s" : ""} ativos</span>
                <Button
                  variant="ghost" size="sm"
                  className="h-5 w-5 p-0 text-yellow-400/60 hover:text-yellow-400 ml-1"
                  onClick={handleReset}
                  disabled={resetMutation.isPending}
                  title="Resetar overrides"
                >
                  <RotateCcw className="w-3 h-3" />
                </Button>
              </div>
            )}
            {isLoading ? (
              <Skeleton className="h-8 w-36" />
            ) : config ? (
              <div className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 ${config.allowExecution ? "border-green-500/50 bg-green-500/10" : "border-border/50 bg-muted/20"}`}>
                {config.allowExecution
                  ? <ShieldCheck className="w-5 h-5 text-green-400" />
                  : <ShieldOff className="w-5 h-5 text-muted-foreground" />}
                <span className={`text-sm font-black tracking-tight font-mono ${config.allowExecution ? "text-green-400" : "text-muted-foreground"}`}>
                  {config.allowExecution ? "LIVE EXECUTION" : "OBSERVATION MODE"}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-48 rounded-lg" />)}
          </div>
        ) : !config ? (
          <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
            <Bot className="h-10 w-10 opacity-15" />
            <p className="text-sm">Could not load bot config</p>
          </div>
        ) : (
          <>
            {/* Safety banner */}
            {!config.allowExecution && (
              <div className="flex items-start gap-4 px-5 py-4 rounded-lg border border-orange-500/30 bg-orange-500/5">
                <AlertTriangle className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-orange-300">Observation Mode Active</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    All gate logic runs and is evaluated, but no orders are sent to BingX.
                    Set <code className="font-mono bg-muted px-1 rounded text-orange-300">SCALP_ALLOW_EXECUTION=true</code> in your environment to enable live execution.
                    Only activate after the Analysis page shows positive EV and PF ≥ 1.5.
                  </p>
                </div>
              </div>
            )}

            {/* ── Execution Mode Selector ───────────────────────────────────── */}
            {(() => {
              const modes = modesData?.modes ?? [];
              const activeMode = config.activeMode;

              const modeColors: Record<string, {
                border: string; bg: string; badge: string; icon: React.ReactNode; btnCls: string;
              }> = {
                easy:       { border: "border-green-500/50",  bg: "bg-green-500/5",  badge: "bg-green-500/20 text-green-400",  icon: <Binoculars className="w-5 h-5 text-green-400" />,  btnCls: "bg-green-600 hover:bg-green-500 text-white" },
                standard:   { border: "border-blue-500/50",   bg: "bg-blue-500/5",   badge: "bg-blue-500/20 text-blue-400",    icon: <Crosshair className="w-5 h-5 text-blue-400" />,    btnCls: "bg-blue-600 hover:bg-blue-500 text-white" },
                aggressive: { border: "border-orange-500/50", bg: "bg-orange-500/5", badge: "bg-orange-500/20 text-orange-400", icon: <Flame className="w-5 h-5 text-orange-400" />, btnCls: "bg-orange-600 hover:bg-orange-500 text-white" },
              };

              return (
                <Card className="border-border/40 bg-card/30">
                  <CardHeader className="px-4 pt-4 pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Layers className="w-4 h-4 text-primary" />
                        Modo de Execução
                        <span className="text-[10px] font-normal text-muted-foreground">
                          — preset de banca + alavancagem + estratégia
                        </span>
                      </CardTitle>
                      {activeMode && (
                        <Button
                          variant="ghost" size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={handleResetMode}
                          disabled={resetModeMutation.isPending}
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Voltar ao ENV
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {modes.map((m) => {
                        const isActive = activeMode === m.id;
                        const colors = modeColors[m.id] ?? modeColors.easy;
                        return (
                          <div
                            key={m.id}
                            className={`relative rounded-xl border-2 p-4 transition-all ${isActive ? `${colors.border} ${colors.bg}` : "border-border/30 bg-card/20"}`}
                          >
                            {isActive && (
                              <span className="absolute top-2 right-2 text-[8px] font-bold px-1.5 py-0.5 rounded bg-foreground/10 text-foreground/60 uppercase tracking-wider">
                                ativo
                              </span>
                            )}
                            <div className="flex items-center gap-2 mb-2">
                              {colors.icon}
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${colors.badge}`}>
                                {m.badge}
                              </span>
                            </div>
                            <p className="text-sm font-bold mb-1">{m.label}</p>
                            <p className="text-[10px] text-muted-foreground leading-relaxed mb-3">{m.description}</p>

                            <div className="space-y-1 mb-3">
                              <div className="flex justify-between text-[10px]">
                                <span className="text-muted-foreground">Banca/trade</span>
                                <span className="font-mono font-bold">${m.marginPerTrade} USDT</span>
                              </div>
                              <div className="flex justify-between text-[10px]">
                                <span className="text-muted-foreground">Leverage</span>
                                <span className="font-mono font-bold">{m.leverage}×</span>
                              </div>
                              <div className="flex justify-between text-[10px]">
                                <span className="text-muted-foreground">Nocional</span>
                                <span className="font-mono font-bold">${(m.marginPerTrade * m.leverage).toFixed(0)} USDT</span>
                              </div>
                              <div className="flex justify-between text-[10px]">
                                <span className="text-muted-foreground">Execução</span>
                                <span className={`font-mono font-bold ${m.bulkExecution ? "text-orange-400" : "text-foreground"}`}>
                                  {m.bulkExecution ? `bulk (${m.maxOrdersPerSecond}/s)` : "individual"}
                                </span>
                              </div>
                            </div>

                            <p className="text-[9px] text-muted-foreground/70 leading-relaxed mb-3 border-t border-border/20 pt-2">
                              {m.riskNote}
                            </p>

                            <Button
                              size="sm"
                              className={`w-full h-7 text-[11px] font-bold ${isActive ? "opacity-50 cursor-not-allowed bg-muted text-muted-foreground" : colors.btnCls}`}
                              onClick={() => !isActive && handleActivateMode(m.id)}
                              disabled={isActive || setModeMutation.isPending}
                            >
                              {isActive ? "Ativo" : `Ativar ${m.label}`}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                    {modes.length === 0 && (
                      <div className="flex justify-center py-6">
                        <Skeleton className="h-32 w-full rounded-xl" />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* ── Runtime Override Panel ─────────────────────────────────────── */}
            <Card className={`border-2 transition-all ${overrideOpen ? "border-yellow-500/40 bg-yellow-500/3" : "border-border/30 bg-card/20"}`}>
              <CardHeader className="px-4 pt-4 pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-yellow-400" />
                    Override em Runtime
                    <span className="text-[10px] font-normal text-muted-foreground ml-1">
                      — sem reiniciar o servidor
                    </span>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {config.hasOverrides && (
                      <Button
                        variant="ghost" size="sm"
                        className="h-7 px-2 text-[11px] text-yellow-400/70 hover:text-yellow-400"
                        onClick={handleReset}
                        disabled={resetMutation.isPending}
                      >
                        <RotateCcw className="w-3 h-3 mr-1" />
                        Reset para ENV
                      </Button>
                    )}
                    <Button
                      variant={overrideOpen ? "secondary" : "outline"}
                      size="sm"
                      className="h-7 px-3 text-[11px]"
                      onClick={() => setOverrideOpen(v => !v)}
                    >
                      <Pencil className="w-3 h-3 mr-1.5" />
                      {overrideOpen ? "Fechar" : "Editar"}
                    </Button>
                  </div>
                </div>
                {!overrideOpen && (
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                    Altera banca, leverage, TP/SL e limites de capital em memória. Reset automático ao reiniciar o servidor — o ENV continua sendo a fonte de verdade.
                  </p>
                )}
              </CardHeader>

              {overrideOpen && (
                <CardContent className="px-4 pb-4">
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-4">
                    <OverrideField
                      label="Leverage (×)"
                      envKey="SCALP_LEVERAGE"
                      value={form.leverage}
                      step="1" min="1" max="100"
                      onChange={v => setForm(f => ({ ...f, leverage: v }))}
                    />
                    <OverrideField
                      label="Banca / trade (USDT)"
                      envKey="SCALP_MARGIN_PER_TRADE"
                      value={form.marginPerTrade}
                      step="0.5" min="0.5"
                      onChange={v => setForm(f => ({ ...f, marginPerTrade: v }))}
                    />
                    <OverrideField
                      label="Take Profit (%)"
                      envKey="SCALP_TAKE_PROFIT_PCT"
                      value={form.takeProfitPct}
                      step="0.01" min="0.01"
                      onChange={v => setForm(f => ({ ...f, takeProfitPct: v }))}
                    />
                    <OverrideField
                      label="Stop Loss (%)"
                      envKey="SCALP_STOP_LOSS_PCT"
                      value={form.stopLossPct}
                      step="0.01" min="0.01"
                      onChange={v => setForm(f => ({ ...f, stopLossPct: v }))}
                    />
                    <OverrideField
                      label="Max posições"
                      envKey="SCALP_MAX_CONCURRENT_POSITIONS"
                      value={form.maxConcurrentPositions}
                      step="1" min="1"
                      onChange={v => setForm(f => ({ ...f, maxConcurrentPositions: v }))}
                    />
                    <OverrideField
                      label="Max utilização (%)"
                      envKey="SCALP_MAX_MARGIN_UTILIZATION (0–1)"
                      value={form.maxMarginUtilization}
                      step="0.05" min="0" max="1"
                      onChange={v => setForm(f => ({ ...f, maxMarginUtilization: v }))}
                    />
                    <OverrideField
                      label="Loss máx / sessão (USDT)"
                      envKey="SCALP_MAX_SESSION_LOSS"
                      value={form.maxSessionLoss}
                      step="1" min="1"
                      onChange={v => setForm(f => ({ ...f, maxSessionLoss: v }))}
                    />
                  </div>

                  {/* Preview de notional */}
                  {(() => {
                    const lev = parseFloat(form.leverage) || 0;
                    const margin = parseFloat(form.marginPerTrade) || 0;
                    const tp = parseFloat(form.takeProfitPct) || 0;
                    const sl = parseFloat(form.stopLossPct) || 0;
                    if (lev > 0 && margin > 0) {
                      return (
                        <div className="mb-4 px-3 py-2.5 rounded-lg bg-muted/20 border border-border/30 flex flex-wrap gap-4 text-[11px]">
                          <span className="text-muted-foreground">Nocional: <span className="font-mono font-bold text-foreground">{(margin * lev).toFixed(0)} USDT</span></span>
                          {tp > 0 && <span className="text-muted-foreground">TP na margem: <span className="font-mono font-bold text-green-400">+{(tp * lev).toFixed(2)}%</span></span>}
                          {sl > 0 && <span className="text-muted-foreground">SL na margem: <span className="font-mono font-bold text-red-400">-{(sl * lev).toFixed(2)}%</span></span>}
                        </div>
                      );
                    }
                    return null;
                  })()}

                  <div className="flex items-center gap-3">
                    <Button
                      className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold"
                      size="sm"
                      onClick={handleApplyOverride}
                      disabled={patchMutation.isPending}
                    >
                      {patchMutation.isPending ? "Aplicando..." : "Aplicar Override"}
                    </Button>
                    <p className="text-[10px] text-muted-foreground">
                      <Info className="w-3 h-3 inline mr-1 opacity-50" />
                      Persiste em memória até reiniciar o servidor. Para fixar permanentemente, atualize o .env.
                    </p>
                  </div>
                </CardContent>
              )}
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Execution params */}
              <Card className="bg-card/50 border-border/50">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-primary" /> Execution Parameters
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <Row label="Leverage" value={`${config.leverage}×`} mono highlight="orange" overridden={ov.has("leverage")} />
                  <Row label="Margin / trade" value={`${config.marginPerTrade} USDT`} mono overridden={ov.has("marginPerTrade")} />
                  <Row label="Notional / trade" value={`${(config.marginPerTrade * config.leverage).toFixed(0)} USDT`} mono highlight="orange" />
                  <Row label="Take profit" value={`${config.takeProfitPct}%`} mono highlight="green" overridden={ov.has("takeProfitPct")} />
                  <Row label="Stop loss" value={`${config.stopLossPct}%`} mono highlight="red" overridden={ov.has("stopLossPct")} />
                  <Row label="TP on margin" value={`${(config.takeProfitPct * config.leverage).toFixed(2)}%`} mono highlight="green" />
                  <Row label="SL on margin" value={`-${(config.stopLossPct * config.leverage).toFixed(2)}%`} mono highlight="red" />
                  <Row label="Order type" value={config.orderType} mono />
                  <Row label="Margin type" value={config.marginType} mono />
                </CardContent>
              </Card>

              {/* Capital controls */}
              <Card className="bg-card/50 border-border/50">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Target className="w-4 h-4 text-primary" /> Capital Controls
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <Row label="Max concurrent positions" value={config.maxConcurrentPositions} mono overridden={ov.has("maxConcurrentPositions")} />
                  <Row label="Max margin utilization" value={`${(config.maxMarginUtilization * 100).toFixed(0)}%`} mono highlight="orange" overridden={ov.has("maxMarginUtilization")} />
                  <Row label="Max session loss" value={`${config.maxSessionLoss} USDT`} mono highlight="red" overridden={ov.has("maxSessionLoss")} />
                  <div className="mt-4 pt-3 border-t border-border/20 space-y-2">
                    <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Throughput ceiling</p>
                    <p className="text-xs text-muted-foreground">
                      BingX rate limit: <span className="text-foreground font-mono">100 orders / 10s</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Max theoretical: <span className="text-primary font-mono">10 orders/s</span>
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Symbol & time gates */}
              <Card className="bg-card/50 border-border/50">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary" /> Symbol & Time Gates
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <Row
                    label="Allowed symbols"
                    value={config.allowedSymbols.length > 0 ? config.allowedSymbols.join(", ") : "all"}
                    mono
                    highlight={config.allowedSymbols.length === 0 ? "dim" : undefined}
                  />
                  <Row
                    label="Hour blacklist (UTC)"
                    value={config.hourBlacklist.length > 0 ? config.hourBlacklist.join(", ") : "none"}
                    mono
                    highlight={config.hourBlacklist.length === 0 ? "dim" : "orange"}
                  />
                  <Row
                    label="BTC regime required"
                    value={config.btcRegimeRequired ? "yes" : "no"}
                    highlight={config.btcRegimeRequired ? undefined : "dim"}
                    mono
                  />
                  {config.btcRegimeRequired && (
                    <Row label="BTC regime threshold" value={`±${config.btcRegimeThresholdPct}%`} mono />
                  )}
                  <div className="mt-4 pt-3 border-t border-border/20">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Current BTC regime</span>
                      <Badge variant="outline" className={`text-[10px] font-mono ${btcRegime === "BULL" ? "border-green-500/40 text-green-400" : btcRegime === "BEAR" ? "border-red-500/40 text-red-400" : "border-border/50 text-muted-foreground"}`}>
                        {btcRegime} ({btcChange >= 0 ? "+" : ""}{btcChange.toFixed(2)}%)
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Adaptive gate thresholds */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-border/50 bg-card/30">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Zap className="w-4 h-4 text-primary" /> Adaptive Gate Thresholds
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground">Calibrate these from the Analysis page after collecting trade data</p>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-0">
                  <GateIndicator
                    pass={config.evMinThreshold > 0}
                    label={`EV minimum: ${config.evMinThreshold > 0 ? `≥ ${config.evMinThreshold.toFixed(4)}` : "disabled"}`}
                    detail="SCALP_EV_MIN_THRESHOLD — set once EV is consistently positive"
                  />
                  <GateIndicator
                    pass={config.winRateMin > 0}
                    label={`Win rate minimum: ${config.winRateMin > 0 ? `≥ ${(config.winRateMin * 100).toFixed(1)}%` : "disabled"}`}
                    detail="SCALP_WIN_RATE_MIN — enable once you have 50+ trades in telemetry"
                  />
                  <GateIndicator
                    pass={config.profitFactorMin > 0}
                    label={`Profit factor minimum: ${config.profitFactorMin > 0 ? `≥ ${config.profitFactorMin.toFixed(2)}x` : "disabled"}`}
                    detail="SCALP_PROFIT_FACTOR_MIN — 1.5x is the sniper threshold"
                  />
                  <GateIndicator
                    pass={config.btcRegimeRequired}
                    label={`BTC regime gate: ${config.btcRegimeRequired ? `±${config.btcRegimeThresholdPct}%` : "disabled"}`}
                    detail="SCALP_BTC_REGIME_REQUIRED — filter entries to strong BTC direction only"
                  />
                  <GateIndicator
                    pass={config.allowedSymbols.length > 0}
                    label={`Symbol allowlist: ${config.allowedSymbols.length > 0 ? config.allowedSymbols.length + " symbols" : "disabled"}`}
                    detail="SCALP_SYMBOLS — restrict to symbols with positive edge from telemetry"
                  />
                  <GateIndicator
                    pass={config.hourBlacklist.length > 0}
                    label={`Hour blacklist: ${config.hourBlacklist.length > 0 ? config.hourBlacklist.length + " hours blocked" : "disabled"}`}
                    detail="SCALP_HOUR_BLACKLIST — use Analysis hour toxicity heatmap to configure"
                  />
                </CardContent>
              </Card>

              {/* Pipeline diagram */}
              <Card className="border-border/50 bg-card/30">
                <CardHeader className="px-4 pt-4 pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <ChevronRight className="w-4 h-4 text-primary" /> Entry Pipeline
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground">
                    signal → gate cascade → execute (or observe)
                  </p>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <Pipeline steps={pipelineSteps} />
                </CardContent>
              </Card>
            </div>

            {/* ── Sniper Autopilot Panel ──────────────────────────────────── */}
            {(() => {
              const ap = autopilotStatus;
              const isRunning = ap?.running ?? false;
              const isBusy = startAutopilotMutation.isPending || stopAutopilotMutation.isPending;

              function fmtUptime(ms: number | null) {
                if (!ms) return "—";
                const s = Math.floor(ms / 1000);
                if (s < 60) return `${s}s`;
                const m = Math.floor(s / 60);
                if (m < 60) return `${m}m ${s % 60}s`;
                return `${Math.floor(m / 60)}h ${m % 60}m`;
              }

              function fmtTime(ts: number | null) {
                if (!ts) return "—";
                return new Date(ts).toLocaleTimeString();
              }

              return (
                <Card className={`border-2 transition-all ${isRunning ? "border-violet-500/50 bg-violet-500/5" : "border-border/30 bg-card/20"}`}>
                  <CardHeader className="px-4 pt-4 pb-3">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Activity className={`w-4 h-4 ${isRunning ? "text-violet-400 animate-pulse" : "text-muted-foreground"}`} />
                        Sniper Autopilot
                        <span className="text-[10px] font-normal text-muted-foreground ml-1">
                          — loop server-side autônomo · dispara sem esperar QB
                        </span>
                        {isRunning && (
                          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 uppercase tracking-wider animate-pulse">
                            ATIVO
                          </span>
                        )}
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        {isRunning ? (
                          <Button
                            size="sm"
                            className="h-8 px-4 bg-red-600 hover:bg-red-500 text-white font-bold text-xs"
                            onClick={handleStopAutopilot}
                            disabled={isBusy}
                          >
                            <Square className="w-3 h-3 mr-1.5" />
                            Parar Autopilot
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            className="h-8 px-4 bg-violet-600 hover:bg-violet-500 text-white font-bold text-xs"
                            onClick={handleStartAutopilot}
                            disabled={isBusy || !config.allowExecution}
                            title={!config.allowExecution ? "SCALP_ALLOW_EXECUTION=true required" : undefined}
                          >
                            <Play className="w-3 h-3 mr-1.5" />
                            Iniciar Autopilot
                          </Button>
                        )}
                      </div>
                    </div>
                    {!config.allowExecution && (
                      <p className="text-[10px] text-orange-400/80 mt-1">
                        <AlertTriangle className="w-3 h-3 inline mr-1" />
                        Requer <code className="font-mono">SCALP_ALLOW_EXECUTION=true</code> para iniciar
                      </p>
                    )}
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {/* Stats row */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                      {[
                        { icon: <Timer className="w-3.5 h-3.5" />, label: "Uptime", value: fmtUptime(ap?.uptimeMs ?? null), color: isRunning ? "text-violet-300" : "text-muted-foreground" },
                        { icon: <Activity className="w-3.5 h-3.5" />, label: "Ciclos", value: ap?.totalCycles ?? 0, color: "text-foreground" },
                        { icon: <TrendingUp className="w-3.5 h-3.5" />, label: "Ordens colocadas", value: ap?.totalPlaced ?? 0, color: ap?.totalPlaced ? "text-green-400" : "text-muted-foreground" },
                        { icon: <DollarSign className="w-3.5 h-3.5" />, label: "Loss sessão", value: ap ? `${ap.sessionLossUsd.toFixed(2)} USDT` : "—", color: (ap?.sessionLossUsd ?? 0) > 0 ? "text-red-400" : "text-muted-foreground" },
                      ].map((stat, i) => (
                        <div key={i} className="flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-muted/15 border border-border/20">
                          <div className="flex items-center gap-1.5 text-muted-foreground">{stat.icon}<span className="text-[10px]">{stat.label}</span></div>
                          <span className={`text-sm font-bold font-mono ${stat.color}`}>{String(stat.value)}</span>
                        </div>
                      ))}
                    </div>

                    {/* Config summary */}
                    {ap && (
                      <div className="flex flex-wrap gap-2 mb-4">
                        {[
                          `Intervalo: ${ap.config.intervalSec}s`,
                          `Candidatos/ciclo: ${ap.config.maxCandidatesPerCycle}`,
                          `Score mínimo: ${ap.config.minCombinedScore}`,
                          `Stacking: ${ap.config.positionStackingEnabled ? `ON (max ${ap.config.maxPositionsPerSymbol}×)` : "OFF"}`,
                        ].map((tag, i) => (
                          <span key={i} className="text-[10px] font-mono px-2 py-1 rounded bg-muted/20 border border-border/20 text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Stop reason */}
                    {ap?.stopReason && !isRunning && (
                      <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/20">
                        <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        <span className="text-[11px] text-red-300">Parado: {ap.stopReason}</span>
                      </div>
                    )}

                    {/* Last cycle */}
                    {ap?.lastCycle && (
                      <div className="mb-4 px-3 py-2.5 rounded-lg bg-muted/10 border border-border/20">
                        <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Último Ciclo #{ap.lastCycle.cycle}</p>
                        <div className="flex flex-wrap gap-3 text-[11px]">
                          <span className="text-muted-foreground">Início: <span className="font-mono text-foreground">{fmtTime(ap.lastCycle.startedAt)}</span></span>
                          <span className="text-muted-foreground">Duração: <span className="font-mono text-foreground">{ap.lastCycle.durationMs}ms</span></span>
                          <span className="text-muted-foreground">Candidatos: <span className="font-mono text-foreground">{ap.lastCycle.candidates}</span></span>
                          <span className="text-muted-foreground">Tentadas: <span className="font-mono text-foreground">{ap.lastCycle.attempted}</span></span>
                          <span className="text-muted-foreground">Colocadas: <span className={`font-mono font-bold ${ap.lastCycle.placed > 0 ? "text-green-400" : "text-foreground"}`}>{ap.lastCycle.placed}</span></span>
                          <span className="text-muted-foreground">Rejeitadas: <span className="font-mono text-foreground">{ap.lastCycle.rejected}</span></span>
                          <span className="text-muted-foreground">BTC: <span className={`font-mono ${ap.lastCycle.btcChangePct >= 0 ? "text-green-400" : "text-red-400"}`}>{ap.lastCycle.btcChangePct >= 0 ? "+" : ""}{ap.lastCycle.btcChangePct.toFixed(2)}%</span></span>
                        </div>
                      </div>
                    )}

                    {/* Recent history table */}
                    {ap && ap.recentHistory.length > 0 && (
                      <div>
                        <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Histórico (últimos {ap.recentHistory.length} ciclos)</p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-[10px]">
                            <thead>
                              <tr className="border-b border-border/20">
                                {["#", "Hora", "ms", "Cand.", "Tent.", "Colocadas", "Rejeit.", "BTC%"].map((h) => (
                                  <th key={h} className="text-left py-1.5 pr-3 text-muted-foreground font-semibold uppercase tracking-wider">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {[...ap.recentHistory].reverse().map((c) => (
                                <tr key={c.cycle} className="border-b border-border/10 hover:bg-muted/5">
                                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{c.cycle}</td>
                                  <td className="py-1.5 pr-3 font-mono">{fmtTime(c.startedAt)}</td>
                                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{c.durationMs}</td>
                                  <td className="py-1.5 pr-3 font-mono">{c.candidates}</td>
                                  <td className="py-1.5 pr-3 font-mono">{c.attempted}</td>
                                  <td className={`py-1.5 pr-3 font-mono font-bold ${c.placed > 0 ? "text-green-400" : "text-muted-foreground"}`}>{c.placed}</td>
                                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{c.rejected}</td>
                                  <td className={`py-1.5 pr-3 font-mono ${c.btcChangePct >= 0 ? "text-green-400" : "text-red-400"}`}>{c.btcChangePct >= 0 ? "+" : ""}{c.btcChangePct.toFixed(2)}%</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {!ap && (
                      <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
                        <Skeleton className="h-4 w-4 rounded" />
                        <span>Carregando status...</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* ENV reference */}
            <Card className="border-border/30 bg-card/20">
              <CardHeader className="px-4 pt-4 pb-3">
                <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  ENV Reference — copy to your .env
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed overflow-x-auto whitespace-pre-wrap">{[
`SCALP_LEVERAGE=${config.leverage}`,
`SCALP_MARGIN_PER_TRADE=${config.marginPerTrade}`,
`SCALP_MAX_CONCURRENT_POSITIONS=${config.maxConcurrentPositions}`,
`SCALP_MAX_MARGIN_UTILIZATION=${config.maxMarginUtilization}`,
`SCALP_TAKE_PROFIT_PCT=${config.takeProfitPct}`,
`SCALP_STOP_LOSS_PCT=${config.stopLossPct}`,
`SCALP_EV_MIN_THRESHOLD=${config.evMinThreshold}`,
`SCALP_WIN_RATE_MIN=${config.winRateMin}`,
`SCALP_PROFIT_FACTOR_MIN=${config.profitFactorMin}`,
`SCALP_BTC_REGIME_REQUIRED=${config.btcRegimeRequired}`,
`SCALP_BTC_REGIME_THRESHOLD_PCT=${config.btcRegimeThresholdPct}`,
`SCALP_SYMBOLS=${config.allowedSymbols.join(",")}`,
`SCALP_HOUR_BLACKLIST=${config.hourBlacklist.join(",")}`,
`SCALP_ORDER_TYPE=${config.orderType}`,
`SCALP_MARGIN_TYPE=${config.marginType}`,
`SCALP_ALLOW_EXECUTION=${config.allowExecution}`,
`SCALP_MAX_SESSION_LOSS=${config.maxSessionLoss}`,
                ].join("\n")}</pre>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
