import "server-only";
import { randomUUID } from "node:crypto";
import { eq,and,ne } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents,modelCandidates,providers,syncRuns } from "@/server/db/schema";
import { discoverySources } from "./sources";
import { ensureModelSources, getEnabledAdapterIds, recordSourceSync } from "./model-sources";
import { resolveProvider } from "@/server/providers/catalog";

/** Same provider + same model id, spelling and punctuation aside — a real duplicate, not a fuzzy family guess. */
const normalizeModelKey=(value:string)=>value.trim().toLowerCase().replace(/[^a-z0-9]+/g,"");

/** When a second (candidate-only) source reports a model an existing row from another source already covers, merge it in as corroboration instead of creating a near-duplicate row. */
async function findCrossSourceDuplicate(db:ReturnType<typeof getDb>,providerName:string,source:string,modelRef:string){
  const key=normalizeModelKey(modelRef);
  const rows=await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence,modelRef:modelCandidates.modelRef}).from(modelCandidates).where(and(eq(modelCandidates.providerName,providerName),ne(modelCandidates.source,source)));
  return rows.find(row=>normalizeModelKey(row.modelRef)===key)??null;
}

export async function runDiscovery(){
  await ensureModelSources();
  const enabledIds = await getEnabledAdapterIds();
  const activeSources = discoverySources.filter(source => enabledIds.has(source.id));
  const db=getDb();const correlationId=randomUUID();const[run]=await db.insert(syncRuns).values({type:"MODEL_DISCOVERY",status:"RUNNING",correlationId,startedAt:new Date()}).returning();
  const results=await Promise.allSettled(activeSources.map(async source=>{try{const items=await source.discover();return {sourceId:source.id,ok:true as const,items}}catch(error){return {sourceId:source.id,ok:false as const,error:error instanceof Error?error.message:"Unknown source error"}}}));
  let discovered=0;const sources=[];
  for(const result of results){
    if(result.status!=="fulfilled")continue; // try/catch inside the mapper means this branch shouldn't occur, but stay defensive
    const outcome=result.value;
    if(!outcome.ok){sources.push({source:outcome.sourceId,status:"failed",error:outcome.error});await recordSourceSync(outcome.sourceId,{ok:false,error:outcome.error});continue}
    const {sourceId:source,items}=outcome;
    sources.push({source,status:"succeeded",count:items.length});
    await recordSourceSync(source,{ok:true,count:items.length});
    for(const item of items){
      const provider=resolveProvider(item.providerName,item.modelRef);if(provider){await db.insert(providers).values(provider).onConflictDoNothing();item.providerName=provider.name;}
      const existing=(await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence}).from(modelCandidates).where(and(eq(modelCandidates.source,item.source),eq(modelCandidates.modelRef,item.modelRef))).limit(1))[0];
      if(existing){const values={displayName:item.displayName,providerName:item.providerName??null,lifecycle:"DISCOVERED" as const,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:item.contextWindow??null,maxOutputTokens:item.maxOutputTokens??null,supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl,evidence:{...(existing.evidence??{}),...item.evidence},lastSeenAt:new Date(),updatedAt:new Date()};await db.update(modelCandidates).set(values).where(eq(modelCandidates.id,existing.id));discovered++;continue;}
      const crossSource=provider?await findCrossSourceDuplicate(db,provider.name,item.source,item.modelRef):null;
      if(crossSource){const prior=Array.isArray(crossSource.evidence.corroboratingSources)?crossSource.evidence.corroboratingSources as {source:string;sourceUrl:string}[]:[];const corroboratingSources=prior.some(c=>c.source===item.source)?prior:[...prior,{source:item.source,sourceUrl:item.sourceUrl}];await db.update(modelCandidates).set({evidence:{...crossSource.evidence,corroboratingSources},lastSeenAt:new Date(),updatedAt:new Date()}).where(eq(modelCandidates.id,crossSource.id));discovered++;continue;}
      await db.insert(modelCandidates).values({source:item.source,modelRef:item.modelRef,displayName:item.displayName,providerName:item.providerName??null,lifecycle:"DISCOVERED" as const,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:item.contextWindow??null,maxOutputTokens:item.maxOutputTokens??null,supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl,evidence:item.evidence,lastSeenAt:new Date(),updatedAt:new Date()});
      discovered++;
    }
  }
  const failed=sources.filter(s=>s.status==="failed").length;const summary={discovered,sources};
  await db.update(syncRuns).set({status:activeSources.length&&failed===activeSources.length?"FAILED":"SUCCEEDED",summary,finishedAt:new Date(),updatedAt:new Date()}).where(eq(syncRuns.id,run.id));
  await db.insert(auditEvents).values({actor:"system",action:"discovery.completed",entityType:"sync_run",entityId:run.id,after:summary,correlationId});
  return{runId:run.id,correlationId,...summary};
}
