import { useEffect } from "react";
import { useLocation } from "wouter";
import {
  useGetBingXSummary,
  useGetBingXPositions,
  useGetBingXOrders,
  useDisconnectBingX,
  useGetBingXTicker,
  getGetBingXTickerQueryKey,
  getGetBingXSummaryQueryKey,
  getGetBingXPositionsQueryKey,
  getGetBingXOrdersQueryKey,
} from "@/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Terminal, LogOut, Wallet, Activity, TrendingUp, AlertTriangle, ArrowUp, ArrowDown } from "lucide-react";

export default function DashboardPage() {
  const [, setLocation] = useLocation();
  const disconnectMutation = useDisconnectBingX();

  const { data: summary, isLoading: loadingSummary } = useGetBingXSummary({
    query: { queryKey: getGetBingXSummaryQueryKey(), refetchInterval: 30000 },
  });

  const { data: positions, isLoading: loadingPositions } = useGetBingXPositions({
    query: { queryKey: getGetBingXPositionsQueryKey(), refetchInterval: 15000, enabled: !!summary?.connected },
  });

  const { data: orders, isLoading: loadingOrders } = useGetBingXOrders(
    { limit: 50 },
    { query: { queryKey: getGetBingXOrdersQueryKey({ limit: 50 }), refetchInterval: 30000, enabled: !!summary?.connected } }
  );

  const { data: btcTicker } = useGetBingXTicker(
    { symbol: "BTC-USDT" },
    { query: { refetchInterval: 5000, queryKey: getGetBingXTickerQueryKey({ symbol: "BTC-USDT" }) } }
  );

  useEffect(() => {
    if (summary && !summary.connected) {
      setLocation("/");
    }
  }, [summary, setLocation]);

  const handleDisconnect = () => {
    disconnectMutation.mutate(undefined, {
      onSuccess: () => setLocation("/"),
    });
  };

  const fmt = (val: string | number | undefined | null, decimals = 2) => {
    if (val === undefined || val === null) return "—";
    const num = typeof val === "string" ? parseFloat(val) : val;
    return isNaN(num) ? "—" : num.toFixed(decimals);
  };

  const fmtLarge = (val: string | number | undefined | null) => {
    if (val === undefined || val === null) return "—";
    const num = typeof val === "string" ? parseFloat(val) : val;
    if (isNaN(num)) return "—";
    if (num >= 1000) return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return num.toFixed(2);
  };

  const renderPnL = (val: string | number | undefined | null) => {
    if (val === undefined || val === null) return <span className="text-muted-foreground font-mono">—</span>;
    const num = typeof val === "string" ? parseFloat(val) : val;
    if (isNaN(num)) return <span className="text-muted-foreground font-mono">—</span>;
    if (num > 0) return <span className="text-green-400 font-mono font-semibold">+{num.toFixed(4)}</span>;
    if (num < 0) return <span className="text-red-400 font-mono font-semibold">{num.toFixed(4)}</span>;
    return <span className="text-muted-foreground font-mono">0.0000</span>;
  };

  const btcChange = btcTicker ? parseFloat(btcTicker.priceChangePercent) : 0;
  const btcUp = btcChange >= 0;

  if (loadingSummary && !summary) {
    return (
      <div className="min-h-screen bg-background text-foreground p-6 space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/95 backdrop-blur-sm px-6 py-3">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4">

          {/* Brand */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="p-1.5 bg-primary/10 rounded-md">
              <Terminal className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight leading-none">Futures Finance</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Live</span>
              </div>
            </div>
          </div>

          {/* BTC Compass — centre */}
          <div className="flex-1 flex justify-center">
            <div
              data-testid="btc-ticker"
              className={`flex items-center gap-4 px-5 py-2 rounded-lg border ${btcUp ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">BTC/USDT</span>
                <span className="text-xs text-muted-foreground opacity-50">·</span>
                <span className="text-xs text-muted-foreground uppercase tracking-widest">Compass</span>
              </div>
              {btcTicker ? (
                <>
                  <span data-testid="btc-price" className="text-xl font-bold font-mono tabular-nums">
                    ${fmtLarge(btcTicker.lastPrice)}
                  </span>
                  <div className={`flex items-center gap-1 ${btcUp ? "text-green-400" : "text-red-400"}`}>
                    {btcUp ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
                    <span className="text-sm font-semibold font-mono tabular-nums">
                      {btcUp ? "+" : ""}{btcChange.toFixed(2)}%
                    </span>
                  </div>
                  <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground font-mono">
                    <span>H: <span className="text-foreground">${fmtLarge(btcTicker.highPrice)}</span></span>
                    <span>L: <span className="text-foreground">${fmtLarge(btcTicker.lowPrice)}</span></span>
                    <span>Vol: <span className="text-foreground">{fmt(parseFloat(btcTicker.volume ?? "0") / 1000, 1)}K</span></span>
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-[10px] font-bold px-2 ${btcUp ? "border-green-500/40 text-green-400 bg-green-500/5" : "border-red-500/40 text-red-400 bg-red-500/5"}`}
                  >
                    {btcUp ? "BULLISH" : "BEARISH"}
                  </Badge>
                </>
              ) : (
                <Skeleton className="h-6 w-48" />
              )}
            </div>
          </div>

          {/* Disconnect */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            data-testid="button-disconnect"
            className="shrink-0 border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Disconnect
          </Button>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-6 space-y-6">

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card data-testid="card-total-balance" className="bg-card/50 border-border/50">
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Balance</CardTitle>
              <Wallet className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="text-2xl font-bold font-mono tabular-nums">
                {loadingSummary ? <Skeleton className="h-8 w-28" /> : <>${fmtLarge(summary?.totalBalance)} <span className="text-xs text-muted-foreground font-normal">USDT</span></>}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-available-balance" className="bg-card/50 border-border/50">
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Available</CardTitle>
              <Activity className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="text-2xl font-bold font-mono tabular-nums">
                {loadingSummary ? <Skeleton className="h-8 w-28" /> : <>${fmtLarge(summary?.availableBalance)} <span className="text-xs text-muted-foreground font-normal">USDT</span></>}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-unrealized-pnl" className="bg-card/50 border-border/50">
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Unrealized PnL</CardTitle>
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="text-2xl font-bold">
                {loadingSummary ? <Skeleton className="h-8 w-28" /> : renderPnL(summary?.totalUnrealizedPnl)}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-open-positions" className="bg-card/50 border-border/50">
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Open Positions</CardTitle>
              <AlertTriangle className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="text-2xl font-bold font-mono">
                {loadingSummary ? <Skeleton className="h-8 w-12" /> : summary?.openPositionsCount ?? 0}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Margin used: <span className="text-foreground font-mono">${fmtLarge(summary?.totalMarginUsed)}</span>
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Positions Table */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Active Positions</h2>
            {positions && positions.length > 0 && (
              <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">{positions.length}</Badge>
            )}
          </div>
          <Card className="border-border/50 bg-card/30 overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/20">
                <TableRow className="hover:bg-transparent border-border/40">
                  {["Symbol", "Side / Lev", "Size", "Entry", "Mark Price", "Liq. Price", "PnL (USDT)"].map((h) => (
                    <TableHead key={h} className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground py-2 last:text-right">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingPositions ? (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center"><Skeleton className="h-5 w-64 mx-auto" /></TableCell></TableRow>
                ) : positions && positions.length > 0 ? (
                  positions.map((pos, i) => (
                    <TableRow key={i} data-testid={`row-position-${i}`} className="border-border/30 hover:bg-muted/10 transition-colors">
                      <TableCell className="font-bold font-mono text-sm py-3">{pos.symbol}</TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center gap-2">
                          <span className={`font-bold font-mono text-xs ${pos.positionSide === "LONG" ? "text-green-400" : "text-red-400"}`}>
                            {pos.positionSide}
                          </span>
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-border/50 font-mono">{pos.leverage}x</Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">{pos.positionAmt}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">{fmtLarge(pos.entryPrice)}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">{fmtLarge(pos.markPrice)}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3 text-orange-400">{fmtLarge(pos.liquidationPrice)}</TableCell>
                      <TableCell className="text-right py-3">{renderPnL(pos.unrealizedProfit)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-28 text-center">
                      <div className="flex flex-col items-center gap-2 text-muted-foreground">
                        <Activity className="h-7 w-7 opacity-15" />
                        <p className="text-sm">No open positions</p>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>

        {/* Orders Table */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Recent Orders</h2>
            {orders && orders.length > 0 && (
              <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">{orders.length}</Badge>
            )}
          </div>
          <Card className="border-border/50 bg-card/30 overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/20">
                <TableRow className="hover:bg-transparent border-border/40">
                  {["Time", "Symbol", "Side", "Type", "Price", "Amount", "Status"].map((h, idx) => (
                    <TableHead key={h} className={`font-mono text-[10px] uppercase tracking-widest text-muted-foreground py-2 ${idx >= 4 ? "text-right" : ""}`}>
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingOrders ? (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center"><Skeleton className="h-5 w-64 mx-auto" /></TableCell></TableRow>
                ) : orders && orders.length > 0 ? (
                  orders.map((order, i) => (
                    <TableRow key={i} data-testid={`row-order-${i}`} className="border-border/30 hover:bg-muted/10 transition-colors">
                      <TableCell className="text-muted-foreground text-[11px] font-mono py-3 whitespace-nowrap">
                        {new Date(order.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </TableCell>
                      <TableCell className="font-bold font-mono text-sm py-3">{order.symbol}</TableCell>
                      <TableCell className="py-3">
                        <span className={`font-bold font-mono text-xs ${order.side === "BUY" ? "text-green-400" : "text-red-400"}`}>
                          {order.side}
                        </span>
                      </TableCell>
                      <TableCell className="text-[11px] font-mono text-muted-foreground py-3">{order.type}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">{fmtLarge(order.price !== "0" ? order.price : order.avgPrice)}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">{order.origQty}</TableCell>
                      <TableCell className="text-right py-3">
                        <Badge
                          variant="outline"
                          className={`text-[10px] font-mono ${
                            order.status === "FILLED" ? "border-green-500/40 text-green-400" :
                            order.status === "CANCELED" ? "border-red-500/40 text-red-400" :
                            order.status === "NEW" ? "border-primary/40 text-primary" :
                            "border-border/50 text-muted-foreground"
                          }`}
                        >
                          {order.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-28 text-center">
                      <div className="flex flex-col items-center gap-2 text-muted-foreground">
                        <Terminal className="h-7 w-7 opacity-15" />
                        <p className="text-sm">No recent orders</p>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      </main>
    </div>
  );
}
