import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { buildPerformanceRows, type LatestProbe } from "./performance-rules";
import { getBenchmarkStats, getDeployments, type DeploymentRow } from "./queries";

/** Each deployment's own newest probe. Not a slice of the fleet's latest N probes: a deployment probed less recently than the Nth newest
 *  (a provider whose probing is paused by its daily call budget, say) used to read "NOT RUN, last tested never" despite a full history. */
export async function getLatestProbes(): Promise<Map<string, LatestProbe>> {
  const rows = await getDb().execute(sql`
    select distinct on (deployment_id) deployment_id as "deploymentId", status::text as status, http_status as "httpStatus", latency_ms as "latencyMs", error, created_at as "createdAt"
    from smoke_tests where deployment_id is not null order by deployment_id, created_at desc`) as unknown as Array<{ deploymentId: string } & Omit<LatestProbe, "createdAt"> & { createdAt: Date | string }>;
  return new Map(rows.map(row => [row.deploymentId, { status: row.status, httpStatus: row.httpStatus, latencyMs: row.latencyMs, error: row.error, createdAt: new Date(row.createdAt) }]));
}

/** What the Performance page shows: one row per deployment still in LiteLLM, ranked. `deployments` is passed in when the caller already has it. */
export async function getPerformanceRows(window = 20, deployments?: DeploymentRow[]) {
  const [list, latest, stats] = await Promise.all([deployments ? Promise.resolve(deployments) : getDeployments(), getLatestProbes(), getBenchmarkStats(window)]);
  return buildPerformanceRows(list, latest, stats);
}
