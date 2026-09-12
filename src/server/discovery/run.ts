import "server-only";
import { randomUUID } from "node:crypto";
import { eq,and } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents,modelCandidates,providers,syncRuns } from "@/server/db/schema";
import { discoverySources } from "./sources";
import { ensureModelSources, getEnabledAdapterIds, recordSourceSync } from "./model-sources";
import { resolveProvider } from "@/server/providers/catalog";
import { bareModelKey } from "./model-key";
import { consolidateModelCandidates } from "./consolidate";

/** When another row (same source under a different spelling, or a different source entirely) already covers this model for this provider, merge it in as corroboration instead of creating a near-duplicate row. Deliberately does not exclude the current source: a single text-scraped page can list the same model twice under slightly different spellings, and the exact (source, modelRef) check above this call only catches an identical spelling. */
async function findDuplicateCandidate(db:ReturnType<typeof getDb>,providerName:string,modelRef:string){
  const key=bareModelKey(modelRef);
  const rows=await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence,modelRef:modelCandidates.modelRef}).from(modelCandidates).where(eq(modelCandidates.providerName,providerName));
  return rows.find(row=>bareModelKey(row.modelRef)===key)??null;
}

export async function runDiscovery(){
  await ensureModelSources();
  const enabledIds = await getEnabledAdapterIds();
  const activeSources = discoverySources.filter(source => enabledIds.has(source.id));
  const db=getDb();const correlationId=randomUUID();const[run]=await db.insert(syncRuns).values({type:"MODEL_DISCOVERY",status:"RUNNING",correlationId,startedAt:new Date()}).returning();
  const providerIdBySlug=new Map((await db.select({slug:providers.slug,id:providers.id}).from(providers)).map(row=>[row.slug,row.id]));
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
      const provider=resolveProvider(item.providerName,item.modelRef);
      if(provider){
        await db.insert(providers).values(provider).onConflictDoNothing();
        item.providerName=provider.name;
        if(!providerIdBySlug.has(provider.slug)){const[row]=await db.select({id:providers.id}).from(providers).where(eq(providers.slug,provider.slug)).limit(1);if(row)providerIdBySlug.set(provider.slug,row.id);}
      }
      const providerId=provider?providerIdBySlug.get(provider.slug)??null:null;
      const existing=(await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence}).from(modelCandidates).where(and(eq(modelCandidates.source,item.source),eq(modelCandidates.modelRef,item.modelRef))).limit(1))[0];
      if(existing){const values={displayName:item.displayName,providerName:item.providerName??null,providerId,lifecycle:"DISCOVERED" as const,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:item.contextWindow??null,maxOutputTokens:item.maxOutputTokens??null,supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl,evidence:{...(existing.evidence??{}),...item.evidence},lastSeenAt:new Date(),updatedAt:new Date()};await db.update(modelCandidates).set(values).where(eq(modelCandidates.id,existing.id));discovered++;continue;}
      const duplicate=provider?await findDuplicateCandidate(db,provider.name,item.modelRef):null;
      if(duplicate){const prior=Array.isArray(duplicate.evidence.corroboratingSources)?duplicate.evidence.corroboratingSources as {source:string;sourceUrl:string}[]:[];const corroboratingSources=prior.some(c=>c.source===item.source)?prior:[...prior,{source:item.source,sourceUrl:item.sourceUrl}];await db.update(modelCandidates).set({providerId,evidence:{...duplicate.evidence,corroboratingSources},lastSeenAt:new Date(),updatedAt:new Date()}).where(eq(modelCandidates.id,duplicate.id));discovered++;continue;}
      await db.insert(modelCandidates).values({source:item.source,modelRef:item.modelRef,displayName:item.displayName,providerName:item.providerName??null,providerId,lifecycle:"DISCOVERED" as const,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:item.contextWindow??null,maxOutputTokens:item.maxOutputTokens??null,supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl,evidence:item.evidence,lastSeenAt:new Date(),updatedAt:new Date()});
      discovered++;
    }
  }
  const consolidation=await consolidateModelCandidates();
  const failed=sources.filter(s=>s.status==="failed").length;const summary={discovered,sources,consolidation};
  await db.update(syncRuns).set({status:activeSources.length&&failed===activeSources.length?"FAILED":"SUCCEEDED",summary,finishedAt:new Date(),updatedAt:new Date()}).where(eq(syncRuns.id,run.id));
  await db.insert(auditEvents).values({actor:"system",action:"discovery.completed",entityType:"sync_run",entityId:run.id,after:summary,correlationId});
  return{runId:run.id,correlationId,...summary};
}
