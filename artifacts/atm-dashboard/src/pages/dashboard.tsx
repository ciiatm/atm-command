import { useGetDashboardSummary, useGetDashboardCashFlow, useGetDashboardTopAtms, useGetDashboardAlertsSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Banknote, AlertTriangle, Activity, AlertCircle, TrendingUp, MonitorOff, Terminal } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Link } from "wouter";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: cashFlow, isLoading: isLoadingCashFlow } = useGetDashboardCashFlow({ days: 14 });
  const { data: topAtms, isLoading: isLoadingTopAtms } = useGetDashboardTopAtms();
  const { data: alerts, isLoading: isLoadingAlerts } = useGetDashboardAlertsSummary();

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between md:items-center gap-4">
        <h2 className="text-3xl font-bold tracking-tight">Command Center</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Fleet Health</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Skeleton className="h-8 w-24" /> : (
              <>
                <div className="text-2xl font-bold">{summary?.onlineAtms} / {summary?.totalAtms}</div>
                <p className="text-xs text-muted-foreground mt-1">ATMs Online</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cash Deployed</CardTitle>
            <Banknote className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Skeleton className="h-8 w-24" /> : (
              <>
                <div className="text-2xl font-bold">${summary?.totalCashDeployed.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground mt-1">Total Vault Cash</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Alerts</CardTitle>
            <AlertCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            {isLoadingAlerts ? <Skeleton className="h-8 w-24" /> : (
              <>
                <div className="text-2xl font-bold text-destructive">{alerts?.totalUnresolved}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {alerts?.critical} Critical, {alerts?.warning} Warning
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Today's Volume</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Skeleton className="h-8 w-24" /> : (
              <>
                <div className="text-2xl font-bold">${summary?.todayDispensed.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground mt-1">Dispensed Today</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Cash Flow</CardTitle>
          </CardHeader>
          <CardContent className="pl-2">
            {isLoadingCashFlow ? (
              <div className="h-[300px] flex items-center justify-center">
                <Skeleton className="h-[250px] w-full" />
              </div>
            ) : cashFlow && cashFlow.length > 0 ? (
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={cashFlow} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorDispensed" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(val) => format(new Date(val), 'MMM d')}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                    />
                    <YAxis 
                      tickFormatter={(val) => `$${val / 1000}k`}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`$${value.toLocaleString()}`, "Dispensed"]}
                      labelFormatter={(label) => format(new Date(label), 'MMM d, yyyy')}
                    />
                    <Area type="monotone" dataKey="dispensed" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#colorDispensed)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                No cash flow data available.
              </div>
            )}
          </CardContent>
        </Card>
        
        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Top Performing ATMs</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingTopAtms ? (
              <div className="space-y-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : topAtms && topAtms.length > 0 ? (
              <div className="space-y-4">
                {topAtms.map((atm) => (
                  <Link key={atm.id} href={`/atms/${atm.id}`}>
                    <div className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors">
                      <div className="space-y-1">
                        <p className="text-sm font-medium leading-none">{atm.name}</p>
                        <p className="text-xs text-muted-foreground">{atm.locationName}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-primary">${atm.avgDailyDispensed.toLocaleString()}/d</p>
                        <p className="text-xs text-muted-foreground">{atm.avgDailyTransactions} txns</p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground text-sm">
                No performance data available.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
