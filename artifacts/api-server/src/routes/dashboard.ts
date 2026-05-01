import { Router } from "express";
import { db } from "@workspace/db";
import {
  atmsTable,
  alertsTable,
  atmTransactionsTable,
  fillOrdersTable,
  bookTransactionsTable,
} from "@workspace/db";
import { eq, count, sum, avg, desc, gte, and, sql } from "drizzle-orm";
import { GetDashboardCashFlowQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/dashboard/summary", async (req, res) => {
  const allAtms = await db.select().from(atmsTable);

  const totalAtms = allAtms.length;
  const onlineAtms = allAtms.filter((a) => a.status === "online").length;
  const offlineAtms = allAtms.filter((a) => a.status === "offline").length;
  const lowCashAtms = allAtms.filter((a) => a.status === "low_cash").length;
  const errorAtms = allAtms.filter((a) => a.status === "error").length;
  const totalCashDeployed = allAtms.reduce(
    (sum, a) => sum + (a.currentBalance || 0),
    0,
  );

  const [alertCounts] = await db
    .select({
      total: count(),
      critical: sql<number>`count(*) filter (where severity = 'critical' and resolved = false)`,
    })
    .from(alertsTable)
    .where(eq(alertsTable.resolved, false));

  const [fillCount] = await db
    .select({ pending: count() })
    .from(fillOrdersTable)
    .where(eq(fillOrdersTable.status, "pending"));

  const avgTx =
    allAtms.reduce((s, a) => s + (a.avgDailyTransactions || 0), 0) /
    (totalAtms || 1);

  const today = new Date().toISOString().split("T")[0];
  const [todayData] = await db
    .select({ dispensed: sum(atmTransactionsTable.totalDispensed) })
    .from(atmTransactionsTable)
    .where(eq(atmTransactionsTable.date, today));

  const monthStart = new Date();
  monthStart.setDate(1);
  const monthStartStr = monthStart.toISOString().split("T")[0];
  const [monthRevenue] = await db
    .select({ revenue: sum(bookTransactionsTable.amount) })
    .from(bookTransactionsTable)
    .where(
      and(
        eq(bookTransactionsTable.type, "income"),
        gte(bookTransactionsTable.date, monthStartStr),
      ),
    );

  res.json({
    totalAtms,
    onlineAtms,
    offlineAtms,
    lowCashAtms,
    errorAtms,
    totalCashDeployed,
    totalActiveAlerts: alertCounts?.total ?? 0,
    criticalAlerts: alertCounts?.critical ?? 0,
    pendingFills: fillCount?.pending ?? 0,
    avgDailyTransactions: Math.round(avgTx),
    todayDispensed: todayData?.dispensed ?? 0,
    monthlyRevenue: monthRevenue?.revenue ?? 0,
  });
});

router.get("/dashboard/cash-flow", async (req, res) => {
  const query = GetDashboardCashFlowQueryParams.safeParse(req.query);
  const days = query.success ? (query.data.days ?? 30) : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  const rows = await db
    .select({
      date: atmTransactionsTable.date,
      dispensed: sum(atmTransactionsTable.totalDispensed),
      transactions: sum(atmTransactionsTable.transactionCount),
    })
    .from(atmTransactionsTable)
    .where(gte(atmTransactionsTable.date, sinceStr))
    .groupBy(atmTransactionsTable.date)
    .orderBy(atmTransactionsTable.date);

  res.json(
    rows.map((r) => ({
      date: r.date,
      dispensed: Number(r.dispensed ?? 0),
      transactions: Number(r.transactions ?? 0),
    })),
  );
});

router.get("/dashboard/top-atms", async (req, res) => {
  const atms = await db
    .select()
    .from(atmsTable)
    .orderBy(desc(atmsTable.avgDailyTransactions))
    .limit(10);

  res.json(
    atms.map((a) => ({
      id: a.id,
      name: a.name,
      locationName: a.locationName,
      avgDailyTransactions: a.avgDailyTransactions ?? 0,
      avgDailyDispensed: a.avgDailyDispensed ?? 0,
      currentBalance: a.currentBalance,
      status: a.status,
    })),
  );
});

router.get("/dashboard/alerts-summary", async (req, res) => {
  const [counts] = await db
    .select({
      critical: sql<number>`count(*) filter (where severity = 'critical' and resolved = false)`,
      warning: sql<number>`count(*) filter (where severity = 'warning' and resolved = false)`,
      info: sql<number>`count(*) filter (where severity = 'info' and resolved = false)`,
      totalUnresolved: sql<number>`count(*) filter (where resolved = false)`,
    })
    .from(alertsTable);

  res.json({
    critical: counts?.critical ?? 0,
    warning: counts?.warning ?? 0,
    info: counts?.info ?? 0,
    totalUnresolved: counts?.totalUnresolved ?? 0,
  });
});

export default router;
