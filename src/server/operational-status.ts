import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments, providerCredentialReferences, providers, syncRuns } from "@/server/db/schema";
import { connectionSummary } from "@/server/settings/connections";
import { readWorkerHealth } from "@/server/worker-heartbeat";
import { evaluateStatus, FRESHNESS_LIMITS_MS, type StatusInput } from "./operational-status-rules";
import { deploymentProblems, deploymentSummary, describeDeployment } from "./deployment-info";
import { getDeploymentIdentity } from "./deployment-identity";
import { supportsCredentialTest } from "./providers/wiring";

export { evaluateStatus } from "./operational-status-rules";

const RUN_TYPES = Object.keys(FRESHNESS_LIMITS_MS);

/** Which provider credentials are invalid, and which are unverified. A credential is "unverified" only where verifying is possible: a provider
 *  with no credential-test endpoint (Kilo, Sarvam) can never be verified, so counting it produced a permanent "not verified yet" notice. */
export function credentialFacts(rows: ReadonlyArray<{ slug: string; name: string; valid: boolean | null; hasValue: boolean }>) {
  const names = (list: typeof rows) => [...new Set(list.map(row => row.name))].sort((a, b) => a.localeCompare(b));
  const invalid = rows.filter(row => row.valid === false);
  const unverified = rows.filter(row => row.valid === null && row.hasValue && supportsCredentialTest(row.slug));
  return { invalid: invalid.length, unverified: unverified.length, invalidProviders: names(invalid), unverifiedProviders: names(unverified) };
}

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
    // A failure is reported only until something later succeeds: the next run of the same kind, or for a promotion the same model being
    // added. Counting every failure of the last 24 hours kept warning about problems that had already fixed themselves.
    db.execute(sql`
      select f.type, count(*)::int as n from sync_runs f
      where f.status = 'FAILED' and f.created_at > now() - interval '24 hours'
        and not exists (
          select 1 from sync_runs s
          where s.type = f.type and s.status = 'SUCCEEDED' and s.created_at > f.created_at
            and (f.type <> 'CANDIDATE_PROMOTE' or s.summary->>'candidateId' = f.summary->>'candidateId'))
      group by f.type`) as unknown as Promise<Array<{ type: string; n: number }>>,
    db.select({ slug: providers.slug, name: providers.name, valid: providerCredentialReferences.valid, hasValue: sql<boolean>`(${providerCredentialReferences.encryptedValue} is not null)` })
      .from(providerCredentialReferences).innerJoin(providers, eq(providerCredentialReferences.providerId, providers.id))
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
    failedRuns24h: Object.fromEntries([...failed].map(row => [row.type, Number(row.n)])),
    credentials: credentialFacts(credentials),
    deployment: { problems: deploymentProblems(deployment) },
    fleet: { live: Number(fleet[0]?.live ?? 0), notServing: Number(fleet[0]?.notServing ?? 0), unmanagedNotServing: Number(fleet[0]?.unmanagedNotServing ?? 0) },
  };
  return { ...evaluateStatus(input), facts: input, environment: { mode: deployment.mode, summary: deploymentSummary(deployment), databaseId: identity?.short ?? null } };
}
