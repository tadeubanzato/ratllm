import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates, providerCredentialReferences, providers } from "@/server/db/schema";
import { getModelCandidates } from "@/server/queries";
import { resolveProvider } from "@/server/providers/catalog";
import { verifyCandidateDirectly, type CandidateVerificationStatus } from "./verify";

const SUCCESS_RECHECK_MS=6*60*60_000;
const FAILURE_RECHECK_MS=6*60*60_000;
const RATE_LIMIT_RECHECK_MS=24*60*60_000;

type VerificationRow={id:string;model:string;provider:string|null;status:CandidateVerificationStatus;httpStatus:number|null;error:string|null;nextCheckAt:string};

/** Tests candidates directly; a 429 backs off only that provider, never the whole batch. */
export async function verifyDueCandidates(limit=20){
  const db=getDb();const rows=await getModelCandidates();const now=Date.now();const eligible=rows.filter(row=>{const nextCheckAt=row.evidence.nextCheckAt??row.evidence.retryAt??row.evidence.testedAt;return !nextCheckAt||new Date(String(nextCheckAt)).getTime()<=now;});const queues=new Map<string,typeof eligible>();for(const row of eligible){const key=resolveProvider(row.source==="openrouter"?"openrouter":row.providerName,row.modelRef)?.slug??("unresolved-"+row.id);const queue=queues.get(key)??[];queue.push(row);queues.set(key,queue);}const due:typeof eligible=[];while(due.length<limit){let added=false;for(const queue of queues.values()){const row=queue.shift();if(row){due.push(row);added=true;if(due.length>=limit)break;}}if(!added)break;}const results:VerificationRow[]=[];const providerBackoff=new Map<string,string>();
  for(const row of due){const testedAt=new Date().toISOString();const definition=resolveProvider(row.source==="openrouter"?"openrouter":row.providerName,row.modelRef);const providerKey=definition?.slug??null;let result:Awaited<ReturnType<typeof verifyCandidateDirectly>>;
    if(providerKey&&providerBackoff.has(providerKey))result={status:"rate_limited",httpStatus:429,error:"Provider rate limit reached earlier in this run; retry deferred"};else{const provider=providerKey?(await db.select().from(providers).where(eq(providers.slug,providerKey)).limit(1))[0]??null:null;const credential=provider?(await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId,provider.id)).limit(1))[0]??null:null;result=await verifyCandidateDirectly({modelRef:row.modelRef,source:row.source,provider:definition,providerBaseUrl:provider?.baseUrl??null,credential});}
    const delay=result.status==="available"?SUCCESS_RECHECK_MS:result.status==="rate_limited"?RATE_LIMIT_RECHECK_MS:FAILURE_RECHECK_MS;const nextCheckAt=new Date(Date.now()+delay).toISOString();if(result.status==="rate_limited"&&providerKey)providerBackoff.set(providerKey,nextCheckAt);const requiredAction=result.status==="credential_missing"?"ADD_CREDENTIAL":result.status==="credential_unverified"?"VERIFY_CREDENTIAL":result.status==="provider_unresolved"?"RESOLVE_PROVIDER":result.status==="provider_not_configured"?"CONFIGURE_VERIFIER":null;
    await db.update(modelCandidates).set({evidence:{...row.evidence,testedAt,lastStatus:result.status,lastHttpStatus:result.httpStatus,lastError:result.error?.slice(0,500)??null,retryAt:result.status==="rate_limited"?nextCheckAt:null,nextCheckAt,providerSlug:providerKey,requiredAction},updatedAt:new Date()}).where(eq(modelCandidates.id,row.id));results.push({id:row.id,model:row.modelRef,provider:providerKey,status:result.status,httpStatus:result.httpStatus,error:result.error,nextCheckAt});}
  return {processed:results.length,results,nextEligibleAt:results.find(item=>item.status==="rate_limited")?.nextCheckAt??null};
}
