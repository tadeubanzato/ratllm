import "server-only";
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelSources, providers, sourceChecks } from "@/server/db/schema";
import { sourceRegistry, type SourceConfig } from "./registry";

function priorityFor(tier: SourceConfig["tier"]): number {
  return tier === "A1" ? 10 : 20;
}

/** Makes the `model_sources` table match the registry (docs/DISCOVERY-PIPELINE.md invariant I5).
 *
 *  The registry in code is the truth for what a source *is* (name, URL, priority, the provider it belongs to); the database
 *  row holds only operator state (enabled, last run). So every run:
 *   - rows for an adapter the registry no longer has are removed. This used to be a hand-maintained list of retired ids, which
 *     drifted: ten sources that no longer run kept showing as HEALTHY on the Settings page;
 *   - registry entries without a row are created (`enabled` comes from the registry only at creation, never afterwards: it is
 *     an operator toggle);
 *   - name, URL, priority and the provider link of existing rows are re-synced, so fixing a URL in code reaches an
 *     already-seeded database instead of silently doing nothing.
 *  Rows with no adapter reference are operator-created custom sources and are left alone. */
export async function ensureModelSources() {
  const db = getDb();
  const registryIds = sourceRegistry.map(source => source.id);
  await db.delete(modelSources).where(and(isNotNull(modelSources.adapterReference), notInArray(modelSources.adapterReference, registryIds)));

  const slugs = [...new Set(sourceRegistry.map(source => source.providerSlug).filter((slug): slug is string => Boolean(slug)))];
  const providerIdBySlug = new Map((slugs.length ? await db.select({slug: providers.slug, id: providers.id}).from(providers).where(inArray(providers.slug, slugs)) : []).map(row => [row.slug, row.id]));
  const providerIdFor = (source: SourceConfig) => (source.providerSlug ? providerIdBySlug.get(source.providerSlug) ?? null : null);

  const existing = await db.select({adapterReference: modelSources.adapterReference}).from(modelSources).where(isNotNull(modelSources.adapterReference));
  const have = new Set(existing.map(row => row.adapterReference));
  const missing = sourceRegistry.filter(source => !have.has(source.id));
  if (missing.length) {
    await db.insert(modelSources).values(missing.map(source => ({name: source.name, type: "CUSTOM_ADAPTER" as const, url: source.url, enabled: source.defaultEnabled ?? true, priority: priorityFor(source.tier), adapterReference: source.id, providerId: providerIdFor(source)})));
  }
  for (const source of sourceRegistry.filter(item => have.has(item.id))) {
    await db.update(modelSources).set({name: source.name, url: source.url, priority: priorityFor(source.tier), providerId: providerIdFor(source), updatedAt: new Date()}).where(eq(modelSources.adapterReference, source.id));
  }
}

export async function getEnabledAdapterIds(): Promise<Set<string>> {
  const rows = await getDb().select({adapterReference: modelSources.adapterReference}).from(modelSources).where(eq(modelSources.enabled, true));
  return new Set(rows.map(row => row.adapterReference).filter((value): value is string => Boolean(value)));
}

/** Last-sync timestamps for enabled sources, keyed by adapter id. */
export async function getEnabledSourceLastSync(): Promise<Map<string, Date | null>> {
  const rows = await getDb().select({adapterReference: modelSources.adapterReference, lastSyncAt: modelSources.lastSyncAt}).from(modelSources).where(eq(modelSources.enabled, true));
  return new Map(rows.filter((row): row is typeof row & {adapterReference: string} => Boolean(row.adapterReference)).map(row => [row.adapterReference, row.lastSyncAt]));
}

/** Records one source's outcome. Status vocabulary (docs/DISCOVERY-PIPELINE.md §4): HEALTHY, DEGRADED (it works, but rows
 *  were skipped), FAILED. BLOCKED is recorded separately because it is not an outcome of a run that happened. */
export async function recordSourceSync(adapterReference: string, result: {ok: true; count: number; degradedReason?: string | null} | {ok: false; error: string}) {
  const db = getDb();
  const now = new Date();
  const sourceRow = await db.select({id: modelSources.id, providerId: modelSources.providerId}).from(modelSources).where(eq(modelSources.adapterReference, adapterReference)).limit(1);
  if (!sourceRow.length) return;
  const {id: sourceId, providerId} = sourceRow[0];
  const status = !result.ok ? "FAILED" : result.degradedReason ? "DEGRADED" : "HEALTHY";
  await db.insert(sourceChecks).values({
    sourceId, providerId, status,
    ...(result.ok ? {discoveredCount: result.count, ...(result.degradedReason ? {error: result.degradedReason} : {})} : {error: result.error}),
    createdAt: now,
  }).onConflictDoNothing();
  await db.update(modelSources).set({
    status, lastSyncAt: now, updatedAt: now,
    lastError: result.ok ? result.degradedReason ?? null : result.error,
    ...(result.ok ? {discoveredModelCount: result.count, lastSuccessAt: now} : {}),
  }).where(eq(modelSources.adapterReference, adapterReference));
}

/** A source that couldn't run because something it needs isn't configured. Deliberately leaves `last_sync_at` alone, so
 *  it is tried again on the very next run instead of waiting out its refresh interval. */
export async function recordSourceBlocked(adapterReference: string, reason?: string) {
  await getDb().update(modelSources).set({status: "BLOCKED", lastError: reason ?? null, updatedAt: new Date()}).where(eq(modelSources.adapterReference, adapterReference));
}
