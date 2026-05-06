import { useState, useRef, useCallback, useEffect } from "react";
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
import {
  Search, Plus, RefreshCw, MapPin, Wifi, WifiOff, AlertTriangle,
  Upload, FileSpreadsheet, CheckCircle2, XCircle, Pencil, Trash2,
  SquareCheck, X, DollarSign, Receipt, ArrowUpDown,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { Atm, CreateAtmBody } from "@workspace/api-client-react";
import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface TransactionRow {
  id: number;
  atmId: number;
  terminalId: string | null;
  transactedAt: string;
  transactionType: string | null;
  cardNumber: string | null;
  amount: number | null;
  response: string | null;
  terminalBalance: number | null;
  amountRequested: number | null;
  feeRequested: number | null;
  amountDispensed: number | null;
  feeAmount: number | null;
  termSeq: string | null;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useAtmTransactionLog(atmId: number | undefined) {
  return useQuery<TransactionLogEntry[]>({
    queryKey: ["atm-transaction-log", atmId],
    queryFn: () => fetch(`/api/atms/${atmId}/transaction-log?limit=100`).then(r => r.json()),
    enabled: !!atmId,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function statusBadge(status: string) {
  if (status === "online")   return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15"><Wifi className="w-3 h-3 mr-1" />Online</Badge>;
  if (status === "low_cash") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 hover:bg-amber-500/15"><AlertTriangle className="w-3 h-3 mr-1" />Low Cash</Badge>;
  if (status === "error")    return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15"><AlertTriangle className="w-3 h-3 mr-1" />Error</Badge>;
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
      <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${Math.min(100, p)}%` }} />
    </div>
  );
}

function hasAddress(atm: Atm) {
  const a = (atm.address ?? "").trim();
  return a.length > 0 && a.toLowerCase() !== "unknown";
}

function addressLine(atm: Atm) {
  if (!hasAddress(atm)) return null;
  const parts = [atm.address, atm.city, atm.state].filter(Boolean);
  return parts.join(", ");
}

function responseColor(response: string | null) {
  if (!response) return "text-muted-foreground";
  const r = response.toLowerCase();
  if (r.includes("approve") || r.includes("success")) return "text-emerald-600";
  if (r.includes("decline") || r.includes("fail") || r.includes("error")) return "text-red-500";
  return "text-muted-foreground";
}

function fmtDollar(val: number | null | undefined): string {
  if (val == null) return "—";
  return `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function responseBadge(response: string | null) {
  if (!response) return <span className="text-muted-foreground">—</span>;
  const lower = response.toLowerCase();
  if (lower.includes("approv")) return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-xs">{response}</Badge>;
  if (lower.includes("declin") || lower.includes("error") || lower.includes("fail")) return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 text-xs">{response}</Badge>;
  return <Badge variant="secondary" className="text-xs">{response}</Badge>;
}

// ---------------------------------------------------------------------------
// ATM Detail Sheet
// ---------------------------------------------------------------------------

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
          {addressLine(atm) && <p className="text-sm text-muted-foreground">{addressLine(atm)}</p>}
        </SheetHeader>

        <Tabs defaultValue="overview">
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="transactions">
              Transactions
              {txLog.length > 0 && <span className="ml-1.5 bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px] font-medium">{txLog.length}</span>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-5 mt-0">
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
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-muted-foreground">Status</span><div className="mt-1">{statusBadge(atm.status)}</div></div>
              <div><span className="text-muted-foreground">Portal</span><div className="mt-1 font-medium capitalize">{atm.portalSource?.replace(/_/g, " ")}</div></div>
              <div><span className="text-muted-foreground">Terminal ID</span><div className="mt-1 font-mono text-xs font-medium">{atm.portalAtmId ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Surcharge</span><div className="mt-1 font-medium">{(atm as any).surcharge != null ? `$${Number((atm as any).surcharge).toFixed(2)}` : "—"}</div></div>
              <div><span className="text-muted-foreground">Low Cash Threshold</span><div className="mt-1 font-medium">${atm.lowCashThreshold.toLocaleString()}</div></div>
              <div><span className="text-muted-foreground">Cash Capacity</span><div className="mt-1 font-medium">${atm.cashCapacity.toLocaleString()}</div></div>
              {(atm as any).makeModel && <div><span className="text-muted-foreground">Machine Type</span><div className="mt-1 font-medium">{(atm as any).makeModel}</div></div>}
              {(atm as any).propertyType && <div><span className="text-muted-foreground">Property Type</span><div className="mt-1 font-medium">{(atm as any).propertyType}</div></div>}
              <div><span className="text-muted-foreground">Last Synced</span><div className="mt-1 font-medium">{atm.lastSynced ? new Date(atm.lastSynced).toLocaleString() : "Never"}</div></div>
              {addressLine(atm) && <div className="col-span-2"><span className="text-muted-foreground">Address</span><div className="mt-1 font-medium">{addressLine(atm)}</div></div>}
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
          </TabsContent>

          <TabsContent value="transactions" className="mt-0">
            {txLog.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-sm">
                No transactions recorded yet.
                <p className="text-xs mt-2 opacity-60 max-w-xs mx-auto">Transaction history is pulled from the portal during each sync.</p>
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
                          <td className="px-3 py-2 font-mono whitespace-nowrap text-muted-foreground">{new Date(tx.transactedAt).toLocaleString()}</td>
                          <td className="px-3 py-2 font-medium">{tx.transactionType ?? "—"}</td>
                          <td className="px-3 py-2 text-right font-medium">{tx.amount != null ? `$${tx.amount.toLocaleString()}` : "—"}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{tx.terminalBalance != null ? `$${tx.terminalBalance.toLocaleString()}` : "—"}</td>
                          <td className={`px-3 py-2 ${responseColor(tx.response)}`}>{tx.response ?? "—"}</td>
                          <td className="px-3 py-2 font-mono text-muted-foreground">{tx.cardNumber ? `••${tx.cardNumber.slice(-4)}` : "—"}</td>
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
// Excel import
// ---------------------------------------------------------------------------

interface ImportRow {
  portalAtmId: string;
  name: string;
  locationName: string;
  address: string;
  city: string;
  state: string;
}

function parseTerminalSheet(wb: XLSX.WorkBook): ImportRow[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: "" });
  const headerRowIdx = raw.findIndex((row: any[]) => row.some((cell: any) => String(cell).trim() === "Terminal ID"));
  if (headerRowIdx === -1) throw new Error("Could not find 'Terminal ID' header row");
  const rows: ImportRow[] = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i] as any[];
    const terminalId = String(row[0] ?? "").trim();
    if (!terminalId || terminalId.startsWith("Active Terminals for:")) break;
    const locationName = String(row[2] ?? "").trim();
    const address = String(row[3] ?? "").trim();
    const city = String(row[5] ?? "").trim();
    const state = String(row[6] ?? "").trim();
    const machineType = String(row[12] ?? "").trim();
    if (!locationName || !address || !city || !state) continue;
    rows.push({ portalAtmId: terminalId, name: machineType || locationName, locationName, address, city, state });
  }
  return rows;
}

function ImportDialog({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => { setPreview(null); setImporting(false); setResult(null); setError(null); if (fileRef.current) fileRef.current.value = ""; }, []);
  const handleClose = () => { reset(); onClose(); };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result, { type: "array" });
        const rows = parseTerminalSheet(wb);
        if (rows.length === 0) throw new Error("No terminal rows found in this file");
        setPreview(rows);
      } catch (err: any) { setError(err.message ?? "Failed to parse file"); setPreview(null); }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const res = await fetch("/api/atms/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: preview, skipExisting: true }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResult(data);
      onSuccess();
      toast({ title: `Imported ${data.imported} ATMs`, description: data.skipped ? `${data.skipped} already existed and were skipped` : undefined });
    } catch (err: any) { setError(err.message ?? "Import failed"); }
    finally { setImporting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="w-5 h-5 text-emerald-600" />Import ATMs from Excel</DialogTitle>
          <p className="text-sm text-muted-foreground">Upload your Active Terminal List report (.xls or .xlsx). ATMs with existing Terminal IDs will be skipped.</p>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          {!result && (
            <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-6 text-center cursor-pointer hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors" onClick={() => fileRef.current?.click()}>
              <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-medium">{preview ? "Change file" : "Click to choose file"}</p>
              <p className="text-xs text-muted-foreground mt-1">.xls or .xlsx</p>
              <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden" onChange={handleFile} />
            </div>
          )}
          {error && <div className="flex items-center gap-2 text-red-600 text-sm bg-red-500/10 rounded-lg p-3"><XCircle className="w-4 h-4 flex-shrink-0" />{error}</div>}
          {result && (
            <div className="flex items-center gap-3 text-emerald-700 bg-emerald-500/10 rounded-lg p-4">
              <CheckCircle2 className="w-6 h-6 flex-shrink-0" />
              <div><p className="font-medium">{result.imported} ATMs imported successfully</p>{result.skipped > 0 && <p className="text-sm text-muted-foreground">{result.skipped} skipped</p>}</div>
            </div>
          )}
          {preview && !result && (
            <div>
              <p className="text-sm font-medium mb-2">{preview.length} terminals found — preview:</p>
              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-64">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0"><tr><th className="text-left px-3 py-2">Terminal ID</th><th className="text-left px-3 py-2">Location</th><th className="text-left px-3 py-2">Address</th><th className="text-left px-3 py-2">City</th><th className="text-left px-3 py-2">ST</th></tr></thead>
                    <tbody className="divide-y">{preview.map((row, i) => (<tr key={i} className="hover:bg-muted/30"><td className="px-3 py-2 font-mono text-muted-foreground">{row.portalAtmId}</td><td className="px-3 py-2 font-medium">{row.locationName}</td><td className="px-3 py-2 text-muted-foreground">{row.address}</td><td className="px-3 py-2">{row.city}</td><td className="px-3 py-2">{row.state}</td></tr>))}</tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="border-t pt-4">
          {result ? <Button onClick={handleClose}>Done</Button> : (<><Button variant="outline" onClick={handleClose}>Cancel</Button><Button onClick={handleImport} disabled={!preview || importing} className="bg-emerald-600 hover:bg-emerald-700">{importing ? "Importing..." : `Import ${preview?.length ?? 0} ATMs`}</Button></>)}
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
  const prevId = useRef<number | null>(null);
  if (atm && atm.id !== prevId.current) { prevId.current = atm.id; setForm({ ...atm }); }
  const updateAtm = useUpdateAtm({ mutation: { onSuccess: () => { toast({ title: "ATM updated" }); onSaved(); onClose(); }, onError: () => toast({ title: "Failed to save", variant: "destructive" }) } });
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
            <div><Label>Status</Label>
              <Select value={f.status} onValueChange={v => set("status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="online">Online</SelectItem><SelectItem value="offline">Offline</SelectItem>
                  <SelectItem value="low_cash">Low Cash</SelectItem><SelectItem value="error">Error</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Terminal ID</Label><Input value={f.portalAtmId ?? ""} onChange={e => set("portalAtmId", e.target.value)} placeholder="L443079" /></div>
            <div><Label>Portal</Label>
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
          <Button onClick={() => {
            const payload: any = {};
            const allowed = ["name","locationName","address","city","state","serialNumber","cashCapacity","lowCashThreshold","status","latitude","longitude"] as const;
            for (const key of allowed) { const val = (f as any)[key]; if (val !== null && val !== undefined) payload[key] = val; }
            updateAtm.mutate({ id: atm.id, data: payload });
          }} disabled={updateAtm.isPending}>{updateAtm.isPending ? "Saving..." : "Save Changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk edit dialog
// ---------------------------------------------------------------------------

interface BulkEditFields { lowCashThreshold: string; cashCapacity: string; portalSource: string; status: string; }

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
      await Promise.all(ids.map(id => new Promise<void>((res, rej) => updateAtm.mutate({ id, data: payload as any }, { onSuccess: () => res(), onError: rej }))));
      toast({ title: `Updated ${ids.length} ATM${ids.length !== 1 ? "s" : ""}` });
      onSaved(); onClose();
    } catch { toast({ title: "Some updates failed", variant: "destructive" }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Bulk Edit — {ids.length} ATM{ids.length !== 1 ? "s" : ""}</DialogTitle><p className="text-xs text-muted-foreground">Only filled fields will be updated.</p></DialogHeader>
        <div className="grid gap-3 py-2">
          <div><Label>Low Cash Threshold ($)</Label><Input type="number" placeholder="e.g. 2000" value={fields.lowCashThreshold} onChange={e => set("lowCashThreshold", e.target.value)} /></div>
          <div><Label>Cash Capacity ($)</Label><Input type="number" placeholder="e.g. 40000" value={fields.cashCapacity} onChange={e => set("cashCapacity", e.target.value)} /></div>
          <div><Label>Portal</Label>
            <Select value={fields.portalSource} onValueChange={v => set("portalSource", v)}>
              <SelectTrigger><SelectValue placeholder="Keep existing" /></SelectTrigger>
              <SelectContent><SelectItem value="columbus_data">Columbus Data</SelectItem><SelectItem value="switch_commerce">Switch Commerce</SelectItem><SelectItem value="atm_transact">ATM Transact</SelectItem><SelectItem value="manual">Manual</SelectItem></SelectContent>
            </Select>
          </div>
          <div><Label>Status</Label>
            <Select value={fields.status} onValueChange={v => set("status", v)}>
              <SelectTrigger><SelectValue placeholder="Keep existing" /></SelectTrigger>
              <SelectContent><SelectItem value="online">Online</SelectItem><SelectItem value="offline">Offline</SelectItem><SelectItem value="low_cash">Low Cash</SelectItem><SelectItem value="error">Error</SelectItem><SelectItem value="unknown">Unknown</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : `Apply to ${ids.length} ATM${ids.length !== 1 ? "s" : ""}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Tab: Info (ATM list)
// ---------------------------------------------------------------------------

function InfoTab({ atms, isLoading, refetch }: { atms: Atm[]; isLoading: boolean; refetch: () => void }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [portalFilter, setPortalFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Atm | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editAtm, setEditAtm] = useState<Atm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Atm | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [form, setForm] = useState<CreateAtmBody>({ name: "", locationName: "", address: "", city: "", state: "", latitude: undefined, longitude: undefined, portalSource: "columbus_data", cashCapacity: 40000, currentBalance: 0, lowCashThreshold: 2000, avgDailyTransactions: undefined, avgDailyDispensed: undefined });
  const { toast } = useToast();
  const createAtm = useCreateAtm({ mutation: { onSuccess: () => { refetch(); setShowAdd(false); toast({ title: "ATM added" }); } } });
  const deleteAtm = useDeleteAtm({ mutation: { onSuccess: () => { refetch(); setDeleteTarget(null); toast({ title: "ATM removed" }); } } });

  const filtered = atms.filter(a => {
    const s = search.toLowerCase();
    const matchSearch = !s || (a.locationName ?? "").toLowerCase().includes(s) || a.name.toLowerCase().includes(s) || (a.city ?? "").toLowerCase().includes(s) || (a.portalAtmId ?? "").toLowerCase().includes(s);
    const matchStatus = statusFilter === "all" || a.status === statusFilter;
    const matchPortal = portalFilter === "all" || a.portalSource === portalFilter;
    return matchSearch && matchStatus && matchPortal;
  });

  const online = atms.filter(a => a.status === "online").length;
  const lowCash = atms.filter(a => a.status === "low_cash").length;
  const errors = atms.filter(a => a.status === "error").length;

  const allChecked = filtered.length > 0 && filtered.every(a => checkedIds.has(a.id));
  const someChecked = checkedIds.size > 0;
  const toggleAll = () => { if (allChecked) setCheckedIds(new Set()); else setCheckedIds(new Set(filtered.map(a => a.id))); };
  const toggleOne = (id: number) => setCheckedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSelection = () => setCheckedIds(new Set());

  const handleBulkDelete = async () => {
    setBulkDeleting(true);
    const ids = Array.from(checkedIds);
    try {
      await Promise.all(ids.map(id => fetch(`/api/atms/${id}`, { method: "DELETE" })));
      toast({ title: `Removed ${ids.length} ATM${ids.length !== 1 ? "s" : ""}` });
      clearSelection(); refetch();
    } catch { toast({ title: "Some deletions failed", variant: "destructive" }); }
    finally { setBulkDeleting(false); setShowBulkDeleteConfirm(false); }
  };

  return (
    <div>
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-5">
        <div className="bg-card border rounded-lg p-4 text-center"><p className="text-2xl font-bold text-emerald-600">{online}</p><p className="text-sm text-muted-foreground">Online</p></div>
        <div className="bg-card border rounded-lg p-4 text-center"><p className="text-2xl font-bold text-amber-600">{lowCash}</p><p className="text-sm text-muted-foreground">Low Cash</p></div>
        <div className="bg-card border rounded-lg p-4 text-center"><p className="text-2xl font-bold text-red-600">{errors}</p><p className="text-sm text-muted-foreground">Errors</p></div>
      </div>

      {/* Action row */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search name, city, terminal ID…" className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem><SelectItem value="online">Online</SelectItem>
            <SelectItem value="low_cash">Low Cash</SelectItem><SelectItem value="error">Error</SelectItem><SelectItem value="offline">Offline</SelectItem>
          </SelectContent>
        </Select>
        <Select value={portalFilter} onValueChange={setPortalFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Portal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Portals</SelectItem><SelectItem value="columbus_data">Columbus Data</SelectItem>
            <SelectItem value="switch_commerce">Switch Commerce</SelectItem><SelectItem value="atm_transact">ATM Transact</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-4 h-4 mr-1" />Import</Button>
        <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1" />Add ATM</Button>
      </div>

      {/* Bulk toolbar */}
      {someChecked && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
          <SquareCheck className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm font-medium">{checkedIds.size} selected</span>
          <div className="flex gap-2 ml-auto">
            <Button size="sm" variant="outline" onClick={() => setShowBulkEdit(true)}><Pencil className="w-3.5 h-3.5 mr-1" />Edit</Button>
            <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => setShowBulkDeleteConfirm(true)}><Trash2 className="w-3.5 h-3.5 mr-1" />Delete</Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={clearSelection}><X className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
      )}

      {/* ATM list */}
      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Loading…</div>
      ) : (
        <div className="border rounded-lg divide-y bg-card">
          {filtered.length === 0 && <div className="py-12 text-center text-muted-foreground">No ATMs found</div>}
          {filtered.length > 0 && (
            <div className="flex items-center gap-4 px-4 py-2 bg-muted/30 rounded-t-lg">
              <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="Select all" />
              <span className="text-xs text-muted-foreground">{allChecked ? "Deselect all" : `Select all ${filtered.length}`}</span>
            </div>
          )}
          {filtered.map(atm => (
            <div key={atm.id} className={`flex items-center gap-4 p-4 hover:bg-muted/30 transition-colors group ${checkedIds.has(atm.id) ? "bg-primary/5" : ""}`}>
              <Checkbox checked={checkedIds.has(atm.id)} onCheckedChange={() => toggleOne(atm.id)} onClick={e => e.stopPropagation()} aria-label={`Select ${atm.locationName ?? atm.name}`} />
              <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setSelected(atm)}>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm truncate">
                    {atm.locationName || atm.name}
                    {atm.portalAtmId && <span className="ml-1.5 font-mono text-xs text-muted-foreground font-normal">({atm.portalAtmId})</span>}
                  </p>
                  {statusBadge(atm.status)}
                </div>
                {addressLine(atm) && <p className="text-xs text-muted-foreground truncate">{addressLine(atm)}</p>}
                <BalanceBar balance={atm.currentBalance} capacity={atm.cashCapacity} status={atm.status} />
              </div>
              <div className="text-right flex-shrink-0 cursor-pointer" onClick={() => setSelected(atm)}>
                <p className="font-semibold text-sm">${atm.currentBalance.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">${atm.cashCapacity.toLocaleString()} cap</p>
                <p className="text-xs text-muted-foreground capitalize">{atm.portalSource?.replace(/_/g, " ")}</p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={e => { e.stopPropagation(); setEditAtm(atm); }}><Pencil className="w-3.5 h-3.5" /></Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10" onClick={e => { e.stopPropagation(); setDeleteTarget(atm); }}><Trash2 className="w-3.5 h-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ATMDetailSheet atm={selected} open={!!selected} onClose={() => setSelected(null)} />
      <EditDialog atm={editAtm} onClose={() => setEditAtm(null)} onSaved={refetch} />
      {showBulkEdit && <BulkEditDialog ids={Array.from(checkedIds)} onClose={() => setShowBulkEdit(false)} onSaved={() => { refetch(); clearSelection(); }} />}

      <Dialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Remove {checkedIds.size} ATM{checkedIds.size !== 1 ? "s" : ""}?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently remove <span className="font-medium text-foreground">{checkedIds.size} ATM{checkedIds.size !== 1 ? "s" : ""}</span> from your fleet. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkDeleting}>{bulkDeleting ? "Removing…" : `Remove ${checkedIds.size} ATM${checkedIds.size !== 1 ? "s" : ""}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Remove ATM?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently remove <span className="font-medium text-foreground">{deleteTarget?.locationName || deleteTarget?.name}</span>. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && deleteAtm.mutate({ id: deleteTarget.id })} disabled={deleteAtm.isPending}>{deleteAtm.isPending ? "Removing…" : "Remove ATM"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportDialog open={showImport} onClose={() => setShowImport(false)} onSuccess={() => { refetch(); setShowImport(false); }} />

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
            <div><Label>Portal</Label>
              <Select value={form.portalSource ?? "columbus_data"} onValueChange={v => setForm(f => ({ ...f, portalSource: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="columbus_data">Columbus Data</SelectItem><SelectItem value="switch_commerce">Switch Commerce</SelectItem><SelectItem value="atm_transact">ATM Transact</SelectItem></SelectContent>
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

// ---------------------------------------------------------------------------
// Tab: Balances
// ---------------------------------------------------------------------------

function BalancesTab({ atms }: { atms: Atm[] }) {
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = [...atms].sort((a, b) =>
    sortDir === "asc" ? a.currentBalance - b.currentBalance : b.currentBalance - a.currentBalance
  );

  const totalCash = atms.reduce((s, a) => s + (a.currentBalance ?? 0), 0);
  const lastSync = atms.reduce((latest, a) => {
    if (!a.lastSynced) return latest;
    const d = new Date(a.lastSynced).getTime();
    return d > latest ? d : latest;
  }, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {lastSync > 0 ? `Balances as of ${new Date(lastSync).toLocaleString()}` : "No sync data yet"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Total Cash Deployed</p>
            <p className="text-lg font-bold">${totalCash.toLocaleString()}</p>
          </div>
        </div>
      </div>

      <div className="border rounded-lg overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Location</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground font-mono text-xs">Terminal ID</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">
                  <button className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto" onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")}>
                    Balance <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="text-right px-4 py-3 font-medium">Capacity</th>
                <th className="text-right px-4 py-3 font-medium">Fill %</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Last Synced</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.map(atm => {
                const fillPct = pct(atm.currentBalance, atm.cashCapacity);
                const barColor = atm.status === "error" ? "bg-red-500" : atm.status === "low_cash" ? "bg-amber-500" : "bg-emerald-500";
                return (
                  <tr key={atm.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium">{atm.locationName || atm.name}</p>
                      {addressLine(atm) && <p className="text-xs text-muted-foreground">{addressLine(atm)}</p>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{atm.portalAtmId ?? "—"}</td>
                    <td className="px-4 py-3">{statusBadge(atm.status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-24 bg-muted rounded-full h-1.5 flex-shrink-0">
                          <div className={`${barColor} h-1.5 rounded-full`} style={{ width: `${Math.min(100, fillPct)}%` }} />
                        </div>
                        <span className="font-semibold tabular-nums w-24 text-right">${atm.currentBalance.toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">${atm.cashCapacity.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className={fillPct < 10 ? "text-red-600 font-semibold" : fillPct < 25 ? "text-amber-600" : "text-muted-foreground"}>
                        {fillPct}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground whitespace-nowrap">
                      {atm.lastSynced ? new Date(atm.lastSynced).toLocaleString() : "Never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t bg-muted/30">
              <tr>
                <td className="px-4 py-3 font-medium" colSpan={3}>{atms.length} ATMs</td>
                <td className="px-4 py-3 text-right font-bold tabular-nums">${totalCash.toLocaleString()}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Transactions
// ---------------------------------------------------------------------------

function TransactionsTab() {
  const { toast } = useToast();
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [terminalFilter, setTerminalFilter] = useState("");
  const [columbusPortalId, setColumbusPortalId] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTransactions = useCallback(async () => {
    try {
      const url = terminalFilter
        ? `/api/atms/transactions?limit=500&terminalId=${encodeURIComponent(terminalFilter)}`
        : `/api/atms/transactions?limit=500`;
      const res = await fetch(url);
      if (res.ok) setTransactions(await res.json());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [terminalFilter]);

  useEffect(() => {
    fetch("/api/portals")
      .then(r => r.json())
      .then((portals: { id: number; name: string }[]) => {
        const p = portals.find(p => p.name === "columbus_data");
        if (p) setColumbusPortalId(p.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchTransactions(); }, [fetchTransactions]);

  const handleSyncTransactions = async () => {
    if (!columbusPortalId) return;
    setSyncing(true);
    try {
      const res = await fetch(`/api/portals/${columbusPortalId}/sync-transactions`, { method: "POST" });
      const data = await res.json();
      if ((data as any).background) {
        toast({ title: "Syncing transactions…", description: "Running in background, may take a few minutes." });
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          await fetchTransactions();
          if (transactions.length > 0) { clearInterval(pollRef.current!); pollRef.current = null; setSyncing(false); }
        }, 5_000);
      } else {
        await fetchTransactions();
        setSyncing(false);
        toast({ title: "Transactions synced" });
      }
    } catch { setSyncing(false); toast({ title: "Sync failed", variant: "destructive" }); }
  };

  const uniqueTerminals = Array.from(new Set(transactions.map(t => t.terminalId).filter(Boolean))) as string[];

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Select value={terminalFilter || "all"} onValueChange={v => setTerminalFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-52"><SelectValue placeholder="All terminals" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Terminals</SelectItem>
            {uniqueTerminals.map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={fetchTransactions}><RefreshCw className="w-4 h-4 mr-1" />Refresh</Button>
        {columbusPortalId && (
          <Button size="sm" disabled={syncing} onClick={handleSyncTransactions}>
            <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync Transactions"}
          </Button>
        )}
        <span className="text-sm text-muted-foreground ml-auto">{transactions.length} records</span>
      </div>

      {loading ? (
        <div className="text-center text-muted-foreground py-16">Loading…</div>
      ) : transactions.length === 0 ? (
        <div className="border rounded-lg py-16 text-center text-muted-foreground bg-card">
          <Receipt className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No transactions yet</p>
          <p className="text-xs mt-1 opacity-60">Click "Sync Transactions" to pull data from the portal</p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-card">
          <div className="overflow-x-auto max-h-[65vh]">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Date / Time</th>
                  <th className="text-left px-3 py-2 font-medium">Terminal</th>
                  <th className="text-left px-3 py-2 font-medium">Type</th>
                  <th className="text-left px-3 py-2 font-medium">Card</th>
                  <th className="text-right px-3 py-2 font-medium">Amt Req</th>
                  <th className="text-right px-3 py-2 font-medium">Fee Req</th>
                  <th className="text-right px-3 py-2 font-medium">Dispensed</th>
                  <th className="text-right px-3 py-2 font-medium">Fee</th>
                  <th className="text-left px-3 py-2 font-medium">Seq #</th>
                  <th className="text-left px-3 py-2 font-medium">Response</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {transactions.map(tx => (
                  <tr key={tx.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-mono whitespace-nowrap text-muted-foreground">{new Date(tx.transactedAt).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{tx.terminalId ?? "—"}</td>
                    <td className="px-3 py-2 font-medium">{tx.transactionType ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{tx.cardNumber ? `••${tx.cardNumber.trim().slice(-4)}` : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtDollar(tx.amountRequested ?? tx.amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtDollar(tx.feeRequested)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtDollar(tx.amountDispensed ?? tx.amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtDollar(tx.feeAmount)}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{tx.termSeq ?? "—"}</td>
                    <td className="px-3 py-2">{responseBadge(tx.response)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ATMFleet() {
  const { data: atms = [], refetch, isLoading } = useListAtms({});

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold">ATM Fleet</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{atms.length} machines across your network</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="w-4 h-4 mr-1" />Refresh</Button>
      </div>

      <Tabs defaultValue="info">
        <TabsList className="mb-5">
          <TabsTrigger value="info" className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" />Info
          </TabsTrigger>
          <TabsTrigger value="balances" className="flex items-center gap-1.5">
            <DollarSign className="w-3.5 h-3.5" />Balances
          </TabsTrigger>
          <TabsTrigger value="transactions" className="flex items-center gap-1.5">
            <Receipt className="w-3.5 h-3.5" />Transactions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="info" className="mt-0">
          <InfoTab atms={atms} isLoading={isLoading} refetch={refetch} />
        </TabsContent>

        <TabsContent value="balances" className="mt-0">
          <BalancesTab atms={atms} />
        </TabsContent>

        <TabsContent value="transactions" className="mt-0">
          <TransactionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
