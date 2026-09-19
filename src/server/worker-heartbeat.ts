import "server-only";
import { and, count, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { automationJobs, leases } from "@/server/db/schema";

const HEARTBEAT_KEY = "worker:heartbeat";
/** A worker that hasn't beaten for this long is treated as down. The beat interval is well under it. */
export const HEARTBEAT_STALE_MS = 60_000;
/** An enabled job this far past its due time while the worker looks alive means the scheduler is not keeping up. */
export const OVERDUE_GRACE_MS = 5 * 60_000;

/** Records that the worker process is alive. Runs on its own timer, not inside the scheduler tick: a tick awaits every
 *  due job, so a multi-minute benchmark would otherwise look exactly like a dead worker. Reuses the `leases` table
 *  (key/owner/expires_at) so no schema change is needed; MAINTENANCE prunes expired rows, so a long-dead worker's row
 *  disappears and reads as "absent" rather than as a stale-but-present beat. */
export async function writeWorkerHeartbeat(owner: string) {
  const expires = new Date(Date.now() + 10 * 60_000);
  await getDb().execute(sql`insert into leases ("key", "owner", "expires_at") values (${HEARTBEAT_KEY}, ${owner}, ${expires.toISOString()}::timestamptz) on conflict ("key") do update set "owner" = excluded."owner", "expires_at" = excluded."expires_at", "updated_at" = now()`);
}

export type WorkerStatus = "alive" | "stale" | "absent";

/** Pure classification so it can be unit-tested without a database. */
export function classifyHeartbeat(lastBeat: Date | null, now = Date.now()): { status: WorkerStatus; ageMs: number | null } {
  if (!lastBeat) return { status: "absent", ageMs: null };
  const ageMs = Math.max(0, now - lastBeat.getTime());
  return { status: ageMs <= HEARTBEAT_STALE_MS ? "alive" : "stale", ageMs };
}

export async function readWorkerHealth() {
  const db = getDb();
  const row = (await db.select({ updatedAt: leases.updatedAt, owner: leases.owner }).from(leases).where(eq(leases.key, HEARTBEAT_KEY)).limit(1))[0];
  const beat = classifyHeartbeat(row?.updatedAt ?? null);
  const [overdue] = await db.select({ n: count() }).from(automationJobs)
    .where(and(eq(automationJobs.enabled, true), lt(automationJobs.nextRunAt, new Date(Date.now() - OVERDUE_GRACE_MS))));
  return { ...beat, overdueJobs: overdue?.n ?? 0 };
}
