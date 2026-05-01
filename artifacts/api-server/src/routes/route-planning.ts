import { Router } from "express";
import { db } from "@workspace/db";
import { routesTable, routeStopsTable, atmsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  PlanRouteBody,
  GetRouteParams,
  UpdateRouteParams,
  UpdateRouteBody,
} from "@workspace/api-zod";

const router = Router();

// Haversine distance in miles
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nearest neighbor TSP heuristic
function optimizeStops(
  atms: Array<{
    id: number;
    lat: number;
    lon: number;
    cashToLoad: number;
    name: string;
    locationName: string;
    address: string;
    currentBalance: number;
  }>,
): typeof atms {
  if (atms.length <= 1) return atms;
  const visited = new Set<number>();
  const result = [atms[0]];
  visited.add(0);

  while (visited.size < atms.length) {
    const last = result[result.length - 1];
    let nearest = -1;
    let minDist = Infinity;
    for (let i = 0; i < atms.length; i++) {
      if (!visited.has(i)) {
        const d = haversineDistance(last.lat, last.lon, atms[i].lat, atms[i].lon);
        if (d < minDist) {
          minDist = d;
          nearest = i;
        }
      }
    }
    if (nearest >= 0) {
      result.push(atms[nearest]);
      visited.add(nearest);
    }
  }
  return result;
}

router.get("/routes", async (req, res) => {
  const routes = await db
    .select()
    .from(routesTable)
    .orderBy(desc(routesTable.scheduledDate));

  const withCounts = await Promise.all(
    routes.map(async (route) => {
      const stops = await db
        .select()
        .from(routeStopsTable)
        .where(eq(routeStopsTable.routeId, route.id));
      return { ...route, stopCount: stops.length };
    }),
  );

  res.json(withCounts);
});

router.post("/routes", async (req, res) => {
  const body = PlanRouteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues });
    return;
  }
  const { name, scheduledDate, atmIds, daysToFill, startAddress } = body.data;

  const atms = await db
    .select()
    .from(atmsTable)
    .where(
      eq(atmsTable.id, atmIds[0]),
    );

  // Get all ATMs
  const allAtms = await db.select().from(atmsTable);
  const selectedAtms = allAtms.filter((a) => atmIds.includes(a.id));

  // Calculate cash needed for each ATM
  const stopsRaw = selectedAtms
    .filter((a) => a.latitude != null && a.longitude != null)
    .map((a) => {
      const avgDaily = a.avgDailyDispensed ?? 500;
      const totalNeeded = avgDaily * daysToFill * 1.1;
      const cashToLoad = Math.max(
        0,
        Math.min(totalNeeded - (a.currentBalance ?? 0), a.cashCapacity ?? 10000),
      );
      return {
        id: a.id,
        lat: a.latitude!,
        lon: a.longitude!,
        cashToLoad,
        name: a.name,
        locationName: a.locationName,
        address: a.address + ", " + a.city + ", " + a.state,
        currentBalance: a.currentBalance ?? 0,
      };
    });

  // ATMs without coords go at end
  const noCoords = selectedAtms
    .filter((a) => a.latitude == null || a.longitude == null)
    .map((a) => {
      const avgDaily = a.avgDailyDispensed ?? 500;
      const cashToLoad = Math.max(
        0,
        Math.min(
          avgDaily * daysToFill * 1.1 - (a.currentBalance ?? 0),
          a.cashCapacity ?? 10000,
        ),
      );
      return {
        id: a.id,
        lat: 0,
        lon: 0,
        cashToLoad,
        name: a.name,
        locationName: a.locationName,
        address: a.address + ", " + a.city + ", " + a.state,
        currentBalance: a.currentBalance ?? 0,
      };
    });

  const optimized = [...optimizeStops(stopsRaw), ...noCoords];

  // Estimate distance
  let totalDist = 0;
  for (let i = 1; i < optimized.length; i++) {
    if (optimized[i - 1].lat && optimized[i].lat) {
      totalDist += haversineDistance(
        optimized[i - 1].lat,
        optimized[i - 1].lon,
        optimized[i].lat,
        optimized[i].lon,
      );
    }
  }

  const totalCashNeeded = optimized.reduce((s, a) => s + a.cashToLoad, 0);
  const estimatedDuration = Math.round(optimized.length * 20 + totalDist * 1.5);

  const [route] = await db
    .insert(routesTable)
    .values({
      name,
      scheduledDate,
      status: "planned",
      totalCashNeeded,
      estimatedDistanceMiles: Math.round(totalDist),
      estimatedDurationMinutes: estimatedDuration,
      startAddress: startAddress ?? null,
    })
    .returning();

  // Insert stops
  for (let i = 0; i < optimized.length; i++) {
    const stop = optimized[i];
    await db.insert(routeStopsTable).values({
      routeId: route.id,
      stopOrder: i + 1,
      atmId: stop.id,
      cashToLoad: stop.cashToLoad,
      status: "pending",
    });
  }

  res.status(201).json({ ...route, stopCount: optimized.length });
});

router.get("/routes/:id", async (req, res) => {
  const params = GetRouteParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [route] = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.id, params.data.id));
  if (!route) {
    res.status(404).json({ error: "Route not found" });
    return;
  }

  const stops = await db
    .select({
      id: routeStopsTable.id,
      routeId: routeStopsTable.routeId,
      stopOrder: routeStopsTable.stopOrder,
      atmId: routeStopsTable.atmId,
      atmName: atmsTable.name,
      locationName: atmsTable.locationName,
      address: atmsTable.address,
      cashToLoad: routeStopsTable.cashToLoad,
      currentBalance: atmsTable.currentBalance,
      status: routeStopsTable.status,
    })
    .from(routeStopsTable)
    .leftJoin(atmsTable, eq(routeStopsTable.atmId, atmsTable.id))
    .where(eq(routeStopsTable.routeId, route.id))
    .orderBy(routeStopsTable.stopOrder);

  res.json({ ...route, stopCount: stops.length, stops });
});

router.put("/routes/:id", async (req, res) => {
  const params = UpdateRouteParams.safeParse({ id: Number(req.params.id) });
  const body = UpdateRouteBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const updateData: Record<string, any> = {};
  if (body.success && body.data.status) {
    updateData.status = body.data.status;
    if (body.data.status === "completed") updateData.completedAt = new Date();
  }
  const [updated] = await db
    .update(routesTable)
    .set(updateData)
    .where(eq(routesTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Route not found" });
    return;
  }
  const stops = await db
    .select()
    .from(routeStopsTable)
    .where(eq(routeStopsTable.routeId, updated.id));
  res.json({ ...updated, stopCount: stops.length });
});

export default router;
