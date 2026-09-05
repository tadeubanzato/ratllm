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
  await db.insert(modelSources).values(missing.map(source => ({name: source.name, type: "CUSTOM_ADAPTER" as const, url: source.url, enabled: true, priority: source.tier === "A1" ? 10 : source.tier === "A2" ? 20 : source.tier === "B" ? 30 : 40, adapterReference: source.id})));
}

export async function getEnabledAdapterIds(): Promise<Set<string>> {
  const rows = await getDb().select({adapterReference: modelSources.adapterReference}).from(modelSources).where(eq(modelSources.enabled, true));
  return new Set(rows.map(row => row.adapterReference).filter((value): value is string => Boolean(value)));
}

export async function recordSourceSync(adapterReference: string, result: {ok: true; count: number} | {ok: false; error: string}) {
  await getDb().update(modelSources).set({
    status: result.ok ? "HEALTHY" : "FAILED",
    lastSyncAt: new Date(),
    ...(result.ok ? {discoveredModelCount: result.count} : {}),
    updatedAt: new Date(),
  }).where(eq(modelSources.adapterReference, adapterReference));
}
