import "server-only";
import { and, eq, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db/client";
import { log } from "@/server/logging";
import { automationJobs, leases, syncRuns } from "@/server/db/schema";
import { runDiscovery } from "@/server/discovery/run";
import { verifyDueCandidates, verifyConnectedCandidates } from "@/server/discovery/verify-due";
import { consolidateModelCandidates } from "@/server/discovery/consolidate";
import { reconcileLaneMembership } from "@/server/lanes/reconcile";
import { runHealthMonitor } from "@/server/health/monitor";
import { learnRateLimits } from "@/server/rate-limits/learn";
import { syncLiteLLM } from "@/server/litellm/sync";
import { verifyAllProviders } from "@/server/providers/verify";
import { refreshGigaChatTokens } from "@/server/providers/gigachat";
import { defaultScheduleFor, JOB_TYPES, nextCron, type AutomationType } from "./schedule";

export { defaultScheduleFor, JOB_TYPES, nextCron } from "./schedule";
export type { AutomationType } from "./schedule";

const RUN_RETENTION_DAYS=30;

/** Seeds each job and, for any job the user has not explicitly customised, heals a schedule that has drifted from the
 *  code default back to it (also re-arming nextRunAt) so a stale/broken schedule can never silently park a monitor. */
export async function ensureAutomationJobs(){
  const db=getDb();
  for(const type of JOB_TYPES){
    const schedule=defaultScheduleFor(type);const next=nextCron(schedule);
    await db.insert(automationJobs).values({type,schedule,timezone:"UTC",nextRunAt:next}).onConflictDoUpdate({
      target:automationJobs.type,
      set:{schedule,nextRunAt:next,updatedAt:new Date()},
      setWhere:and(eq(automationJobs.customSchedule,false),ne(automationJobs.schedule,schedule)),
    });
  }
}
/** A held lease is renewed every LEASE_RENEW_MS while the job runs, so the lease can stay short: a job that outlives a
 *  fixed lease used to be claimable by another worker mid-run, while a crashed worker's job now frees up within
 *  LEASE_MS instead of a fixed 10 minutes. */
export const LEASE_MS=3*60_000;
export const LEASE_RENEW_MS=30_000;
export async function claim(type:string, owner:string){const db=getDb();const until=new Date(Date.now()+LEASE_MS);const result=await db.execute(sql`insert into leases ("key", "owner", "expires_at") values (${`automation:${type}`}, ${owner}, ${until.toISOString()}::timestamptz) on conflict ("key") do update set "owner" = excluded."owner", "expires_at" = excluded."expires_at", "updated_at" = now() where leases."expires_at" < now() returning "key"`);return result.length>0;}
/** Extends the lease only if this owner still holds it. False means it was lost (expired and re-claimed elsewhere). */
export async function renew(type:string,owner:string){const rows=await getDb().update(leases).set({expiresAt:new Date(Date.now()+LEASE_MS),updatedAt:new Date()}).where(and(eq(leases.key,`automation:${type}`),eq(leases.owner,owner))).returning({key:leases.key});return rows.length>0;}
export async function release(type:string,owner:string){await getDb().delete(leases).where(and(eq(leases.key,`automation:${type}`),eq(leases.owner,owner)));}
/** Next due time for a job, computed from its own persisted schedule and time zone. */
async function nextRunFor(type:string,from:Date){const job=(await getDb().select({schedule:automationJobs.schedule,timezone:automationJobs.timezone}).from(automationJobs).where(eq(automationJobs.type,type)).limit(1))[0];return nextCron(job.schedule,from,job.timezone);}
export type AutomationOptions={candidateScope?:"due"|"connected"};
async function execute(type:AutomationType,options?:AutomationOptions){switch(type){case "MODEL_DISCOVERY": return runDiscovery();case "CANDIDATE_VERIFICATION":return options?.candidateScope==="connected"?verifyConnectedCandidates():verifyDueCandidates();case "HEALTH_MONITOR":return runHealthMonitor();case "RATE_LIMIT_LEARNING":return learnRateLimits();case "PROVIDER_VERIFICATION":return verifyAllProviders();case "APPLY_APPROVED_PLANS":return syncLiteLLM({dryRun:false});case "DEEP_BENCHMARK":return runHealthMonitor({limit:100});case "LANE_RECONCILE":return reconcileLaneMembership();case "GIGACHAT_TOKEN_REFRESH":return refreshGigaChatTokens();case "MAINTENANCE":{const db=getDb();const cutoff=new Date(Date.now()-RUN_RETENTION_DAYS*24*60*60_000);return {leasesPruned:(await db.delete(leases).where(lte(leases.expiresAt,new Date())).returning({key:leases.key})).length,runsPruned:(await db.delete(syncRuns).where(lt(syncRuns.createdAt,cutoff)).returning({id:syncRuns.id})).length,candidates:await consolidateModelCandidates()};}}}
// runDiscovery() and reconcileLaneMembership() insert their own sync_runs row under this exact same type string
// (they're also called directly, outside this scheduler, by the manual "run now" API routes) — so on the scheduled
// path below, creating a second wrapper row here would double-log every real execution: one real row with the
// job's own rich summary, one near-empty row nobody reads. Skip the wrapper row for these two; automationJobs
// (updated regardless) is still the canonical status/lastError source for every job type.
const SELF_LOGGING_TYPES = new Set<AutomationType>(["MODEL_DISCOVERY", "LANE_RECONCILE"]);
export async function runAutomation(type:AutomationType, trigger="SCHEDULED", options?:AutomationOptions){
  await ensureAutomationJobs(); const db=getDb(); const owner=randomUUID(); if(!await claim(type,owner)) return {started:false,reason:"already_running" as const};
  const started=new Date();const correlationId=randomUUID();
  const renewer=setInterval(()=>{void renew(type,owner).then(held=>{if(!held)log("warn","Automation lease was lost while the job was still running",{type,owner});}).catch(error=>log("warn","Automation lease renewal failed",{type,error:error instanceof Error?error.message:String(error)}));},LEASE_RENEW_MS);
  const run=SELF_LOGGING_TYPES.has(type)?null:(await db.insert(syncRuns).values({type, status:"RUNNING",correlationId,startedAt:started,summary:{trigger,affectedEntities:[]}}).returning())[0];
  // The job is ours now: a pending "run now" request is satisfied by this very run (whether it was triggered by it or the schedule).
  await db.update(automationJobs).set({status:"RUNNING",lastRunAt:started,lastError:null,runRequestedAt:null,requestedOptions:null,updatedAt:started}).where(eq(automationJobs.type,type));
  try {const summary=await execute(type,options);const finished=new Date();const durationMs=finished.getTime()-started.getTime();if(run)await db.update(syncRuns).set({status:"SUCCEEDED",finishedAt:finished,summary:{trigger,result:summary},updatedAt:finished}).where(eq(syncRuns.id,run.id));await db.update(automationJobs).set({status:"SUCCEEDED",lastRunAt:started,nextRunAt:await nextRunFor(type,finished),durationMs,failureCount:0,lastError:null,updatedAt:finished}).where(eq(automationJobs.type,type));return {started:true,runId:run?.id??null,summary};
  } catch(error) {const finished=new Date();const message=error instanceof Error?error.message:"Automation failed";if(run)await db.update(syncRuns).set({status:"FAILED",finishedAt:finished,error:message,updatedAt:finished}).where(eq(syncRuns.id,run.id));await db.update(automationJobs).set({status:"FAILED",durationMs:finished.getTime()-started.getTime(),failureCount:sql`${automationJobs.failureCount}+1`,lastError:message,nextRunAt:await nextRunFor(type,finished),updatedAt:finished}).where(eq(automationJobs.type,type));throw error;
  } finally {clearInterval(renewer);await release(type,owner);}
}
/** Ask for an immediate run. Returns at once; the worker starts it on its next tick, under the same lease and reporting as a
 *  scheduled run. Asking twice before it starts is one run, not two. Works even when the job's schedule is disabled. */
export async function requestRun(type:AutomationType,options?:AutomationOptions){
  await ensureAutomationJobs();
  const db=getDb();
  const [before]=await db.select({at:automationJobs.runRequestedAt}).from(automationJobs).where(eq(automationJobs.type,type));
  await db.update(automationJobs).set({runRequestedAt:before?.at??new Date(),requestedOptions:options??null,updatedAt:new Date()}).where(eq(automationJobs.type,type));
  return {queued:true as const,alreadyQueued:Boolean(before?.at)};
}

export async function tickScheduler(){await ensureAutomationJobs();const now=new Date();const due=await getDb().select().from(automationJobs).where(or(and(eq(automationJobs.enabled,true),lte(automationJobs.nextRunAt,now)),isNotNull(automationJobs.runRequestedAt)));return Promise.allSettled(due.map(job=>runAutomation(job.type as AutomationType,job.runRequestedAt?"MANUAL":"SCHEDULED",job.requestedOptions??undefined)));
}
