import { useState } from "react";
import { useListPortals, useCreatePortal, useUpdatePortal, useSyncPortal, useGetPortalSyncHistory } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Plus, CheckCircle, XCircle, Clock, Server } from "lucide-react";
import type { CreatePortalBody } from "@workspace/api-client-react";

function syncStatusBadge(s: string) {
  if (s === "success") return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15"><CheckCircle className="w-3 h-3 mr-1" />Success</Badge>;
  if (s === "failed") return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
  return <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />Never synced</Badge>;
}

function portalLabel(name: string) {
  if (name === "columbus_data") return "Columbus Data";
  if (name === "switch_commerce") return "Switch Commerce";
  if (name === "atm_transact") return "ATM Transact";
  return name;
}

const emptyPortal: CreatePortalBody = { name: "columbus_data", username: "", passwordEncrypted: "" };

export default function PortalsPage() {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<CreatePortalBody>(emptyPortal);
  const [syncingId, setSyncingId] = useState<number | null>(null);

  const { data: portals = [], refetch } = useListPortals();
  const createPortal = useCreatePortal({ mutation: { onSuccess: () => { refetch(); setShowAdd(false); setForm(emptyPortal); toast({ title: "Portal added" }); } } });
  const updatePortal = useUpdatePortal({ mutation: { onSuccess: () => { refetch(); setEditingId(null); toast({ title: "Portal updated" }); } } });
  const syncPortal = useSyncPortal({
    mutation: {
      onMutate: (vars) => setSyncingId(vars.portalId),
      onSuccess: (data) => {
        refetch();
        setSyncingId(null);
        toast({ title: `Sync complete: ${data.updatedAtms} ATMs updated` });
      },
      onError: () => { setSyncingId(null); toast({ title: "Sync failed", variant: "destructive" }); }
    }
  });
  const { data: history = [] } = useGetPortalSyncHistory();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Portal Sync</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage credentials and sync ATM data from your portals</p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1" />Add Portal</Button>
      </div>

      {/* Portal cards */}
      <div className="grid gap-4 mb-8">
        {portals.length === 0 && (
          <div className="border rounded-lg py-16 text-center text-muted-foreground bg-card">
            <Server className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No portals configured yet</p>
          </div>
        )}
        {portals.map(portal => (
          <div key={portal.id} className="bg-card border rounded-lg p-5">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Server className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="font-semibold">{portalLabel(portal.name)}</h3>
                  {syncStatusBadge(portal.lastSyncStatus ?? "never")}
                  <Badge variant={portal.isActive ? "default" : "secondary"}>{portal.isActive ? "Active" : "Inactive"}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">Username: {portal.username}</p>
                {portal.lastSyncAt && (
                  <p className="text-xs text-muted-foreground mt-0.5">Last synced: {new Date(portal.lastSyncAt).toLocaleString()}</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setForm({ name: portal.name, username: portal.username, passwordEncrypted: "" }); setEditingId(portal.id); }}>Edit</Button>
                <Button size="sm" disabled={syncingId === portal.id} onClick={() => syncPortal.mutate({ portalId: portal.id })}>
                  <RefreshCw className={`w-4 h-4 mr-1 ${syncingId === portal.id ? "animate-spin" : ""}`} />
                  {syncingId === portal.id ? "Syncing..." : "Sync Now"}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Sync history */}
      {history.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Sync History</h2>
          <div className="border rounded-lg divide-y bg-card">
            {history.slice(0, 20).map(h => (
              <div key={h.id} className="flex items-center gap-4 p-3 text-sm">
                <div className="flex-1">
                  <span className="font-medium">{portalLabel(h.portalName)}</span>
                  <span className="text-muted-foreground ml-2">{new Date(h.startedAt).toLocaleString()}</span>
                </div>
                <span className="text-muted-foreground">{h.atmsUpdated ?? 0} ATMs updated</span>
                {syncStatusBadge(h.status)}
                {h.errorMessage && <span className="text-xs text-red-500 truncate max-w-48">{h.errorMessage}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Portal Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Portal</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <Label>Portal</Label>
              <Select value={form.name} onValueChange={v => setForm(f => ({ ...f, name: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="columbus_data">Columbus Data</SelectItem>
                  <SelectItem value="switch_commerce">Switch Commerce</SelectItem>
                  <SelectItem value="atm_transact">ATM Transact</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Username / Email</Label><Input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="user@example.com" /></div>
            <div><Label>Password</Label><Input type="password" value={form.passwordEncrypted} onChange={e => setForm(f => ({ ...f, passwordEncrypted: e.target.value }))} placeholder="Password" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={() => createPortal.mutate({ data: form })} disabled={!form.username || !form.passwordEncrypted}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Portal Dialog */}
      <Dialog open={editingId !== null} onOpenChange={() => setEditingId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Edit Portal Credentials</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div><Label>Username / Email</Label><Input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} /></div>
            <div><Label>New Password</Label><Input type="password" value={form.passwordEncrypted} onChange={e => setForm(f => ({ ...f, passwordEncrypted: e.target.value }))} placeholder="Leave blank to keep current" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
            <Button onClick={() => editingId !== null && updatePortal.mutate({ portalId: editingId, data: { username: form.username, passwordEncrypted: form.passwordEncrypted || undefined } })}>Update</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
