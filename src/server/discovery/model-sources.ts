import "server-only";
import { eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelSources, providers, sourceChecks } from "@/server/db/schema";
import { sourceRegistry, type SourceConfig } from "./registry";

/** IDs from a previous, smaller registry version, or retired/renamed in a later rewrite — superseded by (or removed
 *  without replacement in) sourceRegistry. Rows for these ids are deleted on every ensureModelSources() run rather
 *  than left as orphaned duplicates that keep failing forever. */
const DEPRECATED_ADAPTER_IDS = [
  "litellm-cost-map", "community-lists",
  // superseded by "litellm_costmap" (2026-09-19 registry rewrite)
  "litellm",
  // retired sources, per registry.ts's 2026-09-19 audit comment (GitHub Models retired 2026-07-30; OVHcloud's
  // api.ovhcloud.ai unreachable since added) — never actually removed from the DB, so they kept failing every cycle
  "github_models", "ovhcloud",
  // no longer present in any known past or current registry revision; stale leftovers
  "aion_labs", "llm7_models", "opencode_zen_models", "sambanova_cloud", "scaleway_models",
];

function priorityFor(tier: SourceConfig["tier"]): number {
  return tier === "A1" ? 10 : 20;
}

/** Maps adapterReference values to provider slugs for sources that correspond 1:1 to a single provider. */
const ADAPTER_TO_PROVIDER_SLUG: Readonly<Record<string, string>> = {
  groq: "groq", cerebras: "cerebras", nvidia_nim: "nvidia", gemini: "google-ai-studio",
  openrouter: "openrouter", mistral_models: "mistral", huggingface: "hugging-face",
  kilo: "kilo", minimax: "minimax", vercel_ai_gateway: "vercel-ai-gateway",
  cohere_models: "cohere", deepseek: "deepseek", zai: "zhipu",
  alibaba: "alibaba-model-studio", cloudflare_workers_ai: "cloudflare-workers-ai",
  freellm_models: "freellm-models", freellm_providers: "freellm-providers",
  litellm: "litellm", models_dev: "models-dev", tatn: "tatn", cheahjs: "cheahjs",
  xyzs996: "xyzs996", ailookup: "ailookup", cybirdd: "cybirdd",
  freellmapi: "freellmapi", freellmapihub: "freellmapihub",
};

/** One-time backfill: sets provider_id on modelSources rows whose adapterReference maps to a known provider. */
export async function backfillModelSourceProviderIds() {
  const db = getDb();
  const slugToId = new Map<string, string>();
  const slugs = Object.values(ADAPTER_TO_PROVIDER_SLUG);
  const rows = await db.select({slug: providers.slug, id: providers.id}).from(providers).where(inArray(providers.slug, slugs));
  for (const row of rows) slugToId.set(row.slug, row.id);
  const toUpdate = Object.entries(ADAPTER_TO_PROVIDER_SLUG)
    .filter(([, slug]) => slugToId.has(slug))
    .map(([adapterRef, slug]) => ({adapterReference: adapterRef, providerId: slugToId.get(slug)!}));
  if (!toUpdate.length) return;
  for (const u of toUpdate) {
    const existing = await db.select({providerId: modelSources.providerId}).from(modelSources).where(eq(modelSources.adapterReference, u.adapterReference)).limit(1);
    if (existing.length && existing[0].providerId !== null) continue;
    await db.update(modelSources).set({providerId: u.providerId}).where(eq(modelSources.adapterReference, u.adapterReference));
  }
}

/** Seeds a Settings → Free Model Sources row for each registry source that isn't represented yet, and keeps the
 *  registry-owned fields (name/url/priority) of existing rows in sync with the registry. `enabled` is deliberately
 *  never touched here — it's an operator toggle in the settings UI, not something the registry seeds — so a fix to a
 *  source's URL in code actually reaches an already-seeded database instead of silently no-op'ing forever. */
export async function ensureModelSources() {
  const db = getDb();
  await db.delete(modelSources).where(inArray(modelSources.adapterReference, DEPRECATED_ADAPTER_IDS));
  const existing = await db.select({adapterReference: modelSources.adapterReference}).from(modelSources).where(isNotNull(modelSources.adapterReference));
  const have = new Set(existing.map(row => row.adapterReference));
  const missing = sourceRegistry.filter(source => !have.has(source.id));
  if (missing.length) {
    await db.insert(modelSources).values(missing.map(source => ({name: source.name, type: "CUSTOM_ADAPTER" as const, url: source.url, enabled: source.defaultEnabled ?? true, priority: priorityFor(source.tier), adapterReference: source.id})));
  }
  const toSync = sourceRegistry.filter(source => have.has(source.id));
  for (const source of toSync) {
    await db.update(modelSources).set({name: source.name, url: source.url, priority: priorityFor(source.tier), updatedAt: new Date()}).where(eq(modelSources.adapterReference, source.id));
  }
  await backfillModelSourceProviderIds();
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

export async function recordSourceSync(adapterReference: string, result: {ok: true; count: number} | {ok: false; error: string}) {
  const db = getDb();
  const now = new Date();
  const sourceRow = await db.select({id: modelSources.id, providerId: modelSources.providerId}).from(modelSources).where(eq(modelSources.adapterReference, adapterReference)).limit(1);
  if (!sourceRow.length) return;
  const {id: sourceId, providerId} = sourceRow[0];
  await db.insert(sourceChecks).values({
    sourceId, providerId,
    status: result.ok ? (result.count > 0 ? "HEALTHY" : "DEGRADED") : "FAILED",
    ...(result.ok ? {discoveredCount: result.count} : {}),
    ...(result.ok ? {} : {error: result.error}),
    createdAt: now,
  }).onConflictDoNothing();
  await db.update(modelSources).set({
    status: result.ok ? (result.count > 0 ? "HEALTHY" : "DEGRADED") : "FAILED",
    lastSyncAt: now,
    ...(result.ok ? {discoveredModelCount: result.count} : {}),
    updatedAt: now,
  }).where(eq(modelSources.adapterReference, adapterReference));
}

/** A source that couldn't run because something it needs isn't configured. */
export async function recordSourceBlocked(adapterReference: string) {
  await getDb().update(modelSources).set({status: "BLOCKED", updatedAt: new Date()}).where(eq(modelSources.adapterReference, adapterReference));
}
