/**
 * Background portal sync scheduler.
 *
 * Checks every hour whether any active portal is overdue for a sync
 * (based on its syncIntervalHours setting) and triggers it automatically.
 */

import { db } from "@workspace/db";
import { portalsTable, portalSyncHistoryTable, atmsTable, alertsTable, atmTransactionLogTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { scrapeColumbusData } from "./scrapers/columbus-data.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

async function syncPortal(portal: {
  id: number;
  name: string;
  username: string;
  passwordEncrypted: string;
}) {
  const startedAt = Date.now();
  logger.info({ portalId: portal.id, portalName: portal.name }, "Auto-sync: starting");

  let success = false;
  let message = "";
  let atmsUpdated = 0;
  let alertsCreated = 0;

  try {
    if (portal.name === "columbus_data") {
      // Real scraper
      const terminalStatuses = await scrapeColumbusData(
        portal.username,
        portal.passwordEncrypted,
      );

      for (const ts of terminalStatuses) {
        const [atm] = await db
          .select()
          .from(atmsTable)
          .where(eq(atmsTable.portalAtmId, ts.terminalId));

        const rawBalance = ts.currentBalance ?? (atm?.currentBalance ?? 0);
        const newBalance = Math.min(rawBalance, 40_000);
        let newStatus: "online" | "offline" | "error" | "low_cash" | "unknown" = "unknown";
        if (!ts.isOnline) newStatus = "offline";
        else if (newBalance === 0) newStatus = "error";
        else if (newBalance < (atm?.lowCashThreshold ?? 2000)) newStatus = "low_cash";
        else newStatus = "online";

        let atmId: number | null = atm?.id ?? null;

        if (atm) {
          await db
            .update(atmsTable)
            .set({
              currentBalance: newBalance,
              status: newStatus,
              lastSynced: new Date(),
              ...(ts.dailyCashDispensed != null ? { avgDailyDispensed: ts.dailyCashDispensed } : {}),
              ...(ts.dailyTransactionCount != null ? { avgDailyTransactions: ts.dailyTransactionCount } : {}),
              ...(ts.surcharge != null ? { surcharge: ts.surcharge } : {}),
              ...(ts.makeModel ? { makeModel: ts.makeModel } : {}),
              ...(ts.locationName ? { locationName: ts.locationName } : {}),
              ...(ts.address ? { address: ts.address } : {}),
              ...(ts.city ? { city: ts.city } : {}),
              ...(ts.state ? { state: ts.state } : {}),
            } as any)
            .where(eq(atmsTable.id, atm.id));
        } else {
          // Auto-create
          const [created] = await db.insert(atmsTable).values({
            name: ts.locationName || ts.terminalLabel || ts.terminalId,
            locationName: ts.locationName || ts.terminalLabel || ts.terminalId,
            address: ts.address || "Unknown",
            city: ts.city || "Unknown",
            state: ts.state || "Unknown",
            portalSource: "columbus_data",
            portalAtmId: ts.terminalId,
            currentBalance: newBalance,
            status: newStatus,
            lastSynced: new Date(),
            ...(ts.makeModel ? { makeModel: ts.makeModel } : {}),
            ...(ts.surcharge != null ? { surcharge: ts.surcharge } : {}),
          } as any).returning();
          atmId = created?.id ?? null;
        }

        if (newStatus === "low_cash" || newStatus === "error") {
          const atmName = atm?.name ?? ts.terminalLabel;
          await db.insert(alertsTable).values({
            atmId: atm?.id ?? 0,
            type: newStatus === "error" ? "out_of_cash" : "low_cash",
            severity: newStatus === "error" ? "critical" : "warning",
            message:
              newStatus === "error"
                ? `${atmName} is out of cash`
                : `${atmName} cash balance is low ($${newBalance.toFixed(0)})`,
            resolved: false,
          });
          alertsCreated++;
        }

        // Store individual transactions from Table5
        if (atmId && ts.transactions.length > 0) {
          for (const tx of ts.transactions) {
            const txTs = new Date(tx.transactedAt);
            if (isNaN(txTs.getTime())) continue;
            await db
              .insert(atmTransactionLogTable)
              .values({
                atmId,
                transactedAt: txTs,
                cardNumber: tx.cardNumber,
                transactionType: tx.transactionType,
                amount: tx.amount ?? 0,
                response: tx.response,
                terminalBalance: tx.terminalBalance,
              })
              .onConflictDoNothing();
          }
        }

        atmsUpdated++;
      }

      success = true;
      message = `Auto-synced ${atmsUpdated} ATMs from Columbus Data`;
    } else {
      // Simulated sync for other portals
      const atms = await db
        .select()
        .from(atmsTable)
        .where(eq(atmsTable.portalSource, portal.name as any));

      for (const atm of atms) {
        const dailyDispensed = atm.avgDailyDispensed ?? 500;
        const daysSinceSync = atm.lastSynced
          ? Math.max(1, Math.floor((Date.now() - new Date(atm.lastSynced).getTime()) / 86_400_000))
          : 1;
        const dispensed = dailyDispensed * daysSinceSync * (0.8 + Math.random() * 0.4);
        const newBalance = Math.max(0, (atm.currentBalance ?? 5000) - dispensed);

        let newStatus: "online" | "offline" | "error" | "low_cash" | "unknown" = "online";
        if (newBalance === 0) newStatus = "error";
        else if (newBalance < (atm.lowCashThreshold ?? 2000)) newStatus = "low_cash";

        await db
          .update(atmsTable)
          .set({ currentBalance: newBalance, status: newStatus, lastSynced: new Date() })
          .where(eq(atmsTable.id, atm.id));

        if (newStatus === "low_cash" || newStatus === "error") {
          await db.insert(alertsTable).values({
            atmId: atm.id,
            type: newStatus === "error" ? "out_of_cash" : "low_cash",
            severity: newStatus === "error" ? "critical" : "warning",
            message:
              newStatus === "error"
                ? `${atm.name} is out of cash`
                : `${atm.name} cash balance is low ($${newBalance.toFixed(0)})`,
            resolved: false,
          });
          alertsCreated++;
        }
      }

      success = true;
      atmsUpdated = atms.length;
      message = `Auto-synced ${atms.length} ATMs`;
    }
  } catch (err) {
    message = `Auto-sync failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ portalId: portal.id, err }, "Auto-sync error");
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

  await db
    .update(portalsTable)
    .set({ lastSynced: new Date(), lastSyncStatus: success ? "success" : "failed" })
    .where(eq(portalsTable.id, portal.id));

  await db.insert(portalSyncHistoryTable).values({
    portalId: portal.id,
    success,
    message,
    atmsUpdated,
    durationSeconds,
  });

  logger.info({ portalId: portal.id, success, atmsUpdated, alertsCreated, durationSeconds }, "Auto-sync: complete");
}

// ---------------------------------------------------------------------------
// Scheduler loop
// ---------------------------------------------------------------------------

async function runCheck() {
  try {
    const portals = await db
      .select()
      .from(portalsTable)
      .where(eq(portalsTable.isActive, true));

    const now = Date.now();

    for (const portal of portals) {
      const intervalMs = portal.syncIntervalHours * 60 * 60 * 1000;
      const lastSyncedMs = portal.lastSynced ? new Date(portal.lastSynced).getTime() : 0;
      const nextSyncMs = lastSyncedMs + intervalMs;

      if (now >= nextSyncMs) {
        // Fire and forget — don't block the scheduler loop
        syncPortal(portal).catch((err) =>
          logger.error({ portalId: portal.id, err }, "Unhandled sync error")
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "Sync scheduler check failed");
  }
}

export function startSyncScheduler() {
  logger.info("Portal sync scheduler started (checks every hour)");
  // Run an initial check shortly after boot
  setTimeout(runCheck, 30_000);
  // Then check on the regular interval
  setInterval(runCheck, CHECK_INTERVAL_MS);
}
