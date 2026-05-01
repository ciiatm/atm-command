import { Router } from "express";
import { db } from "@workspace/db";
import { atmsTable, fillOrdersTable } from "@workspace/db";
import { eq, inArray, desc } from "drizzle-orm";
import {
  CalculateFillsBody,
  ListFillsQueryParams,
  CreateFillBody,
  UpdateFillParams,
  UpdateFillBody,
} from "@workspace/api-zod";

const router = Router();

router.post("/cash-planning/calculate", async (req, res) => {
  const rawBody = {
    ...req.body,
    daysToFill: req.body.daysToFill ?? req.body.days,
  };
  const body = CalculateFillsBody.safeParse({
    ...rawBody,
    atmIds: rawBody.atmIds ?? [],
  });
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const { atmIds, daysToFill, bufferPercent = 10 } = body.data;

  const atms =
    atmIds.length > 0
      ? await db.select().from(atmsTable).where(inArray(atmsTable.id, atmIds))
      : await db.select().from(atmsTable);

  const recommendations = atms.map((atm) => {
    const avgDailyDispensed = atm.avgDailyDispensed ?? 500;
    const currentBalance = atm.currentBalance ?? 0;
    const cashCapacity = atm.cashCapacity ?? 10000;
    const buffer = bufferPercent / 100;

    const totalNeeded = avgDailyDispensed * daysToFill * (1 + buffer);
    const recommendedLoad = Math.min(
      Math.max(0, totalNeeded - currentBalance),
      cashCapacity - currentBalance,
    );

    let priority: "critical" | "high" | "medium" | "low";
    const daysLeft =
      avgDailyDispensed > 0 ? currentBalance / avgDailyDispensed : 999;
    if (daysLeft < 1) priority = "critical";
    else if (daysLeft < 3) priority = "high";
    else if (daysLeft < 7) priority = "medium";
    else priority = "low";

    return {
      atmId: atm.id,
      atmName: atm.name,
      locationName: atm.locationName,
      currentBalance,
      avgDailyDispensed,
      recommendedLoad,
      totalNeeded,
      daysToFill,
      cashCapacity,
      priority,
    };
  });

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  recommendations.sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority],
  );

  res.json(recommendations);
});

router.get("/fills", async (req, res) => {
  const query = ListFillsQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;

  const fills = await db
    .select({
      id: fillOrdersTable.id,
      atmId: fillOrdersTable.atmId,
      atmName: atmsTable.name,
      locationName: atmsTable.locationName,
      scheduledDate: fillOrdersTable.scheduledDate,
      cashAmount: fillOrdersTable.cashAmount,
      daysToFill: fillOrdersTable.daysToFill,
      status: fillOrdersTable.status,
      notes: fillOrdersTable.notes,
      createdAt: fillOrdersTable.createdAt,
      completedAt: fillOrdersTable.completedAt,
    })
    .from(fillOrdersTable)
    .leftJoin(atmsTable, eq(fillOrdersTable.atmId, atmsTable.id))
    .orderBy(desc(fillOrdersTable.createdAt));

  const filtered =
    status && status !== "all"
      ? fills.filter((f) => f.status === status)
      : fills;

  res.json(filtered);
});

router.post("/fills", async (req, res) => {
  const body = CreateFillBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [fill] = await db
    .insert(fillOrdersTable)
    .values(body.data)
    .returning();

  const [atm] = await db
    .select()
    .from(atmsTable)
    .where(eq(atmsTable.id, fill.atmId));

  res.status(201).json({
    ...fill,
    atmName: atm?.name ?? "Unknown",
    locationName: atm?.locationName ?? "Unknown",
  });
});

router.put("/fills/:id", async (req, res) => {
  const params = UpdateFillParams.safeParse({ id: Number(req.params.id) });
  const body = UpdateFillBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const updateData: Record<string, any> = {};
  if (body.success) {
    if (body.data.status) {
      updateData.status = body.data.status;
      if (body.data.status === "completed") {
        updateData.completedAt = new Date();
      }
    }
    if (body.data.notes !== undefined) updateData.notes = body.data.notes;
    if (body.data.cashAmount !== undefined)
      updateData.cashAmount = body.data.cashAmount;
  }

  const [updated] = await db
    .update(fillOrdersTable)
    .set(updateData)
    .where(eq(fillOrdersTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Fill order not found" });
    return;
  }

  const [atm] = await db
    .select()
    .from(atmsTable)
    .where(eq(atmsTable.id, updated.atmId));

  res.json({
    ...updated,
    atmName: atm?.name ?? "Unknown",
    locationName: atm?.locationName ?? "Unknown",
  });
});

export default router;
