import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { candidateChecks, modelCandidates, providerCredentialReferences, providers } from "@/server/db/schema";
import { getModelCandidates } from "@/server/queries";
import { resolveProvider } from "@/server/providers/catalog";
import { verifyCandidateDirectly, type CandidateVerificationStatus } from "./verify";

const SUCCESS_RECHECK_MS=6*60*60_000;
const FAILURE_RECHECK_MS=6*60*60_000;
const RATE_LIMIT_RECHECK_MS=24*60*60_000;

type VerificationRow={id:string;model:string;provider:string|null;status:CandidateVerificationStatus;httpStatus:number|null;error:string|null;nextCheckAt:string};
type Candidate=Awaited<ReturnType<typeof getModelCandidates>>[number];

function roundRobinQueue<T extends {source:string;providerName:string|null;modelRef:string;id:string}>(list:T[]){const queues=new Map<string,T[]>();for(const row of list){const key=resolveProvider(row.source==="openrouter"?"openrouter":row.providerName,row.modelRef)?.slug??("unresolved-"+row.id);const queue=queues.get(key)??[];queue.push(row);queues.set(key,queue);}return queues;}
function drain<T>(queues:Map<string,T[]>,into:T[],cap:number){while(into.length<cap){let added=false;for(const queue of queues.values()){const row=queue.shift();if(row){into.push(row);added=true;if(into.length>=cap)break;}}if(!added)break;}}

/** Runs one direct test for a candidate, then persists the evidence and a candidate_checks row (which is what the
 *  availability status bars are built from). When `providerBackoff` is a Map, a provider that returned 429 earlier in
 *  the batch is skipped without another call; pass `null` to force a real request for every candidate regardless. */
async function checkCandidate(db:ReturnType<typeof getDb>,row:Candidate,providerBackoff:Map<string,string>|null):Promise<VerificationRow>{
  const testedAt=new Date().toISOString();const definition=resolveProvider(row.source==="openrouter"?"openrouter":row.providerName,row.modelRef);const providerKey=definition?.slug??null;let result:Awaited<ReturnType<typeof verifyCandidateDirectly>>;
  if(providerKey&&providerBackoff?.has(providerKey))result={status:"rate_limited",httpStatus:429,error:"Provider rate limit reached earlier in this run; retry deferred"};else{const provider=providerKey?(await db.select().from(providers).where(eq(providers.slug,providerKey)).limit(1))[0]??null:null;const credential=provider?(await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId,provider.id)).limit(1))[0]??null:null;result=await verifyCandidateDirectly({modelRef:row.modelRef,source:row.source,provider:definition,providerBaseUrl:provider?.baseUrl??null,credential});}
  const delay=result.status==="available"?SUCCESS_RECHECK_MS:result.status==="rate_limited"?RATE_LIMIT_RECHECK_MS:FAILURE_RECHECK_MS;const nextCheckAt=new Date(Date.now()+delay).toISOString();if(result.status==="rate_limited"&&providerKey&&providerBackoff)providerBackoff.set(providerKey,nextCheckAt);const requiredAction=result.status==="credential_missing"?"ADD_CREDENTIAL":result.status==="credential_unverified"?"VERIFY_CREDENTIAL":result.status==="provider_unresolved"?"RESOLVE_PROVIDER":result.status==="provider_not_configured"?"CONFIGURE_VERIFIER":null;
  await db.update(modelCandidates).set({evidence:{...row.evidence,testedAt,lastStatus:result.status,lastHttpStatus:result.httpStatus,lastError:result.error?.slice(0,500)??null,retryAt:result.status==="rate_limited"?nextCheckAt:null,nextCheckAt,providerSlug:providerKey,requiredAction},updatedAt:new Date()}).where(eq(modelCandidates.id,row.id));await db.insert(candidateChecks).values({candidateId:row.id,status:result.status,httpStatus:result.httpStatus,error:result.error?.slice(0,500)??null});
  return {id:row.id,model:row.modelRef,provider:providerKey,status:result.status,httpStatus:result.httpStatus,error:result.error,nextCheckAt};
}

/** Tests candidates directly; a 429 backs off only that provider, never the whole batch. Candidates for a provider we already have a verified credential for are guaranteed the first slots — hundreds of candidates with no usable credential shouldn't crowd out the ones we can actually test. */
export async function verifyDueCandidates(limit=20){
  const db=getDb();const rows=await getModelCandidates();const now=Date.now();const eligible=rows.filter(row=>{const nextCheckAt=row.evidence.nextCheckAt??row.evidence.retryAt??row.evidence.testedAt;return !nextCheckAt||new Date(String(nextCheckAt)).getTime()<=now;});
  const priority=eligible.filter(row=>row.credentialVerified);const rest=eligible.filter(row=>!row.credentialVerified);
  const due:typeof eligible=[];drain(roundRobinQueue(priority),due,limit);if(due.length<limit)drain(roundRobinQueue(rest),due,limit);
  const providerBackoff=new Map<string,string>();const results:VerificationRow[]=[];
  for(const row of due)results.push(await checkCandidate(db,row,providerBackoff));
  return {processed:results.length,results,nextEligibleAt:results.find(item=>item.status==="rate_limited")?.nextCheckAt??null};
}

/** Manual "test my connected models now": every credential-verified candidate gets a real request, ignoring both the
 *  recheck schedule and per-provider backoff, so the status bars always gain a fresh point on click. Concurrency-limited
 *  so a few hundred candidates don't open a few hundred sockets at once. */
export async function verifyConnectedCandidates(limit=250,concurrency=10){
  const db=getDb();const rows=await getModelCandidates();
  const targets=rows.filter(row=>row.credentialVerified&&Boolean(row.providerId)).sort((a,b)=>a.displayName.localeCompare(b.displayName)).slice(0,limit);
  const results:VerificationRow[]=[];let cursor=0;
  async function worker(){while(cursor<targets.length){const row=targets[cursor++];results.push(await checkCandidate(db,row,null));}}
  await Promise.all(Array.from({length:Math.min(Math.max(concurrency,1),targets.length||1)},()=>worker()));
  return {processed:results.length,targeted:targets.length,available:results.filter(r=>r.status==="available").length,rateLimited:results.filter(r=>r.status==="rate_limited").length,unavailable:results.filter(r=>r.status==="unavailable"||r.status==="auth_error").length};
}
