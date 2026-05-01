import { useState } from "react";
import { useListRoutes, usePlanRoute, useGetRoute, useUpdateRoute } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { Route as RouteIcon, Plus, MapPin, Navigation, CheckCircle, Clock, Truck } from "lucide-react";
import type { PlanRouteBody } from "@workspace/api-client-react";

function statusBadge(s: string) {
  if (s === "completed") return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>;
  if (s === "in_progress") return <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 hover:bg-blue-500/15"><Truck className="w-3 h-3 mr-1" />In Progress</Badge>;
  return <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />Planned</Badge>;
}

export default function RoutesPage() {
  const { toast } = useToast();
  const [showPlan, setShowPlan] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<number | null>(null);
  const [planForm, setPlanForm] = useState<PlanRouteBody>({ name: "", atmIds: [], startAddress: "", date: new Date().toISOString().slice(0, 10) });
  const [atmIdsInput, setAtmIdsInput] = useState("");

  const { data: routes = [], refetch } = useListRoutes();
  const planRoute = usePlanRoute({
    mutation: {
      onSuccess: () => {
        refetch();
        setShowPlan(false);
        setPlanForm({ name: "", atmIds: [], startAddress: "", date: new Date().toISOString().slice(0, 10) });
        setAtmIdsInput("");
        toast({ title: "Route planned successfully" });
      }
    }
  });
  const { data: routeDetail } = useGetRoute(selectedRouteId ?? 0, { query: { enabled: selectedRouteId !== null } });
  const updateRoute = useUpdateRoute({ mutation: { onSuccess: () => { refetch(); toast({ title: "Route updated" }); } } });

  const active = routes.filter(r => r.status === "planned" || r.status === "in_progress");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Route Planning</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Optimized multi-stop fill routes using nearest-neighbor routing</p>
        </div>
        <Button size="sm" onClick={() => setShowPlan(true)}><Plus className="w-4 h-4 mr-1" />Plan Route</Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-blue-600">{active.length}</p>
          <p className="text-sm text-muted-foreground">Active Routes</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">{routes.filter(r => r.status === "completed").length}</p>
          <p className="text-sm text-muted-foreground">Completed</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">{routes.reduce((s, r) => s + (r.totalStops ?? 0), 0)}</p>
          <p className="text-sm text-muted-foreground">Total ATM Stops</p>
        </div>
      </div>

      {/* Routes list */}
      <div className="border rounded-lg divide-y bg-card">
        {routes.length === 0 && (
          <div className="py-16 text-center text-muted-foreground">
            <RouteIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No routes planned yet</p>
          </div>
        )}
        {routes.map(route => (
          <div key={route.id} className="flex items-center gap-4 p-4 hover:bg-muted/30 cursor-pointer transition-colors" onClick={() => setSelectedRouteId(route.id)}>
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Truck className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <p className="font-medium text-sm">{route.name}</p>
                {statusBadge(route.status)}
              </div>
              <p className="text-xs text-muted-foreground">
                {new Date(route.date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
                {" · "}{route.totalStops ?? 0} stops
                {route.estimatedMiles ? ` · ~${route.estimatedMiles} mi` : ""}
              </p>
            </div>
            <div className="text-right">
              {route.cashToLoad && <p className="font-semibold text-sm">${route.cashToLoad.toLocaleString()}</p>}
              {route.cashToLoad && <p className="text-xs text-muted-foreground">to load</p>}
            </div>
          </div>
        ))}
      </div>

      {/* Plan Route Dialog */}
      <Dialog open={showPlan} onOpenChange={setShowPlan}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Plan New Route</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div><Label>Route Name</Label><Input value={planForm.name} onChange={e => setPlanForm(f => ({ ...f, name: e.target.value }))} placeholder="East Columbus Fill Run" /></div>
            <div><Label>Date</Label><Input type="date" value={planForm.date ?? ""} onChange={e => setPlanForm(f => ({ ...f, date: e.target.value }))} /></div>
            <div><Label>Start Address</Label><Input value={planForm.startAddress ?? ""} onChange={e => setPlanForm(f => ({ ...f, startAddress: e.target.value }))} placeholder="Your warehouse or home address" /></div>
            <div>
              <Label>ATM IDs to Visit</Label>
              <Input
                value={atmIdsInput}
                onChange={e => setAtmIdsInput(e.target.value)}
                placeholder="e.g. 1, 2, 5, 7, 12"
              />
              <p className="text-xs text-muted-foreground mt-1">Enter ATM IDs separated by commas. The route will be optimized automatically.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPlan(false)}>Cancel</Button>
            <Button
              onClick={() => {
                const ids = atmIdsInput.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                planRoute.mutate({ data: { ...planForm, atmIds: ids } });
              }}
              disabled={!planForm.name || !atmIdsInput.trim() || planRoute.isPending}
            >
              <Navigation className="w-4 h-4 mr-1" />
              {planRoute.isPending ? "Optimizing..." : "Plan & Optimize"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Route Detail Sheet */}
      <Sheet open={selectedRouteId !== null} onOpenChange={() => setSelectedRouteId(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{routeDetail?.name}</SheetTitle>
            {routeDetail && (
              <p className="text-sm text-muted-foreground">
                {new Date(routeDetail.date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                {routeDetail.estimatedMiles ? ` · ~${routeDetail.estimatedMiles} mi` : ""}
              </p>
            )}
          </SheetHeader>
          {routeDetail && (
            <div className="mt-6 space-y-4">
              <div className="flex gap-3">
                {statusBadge(routeDetail.status)}
                {routeDetail.cashToLoad && <Badge variant="outline">${routeDetail.cashToLoad.toLocaleString()} to load</Badge>}
              </div>

              {/* Status actions */}
              {routeDetail.status === "planned" && (
                <Button className="w-full" onClick={() => updateRoute.mutate({ routeId: routeDetail.id, data: { status: "in_progress" } })}>
                  <Truck className="w-4 h-4 mr-2" />Start Route
                </Button>
              )}
              {routeDetail.status === "in_progress" && (
                <Button className="w-full" onClick={() => updateRoute.mutate({ routeId: routeDetail.id, data: { status: "completed" } })}>
                  <CheckCircle className="w-4 h-4 mr-2" />Complete Route
                </Button>
              )}

              {/* Stops */}
              <div>
                <h3 className="font-semibold mb-3">Optimized Stop Order</h3>
                {routeDetail.startAddress && (
                  <div className="flex items-center gap-3 mb-2 text-sm text-muted-foreground">
                    <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-xs text-primary-foreground font-bold">S</div>
                    <span>Start: {routeDetail.startAddress}</span>
                  </div>
                )}
                <div className="space-y-2">
                  {(routeDetail.stops ?? []).map((stop, i) => (
                    <div key={stop.id} className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold flex-shrink-0">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{stop.atmName}</p>
                        <p className="text-xs text-muted-foreground">{stop.atmAddress}</p>
                      </div>
                      {stop.fillAmount && <p className="text-sm font-semibold">${stop.fillAmount.toLocaleString()}</p>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
