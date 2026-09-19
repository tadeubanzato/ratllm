import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, laneAssignments, lanes, modelDeployments, providers, smokeTests } from "@/server/db/schema";
import { computeFailureStreak } from "@/server/health/failure-streak";
import { connectionSummary } from "@/server/settings/connections";

/** Everything the deployment detail page shows beyond the summary row: exact identity, the alias pool this deployment
 *  belongs to, its lane memberships, recent probes and audit trail. Every query is scoped to one deployment (or its alias),
 *  so cost doesn't grow with the size of the inventory. */
export async function getDeploymentDetail(id: string) {
  const db = getDb();
  const self = (await db.select({
    id: modelDeployments.id, litellmDeploymentId: modelDeployments.litellmDeploymentId, litellmModelName: modelDeployments.litellmModelName,
    lifecycle: modelDeployments.lifecycle, rawMetadata: modelDeployments.rawMetadata, apiBase: modelDeployments.apiBase,
    updatedAt: modelDeployments.updatedAt,
  }).from(modelDeployments).where(eq(modelDeployments.id, id)).limit(1))[0];
  if (!self) return null;

  const [siblings, laneRows, probes, audit, connection] = await Promise.all([
    // Other members of the same alias pool. An alias is shared by every member, which is exactly why the LiteLLM ID — not
    // the alias — is what identifies one.
    db.select({
      id: modelDeployments.id, litellmDeploymentId: modelDeployments.litellmDeploymentId, providerModelId: modelDeployments.providerModelId,
      lifecycle: modelDeployments.lifecycle, health: modelDeployments.health, managed: modelDeployments.managed, providerName: providers.name,
    }).from(modelDeployments).innerJoin(providers, eq(modelDeployments.providerId, providers.id))
      .where(and(eq(modelDeployments.litellmModelName, self.litellmModelName), ne(modelDeployments.id, id)))
      .orderBy(modelDeployments.lifecycle, providers.name).limit(50),
    db.select({ slug: lanes.slug, name: lanes.name, priority: laneAssignments.priority, excluded: laneAssignments.excluded, pinned: laneAssignments.pinned })
      .from(laneAssignments).innerJoin(lanes, eq(laneAssignments.laneId, lanes.id)).where(eq(laneAssignments.deploymentId, id)).orderBy(lanes.slug),
    db.select({
      at: smokeTests.createdAt, status: smokeTests.status, httpStatus: smokeTests.httpStatus, latencyMs: smokeTests.latencyMs,
      firstTokenMs: smokeTests.firstTokenMs, errorCode: smokeTests.errorCode, error: smokeTests.error,
    }).from(smokeTests).where(eq(smokeTests.deploymentId, id)).orderBy(desc(smokeTests.createdAt)).limit(25),
    db.select({ at: auditEvents.createdAt, actor: auditEvents.actor, action: auditEvents.action, correlationId: auditEvents.correlationId })
      .from(auditEvents).where(and(eq(auditEvents.entityType, "model_deployment"), eq(auditEvents.entityId, id))).orderBy(desc(auditEvents.createdAt)).limit(15),
    connectionSummary("litellm").catch(() => null),
  ]);

  const metadata = self.rawMetadata ?? {};
  const info = metadata.model_info && typeof metadata.model_info === "object" ? metadata.model_info as Record<string, unknown> : {};
  return {
    instanceBaseUrl: connection?.baseUrl ?? null,
    blocked: info.blocked === true,
    removedReason: typeof metadata.removedReason === "string" ? metadata.removedReason : null,
    rawMetadata: metadata,
    siblings,
    lanes: laneRows,
    probes,
    audit,
    failureStreak: computeFailureStreak(probes.map(probe => ({ status: probe.status, errorCode: probe.errorCode }))),
  };
}

export type DeploymentDetail = NonNullable<Awaited<ReturnType<typeof getDeploymentDetail>>>;
