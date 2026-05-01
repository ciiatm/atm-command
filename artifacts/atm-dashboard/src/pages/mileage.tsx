import { useState } from "react";
import { useListMileageLogs, useCreateMileageLog, useGetMileageSummary } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Car, Plus, DollarSign, MapPin, Fuel } from "lucide-react";
import type { CreateMileageLogBody } from "@workspace/api-client-react";

const today = new Date().toISOString().slice(0, 10);
const emptyLog: CreateMileageLogBody = { date: today, startLocation: "", endLocation: "", miles: 0, purpose: "ATM Fill Run", notes: undefined };

const IRS_RATE = 0.67;

export default function MileagePage() {
  const { toast } = useToast();
  const [year, setYear] = useState(new Date().getFullYear().toString());
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<CreateMileageLogBody>(emptyLog);

  const { data: logs = [], refetch } = useListMileageLogs({ year: parseInt(year) });
  const { data: summary } = useGetMileageSummary({ year: parseInt(year) });
  const createLog = useCreateMileageLog({ mutation: { onSuccess: () => { refetch(); setShowAdd(false); setForm(emptyLog); toast({ title: "Mileage logged" }); } } });

  const totalMiles = logs.reduce((s, l) => s + l.miles, 0);
  const totalDeduction = totalMiles * IRS_RATE;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Mileage Log</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Track business driving for IRS deductions at ${IRS_RATE}/mile ({new Date().getFullYear()} rate)</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[2026, 2025, 2024, 2023].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1" />Log Trip</Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2"><Car className="w-4 h-4 text-primary" /><p className="text-xs text-muted-foreground uppercase tracking-wide">Total Miles</p></div>
          <p className="text-2xl font-bold">{totalMiles.toFixed(1)}</p>
          <p className="text-xs text-muted-foreground">{logs.length} trips</p>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2"><DollarSign className="w-4 h-4 text-emerald-600" /><p className="text-xs text-muted-foreground uppercase tracking-wide">IRS Deduction</p></div>
          <p className="text-2xl font-bold text-emerald-600">${totalDeduction.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">at ${IRS_RATE}/mi</p>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2"><Fuel className="w-4 h-4 text-amber-600" /><p className="text-xs text-muted-foreground uppercase tracking-wide">Avg per Trip</p></div>
          <p className="text-2xl font-bold">{logs.length > 0 ? (totalMiles / logs.length).toFixed(1) : "0"}</p>
          <p className="text-xs text-muted-foreground">miles / trip</p>
        </div>
      </div>

      {/* Monthly summary from API */}
      {summary && summary.byMonth && summary.byMonth.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">Monthly Breakdown</h2>
          <div className="bg-card border rounded-lg divide-y">
            {summary.byMonth.map((m: { month: string; miles: number; trips: number }) => (
              <div key={m.month} className="flex items-center gap-4 p-3 text-sm">
                <span className="font-medium w-24">{new Date(m.month + "-01").toLocaleString("default", { month: "long" })}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className="bg-primary h-2 rounded-full" style={{ width: `${Math.min(100, (m.miles / (totalMiles || 1)) * 100)}%` }} />
                </div>
                <span className="text-muted-foreground w-20 text-right">{m.miles.toFixed(1)} mi</span>
                <span className="text-emerald-600 font-medium w-24 text-right">${(m.miles * IRS_RATE).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trip log */}
      <h2 className="text-lg font-semibold mb-3">Trip Log</h2>
      <div className="border rounded-lg divide-y bg-card">
        {logs.length === 0 && (
          <div className="py-16 text-center text-muted-foreground">
            <Car className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No trips logged for {year}</p>
          </div>
        )}
        {logs.map(log => (
          <div key={log.id} className="flex items-start gap-4 p-4">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Car className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{log.purpose}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                <MapPin className="w-3 h-3" />
                <span className="truncate">{log.startLocation} → {log.endLocation}</span>
              </div>
              {log.notes && <p className="text-xs text-muted-foreground mt-0.5">{log.notes}</p>}
              <p className="text-xs text-muted-foreground">{new Date(log.date).toLocaleDateString()}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="font-bold text-sm">{log.miles} mi</p>
              <p className="text-xs text-emerald-600">${(log.miles * IRS_RATE).toFixed(2)}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Add Trip Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Log Trip</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div><Label>Date</Label><Input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></div>
            <div><Label>Starting From</Label><Input value={form.startLocation} onChange={e => setForm(f => ({ ...f, startLocation: e.target.value }))} placeholder="Home / Warehouse address" /></div>
            <div><Label>Ending At</Label><Input value={form.endLocation} onChange={e => setForm(f => ({ ...f, endLocation: e.target.value }))} placeholder="Multiple ATM Locations" /></div>
            <div><Label>Miles Driven</Label><Input type="number" step="0.1" value={form.miles || ""} onChange={e => setForm(f => ({ ...f, miles: +e.target.value }))} /></div>
            <div>
              <Label>Purpose</Label>
              <Select value={form.purpose ?? "ATM Fill Run"} onValueChange={v => setForm(f => ({ ...f, purpose: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ATM Fill Run">ATM Fill Run</SelectItem>
                  <SelectItem value="Bank Trip + Fill">Bank Trip + Fill</SelectItem>
                  <SelectItem value="ATM Maintenance">ATM Maintenance</SelectItem>
                  <SelectItem value="Site Visit">Site Visit</SelectItem>
                  <SelectItem value="Other Business">Other Business</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Notes (optional)</Label><Input value={form.notes ?? ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Number of stops, notes..." /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={() => createLog.mutate({ data: form })} disabled={!form.startLocation || !form.miles}>Log Trip</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
