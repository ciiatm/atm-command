import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";

import Dashboard from "@/pages/dashboard";
import ATMFleet from "@/pages/atms";
import CashPlanningPage from "@/pages/cash-planning";
import RoutesPage from "@/pages/routes";
import AlertsPage from "@/pages/alerts";
import PortalsPage from "@/pages/portals";
import BookkeepingPage from "@/pages/bookkeeping";
import MileagePage from "@/pages/mileage";
import PayrollPage from "@/pages/payroll";
import TransactionsPage from "@/pages/transactions";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/atms" component={ATMFleet} />
        <Route path="/cash-planning" component={CashPlanningPage} />
        <Route path="/routes" component={RoutesPage} />
        <Route path="/alerts" component={AlertsPage} />
        <Route path="/portals" component={PortalsPage} />
        <Route path="/bookkeeping" component={BookkeepingPage} />
        <Route path="/mileage" component={MileagePage} />
        <Route path="/payroll" component={PayrollPage} />
        <Route path="/transactions" component={TransactionsPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
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
