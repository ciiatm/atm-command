import { useState } from "react";
import { useListAlerts, useResolveAlert, useListAlertRules, useCreateAlertRule, useDeleteAlertRule } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle, Bell, Plus, Trash2, Clock } from "lucide-react";
import type { CreateAlertRuleBody } from "@workspace/api-client-react";

function severityBadge(s: string) {
  if (s === "critical") return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15">Critical</Badge>;
  if (s === "warning") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 hover:bg-amber-500/15">Warning</Badge>;
  return <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 hover:bg-blue-500/15">Info</Badge>;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const emptyRule: CreateAlertRuleBody = { name: "", type: "low_cash", threshold: 2000, severity: "warning" };

export default function AlertsPage() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("active");
  const [showRules, setShowRules] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);
  const [ruleForm, setRuleForm] = useState<CreateAlertRuleBody>(emptyRule);

  const { data: alerts = [], refetch } = useListAlerts({
    resolved: filter === "resolved" ? "true" : filter === "active" ? "false" : undefined,
  });
  const resolveAlert = useResolveAlert({ mutation: { onSuccess: () => { refetch(); toast({ title: "Alert resolved" }); } } });
  const { data: rules = [], refetch: refetchRules } = useListAlertRules();
  const createRule = useCreateAlertRule({ mutation: { onSuccess: () => { refetchRules(); setShowAddRule(false); setRuleForm(emptyRule); toast({ title: "Alert rule created" }); } } });
  const deleteRule = useDeleteAlertRule({ mutation: { onSuccess: () => { refetchRules(); toast({ title: "Rule deleted" }); } } });

  const active = alerts.filter(a => !a.resolved);
  const critical = active.filter(a => a.severity === "critical");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Alerts</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {critical.length > 0 ? <span className="text-red-600 font-medium">{critical.length} critical alert{critical.length !== 1 ? "s" : ""} require attention</span> : "All clear — no critical alerts"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowRules(true)}><Bell className="w-4 h-4 mr-1" />Alert Rules</Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-red-600">{active.filter(a => a.severity === "critical").length}</p>
          <p className="text-sm text-muted-foreground">Critical</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">{active.filter(a => a.severity === "warning").length}</p>
          <p className="text-sm text-muted-foreground">Warning</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-blue-600">{active.filter(a => a.severity === "info").length}</p>
          <p className="text-sm text-muted-foreground">Info</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-3 mb-4">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Alerts list */}
      <div className="border rounded-lg divide-y bg-card">
        {alerts.length === 0 && <div className="py-12 text-center text-muted-foreground">No alerts found</div>}
        {alerts.map(alert => (
          <div key={alert.id} className={`flex items-start gap-4 p-4 ${alert.severity === "critical" && !alert.resolved ? "bg-red-500/5" : ""}`}>
            <div className="mt-0.5">
              {alert.resolved
                ? <CheckCircle className="w-5 h-5 text-emerald-500" />
                : alert.severity === "critical"
                  ? <AlertTriangle className="w-5 h-5 text-red-500" />
                  : <AlertTriangle className="w-5 h-5 text-amber-500" />
              }
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                {severityBadge(alert.severity)}
                <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(alert.createdAt)}</span>
              </div>
              <p className="text-sm font-medium">{alert.message}</p>
              {alert.resolved && alert.resolvedAt && (
                <p className="text-xs text-muted-foreground mt-0.5">Resolved {timeAgo(alert.resolvedAt)}</p>
              )}
            </div>
            {!alert.resolved && (
              <Button variant="outline" size="sm" onClick={() => resolveAlert.mutate({ alertId: alert.id })}>
                <CheckCircle className="w-4 h-4 mr-1" />Resolve
              </Button>
            )}
          </div>
        ))}
      </div>

      {/* Alert Rules Dialog */}
      <Dialog open={showRules} onOpenChange={setShowRules}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center justify-between pr-8">
              <DialogTitle>Alert Rules</DialogTitle>
              <Button size="sm" onClick={() => setShowAddRule(true)}><Plus className="w-4 h-4 mr-1" />New Rule</Button>
            </div>
          </DialogHeader>
          <div className="divide-y border rounded-lg">
            {rules.length === 0 && <div className="py-8 text-center text-muted-foreground">No rules configured</div>}
            {rules.map(rule => (
              <div key={rule.id} className="flex items-center gap-3 p-3">
                <div className="flex-1">
                  <p className="font-medium text-sm">{rule.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{rule.type.replace(/_/g, " ")}{rule.threshold ? ` · $${rule.threshold.toLocaleString()}` : ""}</p>
                </div>
                {severityBadge(rule.severity)}
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-600" onClick={() => deleteRule.mutate({ ruleId: rule.id })}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Rule Dialog */}
      <Dialog open={showAddRule} onOpenChange={setShowAddRule}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>New Alert Rule</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div><Label>Rule Name</Label><Input value={ruleForm.name} onChange={e => setRuleForm(f => ({ ...f, name: e.target.value }))} placeholder="Low Cash Warning" /></div>
            <div>
              <Label>Trigger Type</Label>
              <Select value={ruleForm.type} onValueChange={v => setRuleForm(f => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low_cash">Low Cash</SelectItem>
                  <SelectItem value="offline">Offline</SelectItem>
                  <SelectItem value="machine_error">Machine Error</SelectItem>
                  <SelectItem value="out_of_cash">Out of Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {ruleForm.type === "low_cash" && (
              <div><Label>Threshold ($)</Label><Input type="number" value={ruleForm.threshold ?? 2000} onChange={e => setRuleForm(f => ({ ...f, threshold: +e.target.value }))} /></div>
            )}
            <div>
              <Label>Severity</Label>
              <Select value={ruleForm.severity} onValueChange={v => setRuleForm(f => ({ ...f, severity: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddRule(false)}>Cancel</Button>
            <Button onClick={() => createRule.mutate({ data: ruleForm })} disabled={!ruleForm.name}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
