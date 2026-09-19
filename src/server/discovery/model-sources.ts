import "server-only";
import { eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelSources } from "@/server/db/schema";
import { sourceRegistry } from "./registry";

/** IDs from a previous, smaller registry version. Superseded by more specific entries in sourceRegistry, so their rows are cleaned up rather than left as orphaned duplicates. */
const DEPRECATED_ADAPTER_IDS = ["litellm-cost-map", "community-lists"];

/** Seeds a Settings → Free Model Sources row for each registry source that isn't represented yet. Idempotent: never touches a row a user has already edited. */
export async function ensureModelSources() {
  const db = getDb();
  await db.delete(modelSources).where(inArray(modelSources.adapterReference, DEPRECATED_ADAPTER_IDS));
  const existing = await db.select({adapterReference: modelSources.adapterReference}).from(modelSources).where(isNotNull(modelSources.adapterReference));
  const have = new Set(existing.map(row => row.adapterReference));
  const missing = sourceRegistry.filter(source => !have.has(source.id));
  if (!missing.length) return;
  await db.insert(modelSources).values(missing.map(source => ({name: source.name, type: "CUSTOM_ADAPTER" as const, url: source.url, enabled: source.defaultEnabled ?? true, priority: source.tier === "A1" ? 10 : source.tier === "A2" ? 20 : source.tier === "B" ? 30 : 40, adapterReference: source.id})));
}

export async function getEnabledAdapterIds(): Promise<Set<string>> {
  const rows = await getDb().select({adapterReference: modelSources.adapterReference}).from(modelSources).where(eq(modelSources.enabled, true));
  return new Set(rows.map(row => row.adapterReference).filter((value): value is string => Boolean(value)));
}

/** Last-sync timestamps for enabled sources, keyed by adapter id — lets a caller decide which sources are actually
 *  due for a refresh (per-source refreshHours) instead of always re-fetching everything on every discovery pass. */
export async function getEnabledSourceLastSync(): Promise<Map<string, Date | null>> {
  const rows = await getDb().select({adapterReference: modelSources.adapterReference, lastSyncAt: modelSources.lastSyncAt}).from(modelSources).where(eq(modelSources.enabled, true));
  return new Map(rows.filter((row): row is typeof row & {adapterReference: string} => Boolean(row.adapterReference)).map(row => [row.adapterReference, row.lastSyncAt]));
}

export async function recordSourceSync(adapterReference: string, result: {ok: true; count: number} | {ok: false; error: string}) {
  await getDb().update(modelSources).set({
    status: result.ok ? (result.count > 0 ? "HEALTHY" : "DEGRADED") : "FAILED",
    lastSyncAt: new Date(),
    ...(result.ok ? {discoveredModelCount: result.count} : {}),
    updatedAt: new Date(),
  }).where(eq(modelSources.adapterReference, adapterReference));
}

/** A source that couldn't run because something it needs isn't configured. Deliberately leaves `lastSyncAt` alone: that
 *  timestamp drives the refresh interval, and resetting it would delay the first real fetch by a full interval after the
 *  credential is added. */
export async function recordSourceBlocked(adapterReference: string) {
  await getDb().update(modelSources).set({status: "BLOCKED", updatedAt: new Date()}).where(eq(modelSources.adapterReference, adapterReference));
}
