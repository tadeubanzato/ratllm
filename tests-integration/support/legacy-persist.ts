// FROZEN REFERENCE IMPLEMENTATION — the original one-query-per-item discovery persistence, kept verbatim as a test oracle.
// The differential test in ../discovery-persist-differential.test.ts checks that the optimized production version
// produces exactly the same rows as this one. Do not "improve" this file; it exists to stay slow and obviously correct.
import { eq,and } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates,providers } from "@/server/db/schema";
import { resolveProvider } from "@/server/providers/catalog";
import { bareModelKey } from "@/server/discovery/model-key";
import type { DiscoveredCandidate } from "@/server/discovery/types";

/** When another row (same source under a different spelling, or a different source entirely) already covers this model for this provider, merge it in as corroboration instead of creating a near-duplicate row. Deliberately does not exclude the current source: a single text-scraped page can list the same model twice under slightly different spellings, and the exact (source, modelRef) check above this call only catches an identical spelling. */
async function findDuplicateCandidate(db:ReturnType<typeof getDb>,providerName:string,modelRef:string){
  const key=bareModelKey(modelRef);
  const rows=await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence,modelRef:modelCandidates.modelRef}).from(modelCandidates).where(eq(modelCandidates.providerName,providerName));
  return rows.find(row=>bareModelKey(row.modelRef)===key)??null;
}

export interface LegacyPersistState{providerIdBySlug:Map<string,string>;touchedProviderIds:Set<string>}

/** Writes one source's discovered items into model_candidates (insert, refresh, or merge into a same-model duplicate) and
 *  returns how many items were persisted. Mutates `state` so later sources in the same run reuse resolved provider ids. */
export async function legacyPersistDiscoveredItems(db:ReturnType<typeof getDb>,items:DiscoveredCandidate[],state:LegacyPersistState):Promise<number>{
  const {providerIdBySlug,touchedProviderIds}=state;let discovered=0;
  for(const item of items){
    const provider=resolveProvider(item.providerName,item.modelRef);
    if(provider){
      await db.insert(providers).values(provider).onConflictDoNothing();
      item.providerName=provider.name;
      if(!providerIdBySlug.has(provider.slug)){const[row]=await db.select({id:providers.id}).from(providers).where(eq(providers.slug,provider.slug)).limit(1);if(row)providerIdBySlug.set(provider.slug,row.id);}
    }
    const providerId=provider?providerIdBySlug.get(provider.slug)??null:null;
    if(providerId)touchedProviderIds.add(providerId);
    const existing=(await db.select({id:modelCandidates.id,evidence:modelCandidates.evidence}).from(modelCandidates).where(and(eq(modelCandidates.source,item.source),eq(modelCandidates.modelRef,item.modelRef))).limit(1))[0];
    if(existing){const values={displayName:item.displayName,providerName:item.providerName??null,providerId,lifecycle:"DISCOVERED" as const,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:item.contextWindow??null,maxOutputTokens:item.maxOutputTokens??null,supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl,evidence:{...(existing.evidence??{}),...item.evidence},lastSeenAt:new Date(),updatedAt:new Date()};await db.update(modelCandidates).set(values).where(eq(modelCandidates.id,existing.id));discovered++;continue;}
    const duplicate=provider?await findDuplicateCandidate(db,provider.name,item.modelRef):null;
    if(duplicate){const prior=Array.isArray(duplicate.evidence.corroboratingSources)?duplicate.evidence.corroboratingSources as {source:string;sourceUrl:string}[]:[];const corroboratingSources=prior.some(c=>c.source===item.source)?prior:[...prior,{source:item.source,sourceUrl:item.sourceUrl}];await db.update(modelCandidates).set({providerId,evidence:{...duplicate.evidence,corroboratingSources},lastSeenAt:new Date(),updatedAt:new Date()}).where(eq(modelCandidates.id,duplicate.id));discovered++;continue;}
    await db.insert(modelCandidates).values({source:item.source,modelRef:item.modelRef,displayName:item.displayName,providerName:item.providerName??null,providerId,lifecycle:"DISCOVERED" as const,freeType:item.freeType,verifiedFree:item.verifiedFree,contextWindow:item.contextWindow??null,maxOutputTokens:item.maxOutputTokens??null,supportsVision:item.supportsVision??null,supportsTools:item.supportsTools??null,supportsReasoning:item.supportsReasoning??null,sourceUrl:item.sourceUrl,evidence:item.evidence,lastSeenAt:new Date(),updatedAt:new Date()});
    discovered++;
  }
  return discovered;
}

