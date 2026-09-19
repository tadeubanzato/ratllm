import { and, eq, isNotNull } from "drizzle-orm";
import { laneAssignments, modelDeployments } from "@/server/db/schema";

/**
 * A lane member that is really serving traffic: not excluded, and its deployment is ACTIVE with a router ID.
 *
 * Every question about a lane's size — is there room to add a model, how many members does it have, how many are healthy —
 * has to use this one definition. They used to count every non-excluded assignment, including assignments left behind by
 * deployments that had since been removed or blocked. Those "ghosts" were invisible in the router but still counted, so
 * lanes looked full (smart-coding counted 16 members against a cap of 12 while only 8 were live) and automatic promotion
 * was deferred with "all recommended lanes are at capacity" while real capacity went unused.
 *
 * The query must join `model_deployments` on `lane_assignments.deployment_id`.
 */
export const liveLaneMember = and(
  eq(laneAssignments.excluded, false),
  eq(modelDeployments.lifecycle, "ACTIVE"),
  isNotNull(modelDeployments.litellmDeploymentId),
);
