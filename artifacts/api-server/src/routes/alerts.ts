import { Router } from "express";
import { db } from "@workspace/db";
import { alertsTable, alertRulesTable, atmsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import {
  ListAlertsQueryParams,
  ResolveAlertParams,
  CreateAlertRuleBody,
  DeleteAlertRuleParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/alerts", async (req, res) => {
  const query = ListAlertsQueryParams.safeParse(req.query);
  const severity = query.success ? query.data.severity : undefined;
  const resolved = query.success ? query.data.resolved : undefined;

  const rows = await db
    .select({
      id: alertsTable.id,
      atmId: alertsTable.atmId,
      atmName: atmsTable.name,
      type: alertsTable.type,
      severity: alertsTable.severity,
      message: alertsTable.message,
      resolved: alertsTable.resolved,
      createdAt: alertsTable.createdAt,
      resolvedAt: alertsTable.resolvedAt,
    })
    .from(alertsTable)
    .leftJoin(atmsTable, eq(alertsTable.atmId, atmsTable.id))
    .orderBy(desc(alertsTable.createdAt));

  let filtered = rows;
  if (severity && severity !== "all") {
    filtered = filtered.filter((a) => a.severity === severity);
  }
  if (resolved !== undefined) {
    filtered = filtered.filter((a) => a.resolved === resolved);
  }

  res.json(filtered);
});

router.put("/alerts/:id/resolve", async (req, res) => {
  const params = ResolveAlertParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [updated] = await db
    .update(alertsTable)
    .set({ resolved: true, resolvedAt: new Date() })
    .where(eq(alertsTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  const [atm] = updated.atmId
    ? await db.select().from(atmsTable).where(eq(atmsTable.id, updated.atmId))
    : [undefined];
  res.json({ ...updated, atmName: atm?.name ?? null });
});

router.get("/alert-rules", async (req, res) => {
  const rules = await db
    .select()
    .from(alertRulesTable)
    .orderBy(desc(alertRulesTable.createdAt));
  res.json(rules);
});

router.post("/alert-rules", async (req, res) => {
  const body = CreateAlertRuleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [rule] = await db
    .insert(alertRulesTable)
    .values({
      name: body.data.name,
      type: body.data.type as any,
      threshold: body.data.threshold ?? null,
      severity: body.data.severity as any,
      isActive: true,
    })
    .returning();
  res.status(201).json(rule);
});

router.delete("/alert-rules/:id", async (req, res) => {
  const params = DeleteAlertRuleParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(alertRulesTable)
    .where(eq(alertRulesTable.id, params.data.id));
  res.status(204).send();
});

export default router;
