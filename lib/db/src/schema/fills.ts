import {
  pgTable,
  serial,
  text,
  real,
  timestamp,
  integer,
  date,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { atmsTable } from "./atms";

export const fillStatusEnum = pgEnum("fill_status", [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export const fillOrdersTable = pgTable("fill_orders", {
  id: serial("id").primaryKey(),
  atmId: integer("atm_id")
    .notNull()
    .references(() => atmsTable.id, { onDelete: "cascade" }),
  scheduledDate: date("scheduled_date").notNull(),
  cashAmount: real("cash_amount").notNull(),
  daysToFill: integer("days_to_fill").notNull(),
  status: fillStatusEnum("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertFillOrderSchema = createInsertSchema(fillOrdersTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type InsertFillOrder = z.infer<typeof insertFillOrderSchema>;
export type FillOrder = typeof fillOrdersTable.$inferSelect;
