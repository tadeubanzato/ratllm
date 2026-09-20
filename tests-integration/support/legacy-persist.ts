// REFERENCE IMPLEMENTATION — the naive, one-query-per-item way to persist discovery, kept as a test oracle. The differential
// test in ../discovery-persist-differential.test.ts checks that the optimized production version produces exactly the same
// rows as this one. It implements the current semantics (docs/DISCOVERY-PIPELINE.md I1, I3, I10): the provider is decided by
// attributeProvider, a model is identified by (provider_id, model_key). Do not "improve" this file; it exists to stay slow
// and obviously correct, and it deliberately shares no code with run.ts beyond the pure decision functions.
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates, providers } from "@/server/db/schema";
import { attributeProvider } from "@/server/providers/attribution";
import { bareModelKey } from "@/server/discovery/model-key";
import { nonChatModelReason } from "@/server/discovery/model-type";
import type { DiscoveredCandidate } from "@/server/discovery/types";

export interface LegacyPersistState{providerIdBySlug:Map<string,string>;touchedProviderIds:Set<string>}

const positiveOrNull=(value:number|undefined|null)=>typeof value==="number"&&Number.isFinite(value)&&value>0?value:null;

export async function legacyPersistDiscoveredItems(db:ReturnType<typeof getDb>,items:DiscoveredCandidate[],state:LegacyPersistState):Promise<number>{
  const {providerIdBySlug,touchedProviderIds}=state;let discovered=0;
  for(const item of items){
    const identity=attributeProvider(item.providerName,item.modelRef);
    if(identity){
      await db.insert(providers).values({slug:identity.slug,name:identity.name,adapterKey:identity.adapterKey,adapterCapability:identity.adapterCapability,origin:identity.origin}).onConflictDoNothing();
      item.providerName=identity.name;
      if(!providerIdBySlug.has(identity.slug)){const[row]=await db.select({id:providers.id}).from(providers).where(eq(providers.slug,identity.slug)).limit(1);if(row)providerIdBySlug.set(identity.slug,row.id);}
    }
    const providerId=identity?providerIdBySlug.get(identity.slug)??null:null;
    if(providerId)touchedProviderIds.add(providerId);
    const modelKey=bareModelKey(item.modelRef);
    const description=typeof item.evidence?.description==="string"?item.evidence.description:null;
    const evidence={...item.evidence,nonChatReason:item.nonChatReason??nonChatModelReason({modelRef:item.modelRef,displayName:item.displayName,description})??null};
    const values={displayName:item.displayName,providerName:item.providerName??null,providerId,modelKey,lifecycle:"DISCOVERED" as const,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:positiveOrNull(item.contextWindow),maxOutputTokens:positiveOrNull(item.maxOutputTokens),supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl??null};

    // A candidate is one model at one provider as one source lists it. A row this source stored before the provider was known is
    // this same candidate, now attributed.
    const sameSource=and(eq(modelCandidates.source,item.source),eq(modelCandidates.modelRef,item.modelRef));
    const existing=(await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence}).from(modelCandidates).where(and(sameSource,providerId?eq(modelCandidates.providerId,providerId):isNull(modelCandidates.providerId))).limit(1))[0]
      ?? (providerId?(await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence}).from(modelCandidates).where(and(sameSource,isNull(modelCandidates.providerId))).limit(1))[0]:undefined);
    if(existing){await db.update(modelCandidates).set({...values,evidence:{...existing.evidence,...evidence},lastSeenAt:new Date(),updatedAt:new Date()}).where(eq(modelCandidates.id,existing.id));discovered++;continue;}

    // The same model at the same provider, from any source (deliberately including this one, under a different spelling).
    const duplicate=providerId?(await db.select({id:modelCandidates.id,source:modelCandidates.source,evidence:modelCandidates.evidence}).from(modelCandidates).where(and(eq(modelCandidates.providerId,providerId),eq(modelCandidates.modelKey,modelKey))).orderBy(asc(modelCandidates.firstSeenAt),asc(modelCandidates.createdAt)).limit(1))[0]:undefined;
    if(duplicate){
      const prior=Array.isArray(duplicate.evidence.corroboratingSources)?duplicate.evidence.corroboratingSources as {source:string;sourceUrl:string}[]:[];
      const corroboratingSources=prior.some(c=>c.source===item.source)||item.source===duplicate.source?prior:[...prior,{source:item.source,sourceUrl:item.sourceUrl}];
      await db.update(modelCandidates).set({evidence:{...duplicate.evidence,corroboratingSources},lastSeenAt:new Date(),updatedAt:new Date()}).where(eq(modelCandidates.id,duplicate.id));
      discovered++;continue;
    }
    await db.insert(modelCandidates).values({source:item.source,modelRef:item.modelRef,...values,evidence});
    discovered++;
  }
  return discovered;
}
