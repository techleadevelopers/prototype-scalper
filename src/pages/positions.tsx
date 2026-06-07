import { useEffect } from "react";
import { useLocation } from "wouter";
import { useGetBingXSummary, useGetBingXPositions, getGetBingXSummaryQueryKey, getGetBingXPositionsQueryKey } from "@/api-client";
import AppShell from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Activity } from "lucide-react";

function fmt(val: string | number | undefined | null, dec = 2) {
  if (val === undefined || val === null) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return n >= 1000
    ? n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : n.toFixed(dec);
}

function PnL({ val, dec = 4 }: { val: string | number | undefined | null; dec?: number }) {
  const n = typeof val === "string" ? parseFloat(val as string) : (val ?? 0);
  if (!val || isNaN(n)) return <span className="text-muted-foreground font-mono">—</span>;
  if (n > 0) return <span className="text-green-400 font-mono font-semibold">+{n.toFixed(dec)}</span>;
  if (n < 0) return <span className="text-red-400 font-mono font-semibold">{n.toFixed(dec)}</span>;
  return <span className="text-muted-foreground font-mono">0.{"0".repeat(dec)}</span>;
}

export default function PositionsPage() {
  const [, setLocation] = useLocation();
  const { data: summary } = useGetBingXSummary({ query: { queryKey: getGetBingXSummaryQueryKey(), refetchInterval: 30000 } });
  const { data: positions, isLoading } = useGetBingXPositions({ query: { queryKey: getGetBingXPositionsQueryKey(), refetchInterval: 10000, enabled: !!summary?.connected } });

  useEffect(() => {
    if (summary && !summary.connected) setLocation("/");
  }, [summary, setLocation]);

  const totalPnl = (positions ?? []).reduce((s, p) => s + parseFloat(p.unrealizedProfit ?? "0"), 0);
  const totalMargin = (positions ?? []).reduce((s, p) => s + parseFloat(p.initialMargin ?? "0"), 0);
  const longs = (positions ?? []).filter((p) => p.positionSide === "LONG").length;
  const shorts = (positions ?? []).filter((p) => p.positionSide === "SHORT").length;

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Positions</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Live open futures positions — updates every 10s</p>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Open", value: String((positions ?? []).length) },
            { label: "Longs", value: String(longs), color: "text-green-400" },
            { label: "Shorts", value: String(shorts), color: "text-red-400" },
            { label: "Margin Used", value: `$${fmt(totalMargin)}` },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-card/50 border border-border/50 rounded-lg px-4 py-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{label}</p>
              <p className={`text-xl font-bold font-mono mt-0.5 ${color ?? ""}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Total unrealized PnL */}
        <div className={`flex items-center justify-between px-5 py-4 rounded-lg border ${totalPnl >= 0 ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-widest">Total Unrealized PnL</p>
            <p className={`text-3xl font-bold font-mono mt-1 ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(4)} <span className="text-sm font-normal text-muted-foreground">USDT</span>
            </p>
          </div>
          <div className={`text-5xl font-black opacity-10 ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
            {totalPnl >= 0 ? "▲" : "▼"}
          </div>
        </div>

        {/* Positions table */}
        <Card className="border-border/50 bg-card/30 overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/20">
              <TableRow className="hover:bg-transparent border-border/40">
                {["Symbol", "Side", "Leverage", "Size", "Entry Price", "Mark Price", "Liq. Price", "Margin", "PnL (USDT)", "ROI"].map((h, i) => (
                  <TableHead key={h} className={`text-[10px] uppercase tracking-widest text-muted-foreground py-2.5 font-mono ${i >= 3 ? "text-right" : ""}`}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={10} className="py-10 text-center"><Skeleton className="h-5 w-48 mx-auto" /></TableCell></TableRow>
              ) : positions && positions.length > 0 ? positions.map((p, i) => {
                const entry = parseFloat(p.entryPrice);
                const mark = parseFloat(p.markPrice);
                const margin = parseFloat(p.initialMargin ?? "0");
                const pnl = parseFloat(p.unrealizedProfit ?? "0");
                const roi = margin > 0 ? (pnl / margin) * 100 : 0;
                return (
                  <TableRow key={i} data-testid={`row-position-${i}`} className="border-border/30 hover:bg-muted/10">
                    <TableCell className="font-bold font-mono py-3">{p.symbol}</TableCell>
                    <TableCell className="py-3">
                      <span className={`font-bold font-mono text-xs px-2 py-0.5 rounded ${p.positionSide === "LONG" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                        {p.positionSide}
                      </span>
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge variant="outline" className="font-mono text-xs border-border/50">{p.leverage}x</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono py-3">{p.positionAmt}</TableCell>
                    <TableCell className="text-right font-mono py-3">{fmt(entry)}</TableCell>
                    <TableCell className="text-right font-mono py-3">{fmt(mark)}</TableCell>
                    <TableCell className="text-right font-mono py-3 text-orange-400">{fmt(p.liquidationPrice)}</TableCell>
                    <TableCell className="text-right font-mono py-3">${fmt(margin)}</TableCell>
                    <TableCell className="text-right py-3"><PnL val={p.unrealizedProfit} /></TableCell>
                    <TableCell className="text-right py-3"><PnL val={roi} dec={2} /></TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow>
                  <TableCell colSpan={10} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Activity className="h-8 w-8 opacity-15" />
                      <p className="text-sm">No open positions</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </AppShell>
  );
}
