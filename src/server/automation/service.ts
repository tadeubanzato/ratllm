import "server-only";
import { and, eq, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db/client";
import { automationJobs, leases, syncRuns } from "@/server/db/schema";
import { runDiscovery } from "@/server/discovery/run";
import { verifyDueCandidates, verifyConnectedCandidates } from "@/server/discovery/verify-due";
import { consolidateModelCandidates } from "@/server/discovery/consolidate";
import { runHealthMonitor } from "@/server/health/monitor";
import { learnRateLimits } from "@/server/rate-limits/learn";
import { syncLiteLLM } from "@/server/litellm/sync";

export const JOB_TYPES = ["MODEL_DISCOVERY","CANDIDATE_VERIFICATION","HEALTH_MONITOR","RATE_LIMIT_LEARNING","APPLY_APPROVED_PLANS","DEEP_BENCHMARK","MAINTENANCE"] as const;
export type AutomationType = typeof JOB_TYPES[number];
const defaults: Record<AutomationType,string>={MODEL_DISCOVERY:"0 */6 * * *",CANDIDATE_VERIFICATION:"15 */6 * * *",HEALTH_MONITOR:"*/10 * * * *",RATE_LIMIT_LEARNING:"30 */6 * * *",APPLY_APPROVED_PLANS:"0 * * * *",DEEP_BENCHMARK:"0 3 * * *",MAINTENANCE:"30 3 * * *"};

/** Small, deliberately strict five-field cron evaluator. Invalid schedules are rejected rather than guessed. */
export function nextCron(schedule:string, from=new Date()):Date {
  const fields=schedule.trim().split(/\s+/); if(fields.length!==5) throw new Error("Schedule must be a five-field cron expression");
  const matches=(value:number, field:string, min:number,max:number)=>field.split(",").some(part=>{const [base,stepText]=part.split("/");const step=stepText?Number(stepText):1;if(!Number.isInteger(step)||step<1)return false;const accepts=(n:number)=>base==="*"||(base.includes("-")?(()=>{const [a,b]=base.split("-").map(Number);return n>=a&&n<=b})():n===Number(base)); return value>=min&&value<=max&&accepts(value)&&((value-min)%step===0);});
  const at=new Date(from);at.setSeconds(0,0);at.setMinutes(at.getMinutes()+1);
  for(let i=0;i<527040;i++){if(matches(at.getMinutes(),fields[0],0,59)&&matches(at.getHours(),fields[1],0,23)&&matches(at.getDate(),fields[2],1,31)&&matches(at.getMonth()+1,fields[3],1,12)&&matches(at.getDay(),fields[4],0,6))return at;at.setMinutes(at.getMinutes()+1);} throw new Error("No next run found for cron expression");
}
export async function ensureAutomationJobs(){const db=getDb();for(const type of JOB_TYPES){const next=nextCron(defaults[type]);await db.insert(automationJobs).values({type,schedule:defaults[type],timezone:"UTC",nextRunAt:next}).onConflictDoNothing();}}
async function claim(type:string, owner:string){const db=getDb();const until=new Date(Date.now()+10*60_000);const result=await db.execute(sql`insert into leases ("key", "owner", "expires_at") values (${`automation:${type}`}, ${owner}, ${until.toISOString()}::timestamptz) on conflict ("key") do update set "owner" = excluded."owner", "expires_at" = excluded."expires_at", "updated_at" = now() where leases."expires_at" < now() returning "key"`);return result.length>0;}
async function release(type:string,owner:string){await getDb().delete(leases).where(and(eq(leases.key,`automation:${type}`),eq(leases.owner,owner)));}
export type AutomationOptions={candidateScope?:"due"|"connected"};
async function execute(type:AutomationType,options?:AutomationOptions){switch(type){case "MODEL_DISCOVERY": return runDiscovery();case "CANDIDATE_VERIFICATION":return options?.candidateScope==="connected"?verifyConnectedCandidates():verifyDueCandidates();case "HEALTH_MONITOR":return runHealthMonitor();case "RATE_LIMIT_LEARNING":return learnRateLimits();case "APPLY_APPROVED_PLANS":return syncLiteLLM({dryRun:false});case "DEEP_BENCHMARK":return runHealthMonitor({limit:100});case "MAINTENANCE":return {leasesPruned:await getDb().delete(leases).where(lte(leases.expiresAt,new Date())).returning({key:leases.key}),candidates:await consolidateModelCandidates()};}}
export async function runAutomation(type:AutomationType, trigger="SCHEDULED", options?:AutomationOptions){
  await ensureAutomationJobs(); const db=getDb(); const owner=randomUUID(); if(!await claim(type,owner)) return {started:false,reason:"already_running" as const};
  const started=new Date();const correlationId=randomUUID();const [run]=await db.insert(syncRuns).values({type, status:"RUNNING",correlationId,startedAt:started,summary:{trigger,affectedEntities:[]}}).returning();
  await db.update(automationJobs).set({status:"RUNNING",lastRunAt:started,lastError:null,updatedAt:started}).where(eq(automationJobs.type,type));
  try {const summary=await execute(type,options);const finished=new Date();const durationMs=finished.getTime()-started.getTime();await db.update(syncRuns).set({status:"SUCCEEDED",finishedAt:finished,summary:{trigger,result:summary},updatedAt:finished}).where(eq(syncRuns.id,run.id));await db.update(automationJobs).set({status:"SUCCEEDED",lastRunAt:started,nextRunAt:nextCron((await db.select({schedule:automationJobs.schedule}).from(automationJobs).where(eq(automationJobs.type,type)).limit(1))[0].schedule,finished),durationMs,failureCount:0,lastError:null,updatedAt:finished}).where(eq(automationJobs.type,type));return {started:true,runId:run.id,summary};
  } catch(error) {const finished=new Date();const message=error instanceof Error?error.message:"Automation failed";await db.update(syncRuns).set({status:"FAILED",finishedAt:finished,error:message,updatedAt:finished}).where(eq(syncRuns.id,run.id));await db.update(automationJobs).set({status:"FAILED",durationMs:finished.getTime()-started.getTime(),failureCount:sql`${automationJobs.failureCount}+1`,lastError:message,nextRunAt:nextCron((await db.select({schedule:automationJobs.schedule}).from(automationJobs).where(eq(automationJobs.type,type)).limit(1))[0].schedule,finished),updatedAt:finished}).where(eq(automationJobs.type,type));throw error;
  } finally {await release(type,owner);}
}
export async function tickScheduler(){await ensureAutomationJobs();const due=await getDb().select().from(automationJobs).where(and(eq(automationJobs.enabled,true),lte(automationJobs.nextRunAt,new Date())));return Promise.allSettled(due.map(job=>runAutomation(job.type as AutomationType)));
}
