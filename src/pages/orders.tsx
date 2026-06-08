import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useGetBingXSummary, useGetBingXOrders, getGetBingXSummaryQueryKey, getGetBingXOrdersQueryKey } from "@/api-client";
import AppShell from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClipboardList } from "lucide-react";

const STATUS_FILTERS = ["ALL", "FILLED", "NEW", "CANCELED", "PARTIALLY_FILLED"];

function fmt(val: string | number | undefined | null, dec = 2) {
  if (val === undefined || val === null) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return n >= 1000
    ? n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : n.toFixed(dec);
}

function PnL({ val }: { val: string | null | undefined }) {
  if (!val) return <span className="text-muted-foreground font-mono text-xs">—</span>;
  const n = parseFloat(val);
  if (isNaN(n) || n === 0) return <span className="text-muted-foreground font-mono text-xs">0.00</span>;
  if (n > 0) return <span className="text-green-400 font-mono text-xs font-semibold">+{n.toFixed(4)}</span>;
  return <span className="text-red-400 font-mono text-xs font-semibold">{n.toFixed(4)}</span>;
}

export default function OrdersPage() {
  const [, setLocation] = useLocation();
  const [statusFilter, setStatusFilter] = useState("ALL");

  const { data: summary } = useGetBingXSummary({ query: { queryKey: getGetBingXSummaryQueryKey(), refetchInterval: 30000 } });
  const { data: orders, isLoading } = useGetBingXOrders(
    { limit: 100 },
    { query: { queryKey: getGetBingXOrdersQueryKey({ limit: 100 }), refetchInterval: 30000, enabled: !!summary?.connected } }
  );

  useEffect(() => {
    if (summary && !summary.connected) setLocation("/");
  }, [summary, setLocation]);

  const filtered = (orders ?? []).filter((o) => statusFilter === "ALL" || o.status === statusFilter);
  const filled = (orders ?? []).filter((o) => o.status === "FILLED").length;
  const canceled = (orders ?? []).filter((o) => o.status === "CANCELED").length;
  const open = (orders ?? []).filter((o) => o.status === "NEW" || o.status === "PARTIALLY_FILLED").length;

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Orders</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Order history — last 100 orders</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Total", value: String((orders ?? []).length) },
            { label: "Filled", value: String(filled), color: "text-green-400" },
            { label: "Canceled", value: String(canceled), color: "text-red-400" },
            { label: "Open", value: String(open), color: "text-primary" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-card/50 border border-border/50 rounded-lg px-4 py-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{label}</p>
              <p className={`text-xl font-bold font-mono mt-0.5 ${color ?? ""}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Filter:</span>
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(s)}
              className={`text-xs h-7 px-3 ${statusFilter === s ? "" : "border-border/50 text-muted-foreground hover:text-foreground"}`}
            >
              {s}
            </Button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">{filtered.length} orders</span>
        </div>

        <Card className="border-border/50 bg-card/30 overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/20">
              <TableRow className="hover:bg-transparent border-border/40">
                {["Time", "Symbol", "Side", "Pos. Side", "Type", "Price / Avg", "Qty", "Profit", "Fee", "Status"].map((h, i) => (
                  <TableHead key={h} className={`text-[10px] uppercase tracking-widest text-muted-foreground py-2.5 font-mono ${i >= 5 ? "text-right" : ""}`}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={10} className="py-10 text-center"><Skeleton className="h-5 w-48 mx-auto" /></TableCell></TableRow>
              ) : filtered.length > 0 ? filtered.map((o, i) => (
                <TableRow key={i} data-testid={`row-order-${i}`} className="border-border/30 hover:bg-muted/10">
                  <TableCell className="text-[10px] font-mono text-muted-foreground py-2.5 whitespace-nowrap">
                    {new Date(o.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </TableCell>
                  <TableCell className="font-bold font-mono text-sm py-2.5">{o.symbol}</TableCell>
                  <TableCell className="py-2.5">
                    <span className={`font-bold font-mono text-xs ${o.side === "BUY" ? "text-green-400" : "text-red-400"}`}>{o.side}</span>
                  </TableCell>
                  <TableCell className="py-2.5">
                    <span className={`text-[10px] font-mono ${o.positionSide === "LONG" ? "text-green-400/70" : "text-red-400/70"}`}>{o.positionSide}</span>
                  </TableCell>
                  <TableCell className="text-[10px] font-mono text-muted-foreground py-2.5">{o.type}</TableCell>
                  <TableCell className="text-right font-mono text-sm py-2.5">
                    <div>{fmt(o.price !== "0" ? o.price : o.avgPrice)}</div>
                    {o.avgPrice && o.avgPrice !== "0" && o.avgPrice !== o.price && (
                      <div className="text-[9px] text-muted-foreground">avg: {fmt(o.avgPrice)}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm py-2.5">{o.origQty}</TableCell>
                  <TableCell className="text-right py-2.5"><PnL val={o.profit} /></TableCell>
                  <TableCell className="text-right py-2.5">
                    {o.commission ? <span className="text-[10px] font-mono text-muted-foreground">{parseFloat(o.commission).toFixed(4)}</span> : <span className="text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell className="text-right py-2.5">
                    <Badge variant="outline" className={`text-[9px] font-mono ${o.status === "FILLED" ? "border-green-500/40 text-green-400" : o.status === "CANCELED" ? "border-red-500/40 text-red-400" : o.status === "NEW" ? "border-primary/40 text-primary" : "border-border/50 text-muted-foreground"}`}>
                      {o.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={10} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <ClipboardList className="h-8 w-8 opacity-15" />
                      <p className="text-sm">No orders found</p>
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
