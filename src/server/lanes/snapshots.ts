import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { laneStatusSnapshots } from "@/server/db/schema";
import { getLanes } from "@/server/queries";
import { historyTimestamp } from "@/lib/utils";

/** Records the current computed status of every lane. Called once per health-monitor tick so lane bars reflect real recurring checks. */
export async function recordLaneSnapshots() {
  const lanes = await getLanes();
  const db = getDb();
  if (!lanes.length) return;
  await db.insert(laneStatusSnapshots).values(lanes.map(lane => ({laneId: lane.id, status: lane.status, healthy: lane.healthy, total: lane.total})));
}

export interface LaneSnapshotPoint { at: Date; status: string; healthy: number; total: number }

/** Recent per-lane status history for uptime strips. Ranked per lane in SQL rather than by slicing the newest N rows
 *  table-wide: a global cap makes each lane's visible history depend on how many *other* lanes are being snapshotted,
 *  so adding lanes silently shortens everyone's bars. See getCandidateCheckHistory for the same bug caught in the wild. */
export async function getLaneSnapshotHistory(perLane = 30): Promise<Map<string, LaneSnapshotPoint[]>> {
  const rows = await getDb().execute(sql`
    with ranked as (
      select lane_id, created_at, status, healthy, total,
        row_number() over (partition by lane_id order by created_at desc) as rn
      from lane_status_snapshots
    )
    select lane_id as "laneId", created_at as "at", status, healthy, total
    from ranked where rn <= ${perLane} order by lane_id, created_at desc
  `) as unknown as Array<Omit<LaneSnapshotPoint,"at"> & { at: Date | string; laneId: string }>;
  const byLane = new Map<string, LaneSnapshotPoint[]>();
  for (const { laneId, ...point } of rows) {
    const list = byLane.get(laneId) ?? [];
    list.push({...point, at: historyTimestamp(point.at)});
    byLane.set(laneId, list);
  }
  return byLane;
}
