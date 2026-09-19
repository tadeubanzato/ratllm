import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates, providers } from "@/server/db/schema";
import { persistDiscoveredItems, type PersistState } from "@/server/discovery/run";
import type { DiscoveredCandidate } from "@/server/discovery/types";

const item = (over: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate => ({
  source: "src-a", modelRef: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B", providerName: "Groq",
  freeType: "FREE_TIER", verifiedFree: false, contextWindow: 131072, sourceUrl: "https://a.example/models", evidence: { note: "first" }, ...over,
});
const freshState = (): PersistState => ({ providerIdBySlug: new Map(), touchedProviderIds: new Set() });
const persist = (items: DiscoveredCandidate[], state = freshState()) => persistDiscoveredItems(getDb(), items, state).then(discovered => ({ discovered, state }));
const rows = async () => (await getDb().select().from(modelCandidates)).sort((a, b) => (a.source + a.modelRef).localeCompare(b.source + b.modelRef));

describe("persistDiscoveredItems (behavior contract)", () => {
  it("inserts a new candidate, creating and linking its resolved provider", async () => {
    const { discovered, state } = await persist([item()]);
    expect(discovered).toBe(1);
    const [row] = await rows();
    const [provider] = await getDb().select().from(providers).where(eq(providers.slug, "groq"));
    expect(provider).toBeDefined();
    expect(row).toMatchObject({ source: "src-a", modelRef: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B", providerName: "Groq", providerId: provider.id, lifecycle: "DISCOVERED", freeType: "FREE_TIER", verifiedFree: false, contextWindow: 131072, evidence: { note: "first" } });
    expect(state.touchedProviderIds.has(provider.id)).toBe(true);
    expect(state.providerIdBySlug.get("groq")).toBe(provider.id);
  });

  it("stores an unresolved provider as null without inventing one", async () => {
    await persist([item({ modelRef: "zzz-1", providerName: "Nonexistent Corp" })]);
    const [row] = await rows();
    expect(row.providerId).toBeNull();
    expect(row.providerName).toBe("Nonexistent Corp");
    expect(await getDb().select().from(providers)).toHaveLength(0);
  });

  it("normalizes providerName to the catalog's name", async () => {
    await persist([item({ providerName: "groq" })]);
    expect((await rows())[0].providerName).toBe("Groq");
  });

  it("refreshes an existing (source, modelRef): new values win, evidence merges, firstSeenAt is kept", async () => {
    await persist([item({ evidence: { keep: 1, override: "old" } })]);
    const before = (await rows())[0];
    await new Promise(resolve => setTimeout(resolve, 15));
    const { discovered } = await persist([item({ displayName: "Renamed", verifiedFree: true, contextWindow: 8192, evidence: { override: "new", added: true } })]);
    expect(discovered).toBe(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: before.id, displayName: "Renamed", verifiedFree: true, contextWindow: 8192, evidence: { keep: 1, override: "new", added: true } });
    expect(all[0].firstSeenAt.getTime()).toBe(before.firstSeenAt.getTime());
    expect(all[0].lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
  });

  it("merges a same-model item from another source as corroboration instead of creating a duplicate row", async () => {
    await persist([item()]);
    const { discovered } = await persist([item({ source: "src-b", modelRef: "groq/llama-3.3-70b-versatile", sourceUrl: "https://b.example/list", displayName: "Other name" })]);
    expect(discovered).toBe(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe("Llama 3.3 70B"); // corroboration must not overwrite the original's fields
    expect(all[0].evidence).toMatchObject({ note: "first", corroboratingSources: [{ source: "src-b", sourceUrl: "https://b.example/list" }] });
  });

  it("does not record the same corroborating source twice", async () => {
    await persist([item()]);
    const dupe = item({ source: "src-b", modelRef: "groq/llama-3.3-70b-versatile", sourceUrl: "https://b.example/list" });
    await persist([dupe]);
    await persist([dupe]);
    const [row] = await rows();
    expect((row.evidence.corroboratingSources as unknown[]).length).toBe(1);
  });

  it("collapses two spellings of one model inside a single batch", async () => {
    const { discovered } = await persist([item(), item({ modelRef: "groq/llama-3.3-70b-versatile" })]);
    expect(discovered).toBe(2);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].evidence).toMatchObject({ corroboratingSources: [{ source: "src-a" }] });
  });

  it("treats a repeated identical item in one batch as a refresh, merging evidence in order", async () => {
    const { discovered } = await persist([item({ evidence: { a: 1 } }), item({ evidence: { b: 2 } })]);
    expect(discovered).toBe(2);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].evidence).toMatchObject({ a: 1, b: 2 });
  });

  it("keeps different models and different providers as separate rows", async () => {
    await persist([item(), item({ modelRef: "llama3.1-8b", providerName: "Cerebras", displayName: "Cerebras 8B" }), item({ modelRef: "llama-3.1-8b-instant" })]);
    expect(await rows()).toHaveLength(3);
  });

  it("never merges across providers even when the bare model key matches", async () => {
    await persist([item({ modelRef: "shared-model-1", providerName: "Groq" })]);
    await persist([item({ source: "src-b", modelRef: "shared-model-1", providerName: "Cerebras" })]);
    expect(await rows()).toHaveLength(2);
  });

  it("does not merge unresolved-provider items with each other by name", async () => {
    await persist([item({ modelRef: "zzz-1", providerName: "Nonexistent Corp" }), item({ source: "src-b", modelRef: "zzz-1", providerName: "Nonexistent Corp" })]);
    expect(await rows()).toHaveLength(2);
  });

  it("reuses provider ids already known to the run state", async () => {
    const state = freshState();
    await persist([item()], state);
    const id = state.providerIdBySlug.get("groq")!;
    await persist([item({ modelRef: "another-model-9" })], state);
    expect(state.providerIdBySlug.get("groq")).toBe(id);
    expect(await getDb().select().from(providers)).toHaveLength(1);
  });

  it("handles an empty batch", async () => {
    expect((await persist([])).discovered).toBe(0);
  });

  it("moves a refreshed row to its new provider, so later same-model items in the same batch follow it", async () => {
    // Everything happens inside ONE batch, which is what exercises the in-memory index (separate calls reload from the DB).
    const { discovered } = await persist([
      item({ modelRef: "groq/shared-9", providerName: undefined }),        // resolves to Groq from the model prefix
      item({ modelRef: "groq/shared-9", providerName: "Cerebras" }),       // same (source, modelRef): refresh, now Cerebras
      item({ source: "src-b", modelRef: "GROQ/shared-9", providerName: "Groq" }),       // Groq: must NOT merge into the Cerebras row
      item({ source: "src-c", modelRef: "cerebras/shared-9", providerName: "Cerebras" }), // Cerebras: must merge into it
    ]);
    expect(discovered).toBe(4);
    const all = await rows();
    expect(all.map(row => `${row.source}|${row.providerName}`)).toEqual(["src-a|Cerebras", "src-b|Groq"]);
    expect(all[0].evidence).toMatchObject({ corroboratingSources: [{ source: "src-c" }] });
    expect(all[1].evidence).not.toHaveProperty("corroboratingSources");
  });
});
