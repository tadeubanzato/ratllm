import "server-only";
import { eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments, smokeTests } from "@/server/db/schema";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { healthFromSmokeResult } from "@/server/status";
import { randomUUID } from "node:crypto";
export async function runHealthMonitor(options:{limit?:number}={}){const db=getDb();const deployments=await db.select().from(modelDeployments).where(isNotNull(modelDeployments.litellmDeploymentId)).limit(options.limit??25);const adapter=new HttpLiteLLMAdapter();let healthy=0;const results=[] as Array<{id:string;health:string;status:number}>;for(const deployment of deployments){const result=await adapter.smokeTest(deployment.litellmModelName);const health=healthFromSmokeResult(result.ok,result.status,result.latencyMs,result.error);if(health==="HEALTHY")healthy++;await db.insert(smokeTests).values({deploymentId:deployment.id,status:result.ok?"PASSED":"FAILED",latencyMs:result.latencyMs,httpStatus:result.status||null,errorCode:health,error:result.error,responseExcerpt:result.content,correlationId:randomUUID()});await db.update(modelDeployments).set({health,lastTestedAt:new Date(),updatedAt:new Date()}).where(eq(modelDeployments.id,deployment.id));results.push({id:deployment.id,health,status:result.status});}return {checked:deployments.length,healthy,results};}
