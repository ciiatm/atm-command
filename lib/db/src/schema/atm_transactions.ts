import {
  pgTable,
  serial,
  real,
  timestamp,
  integer,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { atmsTable } from "./atms";

export const atmTransactionsTable = pgTable("atm_transactions", {
  id: serial("id").primaryKey(),
  atmId: integer("atm_id")
    .notNull()
    .references(() => atmsTable.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  transactionCount: integer("transaction_count").notNull().default(0),
  totalDispensed: real("total_dispensed").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAtmTransactionSchema = createInsertSchema(
  atmTransactionsTable,
).omit({ id: true, createdAt: true });

export type InsertAtmTransaction = z.infer<typeof insertAtmTransactionSchema>;
export type AtmTransaction = typeof atmTransactionsTable.$inferSelect;
