import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { laneAssignments, lanes, modelDeployments } from "@/server/db/schema";
import { LANE_RULES } from "./rules";
import type { LaneId } from "@/lib/constants";

/** The deployment columns the lane flows need, for one provider. */
export function getDeploymentsForProvider(providerId: string) {
  return getDb().select({
    id: modelDeployments.id,
    providerId: modelDeployments.providerId,
    providerModelId: modelDeployments.providerModelId,
    litellmModelName: modelDeployments.litellmModelName,
    litellmDeploymentId: modelDeployments.litellmDeploymentId,
    health: modelDeployments.health,
    rawMetadata: modelDeployments.rawMetadata,
  }).from(modelDeployments).where(eq(modelDeployments.providerId, providerId));
}

/** Current non-excluded member count for one lane, against its `LANE_RULES.maxDeployments` soft cap. Mirrors the
 *  bulk per-lane count the "Add to LiteLLM" picker (`/api/candidates/[id]/lanes`) already shows as "lane full" —
 *  this is the gate `promoteCandidate` gained to actually enforce that cap on auto-selected lanes, since the
 *  picker's own `full` flag only ever disabled a checkbox and never stopped an unattended promotion. */
export async function laneHasCapacity(slug: LaneId): Promise<boolean> {
  const [row] = await getDb().select({ total: sql<number>`count(*)` }).from(laneAssignments)
    .innerJoin(lanes, eq(laneAssignments.laneId, lanes.id))
    .where(and(eq(lanes.slug, slug), eq(laneAssignments.excluded, false))).groupBy(lanes.slug);
  return Number(row?.total ?? 0) < LANE_RULES[slug].maxDeployments;
}
