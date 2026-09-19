import "server-only";
import { randomUUID } from "node:crypto";
import { eq,inArray,or,sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents,modelCandidates,providers,syncRuns } from "@/server/db/schema";
import { discoverySources } from "./sources";
import { sourceRegistry } from "./registry";
import { ensureModelSources, getEnabledAdapterIds, getEnabledSourceLastSync, recordSourceBlocked, recordSourceSync } from "./model-sources";
import { resolveProvider } from "@/server/providers/catalog";
import { bareModelKey } from "./model-key";
import { consolidateModelCandidates } from "./consolidate";
import { SourceBlockedError, type DiscoveredCandidate, type DiscoverySource } from "./types";
import { discoveryRunStatus } from "./run-status";

export interface PersistState{providerIdBySlug:Map<string,string>;touchedProviderIds:Set<string>}

type Evidence=Record<string,unknown>;
type CandidateColumns={displayName:string;providerName:string|null;providerId:string|null;freeType:DiscoveredCandidate["freeType"];verifiedFree:boolean;contextWindow:number|null;maxOutputTokens:number|null;supportsVision:boolean|null;supportsTools:boolean|null;supportsReasoning:boolean|null;sourceUrl:string|null};
/** One candidate row as it evolves while a batch is applied in memory. `columns` is set when the row's full column set
 *  must be written (every new row, and any existing row a matching item refreshed); an existing row that was only merged
 *  as corroboration has just `evidence`/`providerId` to write. */
interface Entry{id:string;isNew:boolean;source:string;modelRef:string;providerName:string|null;evidence:Evidence;providerId?:string|null;columns?:CandidateColumns}

const BATCH_SIZE=500;
const chunk=<T,>(list:T[],size=BATCH_SIZE)=>Array.from({length:Math.ceil(list.length/size)},(_,i)=>list.slice(i*size,(i+1)*size));
const keyOf=(source:string,modelRef:string)=>`${source}\u0000${modelRef}`;
const columnsFor=(item:DiscoveredCandidate,providerId:string|null):CandidateColumns=>({displayName:item.displayName,providerName:item.providerName??null,providerId,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:item.contextWindow??null,maxOutputTokens:item.maxOutputTokens??null,supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl});

/** Writes one source's discovered items into model_candidates (insert, refresh, or merge into a same-model duplicate) and
 *  returns how many items were persisted. Mutates `state` so later sources in the same run reuse resolved provider ids.
 *
 *  Reads the relevant existing rows once, decides every item in memory using the same sequential rules the original
 *  one-query-per-item version had (an item can match a row inserted earlier in the same batch), then writes in batches
 *  inside one transaction — so query count grows with batches, not items, and a source's results publish atomically.
 *  Equivalence with the original is checked by tests-integration/discovery-persist-differential.test.ts. */
export async function persistDiscoveredItems(db:ReturnType<typeof getDb>,items:DiscoveredCandidate[],state:PersistState):Promise<number>{
  if(!items.length)return 0;
  const {providerIdBySlug,touchedProviderIds}=state;
  const sources=[...new Set(items.map(item=>item.source))];
  const providerNames=[...new Set(items.map(item=>resolveProvider(item.providerName,item.modelRef)?.name).filter((name):name is string=>Boolean(name)))];

  return db.transaction(async tx=>{
    const loaded=await tx.select({id:modelCandidates.id,source:modelCandidates.source,modelRef:modelCandidates.modelRef,providerName:modelCandidates.providerName,evidence:modelCandidates.evidence}).from(modelCandidates)
      .where(providerNames.length?or(inArray(modelCandidates.source,sources),inArray(modelCandidates.providerName,providerNames)):inArray(modelCandidates.source,sources))
      .orderBy(modelCandidates.firstSeenAt,modelCandidates.id);
    const byKey=new Map<string,Entry>();
    // provider name -> bare model key -> rows in load order. The first row is the one a same-model item merges into.
    const byProvider=new Map<string,Map<string,Entry[]>>();
    const link=(entry:Entry)=>{
      if(entry.providerName===null)return;
      const group=byProvider.get(entry.providerName)??new Map<string,Entry[]>();
      const bare=bareModelKey(entry.modelRef);
      group.set(bare,[...(group.get(bare)??[]),entry]);
      byProvider.set(entry.providerName,group);
    };
    const unlink=(entry:Entry)=>{
      if(entry.providerName===null)return;
      const group=byProvider.get(entry.providerName);const bare=bareModelKey(entry.modelRef);
      const rest=(group?.get(bare)??[]).filter(other=>other!==entry);
      if(!group)return;
      if(rest.length)group.set(bare,rest);else group.delete(bare);
    };
    const register=(entry:Entry)=>{byKey.set(keyOf(entry.source,entry.modelRef),entry);link(entry);};
    for(const row of loaded)register({id:row.id,isNew:false,source:row.source,modelRef:row.modelRef,providerName:row.providerName,evidence:row.evidence??{}});

    const entries=new Map<string,Entry>(); // every entry that changed, in first-touched order
    let discovered=0;
    for(const item of items){
      const provider=resolveProvider(item.providerName,item.modelRef);
      if(provider){
        if(!providerIdBySlug.has(provider.slug)){
          await tx.insert(providers).values(provider).onConflictDoNothing();
          const[row]=await tx.select({id:providers.id}).from(providers).where(eq(providers.slug,provider.slug)).limit(1);
          if(row)providerIdBySlug.set(provider.slug,row.id);
        }
        item.providerName=provider.name;
      }
      const providerId=provider?providerIdBySlug.get(provider.slug)??null:null;
      if(providerId)touchedProviderIds.add(providerId);

      const existing=byKey.get(keyOf(item.source,item.modelRef));
      if(existing){
        existing.columns=columnsFor(item,providerId);existing.providerId=providerId;
        // A refresh can change which provider the row belongs to; later same-model lookups must follow it, exactly as they
        // would have when each item was written to the database before the next was read.
        if(existing.providerName!==(item.providerName??null)){unlink(existing);existing.providerName=item.providerName??null;link(existing);}
        existing.evidence={...existing.evidence,...item.evidence};
        entries.set(existing.id,existing);discovered++;continue;
      }
      const duplicate=provider?byProvider.get(provider.name)?.get(bareModelKey(item.modelRef))?.[0]:undefined;
      if(duplicate){
        const prior=Array.isArray(duplicate.evidence.corroboratingSources)?duplicate.evidence.corroboratingSources as {source:string;sourceUrl:string}[]:[];
        const corroboratingSources=prior.some(c=>c.source===item.source)?prior:[...prior,{source:item.source,sourceUrl:item.sourceUrl}];
        duplicate.evidence={...duplicate.evidence,corroboratingSources};duplicate.providerId=providerId;
        if(duplicate.columns)duplicate.columns.providerId=providerId;
        entries.set(duplicate.id,duplicate);discovered++;continue;
      }
      const fresh:Entry={id:randomUUID(),isNew:true,source:item.source,modelRef:item.modelRef,providerName:item.providerName??null,evidence:item.evidence,providerId,columns:columnsFor(item,providerId)};
      register(fresh);entries.set(fresh.id,fresh);discovered++;
    }

    const now=new Date();
    const changed=[...entries.values()];
    for(const batch of chunk(changed.filter(entry=>entry.isNew)))
      await tx.insert(modelCandidates).values(batch.map(entry=>({id:entry.id,source:entry.source,modelRef:entry.modelRef,...entry.columns!,lifecycle:"DISCOVERED" as const,evidence:entry.evidence,lastSeenAt:now,updatedAt:now})));
    for(const batch of chunk(changed.filter(entry=>!entry.isNew&&entry.columns))){
      const payload=JSON.stringify(batch.map(entry=>({id:entry.id,...entry.columns!,evidence:entry.evidence})));
      await tx.execute(sql`update model_candidates m set display_name=v."displayName", provider_name=v."providerName", provider_id=v."providerId", lifecycle='DISCOVERED', free_type=v."freeType"::free_type, verified_free=v."verifiedFree", context_window=v."contextWindow", max_output_tokens=v."maxOutputTokens", supports_vision=v."supportsVision", supports_tools=v."supportsTools", supports_reasoning=v."supportsReasoning", source_url=v."sourceUrl", evidence=v.evidence, last_seen_at=now(), updated_at=now() from jsonb_to_recordset(${payload}::jsonb) as v("id" uuid, "displayName" text, "providerName" text, "providerId" uuid, "freeType" text, "verifiedFree" boolean, "contextWindow" integer, "maxOutputTokens" integer, "supportsVision" boolean, "supportsTools" boolean, "supportsReasoning" boolean, "sourceUrl" text, evidence jsonb) where m.id=v."id"`);
    }
    for(const batch of chunk(changed.filter(entry=>!entry.isNew&&!entry.columns))){
      const payload=JSON.stringify(batch.map(entry=>({id:entry.id,providerId:entry.providerId??null,evidence:entry.evidence})));
      await tx.execute(sql`update model_candidates m set provider_id=v."providerId", evidence=v.evidence, last_seen_at=now(), updated_at=now() from jsonb_to_recordset(${payload}::jsonb) as v("id" uuid, "providerId" uuid, evidence jsonb) where m.id=v."id"`);
    }
    return discovered;
  });
}

export async function runDiscovery(options:{sources?:DiscoverySource[]}={}){
  await ensureModelSources();
  const enabledIds = await getEnabledAdapterIds();
  const lastSyncById = await getEnabledSourceLastSync();
  const registryById = new Map(sourceRegistry.map(source => [source.id, source]));
  const activeSources = (options.sources ?? discoverySources).filter(source => {
    if (!enabledIds.has(source.id)) return false;
    const refreshHours = registryById.get(source.id)?.refreshHours;
    if (!refreshHours) return true;
    const lastSyncAt = lastSyncById.get(source.id);
    if (!lastSyncAt) return true;
    return Date.now() - lastSyncAt.getTime() >= refreshHours * 60 * 60 * 1000;
  });
  const db=getDb();const correlationId=randomUUID();const[run]=await db.insert(syncRuns).values({type:"MODEL_DISCOVERY",status:"RUNNING",correlationId,startedAt:new Date()}).returning();
  const providerIdBySlug=new Map((await db.select({slug:providers.slug,id:providers.id}).from(providers)).map(row=>[row.slug,row.id]));
  const results=await Promise.allSettled(activeSources.map(async source=>{try{const items=await source.discover();return {sourceId:source.id,ok:true as const,items}}catch(error){const message=error instanceof Error?error.message:"Unknown source error";return {sourceId:source.id,ok:false as const,blocked:error instanceof SourceBlockedError,error:message}}}));
  let discovered=0;const sources=[];const touchedProviderIds=new Set<string>();
  for(const result of results){
    if(result.status!=="fulfilled")continue; // try/catch inside the mapper means this branch shouldn't occur, but stay defensive
    const outcome=result.value;
    if(!outcome.ok&&outcome.blocked){sources.push({source:outcome.sourceId,status:"blocked",reason:outcome.error});await recordSourceBlocked(outcome.sourceId);continue}
    if(!outcome.ok){sources.push({source:outcome.sourceId,status:"failed",error:outcome.error});await recordSourceSync(outcome.sourceId,{ok:false,error:outcome.error});continue}
    const {sourceId:source,items}=outcome;
    // One source failing to save (its transaction rolls back) must not abort the sources after it.
    try{discovered+=await persistDiscoveredItems(db,items,{providerIdBySlug,touchedProviderIds});}
    catch(error){const message=error instanceof Error?error.message:"Failed to save discovered models";sources.push({source,status:"failed",error:message});await recordSourceSync(source,{ok:false,error:message});continue}
    sources.push({source,status:"succeeded",count:items.length});
    await recordSourceSync(source,{ok:true,count:items.length});
  }
  if(touchedProviderIds.size)await db.update(providers).set({lastDiscoveryAt:new Date(),updatedAt:new Date()}).where(inArray(providers.id,[...touchedProviderIds]));
  const consolidation=await consolidateModelCandidates();
  const outcomeCounts={succeeded:sources.filter(s=>s.status==="succeeded").length,failed:sources.filter(s=>s.status==="failed").length,blocked:sources.filter(s=>s.status==="blocked").length};const summary={discovered,sources,consolidation};
  await db.update(syncRuns).set({status:activeSources.length?discoveryRunStatus(outcomeCounts):"SUCCEEDED",summary,finishedAt:new Date(),updatedAt:new Date()}).where(eq(syncRuns.id,run.id));
  await db.insert(auditEvents).values({actor:"system",action:"discovery.completed",entityType:"sync_run",entityId:run.id,after:summary,correlationId});
  return{runId:run.id,correlationId,...summary};
}
