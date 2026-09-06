import "server-only";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { LaneId } from "@/lib/constants";
import { getDb } from "@/server/db/client";
import { laneAssignments, lanes, modelDeployments, syncRuns } from "@/server/db/schema";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { syncFallbackConfig } from "./fallbacks";
import { promoteCandidate, PromotionBlocked } from "./promote";

function candidateIdOf(rawMetadata: Record<string, unknown>): string | null {
  const value = rawMetadata?.source_candidate_id ?? (rawMetadata?.model_info as Record<string, unknown> | undefined)?.source_candidate_id;
  return typeof value === "string" ? value : null;
}

/**
 * Converges LiteLLM to ratllm's desired lane membership and fallback config. Safe to run on a schedule:
 * it re-adds any lane member whose router deployment went missing (retrying past transient failures) and
 * re-pushes the fallback chains. It never removes anything a user pinned.
 */
export async function reconcileLaneMembership() {
  const db = getDb();
  const correlationId = randomUUID();
  const [run] = await db.insert(syncRuns).values({ type: "LANE_RECONCILE", status: "RUNNING", correlationId, startedAt: new Date() }).returning();

  const repaired: { candidateId: string; lanes: LaneId[] }[] = [];
  const failures: { candidateId: string; lane: LaneId; error: string }[] = [];
  const orphans: string[] = [];

  try {
    const rows = await db.select({
      laneSlug: lanes.slug,
      excluded: laneAssignments.excluded,
      health: modelDeployments.health,
      litellmDeploymentId: modelDeployments.litellmDeploymentId,
      rawMetadata: modelDeployments.rawMetadata,
    }).from(laneAssignments)
      .innerJoin(lanes, eq(laneAssignments.laneId, lanes.id))
      .innerJoin(modelDeployments, eq(laneAssignments.deploymentId, modelDeployments.id));

    const broken = new Map<string, Set<LaneId>>();
    for (const row of rows) {
      if (row.excluded) continue;
      if (row.health !== "UNAVAILABLE" && row.litellmDeploymentId) continue;
      const candidateId = candidateIdOf(row.rawMetadata);
      if (!candidateId) { orphans.push(row.laneSlug); continue; }
      const set = broken.get(candidateId) ?? new Set<LaneId>();
      set.add(row.laneSlug as LaneId);
      broken.set(candidateId, set);
    }

    for (const [candidateId, laneSet] of broken) {
      const laneList = [...laneSet];
      try {
        const result = await promoteCandidate(candidateId, { lanes: laneList, skipFallbackSync: true });
        repaired.push({ candidateId, lanes: laneList });
        for (const target of result.targets) if (target.status === "failed" && target.lane) failures.push({ candidateId, lane: target.lane, error: target.error ?? "unknown" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "reconcile failed";
        for (const lane of laneList) failures.push({ candidateId, lane, error: message });
        if (!(error instanceof PromotionBlocked)) throw error;
      }
    }

    const fallback = await syncFallbackConfig(new HttpLiteLLMAdapter());

    const summary = { repaired, failures, orphans, fallback };
    const ok = failures.length === 0 && fallback.ok;
    await db.update(syncRuns).set({ status: ok ? "SUCCEEDED" : "FAILED", finishedAt: new Date(), summary, error: ok ? null : "Some lane members could not be reconciled", updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lane reconcile failed";
    await db.update(syncRuns).set({ status: "FAILED", finishedAt: new Date(), error: message, updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    throw error;
  }
}
