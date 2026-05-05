import { useState, useRef, useCallback } from "react";
import { useListAtms, useCreateAtm, useUpdateAtm, useDeleteAtm, useGetAtmTransactions } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Search, Plus, RefreshCw, MapPin, Wifi, WifiOff, AlertTriangle, Upload, ChevronRight, FileSpreadsheet, CheckCircle2, XCircle, Pencil, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { Atm, CreateAtmBody } from "@workspace/api-client-react";
import * as XLSX from "xlsx";

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

// ---------------------------------------------------------------------------
// Excel import types
// ---------------------------------------------------------------------------

interface ImportRow {
  portalAtmId: string;
  name: string;
  locationName: string;
  address: string;
  city: string;
  state: string;
}

// Parse the specific "Active Terminal List" report format from the XLS
function parseTerminalSheet(wb: XLSX.WorkBook): ImportRow[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: "" });

  // Find the header row (contains "Terminal ID")
  const headerRowIdx = raw.findIndex((row: any[]) =>
    row.some((cell: any) => String(cell).trim() === "Terminal ID")
  );
  if (headerRowIdx === -1) throw new Error("Could not find 'Terminal ID' header row");

  const rows: ImportRow[] = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i] as any[];
    const terminalId = String(row[0] ?? "").trim();
    // Stop at summary footer row or empty terminal IDs
    if (!terminalId || terminalId.startsWith("Active Terminals for:")) break;

    const locationName = String(row[2] ?? "").trim();
    const address = String(row[3] ?? "").trim();
    const city = String(row[5] ?? "").trim();
    const state = String(row[6] ?? "").trim();
    const machineType = String(row[12] ?? "").trim();

    if (!locationName || !address || !city || !state) continue;

    rows.push({
      portalAtmId: terminalId,
      name: machineType || locationName,
      locationName,
      address,
      city,
      state,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Import dialog
// ---------------------------------------------------------------------------

function ImportDialog({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPreview(null);
    setImporting(false);
    setResult(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const handleClose = () => { reset(); onClose(); };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = ev.target?.result;
        const wb = XLSX.read(data, { type: "array" });
        const rows = parseTerminalSheet(wb);
        if (rows.length === 0) throw new Error("No terminal rows found in this file");
        setPreview(rows);
      } catch (err: any) {
        setError(err.message ?? "Failed to parse file");
        setPreview(null);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const res = await fetch("/api/atms/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview, skipExisting: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResult(data);
      onSuccess();
      toast({ title: `Imported ${data.imported} ATMs`, description: data.skipped ? `${data.skipped} already existed and were skipped` : undefined });
    } catch (err: any) {
      setError(err.message ?? "Import failed");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
            Import ATMs from Excel
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Upload your Active Terminal List report (.xls or .xlsx). ATMs with existing Terminal IDs will be skipped.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          {/* File picker */}
          {!result && (
            <div
              className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-6 text-center cursor-pointer hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-medium">{preview ? "Change file" : "Click to choose file"}</p>
              <p className="text-xs text-muted-foreground mt-1">.xls or .xlsx</p>
              <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden" onChange={handleFile} />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm bg-red-500/10 rounded-lg p-3">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Success result */}
          {result && (
            <div className="flex items-center gap-3 text-emerald-700 bg-emerald-500/10 rounded-lg p-4">
              <CheckCircle2 className="w-6 h-6 flex-shrink-0" />
              <div>
                <p className="font-medium">{result.imported} ATMs imported successfully</p>
                {result.skipped > 0 && <p className="text-sm text-muted-foreground">{result.skipped} skipped (already existed)</p>}
              </div>
            </div>
          )}

          {/* Preview table */}
          {preview && !result && (
            <div>
              <p className="text-sm font-medium mb-2">{preview.length} terminals found — preview:</p>
              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-64">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Terminal ID</th>
                        <th className="text-left px-3 py-2 font-medium">Location</th>
                        <th className="text-left px-3 py-2 font-medium">Address</th>
                        <th className="text-left px-3 py-2 font-medium">City</th>
                        <th className="text-left px-3 py-2 font-medium">ST</th>
                        <th className="text-left px-3 py-2 font-medium">Machine Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {preview.map((row, i) => (
                        <tr key={i} className="hover:bg-muted/30">
                          <td className="px-3 py-2 font-mono text-muted-foreground">{row.portalAtmId}</td>
                          <td className="px-3 py-2 font-medium">{row.locationName}</td>
                          <td className="px-3 py-2 text-muted-foreground">{row.address}</td>
                          <td className="px-3 py-2">{row.city}</td>
                          <td className="px-3 py-2">{row.state}</td>
                          <td className="px-3 py-2 text-muted-foreground truncate max-w-32">{row.name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-t pt-4">
          {result ? (
            <Button onClick={handleClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={handleImport}
                disabled={!preview || importing}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {importing ? "Importing..." : `Import ${preview?.length ?? 0} ATMs`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------

function EditDialog({ atm, onClose, onSaved }: { atm: Atm | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Partial<Atm>>({});

  // Reset form whenever the target ATM changes
  const prevId = useRef<number | null>(null);
  if (atm && atm.id !== prevId.current) {
    prevId.current = atm.id;
    setForm({ ...atm });
  }

  const updateAtm = useUpdateAtm({
    mutation: {
      onSuccess: () => { toast({ title: "ATM updated" }); onSaved(); onClose(); },
      onError: () => toast({ title: "Failed to save", variant: "destructive" }),
    },
  });

  if (!atm) return null;
  const f = { ...atm, ...form };

  const set = (key: keyof Atm, val: any) => setForm(prev => ({ ...prev, [key]: val }));

  return (
    <Dialog open={!!atm} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Edit ATM</DialogTitle></DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Machine Name</Label><Input value={f.name} onChange={e => set("name", e.target.value)} /></div>
            <div><Label>Location Name</Label><Input value={f.locationName} onChange={e => set("locationName", e.target.value)} /></div>
          </div>
          <div><Label>Address</Label><Input value={f.address} onChange={e => set("address", e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>City</Label><Input value={f.city} onChange={e => set("city", e.target.value)} /></div>
            <div><Label>State</Label><Input value={f.state} onChange={e => set("state", e.target.value)} maxLength={2} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Capacity ($)</Label><Input type="number" value={f.cashCapacity} onChange={e => set("cashCapacity", +e.target.value)} /></div>
            <div><Label>Low Cash Threshold ($)</Label><Input type="number" value={f.lowCashThreshold} onChange={e => set("lowCashThreshold", +e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Current Balance ($)</Label><Input type="number" value={f.currentBalance} onChange={e => set("currentBalance", +e.target.value)} /></div>
            <div>
              <Label>Status</Label>
              <Select value={f.status} onValueChange={v => set("status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="online">Online</SelectItem>
                  <SelectItem value="offline">Offline</SelectItem>
                  <SelectItem value="low_cash">Low Cash</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Terminal ID</Label><Input value={f.portalAtmId ?? ""} onChange={e => set("portalAtmId", e.target.value)} placeholder="L443079" /></div>
            <div>
              <Label>Portal</Label>
              <Select value={f.portalSource} onValueChange={v => set("portalSource", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="columbus_data">Columbus Data</SelectItem>
                  <SelectItem value="switch_commerce">Switch Commerce</SelectItem>
                  <SelectItem value="atm_transact">ATM Transact</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => updateAtm.mutate({ id: atm.id, data: form as any })}
            disabled={updateAtm.isPending}
          >
            {updateAtm.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [showImport, setShowImport] = useState(false);
  const [editAtm, setEditAtm] = useState<Atm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Atm | null>(null);
  const [form, setForm] = useState<CreateAtmBody>(emptyForm);

  const { data: atms = [], refetch, isLoading } = useListAtms({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    portal: portalFilter !== "all" ? portalFilter : undefined,
  });
  const createAtm = useCreateAtm({ mutation: { onSuccess: () => { refetch(); setShowAdd(false); setForm(emptyForm); toast({ title: "ATM added" }); } } });
  const deleteAtm = useDeleteAtm({ mutation: { onSuccess: () => { refetch(); setDeleteTarget(null); toast({ title: "ATM removed" }); } } });

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
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-4 h-4 mr-1" />Import Excel</Button>
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
            <div key={atm.id} className="flex items-center gap-4 p-4 hover:bg-muted/30 transition-colors group">
              <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setSelected(atm)}>
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm truncate">{atm.name}</p>
                  {statusBadge(atm.status)}
                </div>
                <p className="text-xs text-muted-foreground truncate">{atm.address}, {atm.city}, {atm.state}</p>
                <BalanceBar balance={atm.currentBalance} capacity={atm.cashCapacity} status={atm.status} />
              </div>
              <div className="text-right flex-shrink-0 cursor-pointer" onClick={() => setSelected(atm)}>
                <p className="font-semibold text-sm">${atm.currentBalance.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">${atm.cashCapacity.toLocaleString()} cap</p>
                <p className="text-xs text-muted-foreground capitalize">{atm.portalSource?.replace(/_/g, " ")}</p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setEditAtm(atm)}>
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10" onClick={() => setDeleteTarget(atm)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail Sheet */}
      <ATMDetailSheet atm={selected} open={!!selected} onClose={() => setSelected(null)} />

      {/* Edit Dialog */}
      <EditDialog atm={editAtm} onClose={() => setEditAtm(null)} onSaved={refetch} />

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove ATM?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove <span className="font-medium text-foreground">{deleteTarget?.name}</span> from your fleet. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && deleteAtm.mutate({ id: deleteTarget.id })} disabled={deleteAtm.isPending}>
              {deleteAtm.isPending ? "Removing..." : "Remove ATM"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <ImportDialog open={showImport} onClose={() => setShowImport(false)} onSuccess={() => { refetch(); setShowImport(false); }} />

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
