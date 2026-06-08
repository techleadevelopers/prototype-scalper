import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  useGetBingXTicker,
  useGetBotConfig,
  useGetBotEdge,
  useGetBotScan,
  useGetDemoStatus,
  useConnectDemo,
  useDisconnectDemo,
  usePlaceDemoOrder,
  useCloseDemoPosition,
  getGetBingXTickerQueryKey,
  getGetBotConfigQueryKey,
  getGetBotEdgeQueryKey,
  getGetBotScanQueryKey,
  getGetDemoStatusQueryKey,
} from "@/api-client";
import AppShell from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/api-url";
import { fetchDemoPositions, type DemoPosition } from "@/lib/demo-live";
import {
  FlaskConical, ShieldCheck, ShieldOff,
  Zap, Radio, CheckCircle2, XCircle, ArrowRight, Loader2,
  TrendingUp, TrendingDown, DollarSign, LogOut, Play, Square,
  Clock, Target, AlertTriangle, RefreshCw, Shield,
  BarChart3, Crosshair, ChevronDown, ChevronUp, Award, Layers,
} from "lucide-react";

interface LogEntry {
  id: string;
  ts: number;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  placed: boolean;
  observationMode: boolean;
  gateRejects: string[];
  message: string;
  orderId?: string | null;
}

const AUTO_FIRE_MAX_PER_CYCLE = 1;
const AUTO_FIRE_MIN_INTERVAL_MS = 12_000;
const AUTO_FIRE_SYMBOL_COOLDOWN_MS = 90_000;

interface DemoRiskClose {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  reason: string;
  pnl: number;
  orderId: string | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
}

async function runDemoRiskCheck(): Promise<{ checked: number; closed: DemoRiskClose[] }> {
  const response = await fetch(apiUrl("/api/demo/risk-check"), {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error("Failed to run demo risk check");
  return response.json() as Promise<{ checked: number; closed: DemoRiskClose[] }>;
}

function GateTag({ reject }: { reject: string }) {
  const label = reject.split(":")[0];
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">
      {label}
    </span>
  );
}

function getOrderErrorLog(error: unknown): { gateRejects: string[]; message: string } {
  const fallback = { gateRejects: ["REQUEST_ERROR"], message: "Request failed" };
  if (!error || typeof error !== "object") return fallback;

  const apiError = error as { data?: unknown; message?: unknown; status?: unknown };
  const data = apiError.data;
  if (!data || typeof data !== "object") {
    const message = typeof apiError.message === "string" ? apiError.message : fallback.message;
    return { gateRejects: fallback.gateRejects, message };
  }

  const payload = data as {
    gateRejects?: unknown;
    message?: unknown;
    error?: unknown;
  };
  const gateRejects = Array.isArray(payload.gateRejects)
    ? payload.gateRejects.filter((reject): reject is string => typeof reject === "string")
    : [];
  const message =
    typeof payload.message === "string" ? payload.message
      : typeof payload.error === "string" ? payload.error
        : typeof apiError.message === "string" ? apiError.message
          : fallback.message;

  return {
    gateRejects: gateRejects.length > 0 ? gateRejects : fallback.gateRejects,
    message,
  };
}

function ScanRow({
  symbol, positionSide, lastPrice, priceChangePct, gatePass, gateRejects,
  isToxic, isCandidate, ev, ewmaWinRate, samples,
  autoFire, onFire, firing,
}: {
  symbol: string; positionSide: string; lastPrice: string; priceChangePct: number;
  gatePass: boolean; gateRejects: string[]; isToxic: boolean; isCandidate: boolean;
  ev: number; ewmaWinRate: number; samples: number;
  autoFire: boolean; onFire: () => void; firing: boolean;
}) {
  const short = symbol.replace("-USDT", "").replace("-USD", "");
  const up = priceChangePct >= 0;
  const volatility = Math.min(11, Math.max(4, Math.abs(priceChangePct) * 1.1));
  const trendStep = up ? -0.42 : 0.42;
  const sparkY = Array.from({ length: 18 }, (_, i) => {
    const base = 18 + i * trendStep;
    const jag =
      (i % 2 === 0 ? -1 : 1) * volatility * 0.72 +
      (i % 5 === 0 ? -1 : 0.45) * volatility * 0.38;
    const wave = Math.sin(i * 2.35) * volatility * 0.35 + jag;
    return Math.min(27, Math.max(4, base + wave));
  });
  const sparkPoints = sparkY.map((y, i) => `${(i / (sparkY.length - 1)) * 100},${y}`).join(" ");
  const sparkArea = `0,30 ${sparkPoints} 100,30`;
  const chartPrimary = up ? "#22c55e" : "#ef4444";
  const chartSecondary = up ? "#67e8f9" : "#f97316";
  const chartGlow = up ? "drop-shadow(0 0 5px rgba(34,197,94,0.45))" : "drop-shadow(0 0 5px rgba(239,68,68,0.45))";

  const statusColor = isToxic ? "text-red-400"
    : isCandidate ? "text-green-400"
    : gatePass ? "text-yellow-400"
    : "text-muted-foreground";

  const statusLabel = isToxic ? "TOXIC"
    : isCandidate ? "READY"
    : gatePass ? "PASS"
    : "BLOCKED";

  return (
    <div className={`px-4 py-3 border-b border-border/15 last:border-0 transition-colors ${isCandidate && autoFire ? "bg-green-500/5" : ""}`}>
      <div className="flex items-center gap-3">
        {/* Symbol + side */}
        <div className="w-28 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              isToxic ? "bg-red-500" : isCandidate ? "bg-green-400 animate-pulse" : gatePass ? "bg-yellow-400" : "bg-muted-foreground/40"
            }`} />
            <span className="text-xs font-bold">{short}</span>
            <span className={`text-[10px] font-mono ml-0.5 ${positionSide === "LONG" ? "text-green-400" : "text-red-400"}`}>
              {positionSide === "LONG" ? "▲L" : "▼S"}
            </span>
          </div>
          <div className={`text-[10px] font-mono mt-0.5 ${up ? "text-green-400" : "text-red-400"}`}>
            {up ? "+" : ""}{priceChangePct.toFixed(2)}%
          </div>
        </div>

        {/* Gate status */}
        <div className="flex-1 min-w-0">
          {isCandidate ? (
            <div className="space-y-1.5 [&>svg:first-child]:hidden [&>span:nth-child(2)]:hidden [&>span:nth-child(3)]:hidden">
              <div className="flex items-center justify-between gap-2 text-[9px] font-mono">
                <span className={up ? "text-green-400" : "text-red-400"}>
                  {up ? "+" : ""}{priceChangePct.toFixed(2)}%
                </span>
                <span className="text-muted-foreground">
                  {samples > 0 ? `WR ${(ewmaWinRate * 100).toFixed(0)}% · EV ${ev.toFixed(3)}` : "no telemetry"}
                </span>
              </div>
              <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
              <span className="text-[10px] text-green-400 font-semibold">EDGE READY</span>
              {samples > 0 && (
                <span className="text-[9px] text-muted-foreground font-mono ml-1">
                  WR {(ewmaWinRate * 100).toFixed(0)}% · EV {ev.toFixed(3)}
                </span>
              )}
              <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="h-9 w-full overflow-visible">
                <defs>
                  <linearGradient id={`edge-fill-${symbol}-${positionSide}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chartPrimary} stopOpacity="0.34" />
                    <stop offset="72%" stopColor={chartPrimary} stopOpacity="0.08" />
                    <stop offset="100%" stopColor={chartPrimary} stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id={`edge-line-${symbol}-${positionSide}`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={chartPrimary} />
                    <stop offset="55%" stopColor={chartSecondary} />
                    <stop offset="100%" stopColor={chartPrimary} />
                  </linearGradient>
                </defs>
                <line x1="0" y1="29" x2="100" y2="29" stroke="rgba(148,163,184,0.16)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <polygon points={sparkArea} fill={`url(#edge-fill-${symbol}-${positionSide})`} />
                <polyline
                  points={sparkPoints}
                  fill="none"
                  stroke={`url(#edge-line-${symbol}-${positionSide})`}
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ filter: chartGlow }}
                />
                <circle
                  cx="100"
                  cy={sparkY[sparkY.length - 1]}
                  r="2.4"
                  fill={chartPrimary}
                  vectorEffect="non-scaling-stroke"
                  style={{ filter: chartGlow }}
                />
              </svg>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1 items-center">
              {gateRejects.slice(0, 3).map((r, i) => <GateTag key={i} reject={r} />)}
              {gateRejects.length > 3 && (
                <span className="text-[9px] text-muted-foreground">+{gateRejects.length - 3}</span>
              )}
            </div>
          )}
        </div>

        {/* Status badge */}
        <span className={`text-[10px] font-bold font-mono shrink-0 w-14 text-right ${statusColor}`}>
          {statusLabel}
        </span>

        {/* Fire button */}
        <Button
          size="sm"
          variant={isCandidate ? "default" : "outline"}
          disabled={!isCandidate || firing}
          onClick={onFire}
          className={`h-7 px-2.5 text-[11px] shrink-0 ${isCandidate ? "bg-green-600 hover:bg-green-500 text-white" : "opacity-30"}`}
        >
          {firing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          {!firing && <span className="ml-1">Fire</span>}
        </Button>
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false });
  const short = entry.symbol.replace("-USDT", "");
  return (
    <div className={`px-4 py-2.5 border-b border-border/10 last:border-0 flex items-start gap-3 ${
      entry.placed ? "bg-green-500/5" : entry.observationMode ? "" : "bg-red-500/5"
    }`}>
      <span className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5 w-16">{time}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold">{short}</span>
          <span className={`text-[10px] font-mono ${entry.positionSide === "LONG" ? "text-green-400" : "text-red-400"}`}>
            {entry.positionSide}
          </span>
          {entry.placed ? (
            <span className="text-[10px] bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded font-semibold">FILLED</span>
          ) : entry.observationMode ? (
            <span className="text-[10px] bg-muted/40 text-muted-foreground px-1.5 py-0.5 rounded">OBS</span>
          ) : (
            <span className="text-[10px] bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded font-semibold">BLOCKED</span>
          )}
          {entry.orderId && (
            <span className="text-[9px] font-mono text-muted-foreground truncate">#{entry.orderId}</span>
          )}
        </div>
        {entry.gateRejects.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {entry.gateRejects.map((r, i) => <GateTag key={i} reject={r} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function PositionRow({
  position,
  closing,
  onClose,
}: {
  position: DemoPosition;
  closing: boolean;
  onClose: () => void;
}) {
  const pnl = parseFloat(position.unrealizedProfit || "0");
  const qty = Math.abs(parseFloat(position.positionAmt || "0"));
  const short = position.symbol.replace("-USDT", "");
  const isLong = position.positionSide === "LONG";

  return (
    <div className="px-3 py-2.5 border-b border-border/10 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${pnl >= 0 ? "bg-green-400" : "bg-red-400"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold">{short}</span>
            <span className={`text-[10px] font-mono ${isLong ? "text-green-400" : "text-red-400"}`}>
              {position.positionSide}
            </span>
            <span className="text-[9px] text-muted-foreground font-mono">{position.leverage}x</span>
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 text-[9px] font-mono text-muted-foreground">
            <span>Qty {qty.toFixed(4)}</span>
            <span>Entry {parseFloat(position.entryPrice || "0").toFixed(4)}</span>
            <span>Mark {parseFloat(position.markPrice || "0").toFixed(4)}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-xs font-mono font-bold ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
            {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)}
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={closing}
            onClick={onClose}
            className="h-6 px-2 mt-1 text-[10px] text-muted-foreground hover:text-red-400"
          >
            {closing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Close"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MiniPositionRow({ position }: { position: DemoPosition }) {
  const pnl = parseFloat(position.unrealizedProfit || "0");
  const qty = Math.abs(parseFloat(position.positionAmt || "0"));
  const short = position.symbol.replace("-USDT", "");

  return (
    <div className="px-3 py-2 border-b border-border/10 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${pnl >= 0 ? "bg-green-400" : "bg-red-400"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold">{short}</span>
            <span className={`text-[9px] font-mono ${position.positionSide === "LONG" ? "text-green-400" : "text-red-400"}`}>
              {position.positionSide}
            </span>
            <span className="text-[9px] text-muted-foreground font-mono">qty {qty.toFixed(4)}</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-muted/30 overflow-hidden">
            <div
              className={`h-full rounded-full ${pnl >= 0
                ? "bg-gradient-to-r from-green-500 to-cyan-300"
                : "bg-gradient-to-r from-red-500 to-orange-300"}`}
              style={{ width: `${Math.min(100, Math.max(8, Math.abs(pnl) * 35))}%` }}
            />
          </div>
        </div>
        <span className={`text-[11px] font-mono font-bold shrink-0 ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
          {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)}
        </span>
      </div>
    </div>
  );
}

export default function DemoPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [autoFire, setAutoFire] = useState(false);
  const [firingSet, setFiringSet] = useState<Set<string>>(new Set());
  const [closingSet, setClosingSet] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<LogEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const autoFiredKeysRef = useRef<Set<string>>(new Set());
  const lastAutoFireAtRef = useRef(0);
  const symbolCooldownRef = useRef<Map<string, number>>(new Map());
  const riskClosingKeysRef = useRef<Set<string>>(new Set());
  const [sniperLoading, setSniperLoading] = useState(false);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const { data: btcTicker } = useGetBingXTicker(
    { symbol: "BTC-USDT" },
    { query: { refetchInterval: 5000, queryKey: getGetBingXTickerQueryKey({ symbol: "BTC-USDT" }) } }
  );

  const { data: config } = useGetBotConfig({
    query: { queryKey: getGetBotConfigQueryKey(), refetchInterval: 60000 },
  });

  const { data: demoStatus, refetch: refetchStatus } = useGetDemoStatus({
    query: {
      queryKey: getGetDemoStatusQueryKey(),
      refetchInterval: 3000,
      placeholderData: (previousData) => previousData,
    },
  });

  const {
    data: demoPositions = [],
    refetch: refetchDemoPositions,
  } = useQuery({
    queryKey: ["demo-positions"],
    queryFn: fetchDemoPositions,
    enabled: !!demoStatus?.connected,
    refetchInterval: 3000,
  });

  const { data: riskCheck } = useQuery({
    queryKey: ["demo-risk-check"],
    queryFn: runDemoRiskCheck,
    enabled: !!demoStatus?.connected,
    refetchInterval: 2000,
  });

  const { data: sniperStatus, refetch: refetchSniper } = useQuery({
    queryKey: ["demo-sniper-status"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/demo/sniper/status"), { credentials: "include" });
      if (!r.ok) return null;
      return r.json() as Promise<{
        running: boolean;
        startedAt: number | null;
        uptimeMs: number | null;
        cycleCount: number;
        totalPlaced: number;
        stopReason: string | null;
        lastCycleAt: number | null;
        openTrades: number;
        lastCycleSummary: {
          placed: number; skipped: number; scanned: number; btcRegime: string;
          placements: Array<{ symbol: string; positionSide: string; score: number; tier: number }>;
        } | null;
        config: { globalMax: number; perSymbolMax: number; cycleMs: number };
      }>;
    },
    refetchInterval: demoStatus?.connected ? 4000 : false,
    enabled: !!demoStatus?.connected,
  });

  const { data: campaignData, refetch: refetchCampaign } = useQuery({
    queryKey: ["demo-campaign"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/demo/campaign"), { credentials: "include" });
      if (!r.ok) return null;
      return r.json() as Promise<{
        summary: {
          totalTrades: number; totalWins: number; totalLosses: number;
          winRate: number; totalPnl: number; totalFees: number;
          maxDrawdown: number; symbolCount: number;
          bestSymbol: string | null; worstSymbol: string | null;
          sniperRunning: boolean; sniperOpenTrades: number;
        };
        symbols: Array<{
          symbol: string; trades: number; wins: number; losses: number;
          winRate: number; totalPnl: number; totalFees: number; totalGrossPnl: number;
          avgHoldMs: number; maxDrawdown: number; lastTradeAt: number;
          tpCount: number; slCount: number;
          entries: Array<{
            id: string; entryTime: number; exitTime: number;
            positionSide: string; entryPrice: number; exitPrice: number;
            realizedPnl: number; fee: number; grossPnl: number;
            exitReason: string; isWin: boolean; holdMs: number;
            btcRegime: string; estimated: boolean;
          }>;
        }>;
      }>;
    },
    refetchInterval: demoStatus?.connected ? 15000 : false,
    enabled: !!demoStatus?.connected,
  });

  const btcChange = btcTicker ? parseFloat(btcTicker.priceChangePercent) : 0;

  const { data: scan } = useGetBotScan(
    { btcChangePct: btcChange },
    {
      query: {
        queryKey: getGetBotScanQueryKey({ btcChangePct: btcChange }),
        refetchInterval: 8000,
        enabled: !!(demoStatus?.connected && (config?.allowedSymbols?.length ?? 0) > 0),
      },
    }
  );

  const { data: edge } = useGetBotEdge(
    { btcChangePct: btcChange, interval: "5m" },
    {
      query: {
        queryKey: getGetBotEdgeQueryKey({ btcChangePct: btcChange, interval: "5m" }),
        refetchInterval: 8000,
        enabled: !!(demoStatus?.connected && (config?.allowedSymbols?.length ?? 0) > 0),
      },
    }
  );

  const connectMutation = useConnectDemo();
  const disconnectMutation = useDisconnectDemo();
  const orderMutation = usePlaceDemoOrder();
  const closeMutation = useCloseDemoPosition();

  const demoConnected = demoStatus?.connected ?? false;
  const demoAccount = demoStatus as (typeof demoStatus & {
    equity?: string;
    usedMargin?: string;
    positionsConfirmed?: boolean;
  }) | undefined;

  const btcRegime = btcChange >= (config?.btcRegimeThresholdPct ?? 0.5) ? "BULL"
    : btcChange <= -(config?.btcRegimeThresholdPct ?? 0.5) ? "BEAR"
    : "NEUTRAL";

  function addLog(entry: Omit<LogEntry, "id" | "ts">) {
    setLog(prev => [{
      id: `${Date.now()}-${Math.random()}`,
      ts: Date.now(),
      ...entry,
    }, ...prev].slice(0, 200));
  }

  function handleConnect() {
    connectMutation.mutate(
      undefined,
      {
        onSuccess: (data) => {
          if (data.connected) {
            setAutoFire(true);
            autoFiredKeysRef.current.clear();
            toast({ title: "Demo VST ativado", description: `Auto-Fire ligado · Balance: ${data.balance ?? "?"} ${data.currency ?? "VST"}` });
            refetchStatus();
            handleSniperStart();
          } else {
            toast({ title: "Falha ao conectar", description: data.error ?? "Verifique se sua conta BingX está conectada", variant: "destructive" });
          }
        },
        onError: () => toast({ title: "Erro", description: "Não foi possível ativar o modo demo", variant: "destructive" }),
      }
    );
  }

  function handleDisconnect() {
    setAutoFire(false);
    autoFiredKeysRef.current.clear();
    disconnectMutation.mutate(undefined, {
      onSuccess: () => { toast({ title: "Demo disconnected" }); refetchStatus(); },
    });
  }

  async function handleSniperStart() {
    setSniperLoading(true);
    try {
      const r = await fetch(apiUrl("/api/demo/sniper/start"), { method: "POST", credentials: "include" });
      const data = await r.json() as { started?: boolean; running?: boolean; config?: { globalMax: number; cycleMs: number } };
      if (data.started || data.running) {
        toast({
          title: "Demo Sniper Autopilot iniciado",
          description: `Escaneando todos os símbolos a cada ${((data.config?.cycleMs ?? 30000) / 1000).toFixed(0)}s · Max ${data.config?.globalMax ?? 50} posições`,
        });
      }
      refetchSniper();
    } catch {
      toast({ title: "Erro", description: "Falha ao iniciar o sniper autopilot", variant: "destructive" });
    } finally {
      setSniperLoading(false);
    }
  }

  async function handleSniperStop() {
    setSniperLoading(true);
    try {
      await fetch(apiUrl("/api/demo/sniper/stop"), { method: "POST", credentials: "include" });
      toast({ title: "Demo Sniper parado" });
      refetchSniper();
    } catch {
      toast({ title: "Erro", description: "Falha ao parar o sniper", variant: "destructive" });
    } finally {
      setSniperLoading(false);
    }
  }

  function fmtHold(ms: number): string {
    if (!ms || ms <= 0) return "-";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m > 0 ? `${m}m${s}s` : `${s}s`;
  }

  function fireDemoOrder(
    symbol: string,
    positionSide: "LONG" | "SHORT",
    ev: number,
    ewmaWinRate: number,
    execute: boolean,
    lastPrice?: string,
  ) {
    const side = positionSide === "LONG" ? "BUY" as const : "SELL" as const;
    const key = `${symbol}-${positionSide}`;
    setFiringSet(prev => new Set(prev).add(key));

    orderMutation.mutate(
      {
        data: {
          symbol,
          side,
          positionSide,
          currentEv: ev,
          currentWinRate: ewmaWinRate,
          btcChangePct: btcChange,
          lastPrice,
          execute,
        } as never,
      },
      {
        onSuccess: (result) => {
          addLog({ symbol, positionSide, placed: result.placed, observationMode: result.observationMode, gateRejects: result.gateRejects, message: result.message, orderId: result.orderId });
          if (result.placed) {
            toast({ title: `Demo order placed`, description: `${positionSide} ${symbol}` });
            refetchStatus();
            refetchDemoPositions();
          } else {
            autoFiredKeysRef.current.delete(key);
          }
        },
        onError: (error) => {
          autoFiredKeysRef.current.delete(key);
          const errorLog = getOrderErrorLog(error);
          addLog({
            symbol,
            positionSide,
            placed: false,
            observationMode: false,
            gateRejects: errorLog.gateRejects,
            message: errorLog.message,
          });
        },
        onSettled: () => setFiringSet(prev => { const s = new Set(prev); s.delete(key); return s; }),
      }
    );
  }

  function closeDemoPosition(position: DemoPosition) {
    const key = `${position.symbol}-${position.positionSide}`;
    const quantity = Math.abs(parseFloat(position.positionAmt || "0"));
    if (!Number.isFinite(quantity) || quantity <= 0 || closingSet.has(key)) return;

    setClosingSet(prev => new Set(prev).add(key));
    closeMutation.mutate(
      {
        data: {
          symbol: position.symbol,
          positionSide: position.positionSide,
          quantity: quantity.toString(),
        },
      },
      {
        onSuccess: (result) => {
          autoFiredKeysRef.current.delete(key);
          riskClosingKeysRef.current.delete(key);
          addLog({
            symbol: position.symbol,
            positionSide: position.positionSide,
            placed: result.placed,
            observationMode: result.observationMode,
            gateRejects: result.gateRejects,
            message: result.message,
            orderId: result.orderId,
          });
          refetchStatus();
          refetchDemoPositions();
        },
        onError: () => {
          riskClosingKeysRef.current.delete(key);
          addLog({
            symbol: position.symbol,
            positionSide: position.positionSide,
            placed: false,
            observationMode: false,
            gateRejects: ["CLOSE_ERROR"],
            message: "Close request failed",
          });
        },
        onSettled: () => {
          riskClosingKeysRef.current.delete(key);
          setClosingSet(prev => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        },
      },
    );
  }

  const autoFireRef = useRef(autoFire);
  autoFireRef.current = autoFire;
  const loggedRiskCloseRef = useRef<Set<string>>(new Set());
  const statusDemoPositions =
    ((demoStatus as { positions?: DemoPosition[] } | undefined)?.positions ?? []);
  const visibleDemoPositions = demoPositions.length > 0 ? demoPositions : statusDemoPositions;

  useEffect(() => {
    if (demoConnected) {
      setAutoFire(true);
    }
  }, [demoConnected]);

  useEffect(() => {
    if (!riskCheck?.closed?.length) return;
    for (const closed of riskCheck.closed) {
      const key = `${closed.symbol}-${closed.positionSide}-${closed.orderId ?? closed.pnl}`;
      if (loggedRiskCloseRef.current.has(key)) continue;
      loggedRiskCloseRef.current.add(key);
      autoFiredKeysRef.current.delete(`${closed.symbol}-${closed.positionSide}`);
      riskClosingKeysRef.current.delete(`${closed.symbol}-${closed.positionSide}`);
      setClosingSet(prev => {
        const next = new Set(prev);
        next.delete(`${closed.symbol}-${closed.positionSide}`);
        return next;
      });
      addLog({
        symbol: closed.symbol,
        positionSide: closed.positionSide,
        placed: true,
        observationMode: false,
        gateRejects: [closed.reason.includes("TAKE_PROFIT") ? "TAKE_PROFIT" : "STOP_LOSS"],
        message: closed.reason,
        orderId: closed.orderId,
      });
    }
    refetchStatus();
    refetchDemoPositions();
  }, [riskCheck?.closed]);

  useEffect(() => {
    if (!autoFire || !scan?.symbols || !demoConnected) return;
    const maxPositions = config?.maxConcurrentPositions ?? 10;
    const availableSlots = Math.max(0, maxPositions - visibleDemoPositions.length);
    if (availableSlots === 0) return;

    const openPositionKeys = new Set(
      visibleDemoPositions.map((p) => `${p.symbol}-${p.positionSide}`),
    );

    const edgeBySymbol = new Map(
      (edge?.symbols ?? [])
        .filter((s) => s.symbol && s.combined?.bestSide && s.combined.bestSide !== "NEUTRAL")
        .map((s) => [s.symbol!, s]),
    );

    const candidates = scan.symbols
      .map((s) => {
        const edgeSymbol = edgeBySymbol.get(s.symbol);
        const bestSide = edgeSymbol?.combined?.bestSide;
        const edgeScore = bestSide === "LONG"
          ? edgeSymbol?.combined?.longScore ?? 0
          : bestSide === "SHORT"
            ? edgeSymbol?.combined?.shortScore ?? 0
            : 0;

        return { ...s, edgeScore, edgeAgrees: bestSide === s.positionSide };
      })
      .filter((s) => {
        const key = `${s.symbol}-${s.positionSide}`;
        const now = Date.now();
        if (!s.isCandidate) return false;
        if (now - lastAutoFireAtRef.current < AUTO_FIRE_MIN_INTERVAL_MS) return false;
        if ((symbolCooldownRef.current.get(key) ?? 0) > now) return false;
        if (openPositionKeys.has(key)) return false;
        if (firingSet.has(key)) return false;
        if (autoFiredKeysRef.current.has(key)) return false;
        if (edgeBySymbol.size === 0) return true;
        return s.edgeAgrees && s.edgeScore > 0.01;
      })
      .sort((a, b) => {
        if (b.edgeScore !== a.edgeScore) return b.edgeScore - a.edgeScore;
        return (b.rankingScore ?? 0) - (a.rankingScore ?? 0);
      })
      .slice(0, Math.min(availableSlots, AUTO_FIRE_MAX_PER_CYCLE));

    candidates.forEach((s) => {
      const key = `${s.symbol}-${s.positionSide}`;
      const now = Date.now();
      autoFiredKeysRef.current.add(key);
      lastAutoFireAtRef.current = now;
      symbolCooldownRef.current.set(key, now + AUTO_FIRE_SYMBOL_COOLDOWN_MS);
      fireDemoOrder(s.symbol, s.positionSide as "LONG" | "SHORT", s.ev, s.ewmaWinRate, true, s.lastPrice);
    });
  }, [scan?.scanTime, edge?.edgeTime, autoFire, demoConnected, visibleDemoPositions.length, config?.maxConcurrentPositions]);

  const scanSymbols = scan?.symbols ?? [];
  const candidates = scanSymbols.filter(s => s.isCandidate);

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 rounded-lg">
              <FlaskConical className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Demo Lab</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                VST account · sniper lógica completa · sem risco real
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* BTC Regime */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-mono ${
              btcRegime === "BULL" ? "border-green-500/30 bg-green-500/10 text-green-400"
              : btcRegime === "BEAR" ? "border-red-500/30 bg-red-500/10 text-red-400"
              : "border-border/40 text-muted-foreground"
            }`}>
              {btcRegime === "BULL" ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              <span className="font-bold">{btcRegime}</span>
              <span className="text-[10px] opacity-70">{btcChange >= 0 ? "+" : ""}{btcChange.toFixed(2)}%</span>
            </div>

            {/* Demo connection status */}
            {demoConnected ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                <span className="text-xs font-semibold text-blue-400">DEMO CONNECTED</span>
                <Button
                  variant="ghost" size="sm"
                  onClick={handleDisconnect}
                  className="h-6 w-6 p-0 ml-1 text-muted-foreground hover:text-red-400"
                >
                  <LogOut className="w-3 h-3" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/40 bg-muted/10">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                <span className="text-xs text-muted-foreground">Demo offline</span>
              </div>
            )}
          </div>
        </div>

        {/* ── CONTROL ROW ── */}
        {!demoConnected ? (
          <div className="flex gap-4 items-stretch">
            <Card className="flex-1 bg-card/50 border-blue-500/20">
              <CardContent className="px-4 py-3 flex items-center gap-4 h-full">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <FlaskConical className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold">Ativar Modo Demo VST</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                      Usa as mesmas credenciais, direciona para{" "}
                      <span className="font-mono">open-api-vst.bingx.com</span> — sem risco real.
                    </p>
                  </div>
                </div>
                <Button
                  className="shrink-0 bg-blue-600 hover:bg-blue-500 text-white"
                  size="sm"
                  onClick={handleConnect}
                  disabled={connectMutation.isPending}
                >
                  {connectMutation.isPending
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                    : <Radio className="w-3.5 h-3.5 mr-2" />}
                  Ativar Demo VST
                </Button>
              </CardContent>
            </Card>
            {config && (
              <Card className="w-[260px] bg-card/30 border-border/40">
                <CardContent className="px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Target className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-semibold">Parâmetros do Sniper</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    {[
                      ["Leverage", `${config.leverage}×`],
                      ["Margin / trade", `${config.marginPerTrade} USDT`],
                      ["Take profit", `${config.takeProfitPct}%`],
                      ["Stop loss", `${config.stopLossPct}%`],
                      ["EV mínimo", config.evMinThreshold > 0 ? `≥ ${config.evMinThreshold.toFixed(4)}` : "off"],
                      ["Win rate mín", config.winRateMin > 0 ? `≥ ${(config.winRateMin * 100).toFixed(0)}%` : "off"],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between text-[10px]">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-mono font-semibold">{value}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {/* 1 — Conta Demo (VST) */}
            {demoStatus && (
              <Card className="bg-card/50 border-blue-500/20">
                <CardContent className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <DollarSign className="w-3.5 h-3.5 text-blue-400" />
                      <span className="text-xs font-semibold">Conta Demo ({demoStatus.currency ?? "VST"})</span>
                    </div>
                    <button onClick={() => refetchStatus()} className="text-muted-foreground hover:text-foreground transition-colors">
                      <RefreshCw className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {[
                      ["Balance", parseFloat(demoStatus.balance ?? "0").toFixed(4)],
                      ["Disponível", parseFloat(demoStatus.availableBalance ?? "0").toFixed(4)],
                      ["Equity", parseFloat(demoAccount?.equity ?? demoStatus.balance ?? "0").toFixed(4)],
                      ["Margem usada", parseFloat(demoAccount?.usedMargin ?? "0").toFixed(4)],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between text-[10px]">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-mono font-semibold">{value}</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-[10px]">
                      <span className="text-muted-foreground">PnL unrealizado</span>
                      <span className={`font-mono font-semibold ${parseFloat(demoStatus.unrealizedPnl ?? "0") >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {parseFloat(demoStatus.unrealizedPnl ?? "0") >= 0 ? "+" : ""}{parseFloat(demoStatus.unrealizedPnl ?? "0").toFixed(4)}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 2 — Parâmetros do Sniper */}
            {config && (
              <Card className="bg-card/30 border-border/40">
                <CardContent className="px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Target className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-semibold">Parâmetros do Sniper</span>
                  </div>
                  <div className="space-y-1">
                    {[
                      ["Leverage", `${config.leverage}×`],
                      ["Margin / trade", `${config.marginPerTrade} USDT`],
                      ["Take profit", `${config.takeProfitPct}%`],
                      ["Stop loss", `${config.stopLossPct}%`],
                      ["EV mínimo", config.evMinThreshold > 0 ? `≥ ${config.evMinThreshold.toFixed(4)}` : "off"],
                      ["Win rate mín", config.winRateMin > 0 ? `≥ ${(config.winRateMin * 100).toFixed(0)}%` : "off"],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between text-[10px]">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-mono font-semibold">{value}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 3 — Auto-Fire */}
            <Card className={`border-2 transition-colors ${autoFire ? "border-orange-500/50 bg-orange-500/5" : "border-border/40 bg-card/30"}`}>
              <CardContent className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    {autoFire ? <Play className="w-3.5 h-3.5 text-orange-400" /> : <Square className="w-3.5 h-3.5 text-muted-foreground" />}
                    <span className={`text-xs font-bold ${autoFire ? "text-orange-400" : "text-muted-foreground"}`}>Auto-Fire</span>
                  </div>
                  <Switch checked={autoFire} onCheckedChange={setAutoFire} />
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {autoFire
                    ? "Disparando automaticamente em todos os candidatos a cada scan (8s)."
                    : "Quando ativado, dispara ordens nos candidatos que passam todos os gates."}
                </p>
                {autoFire && (
                  <div className="mt-2 flex items-center gap-1.5 text-[9px] text-orange-400 font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
                    ESCANEANDO · {candidates.length} candidato{candidates.length !== 1 ? "s" : ""}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 4 — Sniper Autopilot */}
            <Card className={`border-2 transition-colors ${sniperStatus?.running ? "border-purple-500/50 bg-purple-500/5" : "border-border/40 bg-card/30"}`}>
              <CardContent className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Crosshair className={`w-3.5 h-3.5 ${sniperStatus?.running ? "text-purple-400" : "text-muted-foreground"}`} />
                    <span className={`text-xs font-bold ${sniperStatus?.running ? "text-purple-400" : "text-muted-foreground"}`}>Sniper Autopilot</span>
                    {sniperStatus?.running && (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-purple-500/20 text-[9px] font-mono font-bold text-purple-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                        LIVE
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    disabled={sniperLoading}
                    onClick={sniperStatus?.running ? handleSniperStop : handleSniperStart}
                    className={`h-6 px-2.5 text-[10px] font-bold ${sniperStatus?.running
                      ? "bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30"
                      : "bg-purple-600 hover:bg-purple-500 text-white"}`}
                    variant="ghost"
                  >
                    {sniperLoading ? <Loader2 className="w-3 h-3 animate-spin" />
                      : sniperStatus?.running ? <><Square className="w-3 h-3 mr-1" />Stop</>
                      : <><Play className="w-3 h-3 mr-1" />Start</>}
                  </Button>
                </div>
                {sniperStatus && (
                  <div className="grid grid-cols-4 gap-1">
                    {[
                      ["Cycles", sniperStatus.cycleCount],
                      ["Placed", sniperStatus.totalPlaced],
                      ["Open", sniperStatus.openTrades],
                      ["Uptime", sniperStatus.uptimeMs ? `${Math.floor(sniperStatus.uptimeMs / 60000)}m` : "-"],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="flex flex-col items-center py-1 px-1 rounded-md bg-muted/10 border border-border/15">
                        <span className="text-sm font-bold font-mono">{value}</span>
                        <span className="text-[8px] text-muted-foreground uppercase tracking-wider mt-0.5">{label}</span>
                      </div>
                    ))}
                  </div>
                )}
                {sniperStatus?.lastCycleSummary && (
                  <div className="flex flex-wrap gap-1">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ${
                      sniperStatus.lastCycleSummary.btcRegime === "BULL" ? "bg-green-500/15 text-green-400"
                      : sniperStatus.lastCycleSummary.btcRegime === "BEAR" ? "bg-red-500/15 text-red-400"
                      : "bg-muted/20 text-muted-foreground"
                    }`}>{sniperStatus.lastCycleSummary.btcRegime}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-muted/15 text-muted-foreground">
                      {sniperStatus.lastCycleSummary.scanned} scanned
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-green-500/10 text-green-400">
                      +{sniperStatus.lastCycleSummary.placed} placed
                    </span>
                  </div>
                )}
                <div className="text-[8px] text-muted-foreground border-t border-border/15 pt-1">
                  Score ≥0.90 → ×10 · ≥0.80 → ×5 · ≥0.70 → ×3 · ≥0.60 → ×1
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <div className={`grid grid-cols-1 gap-5 ${demoConnected ? "xl:grid-cols-[260px_1fr_320px]" : "xl:grid-cols-[1fr_320px]"}`}>
          {/* ── LEFT PANEL (Posições Demo only) ── */}
          {demoConnected && (
            <div>
              <Card className="bg-card/40 border-border/40">
                <CardHeader className="px-4 pt-4 pb-3 border-b border-border/20">
                  <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <TrendingDown className="w-4 h-4 text-primary" />
                      Posições Demo
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {visibleDemoPositions.length} aberta{visibleDemoPositions.length === 1 ? "" : "s"}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {visibleDemoPositions.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                      Nenhuma posição aberta
                    </div>
                  ) : (
                    <div className="max-h-[480px] overflow-y-auto custom-scrollbar">
                      {visibleDemoPositions.map((position) => {
                        const key = `${position.symbol}-${position.positionSide}`;
                        return (
                          <PositionRow
                            key={key}
                            position={position}
                            closing={closingSet.has(key)}
                            onClose={() => closeDemoPosition(position)}
                          />
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

       {/* ── CENTER PANEL — scanner ── */}
<Card className="bg-card/30 border-border/40 flex flex-col h-[525px] overflow-hidden">
  <CardHeader className="px-5 pt-5 pb-3 border-b border-border/15 shrink-0">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-primary/10">
          <Radio className="w-3.5 h-3.5 text-primary" />
        </div>
        <CardTitle className="text-sm font-semibold tracking-tight">Scanner Sniper</CardTitle>
        {scan && (
          <span className={`ml-2 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
            candidates.length > 0 ? "bg-green-500/20 text-green-400" : "bg-muted/30 text-muted-foreground"
          }`}>
            {candidates.length} ready
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {scan && (
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[9px] font-mono font-bold ${
            scan.btcRegime === "BULL" ? "bg-green-500/10 text-green-400 border border-green-500/20"
            : scan.btcRegime === "BEAR" ? "bg-red-500/10 text-red-400 border border-red-500/20"
            : "bg-muted/20 text-muted-foreground border border-border/30"
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${
              scan.btcRegime === "BULL" ? "bg-green-400 animate-pulse"
              : scan.btcRegime === "BEAR" ? "bg-red-400" : "bg-muted-foreground"
            }`} />
            {scan.btcRegime} · UTC{scan.currentHourUtc}h
          </div>
        )}
      </div>
    </div>
  </CardHeader>

  {!demoConnected ? (
    <div className="flex flex-col items-center gap-4 py-24 text-muted-foreground">
      <Radio className="w-10 h-10 opacity-10" />
      <div className="text-center">
        <p className="text-sm font-medium">Scanner inativo</p>
        <p className="text-[10px] opacity-60 mt-1">Conecte a conta demo para ativar</p>
      </div>
    </div>
  ) : (config?.allowedSymbols?.length ?? 0) === 0 ? (
    <div className="flex flex-col items-center gap-4 py-24 text-muted-foreground">
      <AlertTriangle className="w-10 h-10 opacity-20" />
      <div className="text-center">
        <p className="text-sm font-medium">Nenhum símbolo configurado</p>
        <p className="text-[10px] opacity-60 mt-1">Configure SCALP_SYMBOLS no .env</p>
      </div>
    </div>
  ) : !scan ? (
    <div className="flex flex-col items-center gap-4 py-24 text-muted-foreground">
      <Loader2 className="w-10 h-10 animate-spin opacity-30" />
      <p className="text-sm">Escaneando mercado...</p>
    </div>
  ) : scanSymbols.length === 0 ? (
    <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
      <p className="text-sm">Nenhum símbolo no scan</p>
    </div>
  ) : (
    <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
      <div className="divide-y divide-border/5">
        {scanSymbols.map((s, i) => {
          const key = `${s.symbol}-${s.positionSide}`;
          const isReady = s.isCandidate;
          const isToxic = s.isToxic;
          const isGatePass = s.gatePass && !isReady;
          
          const up = s.priceChangePct >= 0;
          const vol = Math.min(11, Math.max(4, Math.abs(s.priceChangePct) * 1.1));
          const sparkY = Array.from({ length: 18 }, (_, idx) => {
            const base2 = 18 + idx * (up ? -0.4 : 0.4);
            const jag = (idx % 2 === 0 ? -1 : 1) * vol * 0.72 + (idx % 5 === 0 ? -1 : 0.45) * vol * 0.38;
            return Math.min(26, Math.max(3, base2 + Math.sin(idx * 2.35) * vol * 0.35 + jag));
          });
          const sparkPts = sparkY.map((y, idx) => `${(idx / (sparkY.length - 1)) * 100},${y}`).join(" ");
          const sparkColor = up ? "#22c55e" : "#ef4444";
          const sparkGlow = up ? "drop-shadow(0 0 3px rgba(34,197,94,0.7))" : "drop-shadow(0 0 3px rgba(239,68,68,0.7))";

          return (
            <div
              key={`${key}-${i}`}
              className={`group px-5 py-3 transition-all duration-150 hover:bg-muted/10 ${
                isReady && "bg-gradient-to-r from-green-500/5 to-transparent"
              }`}
            >
              <div className="flex items-center justify-between">
                {/* Left side - Symbol & Side */}
                <div className="flex items-center gap-3 min-w-[140px]">
                  <div className={`w-2 h-2 rounded-full transition-all ${
                    isToxic ? "bg-red-500" : isReady ? "bg-green-400 animate-pulse" : isGatePass ? "bg-yellow-500" : "bg-muted-foreground/30"
                  }`} />
                  <div className="flex items-center gap-2">
                    {(() => {
                      const base = s.symbol.replace("-USDT", "").replace("-USD", "").toLowerCase();
                      const icons: Record<string, string> = {
                        btc: "https://cryptologos.cc/logos/bitcoin-btc-logo.svg",
                        eth: "https://cryptologos.cc/logos/ethereum-eth-logo.svg",
                        sol: "https://cryptologos.cc/logos/solana-sol-logo.svg",
                        vvv: "https://cryptologos.cc/logos/vvv-vvv-logo.svg",
                      };
                      const iconUrl = icons[base];
                      return iconUrl ? (
                        <img src={iconUrl} alt={base} className="w-5 h-5" onError={(e) => (e.target as HTMLImageElement).style.display = 'none'} />
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-muted/20 flex items-center justify-center">
                          <span className="text-[9px] font-bold">{base.slice(0, 2).toUpperCase()}</span>
                        </div>
                      );
                    })()}
                    <div>
                      <p className="text-sm font-mono font-semibold">{s.symbol.replace("-USDT", "")}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                          s.positionSide === "LONG" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                        }`}>
                          {s.positionSide === "LONG" ? "LONG" : "SHORT"}
                        </span>
                        {s.samples > 0 && (
                          <span className="text-[8px] text-muted-foreground">{s.samples} trades</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sparkline */}
                <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="w-24 h-6 mx-3 overflow-visible hidden md:block shrink-0">
                  <polyline
                    points={sparkPts}
                    fill="none"
                    stroke={sparkColor}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    style={{ filter: sparkGlow }}
                  />
                  <circle cx="100" cy={sparkY[sparkY.length - 1]} r="2" fill={sparkColor}
                    vectorEffect="non-scaling-stroke" style={{ filter: sparkGlow }} />
                </svg>

                {/* Center - Metrics */}
                <div className="hidden md:flex items-center gap-6">
                  <div className="text-right">
                    <p className={`text-sm font-mono font-bold tabular-nums ${
                      s.priceChangePct >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {s.priceChangePct >= 0 ? "+" : ""}{s.priceChangePct.toFixed(2)}%
                    </p>
                    <p className="text-[8px] text-muted-foreground uppercase tracking-wider">24h</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-mono font-bold tabular-nums">
                      {s.samples > 0 ? `${Math.round(s.priorityScore * 100)}` : "—"}
                    </p>
                    <p className="text-[8px] text-muted-foreground uppercase tracking-wider">PRIORITY</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-mono font-bold tabular-nums ${
                      s.ev >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {s.ev > 0 ? "+" : ""}{s.ev.toFixed(4)}
                    </p>
                    <p className="text-[8px] text-muted-foreground uppercase tracking-wider">EV</p>
                  </div>
                </div>

                {/* Right side - Action */}
                <div className="flex items-center gap-3">
                  {isToxic ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-500/10">
                      <Shield className="w-3 h-3 text-red-400" />
                      <span className="text-[9px] font-medium text-red-400">TOXIC</span>
                    </div>
                  ) : isReady ? (
                    <Button
                      size="sm"
                      onClick={() => fireDemoOrder(
                        s.symbol,
                        s.positionSide as "LONG" | "SHORT",
                        s.ev,
                        s.ewmaWinRate,
                        true,
                        s.lastPrice,
                      )}
                      disabled={firingSet.has(key) || autoFire}
                      className="h-8 px-4 text-[11px] font-bold transition-all duration-200 bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30 active:scale-95"
                    >
                      {firingSet.has(key) ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <>
                          <Zap className="w-3.5 h-3.5 mr-1.5" />
                          EXECUTE
                        </>
                      )}
                    </Button>
                  ) : isGatePass ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-yellow-500/10">
                      <Clock className="w-3 h-3 text-yellow-400" />
                      <span className="text-[9px] font-medium text-yellow-400">WAITING</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/20">
                      <XCircle className="w-3 h-3 text-muted-foreground" />
                      <span className="text-[9px] text-muted-foreground">BLOCKED</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Progress bar for priority score */}
              {s.samples > 0 && (
                <div className="mt-2 ml-12">
                  <div className="h-0.5 w-full bg-border/20 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all duration-500 ${
                        isToxic ? "bg-red-500" : isReady ? "bg-gradient-to-r from-green-500 to-emerald-500" : "bg-primary/40"
                      }`}
                      style={{ width: `${Math.min(100, Math.max(0, s.priorityScore * 100))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  )}

  {/* Legend */}
  {scanSymbols.length > 0 && (
    <div className="px-5 py-2.5 border-t border-border/15 shrink-0 bg-muted/5">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[8px] text-muted-foreground uppercase tracking-wider">READY</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          <span className="text-[8px] text-muted-foreground uppercase tracking-wider">TOXIC</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
          <span className="text-[8px] text-muted-foreground uppercase tracking-wider">WAITING</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
          <span className="text-[8px] text-muted-foreground uppercase tracking-wider">BLOCKED</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-4 h-0.5 rounded-full bg-primary/40" />
          <span className="text-[8px] text-muted-foreground uppercase tracking-wider">PRIORITY SCORE</span>
        </div>
      </div>
    </div>
  )}
</Card>

{/* ── RIGHT PANEL — log ── */}
<Card className="bg-card/30 border-border/40 flex flex-col h-[525px] overflow-hidden">
  <CardHeader className="px-4 pt-4 pb-3 border-b border-border/20 shrink-0">
    <div className="flex items-center justify-between">
      <CardTitle className="text-sm font-semibold flex items-center gap-2">
        <Clock className="w-4 h-4 text-primary" />
        Execution Log
      </CardTitle>
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-muted-foreground">{log.length} entries</span>
        {log.length > 0 && (
          <Button
            variant="ghost" 
            size="sm"
            className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive transition-colors"
            onClick={() => setLog([])}
          >
            clear
          </Button>
        )}
      </div>
    </div>
  </CardHeader>

  {/* Log entries */}
  <div ref={logRef} className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
    {log.length === 0 ? (
      <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
        <ArrowRight className="w-6 h-6 opacity-20" />
        <p className="text-xs">Nenhuma ordem ainda</p>
        <p className="text-[10px] opacity-60">Use o botão "Fire" ou ative o Auto-Fire</p>
      </div>
    ) : (
      <div className="divide-y divide-border/10">
        {log.map(entry => <LogRow key={entry.id} entry={entry} />)}
      </div>
    )}
  </div>

  {/* Log summary footer */}
  {log.length > 0 && (
    <div className="px-4 py-3 border-t border-border/20 shrink-0 bg-muted/5">
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="flex flex-col items-center gap-0.5">
          <div className="text-base font-bold text-green-400">{log.filter(l => l.placed).length}</div>
          <div className="text-[8px] text-muted-foreground uppercase tracking-wider">FILLED</div>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <div className="text-base font-bold text-red-400">{log.filter(l => !l.placed && !l.observationMode).length}</div>
          <div className="text-[8px] text-muted-foreground uppercase tracking-wider">BLOCKED</div>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <div className="text-base font-bold text-amber-400">{log.filter(l => l.observationMode).length}</div>
          <div className="text-[8px] text-muted-foreground uppercase tracking-wider">OBS</div>
        </div>
      </div>
    </div>
  )}
</Card>
        </div>

        {/* ── Campaign Reporting ── */}
        <Card className="border-border/30 bg-card/20">
          <CardHeader className="px-5 pt-5 pb-3 border-b border-border/15">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-purple-500/10">
                  <BarChart3 className="w-3.5 h-3.5 text-purple-400" />
                </div>
                <CardTitle className="text-sm font-semibold tracking-tight">Campaign Reporting</CardTitle>
                {campaignData?.summary && (
                  <span className="text-[10px] font-mono text-muted-foreground px-2 py-0.5 rounded bg-muted/20">
                    {campaignData.summary.totalTrades} trades · {campaignData.summary.symbolCount} símbolo{campaignData.summary.symbolCount !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {campaignData?.summary && (
                  <div className="flex items-center gap-3">
                    <div className="text-center">
                      <div className={`text-sm font-bold font-mono ${campaignData.summary.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {campaignData.summary.totalPnl >= 0 ? "+" : ""}{campaignData.summary.totalPnl.toFixed(4)}
                      </div>
                      <div className="text-[8px] text-muted-foreground uppercase">Net PnL</div>
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-bold font-mono text-amber-400">
                        {(campaignData.summary.winRate * 100).toFixed(1)}%
                      </div>
                      <div className="text-[8px] text-muted-foreground uppercase">Win Rate</div>
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-bold font-mono text-red-400/80">
                        -{campaignData.summary.maxDrawdown.toFixed(4)}
                      </div>
                      <div className="text-[8px] text-muted-foreground uppercase">Max DD</div>
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-bold font-mono text-muted-foreground">
                        {campaignData.summary.totalFees.toFixed(4)}
                      </div>
                      <div className="text-[8px] text-muted-foreground uppercase">Fees</div>
                    </div>
                  </div>
                )}
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => refetchCampaign()}>
                  <RefreshCw className="w-3 h-3" />
                </Button>
              </div>
            </div>
          </CardHeader>

          {!demoConnected ? (
            <div className="px-5 py-8 text-center text-[11px] text-muted-foreground">
              Conecte a conta demo para ver o relatório de campanha.
            </div>
          ) : !campaignData || campaignData.symbols.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <Layers className="w-8 h-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-xs text-muted-foreground">Nenhum trade demo registrado ainda.</p>
              <p className="text-[10px] text-muted-foreground/60 mt-1">Inicie o Sniper Autopilot para acumular dados.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/15 bg-muted/5">
                    {["Símbolo", "Trades", "W%", "Net PnL", "Gross", "Fees", "Drawdown", "TP", "SL", "Avg Hold", ""].map((h) => (
                      <th key={h} className="px-3 py-2.5 text-left text-[9px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/10">
                  {campaignData.symbols.map((sym) => {
                    const isExpanded = expandedSymbol === sym.symbol;
                    const shortSym = sym.symbol.replace("-USDT", "").replace("-USD", "");
                    return (
                      <>
                        <tr
                          key={sym.symbol}
                          className="hover:bg-muted/8 transition-colors cursor-pointer"
                          onClick={() => setExpandedSymbol(isExpanded ? null : sym.symbol)}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              {sym.symbol === campaignData.summary.bestSymbol && (
                                <Award className="w-3 h-3 text-yellow-400 shrink-0" />
                              )}
                              <span className="font-bold">{shortSym}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 font-mono">
                            <span className="text-green-400">{sym.wins}W</span>
                            <span className="text-muted-foreground mx-1">/</span>
                            <span className="text-red-400">{sym.losses}L</span>
                          </td>
                          <td className="px-3 py-2.5 font-mono font-bold">
                            <span className={sym.winRate >= 0.5 ? "text-green-400" : sym.winRate >= 0.4 ? "text-amber-400" : "text-red-400"}>
                              {(sym.winRate * 100).toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono font-bold">
                            <span className={sym.totalPnl >= 0 ? "text-green-400" : "text-red-400"}>
                              {sym.totalPnl >= 0 ? "+" : ""}{sym.totalPnl.toFixed(4)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-muted-foreground">
                            {sym.totalGrossPnl >= 0 ? "+" : ""}{sym.totalGrossPnl.toFixed(4)}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-red-400/70">{sym.totalFees.toFixed(4)}</td>
                          <td className="px-3 py-2.5 font-mono text-red-400/80">-{sym.maxDrawdown.toFixed(4)}</td>
                          <td className="px-3 py-2.5 font-mono text-green-400/80">{sym.tpCount}</td>
                          <td className="px-3 py-2.5 font-mono text-red-400/80">{sym.slCount}</td>
                          <td className="px-3 py-2.5 font-mono text-muted-foreground">{fmtHold(sym.avgHoldMs)}</td>
                          <td className="px-3 py-2.5">
                            {isExpanded
                              ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                              : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                          </td>
                        </tr>

                        {isExpanded && sym.entries.length > 0 && (
                          <tr key={`${sym.symbol}-entries`}>
                            <td colSpan={11} className="p-0">
                              <div className="bg-muted/5 border-l-2 border-purple-500/30">
                                <div className="px-4 py-2 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/10">
                                  Entradas individuais — {sym.entries.length} registros (últimos 100)
                                </div>
                                <div className="max-h-[260px] overflow-y-auto">
                                  <table className="w-full text-[10px]">
                                    <thead className="sticky top-0 bg-muted/10">
                                      <tr className="border-b border-border/10">
                                        {["Lado", "Entry", "Exit", "PnL", "Fee", "Motivo", "Regime", "Hold", "Est."].map((h) => (
                                          <th key={h} className="px-3 py-1.5 text-left text-[8px] font-semibold text-muted-foreground uppercase">{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border/5">
                                      {sym.entries.slice().reverse().map((e) => (
                                        <tr key={e.id} className={`hover:bg-muted/10 transition-colors ${e.isWin ? "" : "opacity-80"}`}>
                                          <td className="px-3 py-1.5">
                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                              e.positionSide === "LONG" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                                            }`}>{e.positionSide === "LONG" ? "▲L" : "▼S"}</span>
                                          </td>
                                          <td className="px-3 py-1.5 font-mono text-muted-foreground">{e.entryPrice.toFixed(2)}</td>
                                          <td className="px-3 py-1.5 font-mono text-muted-foreground">{e.exitPrice.toFixed(2)}</td>
                                          <td className="px-3 py-1.5 font-mono font-bold">
                                            <span className={e.realizedPnl >= 0 ? "text-green-400" : "text-red-400"}>
                                              {e.realizedPnl >= 0 ? "+" : ""}{e.realizedPnl.toFixed(4)}
                                            </span>
                                          </td>
                                          <td className="px-3 py-1.5 font-mono text-muted-foreground/70">{e.fee.toFixed(4)}</td>
                                          <td className="px-3 py-1.5">
                                            <span className={`text-[8px] px-1 py-0.5 rounded font-mono ${
                                              e.exitReason === "TAKE_PROFIT" ? "bg-green-500/15 text-green-400"
                                              : e.exitReason === "STOP_LOSS" ? "bg-red-500/15 text-red-400"
                                              : "bg-muted/20 text-muted-foreground"
                                            }`}>{e.exitReason.replace("_", " ")}</span>
                                          </td>
                                          <td className="px-3 py-1.5 font-mono text-muted-foreground/70">{e.btcRegime}</td>
                                          <td className="px-3 py-1.5 font-mono text-muted-foreground">{fmtHold(e.holdMs)}</td>
                                          <td className="px-3 py-1.5">
                                            {e.estimated && <span className="text-[8px] text-amber-400/70 font-mono">est</span>}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* How it works */}
        <Card className="border-border/20 bg-card/10">
          <CardContent className="px-5 py-4">
            <div className="flex items-start gap-6 flex-wrap">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
                <span>Conecte sua <strong>API Key da conta Demo</strong> BingX (VST)</span>
              </div>
              <ArrowRight className="w-3 h-3 text-border/50 shrink-0 mt-1 hidden sm:block" />
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
                <span>Scanner roda a lógica sniper completa em todos os seus símbolos</span>
              </div>
              <ArrowRight className="w-3 h-3 text-border/50 shrink-0 mt-1 hidden sm:block" />
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">3</span>
                <span><strong>Fire manual</strong> ou <strong>Auto-Fire</strong> dispara ordens reais na conta VST</span>
              </div>
              <ArrowRight className="w-3 h-3 text-border/50 shrink-0 mt-1 hidden sm:block" />
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">4</span>
                <span>Resultados alimentam o <strong>telemetry</strong> → calibra edge para conta real</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
