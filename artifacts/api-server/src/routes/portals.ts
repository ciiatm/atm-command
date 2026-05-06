import { Router } from "express";
import { db } from "@workspace/db";
import {
  portalsTable,
  portalSyncHistoryTable,
  atmsTable,
  alertsTable,
} from "@workspace/db";
import { eq, count, desc } from "drizzle-orm";
import {
  CreatePortalBody,
  UpdatePortalParams,
  UpdatePortalBody,
  DeletePortalParams,
  SyncPortalParams,
} from "@workspace/api-zod";

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

// Simulate sync - in production this would use Puppeteer to scrape the portal
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

  const result = await performPortalSync(portal);

  // Update portal sync status
  await db
    .update(portalsTable)
    .set({
      lastSynced: new Date(),
      lastSyncStatus: result.success ? "success" : "failed",
    })
    .where(eq(portalsTable.id, portal.id));

  // Log sync history
  await db.insert(portalSyncHistoryTable).values({
    portalId: portal.id,
    success: result.success,
    message: result.message,
    atmsUpdated: result.atmsUpdated,
  });

  res.json({
    portalId: portal.id,
    portalName: PORTAL_CONFIG[portal.name]?.displayName ?? portal.name,
    success: result.success,
    message: result.message,
    atmsUpdated: result.atmsUpdated,
    alertsCreated: result.alertsCreated,
    syncedAt: new Date().toISOString(),
  });
});

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
  try {
    // Get ATMs linked to this portal
    const atms = await db
      .select()
      .from(atmsTable)
      .where(eq(atmsTable.portalSource, portal.name as any));

    let alertsCreated = 0;

    // Simulate updating balances with realistic fluctuation
    for (const atm of atms) {
      const dailyDispensed = atm.avgDailyDispensed ?? 500;
      const daysSinceSync = atm.lastSynced
        ? Math.floor(
            (Date.now() - new Date(atm.lastSynced).getTime()) /
              (1000 * 60 * 60 * 24),
          )
        : 1;
      const dispensed = dailyDispensed * Math.max(1, daysSinceSync) * (0.8 + Math.random() * 0.4);
      const newBalance = Math.max(0, (atm.currentBalance ?? 5000) - dispensed);

      let newStatus: "online" | "offline" | "error" | "low_cash" | "unknown" =
        "online";
      if (newBalance === 0) newStatus = "error";
      else if (newBalance < (atm.lowCashThreshold ?? 2000)) newStatus = "low_cash";

      await db
        .update(atmsTable)
        .set({
          currentBalance: newBalance,
          status: newStatus,
          lastSynced: new Date(),
        })
        .where(eq(atmsTable.id, atm.id));

      // Create alert if needed
      if (newStatus === "low_cash" || newStatus === "error") {
        const severity = newStatus === "error" ? "critical" : "warning";
        const type = newStatus === "error" ? "out_of_cash" : "low_cash";
        const message =
          newStatus === "error"
            ? `${atm.name} is out of cash`
            : `${atm.name} cash balance is below threshold ($${newBalance.toFixed(0)})`;

        await db.insert(alertsTable).values({
          atmId: atm.id,
          type,
          severity,
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
