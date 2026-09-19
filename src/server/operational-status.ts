import "server-only";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments, providerCredentialReferences, providers, syncRuns } from "@/server/db/schema";
import { connectionSummary } from "@/server/settings/connections";
import { readWorkerHealth } from "@/server/worker-heartbeat";
import { evaluateStatus, FRESHNESS_LIMITS_MS, type StatusInput } from "./operational-status-rules";
import { deploymentProblems, deploymentSummary, describeDeployment } from "./deployment-info";
import { getDeploymentIdentity } from "./deployment-identity";

export { evaluateStatus } from "./operational-status-rules";

const RUN_TYPES = Object.keys(FRESHNESS_LIMITS_MS);

/**
 * Gathers the facts an operator needs to know whether the system is doing its job — not just whether the web process is up.
 * `/api/health` answers "is the process alive?" (and is what the container healthcheck uses, so it must stay cheap and never
 * depend on an external provider). This answers "is RatLLM actually working?".
 */
export async function getOperationalStatus(now = Date.now()) {
  const db = getDb();
  const [worker, connection, lastSuccess, failed, credentials, fleet, identity] = await Promise.all([
    readWorkerHealth().catch(() => null),
    connectionSummary("litellm").catch(() => null),
    db.select({ type: syncRuns.type, at: sql<Date | string | null>`max(${syncRuns.finishedAt})` }).from(syncRuns)
      .where(and(eq(syncRuns.status, "SUCCEEDED"), inArray(syncRuns.type, RUN_TYPES))).groupBy(syncRuns.type),
    db.select({ type: syncRuns.type, n: count() }).from(syncRuns)
      .where(and(eq(syncRuns.status, "FAILED"), sql`${syncRuns.createdAt} > now() - interval '24 hours'`)).groupBy(syncRuns.type),
    db.select({
      invalid: sql<number>`(count(*) filter (where ${providerCredentialReferences.valid} = false))::int`,
      unverified: sql<number>`(count(*) filter (where ${providerCredentialReferences.valid} is null and ${providerCredentialReferences.encryptedValue} is not null))::int`,
    }).from(providerCredentialReferences).innerJoin(providers, eq(providerCredentialReferences.providerId, providers.id))
      .where(and(eq(providers.enabled, true), eq(providerCredentialReferences.disabled, false))),
    db.select({
      live: sql<number>`count(*)::int`,
      notServing: sql<number>`(count(*) filter (where ${modelDeployments.health} in ('UNAVAILABLE', 'AUTH_ERROR')))::int`,
      unmanagedNotServing: sql<number>`(count(*) filter (where not ${modelDeployments.managed} and ${modelDeployments.health} in ('UNAVAILABLE', 'AUTH_ERROR')))::int`,
    }).from(modelDeployments).where(and(eq(modelDeployments.lifecycle, "ACTIVE"), isNotNull(modelDeployments.litellmDeploymentId))),
    getDeploymentIdentity().catch(() => null),
  ]);
  const deployment = describeDeployment(process.env);

  const input: StatusInput = {
    now,
    worker: worker ? { status: worker.status, heartbeatAgeMs: worker.ageMs, overdueJobs: worker.overdueJobs } : null,
    litellm: connection ? { status: connection.status, lastSuccessAt: connection.lastSuccess ? Date.parse(connection.lastSuccess) : null, error: connection.error } : null,
    lastSuccessAt: Object.fromEntries(lastSuccess.map(row => [row.type, row.at ? new Date(row.at).getTime() : null])),
    failedRuns24h: Object.fromEntries(failed.map(row => [row.type, Number(row.n)])),
    credentials: { invalid: Number(credentials[0]?.invalid ?? 0), unverified: Number(credentials[0]?.unverified ?? 0) },
    deployment: { problems: deploymentProblems(deployment) },
    fleet: { live: Number(fleet[0]?.live ?? 0), notServing: Number(fleet[0]?.notServing ?? 0), unmanagedNotServing: Number(fleet[0]?.unmanagedNotServing ?? 0) },
  };
  return { ...evaluateStatus(input), facts: input, environment: { mode: deployment.mode, summary: deploymentSummary(deployment), databaseId: identity?.short ?? null } };
}
