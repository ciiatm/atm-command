import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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

interface Portal {
  id: number;
  name: string;
}

function fmt(val: number | null | undefined): string {
  if (val == null) return "-";
  return `$${val.toFixed(2)}`;
}

function responseBadge(response: string | null) {
  if (!response) return <span className="text-muted-foreground">-</span>;
  const lower = response.toLowerCase();
  if (lower.includes("approv")) return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15">{response}</Badge>;
  if (lower.includes("declin") || lower.includes("error") || lower.includes("fail")) return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15">{response}</Badge>;
  return <Badge variant="secondary">{response}</Badge>;
}

export default function TransactionsPage() {
  const { toast } = useToast();
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [terminalFilter, setTerminalFilter] = useState("");
  const [columbusPortalId, setColumbusPortalId] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTransactions = async () => {
    try {
      const url = terminalFilter
        ? `/api/atms/transactions?limit=500&terminalId=${encodeURIComponent(terminalFilter)}`
        : `/api/atms/transactions?limit=500`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setTransactions(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  // Fetch Columbus Data portal ID
  useEffect(() => {
    fetch("/api/portals")
      .then(r => r.json())
      .then((portals: Portal[]) => {
        const cd = portals.find(p => p.name === "columbus_data");
        if (cd) setColumbusPortalId(cd.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchTransactions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalFilter]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = (startedAt: Date) => {
    stopPolling();
    const interval = setInterval(async () => {
      // Check sync history for a new entry since we started
      try {
        const histRes = await fetch("/api/portals/sync-history");
        if (histRes.ok) {
          const history = await histRes.json();
          const recent = history.find(
            (h: any) =>
              h.portalId === columbusPortalId &&
              h.syncedAt &&
              new Date(h.syncedAt) > startedAt
          );
          if (recent) {
            stopPolling();
            setSyncing(false);
            if (recent.success) {
              toast({ title: "Transaction sync complete" });
              fetchTransactions();
            } else {
              toast({ title: "Transaction sync failed", description: recent.message ?? "", variant: "destructive" });
            }
          }
        }
      } catch {
        // ignore
      }
    }, 5_000);
    pollRef.current = interval;
  };

  const handleSync = async () => {
    if (!columbusPortalId) {
      toast({ title: "No Columbus Data portal configured", variant: "destructive" });
      return;
    }
    setSyncing(true);
    const startedAt = new Date();
    try {
      const res = await fetch(`/api/portals/${columbusPortalId}/sync-transactions`, {
        method: "POST",
      });
      if (!res.ok) {
        setSyncing(false);
        toast({ title: "Failed to start transaction sync", variant: "destructive" });
        return;
      }
      toast({ title: "Syncing transactions…", description: "Running in background, this may take a minute." });
      startPolling(startedAt);
    } catch {
      setSyncing(false);
      toast({ title: "Failed to start transaction sync", variant: "destructive" });
    }
  };

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), []);

  const filtered = terminalFilter
    ? transactions.filter(t => t.terminalId?.toLowerCase().includes(terminalFilter.toLowerCase()))
    : transactions;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Transactions</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Per-terminal transaction history from Columbus Data
          </p>
        </div>
        <Button size="sm" disabled={syncing} onClick={handleSync}>
          <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Sync Transactions"}
        </Button>
      </div>

      <div className="mb-4">
        <Input
          placeholder="Filter by Terminal ID..."
          value={terminalFilter}
          onChange={e => setTerminalFilter(e.target.value)}
          className="max-w-xs"
        />
      </div>

      {loading ? (
        <div className="text-center py-16 text-muted-foreground">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="border rounded-lg py-16 text-center text-muted-foreground bg-card">
          <Receipt className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No transactions yet</p>
          <p className="text-sm mt-1">Click Sync to pull from portal</p>
        </div>
      ) : (
        <div className="border rounded-lg bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Terminal ID</TableHead>
                  <TableHead>Date/Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Card Number</TableHead>
                  <TableHead className="text-right">Amt Reqd</TableHead>
                  <TableHead className="text-right">Fee Reqd</TableHead>
                  <TableHead className="text-right">Amt Disp</TableHead>
                  <TableHead className="text-right">Fee Amt</TableHead>
                  <TableHead>Term Seq</TableHead>
                  <TableHead>Response</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(tx => (
                  <TableRow key={tx.id}>
                    <TableCell className="font-mono text-xs">{tx.terminalId ?? "-"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {tx.transactedAt ? new Date(tx.transactedAt).toLocaleString() : "-"}
                    </TableCell>
                    <TableCell className="text-xs">{tx.transactionType ?? "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{tx.cardNumber ?? "-"}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmt(tx.amountRequested)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmt(tx.feeRequested)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmt(tx.amountDispensed)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmt(tx.feeAmount)}</TableCell>
                    <TableCell className="font-mono text-xs">{tx.termSeq ?? "-"}</TableCell>
                    <TableCell>{responseBadge(tx.response)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="px-4 py-2 text-xs text-muted-foreground border-t">
            Showing {filtered.length} transaction{filtered.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}
    </div>
  );
}
