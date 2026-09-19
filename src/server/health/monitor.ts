import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, canonicalModels, laneAssignments, modelCandidates, modelDeployments, providers, smokeTests } from "@/server/db/schema";
import { removalHistoryOf } from "@/server/discovery/auto-add-policy";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { log } from "@/server/logging";
import { recordLaneSnapshots } from "@/server/lanes/snapshots";
import { recordConnection } from "@/server/settings/connections";
import { getLiteLLMManagementSettings } from "@/server/settings/litellm-management";
import { healthFromSmokeResult } from "@/server/status";
import { AUTO_REMOVE_AFTER_FAILURES, computeFailureStreak, isAutoRemoveEligible } from "./failure-streak";
import { SYSTEMIC, detectSystemicFailures, type RunProbe } from "./probe-policy";
import { randomUUID } from "node:crypto";

// Looks back further than AUTO_REMOVE_AFTER_FAILURES so a run of rate-limited checks (skipped, never counted —
// see computeFailureStreak) doesn't leave too few rows for 5 genuine failures to actually be found.
const LOOKBACK_MULTIPLIER = 4;

async function consecutiveFailureCount(deploymentId: string): Promise<number> {
  const recent = await getDb().select({ status: smokeTests.status, errorCode: smokeTests.errorCode }).from(smokeTests)
    .where(eq(smokeTests.deploymentId, deploymentId)).orderBy(desc(smokeTests.createdAt)).limit(AUTO_REMOVE_AFTER_FAILURES * LOOKBACK_MULTIPLIER);
  return computeFailureStreak(recent);
}

/** Appends this removal to the source candidate's flap history (see auto-add-policy.ts) so a later re-add can
 *  tell whether it's due a cooldown or has flapped past the point of trusting automation with it again. The
 *  candidate is found via the id `registerTarget` (lanes/promote.ts) embeds in every deployment it creates —
 *  silently a no-op for a deployment that predates that (or was added outside RatLLM), since there's no candidate
 *  row to track flaps against. */
async function recordCandidateRemoval(db: ReturnType<typeof getDb>, deployment: typeof modelDeployments.$inferSelect, reason: string) {
  const modelInfo = deployment.rawMetadata?.model_info as Record<string, unknown> | undefined;
  const candidateId = typeof modelInfo?.source_candidate_id === "string" ? modelInfo.source_candidate_id : null;
  if (!candidateId) return;
  const candidate = (await db.select({ evidence: modelCandidates.evidence }).from(modelCandidates).where(eq(modelCandidates.id, candidateId)).limit(1))[0];
  if (!candidate) return;
  const history = [...removalHistoryOf(candidate.evidence), { at: new Date().toISOString(), reason }];
  await db.update(modelCandidates).set({ evidence: { ...candidate.evidence, removalHistory: history }, updatedAt: new Date() }).where(eq(modelCandidates.id, candidateId));
}

/**
 * A ratllm-managed deployment that has failed its last AUTO_REMOVE_AFTER_FAILURES health checks in a row is
 * pulled from LiteLLM automatically, excluded from its lanes, and its canonical model quarantined — so a dead
 * free-tier model stops clogging routing/fallbacks instead of sitting there forever showing as failing.
 * See isAutoRemoveEligible for what's exempt and why.
 */
export type HealthAdapter = Pick<HttpLiteLLMAdapter, "smokeTest" | "removeDeployment">;

async function autoRemoveIfFailing(deployment: typeof modelDeployments.$inferSelect, providerSlug: string, adapter: HealthAdapter): Promise<boolean> {
  // The trailing null check is redundant with isAutoRemoveEligible at runtime — it's here only so TypeScript can
  // narrow litellmDeploymentId to a string for the removeDeployment call below.
  if (!isAutoRemoveEligible(deployment, providerSlug) || !deployment.litellmDeploymentId) return false;
  const streak = await consecutiveFailureCount(deployment.id);
  if (streak < AUTO_REMOVE_AFTER_FAILURES) return false;

  const db = getDb();
  const correlationId = randomUUID();
  const reason = `${AUTO_REMOVE_AFTER_FAILURES} consecutive failed health checks`;
  try {
    await adapter.removeDeployment(deployment.litellmDeploymentId);
  } catch (error) {
    log("error", "Auto-remove could not reach LiteLLM", { deploymentId: deployment.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  await db.update(modelDeployments).set({
    litellmDeploymentId: null, health: "UNAVAILABLE", lifecycle: "REMOVED",
    rawMetadata: { ...deployment.rawMetadata, removedAt: new Date().toISOString(), removedReason: reason },
    updatedAt: new Date(),
  }).where(eq(modelDeployments.id, deployment.id));
  await db.update(laneAssignments).set({
    excluded: true, explanation: { source: "AUTO_REMOVE", reason: "removed from LiteLLM after repeated failures", at: new Date().toISOString() }, updatedAt: new Date(),
  }).where(eq(laneAssignments.deploymentId, deployment.id));
  await db.update(canonicalModels).set({ lifecycle: "QUARANTINED", updatedAt: new Date() }).where(eq(canonicalModels.id, deployment.canonicalModelId));
  await recordCandidateRemoval(db, deployment, reason);
  await db.insert(auditEvents).values({
    actor: "system", action: "litellm.deployment.auto_removed", entityType: "model_deployment", entityId: deployment.id,
    before: { litellmDeploymentId: deployment.litellmDeploymentId, health: deployment.health },
    after: { reason: `${AUTO_REMOVE_AFTER_FAILURES} consecutive failures` }, correlationId,
  });
  log("warn", "Auto-removed failing deployment from LiteLLM", { deploymentId: deployment.id, litellmModelName: deployment.litellmModelName });
  return true;
}

/** Least-recently-tested deployments first, so a frequent limited-size run rotates through the whole inventory over time instead of getting stuck on the same rows forever. Skips deployments whose provider is marked "skip automation" in Settings → Providers. */
/** The last time each deployment PASSED a check — what decides whether a systemic incident may shield its failures. */
async function lastPassedAt(db: ReturnType<typeof getDb>, deploymentIds: string[]): Promise<Map<string, Date>> {
  if (!deploymentIds.length) return new Map();
  const rows = await db.select({ id: smokeTests.deploymentId, at: sql<Date | string | null>`max(${smokeTests.createdAt})` }).from(smokeTests)
    .where(and(inArray(smokeTests.deploymentId, deploymentIds), eq(smokeTests.status, "PASSED"))).groupBy(smokeTests.deploymentId);
  return new Map(rows.filter(row => row.id && row.at).map(row => [row.id as string, new Date(row.at as Date | string)]));
}

export async function runHealthMonitor(options:{limit?:number; adapter?:HealthAdapter}={}){
  const db=getDb();
  const rows=await db.select({deployment:modelDeployments,providerSlug:providers.slug}).from(modelDeployments)
    .innerJoin(providers,eq(modelDeployments.providerId,providers.id))
    .where(and(isNotNull(modelDeployments.litellmDeploymentId),eq(modelDeployments.lifecycle,"ACTIVE"),eq(providers.enabled,true)))
    .orderBy(sql`${modelDeployments.lastTestedAt} asc nulls first`)
    .limit(options.limit??25);
  const deployments=rows.map(row=>row.deployment);
  const providerSlugById=new Map(rows.map(row=>[row.deployment.id,row.providerSlug]));
  const adapter:HealthAdapter=options.adapter??new HttpLiteLLMAdapter();
  const { autoRemove } = await getLiteLLMManagementSettings();
  let healthy=0; let autoRemoved=0; let reachedLiteLLM=false;
  const results=[] as Array<{id:string;health:string;status:number}>;
  const probed=[] as Array<{deployment:typeof modelDeployments.$inferSelect;providerSlug:string;ok:boolean;status:number;health:string;rowId:string}>;

  // Phase 1 — probe everything and record it. No removal decision is made here: whether a failure is evidence about a
  // deployment depends on how the OTHER deployments in this same run fared, which isn't known until they've all been probed.
  for(const deployment of deployments){
    // Addressed by the deployment's own litellm_deployment_id, never its litellm_model_name — many deployments
    // share one alias (a lane's whole routing pool), and testing by alias lets LiteLLM's own load balancer pick
    // which pool member actually answers. That silently misattributes pass/fail to the wrong row and made the
    // 5-consecutive-failures auto-remove below unable to ever reliably catch a specific broken lane member.
    // Addressing by id bypasses routing/fallbacks and hits exactly this deployment, still with a real prompt.
    const result=await adapter.smokeTest(deployment.litellmDeploymentId!);
    if(result.status!==0)reachedLiteLLM=true; // a real HTTP response (even an error one) proves LiteLLM itself answered
    const health=healthFromSmokeResult(result.ok,result.status,result.latencyMs,result.error);
    if(health==="HEALTHY")healthy++;
    const [row]=await db.insert(smokeTests).values({deploymentId:deployment.id,status:result.ok?"PASSED":"FAILED",latencyMs:result.latencyMs,firstTokenMs:result.firstTokenMs??null,httpStatus:result.status||null,errorCode:health,error:result.error,responseExcerpt:result.content,correlationId:randomUUID()}).returning({id:smokeTests.id});
    await db.update(modelDeployments).set({health,lastTestedAt:new Date(),updatedAt:new Date()}).where(eq(modelDeployments.id,deployment.id));
    probed.push({deployment,providerSlug:providerSlugById.get(deployment.id)!,ok:result.ok,status:result.status,health,rowId:row.id});
    results.push({id:deployment.id,health,status:result.status});
  }

  // Phase 2 — judge the run as a whole. A router that couldn't be reached, or most of the fleet (or all of one provider)
  // failing together, is an incident; failures during it aren't evidence that any single deployment is dead, so they're
  // marked SYSTEMIC and excluded from removal streaks. A deployment's real health is still recorded as it was observed.
  const lastPassed=await lastPassedAt(db,probed.filter(p=>!p.ok).map(p=>p.deployment.id));
  const runProbes:RunProbe[]=probed.map(p=>({deploymentId:p.deployment.id,providerSlug:p.providerSlug,ok:p.ok,httpStatus:p.status,errorCode:p.health,lastPassedAt:lastPassed.get(p.deployment.id)??null}));
  const { deploymentIds: systemicIds, incidents } = detectSystemicFailures(runProbes);
  if(systemicIds.size){
    await db.update(smokeTests).set({errorCode:SYSTEMIC}).where(inArray(smokeTests.id,probed.filter(p=>systemicIds.has(p.deployment.id)).map(p=>p.rowId)));
    log("warn","Health check run looks like a wider incident; its failures will not count toward auto-removal",{incidents,shielded:systemicIds.size});
    await db.insert(auditEvents).values({actor:"system",action:"litellm.health.systemic_failure",entityType:"health_run",entityId:null,after:{incidents,shielded:systemicIds.size},correlationId:randomUUID()});
  }

  // Phase 3 — removal decisions, now that each failure is known to be either genuine or part of an incident.
  for(const p of probed){
    if(autoRemove && !p.ok && !systemicIds.has(p.deployment.id) && await autoRemoveIfFailing(p.deployment,p.providerSlug,adapter)) autoRemoved++;
  }
  // The health monitor runs every few minutes — a far more frequent, real proof of LiteLLM connectivity than
  // waiting on someone to click "Test connection" in Settings, so the overview page's LITELLM card doesn't sit
  // on STALE between manual tests while everything is actually working.
  if(reachedLiteLLM)await recordConnection("litellm",{ok:true}).catch(()=>undefined);
  await recordLaneSnapshots();
  return {checked:deployments.length,healthy,autoRemoved,results,incidents};
}
