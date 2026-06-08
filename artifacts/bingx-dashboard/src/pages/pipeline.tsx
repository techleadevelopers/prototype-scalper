import { useQuery } from "@tanstack/react-query";
import AppShell from "@/components/app-shell";
import { apiUrl } from "@/lib/api-url";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, GitBranch, GraduationCap, ShieldCheck } from "lucide-react";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface PipelineGap {
  severity: Severity;
  code: string;
  message: string;
  entityType: string;
  entityId: string | null;
  previousId?: string | null;
}

interface PipelineAuditReport {
  health: "HEALTHY" | "DEGRADED" | "CRITICAL";
  totalSignals: number;
  totalOrders: number;
  totalPositions: number;
  totalOutcomes: number;
  criticalGaps: PipelineGap[];
  highGaps: PipelineGap[];
  mediumGaps: PipelineGap[];
  lowGaps: PipelineGap[];
  orphanSignals: number;
  orphanOrders: number;
  orphanPositions: number;
  duplicateExecutions: number;
  learningEligibleOutcomes: number;
  blockedFromLearning: number;
  gapsByStage: Record<string, number>;
  topIntegrityLossCauses: Array<{ code: string; count: number; severity: Severity }>;
  latestCriticalFailures: PipelineGap[];
}

async function fetchPipelineAudit(): Promise<PipelineAuditReport> {
  const response = await fetch(apiUrl("/api/pipeline/audit"), { credentials: "include" });
  if (!response.ok) throw new Error(`Pipeline audit failed: HTTP ${response.status}`);
  return response.json();
}

function healthTone(health: PipelineAuditReport["health"]) {
  if (health === "HEALTHY") return "text-green-400 border-green-500/30 bg-green-500/10";
  if (health === "DEGRADED") return "text-yellow-300 border-yellow-500/30 bg-yellow-500/10";
  return "text-red-300 border-red-500/30 bg-red-500/10";
}

function severityTone(severity: Severity) {
  if (severity === "CRITICAL") return "text-red-300 border-red-500/30 bg-red-500/10";
  if (severity === "HIGH") return "text-orange-300 border-orange-500/30 bg-orange-500/10";
  if (severity === "MEDIUM") return "text-yellow-300 border-yellow-500/30 bg-yellow-500/10";
  return "text-muted-foreground";
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border/40 bg-muted/10 px-3 py-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

export default function PipelinePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["pipeline-audit"],
    queryFn: fetchPipelineAudit,
    refetchInterval: 15_000,
  });

  return (
    <AppShell>
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-normal">Pipeline Health</h1>
            <p className="text-sm text-muted-foreground">Lineage audit from signal to learning eligibility.</p>
          </div>
          {data && <Badge className={healthTone(data.health)}>{data.health}</Badge>}
        </div>

        {isLoading && <Skeleton className="h-80 w-full" />}
        {error && (
          <Card>
            <CardContent className="p-4 text-sm text-red-300">{error instanceof Error ? error.message : "Audit unavailable"}</CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Signals" value={data.totalSignals} />
              <Stat label="Orders" value={data.totalOrders} />
              <Stat label="Positions" value={data.totalPositions} />
              <Stat label="Outcomes" value={data.totalOutcomes} />
              <Stat label="Critical gaps" value={data.criticalGaps.length} />
              <Stat label="High gaps" value={data.highGaps.length} />
              <Stat label="Eligible learning" value={data.learningEligibleOutcomes} />
              <Stat label="Blocked learning" value={data.blockedFromLearning} />
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm"><GitBranch className="h-4 w-4" /> Gaps por etapa</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {Object.entries(data.gapsByStage).length === 0 && <div className="text-sm text-muted-foreground">Sem gaps registrados.</div>}
                  {Object.entries(data.gapsByStage).map(([stage, count]) => (
                    <div key={stage} className="flex items-center justify-between text-sm">
                      <span className="capitalize text-muted-foreground">{stage}</span>
                      <span className="font-mono">{count}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm"><GraduationCap className="h-4 w-4" /> Treino</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Orphan signals</span><span className="font-mono">{data.orphanSignals}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Orphan orders</span><span className="font-mono">{data.orphanOrders}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Orphan positions</span><span className="font-mono">{data.orphanPositions}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Duplicate executions</span><span className="font-mono">{data.duplicateExecutions}</span></div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4" /> Top causas</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data.topIntegrityLossCauses.map((cause) => (
                    <div key={cause.code} className="flex items-center justify-between gap-2 text-xs">
                      <Badge variant="outline" className={severityTone(cause.severity)}>{cause.severity}</Badge>
                      <span className="min-w-0 flex-1 truncate font-mono">{cause.code}</span>
                      <span className="font-mono">{cause.count}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4" /> Últimas 50 falhas críticas</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-hidden rounded-md border border-border/40">
                  {data.latestCriticalFailures.length === 0 && <div className="p-3 text-sm text-muted-foreground">Nenhuma falha crítica.</div>}
                  {data.latestCriticalFailures.map((gap, idx) => (
                    <div key={`${gap.code}-${gap.entityId}-${idx}`} className="grid grid-cols-[120px_1fr_180px] gap-3 border-b border-border/30 px-3 py-2 text-xs last:border-0">
                      <Badge variant="outline" className={severityTone(gap.severity)}>{gap.severity}</Badge>
                      <div className="min-w-0">
                        <div className="truncate font-mono">{gap.code}</div>
                        <div className="truncate text-muted-foreground">{gap.message}</div>
                      </div>
                      <div className="truncate text-right font-mono text-muted-foreground">{gap.entityId ?? "no-id"}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
