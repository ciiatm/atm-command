import { useState, useRef, useCallback } from "react";
import { useListAtms, useCreateAtm, useUpdateAtm, useDeleteAtm, useGetAtmTransactions } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Search, Plus, RefreshCw, MapPin, Wifi, WifiOff, AlertTriangle, Upload, FileSpreadsheet, CheckCircle2, XCircle, Pencil, Trash2, SquareCheck, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { Atm, CreateAtmBody } from "@workspace/api-client-react";
import * as XLSX from "xlsx";

interface TransactionLogEntry {
  id: number;
  atmId: number;
  transactedAt: string;
  cardNumber: string | null;
  transactionType: string | null;
  amount: number;
  response: string | null;
  terminalBalance: number | null;
}

function useAtmTransactionLog(atmId: number | undefined) {
  return useQuery<TransactionLogEntry[]>({
    queryKey: ["atm-transaction-log", atmId],
    queryFn: () => fetch(`/api/atms/${atmId}/transaction-log?limit=100`).then(r => r.json()),
    enabled: !!atmId,
    staleTime: 30_000,
  });
}

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

/** Returns true when the field contains real data (not the placeholder the scraper inserts) */
function hasAddress(atm: Atm) {
  const a = (atm.address ?? "").trim();
  return a.length > 0 && a.toLowerCase() !== "unknown";
}

function addressLine(atm: Atm) {
  if (!hasAddress(atm)) return null;
  return `${atm.address}, ${atm.city}, ${atm.state}`;
}

function responseColor(response: string | null) {
  if (!response) return "text-muted-foreground";
  const r = response.toLowerCase();
  if (r.includes("approve") || r.includes("success")) return "text-emerald-600";
  if (r.includes("decline") || r.includes("fail") || r.includes("error")) return "text-red-500";
  return "text-muted-foreground";
}

function ATMDetailSheet({ atm, open, onClose }: { atm: Atm | null; open: boolean; onClose: () => void }) {
  const { data: txData } = useGetAtmTransactions(atm?.id ?? 0, { days: "30" }, { query: { enabled: !!atm } });
  const { data: txLog = [] } = useAtmTransactionLog(atm?.id);
  const chartData = (txData ?? []).slice(-14).map(t => ({ date: t.date.slice(5), dispensed: t.totalDispensed }));

  if (!atm) return null;
  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle>{atm.locationName || atm.name}</SheetTitle>
          {addressLine(atm) && (
            <p className="text-sm text-muted-foreground">{addressLine(atm)}</p>
          )}
        </SheetHeader>

        <Tabs defaultValue="overview">
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="transactions">Transactions {txLog.length > 0 && <span className="ml-1.5 bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px] font-medium">{txLog.length}</span>}</TabsTrigger>
          </TabsList>

          {/* ── Overview tab ── */}
          <TabsContent value="overview" className="space-y-5 mt-0">
            {/* Balance + daily volume */}
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

            {/* Key fields grid */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-muted-foreground">Status</span><div className="mt-1">{statusBadge(atm.status)}</div></div>
              <div><span className="text-muted-foreground">Portal</span><div className="mt-1 font-medium capitalize">{atm.portalSource?.replace(/_/g, " ")}</div></div>
              <div><span className="text-muted-foreground">Terminal ID</span><div className="mt-1 font-mono text-xs font-medium">{atm.portalAtmId ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Surcharge</span><div className="mt-1 font-medium">{(atm as any).surcharge != null ? `$${Number((atm as any).surcharge).toFixed(2)}` : "—"}</div></div>
              <div><span className="text-muted-foreground">Low Cash Threshold</span><div className="mt-1 font-medium">${atm.lowCashThreshold.toLocaleString()}</div></div>
              <div><span className="text-muted-foreground">Cash Capacity</span><div className="mt-1 font-medium">${atm.cashCapacity.toLocaleString()}</div></div>
              {(atm as any).makeModel && <div><span className="text-muted-foreground">Machine Type</span><div className="mt-1 font-medium">{(atm as any).makeModel}</div></div>}
              <div><span className="text-muted-foreground">Last Synced</span><div className="mt-1 font-medium">{atm.lastSynced ? new Date(atm.lastSynced).toLocaleString() : "Never"}</div></div>
              {addressLine(atm) && (
                <div className="col-span-2"><span className="text-muted-foreground">Address</span><div className="mt-1 font-medium">{addressLine(atm)}</div></div>
              )}
            </div>

            {/* 14-day chart */}
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
          </TabsContent>

          {/* ── Transactions tab ── */}
          <TabsContent value="transactions" className="mt-0">
            {txLog.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-sm">
                No transactions recorded yet.
                <p className="text-xs mt-2 opacity-60 max-w-xs mx-auto">Transaction history is pulled from the portal during each sync. Run a portal sync to populate this data.</p>
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[60vh]">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0 z-10">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Date / Time</th>
                        <th className="text-left px-3 py-2 font-medium">Type</th>
                        <th className="text-right px-3 py-2 font-medium">Amount</th>
                        <th className="text-right px-3 py-2 font-medium">Balance After</th>
                        <th className="text-left px-3 py-2 font-medium">Response</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Card</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {txLog.map(tx => (
                        <tr key={tx.id} className="hover:bg-muted/20">
                          <td className="px-3 py-2 font-mono whitespace-nowrap text-muted-foreground">
                            {new Date(tx.transactedAt).toLocaleString()}
                          </td>
                          <td className="px-3 py-2 font-medium">{tx.transactionType ?? "—"}</td>
                          <td className="px-3 py-2 text-right font-medium">
                            {tx.amount != null ? `$${tx.amount.toLocaleString()}` : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {tx.terminalBalance != null ? `$${tx.terminalBalance.toLocaleString()}` : "—"}
                          </td>
                          <td className={`px-3 py-2 ${responseColor(tx.response)}`}>
                            {tx.response ?? "—"}
                          </td>
                          <td className="px-3 py-2 font-mono text-muted-foreground">
                            {tx.cardNumber ? `••${tx.cardNumber.slice(-4)}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/20">
                  Showing {txLog.length} most recent transaction{txLog.length !== 1 ? "s" : ""}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
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
            onClick={() => {
              // Only send fields the UpdateAtmBody schema accepts; convert null → undefined
              const payload: any = {};
              const allowed = ["name","locationName","address","city","state","serialNumber","cashCapacity","lowCashThreshold","status","latitude","longitude"] as const;
              for (const key of allowed) {
                const val = (f as any)[key];
                if (val !== null && val !== undefined) payload[key] = val;
              }
              updateAtm.mutate({ id: atm.id, data: payload });
            }}
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
  portalSource: "columbus_data", cashCapacity: 40000, currentBalance: 0, lowCashThreshold: 2000,
  avgDailyTransactions: undefined, avgDailyDispensed: undefined,
};

// ---------------------------------------------------------------------------
// Bulk edit dialog
// ---------------------------------------------------------------------------

interface BulkEditFields {
  lowCashThreshold: string;
  cashCapacity: string;
  portalSource: string;
  status: string;
}

function BulkEditDialog({ ids, onClose, onSaved }: { ids: number[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const updateAtm = useUpdateAtm();
  const [fields, setFields] = useState<BulkEditFields>({ lowCashThreshold: "", cashCapacity: "", portalSource: "", status: "" });
  const [saving, setSaving] = useState(false);

  const set = (k: keyof BulkEditFields, v: string) => setFields(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    const payload: Record<string, any> = {};
    if (fields.lowCashThreshold !== "") payload.lowCashThreshold = Number(fields.lowCashThreshold);
    if (fields.cashCapacity !== "") payload.cashCapacity = Number(fields.cashCapacity);
    if (fields.portalSource !== "") payload.portalSource = fields.portalSource;
    if (fields.status !== "") payload.status = fields.status;
    if (Object.keys(payload).length === 0) { onClose(); return; }
    setSaving(true);
    try {
      await Promise.all(ids.map(id => new Promise<void>((res, rej) =>
        updateAtm.mutate({ id, data: payload as any }, { onSuccess: () => res(), onError: rej })
      )));
      toast({ title: `Updated ${ids.length} ATM${ids.length !== 1 ? "s" : ""}` });
      onSaved();
      onClose();
    } catch {
      toast({ title: "Some updates failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Bulk Edit — {ids.length} ATM{ids.length !== 1 ? "s" : ""}</DialogTitle>
          <p className="text-xs text-muted-foreground">Only filled fields will be updated. Leave blank to keep existing value.</p>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div>
            <Label>Low Cash Threshold ($)</Label>
            <Input type="number" placeholder="e.g. 2000" value={fields.lowCashThreshold} onChange={e => set("lowCashThreshold", e.target.value)} />
          </div>
          <div>
            <Label>Cash Capacity ($)</Label>
            <Input type="number" placeholder="e.g. 40000" value={fields.cashCapacity} onChange={e => set("cashCapacity", e.target.value)} />
          </div>
          <div>
            <Label>Portal</Label>
            <Select value={fields.portalSource} onValueChange={v => set("portalSource", v)}>
              <SelectTrigger><SelectValue placeholder="Keep existing" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="columbus_data">Columbus Data</SelectItem>
                <SelectItem value="switch_commerce">Switch Commerce</SelectItem>
                <SelectItem value="atm_transact">ATM Transact</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={fields.status} onValueChange={v => set("status", v)}>
              <SelectTrigger><SelectValue placeholder="Keep existing" /></SelectTrigger>
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : `Apply to ${ids.length} ATM${ids.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

  // Bulk selection state
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

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

  const allChecked = atms.length > 0 && atms.every(a => checkedIds.has(a.id));
  const someChecked = checkedIds.size > 0;

  const toggleAll = () => {
    if (allChecked) setCheckedIds(new Set());
    else setCheckedIds(new Set(atms.map(a => a.id)));
  };
  const toggleOne = (id: number) => setCheckedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearSelection = () => setCheckedIds(new Set());

  const handleBulkDelete = async () => {
    setBulkDeleting(true);
    const ids = Array.from(checkedIds);
    try {
      await Promise.all(ids.map(id => fetch(`/api/atms/${id}`, { method: "DELETE" })));
      toast({ title: `Removed ${ids.length} ATM${ids.length !== 1 ? "s" : ""}` });
      clearSelection();
      refetch();
    } catch {
      toast({ title: "Some deletions failed", variant: "destructive" });
    } finally {
      setBulkDeleting(false);
      setShowBulkDeleteConfirm(false);
    }
  };

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

      {/* Bulk action toolbar — appears when any row is selected */}
      {someChecked && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
          <SquareCheck className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm font-medium">{checkedIds.size} selected</span>
          <div className="flex gap-2 ml-auto">
            <Button size="sm" variant="outline" onClick={() => setShowBulkEdit(true)}>
              <Pencil className="w-3.5 h-3.5 mr-1" />Edit
            </Button>
            <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300" onClick={() => setShowBulkDeleteConfirm(true)}>
              <Trash2 className="w-3.5 h-3.5 mr-1" />Delete
            </Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={clearSelection}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* ATM list */}
      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Loading...</div>
      ) : (
        <div className="border rounded-lg divide-y bg-card">
          {atms.length === 0 && <div className="py-12 text-center text-muted-foreground">No ATMs found</div>}

          {/* Header row with select-all */}
          {atms.length > 0 && (
            <div className="flex items-center gap-4 px-4 py-2 bg-muted/30 rounded-t-lg">
              <Checkbox
                checked={allChecked}
                onCheckedChange={toggleAll}
                aria-label="Select all"
              />
              <span className="text-xs text-muted-foreground">{allChecked ? "Deselect all" : `Select all ${atms.length}`}</span>
            </div>
          )}

          {atms.map(atm => (
            <div key={atm.id} className={`flex items-center gap-4 p-4 hover:bg-muted/30 transition-colors group ${checkedIds.has(atm.id) ? "bg-primary/5" : ""}`}>
              <Checkbox
                checked={checkedIds.has(atm.id)}
                onCheckedChange={() => toggleOne(atm.id)}
                onClick={e => e.stopPropagation()}
                aria-label={`Select ${atm.locationName ?? atm.name}`}
              />
              <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setSelected(atm)}>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm truncate">
                    {atm.locationName || atm.name}
                    {atm.portalAtmId && (
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground font-normal">({atm.portalAtmId})</span>
                    )}
                  </p>
                  {statusBadge(atm.status)}
                </div>
                {addressLine(atm) && (
                  <p className="text-xs text-muted-foreground truncate">{addressLine(atm)}</p>
                )}
                <BalanceBar balance={atm.currentBalance} capacity={atm.cashCapacity} status={atm.status} />
              </div>
              <div className="text-right flex-shrink-0 cursor-pointer" onClick={() => setSelected(atm)}>
                <p className="font-semibold text-sm">${atm.currentBalance.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">${atm.cashCapacity.toLocaleString()} cap</p>
                <p className="text-xs text-muted-foreground capitalize">{atm.portalSource?.replace(/_/g, " ")}</p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={e => { e.stopPropagation(); setEditAtm(atm); }}>
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10" onClick={e => { e.stopPropagation(); setDeleteTarget(atm); }}>
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

      {/* Bulk Edit Dialog */}
      {showBulkEdit && (
        <BulkEditDialog
          ids={Array.from(checkedIds)}
          onClose={() => setShowBulkEdit(false)}
          onSaved={() => { refetch(); clearSelection(); }}
        />
      )}

      {/* Bulk Delete Confirmation */}
      <Dialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {checkedIds.size} ATM{checkedIds.size !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove <span className="font-medium text-foreground">{checkedIds.size} ATM{checkedIds.size !== 1 ? "s" : ""}</span> from your fleet. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkDeleting}>
              {bulkDeleting ? "Removing..." : `Remove ${checkedIds.size} ATM${checkedIds.size !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Single Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove ATM?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove <span className="font-medium text-foreground">{deleteTarget?.locationName || deleteTarget?.name}</span> from your fleet. This cannot be undone.
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
