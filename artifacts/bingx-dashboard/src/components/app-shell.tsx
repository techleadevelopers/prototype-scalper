import { useLocation, Link } from "wouter";
import {
  useGetBingXTicker,
  useGetBingXSummary,
  useDisconnectBingX,
  useGetBotScan,
  useGetBotConfig,
  getGetBingXTickerQueryKey,
  getGetBingXSummaryQueryKey,
  getGetBotScanQueryKey,
  getGetBotConfigQueryKey,
} from "@/api-client";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  TrendingUp,
  ClipboardList,
  BarChart3,
  Settings,
  LogOut,
  Terminal,
  ArrowUp,
  ArrowDown,
  Zap,
  Bot,
  Radio,
  FlaskConical,
  BrainCircuit,
} from "lucide-react";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  YAxis,
} from "recharts";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/positions", label: "Positions", icon: TrendingUp },
  { href: "/orders", label: "Orders", icon: ClipboardList },
  { href: "/analysis", label: "Analysis", icon: BarChart3 },
  { href: "/intelligence", label: "IA Sniper", icon: BrainCircuit },
  { href: "/bot", label: "Bot", icon: Bot },
  { href: "/demo", label: "Demo Lab", icon: FlaskConical, highlight: true },
  { href: "/settings", label: "Settings", icon: Settings },
];

function MiniRiskChart({
  changePct,
  isLong,
  isToxic,
}: {
  changePct: number;
  isLong: boolean;
  isToxic: boolean;
}) {
  const direction = changePct >= 0 ? 1 : -1;
  const absChange = Math.max(Math.abs(changePct), 0.15);
  const base = 100;
  const data = [
    { t: 1, price: base - direction * absChange * 0.42 },
    { t: 2, price: base - direction * absChange * 0.08 },
    { t: 3, price: base + direction * absChange * 0.2 },
    { t: 4, price: base + direction * absChange * 0.04 },
    { t: 5, price: base + direction * absChange * 0.48 },
    { t: 6, price: base + direction * absChange },
  ];
  const stroke = isToxic
    ? "rgb(248 113 113)"
    : isLong
    ? "rgb(74 222 128)"
    : "rgb(251 113 133)";
  const target = base + direction * absChange;
  const stop = base - direction * absChange * 0.55;
  const domainPad = absChange * 0.95;

  return (
    <div className="relative h-8 flex-1 min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 3, right: 2, bottom: 2, left: 2 }}>
          <YAxis domain={[base - domainPad, base + domainPad]} hide />
          <ReferenceLine y={base} stroke="hsl(var(--border))" strokeDasharray="2 2" strokeOpacity={0.5} />
          <ReferenceLine y={target} stroke={stroke} strokeOpacity={0.28} />
          <ReferenceLine y={stop} stroke="rgb(248 113 113)" strokeOpacity={0.22} />
          <Line
            type="monotone"
            dataKey="price"
            stroke={stroke}
            strokeWidth={1.7}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <span className={`absolute right-0 top-0 text-[8px] font-mono tabular-nums ${changePct >= 0 ? "text-green-400" : "text-red-400"}`}>
        {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
      </span>
    </div>
  );
}

function TargetRow({
  symbol,
  positionSide,
  lastPrice,
  priceChangePct,
  priorityScore,
  toxicityScore,
  ewmaWinRate,
  samples,
  gatePass,
  isToxic,
  isCandidate,
}: {
  symbol: string;
  positionSide: string;
  lastPrice: string;
  priceChangePct: number;
  priorityScore: number;
  toxicityScore: number;
  ewmaWinRate: number;
  samples: number;
  gatePass: boolean;
  isToxic: boolean;
  isCandidate: boolean;
}) {
  const shortSym = symbol.replace("-USDT", "").replace("-USD", "");
  const pUp = priceChangePct >= 0;

  const dotColor = isToxic
    ? "bg-red-500"
    : isCandidate
    ? "bg-green-400 animate-pulse"
    : gatePass
    ? "bg-yellow-400"
    : samples === 0
    ? "bg-muted-foreground/40"
    : "bg-orange-400";

  return (
    <div className="px-3 py-1.5 border-b border-border/10 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-[11px] font-bold tabular-nums leading-none flex-1">{shortSym}</span>
        <span className={`text-[9px] font-mono shrink-0 ${positionSide === "LONG" ? "text-green-400" : "text-red-400"}`}>
          {positionSide === "LONG" ? "L" : "S"}
        </span>
        <span className={`text-[10px] font-mono tabular-nums ${pUp ? "text-green-400" : "text-red-400"}`}>
          {pUp ? "+" : ""}{priceChangePct.toFixed(2)}%
        </span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <MiniRiskChart
          changePct={priceChangePct}
          isLong={positionSide === "LONG"}
          isToxic={isToxic}
        />
        <span className="text-[9px] text-muted-foreground tabular-nums font-mono">
          {samples > 0 ? `${(ewmaWinRate * 100).toFixed(0)}%` : "—"}
        </span>
        <span className={`text-[9px] font-semibold tabular-nums ${isToxic ? "text-red-400" : isCandidate ? "text-green-400" : "text-muted-foreground"}`}>
          P{Math.round(priorityScore * 100)}
        </span>
      </div>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const disconnectMutation = useDisconnectBingX();

  const { data: btcTicker } = useGetBingXTicker(
    { symbol: "BTC-USDT" },
    { query: { refetchInterval: 5000, queryKey: getGetBingXTickerQueryKey({ symbol: "BTC-USDT" }) } }
  );

  const { data: summary } = useGetBingXSummary({
    query: { queryKey: getGetBingXSummaryQueryKey(), refetchInterval: 30000 },
  });

  const { data: botConfig } = useGetBotConfig({
    query: { queryKey: getGetBotConfigQueryKey(), refetchInterval: 60000 },
  });

  const btcChange = btcTicker ? parseFloat(btcTicker.priceChangePercent) : 0;

  const { data: scan } = useGetBotScan(
    { btcChangePct: btcChange },
    {
      query: {
        queryKey: getGetBotScanQueryKey({ btcChangePct: btcChange }),
        refetchInterval: 8000,
        enabled: (botConfig?.allowedSymbols?.length ?? 0) > 0,
      },
    }
  );

  const btcUp = btcChange >= 0;
  const fmtPrice = (v: string | undefined) => {
    if (!v) return "—";
    const n = parseFloat(v);
    return isNaN(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate(undefined, { onSuccess: () => setLocation("/") });
  };

  const scanSymbols = scan?.symbols ?? [];
  const candidateCount = scan?.candidateCount ?? 0;
  const hasTargets = (botConfig?.allowedSymbols?.length ?? 0) > 0;
  const accountSummary = summary as
    | (typeof summary & {
        recentRealizedPnl?: string;
        lastRealizedPnl?: string;
      })
    | undefined;
  const recentRealizedPnl = parseFloat(accountSummary?.recentRealizedPnl ?? "0");
  const openPnl = parseFloat(summary?.totalUnrealizedPnl ?? "0");

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-border/50 bg-card/30 backdrop-blur-sm overflow-y-auto">
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border/40 shrink-0">
          <div className="p-1.5 bg-primary/15 rounded-md">
            <Terminal className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold tracking-tight leading-none">Futures Finance</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[9px] text-muted-foreground uppercase tracking-widest">Live</span>
            </div>
          </div>
        </div>

        {/* BTC Compass */}
<div className={`mx-3 mt-3 p-3 rounded-lg border shrink-0 ${btcUp ? "border-green-500/25 bg-green-500/5" : "border-red-500/25 bg-red-500/5"}`}>
  <div className="flex items-center justify-between mb-1">
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">BTC/USDT</span>
    </div>
    <img 
      src="https://cryptologos.cc/logos/bitcoin-btc-logo.svg" 
      alt="BTC" 
      className="w-5 h-5"
      onError={(e) => {
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  </div>
  <div className="font-bold font-mono text-base tabular-nums">
    ${fmtPrice(btcTicker?.lastPrice)}
  </div>
  <div className={`flex items-center gap-1 mt-0.5 ${btcUp ? "text-green-400" : "text-red-400"}`}>
    {btcUp ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
    <span className="text-xs font-semibold font-mono">{btcUp ? "+" : ""}{btcChange.toFixed(2)}%</span>
    <span className={`ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded ${btcUp ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
      {btcUp ? "BULL" : "BEAR"}
    </span>
  </div>
  {btcTicker && (
    <div className="flex justify-between mt-2 text-[9px] text-muted-foreground font-mono">
      <span>H: <span className="text-foreground/70">{fmtPrice(btcTicker.highPrice)}</span></span>
      <span>L: <span className="text-foreground/70">{fmtPrice(btcTicker.lowPrice)}</span></span>
    </div>
  )}
</div>

        {/* Account mini-summary */}
        {summary?.connected && (
          <div className="mx-3 mt-2 p-3 rounded-lg border border-border/30 bg-muted/10 shrink-0">
            <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1.5">Account</p>
            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Balance</span>
                <span className="font-mono font-semibold">${parseFloat(summary.totalBalance).toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Realized</span>
                <span className={`font-mono font-semibold ${recentRealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {recentRealizedPnl >= 0 ? "+" : ""}{recentRealizedPnl.toFixed(4)}
                </span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Open PnL</span>
                <span className={`font-mono font-semibold ${openPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {openPnl >= 0 ? "+" : ""}{openPnl.toFixed(4)}
                </span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Positions</span>
                <span className="font-mono font-semibold">{summary.openPositionsCount}</span>
              </div>
            </div>
          </div>
        )}

        {/* Nav */}
        <nav className="px-3 mt-4 space-y-0.5 shrink-0">
          {NAV.map(({ href, label, icon: Icon, highlight }) => {
            const active = location === href || (href !== "/dashboard" && location.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                data-testid={`nav-${label.toLowerCase().replace(" ", "-")}`}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 ${
                  active
                    ? "bg-primary/15 text-primary font-semibold"
                    : highlight
                    ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? "text-primary" : highlight ? "text-blue-400" : ""}`} />
                {label}
                {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />}
                {!active && highlight && <span className="ml-auto text-[8px] font-bold px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 uppercase tracking-wide">VST</span>}
              </Link>
            );
          })}
        </nav>

        {/* Targets / Watchlist */}
        {hasTargets && (
          <div className="mx-3 mt-4 rounded-lg border border-border/30 bg-muted/5 overflow-hidden shrink-0">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/20">
              <div className="flex items-center gap-1.5">
                <Radio className="w-3 h-3 text-primary" />
                <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">Targets</span>
              </div>
              <div className="flex items-center gap-1.5">
                {scan && (
                  <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
                    candidateCount > 0
                      ? "bg-green-500/15 text-green-400"
                      : "bg-muted/30 text-muted-foreground"
                  }`}>
                    {candidateCount} ready
                  </span>
                )}
                <span className={`text-[9px] font-mono text-muted-foreground`}>≤10/s</span>
              </div>
            </div>

            {/* Regime row */}
            {scan && (
              <div className={`px-3 py-1.5 border-b border-border/10 flex items-center justify-between ${
                scan.btcRegime === "BULL" ? "bg-green-500/5" :
                scan.btcRegime === "BEAR" ? "bg-red-500/5" : "bg-muted/5"
              }`}>
                <span className="text-[9px] text-muted-foreground">Regime</span>
                <span className={`text-[9px] font-bold ${
                  scan.btcRegime === "BULL" ? "text-green-400" :
                  scan.btcRegime === "BEAR" ? "text-red-400" : "text-muted-foreground"
                }`}>{scan.btcRegime} · UTC{scan.currentHourUtc}h</span>
              </div>
            )}

            {/* Symbol rows */}
            {scanSymbols.length === 0 && (
              <div className="px-3 py-3 text-center">
                <p className="text-[9px] text-muted-foreground">Set SCALP_SYMBOLS in .env</p>
              </div>
            )}
            {scanSymbols.map((s, i) => (
              <TargetRow key={`${s.symbol}-${s.positionSide}-${i}`} {...s} />
            ))}

            {/* Legend */}
            <div className="px-3 py-1.5 border-t border-border/10 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-[8px] text-muted-foreground">ready</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                <span className="text-[8px] text-muted-foreground">toxic</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                <span className="text-[8px] text-muted-foreground">no data</span>
              </div>
              <span className="text-[8px] text-muted-foreground ml-auto">P=priority</span>
            </div>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1 min-h-2" />

        {/* Disconnect */}
        <div className="p-3 border-t border-border/40 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDisconnect}
            data-testid="button-disconnect"
            className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Disconnect
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
