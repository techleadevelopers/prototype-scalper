import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import AppShell from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import {
  getTriggerStatus,
  getTriggerStatusQueryKey,
  useEnableTrigger,
  useDisableTrigger,
  useSnapshotTrigger,
  useResetTriggerSymbol,
  type TriggerSymbolState,
  type TriggerStatus,
} from "@/api-client";
import {
  Target,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Play,
  Square,
  AlertTriangle,
  Camera,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Clock,
  Zap,
  Info,
  ArrowDown,
  ArrowUp,
} from "lucide-react";

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return "—";
  return n.toFixed(decimals);
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 10000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtAgo(ms: number | null): string {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function SymbolRow({ s, onReset }: { s: TriggerSymbolState; onReset: (sym: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const deviation = s.dropPct > 0 ? -s.dropPct : s.risePct;
  const isDown = s.dropPct > 0;
  const isUp = s.risePct > 0;
  const longPct = Math.min(100, (s.dropPct / (s.longTpPct || 1)) * 100);
  const shortPct = Math.min(100, (s.risePct / (s.shortTpPct || 1)) * 100);

  return (
    <div className="border border-border/20 rounded-lg bg-card/5 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/10 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-mono text-xs font-semibold text-foreground/90 w-28 shrink-0">
          {s.symbol.replace("-USDT", "")}
        </span>

        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[10px] font-mono ${s.dropPct >= 0.01 ? "text-emerald-400" : "text-muted-foreground/50"}`}>
            ▼{fmt(s.dropPct)}%
          </span>
          <span className="text-[9px] text-muted-foreground/30">/</span>
          <span className={`text-[10px] font-mono ${s.risePct >= 0.01 ? "text-rose-400" : "text-muted-foreground/50"}`}>
            ▲{fmt(s.risePct)}%
          </span>
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1">
          {s.longArmed && (
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[9px] px-1.5 py-0">
              <Zap className="w-2.5 h-2.5 mr-0.5" />LONG ARMED
            </Badge>
          )}
          {s.shortArmed && (
            <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30 text-[9px] px-1.5 py-0">
              <Zap className="w-2.5 h-2.5 mr-0.5" />SHORT ARMED
            </Badge>
          )}
          {!s.longArmed && !s.shortArmed && (
            <span className="text-[10px] text-muted-foreground/40">monitorando</span>
          )}
        </div>

        <span className="text-[10px] text-muted-foreground/50 shrink-0">
          ref {fmtPrice(s.referencePrice)}
        </span>
        <span className="text-[10px] text-muted-foreground/40 shrink-0">
          {s.secondsSinceSnapshot}s
        </span>

        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground/40" /> : <ChevronDown className="w-3 h-3 text-muted-foreground/40" />}
      </div>

      {expanded && (
        <div className="border-t border-border/10 px-3 py-3 grid grid-cols-2 gap-3 bg-card/5">
          <div className="space-y-1.5">
            <div className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1">
              <TrendingUp className="w-3 h-3 text-emerald-400" />LONG Gate
            </div>
            <div className="space-y-0.5">
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">Gatilho</span>
                <span className="font-mono text-foreground/80">{fmtPrice(s.longTriggerPrice)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">TP alvo</span>
                <span className="font-mono text-emerald-400">{fmtPrice(s.referencePrice)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">TP %</span>
                <span className="font-mono text-emerald-400">+{fmt(s.longTpPct)}%</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">Progresso</span>
                <span className="font-mono text-foreground/60">{fmt(longPct, 0)}%</span>
              </div>
            </div>
            <div className="h-1 bg-border/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500/60 transition-all duration-500"
                style={{ width: `${Math.max(0, longPct)}%` }}
              />
            </div>
            {s.longFiredAt && (
              <div className="text-[9px] text-muted-foreground/40 flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />Disparado {fmtAgo(s.longFiredAt)}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1">
              <TrendingDown className="w-3 h-3 text-rose-400" />SHORT Gate
            </div>
            <div className="space-y-0.5">
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">Gatilho</span>
                <span className="font-mono text-foreground/80">{fmtPrice(s.shortTriggerPrice)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">TP alvo</span>
                <span className="font-mono text-rose-400">{fmtPrice(s.referencePrice)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">TP %</span>
                <span className="font-mono text-rose-400">+{fmt(s.shortTpPct)}%</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground/60">Progresso</span>
                <span className="font-mono text-foreground/60">{fmt(shortPct, 0)}%</span>
              </div>
            </div>
            <div className="h-1 bg-border/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-rose-500/60 transition-all duration-500"
                style={{ width: `${Math.max(0, shortPct)}%` }}
              />
            </div>
            {s.shortFiredAt && (
              <div className="text-[9px] text-muted-foreground/40 flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />Disparado {fmtAgo(s.shortFiredAt)}
              </div>
            )}
          </div>

          <div className="col-span-2 flex items-center justify-between pt-1 border-t border-border/10">
            <div className="flex items-center gap-3 text-[10px]">
              <span className="text-muted-foreground/60">Preço atual</span>
              <span className="font-mono text-foreground/80">{fmtPrice(s.currentPrice)}</span>
              {isDown && s.dropPct > 0 && (
                <span className="text-emerald-400 flex items-center gap-0.5">
                  <ArrowDown className="w-3 h-3" />−{fmt(s.dropPct)}%
                </span>
              )}
              {isUp && s.risePct > 0 && (
                <span className="text-rose-400 flex items-center gap-0.5">
                  <ArrowUp className="w-3 h-3" />+{fmt(s.risePct)}%
                </span>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-muted-foreground/60 hover:text-foreground/80"
              onClick={(e) => { e.stopPropagation(); onReset(s.symbol); }}
            >
              <RotateCcw className="w-3 h-3 mr-1" />Reset ref
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TriggerPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [longDropPct, setLongDropPct] = useState("1.74");
  const [shortRisePct, setShortRisePct] = useState("3.16");
  const [slPct, setSlPct] = useState("0.55");
  const [cooldownMin, setCooldownMin] = useState("5");

  const { data: status, isLoading, refetch } = useQuery<TriggerStatus>({
    queryKey: getTriggerStatusQueryKey(),
    queryFn: getTriggerStatus,
    refetchInterval: 5000,
  });

  const enableMut = useEnableTrigger({
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getTriggerStatusQueryKey() });
      toast({ title: "Gatilho ativado", description: "Referências capturadas para todos os símbolos." });
    },
    onError: (e) => toast({ title: "Erro", description: String(e), variant: "destructive" }),
  });

  const disableMut = useDisableTrigger({
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getTriggerStatusQueryKey() });
      toast({ title: "Gatilho desativado" });
    },
  });

  const snapshotMut = useSnapshotTrigger({
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: getTriggerStatusQueryKey() });
      toast({ title: "Referências re-capturadas", description: `${r.snapshotted} símbolo(s) atualizados.` });
    },
    onError: (e) => toast({ title: "Erro", description: String(e), variant: "destructive" }),
  });

  const resetMut = useResetTriggerSymbol({
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: getTriggerStatusQueryKey() });
      toast({ title: "Estado resetado", description: `${r.reset}` });
    },
  });

  const handleToggle = useCallback((checked: boolean) => {
    if (checked) {
      enableMut.mutate({
        longDropPct: parseFloat(longDropPct) || 1.74,
        shortRisePct: parseFloat(shortRisePct) || 3.16,
        slPct: parseFloat(slPct) || 0.55,
        cooldownMs: (parseFloat(cooldownMin) || 5) * 60 * 1000,
      });
    } else {
      disableMut.mutate();
    }
  }, [longDropPct, shortRisePct, slPct, cooldownMin, enableMut, disableMut]);

  const isEnabled = status?.enabled ?? false;
  const isPending = enableMut.isPending || disableMut.isPending;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Target className="w-5 h-5 text-primary" />
            <div>
              <h1 className="text-lg font-semibold text-foreground">Estratégia Gatilho</h1>
              <p className="text-[11px] text-muted-foreground/70">
                Dispara entrada por desvio de preço do ponto de referência
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => refetch()}
              disabled={isLoading}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${isLoading ? "animate-spin" : ""}`} />
              Atualizar
            </Button>
            {isEnabled && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px] border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                onClick={() => snapshotMut.mutate()}
                disabled={snapshotMut.isPending}
              >
                <Camera className="w-3.5 h-3.5 mr-1" />
                {snapshotMut.isPending ? "Re-capturando..." : "Re-snapshot"}
              </Button>
            )}
          </div>
        </div>

        {/* Config + Toggle */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="border-border/20 bg-card/10 lg:col-span-2">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Info className="w-4 h-4 text-muted-foreground/60" />
                Configuração
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[10px] text-muted-foreground/70 mb-1 uppercase tracking-wider">
                    <TrendingUp className="w-3 h-3 inline mr-1 text-emerald-400" />
                    LONG drop %
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="20"
                    className="w-full h-8 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={longDropPct}
                    onChange={(e) => setLongDropPct(e.target.value)}
                    disabled={isEnabled}
                  />
                  <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                    queda → entrada LONG
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] text-muted-foreground/70 mb-1 uppercase tracking-wider">
                    <TrendingDown className="w-3 h-3 inline mr-1 text-rose-400" />
                    SHORT rise %
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="20"
                    className="w-full h-8 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={shortRisePct}
                    onChange={(e) => setShortRisePct(e.target.value)}
                    disabled={isEnabled}
                  />
                  <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                    alta → entrada SHORT
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] text-muted-foreground/70 mb-1 uppercase tracking-wider">
                    Stop Loss %
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    min="0.1"
                    max="10"
                    className="w-full h-8 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={slPct}
                    onChange={(e) => setSlPct(e.target.value)}
                    disabled={isEnabled}
                  />
                  <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                    % do preço de entrada
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] text-muted-foreground/70 mb-1 uppercase tracking-wider">
                    Cooldown (min)
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    max="60"
                    className="w-full h-8 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={cooldownMin}
                    onChange={(e) => setCooldownMin(e.target.value)}
                    disabled={isEnabled}
                  />
                  <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                    entre disparos por símbolo
                  </p>
                </div>
              </div>

              {isEnabled && (
                <div className="mt-3 text-[10px] text-amber-400/70 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  Desative para alterar parâmetros.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Activation card */}
          <Card className={`border-border/20 ${isEnabled ? "bg-emerald-950/20 border-emerald-500/20" : "bg-card/10"}`}>
            <CardContent className="flex flex-col items-center justify-center h-full px-4 py-6 gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                isEnabled ? "bg-emerald-500/20" : "bg-muted/20"
              }`}>
                <Target className={`w-6 h-6 ${isEnabled ? "text-emerald-400" : "text-muted-foreground/50"}`} />
              </div>

              <div className="text-center">
                <div className={`text-sm font-semibold ${isEnabled ? "text-emerald-400" : "text-muted-foreground/70"}`}>
                  {isEnabled ? "Gatilho ATIVO" : "Gatilho inativo"}
                </div>
                <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                  {isEnabled
                    ? `${status?.symbolCount ?? 0} símbolos monitorados`
                    : "Ative para começar monitoramento"}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-[11px] text-muted-foreground/60">
                  {isEnabled ? "Ativo" : "Inativo"}
                </span>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={handleToggle}
                  disabled={isPending}
                />
              </div>

              {isEnabled && (
                <div className="grid grid-cols-2 gap-2 w-full text-center">
                  <div className="bg-emerald-500/10 rounded p-1.5">
                    <div className="text-[9px] text-muted-foreground/60">LONG armed</div>
                    <div className="text-sm font-bold text-emerald-400">{status?.armedLong ?? 0}</div>
                  </div>
                  <div className="bg-rose-500/10 rounded p-1.5">
                    <div className="text-[9px] text-muted-foreground/60">SHORT armed</div>
                    <div className="text-sm font-bold text-rose-400">{status?.armedShort ?? 0}</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* How it works */}
        <Card className="border-border/20 bg-card/5">
          <CardContent className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground/70">
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
                <span>Snapshot captura o <strong>preço de referência</strong> de cada símbolo</span>
              </div>
              <div className="w-3 h-px bg-border/40 hidden sm:block" />
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
                <span>Se cair <strong>{longDropPct}%</strong> → <strong className="text-emerald-400">LONG</strong>; TP = volta ao ref</span>
              </div>
              <div className="w-3 h-px bg-border/40 hidden sm:block" />
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-rose-500/20 text-rose-400 text-[10px] font-bold flex items-center justify-center shrink-0">3</span>
                <span>Se subir <strong>{shortRisePct}%</strong> → <strong className="text-rose-400">SHORT</strong>; TP = volta ao ref</span>
              </div>
              <div className="w-3 h-px bg-border/40 hidden sm:block" />
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold flex items-center justify-center shrink-0">4</span>
                <span>Cooldown <strong>{cooldownMin}min</strong> entre disparos por símbolo</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Symbol states table */}
        {isEnabled && status && status.symbols.length > 0 && (
          <Card className="border-border/20 bg-card/10">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Zap className="w-4 h-4 text-primary" />
                  Monitor por símbolo
                  <Badge variant="outline" className="text-[10px]">{status.symbols.length}</Badge>
                </CardTitle>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-500/60" />
                    LONG {status.armedLong}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-rose-500/60" />
                    SHORT {status.armedShort}
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-1.5">
              {status.symbols.map((s) => (
                <SymbolRow
                  key={s.symbol}
                  s={s}
                  onReset={(sym) => resetMut.mutate(sym)}
                />
              ))}
            </CardContent>
          </Card>
        )}

        {!isEnabled && (
          <Card className="border-border/20 bg-card/5">
            <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
              <Target className="w-10 h-10 text-muted-foreground/20" />
              <div className="text-center">
                <div className="text-sm text-muted-foreground/60 font-medium">Gatilho inativo</div>
                <div className="text-[11px] text-muted-foreground/40 mt-1">
                  Configure os parâmetros acima e ative para começar o monitoramento.
                  <br />O sniper VST precisa estar rodando para que as ordens sejam executadas.
                </div>
              </div>
              <Button
                size="sm"
                className="mt-2 h-8 px-4 text-xs"
                onClick={() => handleToggle(true)}
                disabled={isPending}
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Ativar Gatilho
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
