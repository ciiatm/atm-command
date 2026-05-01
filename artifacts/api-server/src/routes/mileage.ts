import { Router } from "express";
import { db } from "@workspace/db";
import { mileageLogsTable } from "@workspace/db";
import { eq, gte, lte, sum, count, desc } from "drizzle-orm";
import {
  ListMileageLogsQueryParams,
  CreateMileageLogBody,
  DeleteMileageLogParams,
} from "@workspace/api-zod";

// 2024 IRS standard mileage rate
const IRS_RATE_PER_MILE = 0.67;

const router = Router();

router.get("/mileage", async (req, res) => {
  const query = ListMileageLogsQueryParams.safeParse(req.query);
  let logs = await db
    .select()
    .from(mileageLogsTable)
    .orderBy(desc(mileageLogsTable.date));

  if (query.success) {
    if (query.data.startDate) {
      logs = logs.filter((l) => l.date >= query.data.startDate!);
    }
    if (query.data.endDate) {
      logs = logs.filter((l) => l.date <= query.data.endDate!);
    }
  }
  res.json(logs);
});

router.post("/mileage", async (req, res) => {
  const body = CreateMileageLogBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [log] = await db
    .insert(mileageLogsTable)
    .values(body.data)
    .returning();
  res.status(201).json(log);
});

router.delete("/mileage/:id", async (req, res) => {
  const params = DeleteMileageLogParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(mileageLogsTable)
    .where(eq(mileageLogsTable.id, params.data.id));
  res.status(204).send();
});

router.get("/mileage/summary", async (req, res) => {
  const allLogs = await db.select().from(mileageLogsTable);
  const totalMiles = allLogs.reduce((s, l) => s + (l.miles ?? 0), 0);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];
  const yearStart = new Date(now.getFullYear(), 0, 1)
    .toISOString()
    .split("T")[0];

  const monthlyMiles = allLogs
    .filter((l) => l.date >= monthStart)
    .reduce((s, l) => s + (l.miles ?? 0), 0);

  const yearlyMiles = allLogs
    .filter((l) => l.date >= yearStart)
    .reduce((s, l) => s + (l.miles ?? 0), 0);

  res.json({
    totalMiles,
    totalTrips: allLogs.length,
    monthlyMiles,
    yearlyMiles,
    irsDeduction: Math.round(yearlyMiles * IRS_RATE_PER_MILE * 100) / 100,
  });
});

export default router;
