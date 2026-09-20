import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";

/** Recomputes the stored check state (latest real result, latest pass, current streak, ever failed) of the given candidates
 *  from their candidate_checks history. Used after history moves between rows (consolidation merges two rows into one), so
 *  the columns cannot disagree with the history they summarise (invariants I6 and I7). */
export async function recomputeCheckState(db: ReturnType<typeof getDb>, candidateIds: string[]): Promise<void> {
  if (!candidateIds.length) return;
  const ids = sql.join(candidateIds.map(id => sql`${id}::uuid`), sql`, `);
  await db.execute(sql`
    with ranked as (
      select candidate_id, status, created_at, row_number() over (partition by candidate_id order by created_at desc) as rn
      from candidate_checks where candidate_id in (${ids})
    ),
    summary as (
      select c.id as candidate_id,
        (select status from ranked r where r.candidate_id = c.id and r.rn = 1) as last_status,
        (select created_at from ranked r where r.candidate_id = c.id and r.rn = 1) as last_at,
        (select max(created_at) from ranked r where r.candidate_id = c.id and r.status = 'available') as last_pass,
        coalesce((select min(rn) - 1 from ranked r where r.candidate_id = c.id and r.status <> 'available'), (select count(*) from ranked r where r.candidate_id = c.id), 0) as streak,
        exists (select 1 from ranked r where r.candidate_id = c.id and r.status <> 'available') as failed
      from model_candidates c where c.id in (${ids})
    )
    update model_candidates m set last_check_status = s.last_status, last_checked_at = s.last_at, last_passed_at = s.last_pass,
      consecutive_passes = s.streak::int, ever_failed = s.failed, updated_at = now()
    from summary s where m.id = s.candidate_id
  `);
}
