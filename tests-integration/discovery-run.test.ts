import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates, modelSources, syncRuns } from "@/server/db/schema";
import { runDiscovery } from "@/server/discovery/run";
import { SourceBlockedError, type DiscoveredCandidate, type DiscoverySource } from "@/server/discovery/types";

// Real registry ids, so the sources are seeded and enabled exactly as in production; only their network fetch is faked.
const item = (source: string, modelRef: string, over: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate =>
  ({ source, modelRef, displayName: modelRef, providerName: "Groq", freeType: "FREE_TIER", verifiedFree: false, sourceUrl: "https://x.example", evidence: {}, ...over });
const returns = (id: string, ...items: DiscoveredCandidate[]): DiscoverySource => ({ id, discover: async () => items });
const throws = (id: string, error: Error): DiscoverySource => ({ id, discover: async () => { throw error; } });

const lastRun = async () => (await getDb().select().from(syncRuns).where(eq(syncRuns.type, "MODEL_DISCOVERY")).orderBy(desc(syncRuns.createdAt)).limit(1))[0];
const sourceRow = async (id: string) => (await getDb().select().from(modelSources).where(eq(modelSources.adapterReference, id)))[0];
const candidateRefs = async () => (await getDb().select().from(modelCandidates)).map(row => `${row.source}:${row.modelRef}`).sort();

describe("runDiscovery source outcomes", () => {
  it("is SUCCEEDED when every source works", async () => {
    await runDiscovery({ sources: [returns("openrouter", item("openrouter", "m1")), returns("cerebras", item("cerebras", "m2", { providerName: "Cerebras" }))] });
    expect((await lastRun()).status).toBe("SUCCEEDED");
    expect(await candidateRefs()).toEqual(["cerebras:m2", "openrouter:m1"]);
  });

  it("is PARTIAL when one source fails, and the healthy sources still persist", async () => {
    const result = await runDiscovery({ sources: [returns("openrouter", item("openrouter", "m1")), throws("groq", new Error("boom")), returns("cerebras", item("cerebras", "m2", { providerName: "Cerebras" }))] });
    expect((await lastRun()).status).toBe("PARTIAL");
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "groq", status: "failed", error: "boom" })]));
    expect(await candidateRefs()).toEqual(["cerebras:m2", "openrouter:m1"]);
    expect((await sourceRow("groq")).status).toBe("FAILED");
    expect((await sourceRow("openrouter")).status).toBe("HEALTHY");
  });

  it("is FAILED only when every source fails", async () => {
    await runDiscovery({ sources: [throws("openrouter", new Error("a")), throws("groq", new Error("b"))] });
    expect((await lastRun()).status).toBe("FAILED");
  });

  it("treats a source waiting on a credential as BLOCKED, without degrading the run", async () => {
    const result = await runDiscovery({ sources: [returns("openrouter", item("openrouter", "m1")), throws("cerebras", new SourceBlockedError("CEREBRAS_API_KEY is not configured"))] });
    expect((await lastRun()).status).toBe("SUCCEEDED");
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "cerebras", status: "blocked", reason: "CEREBRAS_API_KEY is not configured" })]));
    const blocked = await sourceRow("cerebras");
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.lastSyncAt).toBeNull(); // must not consume the refresh interval
  });

  it("calls a run DEFERRED when every source is blocked", async () => {
    await runDiscovery({ sources: [throws("cerebras", new SourceBlockedError("no key")), throws("groq", new SourceBlockedError("no key"))] });
    expect((await lastRun()).status).toBe("DEFERRED");
  });

  it("retries a blocked source on the very next run once it can work (its refresh interval was not consumed)", async () => {
    await runDiscovery({ sources: [throws("cerebras", new SourceBlockedError("no key"))] });
    expect(await candidateRefs()).toEqual([]);
    await runDiscovery({ sources: [returns("cerebras", item("cerebras", "m2", { providerName: "Cerebras" }))] });
    expect(await candidateRefs()).toEqual(["cerebras:m2"]);
    expect((await sourceRow("cerebras")).status).toBe("HEALTHY");
  });

  it("isolates a save failure to its own source: that source rolls back and fails, the others persist", async () => {
    // An invalid enum value makes this source's INSERT fail inside its transaction.
    const poisoned = item("openrouter", "bad-1", { freeType: "NOT_A_REAL_TYPE" as never });
    const result = await runDiscovery({ sources: [returns("openrouter", item("openrouter", "ok-1"), poisoned), returns("cerebras", item("cerebras", "m2", { providerName: "Cerebras" }))] });
    expect((await lastRun()).status).toBe("PARTIAL");
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "openrouter", status: "failed" })]));
    expect(await candidateRefs()).toEqual(["cerebras:m2"]); // openrouter's good item rolled back with its bad one: atomic per source
    expect((await sourceRow("openrouter")).status).toBe("FAILED");
  });
});
