import "server-only";
import { eq, inArray, and, isNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { candidateChecks, modelCandidates, modelDeployments, providers } from "@/server/db/schema";
import { attributeProvider, catalogIdentity } from "@/server/providers/attribution";
import { bareModelKey, deploymentModelKey } from "./model-key";
import { sourceRegistry } from "./registry";
import { isPlausibleScrapedModelId } from "./sources";
import { recomputeCheckState } from "./check-state";

const activeSourceIds = new Set(sourceRegistry.map(source => source.id));
const ownProviderOfSource = new Map(sourceRegistry.filter(source => source.providerSlug).map(source => [source.id, source.providerSlug!]));
const textCandidateSourceIds = new Set(sourceRegistry.filter(source => source.adapter === "text_candidates").map(source => source.id));
const tierRank: Record<string, number> = Object.fromEntries(sourceRegistry.map(source => [source.id, source.tier === "A1" ? 0 : source.tier === "A2" ? 1 : source.tier === "B" ? 2 : 3]));

/** A model no source has listed for this long, whose own source is working, is gone from the provider: it stops being a candidate. */
export const RETIRE_AFTER_MS = 7 * 24 * 60 * 60_000;

type CandidateRow = typeof modelCandidates.$inferSelect;

/**
 * Keeps the candidate table honest (docs/DISCOVERY-PIPELINE.md I2, I10). Idempotent: on data it has already cleaned it
 * changes nothing, which tests-integration/discovery-pipeline.test.ts asserts by running it twice.
 *
 *  - drops rows from sources the registry no longer has, and scraped hits the current parser would not accept;
 *  - attributes rows that have no provider yet, with the same attributeProvider every writer uses. It NEVER re-derives a
 *    provider a row already has: an earlier version re-resolved from the stored name, failed for most providers, and wiped
 *    the provider id discovery had just written, on every run;
 *  - merges rows that are the same model at the same provider (same provider_id and model_key), keeping every source as
 *    corroboration and moving the check history to the survivor;
 *  - retires models their own source stopped listing (see below).
 *
 * `succeededSourceIds` are the sources that ran successfully in the discovery run calling this. Retirement only ever
 * concerns rows of those sources, so a failing, blocked or paused source can never cause its models to be deleted.
 */
export async function consolidateModelCandidates(options: { succeededSourceIds?: ReadonlySet<string> } = {}) {
  const db = getDb();
  const rows: CandidateRow[] = await db.select().from(modelCandidates);

  const orphaned = rows.filter(row => !activeSourceIds.has(row.source));
  if (orphaned.length) await db.delete(modelCandidates).where(inArray(modelCandidates.id, orphaned.map(row => row.id)));

  const live = rows.filter(row => activeSourceIds.has(row.source));
  const junk = live.filter(row => textCandidateSourceIds.has(row.source) && !isPlausibleScrapedModelId(row.modelRef));
  if (junk.length) await db.delete(modelCandidates).where(inArray(modelCandidates.id, junk.map(row => row.id)));

  const junkIds = new Set(junk.map(row => row.id));
  const survivors = live.filter(row => !junkIds.has(row.id));

  // Rows with no provider yet: decide it once, here, with the shared decision point. Rows that already have one are left alone.
  const providerIdBySlug = new Map((await db.select({slug: providers.slug, id: providers.id}).from(providers)).map(row => [row.slug, row.id]));
  const providerIdOf = new Map<string, string | null>(survivors.map(row => [row.id, row.providerId]));
  let providerIdBackfilled = 0;
  for (const row of survivors.filter(item => !item.providerId)) {
    // A source that is one provider's own catalog owns its rows even when an older run stored no provider name for them.
    const ownSlug = ownProviderOfSource.get(row.source);
    const identity = (ownSlug ? catalogIdentity(ownSlug) : null) ?? attributeProvider(row.providerName, row.modelRef);
    if (!identity) continue;
    let id = providerIdBySlug.get(identity.slug);
    if (!id) {
      await db.insert(providers).values({slug: identity.slug, name: identity.name, adapterKey: identity.adapterKey, adapterCapability: identity.adapterCapability, origin: identity.origin}).onConflictDoNothing();
      id = (await db.select({id: providers.id}).from(providers).where(eq(providers.slug, identity.slug)).limit(1))[0]?.id;
      if (id) providerIdBySlug.set(identity.slug, id);
    }
    if (!id) continue;
    await db.update(modelCandidates).set({providerId: id, updatedAt: new Date()}).where(eq(modelCandidates.id, row.id));
    providerIdOf.set(row.id, id);
    providerIdBackfilled++;
  }

  // Same model at the same provider.
  const groups = new Map<string, CandidateRow[]>();
  for (const row of survivors) {
    const providerId = providerIdOf.get(row.id);
    if (!providerId) continue;
    const key = `${providerId}::${row.modelKey || bareModelKey(row.modelRef)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  let merged = 0; let groupsMerged = 0; const mergedWinnerIds: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [winner, ...losers] = [...group].sort((a, b) => {
      if (a.verifiedFree !== b.verifiedFree) return a.verifiedFree ? -1 : 1;
      const aTested = Boolean(a.lastCheckedAt), bTested = Boolean(b.lastCheckedAt);
      if (aTested !== bTested) return aTested ? -1 : 1;
      const ta = tierRank[a.source] ?? 4, tb = tierRank[b.source] ?? 4;
      if (ta !== tb) return ta - tb;
      return a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.id.localeCompare(b.id);
    });
    const prior = Array.isArray(winner.evidence.corroboratingSources) ? winner.evidence.corroboratingSources as {source: string; sourceUrl: string}[] : [];
    const seen = new Set(prior.map(item => item.source));
    const corroboratingSources = [...prior];
    for (const loser of losers) if (!seen.has(loser.source) && loser.source !== winner.source) { corroboratingSources.push({source: loser.source, sourceUrl: loser.sourceUrl ?? ""}); seen.add(loser.source); }
    const loserIds = losers.map(loser => loser.id);
    // The survivor inherits a promotion stamp if it has none of its own: "added" is a fact about the model, not the row.
    const stamped = [winner, ...losers].find(row => row.addedToLitellmAt);
    await db.update(candidateChecks).set({candidateId: winner.id}).where(inArray(candidateChecks.candidateId, loserIds));
    await db.update(modelCandidates).set({
      providerId: providerIdOf.get(winner.id) ?? null, evidence: {...winner.evidence, corroboratingSources},
      firstSeenAt: new Date(Math.min(...group.map(row => row.firstSeenAt.getTime()))),
      ...(stamped && !winner.addedToLitellmAt ? {addedToLitellmAt: stamped.addedToLitellmAt, addedBy: stamped.addedBy} : {}),
      updatedAt: new Date(),
    }).where(eq(modelCandidates.id, winner.id));
    await db.delete(modelCandidates).where(inArray(modelCandidates.id, loserIds));
    merged += losers.length; groupsMerged += 1; mergedWinnerIds.push(winner.id);
  }
  // The history now holds both timelines, so the summary columns are recomputed from it rather than trusted.
  await recomputeCheckState(db, mergedWinnerIds);

  const retired = await retireUnlistedModels(db, options.succeededSourceIds ?? new Set());

  return {orphanedRemoved: orphaned.length, junkRemoved: junk.length, duplicatesMerged: merged, groupsMerged, providerIdBackfilled, retired};
}

/** A provider withdraws a model; the next successful listing simply no longer has it, and nothing else ever touches its row.
 *  Without this it would sit in the table forever failing its checks. A row is retired only when ALL hold:
 *   - its own source ran successfully in this run (a failing, blocked or paused source never causes a deletion);
 *   - no source has listed it for RETIRE_AFTER_MS (a merged row is refreshed by any source that lists it, so a model still
 *     listed anywhere stays);
 *   - it is not in LiteLLM in any state and was never added — the deployment's history must not lose its candidate. */
async function retireUnlistedModels(db: ReturnType<typeof getDb>, succeededSourceIds: ReadonlySet<string>): Promise<number> {
  if (!succeededSourceIds.size) return 0;
  const deployments = await db.select({providerId: modelDeployments.providerId, providerModelId: modelDeployments.providerModelId}).from(modelDeployments);
  const inLiteLLM = new Set(deployments.map(row => `${row.providerId}::${deploymentModelKey(row.providerModelId)}`));
  const stale = await db.select({id: modelCandidates.id, providerId: modelCandidates.providerId, modelKey: modelCandidates.modelKey}).from(modelCandidates)
    .where(and(inArray(modelCandidates.source, [...succeededSourceIds]), sql`${modelCandidates.lastSeenAt} < now() - (${RETIRE_AFTER_MS} * interval '1 millisecond')`, isNull(modelCandidates.addedToLitellmAt)));
  const doomed = stale.filter(row => !(row.providerId && inLiteLLM.has(`${row.providerId}::${row.modelKey}`))).map(row => row.id);
  for (const batch of Array.from({length: Math.ceil(doomed.length / 500)}, (_, i) => doomed.slice(i * 500, (i + 1) * 500)))
    await db.delete(modelCandidates).where(inArray(modelCandidates.id, batch));
  return doomed.length;
}
