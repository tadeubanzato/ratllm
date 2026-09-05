import "server-only";
import { eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelSources } from "@/server/db/schema";
import { discoverySourceInfo } from "./sources";

/** Seeds a Settings → Free Model Sources row for each built-in scouting source that isn't represented yet. Idempotent: never touches a row a user has already edited. */
export async function ensureModelSources() {
  const db = getDb();
  const existing = await db.select({adapterReference: modelSources.adapterReference}).from(modelSources).where(isNotNull(modelSources.adapterReference));
  const have = new Set(existing.map(row => row.adapterReference));
  const missing = discoverySourceInfo.filter(source => !have.has(source.id));
  if (!missing.length) return;
  await db.insert(modelSources).values(missing.map(source => ({name: source.name, type: "CUSTOM_ADAPTER" as const, url: source.url, enabled: true, priority: 100, adapterReference: source.id})));
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
