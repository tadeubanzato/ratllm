import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { getDb } from "@/server/db/client";
import { modelCandidates, providers } from "@/server/db/schema";
import { persistDiscoveredItems } from "@/server/discovery/run";
import type { DiscoveredCandidate } from "@/server/discovery/types";
import { legacyPersistDiscoveredItems } from "./support/legacy-persist";

// Count every statement the server sends, by installing a counting client before anything calls getDb().
let statements = 0;
(globalThis as unknown as { sqlClient?: unknown }).sqlClient = postgres(process.env.DATABASE_URL!, { max: 5, prepare: false, debug: () => { statements++; } });

/** Small deterministic PRNG so a failure reproduces exactly from its seed. */
function rng(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

const MODELS = ["llama-3.3-70b-versatile", "llama3.1-8b", "gemma2-9b-it", "qwen-2.5-32b", "mixtral-8x7b", "deepseek-r1", "whisper-large-v3", "gpt-oss-20b"];
const PROVIDERS = ["Groq", "Cerebras", "Nonexistent Corp", undefined];
const SOURCES = ["src-a", "src-b", "src-c", "src-d"];
const FREE = ["FREE_TIER", "UNKNOWN", "RECURRING_CREDIT", "TRIAL_QUOTA", "PROVIDER_SPECIFIC_FREE"] as const;

function generate(seed: number, count: number): DiscoveredCandidate[] {
  const r = rng(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(r() * list.length)];
  return Array.from({ length: count }, (_, i) => {
    const base = pick(MODELS);
    const variant = pick(["", "groq/", "GROQ/", "cerebras/", "models/"]);
    const source = pick(SOURCES);
    const modelRef = `${variant}${base}`;
    // A real source reports the same provider for the same model every time. (If one (source, model) flipped providers
    // between sightings, two rows could end up sharing a provider and model key, and which of them a later item merges
    // into would depend on PostgreSQL's unordered scan — unspecified, so not something to compare.)
    const providerName = PROVIDERS[[...`${source}|${modelRef}`].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PROVIDERS.length];
    const out: DiscoveredCandidate = {
      source, modelRef, displayName: `Name ${i} ${base}`, providerName,
      freeType: pick(FREE), verifiedFree: r() < 0.3, sourceUrl: `https://${source}.example/${i}`,
      evidence: { i, tag: pick(["x", "y", "z"]), ...(r() < 0.5 ? { extra: { nested: i % 7 } } : {}) },
    };
    if (r() < 0.6) out.contextWindow = 1000 * (1 + Math.floor(r() * 200));
    if (r() < 0.3) out.maxOutputTokens = 512 * (1 + Math.floor(r() * 8));
    if (r() < 0.5) out.supportsVision = r() < 0.5;
    if (r() < 0.5) out.supportsTools = r() < 0.5;
    if (r() < 0.5) out.supportsReasoning = r() < 0.5;
    return out;
  });
}
const clone = (items: DiscoveredCandidate[]) => structuredClone(items);
const freshState = () => ({ providerIdBySlug: new Map<string, string>(), touchedProviderIds: new Set<string>() });

/** Everything that matters about the table, with volatile ids/timestamps replaced by stable equivalents. */
async function snapshot() {
  const db = getDb();
  const slugById = new Map((await db.select().from(providers)).map(row => [row.id, row.slug]));
  const rows = await db.select().from(modelCandidates);
  return rows
    .map(row => {
      const { id, firstSeenAt, lastSeenAt, createdAt, updatedAt, providerId, ...rest } = row;
      void id; void firstSeenAt; void lastSeenAt; void createdAt; void updatedAt;
      return { ...rest, provider: providerId ? slugById.get(providerId) ?? "?" : null };
    })
    .sort((a, b) => `${a.source}::${a.modelRef}`.localeCompare(`${b.source}::${b.modelRef}`));
}

async function reset() {
  const db = getDb();
  await db.delete(modelCandidates);
  await db.delete(providers);
}

async function run(fn: typeof persistDiscoveredItems | typeof legacyPersistDiscoveredItems, batches: DiscoveredCandidate[][]) {
  const state = freshState();
  const counts: number[] = [];
  for (const batch of batches) counts.push(await fn(getDb(), clone(batch), state));
  const slugById = new Map((await getDb().select().from(providers)).map(row => [row.id, row.slug]));
  return { counts, touched: [...state.touchedProviderIds].map(id => slugById.get(id)).sort(), rows: await snapshot() };
}

describe("persistDiscoveredItems matches the original implementation", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`produces identical rows for random input (seed ${seed})`, async () => {
      // Three batches: later batches hit rows created by earlier ones (refresh + cross-source corroboration).
      const batches = [generate(seed * 100 + 1, 120), generate(seed * 100 + 2, 120), generate(seed * 100 + 3, 60)];
      await reset();
      const legacy = await run(legacyPersistDiscoveredItems, batches);
      await reset();
      const optimized = await run(persistDiscoveredItems, batches);
      expect(optimized.counts).toEqual(legacy.counts);
      expect(optimized.touched).toEqual(legacy.touched);
      expect(optimized.rows).toEqual(legacy.rows);
      expect(legacy.rows.length).toBeGreaterThan(5); // guard against a vacuous comparison
    });
  }
});

describe("persistDiscoveredItems scale", () => {
  const distinct = (seed: number) => generate(seed, 1500).map((item, i) => ({ ...item, modelRef: `${item.modelRef}-${i}` }));

  it("uses a bounded number of statements no matter how many items it persists", async () => {
    const items = distinct(99);
    await reset();
    statements = 0;
    const discovered = await persistDiscoveredItems(getDb(), clone(items), freshState());
    const optimized = statements;
    expect(discovered).toBe(1500);
    expect(await getDb().select().from(modelCandidates)).toHaveLength(1500);
    expect(optimized).toBeLessThan(30);

    // The original needed several statements per item for the same input.
    await reset();
    statements = 0;
    await legacyPersistDiscoveredItems(getDb(), clone(items), freshState());
    expect(statements).toBeGreaterThan(optimized * 50);
    console.info(`statements for 1500 items — original: ${statements}, optimized: ${optimized}`);
  });

  it("refreshing 1500 existing rows is also a bounded number of statements", async () => {
    const items = distinct(98);
    await reset();
    await persistDiscoveredItems(getDb(), clone(items), freshState());
    statements = 0;
    await persistDiscoveredItems(getDb(), clone(items), freshState());
    expect(statements).toBeLessThan(30);
    expect(await getDb().select().from(modelCandidates)).toHaveLength(1500);
  });
});
