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

export const routeStatusEnum = pgEnum("route_status", [
  "planned",
  "in_progress",
  "completed",
  "cancelled",
]);

export const routeStopStatusEnum = pgEnum("route_stop_status", [
  "pending",
  "completed",
  "skipped",
]);

export const routesTable = pgTable("routes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  scheduledDate: date("scheduled_date").notNull(),
  status: routeStatusEnum("status").notNull().default("planned"),
  totalCashNeeded: real("total_cash_needed").notNull().default(0),
  estimatedDistanceMiles: real("estimated_distance_miles"),
  estimatedDurationMinutes: integer("estimated_duration_minutes"),
  startAddress: text("start_address"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const routeStopsTable = pgTable("route_stops", {
  id: serial("id").primaryKey(),
  routeId: integer("route_id")
    .notNull()
    .references(() => routesTable.id, { onDelete: "cascade" }),
  stopOrder: integer("stop_order").notNull(),
  atmId: integer("atm_id")
    .notNull()
    .references(() => atmsTable.id, { onDelete: "cascade" }),
  cashToLoad: real("cash_to_load").notNull(),
  status: routeStopStatusEnum("status").notNull().default("pending"),
});

export const insertRouteSchema = createInsertSchema(routesTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type InsertRoute = z.infer<typeof insertRouteSchema>;
export type Route = typeof routesTable.$inferSelect;
export type RouteStop = typeof routeStopsTable.$inferSelect;
