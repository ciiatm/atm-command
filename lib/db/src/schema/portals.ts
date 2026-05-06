import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const portalNameEnum = pgEnum("portal_name", [
  "columbus_data",
  "switch_commerce",
  "atm_transact",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "success",
  "failed",
  "pending",
  "never",
]);

export const portalsTable = pgTable("portals", {
  id: serial("id").primaryKey(),
  name: portalNameEnum("name").notNull(),
  username: text("username").notNull(),
  passwordEncrypted: text("password_encrypted").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  syncIntervalHours: integer("sync_interval_hours").notNull().default(12),
  lastSynced: timestamp("last_synced"),
  lastSyncStatus: syncStatusEnum("last_sync_status").notNull().default("never"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const portalSyncHistoryTable = pgTable("portal_sync_history", {
  id: serial("id").primaryKey(),
  portalId: integer("portal_id")
    .notNull()
    .references(() => portalsTable.id, { onDelete: "cascade" }),
  success: boolean("success").notNull(),
  message: text("message").notNull(),
  atmsUpdated: integer("atms_updated").notNull().default(0),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
});

export const insertPortalSchema = createInsertSchema(portalsTable).omit({
  id: true,
  createdAt: true,
  lastSynced: true,
  lastSyncStatus: true,
});

export type InsertPortal = z.infer<typeof insertPortalSchema>;
export type Portal = typeof portalsTable.$inferSelect;
export type PortalSyncHistory = typeof portalSyncHistoryTable.$inferSelect;
