import {
  pgTable,
  serial,
  real,
  timestamp,
  integer,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { atmsTable } from "./atms";

/**
 * Individual transaction records scraped from the Columbus Data portal (Table5).
 * One row per transaction. Unique on (atmId, transactedAt) to prevent duplicates
 * across repeated syncs.
 */
export const atmTransactionLogTable = pgTable(
  "atm_transaction_log",
  {
    id: serial("id").primaryKey(),
    atmId: integer("atm_id")
      .notNull()
      .references(() => atmsTable.id, { onDelete: "cascade" }),
    /** Timestamp of the transaction as reported by the portal */
    transactedAt: timestamp("transacted_at").notNull(),
    /** Masked card number, e.g. "XXXX XXXX XXXX 1234" */
    cardNumber: text("card_number"),
    /** Transaction type, e.g. "Withdrawal", "Balance Inquiry" */
    transactionType: text("transaction_type"),
    /** Amount dispensed in dollars (0 for non-cash transactions) */
    amount: real("amount").notNull().default(0),
    /** Portal response string, e.g. "Approved", "Declined" */
    response: text("response"),
    /** ATM cash balance after this transaction */
    terminalBalance: real("terminal_balance"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    atmTransactedAtUniq: uniqueIndex("atm_transaction_log_atm_transacted_at_uniq").on(
      t.atmId,
      t.transactedAt,
    ),
  }),
);

export type AtmTransactionLog = typeof atmTransactionLogTable.$inferSelect;
