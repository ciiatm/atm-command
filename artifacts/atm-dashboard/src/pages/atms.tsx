import { useState } from "react";
import { useListAtms, useCreateAtm, useUpdateAtm, useDeleteAtm, useGetAtmTransactions } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Search, Plus, RefreshCw, MapPin, Wifi, WifiOff, AlertTriangle, TrendingUp, ChevronRight } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { Atm, CreateAtmBody } from "@workspace/api-client-react";

function statusBadge(status: string) {
  if (status === "online") return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15"><Wifi className="w-3 h-3 mr-1" />Online</Badge>;
  if (status === "low_cash") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 hover:bg-amber-500/15"><AlertTriangle className="w-3 h-3 mr-1" />Low Cash</Badge>;
  if (status === "error") return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15"><AlertTriangle className="w-3 h-3 mr-1" />Error</Badge>;
  return <Badge variant="secondary"><WifiOff className="w-3 h-3 mr-1" />Offline</Badge>;
}

function pct(balance: number, capacity: number) {
  return Math.round((balance / capacity) * 100);
}

function BalanceBar({ balance, capacity, status }: { balance: number; capacity: number; status: string }) {
  const p = pct(balance, capacity);
  const color = status === "error" ? "bg-red-500" : status === "low_cash" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="w-full bg-muted rounded-full h-1.5 mt-1">
      <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${p}%` }} />
    </div>
  );
}

function ATMDetailSheet({ atm, open, onClose }: { atm: Atm | null; open: boolean; onClose: () => void }) {
  const { data: txData } = useGetAtmTransactions(atm?.id ?? 0, { days: "30" }, { query: { enabled: !!atm } });
  const chartData = (txData ?? []).slice(-14).map(t => ({ date: t.date.slice(5), dispensed: t.totalDispensed }));

  if (!atm) return null;
  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{atm.name}</SheetTitle>
          <p className="text-sm text-muted-foreground">{atm.address}, {atm.city}, {atm.state}</p>
        </SheetHeader>
        <div className="mt-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-muted/40 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Current Balance</p>
              <p className="text-xl font-bold">${atm.currentBalance.toLocaleString()}</p>
              <BalanceBar balance={atm.currentBalance} capacity={atm.cashCapacity} status={atm.status} />
              <p className="text-xs text-muted-foreground mt-1">{pct(atm.currentBalance, atm.cashCapacity)}% of ${atm.cashCapacity.toLocaleString()}</p>
            </div>
            <div className="bg-muted/40 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Daily Volume</p>
              <p className="text-xl font-bold">${(atm.avgDailyDispensed ?? 0).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-1">{atm.avgDailyTransactions ?? 0} transactions/day</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-muted-foreground">Status</span><div className="mt-1">{statusBadge(atm.status)}</div></div>
            <div><span className="text-muted-foreground">Portal</span><div className="mt-1 font-medium capitalize">{atm.portalSource?.replace(/_/g, " ")}</div></div>
            <div><span className="text-muted-foreground">Threshold</span><div className="mt-1 font-medium">${atm.lowCashThreshold.toLocaleString()}</div></div>
            <div><span className="text-muted-foreground">Last Synced</span><div className="mt-1 font-medium">{atm.lastSynced ? new Date(atm.lastSynced).toLocaleString() : "Never"}</div></div>
          </div>
          {chartData.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-2">14-Day Cash Dispensed</p>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={chartData}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, "Dispensed"]} />
                  <Line type="monotone" dataKey="dispensed" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const emptyForm: CreateAtmBody = {
  name: "", locationName: "", address: "", city: "", state: "", latitude: undefined, longitude: undefined,
  portalSource: "columbus_data", cashCapacity: 10000, currentBalance: 0, lowCashThreshold: 2000,
  avgDailyTransactions: undefined, avgDailyDispensed: undefined,
};

export default function ATMFleet() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [portalFilter, setPortalFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Atm | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<CreateAtmBody>(emptyForm);

  const { data: atms = [], refetch, isLoading } = useListAtms({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    portal: portalFilter !== "all" ? portalFilter : undefined,
  });
  const createAtm = useCreateAtm({ mutation: { onSuccess: () => { refetch(); setShowAdd(false); setForm(emptyForm); toast({ title: "ATM added" }); } } });
  const deleteAtm = useDeleteAtm({ mutation: { onSuccess: () => { refetch(); toast({ title: "ATM removed" }); } } });

  const online = atms.filter(a => a.status === "online").length;
  const lowCash = atms.filter(a => a.status === "low_cash").length;
  const errors = atms.filter(a => a.status === "error").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">ATM Fleet</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{atms.length} machines across your network</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="w-4 h-4 mr-1" />Refresh</Button>
          <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1" />Add ATM</Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-emerald-600">{online}</p>
          <p className="text-sm text-muted-foreground">Online</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">{lowCash}</p>
          <p className="text-sm text-muted-foreground">Low Cash</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-red-600">{errors}</p>
          <p className="text-sm text-muted-foreground">Errors</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search by name, city..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="online">Online</SelectItem>
            <SelectItem value="low_cash">Low Cash</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
          </SelectContent>
        </Select>
        <Select value={portalFilter} onValueChange={setPortalFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Portal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Portals</SelectItem>
            <SelectItem value="columbus_data">Columbus Data</SelectItem>
            <SelectItem value="switch_commerce">Switch Commerce</SelectItem>
            <SelectItem value="atm_transact">ATM Transact</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ATM list */}
      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Loading...</div>
      ) : (
        <div className="border rounded-lg divide-y bg-card">
          {atms.length === 0 && <div className="py-12 text-center text-muted-foreground">No ATMs found</div>}
          {atms.map(atm => (
            <div key={atm.id} className="flex items-center gap-4 p-4 hover:bg-muted/30 cursor-pointer transition-colors" onClick={() => setSelected(atm)}>
              <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm truncate">{atm.name}</p>
                  {statusBadge(atm.status)}
                </div>
                <p className="text-xs text-muted-foreground truncate">{atm.address}, {atm.city}, {atm.state}</p>
                <BalanceBar balance={atm.currentBalance} capacity={atm.cashCapacity} status={atm.status} />
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-semibold text-sm">${atm.currentBalance.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">${atm.cashCapacity.toLocaleString()} cap</p>
                <p className="text-xs text-muted-foreground capitalize">{atm.portalSource?.replace(/_/g, " ")}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
          ))}
        </div>
      )}

      {/* Detail Sheet */}
      <ATMDetailSheet atm={selected} open={!!selected} onClose={() => setSelected(null)} />

      {/* Add ATM Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add New ATM</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Machine Name</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Shell Gas - Main St" /></div>
              <div><Label>Location Name</Label><Input value={form.locationName ?? ""} onChange={e => setForm(f => ({ ...f, locationName: e.target.value }))} placeholder="Shell Gas Station" /></div>
            </div>
            <div><Label>Address</Label><Input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="456 Main St" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>City</Label><Input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="Columbus" /></div>
              <div><Label>State</Label><Input value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} placeholder="OH" maxLength={2} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Capacity ($)</Label><Input type="number" value={form.cashCapacity} onChange={e => setForm(f => ({ ...f, cashCapacity: +e.target.value }))} /></div>
              <div><Label>Low Cash Threshold ($)</Label><Input type="number" value={form.lowCashThreshold} onChange={e => setForm(f => ({ ...f, lowCashThreshold: +e.target.value }))} /></div>
            </div>
            <div>
              <Label>Portal</Label>
              <Select value={form.portalSource ?? "columbus_data"} onValueChange={v => setForm(f => ({ ...f, portalSource: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="columbus_data">Columbus Data</SelectItem>
                  <SelectItem value="switch_commerce">Switch Commerce</SelectItem>
                  <SelectItem value="atm_transact">ATM Transact</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={() => createAtm.mutate({ data: form })} disabled={!form.name || !form.address}>Add ATM</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
