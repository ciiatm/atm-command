import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, bookTransactionsTable } from "@workspace/db";
import { eq, and, gte, lte, desc, sum, sql } from "drizzle-orm";
import {
  CreateAccountBody,
  UpdateAccountParams,
  UpdateAccountBody,
  DeleteAccountParams,
  ListBookTransactionsQueryParams,
  CreateBookTransactionBody,
  DeleteBookTransactionParams,
  GetBookkeepingSummaryParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/accounts", async (req, res) => {
  const accounts = await db
    .select()
    .from(accountsTable)
    .orderBy(accountsTable.name);
  res.json(accounts);
});

router.post("/accounts", async (req, res) => {
  const body = CreateAccountBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [account] = await db
    .insert(accountsTable)
    .values(body.data)
    .returning();
  res.status(201).json(account);
});

router.put("/accounts/:id", async (req, res) => {
  const params = UpdateAccountParams.safeParse({ id: Number(req.params.id) });
  const body = UpdateAccountBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [updated] = await db
    .update(accountsTable)
    .set(body.success ? body.data : {})
    .where(eq(accountsTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(updated);
});

router.delete("/accounts/:id", async (req, res) => {
  const params = DeleteAccountParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(accountsTable)
    .where(eq(accountsTable.id, params.data.id));
  res.status(204).send();
});

router.get("/book-transactions", async (req, res) => {
  const query = ListBookTransactionsQueryParams.safeParse(req.query);
  const rows = await db
    .select({
      id: bookTransactionsTable.id,
      accountId: bookTransactionsTable.accountId,
      accountName: accountsTable.name,
      date: bookTransactionsTable.date,
      description: bookTransactionsTable.description,
      amount: bookTransactionsTable.amount,
      type: bookTransactionsTable.type,
      category: bookTransactionsTable.category,
      notes: bookTransactionsTable.notes,
      createdAt: bookTransactionsTable.createdAt,
    })
    .from(bookTransactionsTable)
    .leftJoin(
      accountsTable,
      eq(bookTransactionsTable.accountId, accountsTable.id),
    )
    .orderBy(desc(bookTransactionsTable.date));

  let filtered = rows;
  if (query.success) {
    if (query.data.accountId) {
      filtered = filtered.filter((t) => t.accountId === query.data.accountId);
    }
    if (query.data.category) {
      filtered = filtered.filter((t) => t.category === query.data.category);
    }
    if (query.data.startDate) {
      const start = query.data.startDate;
      filtered = filtered.filter((t) => t.date >= start);
    }
    if (query.data.endDate) {
      const end = query.data.endDate;
      filtered = filtered.filter((t) => t.date <= end);
    }
  }

  res.json(filtered);
});

router.post("/book-transactions", async (req, res) => {
  const body = CreateBookTransactionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [tx] = await db
    .insert(bookTransactionsTable)
    .values(body.data)
    .returning();
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, tx.accountId));
  res.status(201).json({ ...tx, accountName: account?.name ?? "Unknown" });
});

router.delete("/book-transactions/:id", async (req, res) => {
  const params = DeleteBookTransactionParams.safeParse({
    id: Number(req.params.id),
  });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(bookTransactionsTable)
    .where(eq(bookTransactionsTable.id, params.data.id));
  res.status(204).send();
});

router.get("/bookkeeping/summary", async (req, res) => {
  const allTx = await db.select().from(bookTransactionsTable);

  let filtered = allTx;
  if (req.query.startDate) {
    filtered = filtered.filter((t) => t.date >= (req.query.startDate as string));
  }
  if (req.query.endDate) {
    filtered = filtered.filter((t) => t.date <= (req.query.endDate as string));
  }

  const totalIncome = filtered
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const totalExpenses = filtered
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + (t.amount ?? 0), 0);

  const categoryMap: Record<string, { category: string; type: string; total: number }> = {};
  for (const tx of filtered) {
    const key = `${tx.category}__${tx.type}`;
    if (!categoryMap[key]) {
      categoryMap[key] = { category: tx.category, type: tx.type, total: 0 };
    }
    categoryMap[key].total += tx.amount ?? 0;
  }

  res.json({
    totalIncome,
    totalExpenses,
    netProfit: totalIncome - totalExpenses,
    byCategory: Object.values(categoryMap).sort((a, b) => b.total - a.total),
  });
});

export default router;
