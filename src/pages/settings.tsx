import { useEffect } from "react";
import { useLocation } from "wouter";
import { useGetBingXSummary, useDisconnectBingX, getGetBingXSummaryQueryKey } from "@/api-client";
import AppShell from "@/components/app-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogOut, Shield, Zap, Info } from "lucide-react";

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  const { data: summary } = useGetBingXSummary({ query: { queryKey: getGetBingXSummaryQueryKey(), refetchInterval: 60000 } });
  const disconnectMutation = useDisconnectBingX();

  useEffect(() => {
    if (summary && !summary.connected) setLocation("/");
  }, [summary, setLocation]);

  const handleDisconnect = () => {
    disconnectMutation.mutate(undefined, { onSuccess: () => setLocation("/") });
  };

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[800px]">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Settings</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Session and security configuration</p>
        </div>

        {/* Connection status */}
        <Card className="border-border/50 bg-card/30">
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" /> Connection Status
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-3">
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-semibold">Connected to BingX Futures API</span>
              <Badge variant="outline" className="border-green-500/40 text-green-400 text-[10px]">ACTIVE</Badge>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-muted/20 rounded-lg p-3 space-y-1">
                <p className="text-muted-foreground uppercase tracking-widest text-[9px]">Balance</p>
                <p className="font-mono font-bold">${parseFloat(summary?.totalBalance ?? "0").toFixed(2)} USDT</p>
              </div>
              <div className="bg-muted/20 rounded-lg p-3 space-y-1">
                <p className="text-muted-foreground uppercase tracking-widest text-[9px]">Open Positions</p>
                <p className="font-mono font-bold">{summary?.openPositionsCount ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Security */}
        <Card className="border-border/50 bg-card/30">
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" /> Security
            </CardTitle>
            <CardDescription className="text-xs">How your credentials are handled</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-3 text-sm text-muted-foreground">
            <div className="space-y-2">
              {[
                "Your API Key and Secret are stored only in the server-side session — never in a database or localStorage.",
                "All BingX API calls are signed with HMAC-SHA256 on the backend. The Secret Key never leaves the server.",
                "Session is cleared when you disconnect or the server restarts.",
                "Recommendation: create a read-only API key with no withdrawal or transfer permissions.",
              ].map((text, i) => (
                <div key={i} className="flex gap-2.5 text-xs">
                  <span className="text-primary mt-0.5 shrink-0">·</span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Refresh intervals */}
        <Card className="border-border/50 bg-card/30">
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="w-4 h-4 text-primary" /> Refresh Intervals
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="space-y-2">
              {[
                { label: "BTC Compass", interval: "5s" },
                { label: "Positions", interval: "10–15s" },
                { label: "Account Summary", interval: "30s" },
                { label: "Orders", interval: "30s" },
                { label: "Analysis", interval: "60s" },
              ].map(({ label, interval }) => (
                <div key={label} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <Badge variant="outline" className="text-[10px] font-mono border-border/50">{interval}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Disconnect */}
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="text-sm text-destructive">Disconnect Account</CardTitle>
            <CardDescription className="text-xs">Clears your session and returns to the login screen.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={disconnectMutation.isPending}
              data-testid="button-disconnect-settings"
            >
              <LogOut className="w-4 h-4 mr-2" />
              {disconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
