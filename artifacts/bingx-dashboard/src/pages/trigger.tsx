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
  useNativeTriggerStatus,
  type TriggerSymbolState,
  type TriggerStatus,
  type NativeTriggerSymbol,
  type NativePendingOrder,
} from "@/api-client";
import {
  Target,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  AlertTriangle,
  Camera,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Clock,
  Zap,
  ArrowDown,
  ArrowUp,
  Activity,
  Settings,
  Eye,
  Grid3X3,
  Lock,
  Layers,
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
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m atrás`;
  return `${Math.floor(m / 60)}h atrás`;
}

function fmtTtl(ms: number): string {
  if (ms <= 0) return "expirado";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 > 0 ? ` ${s % 60}s` : ""}`;
}

// ── Old trigger strategy components ──────────────────────────────────────────

function ArmedCard({ s, side, onReset }: {
  s: TriggerSymbolState;
  side: "LONG" | "SHORT";
  onReset: (sym: string) => void;
}) {
  const isLong = side === "LONG";
  const triggerPrice = isLong ? s.longTriggerPrice : s.shortTriggerPrice;
  const tpPct = isLong ? s.longTpPct : s.shortTpPct;
  const deviationPct = isLong ? s.dropPct : s.risePct;
  const firedAt = isLong ? s.longFiredAt : s.shortFiredAt;
  const progress = Math.min(100, (deviationPct / (tpPct || 1)) * 100);
  const token = s.symbol.replace("-USDT", "");
  const isFired = !!firedAt;

  return (
    <div className={`relative rounded-xl border overflow-hidden ${
      isFired
        ? isLong
          ? "border-emerald-400/40 bg-emerald-950/30"
          : "border-rose-400/40 bg-rose-950/30"
        : isLong
          ? "border-emerald-500/25 bg-emerald-950/20"
          : "border-rose-500/25 bg-rose-950/20"
    }`}>
      {isFired && (
        <div className={`absolute top-0 left-0 right-0 h-0.5 ${isLong ? "bg-emerald-400" : "bg-rose-400"}`} />
      )}

      <div className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              isLong ? "bg-emerald-500/20" : "bg-rose-500/20"
            }`}>
              {isLong
                ? <TrendingUp className="w-4 h-4 text-emerald-400" />
                : <TrendingDown className="w-4 h-4 text-rose-400" />
              }
            </div>
            <div>
              <div className="text-base font-bold text-foreground font-mono">{token}</div>
              <div className={`text-[10px] font-semibold tracking-wider ${isLong ? "text-emerald-400" : "text-rose-400"}`}>
                {side} {isFired ? "· DISPARADO" : "· ARMADO"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {isFired ? (
              <Badge className={`text-[9px] px-1.5 py-0 ${
                isLong
                  ? "bg-emerald-400/20 text-emerald-300 border-emerald-400/30"
                  : "bg-rose-400/20 text-rose-300 border-rose-400/30"
              }`}>
                <Zap className="w-2.5 h-2.5 mr-0.5" />DISPARADO
              </Badge>
            ) : (
              <Badge className={`text-[9px] px-1.5 py-0 ${
                isLong
                  ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
                  : "bg-rose-500/15 text-rose-400 border-rose-500/25"
              }`}>
                <Activity className="w-2.5 h-2.5 mr-0.5" />ARMADO
              </Badge>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="bg-black/20 rounded-lg p-2.5">
            <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">
              Preço de Entrada
            </div>
            <div className="text-lg font-bold font-mono text-foreground">
              {fmtPrice(triggerPrice)}
            </div>
            <div className="text-[9px] text-muted-foreground/50">USDT</div>
          </div>
          <div className="bg-black/20 rounded-lg p-2.5">
            <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">
              Preço Atual
            </div>
            <div className="text-lg font-bold font-mono text-foreground">
              {fmtPrice(s.currentPrice)}
            </div>
            <div className={`text-[9px] flex items-center gap-0.5 ${isLong ? "text-emerald-400" : "text-rose-400"}`}>
              {isLong ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />}
              {isLong ? "−" : "+"}{fmt(deviationPct)}% do ref
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground/60">Referência</span>
            <span className="font-mono text-foreground/80">{fmtPrice(s.referencePrice)}</span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground/60">TP alvo</span>
            <span className={`font-mono font-semibold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>
              {fmtPrice(s.referencePrice)} (+{fmt(tpPct)}%)
            </span>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-[9px] text-muted-foreground/50">
              <span>Progresso ao gatilho</span>
              <span>{fmt(progress, 0)}%</span>
            </div>
            <div className="h-1.5 bg-black/30 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isFired
                    ? isLong ? "bg-emerald-400" : "bg-rose-400"
                    : isLong ? "bg-emerald-500/70" : "bg-rose-500/70"
                }`}
                style={{ width: `${Math.max(2, progress)}%` }}
              />
            </div>
          </div>
        </div>

        {firedAt && (
          <div className="mt-3 pt-2.5 border-t border-white/5 flex items-center justify-between">
            <div className={`text-[10px] flex items-center gap-1 ${isLong ? "text-emerald-400/70" : "text-rose-400/70"}`}>
              <Clock className="w-3 h-3" />Disparado {fmtAgo(firedAt)}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-2 text-[9px] text-muted-foreground/50 hover:text-foreground/70"
              onClick={() => onReset(s.symbol)}
            >
              <RotateCcw className="w-2.5 h-2.5 mr-1" />Reset
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function SymbolRow({ s, onReset }: { s: TriggerSymbolState; onReset: (sym: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const longPct = Math.min(100, (s.dropPct / (s.longTpPct || 1)) * 100);
  const shortPct = Math.min(100, (s.risePct / (s.shortTpPct || 1)) * 100);
  const token = s.symbol.replace("-USDT", "");

  return (
    <div className="border border-border/15 rounded-lg bg-card/5 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/8 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-mono text-xs font-semibold text-foreground/85 w-20 shrink-0">{token}</span>

        <div className="flex items-center gap-1.5 shrink-0 w-32">
          <span className={`text-[10px] font-mono tabular-nums ${s.dropPct >= 0.1 ? "text-emerald-400" : "text-muted-foreground/35"}`}>
            ▼{fmt(s.dropPct)}%
          </span>
          <span className="text-[9px] text-muted-foreground/25">/</span>
          <span className={`text-[10px] font-mono tabular-nums ${s.risePct >= 0.1 ? "text-rose-400" : "text-muted-foreground/35"}`}>
            ▲{fmt(s.risePct)}%
          </span>
        </div>

        <div className="flex-1 flex items-center gap-1.5">
          {s.longArmed && (
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/25 text-[9px] px-1.5 py-0 h-4">
              <Zap className="w-2 h-2 mr-0.5" />LONG
            </Badge>
          )}
          {s.shortArmed && (
            <Badge className="bg-rose-500/15 text-rose-400 border-rose-500/25 text-[9px] px-1.5 py-0 h-4">
              <Zap className="w-2 h-2 mr-0.5" />SHORT
            </Badge>
          )}
          {!s.longArmed && !s.shortArmed && (
            <span className="text-[9px] text-muted-foreground/35">monitorando</span>
          )}
        </div>

        <div className="hidden sm:flex items-center gap-3 text-[9px] text-muted-foreground/45 shrink-0">
          <span>ref <span className="font-mono">{fmtPrice(s.referencePrice)}</span></span>
          <span>{s.secondsSinceSnapshot}s</span>
        </div>

        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground/30 shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground/30 shrink-0" />}
      </div>

      {expanded && (
        <div className="border-t border-border/10 px-3 py-3 bg-black/10">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="space-y-1.5">
              <div className="text-[9px] font-semibold text-emerald-400/70 uppercase tracking-wider flex items-center gap-1">
                <TrendingUp className="w-3 h-3" />LONG Gate
              </div>
              <div className="space-y-0.5 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground/55">Entrada</span>
                  <span className="font-mono text-foreground/80">{fmtPrice(s.longTriggerPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground/55">TP alvo</span>
                  <span className="font-mono text-emerald-400">{fmtPrice(s.referencePrice)} (+{fmt(s.longTpPct)}%)</span>
                </div>
              </div>
              <div className="h-1 bg-border/20 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500/60 transition-all duration-500" style={{ width: `${Math.max(0, longPct)}%` }} />
              </div>
              {s.longFiredAt && (
                <div className="text-[9px] text-emerald-400/50 flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" />Disparado {fmtAgo(s.longFiredAt)}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-[9px] font-semibold text-rose-400/70 uppercase tracking-wider flex items-center gap-1">
                <TrendingDown className="w-3 h-3" />SHORT Gate
              </div>
              <div className="space-y-0.5 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground/55">Entrada</span>
                  <span className="font-mono text-foreground/80">{fmtPrice(s.shortTriggerPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground/55">TP alvo</span>
                  <span className="font-mono text-rose-400">{fmtPrice(s.referencePrice)} (+{fmt(s.shortTpPct)}%)</span>
                </div>
              </div>
              <div className="h-1 bg-border/20 rounded-full overflow-hidden">
                <div className="h-full bg-rose-500/60 transition-all duration-500" style={{ width: `${Math.max(0, shortPct)}%` }} />
              </div>
              {s.shortFiredAt && (
                <div className="text-[9px] text-rose-400/50 flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" />Disparado {fmtAgo(s.shortFiredAt)}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-border/10">
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-muted-foreground/50">Atual</span>
              <span className="font-mono text-foreground/75">{fmtPrice(s.currentPrice)}</span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-2 text-[9px] text-muted-foreground/45 hover:text-foreground/70"
              onClick={(e) => { e.stopPropagation(); onReset(s.symbol); }}
            >
              <RotateCcw className="w-2.5 h-2.5 mr-1" />Reset ref
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tail Hunter Native Grid components ────────────────────────────────────────

function PendingOrderRow({ o }: { o: NativePendingOrder }) {
  const isLong = o.direction === "LONG";
  const token = o.symbol.replace("-USDT", "");
  const ttlPct = Math.min(100, (o.ttlRemainingMs / (o.expiresAt - o.armedAt)) * 100);

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
      isLong
        ? "border-emerald-500/20 bg-emerald-950/15"
        : "border-rose-500/20 bg-rose-950/15"
    }`}>
      <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${
        isLong ? "bg-emerald-500/20" : "bg-rose-500/20"
      }`}>
        {isLong
          ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
          : <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
        }
      </div>
      <div className="font-mono text-xs font-bold text-foreground/85 w-16 shrink-0">{token}</div>
      <div className={`text-[10px] font-semibold shrink-0 ${isLong ? "text-emerald-400" : "text-rose-400"}`}>
        {o.direction}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-mono text-foreground/75">{fmtPrice(o.triggerPrice)}</div>
        {o.sectorCluster && (
          <div className="text-[9px] text-muted-foreground/40 truncate">{o.sectorCluster}</div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className={`text-[9px] font-mono ${o.ttlRemainingMs < 30000 ? "text-amber-400" : "text-muted-foreground/50"}`}>
          {fmtTtl(o.ttlRemainingMs)}
        </div>
        <div className="w-16 h-0.5 bg-black/30 rounded-full mt-1 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${
              ttlPct < 20 ? "bg-amber-400" : isLong ? "bg-emerald-500/70" : "bg-rose-500/70"
            }`}
            style={{ width: `${Math.max(0, ttlPct)}%` }}
          />
        </div>
      </div>
      <div className="text-[9px] text-muted-foreground/35 shrink-0">{fmtAgo(o.armedAt)}</div>
    </div>
  );
}

function NativeSymbolCard({ sym }: { sym: NativeTriggerSymbol }) {
  const [expanded, setExpanded] = useState(false);
  const token = sym.symbol.replace("-USDT", "");
  const movePct = sym.recentMovePct;
  const isDropping = movePct < 0;
  const isPumping = movePct > 0;
  const inCooldownLong = sym.longCooldownMs > 0;
  const inCooldownShort = sym.shortCooldownMs > 0;

  const absMov = Math.abs(movePct);

  return (
    <div className="border border-border/15 rounded-lg bg-card/5 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/8 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-mono text-xs font-semibold text-foreground/85 w-16 shrink-0">{token}</span>

        <div className={`flex items-center gap-0.5 shrink-0 w-20 text-[10px] font-mono tabular-nums ${
          isDropping ? "text-emerald-400" : isPumping ? "text-rose-400" : "text-muted-foreground/40"
        }`}>
          {isDropping ? <ArrowDown className="w-2.5 h-2.5" /> : isPumping ? <ArrowUp className="w-2.5 h-2.5" /> : null}
          {movePct >= 0 ? "+" : ""}{fmt(movePct)}%
        </div>

        <div className="flex-1 flex items-center gap-1.5">
          {sym.wouldFireLong && (
            <Badge className="bg-emerald-400/20 text-emerald-300 border-emerald-400/30 text-[9px] px-1.5 py-0 h-4">
              <Zap className="w-2 h-2 mr-0.5" />LONG FIRE
            </Badge>
          )}
          {sym.wouldFireShort && (
            <Badge className="bg-rose-400/20 text-rose-300 border-rose-400/30 text-[9px] px-1.5 py-0 h-4">
              <Zap className="w-2 h-2 mr-0.5" />SHORT FIRE
            </Badge>
          )}
          {inCooldownLong && (
            <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/25 text-[9px] px-1.5 py-0 h-4">
              <Clock className="w-2 h-2 mr-0.5" />CD-L {fmtTtl(sym.longCooldownMs)}
            </Badge>
          )}
          {inCooldownShort && (
            <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/25 text-[9px] px-1.5 py-0 h-4">
              <Clock className="w-2 h-2 mr-0.5" />CD-S {fmtTtl(sym.shortCooldownMs)}
            </Badge>
          )}
          {!sym.wouldFireLong && !sym.wouldFireShort && !inCooldownLong && !inCooldownShort && (
            <span className="text-[9px] text-muted-foreground/30">aguardando</span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[9px] text-muted-foreground/40 font-mono">{fmtPrice(sym.currentPrice)}</span>
        </div>

        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground/30 shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground/30 shrink-0" />}
      </div>

      {expanded && (
        <div className="border-t border-border/10 px-3 py-3 bg-black/10 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* LONG grid levels */}
            <div className="space-y-1.5">
              <div className="text-[9px] font-semibold text-emerald-400/70 uppercase tracking-wider flex items-center gap-1">
                <TrendingUp className="w-3 h-3" />LONG Grid ({sym.longGrid.length} níveis)
              </div>
              {sym.longGrid.length === 0 ? (
                <div className="text-[9px] text-muted-foreground/35">sem dados de candle</div>
              ) : (
                <div className="space-y-1">
                  {sym.longGrid.map((lvl) => {
                    const pct = Math.min(100, Math.max(0, (absMov / lvl.distancePct) * 100));
                    return (
                      <div key={lvl.level} className="bg-black/20 rounded p-1.5 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-emerald-400/60 font-semibold">L{lvl.level} · −{fmt(lvl.distancePct)}% · {Math.round(lvl.allocationFactor * 100)}%</span>
                          <span className="text-[9px] font-mono text-foreground/70">{fmtPrice(lvl.triggerPrice)}</span>
                        </div>
                        <div className="h-0.5 bg-border/20 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500/50 transition-all duration-500" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex justify-between text-[9px]">
                          <span className="text-muted-foreground/40">TP <span className="font-mono text-emerald-400/70">{fmtPrice(lvl.targetPrice)}</span></span>
                          <span className="text-muted-foreground/40">SL <span className="font-mono text-rose-400/70">{fmtPrice(lvl.stopPrice)}</span></span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SHORT grid levels */}
            <div className="space-y-1.5">
              <div className="text-[9px] font-semibold text-rose-400/70 uppercase tracking-wider flex items-center gap-1">
                <TrendingDown className="w-3 h-3" />SHORT Grid ({sym.shortGrid.length} níveis)
              </div>
              {sym.shortGrid.length === 0 ? (
                <div className="text-[9px] text-muted-foreground/35">sem dados de candle</div>
              ) : (
                <div className="space-y-1">
                  {sym.shortGrid.map((lvl) => {
                    const pct = Math.min(100, Math.max(0, (absMov / lvl.distancePct) * 100));
                    return (
                      <div key={lvl.level} className="bg-black/20 rounded p-1.5 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-rose-400/60 font-semibold">S{lvl.level} · +{fmt(lvl.distancePct)}% · {Math.round(lvl.allocationFactor * 100)}%</span>
                          <span className="text-[9px] font-mono text-foreground/70">{fmtPrice(lvl.triggerPrice)}</span>
                        </div>
                        <div className="h-0.5 bg-border/20 rounded-full overflow-hidden">
                          <div className="h-full bg-rose-500/50 transition-all duration-500" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex justify-between text-[9px]">
                          <span className="text-muted-foreground/40">TP <span className="font-mono text-emerald-400/70">{fmtPrice(lvl.targetPrice)}</span></span>
                          <span className="text-muted-foreground/40">SL <span className="font-mono text-rose-400/70">{fmtPrice(lvl.stopPrice)}</span></span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="pt-1.5 border-t border-border/10 flex items-center gap-4 text-[9px] text-muted-foreground/40">
            <span>Atual <span className="font-mono text-foreground/60">{fmtPrice(sym.currentPrice)}</span></span>
            <span>ATR <span className="font-mono">{fmt(sym.atrPct)}%</span></span>
            <span>Mov 5m <span className={`font-mono ${isDropping ? "text-emerald-400/60" : isPumping ? "text-rose-400/60" : ""}`}>{movePct >= 0 ? "+" : ""}{fmt(movePct)}%</span></span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TriggerPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [longDropPct, setLongDropPct] = useState("1.74");
  const [shortRisePct, setShortRisePct] = useState("3.16");
  const [slPct, setSlPct] = useState("0.55");
  const [cooldownMin, setCooldownMin] = useState("5");
  const [showConfig, setShowConfig] = useState(false);

  const { data: status, isLoading, refetch } = useQuery<TriggerStatus>({
    queryKey: getTriggerStatusQueryKey(),
    queryFn: getTriggerStatus,
    refetchInterval: 3000,
  });

  const { data: nativeStatus, isLoading: nativeLoading, refetch: nativeRefetch } = useNativeTriggerStatus();

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

  const armedSymbols = (status?.symbols ?? []).filter(s => s.longArmed || s.shortArmed || s.longFiredAt || s.shortFiredAt);
  const monitoringSymbols = (status?.symbols ?? []).filter(s => !s.longArmed && !s.shortArmed && !s.longFiredAt && !s.shortFiredAt);

  const armedCards: Array<{ s: TriggerSymbolState; side: "LONG" | "SHORT" }> = [];
  for (const s of (status?.symbols ?? [])) {
    if (s.longArmed || s.longFiredAt) armedCards.push({ s, side: "LONG" });
    if (s.shortArmed || s.shortFiredAt) armedCards.push({ s, side: "SHORT" });
  }

  const nativeSymbolsFireable = (nativeStatus?.symbols ?? []).filter(s => s.wouldFireLong || s.wouldFireShort);
  const muxLocked = nativeStatus?.muxLock?.locked ?? false;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isEnabled ? "bg-emerald-500/20" : "bg-muted/15"}`}>
              <Target className={`w-4 h-4 ${isEnabled ? "text-emerald-400" : "text-muted-foreground/50"}`} />
            </div>
            <div>
              <h1 className="text-base font-bold text-foreground flex items-center gap-2">
                Estratégia Gatilho
                {isEnabled && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-normal bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 rounded-full px-2 py-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    ATIVO · {status?.symbolCount ?? 0} símbolos
                  </span>
                )}
              </h1>
              <p className="text-[10px] text-muted-foreground/55">
                Dispara entrada por desvio de preço do ponto de referência
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => { refetch(); nativeRefetch(); }}
              disabled={isLoading || nativeLoading}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${(isLoading || nativeLoading) ? "animate-spin" : ""}`} />
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
                {snapshotMut.isPending ? "Capturando..." : "Re-snapshot"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className={`h-7 px-2 text-[11px] ${showConfig ? "bg-muted/20" : ""}`}
              onClick={() => setShowConfig(v => !v)}
            >
              <Settings className="w-3.5 h-3.5 mr-1" />Config
            </Button>
          </div>
        </div>

        {/* ── Config (collapsible) ── */}
        {showConfig && (
          <Card className="border-border/20 bg-card/8">
            <CardContent className="px-4 py-4">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
                <div>
                  <label className="block text-[9px] text-muted-foreground/60 mb-1 uppercase tracking-wider">
                    <TrendingUp className="w-2.5 h-2.5 inline mr-0.5 text-emerald-400" />
                    LONG drop %
                  </label>
                  <input type="number" step="0.1" min="0.1" max="20"
                    className="w-full h-7 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={longDropPct} onChange={(e) => setLongDropPct(e.target.value)} disabled={isEnabled} />
                </div>
                <div>
                  <label className="block text-[9px] text-muted-foreground/60 mb-1 uppercase tracking-wider">
                    <TrendingDown className="w-2.5 h-2.5 inline mr-0.5 text-rose-400" />
                    SHORT rise %
                  </label>
                  <input type="number" step="0.1" min="0.1" max="20"
                    className="w-full h-7 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={shortRisePct} onChange={(e) => setShortRisePct(e.target.value)} disabled={isEnabled} />
                </div>
                <div>
                  <label className="block text-[9px] text-muted-foreground/60 mb-1 uppercase tracking-wider">Stop Loss %</label>
                  <input type="number" step="0.05" min="0.1" max="10"
                    className="w-full h-7 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={slPct} onChange={(e) => setSlPct(e.target.value)} disabled={isEnabled} />
                </div>
                <div>
                  <label className="block text-[9px] text-muted-foreground/60 mb-1 uppercase tracking-wider">Cooldown (min)</label>
                  <input type="number" step="1" min="1" max="60"
                    className="w-full h-7 px-2 text-xs bg-background/50 border border-border/30 rounded text-foreground focus:outline-none focus:border-primary/50"
                    value={cooldownMin} onChange={(e) => setCooldownMin(e.target.value)} disabled={isEnabled} />
                </div>
                <div className="flex flex-col items-center justify-end gap-1.5">
                  <Switch checked={isEnabled} onCheckedChange={handleToggle} disabled={isPending} />
                  <span className={`text-[9px] ${isEnabled ? "text-emerald-400" : "text-muted-foreground/50"}`}>
                    {isEnabled ? "Ativo" : "Inativo"}
                  </span>
                </div>
              </div>
              {isEnabled && (
                <div className="mt-3 text-[10px] text-amber-400/70 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />Desative para alterar parâmetros.
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Inactive state ── */}
        {!isEnabled && (
          <Card className="border-border/20 bg-card/5">
            <CardContent className="flex flex-col items-center justify-center py-14 gap-4">
              <div className="w-14 h-14 rounded-full bg-muted/15 flex items-center justify-center">
                <Target className="w-7 h-7 text-muted-foreground/30" />
              </div>
              <div className="text-center">
                <div className="text-sm font-semibold text-muted-foreground/60">Gatilho inativo</div>
                <div className="text-[11px] text-muted-foreground/40 mt-1">
                  Clique em <strong>Config</strong> e ative o switch para iniciar o monitoramento
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={false} onCheckedChange={handleToggle} disabled={isPending} />
                <span className="text-[11px] text-muted-foreground/50">Ativar</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Active: gatilhos armados / disparados ── */}
        {isEnabled && (
          <>
            {/* Status bar */}
            <div className="grid grid-cols-4 gap-3">
              <Card className="border-border/15 bg-card/8">
                <CardContent className="px-3 py-2.5 text-center">
                  <div className="text-[9px] text-muted-foreground/50 uppercase tracking-wider">Monitorando</div>
                  <div className="text-xl font-bold text-foreground mt-0.5">{status?.symbolCount ?? 0}</div>
                  <div className="text-[9px] text-muted-foreground/40">símbolos</div>
                </CardContent>
              </Card>
              <Card className="border-emerald-500/20 bg-emerald-950/15">
                <CardContent className="px-3 py-2.5 text-center">
                  <div className="text-[9px] text-emerald-400/60 uppercase tracking-wider">LONG armado</div>
                  <div className="text-xl font-bold text-emerald-400 mt-0.5">{status?.armedLong ?? 0}</div>
                  <div className="text-[9px] text-emerald-400/40">gatilhos</div>
                </CardContent>
              </Card>
              <Card className="border-rose-500/20 bg-rose-950/15">
                <CardContent className="px-3 py-2.5 text-center">
                  <div className="text-[9px] text-rose-400/60 uppercase tracking-wider">SHORT armado</div>
                  <div className="text-xl font-bold text-rose-400 mt-0.5">{status?.armedShort ?? 0}</div>
                  <div className="text-[9px] text-rose-400/40">gatilhos</div>
                </CardContent>
              </Card>
              <Card className="border-border/15 bg-card/8">
                <CardContent className="px-3 py-2.5 text-center">
                  <div className="text-[9px] text-muted-foreground/50 uppercase tracking-wider">Queda / Alta</div>
                  <div className="text-sm font-bold text-foreground mt-0.5 tabular-nums">
                    <span className="text-emerald-400">{longDropPct}%</span>
                    <span className="text-muted-foreground/30 mx-1">/</span>
                    <span className="text-rose-400">{shortRisePct}%</span>
                  </div>
                  <div className="text-[9px] text-muted-foreground/40">disparo</div>
                </CardContent>
              </Card>
            </div>

            {/* Gatilhos armados / disparados */}
            {armedCards.length > 0 ? (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="w-4 h-4 text-amber-400" />
                  <h2 className="text-sm font-semibold text-foreground">Gatilhos Ativos</h2>
                  <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
                    {armedCards.length}
                  </Badge>
                  <div className="flex-1 h-px bg-border/15" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {armedCards.map(({ s, side }) => (
                    <ArmedCard
                      key={`${s.symbol}-${side}`}
                      s={s}
                      side={side}
                      onReset={(sym) => resetMut.mutate(sym)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <Card className="border-border/15 bg-card/5">
                <CardContent className="flex items-center justify-center py-8 gap-3">
                  <Eye className="w-5 h-5 text-muted-foreground/25" />
                  <div className="text-[12px] text-muted-foreground/45">
                    Nenhum gatilho armado — monitorando desvios de preço...
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Monitor por símbolo */}
            {status && status.symbols.length > 0 && (
              <Card className="border-border/15 bg-card/8">
                <CardHeader className="pb-2 pt-3.5 px-4">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-xs font-semibold flex items-center gap-2 text-muted-foreground/70">
                      <Activity className="w-3.5 h-3.5" />
                      Monitor por símbolo
                      <Badge variant="outline" className="text-[9px]">{status.symbols.length}</Badge>
                    </CardTitle>
                    <div className="flex items-center gap-3 text-[9px] text-muted-foreground/40">
                      <span>LONG drop {longDropPct}%</span>
                      <span>SHORT rise {shortRisePct}%</span>
                      <span>SL {slPct}%</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-1">
                  {armedSymbols.map((s) => (
                    <SymbolRow key={s.symbol} s={s} onReset={(sym) => resetMut.mutate(sym)} />
                  ))}
                  {armedSymbols.length > 0 && monitoringSymbols.length > 0 && (
                    <div className="flex items-center gap-2 py-1">
                      <div className="flex-1 h-px bg-border/10" />
                      <span className="text-[9px] text-muted-foreground/30">aguardando desvio</span>
                      <div className="flex-1 h-px bg-border/10" />
                    </div>
                  )}
                  {monitoringSymbols.map((s) => (
                    <SymbolRow key={s.symbol} s={s} onReset={(sym) => resetMut.mutate(sym)} />
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            Tail Hunter Grid — Motor Nativo de Gatilhos (sempre visível)
        ════════════════════════════════════════════════════════════════════ */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Grid3X3 className="w-4 h-4 text-violet-400" />
            <h2 className="text-sm font-semibold text-foreground">Tail Hunter Grid</h2>
            <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-400">
              Motor Nativo
            </Badge>
            {muxLocked && (
              <Badge className="text-[9px] bg-amber-500/15 text-amber-400 border-amber-500/25">
                <Lock className="w-2 h-2 mr-0.5" />MUX LOCK
              </Badge>
            )}
            <div className="flex-1 h-px bg-border/15" />
            {nativeStatus?.config && (
              <span className="text-[9px] text-muted-foreground/40 shrink-0">
                L −{fmt(nativeStatus.config.longDetectPct)}% · S +{fmt(nativeStatus.config.shortDetectPct)}%
              </span>
            )}
          </div>

          {/* Pending orders summary */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Card className="border-border/15 bg-card/8">
              <CardContent className="px-3 py-2.5 text-center">
                <div className="text-[9px] text-muted-foreground/50 uppercase tracking-wider">Ordens Pending</div>
                <div className="text-xl font-bold text-foreground mt-0.5">{nativeStatus?.pendingOrders.length ?? 0}</div>
                <div className="text-[9px] text-muted-foreground/40">na BingX</div>
              </CardContent>
            </Card>
            <Card className="border-emerald-500/20 bg-emerald-950/15">
              <CardContent className="px-3 py-2.5 text-center">
                <div className="text-[9px] text-emerald-400/60 uppercase tracking-wider">LONG pending</div>
                <div className="text-xl font-bold text-emerald-400 mt-0.5">{nativeStatus?.pendingLong ?? 0}</div>
                <div className="text-[9px] text-emerald-400/40">entradas</div>
              </CardContent>
            </Card>
            <Card className="border-rose-500/20 bg-rose-950/15">
              <CardContent className="px-3 py-2.5 text-center">
                <div className="text-[9px] text-rose-400/60 uppercase tracking-wider">SHORT pending</div>
                <div className="text-xl font-bold text-rose-400 mt-0.5">{nativeStatus?.pendingShort ?? 0}</div>
                <div className="text-[9px] text-rose-400/40">entradas</div>
              </CardContent>
            </Card>
          </div>

          {/* Pending orders list */}
          {(nativeStatus?.pendingOrders.length ?? 0) > 0 ? (
            <Card className="border-border/15 bg-card/8 mb-3">
              <CardHeader className="pb-2 pt-3.5 px-4">
                <CardTitle className="text-xs font-semibold flex items-center gap-2 text-muted-foreground/70">
                  <Layers className="w-3.5 h-3.5 text-violet-400" />
                  Ordens LIMIT no BingX
                  <Badge variant="outline" className="text-[9px] border-violet-500/30 text-violet-400">
                    {nativeStatus!.pendingOrders.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-1.5">
                {nativeStatus!.pendingOrders.map((o) => (
                  <PendingOrderRow key={o.id} o={o} />
                ))}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-border/15 bg-card/5 mb-3">
              <CardContent className="flex items-center justify-center py-6 gap-3">
                <Eye className="w-4 h-4 text-muted-foreground/25" />
                <div className="text-[11px] text-muted-foreground/40">
                  Nenhuma ordem LIMIT pendente no BingX
                </div>
              </CardContent>
            </Card>
          )}

          {/* Symbols with wouldFire first */}
          {nativeSymbolsFireable.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] font-semibold text-amber-400">Prontos para disparar</span>
                <Badge className="text-[9px] bg-amber-500/15 text-amber-400 border-amber-500/25">{nativeSymbolsFireable.length}</Badge>
              </div>
              <div className="space-y-1">
                {nativeSymbolsFireable.map((sym) => (
                  <NativeSymbolCard key={sym.symbol} sym={sym} />
                ))}
              </div>
            </div>
          )}

          {/* All symbols grid */}
          <Card className="border-border/15 bg-card/8">
            <CardHeader className="pb-2 pt-3.5 px-4">
              <CardTitle className="text-xs font-semibold flex items-center gap-2 text-muted-foreground/70">
                <Activity className="w-3.5 h-3.5" />
                Níveis de Grid por Símbolo
                <Badge variant="outline" className="text-[9px]">{nativeStatus?.symbols.length ?? 0}</Badge>
                <span className="text-[9px] text-muted-foreground/35 font-normal ml-1">
                  LONG: L1 −10% L2 −11% L3 −12% · SHORT: S1 +20% S2 +21% S3 +22% S4 +24%
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-1">
              {nativeLoading && (nativeStatus?.symbols.length ?? 0) === 0 ? (
                <div className="flex items-center justify-center py-8 text-[11px] text-muted-foreground/40">
                  <RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" />Carregando dados de candle...
                </div>
              ) : (nativeStatus?.symbols ?? []).length === 0 ? (
                <div className="flex items-center justify-center py-8 text-[11px] text-muted-foreground/40">
                  Nenhum símbolo configurado
                </div>
              ) : (
                (nativeStatus?.symbols ?? [])
                  .filter(s => !s.wouldFireLong && !s.wouldFireShort)
                  .map((sym) => (
                    <NativeSymbolCard key={sym.symbol} sym={sym} />
                  ))
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </AppShell>
  );
}
