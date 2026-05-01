import {
  pgTable,
  serial,
  text,
  boolean,
  real,
  timestamp,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { atmsTable } from "./atms";

export const alertTypeEnum = pgEnum("alert_type", [
  "low_cash",
  "machine_error",
  "offline",
  "out_of_cash",
  "sync_failed",
  "custom",
]);

export const alertSeverityEnum = pgEnum("alert_severity", [
  "critical",
  "warning",
  "info",
]);

export const alertRuleTypeEnum = pgEnum("alert_rule_type", [
  "low_cash",
  "machine_error",
  "offline",
  "out_of_cash",
]);

export const alertsTable = pgTable("alerts", {
  id: serial("id").primaryKey(),
  atmId: integer("atm_id").references(() => atmsTable.id, {
    onDelete: "cascade",
  }),
  type: alertTypeEnum("type").notNull(),
  severity: alertSeverityEnum("severity").notNull(),
  message: text("message").notNull(),
  resolved: boolean("resolved").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

export const alertRulesTable = pgTable("alert_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: alertRuleTypeEnum("type").notNull(),
  threshold: real("threshold"),
  severity: alertSeverityEnum("severity").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAlertSchema = createInsertSchema(alertsTable).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});

export const insertAlertRuleSchema = createInsertSchema(alertRulesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Alert = typeof alertsTable.$inferSelect;
export type AlertRule = typeof alertRulesTable.$inferSelect;
