import "server-only";
import { randomUUID } from "node:crypto";
import { eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, modelCandidates, providerOffers, providers, syncRuns } from "@/server/db/schema";
import { discoverySources } from "./sources";
import { sourceRegistry } from "./registry";
import { ensureModelSources, getEnabledAdapterIds, getEnabledSourceLastSync, recordSourceBlocked, recordSourceSync } from "./model-sources";
import { attributeOfferProvider, attributeProvider, catalogIdentity, type ProviderIdentity } from "@/server/providers/attribution";
import { bareModelKey } from "./model-key";
import { consolidateModelCandidates } from "./consolidate";
import { reconcileCheckBlockers } from "./blockers";
import { nonChatModelReason } from "./model-type";
import { SourceBlockedError, normalizeDiscoveryResult, type DiscoveredCandidate, type DiscoverySource, type ProviderOffer } from "./types";
import { discoveryRunStatus } from "./run-status";

export interface PersistState{providerIdBySlug:Map<string,string>;touchedProviderIds:Set<string>}

type Evidence=Record<string,unknown>;
type CandidateColumns={displayName:string;providerName:string|null;providerId:string|null;modelKey:string;freeType:DiscoveredCandidate["freeType"];verifiedFree:boolean;contextWindow:number|null;maxOutputTokens:number|null;supportsVision:boolean|null;supportsTools:boolean|null;supportsReasoning:boolean|null;sourceUrl:string|null};
/** One candidate row as it evolves while a batch is applied in memory. `columns` is set when the row's full column set
 *  must be written (every new row, and any existing row a matching item refreshed); an existing row that was only merged
 *  as corroboration has just `evidence`/`providerId` to write. */
interface Entry{id:string;isNew:boolean;source:string;modelRef:string;modelKey:string;providerId:string|null;evidence:Evidence;columns?:CandidateColumns}

const BATCH_SIZE=500;
const SOURCE_CONCURRENCY=8;
/** A source that rejects more than this share of the rows it returned is DEGRADED: it works, but is dropping data. */
const DEGRADED_REJECT_SHARE=0.2;
const chunk=<T,>(list:T[],size=BATCH_SIZE)=>Array.from({length:Math.ceil(list.length/size)},(_,i)=>list.slice(i*size,(i+1)*size));
const keyOf=(source:string,modelRef:string)=>`${source}\u0000${modelRef}`;
const groupKey=(providerId:string,modelKey:string)=>`${providerId}\u0000${modelKey}`;
const columnsFor=(item:DiscoveredCandidate,providerId:string|null):CandidateColumns=>({displayName:item.displayName,providerName:item.providerName??null,providerId,modelKey:bareModelKey(item.modelRef),freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:positiveOrNull(item.contextWindow),maxOutputTokens:positiveOrNull(item.maxOutputTokens),supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl??null});
/** A source that reports 0 (or a negative) for a token limit means "unknown", which the database stores as NULL. */
function positiveOrNull(value:number|undefined|null){return typeof value==="number"&&Number.isFinite(value)&&value>0?value:null;}

/** The evidence to store for an item: what the source sent, plus whether the model is a chat model at all. A source's own
 *  statement wins; otherwise the name heuristic decides. Written once at ingestion so no reader has to re-derive it, and
 *  read by reconcileCheckBlockers, which is what keeps a whisper or embedding model from ever being sent a chat call. */
function evidenceFor(item:DiscoveredCandidate):Evidence{
  const description=typeof item.evidence?.description==="string"?item.evidence.description:null;
  const nonChatReason=item.nonChatReason??nonChatModelReason({modelRef:item.modelRef,displayName:item.displayName,description});
  return {...item.evidence,nonChatReason:nonChatReason??null};
}

/** Makes sure the provider row exists (creating a DISCOVERED provider if a source named one the catalog doesn't know —
 *  invariant I3) and returns its id. Mutates `state` so later items and sources in the same run reuse it. */
async function ensureProvider(tx:Pick<ReturnType<typeof getDb>,"insert"|"select">,identity:ProviderIdentity,state:PersistState):Promise<string|null>{
  const known=state.providerIdBySlug.get(identity.slug);
  if(known)return known;
  await tx.insert(providers).values({slug:identity.slug,name:identity.name,adapterKey:identity.adapterKey,adapterCapability:identity.adapterCapability,origin:identity.origin}).onConflictDoNothing();
  const[row]=await tx.select({id:providers.id}).from(providers).where(eq(providers.slug,identity.slug)).limit(1);
  if(row)state.providerIdBySlug.set(identity.slug,row.id);
  return row?.id??null;
}

/** Writes one source's discovered items into model_candidates (insert, refresh, or merge into a same-model duplicate) and
 *  returns how many items were persisted. Mutates `state` so later sources in the same run reuse resolved provider ids.
 *
 *  Every item's provider is decided once, by attributeProvider (invariant I1), and stored as `provider_id`; a model is
 *  identified by (provider_id, model_key) (I10), so the same model from a second source merges into the row we already have
 *  while the same model at a different provider stays its own row. Reads the relevant rows once, decides every item in
 *  memory using the same sequential rules as a one-query-per-item version (an item can match a row inserted earlier in the
 *  batch), then writes in batches inside one transaction: query count grows with batches, not items, and a source's results
 *  publish atomically. tests-integration/discovery-persist-differential.test.ts checks it against a naive sequential oracle. */
export async function persistDiscoveredItems(db:ReturnType<typeof getDb>,items:DiscoveredCandidate[],state:PersistState):Promise<number>{
  if(!items.length)return 0;
  const {touchedProviderIds}=state;
  const sources=[...new Set(items.map(item=>item.source))];

  return db.transaction(async tx=>{
    // 1. Decide every item's provider, and make sure each distinct provider exists, before reading candidates.
    const identityOf=new Map<DiscoveredCandidate,ProviderIdentity|null>();
    const providerIdOf=new Map<string,string|null>();
    for(const item of items){
      const identity=attributeProvider(item.providerName,item.modelRef);
      identityOf.set(item,identity);
      if(identity&&!providerIdOf.has(identity.slug))providerIdOf.set(identity.slug,await ensureProvider(tx,identity,state));
    }
    const providerIds=[...new Set([...providerIdOf.values()].filter((id):id is string=>Boolean(id)))];

    // 2. Everything that could already hold one of these models: rows from these sources, or rows at these providers.
    const loaded=await tx.select({id:modelCandidates.id,source:modelCandidates.source,modelRef:modelCandidates.modelRef,modelKey:modelCandidates.modelKey,providerId:modelCandidates.providerId,evidence:modelCandidates.evidence}).from(modelCandidates)
      .where(providerIds.length?or(inArray(modelCandidates.source,sources),inArray(modelCandidates.providerId,providerIds)):inArray(modelCandidates.source,sources))
      .orderBy(modelCandidates.firstSeenAt,modelCandidates.id);
    const byKey=new Map<string,Entry>();
    // (provider, model key) -> rows in load order. The first row is the one a same-model item merges into.
    const byModel=new Map<string,Entry[]>();
    const link=(entry:Entry)=>{if(!entry.providerId)return;const key=groupKey(entry.providerId,entry.modelKey);byModel.set(key,[...(byModel.get(key)??[]),entry]);};
    const unlink=(entry:Entry)=>{if(!entry.providerId)return;const key=groupKey(entry.providerId,entry.modelKey);const rest=(byModel.get(key)??[]).filter(other=>other!==entry);if(rest.length)byModel.set(key,rest);else byModel.delete(key);};
    const register=(entry:Entry)=>{byKey.set(keyOf(entry.source,entry.modelRef),entry);link(entry);};
    for(const row of loaded)register({id:row.id,isNew:false,source:row.source,modelRef:row.modelRef,modelKey:row.modelKey||bareModelKey(row.modelRef),providerId:row.providerId,evidence:row.evidence??{}});

    const entries=new Map<string,Entry>(); // every entry that changed, in first-touched order
    let discovered=0;
    for(const item of items){
      const identity=identityOf.get(item)??null;
      const providerId=identity?providerIdOf.get(identity.slug)??null:null;
      if(identity)item.providerName=identity.name;
      if(providerId)touchedProviderIds.add(providerId);
      const modelKey=bareModelKey(item.modelRef);
      const evidence=evidenceFor(item);

      const existing=byKey.get(keyOf(item.source,item.modelRef));
      if(existing){
        // A refresh can change which provider the row belongs to; later same-model lookups must follow it.
        if(existing.providerId!==providerId){unlink(existing);existing.providerId=providerId;link(existing);}
        existing.columns=columnsFor(item,providerId);
        existing.evidence={...existing.evidence,...evidence};
        entries.set(existing.id,existing);discovered++;continue;
      }
      const duplicate=providerId?byModel.get(groupKey(providerId,modelKey))?.[0]:undefined;
      if(duplicate){
        const prior=Array.isArray(duplicate.evidence.corroboratingSources)?duplicate.evidence.corroboratingSources as {source:string;sourceUrl:string}[]:[];
        const corroboratingSources=prior.some(c=>c.source===item.source)?prior:[...prior,{source:item.source,sourceUrl:item.sourceUrl}];
        duplicate.evidence={...duplicate.evidence,corroboratingSources};
        entries.set(duplicate.id,duplicate);discovered++;continue;
      }
      const fresh:Entry={id:randomUUID(),isNew:true,source:item.source,modelRef:item.modelRef,modelKey,providerId,evidence,columns:columnsFor(item,providerId)};
      register(fresh);entries.set(fresh.id,fresh);discovered++;
    }

    const now=new Date();
    const changed=[...entries.values()];
    for(const batch of chunk(changed.filter(entry=>entry.isNew)))
      await tx.insert(modelCandidates).values(batch.map(entry=>({id:entry.id,source:entry.source,modelRef:entry.modelRef,...entry.columns!,lifecycle:"DISCOVERED" as const,evidence:entry.evidence,firstSeenAt:now,lastSeenAt:now,updatedAt:now})));
    for(const batch of chunk(changed.filter(entry=>!entry.isNew&&entry.columns))){
      const payload=JSON.stringify(batch.map(entry=>({id:entry.id,...entry.columns!,evidence:entry.evidence})));
      await tx.execute(sql`update model_candidates m set display_name=v."displayName", provider_name=v."providerName", provider_id=v."providerId", model_key=v."modelKey", lifecycle='DISCOVERED', free_type=v."freeType"::free_type, verified_free=v."verifiedFree", context_window=v."contextWindow", max_output_tokens=v."maxOutputTokens", supports_vision=v."supportsVision", supports_tools=v."supportsTools", supports_reasoning=v."supportsReasoning", source_url=v."sourceUrl", evidence=v.evidence, last_seen_at=now(), updated_at=now() from jsonb_to_recordset(${payload}::jsonb) as v("id" uuid, "displayName" text, "providerName" text, "providerId" uuid, "modelKey" text, "freeType" text, "verifiedFree" boolean, "contextWindow" integer, "maxOutputTokens" integer, "supportsVision" boolean, "supportsTools" boolean, "supportsReasoning" boolean, "sourceUrl" text, evidence jsonb) where m.id=v."id"`);
    }
    for(const batch of chunk(changed.filter(entry=>!entry.isNew&&!entry.columns))){
      const payload=JSON.stringify(batch.map(entry=>({id:entry.id,evidence:entry.evidence})));
      await tx.execute(sql`update model_candidates m set evidence=v.evidence, last_seen_at=now(), updated_at=now() from jsonb_to_recordset(${payload}::jsonb) as v("id" uuid, evidence jsonb) where m.id=v."id"`);
    }
    return discovered;
  });
}

/** Stores what sources say about providers' free offers (docs/DISCOVERY-PIPELINE.md §5), one row per (provider, source).
 *  The provider is decided by attributeOfferProvider — the same single decision point, extended with the slug and the base
 *  URL an offer publishes, because a dataset's marketing name ("Google Gemini API (AI Studio)") rarely spells the provider's
 *  slug. An offer only ever attaches to a provider that already exists (the catalog, or a provider some source listed models
 *  for): the datasets also describe speech, OCR and embedding vendors, and an offer must not conjure those into the
 *  Providers list. Returns how many offers were stored. */
export async function persistProviderOffers(db:ReturnType<typeof getDb>,offers:ProviderOffer[],state:PersistState):Promise<number>{
  if(!offers.length)return 0;
  return db.transaction(async tx=>{
    let stored=0;
    const seen=new Set<string>();
    for(const offer of offers){
      const identity=attributeOfferProvider(offer);
      const providerId=identity?state.providerIdBySlug.get(identity.slug):undefined;
      if(!providerId)continue;
      // Two entries in one dataset can resolve to the same provider; the first one wins so the row is deterministic.
      const key=`${providerId}\u0000${offer.source}`;
      if(seen.has(key))continue;
      seen.add(key);
      const values={providerId,source:offer.source,freeType:offer.freeType,freeTierText:offer.freeTierText??null,rateLimitsText:offer.rateLimitsText??null,notes:offer.notes??null,expiresAt:offer.expiresAt??null,cardRequired:offer.cardRequired??null,phoneRequired:offer.phoneRequired??null,commercialOk:offer.commercialOk??null,openaiBaseUrl:offer.openaiBaseUrl??null,docsUrl:offer.docsUrl??null,sourceVerified:offer.sourceVerified??null,sourceLastVerified:offer.sourceLastVerified??null,observedAt:new Date()};
      await tx.insert(providerOffers).values(values).onConflictDoUpdate({target:[providerOffers.providerId,providerOffers.source],set:values});
      stored++;
    }
    return stored;
  });
}

/** Invalid rows a source returned: no usable id. Counted, never stored, and reported so a source that quietly drops most of
 *  its rows shows up as DEGRADED rather than looking healthy with a smaller number. */
function isUsableItem(item:DiscoveredCandidate){
  const ref=typeof item.modelRef==="string"?item.modelRef.trim():"";
  return ref.length>0&&ref.length<=300&&!/[\u0000-\u001f\u007f]/.test(ref);
}

type SourceOutcome=
  |{sourceId:string;kind:"blocked";reason:string}
  |{sourceId:string;kind:"failed";error:string}
  |{sourceId:string;kind:"ok";items:DiscoveredCandidate[];offers:ProviderOffer[];rejected:number;minExpected:number};

async function fetchSource(source:DiscoverySource):Promise<SourceOutcome>{
  try{
    const result=normalizeDiscoveryResult(await source.discover());
    const catalog=source.providerSlug?catalogIdentity(source.providerSlug):null;
    if(source.providerSlug&&!catalog)return {sourceId:source.id,kind:"failed",error:`Registry names provider "${source.providerSlug}", which is not in the catalog`};
    const seen=new Set<string>();
    const items:DiscoveredCandidate[]=[];
    let rejected=result.rejected;
    for(const item of result.candidates){
      if(!isUsableItem(item)){rejected++;continue;}
      const key=item.modelRef.trim();
      if(seen.has(key))continue;
      seen.add(key);
      // A source that is one provider's own catalog owns every model it lists (I1): its label wins over anything an adapter guessed.
      items.push({...item,modelRef:key,...(catalog?{providerName:catalog.name}:{})});
    }
    return {sourceId:source.id,kind:"ok",items,offers:result.offers,rejected,minExpected:source.minExpected??1};
  }catch(error){
    const message=error instanceof Error?error.message:"Unknown source error";
    return error instanceof SourceBlockedError?{sourceId:source.id,kind:"blocked",reason:message}:{sourceId:source.id,kind:"failed",error:message};
  }
}

/** Runs `worker` over `list` with at most `limit` in flight, keeping results in input order. */
async function mapLimited<T,R>(list:T[],limit:number,worker:(item:T)=>Promise<R>):Promise<R[]>{
  const results:R[]=new Array(list.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,list.length)},async()=>{while(cursor<list.length){const index=cursor++;results[index]=await worker(list[index]!);}}));
  return results;
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
  const state:PersistState={providerIdBySlug:new Map((await db.select({slug:providers.slug,id:providers.id}).from(providers)).map(row=>[row.slug,row.id])),touchedProviderIds:new Set<string>()};
  const outcomes=await mapLimited(activeSources,SOURCE_CONCURRENCY,fetchSource);
  let discovered=0;const sources:Array<Record<string,unknown>>=[];const succeededSourceIds=new Set<string>();
  for(const outcome of outcomes){
    if(outcome.kind==="blocked"){sources.push({source:outcome.sourceId,status:"blocked",reason:outcome.reason});await recordSourceBlocked(outcome.sourceId,outcome.reason);continue}
    if(outcome.kind==="failed"){sources.push({source:outcome.sourceId,status:"failed",error:outcome.error});await recordSourceSync(outcome.sourceId,{ok:false,error:outcome.error});continue}
    const {sourceId:source,items,offers,rejected,minExpected}=outcome;
    // The contract (I4): fewer results than the source reliably returns means it, or its parser, broke. Nothing from a
    // source in that state is trusted or stored — a scraper that starts matching page furniture must not fill the table.
    if(items.length<minExpected){
      const error=`Returned ${items.length} usable models but at least ${minExpected} are expected — the source or its parser may have changed`;
      sources.push({source,status:"failed",error,count:items.length});await recordSourceSync(source,{ok:false,error});continue;
    }
    // One source failing to save (its transaction rolls back) must not abort the sources after it.
    try{discovered+=await persistDiscoveredItems(db,items,state);await persistProviderOffers(db,offers,state);}
    catch(error){const message=error instanceof Error?error.message:"Failed to save discovered models";sources.push({source,status:"failed",error:message});await recordSourceSync(source,{ok:false,error:message});continue}
    const degraded=rejected>0&&rejected/(rejected+items.length)>DEGRADED_REJECT_SHARE;
    const note=degraded?`${rejected} of ${rejected+items.length} rows had no usable model id and were skipped`:null;
    sources.push({source,status:degraded?"degraded":"succeeded",count:items.length,...(offers.length?{offers:offers.length}:{}),...(rejected?{rejected}:{}),...(note?{note}:{})});
    succeededSourceIds.add(source);
    await recordSourceSync(source,{ok:true,count:items.length,degradedReason:note});
  }
  if(state.touchedProviderIds.size)await db.update(providers).set({lastDiscoveryAt:new Date(),updatedAt:new Date()}).where(inArray(providers.id,[...state.touchedProviderIds]));
  const consolidation=await consolidateModelCandidates({succeededSourceIds});
  await reconcileCheckBlockers(db);
  const outcomeCounts={succeeded:sources.filter(s=>s.status==="succeeded"||s.status==="degraded").length,failed:sources.filter(s=>s.status==="failed").length,blocked:sources.filter(s=>s.status==="blocked").length};const summary={discovered,sources,consolidation};
  await db.update(syncRuns).set({status:activeSources.length?discoveryRunStatus(outcomeCounts):"SUCCEEDED",summary,finishedAt:new Date(),updatedAt:new Date()}).where(eq(syncRuns.id,run.id));
  await db.insert(auditEvents).values({actor:"system",action:"discovery.completed",entityType:"sync_run",entityId:run.id,after:summary,correlationId});
  return{runId:run.id,correlationId,...summary};
}
