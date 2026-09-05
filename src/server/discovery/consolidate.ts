import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { candidateChecks, modelCandidates } from "@/server/db/schema";
import { resolveProvider } from "@/server/providers/catalog";
import { bareModelKey } from "./model-key";
import { sourceRegistry } from "./registry";
import { isPlausibleScrapedModelId } from "./sources";

const activeSourceIds = new Set(sourceRegistry.map(source => source.id));
const textCandidateSourceIds = new Set(sourceRegistry.filter(source => source.adapter === "text_candidates").map(source => source.id));
const tierRank: Record<string, number> = Object.fromEntries(sourceRegistry.map(source => [source.id, source.tier === "A1" ? 0 : source.tier === "A2" ? 1 : source.tier === "B" ? 2 : 3]));

type CandidateRow = typeof modelCandidates.$inferSelect;

/**
 * Cleans up the accumulated discovery candidate table: drops rows from
 * retired/renamed sources, drops scraped hits the current parser quality
 * filters would no longer accept, and merges same-provider/same-model
 * duplicates that different community sources report under slightly
 * different spellings into a single row (keeping every source as
 * corroboration on the survivor rather than losing the signal).
 */
export async function consolidateModelCandidates() {
  const db = getDb();
  const rows: CandidateRow[] = await db.select().from(modelCandidates);

  const orphaned = rows.filter(row => !activeSourceIds.has(row.source));
  if (orphaned.length) await db.delete(modelCandidates).where(inArray(modelCandidates.id, orphaned.map(row => row.id)));

  const live = rows.filter(row => activeSourceIds.has(row.source));
  const junk = live.filter(row => textCandidateSourceIds.has(row.source) && !isPlausibleScrapedModelId(row.modelRef));
  if (junk.length) await db.delete(modelCandidates).where(inArray(modelCandidates.id, junk.map(row => row.id)));

  const junkIds = new Set(junk.map(row => row.id));
  const survivors = live.filter(row => !junkIds.has(row.id));
  const groups = new Map<string, CandidateRow[]>();
  for (const row of survivors) {
    const provider = resolveProvider(row.providerName, row.modelRef);
    if (!provider) continue;
    const key = `${provider.slug}::${bareModelKey(row.modelRef)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  let merged = 0; let groupsMerged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [winner, ...losers] = [...group].sort((a, b) => {
      if (a.verifiedFree !== b.verifiedFree) return a.verifiedFree ? -1 : 1;
      const aTested = Boolean(a.evidence.testedAt), bTested = Boolean(b.evidence.testedAt);
      if (aTested !== bTested) return aTested ? -1 : 1;
      const ta = tierRank[a.source] ?? 4, tb = tierRank[b.source] ?? 4;
      if (ta !== tb) return ta - tb;
      return a.firstSeenAt.getTime() - b.firstSeenAt.getTime();
    });
    const prior = Array.isArray(winner.evidence.corroboratingSources) ? winner.evidence.corroboratingSources as {source: string; sourceUrl: string}[] : [];
    const seen = new Set(prior.map(item => item.source));
    const corroboratingSources = [...prior];
    for (const loser of losers) if (!seen.has(loser.source)) { corroboratingSources.push({source: loser.source, sourceUrl: loser.sourceUrl ?? ""}); seen.add(loser.source); }
    const loserIds = losers.map(loser => loser.id);
    await db.update(candidateChecks).set({candidateId: winner.id}).where(inArray(candidateChecks.candidateId, loserIds));
    await db.update(modelCandidates).set({evidence: {...winner.evidence, corroboratingSources}, updatedAt: new Date()}).where(eq(modelCandidates.id, winner.id));
    await db.delete(modelCandidates).where(inArray(modelCandidates.id, loserIds));
    merged += losers.length; groupsMerged += 1;
  }

  return {orphanedRemoved: orphaned.length, junkRemoved: junk.length, duplicatesMerged: merged, groupsMerged};
}
