import { Router } from "express";
import { db } from "@workspace/db";
import {
  portalsTable,
  portalSyncHistoryTable,
  atmsTable,
  alertsTable,
  atmTransactionLogTable,
} from "@workspace/db";
import { eq, count, desc, isNotNull } from "drizzle-orm";
import {
  CreatePortalBody,
  UpdatePortalParams,
  UpdatePortalBody,
  DeletePortalParams,
  SyncPortalParams,
} from "@workspace/api-zod";
import { scrapeColumbusData } from "../lib/scrapers/columbus-data.js";
import { scrapeColumbusTransactions } from "../lib/scrapers/columbus-data-transactions.js";

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

router.post("/portals/:id/sync-transactions", async (req, res) => {
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

  res.json({ background: true, message: "Transaction sync started" });

  runTransactionSyncInBackground(portal);
});

// Debug endpoint: scrape a single terminal and return raw results
// POST /portals/:id/debug-tx { terminalId: "L443079" }
router.post("/portals/:id/debug-tx", async (req, res) => {
  const params = SyncPortalParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const terminalId = req.body?.terminalId as string | undefined;
  if (!terminalId) { res.status(400).json({ error: "terminalId required in body" }); return; }

  const [portal] = await db.select().from(portalsTable).where(eq(portalsTable.id, params.data.id));
  if (!portal) { res.status(404).json({ error: "Portal not found" }); return; }

  try {
    const txMap = await scrapeColumbusTransactions(portal.username, portal.passwordEncrypted, [terminalId]);
    const records = txMap.get(terminalId) ?? [];
    res.json({ terminalId, count: records.length, sample: records.slice(0, 5), allRecords: records });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

async function runSyncInBackground(portal: {
  id: number; name: string; username: string; passwordEncrypted: string; syncIntervalHours: number;
}) {
  const startedAt = Date.now();
  let result: { success: boolean; message: string; atmsUpdated: number; alertsCreated: number };
  try {
    result = await performPortalSync(portal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { success: false, message, atmsUpdated: 0, alertsCreated: 0 };
  }
  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

  await db
    .update(portalsTable)
    .set({ lastSynced: new Date(), lastSyncStatus: result.success ? "success" : "failed" })
    .where(eq(portalsTable.id, portal.id));

  await db.insert(portalSyncHistoryTable).values({
    portalId: portal.id,
    success: result.success,
    message: result.message,
    atmsUpdated: result.atmsUpdated,
    durationSeconds,
  });
}

async function runTransactionSyncInBackground(portal: {
  id: number; name: string; username: string; passwordEncrypted: string;
}) {
  const startedAt = Date.now();
  let success = false;
  let message = "";
  let atmsUpdated = 0;

  try {
    // Get all ATMs for this portal that have a portalAtmId
    const atms = await db
      .select()
      .from(atmsTable)
      .where(
        eq(atmsTable.portalSource, portal.name as any),
      );

    const eligibleAtms = atms.filter(a => isNotNull(a.portalAtmId) && a.portalAtmId != null);
    const terminalIds = eligibleAtms.map(a => a.portalAtmId!);

    if (terminalIds.length === 0) {
      message = "No terminals with portal IDs found";
      success = true;
    } else {
      const txMap = await scrapeColumbusTransactions(
        portal.username,
        portal.passwordEncrypted,
        terminalIds,
      );

      for (const [termId, records] of txMap) {
        if (records.length === 0) continue;

        const atm = eligibleAtms.find(a => a.portalAtmId === termId);
        if (!atm) continue;

        for (const tx of records) {
          const ts = new Date(tx.transactedAt);
          if (isNaN(ts.getTime())) continue;

          await db
            .insert(atmTransactionLogTable)
            .values({
              atmId: atm.id,
              transactedAt: ts,
              cardNumber: tx.cardNumber,
              transactionType: tx.transactionType,
              amount: tx.amountDispensed ?? 0,
              response: tx.response,
              terminalBalance: null,
              amountRequested: tx.amountRequested,
              feeRequested: tx.feeRequested,
              amountDispensed: tx.amountDispensed,
              feeAmount: tx.feeAmount,
              termSeq: tx.termSeq,
            } as any)
            .onConflictDoNothing();
        }

        atmsUpdated++;
      }

      success = true;
      message = `Transaction sync complete: ${atmsUpdated} terminals updated`;
    }
  } catch (err) {
    message = `Transaction sync failed: ${err instanceof Error ? err.message : String(err)}`;
    success = false;
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

  await db.insert(portalSyncHistoryTable).values({
    portalId: portal.id,
    success,
    message,
    atmsUpdated,
    durationSeconds,
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
      durationSeconds: portalSyncHistoryTable.durationSeconds,
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
            ...(ts.postalCode ? { postalCode: ts.postalCode } : {}),
            ...(ts.propertyType ? { propertyType: ts.propertyType } : {}),
          } as any)
          .returning();

        if (newAtm && balance < (newAtm.lowCashThreshold ?? 2000)) {
          await createBalanceAlert(newAtm.id, newAtm.name, balance, newAtm.lowCashThreshold ?? 2000);
          alertsCreated++;
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
        ...(ts.makeModel ? { makeModel: ts.makeModel } : {}),
        ...(ts.surcharge != null ? { surcharge: ts.surcharge } : {}),
        // Patch address/name only if the report gave us real data
        ...(ts.locationName ? { locationName: ts.locationName } : {}),
        ...(ts.address ? { address: ts.address } : {}),
        ...(ts.city ? { city: ts.city } : {}),
        ...(ts.state ? { state: ts.state } : {}),
        ...(ts.postalCode ? { postalCode: ts.postalCode } : {}),
        ...(ts.propertyType ? { propertyType: ts.propertyType } : {}),
      };

      await db
        .update(atmsTable)
        .set(updateSet)
        .where(eq(atmsTable.id, atm.id));

      if (newStatus === "low_cash" || newStatus === "error") {
        await createBalanceAlert(atm.id, atm.name, newBalance, atm.lowCashThreshold ?? 2000);
        alertsCreated++;
      }

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
