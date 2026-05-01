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

export const accountTypeEnum = pgEnum("account_type", [
  "checking",
  "savings",
  "credit_card",
  "cash",
  "other",
]);

export const transactionTypeEnum = pgEnum("transaction_type_bk", [
  "income",
  "expense",
]);

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: accountTypeEnum("type").notNull(),
  institution: text("institution").notNull(),
  lastFour: text("last_four"),
  balance: real("balance").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bookTransactionsTable = pgTable("book_transactions", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accountsTable.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  description: text("description").notNull(),
  amount: real("amount").notNull(),
  type: transactionTypeEnum("type").notNull(),
  category: text("category").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({
  id: true,
  createdAt: true,
});

export const insertBookTransactionSchema = createInsertSchema(
  bookTransactionsTable,
).omit({ id: true, createdAt: true });

export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
export type BookTransaction = typeof bookTransactionsTable.$inferSelect;
