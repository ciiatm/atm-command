import { Router } from "express";
import { db } from "@workspace/db";
import {
  atmsTable,
  atmTransactionsTable,
  atmTransactionLogTable,
  alertsTable,
  fillOrdersTable,
} from "@workspace/db";
import { eq, desc, gte, and, isNotNull } from "drizzle-orm";
import {
  ListAtmsQueryParams,
  CreateAtmBody,
  GetAtmParams,
  UpdateAtmParams,
  UpdateAtmBody,
  DeleteAtmParams,
  GetAtmTransactionsParams,
  GetAtmTransactionsQueryParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/atms", async (req, res) => {
  const query = ListAtmsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.issues });
    return;
  }
  const { status, portal } = query.data;

  const conditions = [];
  if (status && status !== "all") {
    conditions.push(eq(atmsTable.status, status as any));
  }
  if (portal) {
    conditions.push(eq(atmsTable.portalSource, portal as any));
  }

  const atms =
    conditions.length > 0
      ? await db
          .select()
          .from(atmsTable)
          .where(and(...conditions))
          .orderBy(atmsTable.name)
      : await db.select().from(atmsTable).orderBy(atmsTable.name);

  res.json(atms);
});

router.post("/atms", async (req, res) => {
  const body = CreateAtmBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [atm] = await db.insert(atmsTable).values(body.data).returning();
  res.status(201).json(atm);
});

router.get("/atms/:id", async (req, res) => {
  const params = GetAtmParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: params.error.issues });
    return;
  }
  const { id } = params.data;
  const [atm] = await db
    .select()
    .from(atmsTable)
    .where(eq(atmsTable.id, id));
  if (!atm) {
    res.status(404).json({ error: "ATM not found" });
    return;
  }

  const recentAlerts = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.atmId, id))
    .orderBy(desc(alertsTable.createdAt))
    .limit(10);

  const fillHistory = await db
    .select()
    .from(fillOrdersTable)
    .where(eq(fillOrdersTable.atmId, id))
    .orderBy(desc(fillOrdersTable.createdAt))
    .limit(10);

  res.json({ ...atm, recentAlerts, fillHistory });
});

router.put("/atms/:id", async (req, res) => {
  const params = UpdateAtmParams.safeParse({ id: Number(req.params.id) });
  const body = UpdateAtmBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const [updated] = await db
    .update(atmsTable)
    .set(body.data)
    .where(eq(atmsTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "ATM not found" });
    return;
  }
  res.json(updated);
});

router.delete("/atms/:id", async (req, res) => {
  const params = DeleteAtmParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(atmsTable).where(eq(atmsTable.id, params.data.id));
  res.status(204).send();
});

router.get("/atms/:id/transactions", async (req, res) => {
  const params = GetAtmTransactionsParams.safeParse({
    id: Number(req.params.id),
  });
  const query = GetAtmTransactionsQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { id } = params.data;
  const days = query.data.days ?? 30;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  const transactions = await db
    .select()
    .from(atmTransactionsTable)
    .where(
      and(
        eq(atmTransactionsTable.atmId, id),
        gte(atmTransactionsTable.date, sinceStr),
      ),
    )
    .orderBy(desc(atmTransactionsTable.date));

  res.json(transactions);
});

// ---------------------------------------------------------------------------
// Individual transaction log (scraped from portal Table5)
// ---------------------------------------------------------------------------

router.get("/atms/:id/transaction-log", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  const logs = await db
    .select()
    .from(atmTransactionLogTable)
    .where(eq(atmTransactionLogTable.atmId, id))
    .orderBy(desc(atmTransactionLogTable.transactedAt))
    .limit(limit);

  res.json(logs);
});

// ---------------------------------------------------------------------------
// Global transaction log endpoint (all ATMs)
// GET /atms/transactions?limit=500&terminalId=L658443
// ---------------------------------------------------------------------------

router.get("/atms/transactions", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 500), 1000);
  const terminalIdFilter = req.query.terminalId as string | undefined;

  const conditions = [isNotNull(atmTransactionLogTable.transactedAt)];
  if (terminalIdFilter) {
    conditions.push(eq(atmsTable.portalAtmId, terminalIdFilter));
  }

  const rows = await db
    .select({
      id: atmTransactionLogTable.id,
      atmId: atmTransactionLogTable.atmId,
      terminalId: atmsTable.portalAtmId,
      transactedAt: atmTransactionLogTable.transactedAt,
      transactionType: atmTransactionLogTable.transactionType,
      cardNumber: atmTransactionLogTable.cardNumber,
      amount: atmTransactionLogTable.amount,
      response: atmTransactionLogTable.response,
      terminalBalance: atmTransactionLogTable.terminalBalance,
      amountRequested: (atmTransactionLogTable as any).amountRequested,
      feeRequested: (atmTransactionLogTable as any).feeRequested,
      amountDispensed: (atmTransactionLogTable as any).amountDispensed,
      feeAmount: (atmTransactionLogTable as any).feeAmount,
      termSeq: (atmTransactionLogTable as any).termSeq,
    })
    .from(atmTransactionLogTable)
    .leftJoin(atmsTable, eq(atmTransactionLogTable.atmId, atmsTable.id))
    .where(and(...conditions))
    .orderBy(desc(atmTransactionLogTable.transactedAt))
    .limit(limit);

  res.json(rows);
});

// ---------------------------------------------------------------------------
// Bulk import from Excel (parsed client-side, sent as JSON)
// ---------------------------------------------------------------------------

interface ImportAtmRow {
  portalAtmId?: string;
  name: string;
  locationName: string;
  address: string;
  city: string;
  state: string;
}

router.post("/atms/import", async (req, res) => {
  const { rows, skipExisting = true } = req.body as {
    rows: ImportAtmRow[];
    skipExisting?: boolean;
  };

  if (!Array.isArray(rows)) {
    res.status(400).json({ error: "rows must be an array" });
    return;
  }
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    // Skip if an ATM with same portalAtmId already exists
    if (skipExisting && row.portalAtmId) {
      const existing = await db
        .select({ id: atmsTable.id })
        .from(atmsTable)
        .where(eq(atmsTable.portalAtmId, row.portalAtmId))
        .limit(1);
      if (existing.length > 0) {
        skipped++;
        continue;
      }
    }

    await db.insert(atmsTable).values({
      portalAtmId: row.portalAtmId,
      name: row.name,
      locationName: row.locationName,
      address: row.address,
      city: row.city,
      state: row.state,
      portalSource: "manual",
      cashCapacity: 10000,
      currentBalance: 0,
      lowCashThreshold: 2000,
      status: "unknown",
    });
    imported++;
  }

  res.json({ imported, skipped, total: rows.length });
});

export default router;
