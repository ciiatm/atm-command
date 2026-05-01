import { useState } from "react";
import { useListEmployees, useCreateEmployee, useListPayroll, useCreatePayroll, useUpdateEmployee } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Users, Plus, CheckCircle, Clock, DollarSign, Briefcase } from "lucide-react";
import type { CreateEmployeeBody, CreatePayrollBody } from "@workspace/api-client-react";

function payrollStatusBadge(s: string) {
  if (s === "paid") return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15"><CheckCircle className="w-3 h-3 mr-1" />Paid</Badge>;
  if (s === "approved") return <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 hover:bg-blue-500/15"><CheckCircle className="w-3 h-3 mr-1" />Approved</Badge>;
  return <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
}

const today = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const emptyEmp: CreateEmployeeBody = { name: "", email: "", role: "ATM Technician", payType: "hourly", payRate: 20 };
const emptyPayroll: CreatePayrollBody = { employeeId: 0, periodStart: weekAgo, periodEnd: today, hoursWorked: undefined, grossPay: 0, deductions: 0, status: "pending" };

export default function PayrollPage() {
  const { toast } = useToast();
  const [showAddEmp, setShowAddEmp] = useState(false);
  const [showAddPayroll, setShowAddPayroll] = useState(false);
  const [empForm, setEmpForm] = useState<CreateEmployeeBody>(emptyEmp);
  const [payForm, setPayForm] = useState<CreatePayrollBody>(emptyPayroll);

  const { data: employees = [], refetch: refetchEmps } = useListEmployees();
  const { data: payrollRecords = [], refetch: refetchPayroll } = useListPayroll({});
  const createEmployee = useCreateEmployee({ mutation: { onSuccess: () => { refetchEmps(); setShowAddEmp(false); setEmpForm(emptyEmp); toast({ title: "Employee added" }); } } });
  const createPayroll = useCreatePayroll({ mutation: { onSuccess: () => { refetchPayroll(); setShowAddPayroll(false); setPayForm(emptyPayroll); toast({ title: "Payroll record created" }); } } });

  const pendingPayroll = payrollRecords.filter(p => p.status === "pending");
  const totalPending = pendingPayroll.reduce((s, p) => s + p.grossPay - p.deductions, 0);

  // Auto-calculate gross pay for hourly employees
  const selectedEmployee = employees.find(e => e.id === payForm.employeeId);
  const calculatedGross = selectedEmployee?.payType === "hourly" && payForm.hoursWorked && selectedEmployee.payRate
    ? payForm.hoursWorked * selectedEmployee.payRate
    : payForm.grossPay;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Payroll</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage employees and payroll records</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowAddEmp(true)}><Plus className="w-4 h-4 mr-1" />Employee</Button>
          <Button size="sm" onClick={() => setShowAddPayroll(true)}><Plus className="w-4 h-4 mr-1" />Payroll Entry</Button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">{employees.filter(e => e.isActive).length}</p>
          <p className="text-sm text-muted-foreground">Active Employees</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">{pendingPayroll.length}</p>
          <p className="text-sm text-muted-foreground">Pending Payroll</p>
        </div>
        <div className="bg-card border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-emerald-600">${totalPending.toLocaleString()}</p>
          <p className="text-sm text-muted-foreground">Due to Employees</p>
        </div>
      </div>

      {/* Employees */}
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><Users className="w-5 h-5" />Employees</h2>
      <div className="border rounded-lg divide-y bg-card mb-8">
        {employees.length === 0 && <div className="py-12 text-center text-muted-foreground">No employees yet</div>}
        {employees.map(emp => (
          <div key={emp.id} className="flex items-center gap-4 p-4">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <span className="font-bold text-primary text-sm">{emp.name.split(" ").map(n => n[0]).join("").slice(0, 2)}</span>
            </div>
            <div className="flex-1">
              <p className="font-medium text-sm">{emp.name}</p>
              <p className="text-xs text-muted-foreground">{emp.role} · {emp.email}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold text-sm">
                {emp.payType === "hourly" ? `$${emp.payRate}/hr` : `$${emp.payRate?.toLocaleString()}/yr`}
              </p>
              <p className="text-xs text-muted-foreground capitalize">{emp.payType}</p>
            </div>
            <Badge variant={emp.isActive ? "default" : "secondary"}>{emp.isActive ? "Active" : "Inactive"}</Badge>
          </div>
        ))}
      </div>

      {/* Payroll records */}
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><DollarSign className="w-5 h-5" />Payroll Records</h2>
      <div className="border rounded-lg divide-y bg-card">
        {payrollRecords.length === 0 && <div className="py-12 text-center text-muted-foreground">No payroll records yet</div>}
        {payrollRecords.map(record => (
          <div key={record.id} className="flex items-center gap-4 p-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{record.employeeName ?? `Employee #${record.employeeId}`}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(record.periodStart).toLocaleDateString()} – {new Date(record.periodEnd).toLocaleDateString()}
                {record.hoursWorked ? ` · ${record.hoursWorked}h` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="font-bold text-sm">${(record.grossPay - record.deductions).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Net · ${record.grossPay.toLocaleString()} gross</p>
            </div>
            {payrollStatusBadge(record.status)}
          </div>
        ))}
      </div>

      {/* Add Employee Dialog */}
      <Dialog open={showAddEmp} onOpenChange={setShowAddEmp}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Employee</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div><Label>Full Name</Label><Input value={empForm.name} onChange={e => setEmpForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div><Label>Email</Label><Input type="email" value={empForm.email ?? ""} onChange={e => setEmpForm(f => ({ ...f, email: e.target.value }))} /></div>
            <div><Label>Role</Label><Input value={empForm.role ?? ""} onChange={e => setEmpForm(f => ({ ...f, role: e.target.value }))} placeholder="ATM Technician, Route Driver..." /></div>
            <div>
              <Label>Pay Type</Label>
              <Select value={empForm.payType} onValueChange={v => setEmpForm(f => ({ ...f, payType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="salary">Salary</SelectItem>
                  <SelectItem value="contractor">Contractor</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{empForm.payType === "hourly" ? "Hourly Rate ($)" : "Annual Salary ($)"}</Label>
              <Input type="number" step="0.01" value={empForm.payRate ?? ""} onChange={e => setEmpForm(f => ({ ...f, payRate: +e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddEmp(false)}>Cancel</Button>
            <Button onClick={() => createEmployee.mutate({ data: empForm })} disabled={!empForm.name}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Payroll Dialog */}
      <Dialog open={showAddPayroll} onOpenChange={setShowAddPayroll}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Payroll Entry</DialogTitle></DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <Label>Employee</Label>
              <Select value={String(payForm.employeeId)} onValueChange={v => setPayForm(f => ({ ...f, employeeId: +v }))}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {employees.map(e => <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Period Start</Label><Input type="date" value={payForm.periodStart} onChange={e => setPayForm(f => ({ ...f, periodStart: e.target.value }))} /></div>
              <div><Label>Period End</Label><Input type="date" value={payForm.periodEnd} onChange={e => setPayForm(f => ({ ...f, periodEnd: e.target.value }))} /></div>
            </div>
            {selectedEmployee?.payType === "hourly" && (
              <div><Label>Hours Worked</Label><Input type="number" value={payForm.hoursWorked ?? ""} onChange={e => setPayForm(f => ({ ...f, hoursWorked: +e.target.value, grossPay: +e.target.value * (selectedEmployee.payRate ?? 0) }))} /></div>
            )}
            <div><Label>Gross Pay ($)</Label><Input type="number" step="0.01" value={payForm.grossPay} onChange={e => setPayForm(f => ({ ...f, grossPay: +e.target.value }))} /></div>
            <div><Label>Deductions ($)</Label><Input type="number" step="0.01" value={payForm.deductions ?? 0} onChange={e => setPayForm(f => ({ ...f, deductions: +e.target.value }))} /></div>
            <p className="text-sm text-muted-foreground">Net pay: <strong>${((payForm.grossPay || 0) - (payForm.deductions || 0)).toFixed(2)}</strong></p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddPayroll(false)}>Cancel</Button>
            <Button onClick={() => createPayroll.mutate({ data: payForm })} disabled={!payForm.employeeId}>Add Entry</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
