import "server-only";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, canonicalModels, laneAssignments, modelDeployments, providers, smokeTests } from "@/server/db/schema";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { log } from "@/server/logging";
import { recordLaneSnapshots } from "@/server/lanes/snapshots";
import { recordConnection } from "@/server/settings/connections";
import { getLiteLLMManagementSettings } from "@/server/settings/litellm-management";
import { healthFromSmokeResult } from "@/server/status";
import { AUTO_REMOVE_AFTER_FAILURES, computeFailureStreak } from "./failure-streak";
import { randomUUID } from "node:crypto";

// Looks back further than AUTO_REMOVE_AFTER_FAILURES so a run of rate-limited checks (skipped, never counted —
// see computeFailureStreak) doesn't leave too few rows for 5 genuine failures to actually be found.
const LOOKBACK_MULTIPLIER = 4;

async function consecutiveFailureCount(deploymentId: string): Promise<number> {
  const recent = await getDb().select({ status: smokeTests.status, errorCode: smokeTests.errorCode }).from(smokeTests)
    .where(eq(smokeTests.deploymentId, deploymentId)).orderBy(desc(smokeTests.createdAt)).limit(AUTO_REMOVE_AFTER_FAILURES * LOOKBACK_MULTIPLIER);
  return computeFailureStreak(recent);
}

/**
 * A ratllm-managed deployment that has failed its last AUTO_REMOVE_AFTER_FAILURES health checks in a row is
 * pulled from LiteLLM automatically, excluded from its lanes, and its canonical model quarantined — so a dead
 * free-tier model stops clogging routing/fallbacks instead of sitting there forever showing as failing.
 * Never touches an unmanaged deployment (one this app did not add itself).
 */
async function autoRemoveIfFailing(deployment: typeof modelDeployments.$inferSelect, adapter: HttpLiteLLMAdapter): Promise<boolean> {
  if (!deployment.managed || !deployment.litellmDeploymentId) return false;
  const streak = await consecutiveFailureCount(deployment.id);
  if (streak < AUTO_REMOVE_AFTER_FAILURES) return false;

  const db = getDb();
  const correlationId = randomUUID();
  try {
    await adapter.removeDeployment(deployment.litellmDeploymentId);
  } catch (error) {
    log("error", "Auto-remove could not reach LiteLLM", { deploymentId: deployment.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  await db.update(modelDeployments).set({
    litellmDeploymentId: null, health: "UNAVAILABLE", lifecycle: "REMOVED",
    rawMetadata: { ...deployment.rawMetadata, removedAt: new Date().toISOString(), removedReason: `${AUTO_REMOVE_AFTER_FAILURES} consecutive failed health checks` },
    updatedAt: new Date(),
  }).where(eq(modelDeployments.id, deployment.id));
  await db.update(laneAssignments).set({
    excluded: true, explanation: { source: "AUTO_REMOVE", reason: "removed from LiteLLM after repeated failures", at: new Date().toISOString() }, updatedAt: new Date(),
  }).where(eq(laneAssignments.deploymentId, deployment.id));
  await db.update(canonicalModels).set({ lifecycle: "QUARANTINED", updatedAt: new Date() }).where(eq(canonicalModels.id, deployment.canonicalModelId));
  await db.insert(auditEvents).values({
    actor: "system", action: "litellm.deployment.auto_removed", entityType: "model_deployment", entityId: deployment.id,
    before: { litellmDeploymentId: deployment.litellmDeploymentId, health: deployment.health },
    after: { reason: `${AUTO_REMOVE_AFTER_FAILURES} consecutive failures` }, correlationId,
  });
  log("warn", "Auto-removed failing deployment from LiteLLM", { deploymentId: deployment.id, litellmModelName: deployment.litellmModelName });
  return true;
}

/** Least-recently-tested deployments first, so a frequent limited-size run rotates through the whole inventory over time instead of getting stuck on the same rows forever. Skips deployments whose provider is marked "skip automation" in Settings → Providers. */
export async function runHealthMonitor(options:{limit?:number}={}){
  const db=getDb();
  const deployments=await db.select({deployment:modelDeployments}).from(modelDeployments)
    .innerJoin(providers,eq(modelDeployments.providerId,providers.id))
    .where(and(isNotNull(modelDeployments.litellmDeploymentId),eq(providers.enabled,true)))
    .orderBy(sql`${modelDeployments.lastTestedAt} asc nulls first`)
    .limit(options.limit??25).then(rows=>rows.map(row=>row.deployment));
  const adapter=new HttpLiteLLMAdapter();
  const { autoRemove } = await getLiteLLMManagementSettings();
  let healthy=0; let autoRemoved=0; let reachedLiteLLM=false;
  const results=[] as Array<{id:string;health:string;status:number}>;
  for(const deployment of deployments){
    const result=await adapter.smokeTest(deployment.litellmModelName);
    if(result.status!==0)reachedLiteLLM=true; // a real HTTP response (even an error one) proves LiteLLM itself answered
    const health=healthFromSmokeResult(result.ok,result.status,result.latencyMs,result.error);
    if(health==="HEALTHY")healthy++;
    await db.insert(smokeTests).values({deploymentId:deployment.id,status:result.ok?"PASSED":"FAILED",latencyMs:result.latencyMs,firstTokenMs:result.firstTokenMs??null,httpStatus:result.status||null,errorCode:health,error:result.error,responseExcerpt:result.content,correlationId:randomUUID()});
    await db.update(modelDeployments).set({health,lastTestedAt:new Date(),updatedAt:new Date()}).where(eq(modelDeployments.id,deployment.id));
    if (autoRemove && !result.ok && await autoRemoveIfFailing(deployment, adapter)) autoRemoved++;
    results.push({id:deployment.id,health,status:result.status});
  }
  // The health monitor runs every few minutes — a far more frequent, real proof of LiteLLM connectivity than
  // waiting on someone to click "Test connection" in Settings, so the overview page's LITELLM card doesn't sit
  // on STALE between manual tests while everything is actually working.
  if(reachedLiteLLM)await recordConnection("litellm",{ok:true}).catch(()=>undefined);
  await recordLaneSnapshots();
  return {checked:deployments.length,healthy,autoRemoved,results};
}
