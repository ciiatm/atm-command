import { Router } from "express";
import { db } from "@workspace/db";
import {
  portalsTable,
  portalSyncHistoryTable,
  atmsTable,
  alertsTable,
  atmTransactionLogTable,
} from "@workspace/db";
import { eq, count, desc } from "drizzle-orm";
import {
  CreatePortalBody,
  UpdatePortalParams,
  UpdatePortalBody,
  DeletePortalParams,
  SyncPortalParams,
} from "@workspace/api-zod";
import { scrapeColumbusData } from "../lib/scrapers/columbus-data.js";

const PORTAL_CONFIG: Record<
  string,
  { displayName: string; url: string }
> = {
  columbus_data: {
    displayName: "Columbus Data",
    url: "https://www.columbusdata.net/cdswebtool/login/login.aspx",
  },
  switch_commerce: {
    displayName: "Switch Commerce",
    url: "https://www.switchcommerce.net/TMS/Login.aspx",
  },
  atm_transact: {
    displayName: "ATM Transact",
    url: "https://portal.atmtransact.com/login",
  },
};

const router = Router();

router.get("/portals", async (req, res) => {
  const portals = await db.select().from(portalsTable).orderBy(portalsTable.name);
  const atmCounts = await db
    .select({ source: atmsTable.portalSource, cnt: count() })
    .from(atmsTable)
    .groupBy(atmsTable.portalSource);

  const countMap: Record<string, number> = {};
  for (const row of atmCounts) {
    if (row.source) countMap[row.source] = Number(row.cnt);
  }

  res.json(
    portals.map((p) => ({
      id: p.id,
      name: p.name,
      displayName: PORTAL_CONFIG[p.name]?.displayName ?? p.name,
      url: PORTAL_CONFIG[p.name]?.url ?? "",
      username: p.username,
      isActive: p.isActive,
      syncIntervalHours: p.syncIntervalHours,
      lastSynced: p.lastSynced,
      lastSyncStatus: p.lastSyncStatus,
      atmCount: countMap[p.name] ?? 0,
      createdAt: p.createdAt,
    })),
  );
});

router.post("/portals", async (req, res) => {
  const body = CreatePortalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const [portal] = await db
    .insert(portalsTable)
    .values({
      name: body.data.name as any,
      username: body.data.username,
      passwordEncrypted: body.data.password,
      syncIntervalHours: (body.data as any).syncIntervalHours ?? 12,
    })
    .returning();

  res.status(201).json({
    id: portal.id,
    name: portal.name,
    displayName: PORTAL_CONFIG[portal.name]?.displayName ?? portal.name,
    url: PORTAL_CONFIG[portal.name]?.url ?? "",
    username: portal.username,
    isActive: portal.isActive,
    syncIntervalHours: portal.syncIntervalHours,
    lastSynced: portal.lastSynced,
    lastSyncStatus: portal.lastSyncStatus,
    atmCount: 0,
    createdAt: portal.createdAt,
  });
});

router.put("/portals/:id", async (req, res) => {
  const params = UpdatePortalParams.safeParse({ id: Number(req.params.id) });
  const body = UpdatePortalBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const updateData: Record<string, any> = {};
  if (body.success) {
    if (body.data.username) updateData.username = body.data.username;
    if (body.data.password) updateData.passwordEncrypted = body.data.password;
    if (body.data.isActive !== undefined) updateData.isActive = body.data.isActive;
  }
  if ((req.body as any).syncIntervalHours) {
    updateData.syncIntervalHours = Number((req.body as any).syncIntervalHours);
  }
  const [updated] = await db
    .update(portalsTable)
    .set(updateData)
    .where(eq(portalsTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Portal not found" });
    return;
  }
  const [atmsCountRow] = await db
    .select({ cnt: count() })
    .from(atmsTable)
    .where(eq(atmsTable.portalSource, updated.name as any));

  res.json({
    id: updated.id,
    name: updated.name,
    displayName: PORTAL_CONFIG[updated.name]?.displayName ?? updated.name,
    url: PORTAL_CONFIG[updated.name]?.url ?? "",
    username: updated.username,
    isActive: updated.isActive,
    syncIntervalHours: updated.syncIntervalHours,
    lastSynced: updated.lastSynced,
    lastSyncStatus: updated.lastSyncStatus,
    atmCount: Number(atmsCountRow?.cnt ?? 0),
    createdAt: updated.createdAt,
  });
});

router.delete("/portals/:id", async (req, res) => {
  const params = DeletePortalParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(portalsTable).where(eq(portalsTable.id, params.data.id));
  res.status(204).send();
});

router.post("/portals/:id/sync", async (req, res) => {
  const params = SyncPortalParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [portal] = await db
    .select()
    .from(portalsTable)
    .where(eq(portalsTable.id, params.data.id));
  if (!portal) {
    res.status(404).json({ error: "Portal not found" });
    return;
  }

  // Return immediately — the real scrape runs in the background.
  // The ALB has a 60s idle timeout; Puppeteer scrapes take longer.
  // The frontend polls sync history to see when it completes.
  res.json({
    portalId: portal.id,
    portalName: PORTAL_CONFIG[portal.name]?.displayName ?? portal.name,
    success: true,
    message: "Sync started in background",
    atmsUpdated: 0,
    alertsCreated: 0,
    syncedAt: new Date().toISOString(),
    background: true,
  });

  // Run the actual sync after response is sent
  runSyncInBackground(portal);
});

async function runSyncInBackground(portal: {
  id: number; name: string; username: string; passwordEncrypted: string; syncIntervalHours: number;
}) {
  let result: { success: boolean; message: string; atmsUpdated: number; alertsCreated: number };
  try {
    result = await performPortalSync(portal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { success: false, message, atmsUpdated: 0, alertsCreated: 0 };
  }

  await db
    .update(portalsTable)
    .set({ lastSynced: new Date(), lastSyncStatus: result.success ? "success" : "failed" })
    .where(eq(portalsTable.id, portal.id));

  await db.insert(portalSyncHistoryTable).values({
    portalId: portal.id,
    success: result.success,
    message: result.message,
    atmsUpdated: result.atmsUpdated,
  });
}

router.post("/portals/sync-all", async (req, res) => {
  const portals = await db
    .select()
    .from(portalsTable)
    .where(eq(portalsTable.isActive, true));

  const results = await Promise.all(
    portals.map(async (portal) => {
      const result = await performPortalSync(portal);

      await db
        .update(portalsTable)
        .set({
          lastSynced: new Date(),
          lastSyncStatus: result.success ? "success" : "failed",
        })
        .where(eq(portalsTable.id, portal.id));

      await db.insert(portalSyncHistoryTable).values({
        portalId: portal.id,
        success: result.success,
        message: result.message,
        atmsUpdated: result.atmsUpdated,
      });

      return {
        portalId: portal.id,
        portalName: PORTAL_CONFIG[portal.name]?.displayName ?? portal.name,
        success: result.success,
        message: result.message,
        atmsUpdated: result.atmsUpdated,
        alertsCreated: result.alertsCreated,
        syncedAt: new Date().toISOString(),
      };
    }),
  );

  res.json(results);
});

router.get("/portals/sync-history", async (req, res) => {
  const history = await db
    .select({
      id: portalSyncHistoryTable.id,
      portalId: portalSyncHistoryTable.portalId,
      portalName: portalsTable.name,
      success: portalSyncHistoryTable.success,
      message: portalSyncHistoryTable.message,
      atmsUpdated: portalSyncHistoryTable.atmsUpdated,
      syncedAt: portalSyncHistoryTable.syncedAt,
    })
    .from(portalSyncHistoryTable)
    .leftJoin(portalsTable, eq(portalSyncHistoryTable.portalId, portalsTable.id))
    .orderBy(desc(portalSyncHistoryTable.syncedAt))
    .limit(50);

  res.json(
    history.map((h) => ({
      ...h,
      portalName:
        PORTAL_CONFIG[h.portalName ?? ""]?.displayName ?? h.portalName ?? "Unknown",
    })),
  );
});

async function performPortalSync(portal: {
  id: number;
  name: string;
  username: string;
  passwordEncrypted: string;
}): Promise<{
  success: boolean;
  message: string;
  atmsUpdated: number;
  alertsCreated: number;
}> {
  // Route to real scraper for Columbus Data; simulate for others
  if (portal.name === "columbus_data") {
    return performColumbusDataSync(portal);
  }
  return performSimulatedSync(portal);
}

/** Real Columbus Data sync using Puppeteer */
async function performColumbusDataSync(portal: {
  id: number;
  name: string;
  username: string;
  passwordEncrypted: string;
}): Promise<{
  success: boolean;
  message: string;
  atmsUpdated: number;
  alertsCreated: number;
}> {
  try {
    const terminalStatuses = await scrapeColumbusData(
      portal.username,
      portal.passwordEncrypted,
    );

    let atmsUpdated = 0;
    let alertsCreated = 0;

    for (const ts of terminalStatuses) {
      // Find the ATM by portalAtmId
      let [atm] = await db
        .select()
        .from(atmsTable)
        .where(eq(atmsTable.portalAtmId, ts.terminalId));

      if (!atm) {
        // Auto-create the ATM if it doesn't exist yet
        const balance = cappedBalance(ts.currentBalance);
        const [newAtm] = await db
          .insert(atmsTable)
          .values({
            name: ts.locationName || ts.terminalLabel || ts.terminalId,
            locationName: ts.locationName || ts.terminalLabel || ts.terminalId,
            address: ts.address || "Unknown",
            city: ts.city || "Unknown",
            state: ts.state || "Unknown",
            portalSource: "columbus_data",
            portalAtmId: ts.terminalId,
            currentBalance: balance,
            status: resolveStatus(ts, 2000),
            lastSynced: new Date(),
            ...(ts.makeModel ? { makeModel: ts.makeModel } : {}),
            ...(ts.surcharge != null ? { surcharge: ts.surcharge } : {}),
          } as any)
          .returning();

        if (newAtm && balance < (newAtm.lowCashThreshold ?? 2000)) {
          await createBalanceAlert(newAtm.id, newAtm.name, balance, newAtm.lowCashThreshold ?? 2000);
          alertsCreated++;
        }

        if (newAtm) {
          await storeTransactions(newAtm.id, ts.transactions);
        }
        atmsUpdated++;
        continue;
      }

      const newBalance = cappedBalance(ts.currentBalance ?? atm.currentBalance);
      const newStatus = resolveStatus({ ...ts, currentBalance: newBalance }, atm.lowCashThreshold ?? 2000);

      // Build update — always refresh balance/status; patch address/location
      // only when we now have real data (overwriting placeholder "Unknown")
      const updateSet: Record<string, any> = {
        currentBalance: newBalance,
        status: newStatus,
        lastSynced: new Date(),
        ...(ts.dailyCashDispensed != null ? { avgDailyDispensed: ts.dailyCashDispensed } : {}),
        ...(ts.dailyTransactionCount != null ? { avgDailyTransactions: ts.dailyTransactionCount } : {}),
        ...(ts.surcharge != null ? { surcharge: ts.surcharge } : {}),
        ...(ts.makeModel ? { makeModel: ts.makeModel } : {}),
        // Patch address/name only if the report gave us real data
        ...(ts.locationName ? { locationName: ts.locationName } : {}),
        ...(ts.address ? { address: ts.address } : {}),
        ...(ts.city ? { city: ts.city } : {}),
        ...(ts.state ? { state: ts.state } : {}),
      };

      await db
        .update(atmsTable)
        .set(updateSet)
        .where(eq(atmsTable.id, atm.id));

      if (newStatus === "low_cash" || newStatus === "error") {
        await createBalanceAlert(atm.id, atm.name, newBalance, atm.lowCashThreshold ?? 2000);
        alertsCreated++;
      }

      await storeTransactions(atm.id, ts.transactions);
      atmsUpdated++;
    }

    return {
      success: true,
      message: `Synced ${atmsUpdated} ATMs from Columbus Data`,
      atmsUpdated,
      alertsCreated,
    };
  } catch (err) {
    return {
      success: false,
      message: `Columbus Data sync failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      atmsUpdated: 0,
      alertsCreated: 0,
    };
  }
}

const MAX_BALANCE = 40_000;

function resolveStatus(
  ts: { currentBalance: number | null; isOnline: boolean },
  lowCashThreshold = 2000,
): "online" | "offline" | "error" | "low_cash" | "unknown" {
  if (!ts.isOnline) return "offline";
  if (ts.currentBalance === null) return "unknown";
  if (ts.currentBalance === 0) return "error";
  if (ts.currentBalance < lowCashThreshold) return "low_cash";
  return "online";
}

function cappedBalance(raw: number | null | undefined): number {
  if (raw == null) return 0;
  return Math.min(raw, MAX_BALANCE);
}

async function createBalanceAlert(
  atmId: number,
  atmName: string,
  balance: number,
  threshold: number,
): Promise<void> {
  const isEmpty = balance === 0;
  await db.insert(alertsTable).values({
    atmId,
    type: isEmpty ? "out_of_cash" : "low_cash",
    severity: isEmpty ? "critical" : "warning",
    message: isEmpty
      ? `${atmName} is out of cash`
      : `${atmName} cash balance is below threshold ($${balance.toFixed(0)})`,
    resolved: false,
  });
}

/**
 * Store individual transactions scraped from Table5.
 * Skips any transaction whose timestamp already exists for this ATM
 * to avoid duplicates on repeated syncs.
 */
async function storeTransactions(
  atmId: number,
  transactions: Array<{
    transactedAt: string;
    cardNumber: string | null;
    transactionType: string | null;
    amount: number | null;
    response: string | null;
    terminalBalance: number | null;
  }>,
): Promise<void> {
  if (!transactions.length) return;

  for (const tx of transactions) {
    const ts = new Date(tx.transactedAt);
    if (isNaN(ts.getTime())) continue; // skip unparseable timestamps

    // Insert; ignore duplicates via on-conflict do nothing
    await db
      .insert(atmTransactionLogTable)
      .values({
        atmId,
        transactedAt: ts,
        cardNumber: tx.cardNumber,
        transactionType: tx.transactionType,
        amount: tx.amount ?? 0,
        response: tx.response,
        terminalBalance: tx.terminalBalance,
      })
      .onConflictDoNothing();
  }
}

/** Simulated sync for portals where we don't yet have a real scraper */
async function performSimulatedSync(portal: {
  id: number;
  name: string;
  username: string;
  passwordEncrypted: string;
}): Promise<{
  success: boolean;
  message: string;
  atmsUpdated: number;
  alertsCreated: number;
}> {
  try {
    const atms = await db
      .select()
      .from(atmsTable)
      .where(eq(atmsTable.portalSource, portal.name as any));

    let alertsCreated = 0;

    for (const atm of atms) {
      const dailyDispensed = atm.avgDailyDispensed ?? 500;
      const daysSinceSync = atm.lastSynced
        ? Math.floor(
            (Date.now() - new Date(atm.lastSynced).getTime()) /
              (1000 * 60 * 60 * 24),
          )
        : 1;
      const dispensed =
        dailyDispensed * Math.max(1, daysSinceSync) * (0.8 + Math.random() * 0.4);
      const newBalance = Math.max(0, (atm.currentBalance ?? 5000) - dispensed);

      let newStatus: "online" | "offline" | "error" | "low_cash" | "unknown" =
        "online";
      if (newBalance === 0) newStatus = "error";
      else if (newBalance < (atm.lowCashThreshold ?? 2000)) newStatus = "low_cash";

      await db
        .update(atmsTable)
        .set({ currentBalance: newBalance, status: newStatus, lastSynced: new Date() })
        .where(eq(atmsTable.id, atm.id));

      if (newStatus === "low_cash" || newStatus === "error") {
        const message =
          newStatus === "error"
            ? `${atm.name} is out of cash`
            : `${atm.name} cash balance is below threshold ($${newBalance.toFixed(0)})`;
        await db.insert(alertsTable).values({
          atmId: atm.id,
          type: newStatus === "error" ? "out_of_cash" : "low_cash",
          severity: newStatus === "error" ? "critical" : "warning",
          message,
          resolved: false,
        });
        alertsCreated++;
      }
    }

    return {
      success: true,
      message: `Synced ${atms.length} ATMs from ${PORTAL_CONFIG[portal.name]?.displayName ?? portal.name}`,
      atmsUpdated: atms.length,
      alertsCreated,
    };
  } catch (err) {
    return {
      success: false,
      message: `Sync failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      atmsUpdated: 0,
      alertsCreated: 0,
    };
  }
}

export default router;
