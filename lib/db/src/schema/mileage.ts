import {
  pgTable,
  serial,
  text,
  real,
  timestamp,
  integer,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { routesTable } from "./routes";

export const mileageLogsTable = pgTable("mileage_logs", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  startLocation: text("start_location").notNull(),
  endLocation: text("end_location").notNull(),
  miles: real("miles").notNull(),
  purpose: text("purpose").notNull(),
  routeId: integer("route_id").references(() => routesTable.id, {
    onDelete: "set null",
  }),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMileageLogSchema = createInsertSchema(mileageLogsTable).omit(
  { id: true, createdAt: true },
);

export type InsertMileageLog = z.infer<typeof insertMileageLogSchema>;
export type MileageLog = typeof mileageLogsTable.$inferSelect;
