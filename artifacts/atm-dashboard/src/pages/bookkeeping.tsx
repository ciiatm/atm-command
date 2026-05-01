import { useState } from "react";
import { useListAccounts, useGetBookkeepingSummary, useListBookTransactions, useCreateBookTransaction, useCreateAccount } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { TrendingUp, TrendingDown, Plus, BookOpen, Wallet, CreditCard } from "lucide-react";
import type { CreateBookTransactionBody, CreateAccountBody } from "@workspace/api-client-react";

function accountIcon(type: string) {
  if (type === "checking" || type === "savings") return <Wallet className="w-5 h-5 text-primary" />;
  return <CreditCard className="w-5 h-5 text-primary" />;
}

const today = new Date().toISOString().slice(0, 10);
const emptyTx: CreateBookTransactionBody = { accountId: 0, date: today, description: "", amount: 0, type: "income", category: "ATM Revenue" };
const emptyAcct: CreateAccountBody = { name: "", type: "checking", institution: "", lastFour: undefined, balance: 0 };

export default function BookkeepingPage() {
  const { toast } = useToast();
  const [period, setPeriod] = useState("month");
  const [showAddTx, setShowAddTx] = useState(false);
  const [showAddAcct, setShowAddAcct] = useState(false);
  const [txForm, setTxForm] = useState<CreateBookTransactionBody>(emptyTx);
  const [acctForm, setAcctForm] = useState<CreateAccountBody>(emptyAcct);
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const { data: accounts = [] } = useListAccounts();
  const { data: summary } = useGetBookkeepingSummary({ period });
  const { data: transactions = [], refetch } = useListBookTransactions({ type: typeFilter !== "all" ? typeFilter : undefined });
  const createTx = useCreateBookTransaction({ mutation: { onSuccess: () => { refetch(); setShowAddTx(false); setTxForm(emptyTx); toast({ title: "Transaction added" }); } } });
  const createAcct = useCreateAccount({ mutation: { onSuccess: () => { setShowAddAcct(false); setAcctForm(emptyAcct); toast({ title: "Account added" }); } } });

  const totalAssets = accounts.filter(a => a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = accounts.filter(a => a.balance < 0).reduce((s, a) => s + Math.abs(a.balance), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Bookkeeping</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Track income, expenses, and account balances</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowAddAcct(true)}><Plus className="w-4 h-4 mr-1" />Account</Button>
          <Button size="sm" onClick={() => setShowAddTx(true)}><Plus className="w-4 h-4 mr-1" />Transaction</Button>
        </div>
      </div>

      {/* P&L Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-emerald-600" />
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Revenue</p>
          </div>
          <p className="text-2xl font-bold text-emerald-600">${(summary?.totalIncome ?? 0).toLocaleString()}</p>
          <p className="text-xs text-muted-foreground capitalize">{period}</p>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="w-4 h-4 text-red-500" />
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Expenses</p>
          </div>
          <p className="text-2xl font-bold text-red-500">${(summary?.totalExpenses ?? 0).toLocaleString()}</p>
          <p className="text-xs text-muted-foreground capitalize">{period}</p>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-4 h-4 text-primary" />
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Net Profit</p>
          </div>
          <p className={`text-2xl font-bold ${(summary?.netProfit ?? 0) >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            ${(summary?.netProfit ?? 0).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground capitalize">{period}</p>
        </div>
      </div>

      {/* Accounts */}
      <h2 className="text-lg font-semibold mb-3">Accounts</h2>
      <div className="grid grid-cols-2 gap-3 mb-6">
        {accounts.map(acct => (
          <div key={acct.id} className="bg-card border rounded-lg p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              {accountIcon(acct.type)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{acct.name}</p>
              <p className="text-xs text-muted-foreground">{acct.institution}{acct.lastFour ? ` ···${acct.lastFour}` : ""}</p>
            </div>
            <div className="text-right">
              <p className={`font-bold text-sm ${acct.balance >= 0 ? "" : "text-red-500"}`}>
                {acct.balance >= 0 ? "" : "-"}${Math.abs(acct.balance).toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground capitalize">{acct.type.replace("_", " ")}</p>
            </div>
          </div>
        ))}
        <div className="bg-muted/30 border border-dashed rounded-lg p-4 flex items-center justify-center cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setShowAddAcct(true)}>
          <Plus className="w-4 h-4 text-muted-foreground mr-2" />
          <span className="text-sm text-muted-foreground">Add Account</span>
        </div>
      </div>

      {/* Transactions */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Transactions</h2>
        <div className="flex gap-2 items-center">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="week">This Week</SelectItem>
              <SelectItem value="month">This Month</SelectItem>
              <SelectItem value="quarter">This Quarter</SelectItem>
              <SelectItem value="year">This Year</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="income">Income</SelectItem>
              <SelectItem value="expense">Expense</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="border rounded-lg divide-y bg-card">
        {transactions.length === 0 && <div className="py-12 text-center text-muted-foreground">No transactions found</div>}
        {transactions.map(tx => (
          <div key={tx.id} className="flex items-center gap-4 p-4">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${tx.type === "income" ? "bg-emerald-500/15" : "bg-red-500/15"}`}>
              {tx.type === "income" ? <TrendingUp className="w-4 h-4 text-emerald-600" /> : <TrendingDown className="w-4 h-4 text-red-500" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{tx.description}</p>
              <p className="text-xs text-muted-foreground">{new Date(tx.date).toLocaleDateString()} · {tx.category}</p>
            </div>
            <p className={`font-bold text-sm ${tx.type === "income" ? "text-emerald-600" : "text-red-500"}`}>
              {tx.type === "income" ? "+" : "-"}${tx.amount.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {/* Add Transaction Dialog */}
      <Dialog open={showAddTx} onOpenChange={setShowAddTx}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Transaction</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <Label>Type</Label>
              <Select value={txForm.type} onValueChange={v => setTxForm(f => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Income</SelectItem>
                  <SelectItem value="expense">Expense</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Account</Label>
              <Select value={String(txForm.accountId)} onValueChange={v => setTxForm(f => ({ ...f, accountId: +v }))}>
                <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Description</Label><Input value={txForm.description} onChange={e => setTxForm(f => ({ ...f, description: e.target.value }))} /></div>
            <div><Label>Amount ($)</Label><Input type="number" step="0.01" value={txForm.amount} onChange={e => setTxForm(f => ({ ...f, amount: +e.target.value }))} /></div>
            <div><Label>Date</Label><Input type="date" value={txForm.date} onChange={e => setTxForm(f => ({ ...f, date: e.target.value }))} /></div>
            <div><Label>Category</Label><Input value={txForm.category ?? ""} onChange={e => setTxForm(f => ({ ...f, category: e.target.value }))} placeholder="ATM Revenue, Fuel, etc." /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddTx(false)}>Cancel</Button>
            <Button onClick={() => createTx.mutate({ data: txForm })} disabled={!txForm.description || !txForm.accountId}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Account Dialog */}
      <Dialog open={showAddAcct} onOpenChange={setShowAddAcct}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Account</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div><Label>Account Name</Label><Input value={acctForm.name} onChange={e => setAcctForm(f => ({ ...f, name: e.target.value }))} placeholder="Business Checking" /></div>
            <div>
              <Label>Type</Label>
              <Select value={acctForm.type} onValueChange={v => setAcctForm(f => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="checking">Checking</SelectItem>
                  <SelectItem value="savings">Savings</SelectItem>
                  <SelectItem value="credit_card">Credit Card</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Institution</Label><Input value={acctForm.institution ?? ""} onChange={e => setAcctForm(f => ({ ...f, institution: e.target.value }))} placeholder="Chase Bank" /></div>
            <div><Label>Last 4 Digits</Label><Input value={acctForm.lastFour ?? ""} onChange={e => setAcctForm(f => ({ ...f, lastFour: e.target.value }))} placeholder="4521" maxLength={4} /></div>
            <div><Label>Current Balance ($)</Label><Input type="number" step="0.01" value={acctForm.balance ?? 0} onChange={e => setAcctForm(f => ({ ...f, balance: +e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddAcct(false)}>Cancel</Button>
            <Button onClick={() => createAcct.mutate({ data: acctForm })} disabled={!acctForm.name}>Add Account</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
