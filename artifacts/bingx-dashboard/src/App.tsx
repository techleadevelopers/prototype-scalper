import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import OverviewPage from "@/pages/overview";
import PositionsPage from "@/pages/positions";
import OrdersPage from "@/pages/orders";
import AnalysisPage from "@/pages/analysis";
import SettingsPage from "@/pages/settings";
import BotPage from "@/pages/bot";
import DemoPage from "@/pages/demo";
import IntelligencePage from "@/pages/intelligence";
import TriggerPage from "@/pages/trigger";
import NeuralPage from "@/pages/neural";
import SniperPnlPage from "@/pages/sniper-pnl";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={LoginPage} />
      <Route path="/dashboard" component={OverviewPage} />
      <Route path="/positions" component={PositionsPage} />
      <Route path="/orders" component={OrdersPage} />
      <Route path="/analysis" component={AnalysisPage} />
      <Route path="/intelligence" component={IntelligencePage} />
      <Route path="/bot" component={BotPage} />
      <Route path="/demo" component={DemoPage} />
      <Route path="/trigger" component={TriggerPage} />
      <Route path="/neural" component={NeuralPage} />
      <Route path="/sniper-pnl" component={SniperPnlPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
