import { Router } from "express";
import { db } from "@workspace/db";
import { employeesTable, payrollRecordsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  CreateEmployeeBody,
  UpdateEmployeeParams,
  UpdateEmployeeBody,
  ListPayrollQueryParams,
  CreatePayrollBody,
} from "@workspace/api-zod";

const router = Router();

router.get("/employees", async (req, res) => {
  const employees = await db
    .select()
    .from(employeesTable)
    .orderBy(employeesTable.name);
  res.json(employees);
});

router.post("/employees", async (req, res) => {
  const body = CreateEmployeeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [employee] = await db
    .insert(employeesTable)
    .values(body.data)
    .returning();
  res.status(201).json(employee);
});

router.put("/employees/:id", async (req, res) => {
  const params = UpdateEmployeeParams.safeParse({ id: Number(req.params.id) });
  const body = UpdateEmployeeBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [updated] = await db
    .update(employeesTable)
    .set(body.success ? body.data : {})
    .where(eq(employeesTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  res.json(updated);
});

router.get("/payroll", async (req, res) => {
  const query = ListPayrollQueryParams.safeParse(req.query);
  const rows = await db
    .select({
      id: payrollRecordsTable.id,
      employeeId: payrollRecordsTable.employeeId,
      employeeName: employeesTable.name,
      periodStart: payrollRecordsTable.periodStart,
      periodEnd: payrollRecordsTable.periodEnd,
      hoursWorked: payrollRecordsTable.hoursWorked,
      grossPay: payrollRecordsTable.grossPay,
      deductions: payrollRecordsTable.deductions,
      netPay: payrollRecordsTable.grossPay,
      status: payrollRecordsTable.status,
      paidAt: payrollRecordsTable.paidAt,
      notes: payrollRecordsTable.notes,
      createdAt: payrollRecordsTable.createdAt,
    })
    .from(payrollRecordsTable)
    .leftJoin(
      employeesTable,
      eq(payrollRecordsTable.employeeId, employeesTable.id),
    )
    .orderBy(desc(payrollRecordsTable.createdAt));

  let filtered = rows;
  if (query.success && query.data.employeeId) {
    filtered = filtered.filter((r) => r.employeeId === query.data.employeeId);
  }

  res.json(
    filtered.map((r) => ({
      ...r,
      netPay: (r.grossPay ?? 0) - (r.deductions ?? 0),
    })),
  );
});

router.post("/payroll", async (req, res) => {
  const body = CreatePayrollBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const netPay = body.data.grossPay - body.data.deductions;
  const [record] = await db
    .insert(payrollRecordsTable)
    .values({ ...body.data, status: "pending" })
    .returning();
  const [employee] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.id, record.employeeId));
  res.status(201).json({
    ...record,
    employeeName: employee?.name ?? "Unknown",
    netPay,
  });
});

export default router;
