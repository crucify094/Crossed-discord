import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { AppLayout } from "./components/AppLayout";
import Dashboard from "./pages/Dashboard";
import AntiNuke from "./pages/AntiNuke";
import AntiRaid from "./pages/AntiRaid";
import AutoMod from "./pages/AutoMod";
import Jail from "./pages/Jail";
import Leveling from "./pages/Leveling";
import ReactionRoles from "./pages/ReactionRoles";
import Welcome from "./pages/Welcome";
import SocialAlerts from "./pages/SocialAlerts";
import AuditLogs from "./pages/AuditLogs";
import BotSettings from "./pages/BotSettings";
import Commands from "./pages/Commands";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5,
    }
  }
});

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/security/antinuke" component={AntiNuke} />
        <Route path="/security/antiraid" component={AntiRaid} />
        <Route path="/moderation/automod" component={AutoMod} />
        <Route path="/moderation/jail" component={Jail} />
        <Route path="/engagement/leveling" component={Leveling} />
        <Route path="/engagement/reaction-roles" component={ReactionRoles} />
        <Route path="/engagement/welcome" component={Welcome} />
        <Route path="/commands" component={Commands} />
        <Route path="/social-alerts" component={SocialAlerts} />
        <Route path="/logs" component={AuditLogs} />
        <Route path="/bot-settings" component={BotSettings} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
