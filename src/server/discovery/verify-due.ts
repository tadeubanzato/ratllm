import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates } from "@/server/db/schema";
import { getModelCandidates } from "@/server/queries";
import { connectCandidate } from "./connect";

export async function verifyDueCandidates(limit=20){
  const db=getDb();const rows=await getModelCandidates();const now=Date.now();const due=rows.filter(row=>row.credentialVerified&&(!row.evidence.testedAt||new Date(String(row.evidence.retryAt??row.evidence.testedAt)).getTime()<=now)).slice(0,limit);const results=[];
  for(const row of due){try{const result=await connectCandidate(row.id);results.push({id:row.id,model:row.modelRef,status:"passed",result});await db.update(modelCandidates).set({evidence:{...row.evidence,testedAt:new Date().toISOString(),lastStatus:"passed",retryAt:null},updatedAt:new Date()}).where(eq(modelCandidates.id,row.id));}catch(error){const message=error instanceof Error?error.message:"Verification failed";const rateLimited=/\b429\b|rate.?limit|free-models-per-day/i.test(message);const retryAt=new Date(Date.now()+(rateLimited?24*60*60_000:6*60*60_000)).toISOString();results.push({id:row.id,model:row.modelRef,status:rateLimited?"rate_limited":"failed",error:message});await db.update(modelCandidates).set({evidence:{...row.evidence,testedAt:new Date().toISOString(),lastStatus:rateLimited?"rate_limited":"failed",lastError:message.slice(0,500),retryAt},updatedAt:new Date()}).where(eq(modelCandidates.id,row.id));if(rateLimited)break;}}
  return {processed:results.length,results,nextEligibleAt:results.some(item=>item.status==="rate_limited")?new Date(Date.now()+24*60*60_000).toISOString():null};
}
