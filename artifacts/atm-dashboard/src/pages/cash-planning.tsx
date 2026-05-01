import { useState, useEffect, useRef } from "react";
import { useListFills, useCreateFill, useUpdateFill, useCalculateFills } from "@workspace/api-client-react";
import type { FillRecommendation } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Banknote, CalendarCheck, CheckCircle, Clock, AlertTriangle, Calculator, Plus } from "lucide-react";
import type { CreateFillBody } from "@workspace/api-client-react";

function statusBadge(s: string) {
  if (s === "completed") return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>;
  if (s === "pending") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 hover:bg-amber-500/15"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
  return <Badge variant="secondary">{s}</Badge>;
}

export default function CashPlanningPage() {
  const { toast } = useToast();
  const [days, setDays] = useState("14");
  const [showAdd, setShowAdd] = useState(false);
  const [recommendations, setRecommendations] = useState<FillRecommendation[]>([]);
  const [loadingRec, setLoadingRec] = useState(false);
  const [addForm, setAddForm] = useState<CreateFillBody>({ atmId: 0, scheduledDate: new Date().toISOString().slice(0, 10), cashAmount: 10000, daysToFill: 14 });

  const calcFills = useCalculateFills({ mutation: { onSuccess: (data) => { setRecommendations(data); setLoadingRec(false); }, onError: () => setLoadingRec(false) } });
  const { data: fills = [], refetch } = useListFills({ status: undefined });
  const createFill = useCreateFill({ mutation: { onSuccess: () => { refetch(); setShowAdd(false); toast({ title: "Fill scheduled" }); } } });
  const updateFill = useUpdateFill({ mutation: { onSuccess: () => { refetch(); toast({ title: "Fill updated" }); } } });

  useEffect(() => {
    setLoadingRec(true);
    calcFills.mutate({ data: { atmIds: [], daysToFill: Number(days), bufferPercent: 10 } });
  }, [days]);

  const pending = fills.filter(f => f.status === "pending");
  const totalCashNeeded = recommendations.reduce((s, r) => s + r.recommendedLoad, 0);
  const urgent = recommendations.filter(r => {
    const daysLeft = r.avgDailyDispensed > 0 ? r.currentBalance / r.avgDailyDispensed : 99;
    return daysLeft <= 2;
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Cash Planning</h1>
          <p className="text-muted-foreground text-sm mt-0.5">AI-assisted fill recommendations based on transaction velocity</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7-day fills</SelectItem>
              <SelectItem value="14">14-day fills</SelectItem>
              <SelectItem value="21">21-day fills</SelectItem>
              <SelectItem value="30">30-day fills</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1" />Manual Fill</Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">Needs Fill Now</p>
          <p className="text-2xl font-bold text-red-600">{urgent.length}</p>
          <p className="text-xs text-muted-foreground">≤2 days of cash left</p>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">Total Cash Needed</p>
          <p className="text-2xl font-bold">${totalCashNeeded.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">Across {recommendations.length} ATMs</p>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">Pending Orders</p>
          <p className="text-2xl font-bold text-amber-600">{pending.length}</p>
          <p className="text-xs text-muted-foreground">Scheduled fills</p>
        </div>
      </div>

      {/* Recommendations */}
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><Calculator className="w-5 h-5" />Fill Recommendations ({days} days)</h2>
      {loadingRec ? (
        <div className="text-center text-muted-foreground py-10">Calculating recommendations...</div>
      ) : (
        <div className="border rounded-lg divide-y bg-card mb-8">
          {recommendations.length === 0 && <div className="py-12 text-center text-muted-foreground">All ATMs have sufficient cash for {days} days</div>}
          {recommendations.map(rec => {
            const daysLeft = rec.avgDailyDispensed > 0 ? Math.floor(rec.currentBalance / rec.avgDailyDispensed) : 99;
            const isUrgent = daysLeft <= 2;
            return (
              <div key={rec.atmId} className={`flex items-center gap-4 p-4 ${isUrgent ? "bg-red-500/5" : ""}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm">{rec.atmName}</p>
                    {isUrgent && <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15 text-xs"><AlertTriangle className="w-3 h-3 mr-1" />Urgent</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">Balance: ${rec.currentBalance.toLocaleString()} · Avg: ${rec.avgDailyDispensed.toLocaleString()}/day</p>
                  <p className="text-xs text-muted-foreground">~{daysLeft} days of cash remaining</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-sm">${rec.recommendedLoad.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">recommended fill</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => createFill.mutate({ data: { atmId: rec.atmId, scheduledDate: new Date().toISOString().slice(0, 10), cashAmount: rec.recommendedLoad, daysToFill: Number(days) } })}>
                  <CalendarCheck className="w-4 h-4 mr-1" />Schedule
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {/* Fill orders */}
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><Banknote className="w-5 h-5" />All Fill Orders</h2>
      <div className="border rounded-lg divide-y bg-card">
        {fills.length === 0 && <div className="py-12 text-center text-muted-foreground">No fill orders yet</div>}
        {fills.map(fill => (
          <div key={fill.id} className="flex items-center gap-4 p-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{fill.atmName ?? `ATM #${fill.atmId}`}</p>
              <p className="text-xs text-muted-foreground">Scheduled: {new Date(fill.scheduledDate).toLocaleDateString()} · {fill.daysToFill}-day fill</p>
              {fill.notes && <p className="text-xs text-muted-foreground">{fill.notes}</p>}
            </div>
            <div className="text-right">
              <p className="font-bold text-sm">${fill.cashAmount.toLocaleString()}</p>
            </div>
            {statusBadge(fill.status)}
            {fill.status === "pending" && (
              <Button size="sm" onClick={() => updateFill.mutate({ fillId: fill.id, data: { status: "completed" } })}>
                <CheckCircle className="w-4 h-4 mr-1" />Mark Done
              </Button>
            )}
          </div>
        ))}
      </div>

      {/* Manual Fill Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Schedule Manual Fill</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div><Label>ATM ID</Label><Input type="number" value={addForm.atmId || ""} onChange={e => setAddForm(f => ({ ...f, atmId: +e.target.value }))} placeholder="ATM ID number" /></div>
            <div><Label>Date</Label><Input type="date" value={addForm.scheduledDate} onChange={e => setAddForm(f => ({ ...f, scheduledDate: e.target.value }))} /></div>
            <div><Label>Cash Amount ($)</Label><Input type="number" value={addForm.cashAmount} onChange={e => setAddForm(f => ({ ...f, cashAmount: +e.target.value }))} /></div>
            <div><Label>Days to Cover</Label><Input type="number" value={addForm.daysToFill ?? 14} onChange={e => setAddForm(f => ({ ...f, daysToFill: +e.target.value }))} /></div>
            <div><Label>Notes (optional)</Label><Input value={addForm.notes ?? ""} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={() => createFill.mutate({ data: addForm })} disabled={!addForm.atmId}>Schedule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
