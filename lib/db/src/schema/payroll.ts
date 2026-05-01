import {
  pgTable,
  serial,
  text,
  real,
  boolean,
  timestamp,
  integer,
  date,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const payTypeEnum = pgEnum("pay_type", [
  "hourly",
  "salary",
  "contractor",
]);

export const payrollStatusEnum = pgEnum("payroll_status", [
  "pending",
  "approved",
  "paid",
]);

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  role: text("role").notNull(),
  payType: payTypeEnum("pay_type").notNull(),
  payRate: real("pay_rate").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  startDate: date("start_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const payrollRecordsTable = pgTable("payroll_records", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employeesTable.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  hoursWorked: real("hours_worked"),
  grossPay: real("gross_pay").notNull(),
  deductions: real("deductions").notNull().default(0),
  notes: text("notes"),
  status: payrollStatusEnum("status").notNull().default("pending"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({
  id: true,
  createdAt: true,
});

export const insertPayrollRecordSchema = createInsertSchema(
  payrollRecordsTable,
).omit({ id: true, createdAt: true, paidAt: true });

export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;
export type PayrollRecord = typeof payrollRecordsTable.$inferSelect;
