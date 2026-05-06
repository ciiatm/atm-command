import {
  pgTable,
  serial,
  text,
  real,
  timestamp,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const portalSourceEnum = pgEnum("portal_source", [
  "columbus_data",
  "switch_commerce",
  "atm_transact",
  "manual",
]);

export const atmStatusEnum = pgEnum("atm_status", [
  "online",
  "offline",
  "error",
  "low_cash",
  "unknown",
]);

export const atmsTable = pgTable("atms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  locationName: text("location_name").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  latitude: real("latitude"),
  longitude: real("longitude"),
  serialNumber: text("serial_number"),
  portalSource: portalSourceEnum("portal_source").notNull().default("manual"),
  portalAtmId: text("portal_atm_id"),
  cashCapacity: real("cash_capacity").notNull().default(10000),
  currentBalance: real("current_balance").notNull().default(0),
  lowCashThreshold: real("low_cash_threshold").notNull().default(2000),
  status: atmStatusEnum("status").notNull().default("unknown"),
  lastSynced: timestamp("last_synced"),
  avgDailyTransactions: real("avg_daily_transactions"),
  avgDailyDispensed: real("avg_daily_dispensed"),
  surcharge: real("surcharge"),
  makeModel: text("make_model"),
  postalCode: text("postal_code"),
  propertyType: text("property_type"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAtmSchema = createInsertSchema(atmsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertAtm = z.infer<typeof insertAtmSchema>;
export type Atm = typeof atmsTable.$inferSelect;
