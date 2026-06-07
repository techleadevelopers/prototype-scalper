import { useEffect } from "react";
import { useLocation } from "wouter";
import {
  useGetBingXSummary,
  useGetBingXPositions,
  useGetBingXOrders,
  getGetBingXSummaryQueryKey,
  getGetBingXPositionsQueryKey,
  getGetBingXOrdersQueryKey,
} from "@/api-client";
import AppShell from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Wallet, Activity, TrendingUp, AlertTriangle } from "lucide-react";

function fmt(val: string | number | undefined | null, dec = 2) {
  if (val === undefined || val === null) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return n >= 1000
    ? n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : n.toFixed(dec);
}

function PnL({ val }: { val: string | number | undefined | null }) {
  const n = typeof val === "string" ? parseFloat(val as string) : (val ?? 0);
  if (!val || isNaN(n)) return <span className="text-muted-foreground font-mono">—</span>;
  if (n > 0) return <span className="text-green-400 font-mono font-semibold">+{n.toFixed(4)}</span>;
  if (n < 0) return <span className="text-red-400 font-mono font-semibold">{n.toFixed(4)}</span>;
  return <span className="text-muted-foreground font-mono">0.0000</span>;
}

export default function OverviewPage() {
  const [, setLocation] = useLocation();

  const { data: summary, isLoading: loadingSummary } = useGetBingXSummary({ query: { queryKey: getGetBingXSummaryQueryKey(), refetchInterval: 30000 } });
  const { data: positions, isLoading: loadingPositions } = useGetBingXPositions({ query: { queryKey: getGetBingXPositionsQueryKey(), refetchInterval: 15000, enabled: !!summary?.connected } });
  const { data: orders, isLoading: loadingOrders } = useGetBingXOrders({ limit: 20 }, { query: { queryKey: getGetBingXOrdersQueryKey({ limit: 20 }), refetchInterval: 30000, enabled: !!summary?.connected } });

  useEffect(() => {
    if (summary && !summary.connected) setLocation("/");
  }, [summary, setLocation]);

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Overview</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Account summary and live positions</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {[
            { label: "Total Balance", icon: Wallet, value: summary?.totalBalance, prefix: "$", suffix: "USDT" },
            { label: "Available", icon: Activity, value: summary?.availableBalance, prefix: "$", suffix: "USDT" },
            { label: "Unrealized PnL", icon: TrendingUp, value: null, pnl: summary?.totalUnrealizedPnl },
            { label: "Open Positions", icon: AlertTriangle, value: String(summary?.openPositionsCount ?? 0), raw: true },
          ].map(({ label, icon: Icon, value, prefix, suffix, pnl, raw }) => (
            <Card key={label} className="bg-card/50 border-border/50">
              <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
                <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</CardTitle>
                <Icon className="w-4 h-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loadingSummary ? (
                  <Skeleton className="h-7 w-28" />
                ) : pnl !== undefined ? (
                  <div className="text-2xl font-bold"><PnL val={pnl} /></div>
                ) : raw ? (
                  <div className="text-2xl font-bold font-mono">{value}</div>
                ) : (
                  <div className="text-2xl font-bold font-mono">
                    {prefix}{fmt(value)} <span className="text-xs text-muted-foreground font-normal">{suffix}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Positions quick view */}
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Active Positions</h2>
          <Card className="border-border/50 bg-card/30 overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/20">
                <TableRow className="hover:bg-transparent border-border/40">
                  {["Symbol", "Side", "Size", "Entry", "Mark", "Liq.", "PnL"].map((h) => (
                    <TableHead key={h} className="text-[10px] uppercase tracking-widest text-muted-foreground py-2 font-mono last:text-right">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingPositions ? (
                  <TableRow><TableCell colSpan={7} className="py-6 text-center"><Skeleton className="h-4 w-48 mx-auto" /></TableCell></TableRow>
                ) : positions && positions.length > 0 ? positions.map((p, i) => (
                  <TableRow key={i} className="border-border/30 hover:bg-muted/10">
                    <TableCell className="font-bold font-mono text-sm py-2.5">{p.symbol}</TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className={`font-bold font-mono text-xs ${p.positionSide === "LONG" ? "text-green-400" : "text-red-400"}`}>{p.positionSide}</span>
                        <Badge variant="outline" className="text-[9px] py-0 px-1 border-border/50 font-mono">{p.leverage}x</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm py-2.5">{p.positionAmt}</TableCell>
                    <TableCell className="text-right font-mono text-sm py-2.5">{fmt(p.entryPrice)}</TableCell>
                    <TableCell className="text-right font-mono text-sm py-2.5">{fmt(p.markPrice)}</TableCell>
                    <TableCell className="text-right font-mono text-sm py-2.5 text-orange-400">{fmt(p.liquidationPrice)}</TableCell>
                    <TableCell className="text-right py-2.5"><PnL val={p.unrealizedProfit} /></TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">No open positions</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>

        {/* Recent orders quick view */}
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent Orders (last 20)</h2>
          <Card className="border-border/50 bg-card/30 overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/20">
                <TableRow className="hover:bg-transparent border-border/40">
                  {["Time", "Symbol", "Side", "Type", "Price", "Qty", "Status"].map((h, i) => (
                    <TableHead key={h} className={`text-[10px] uppercase tracking-widest text-muted-foreground py-2 font-mono ${i >= 4 ? "text-right" : ""}`}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingOrders ? (
                  <TableRow><TableCell colSpan={7} className="py-6 text-center"><Skeleton className="h-4 w-48 mx-auto" /></TableCell></TableRow>
                ) : orders && orders.length > 0 ? orders.map((o, i) => (
                  <TableRow key={i} className="border-border/30 hover:bg-muted/10">
                    <TableCell className="text-[11px] font-mono text-muted-foreground py-2.5 whitespace-nowrap">
                      {new Date(o.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </TableCell>
                    <TableCell className="font-bold font-mono text-sm py-2.5">{o.symbol}</TableCell>
                    <TableCell className={`font-bold font-mono text-xs py-2.5 ${o.side === "BUY" ? "text-green-400" : "text-red-400"}`}>{o.side}</TableCell>
                    <TableCell className="text-[11px] font-mono text-muted-foreground py-2.5">{o.type}</TableCell>
                    <TableCell className="text-right font-mono text-sm py-2.5">{fmt(o.price !== "0" ? o.price : o.avgPrice)}</TableCell>
                    <TableCell className="text-right font-mono text-sm py-2.5">{o.origQty}</TableCell>
                    <TableCell className="text-right py-2.5">
                      <Badge variant="outline" className={`text-[9px] font-mono ${o.status === "FILLED" ? "border-green-500/40 text-green-400" : o.status === "CANCELED" ? "border-red-500/40 text-red-400" : "border-primary/40 text-primary"}`}>
                        {o.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">No recent orders</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
