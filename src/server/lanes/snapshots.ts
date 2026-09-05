import "server-only";
import { desc } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { laneStatusSnapshots } from "@/server/db/schema";
import { getLanes } from "@/server/queries";

/** Records the current computed status of every lane. Called once per health-monitor tick so lane bars reflect real recurring checks. */
export async function recordLaneSnapshots() {
  const lanes = await getLanes();
  const db = getDb();
  if (!lanes.length) return;
  await db.insert(laneStatusSnapshots).values(lanes.map(lane => ({laneId: lane.id, status: lane.status, healthy: lane.healthy, total: lane.total})));
}

export interface LaneSnapshotPoint { at: Date; status: string; healthy: number; total: number }

/** Recent per-lane status history for uptime strips. One query, grouped in memory to avoid N+1 per lane. */
export async function getLaneSnapshotHistory(perLane = 30, rawLimit = 2000): Promise<Map<string, LaneSnapshotPoint[]>> {
  const rows = await getDb().select().from(laneStatusSnapshots).orderBy(desc(laneStatusSnapshots.createdAt)).limit(rawLimit);
  const byLane = new Map<string, LaneSnapshotPoint[]>();
  for (const row of rows) {
    const list = byLane.get(row.laneId) ?? [];
    if (list.length < perLane) list.push({at: row.createdAt, status: row.status, healthy: row.healthy, total: row.total});
    byLane.set(row.laneId, list);
  }
  return byLane;
}
