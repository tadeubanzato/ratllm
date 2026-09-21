import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { candidateChecks, canonicalModels, modelCandidates, modelDeployments, modelSources, providerCredentialReferences, providerOffers, providers, sourceChecks, syncRuns, systemSettings } from "@/server/db/schema";
import { runDiscovery, persistProviderOffers, persistDiscoveredItems } from "@/server/discovery/run";
import { consolidateModelCandidates, RETIRE_AFTER_MS } from "@/server/discovery/consolidate";
import { reconcileCheckBlockers } from "@/server/discovery/blockers";
import { ensureModelSources } from "@/server/discovery/model-sources";
import { selectAutoAddRetryable, verifyConnectedCandidates, verifyDueCandidates } from "@/server/discovery/verify-due";
import { BASELINE_EPOCH_KEY, getCandidatePage } from "@/server/queries";
import { newlyDiscoveredIds } from "@/server/discovery/new-candidates";
import { bareModelKey } from "@/server/discovery/model-key";
import { PROMOTION_PASSES } from "@/server/discovery/verification-policy";
import { SourceBlockedError, type DiscoveredCandidate, type DiscoverySource, type ProviderOffer } from "@/server/discovery/types";
import { setLiteLLMManagementSettings } from "@/server/settings/litellm-management";

// The lanes/promote module talks to a live LiteLLM. Everything here is about *when* automation decides to add, so it is replaced
// by a recorder; the real class is kept so `instanceof PromotionDeferred` still works.
const promoted: Array<{ id: string; trigger?: string }> = [];
vi.mock("@/server/lanes/promote", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/lanes/promote")>()),
  promoteCandidate: vi.fn(async (id: string, options?: { trigger?: string }) => { promoted.push({ id, trigger: options?.trigger }); return { candidateId: id, runId: "r", ok: true, targets: [] }; }),
}));

afterEach(() => { vi.unstubAllGlobals(); promoted.length = 0; });

const db = () => getDb();
const HOUR = 3_600_000, DAY = 24 * HOUR;

// ── builders ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const item = (source: string, modelRef: string, over: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate =>
  ({ source, modelRef, displayName: modelRef, providerName: "Groq", freeType: "UNKNOWN", verifiedFree: false, sourceUrl: "https://x.example", evidence: {}, ...over });
const source = (id: string, items: DiscoveredCandidate[], extra: Partial<DiscoverySource> & { offers?: ProviderOffer[]; rejected?: number } = {}): DiscoverySource =>
  ({ id, minExpected: extra.minExpected ?? 1, providerSlug: extra.providerSlug, discover: async () => ({ candidates: items, offers: extra.offers, rejected: extra.rejected }) });
const failing = (id: string, error: Error): DiscoverySource => ({ id, discover: async () => { throw error; } });

const provider = async (slug: string, name: string, over: Partial<typeof providers.$inferInsert> = {}) =>
  (await db().insert(providers).values({ slug, name, adapterKey: "openai-compatible", adapterCapability: "AUTOMATED", ...over }).returning())[0];
const credential = async (providerId: string, valid: boolean | null, envVar = "PIPELINE_TEST_KEY") => {
  process.env[envVar] = "test-secret";
  return (await db().insert(providerCredentialReferences).values({ providerId, environmentVariable: envVar, valid }).returning())[0];
};
const candidate = async (over: Partial<typeof modelCandidates.$inferInsert> & { modelRef: string }) =>
  (await db().insert(modelCandidates).values({ source: "openrouter", displayName: over.modelRef, sourceUrl: "u", modelKey: bareModelKey(over.modelRef), ...over }).returning())[0];
const row = async (id: string) => (await db().select().from(modelCandidates).where(eq(modelCandidates.id, id)))[0];
const checksOf = async (id: string) => (await db().select().from(candidateChecks).where(eq(candidateChecks.candidateId, id))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const deployment = async (providerId: string, providerModelId: string, lifecycle: "ACTIVE" | "REMOVED" | "DEACTIVATED" = "ACTIVE", createdAt?: Date) => {
  const canonical = (await db().insert(canonicalModels).values({ slug: `c-${Math.random()}`, name: providerModelId }).returning())[0];
  return (await db().insert(modelDeployments).values({ canonicalModelId: canonical.id, providerId, providerModelId, litellmModelName: "lane", litellmDeploymentId: `d-${Math.random()}`, lifecycle, ...(createdAt ? { createdAt } : {}) }).returning())[0];
};

/** Stubs the network: `respond(model)` answers a chat-completion request, `calls` records which models were actually called. */
function stubProvider(respond: (model: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => { const model = JSON.parse(init.body).model as string; calls.push(model); return respond(model); }));
  return calls;
}
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
const fail = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

const snapshot = async () => (await db().select().from(modelCandidates)).map(r => `${r.source}|${r.modelRef}|${r.providerId}|${r.modelKey}|${r.firstSeenAt.toISOString()}`).sort();

// ── I1, I2: one attribution, idempotent discovery ──────────────────────────────────────────────────────────────────────
describe("I1/I2 — discovery is idempotent and never undoes itself", () => {
  const catalog = (over: Partial<DiscoveredCandidate>[] = []) => [
    item("models_dev", "ibm-granite/granite-4.1-8b", { providerName: "W&B Inference" }),
    item("models_dev", "meta-llama/Llama-3.1-70B-Instruct", { providerName: "CoreWeave" }),
    item("models_dev", "some-model-7b", { providerName: "Novita" }),
    item("models_dev", "deepinfra/deepseek-v4-pro", { providerName: "Eden AI" }),
    item("models_dev", "gpt-oss-120b", { providerName: "Groq" }),
    ...over.map(o => item("models_dev", "x", o)),
  ];

  it("a second identical run changes nothing and reports no merges, backfills or retirements — the historical 44/44 loop", async () => {
    const sources = [source("models_dev", catalog())];
    await runDiscovery({ sources });
    const first = await snapshot();
    const second = await runDiscovery({ sources });
    const third = await runDiscovery({ sources });
    expect(await snapshot()).toEqual(first);
    for (const run of [second, third]) expect(run.consolidation).toMatchObject({ duplicatesMerged: 0, groupsMerged: 0, providerIdBackfilled: 0, retired: 0, orphanedRemoved: 0 });
  });

  it("keeps a provider whose display name once failed to re-resolve: W&B Inference stays attributed to wandb across runs", async () => {
    const sources = [source("models_dev", catalog())];
    for (let i = 0; i < 3; i++) await runDiscovery({ sources });
    const granite = (await db().select().from(modelCandidates).where(eq(modelCandidates.modelRef, "ibm-granite/granite-4.1-8b")))[0];
    const wandb = (await db().select().from(providers).where(eq(providers.slug, "wandb")))[0];
    expect(wandb).toBeDefined();
    expect(granite.providerId).toBe(wandb.id);
    // CoreWeave is W&B's former name: the same provider, not a second one.
    const coreweave = (await db().select().from(modelCandidates).where(eq(modelCandidates.modelRef, "meta-llama/Llama-3.1-70B-Instruct")))[0];
    expect(coreweave.providerId).toBe(wandb.id);
  });

  it("I3: derives a provider row for a name the catalog does not know, once, and never re-creates it", async () => {
    const sources = [source("models_dev", catalog())];
    await runDiscovery({ sources }); await runDiscovery({ sources });
    const eden = await db().select().from(providers).where(eq(providers.slug, "eden-ai"));
    expect(eden).toHaveLength(1);
    expect(eden[0]).toMatchObject({ name: "Eden AI", origin: "DISCOVERED", adapterCapability: "MANUAL" });
  });

  it("a source that lists one model id under several providers keeps all of them, and stays stable — the models.dev shape", async () => {
    // models.dev lists "gemini-flash-latest" under both Google and Vertex; the id alone used to be the candidate's identity, so one
    // provider overwrote the other and the row flipped between runs.
    const sources = [source("models_dev", [
      item("models_dev", "gemini-flash-latest", { providerName: "Google" }),
      item("models_dev", "gemini-flash-latest", { providerName: "Google Vertex" }),
      item("models_dev", "gemini-flash-latest", { providerName: "Vertex Mirror Co" }),
      item("models_dev", "gemini-flash-latest", { providerName: "Google" }), // an exact repeat is still just one candidate
    ])];
    await runDiscovery({ sources });
    const first = await snapshot();
    expect(first).toHaveLength(3);
    await runDiscovery({ sources }); await runDiscovery({ sources });
    expect(await snapshot()).toEqual(first);
  });

  it("a source never appears as its own corroboration when it lists the same model under another spelling", async () => {
    const sources = [source("models_dev", [item("models_dev", "qwen3.6-27b", { providerName: "Alibaba" }), item("models_dev", "qwen3.6-27b:thinking", { providerName: "Alibaba" })])];
    await runDiscovery({ sources }); await runDiscovery({ sources });
    const rows = await db().select().from(modelCandidates);
    expect(rows).toHaveLength(2); // ":thinking" is a different model id, so it is its own candidate
    for (const r of rows) expect(r.evidence.corroboratingSources ?? []).toEqual([]);
    // and the genuinely same-key spelling of the same source folds in without naming itself
    const merged = [source("models_dev", [item("models_dev", "GPT-OSS-120B", { providerName: "Groq" }), item("models_dev", "gpt-oss-120b", { providerName: "Groq" })])];
    await runDiscovery({ sources: merged });
    const gpt = (await db().select().from(modelCandidates)).filter(r => r.modelKey === "gptoss120b");
    expect(gpt).toHaveLength(1);
    expect(gpt[0].evidence.corroboratingSources ?? []).toEqual([]);
  });

  it("a later source listing the same model at the same provider joins the existing row, not a new one", async () => {
    await runDiscovery({ sources: [source("models_dev", [item("models_dev", "gemini-flash-latest", { providerName: "Google" }), item("models_dev", "gemini-flash-latest", { providerName: "Google Vertex" })])] });
    await runDiscovery({ sources: [source("gemini", [item("gemini", "gemini-flash-latest", { providerName: "Google AI Studio" })], { providerSlug: "google-ai-studio" })] });
    const rows = await db().select().from(modelCandidates);
    expect(rows).toHaveLength(2); // Google (with Gemini as corroboration) and Vertex
  });

  it("consolidation on its own is idempotent on data it has already cleaned", async () => {
    await runDiscovery({ sources: [source("models_dev", catalog())] });
    expect(await consolidateModelCandidates()).toMatchObject({ duplicatesMerged: 0, providerIdBackfilled: 0, retired: 0 });
  });

  it("consolidation never overwrites a provider a row already has, even if its stored name no longer resolves", async () => {
    const wandb = await provider("wandb", "W&B Inference");
    const r = await candidate({ source: "models_dev", modelRef: "m-7b", providerName: "Some Stale Spelling", providerId: wandb.id });
    await consolidateModelCandidates();
    expect((await row(r.id)).providerId).toBe(wandb.id);
  });
});

// ── I4, I5: source contract and registry truth ─────────────────────────────────────────────────────────────────────────
describe("I4 — a source can never succeed with nothing", () => {
  const lastRun = async () => (await db().select().from(syncRuns).where(eq(syncRuns.type, "MODEL_DISCOVERY")))[0];
  const sourceRow = async (id: string) => (await db().select().from(modelSources).where(eq(modelSources.adapterReference, id)))[0];

  it("fails a source that returns fewer models than its contract, and stores none of them", async () => {
    await runDiscovery({ sources: [source("groq", [item("groq", "junk-1"), item("groq", "junk-2")], { minExpected: 5 })] });
    expect(await db().select().from(modelCandidates)).toHaveLength(0);
    const groq = await sourceRow("groq");
    expect(groq.status).toBe("FAILED");
    expect(groq.lastError).toMatch(/Returned 2 usable models but at least 5/);
    expect((await lastRun()).status).toBe("FAILED");
  });

  it("a source that returns nothing is a failure, not a success with 0", async () => {
    await runDiscovery({ sources: [source("groq", [])] });
    expect((await sourceRow("groq")).status).toBe("FAILED");
  });

  it("keeps the last good data when a source breaks: a later empty run does not delete or age anything", async () => {
    await runDiscovery({ sources: [source("groq", [item("groq", "good-1"), item("groq", "good-2")], { minExpected: 2 })] });
    const before = await snapshot();
    await runDiscovery({ sources: [source("groq", [], { minExpected: 2 })] });
    expect(await snapshot()).toEqual(before);
  });

  it("marks a source DEGRADED, and still stores its good rows, when it is dropping many rows", async () => {
    const result = await runDiscovery({ sources: [source("groq", [item("groq", "a-1"), item("groq", "a-2")], { rejected: 3 })] });
    const groq = await sourceRow("groq");
    expect(groq.status).toBe("DEGRADED");
    expect(groq.lastError).toMatch(/3 of 5 rows/);
    expect(await db().select().from(modelCandidates)).toHaveLength(2);
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "groq", status: "degraded", rejected: 3 })]));
    expect((await lastRun()).status).toBe("SUCCEEDED"); // degraded is not a failure
  });

  it("reports BLOCKED, with the reason, without making the run partial", async () => {
    await runDiscovery({ sources: [source("openrouter", [item("openrouter", "m1", { providerName: "OpenRouter" })]), failing("fireworks_ai", new SourceBlockedError("Fireworks needs an API key"))] });
    const blocked = await sourceRow("fireworks_ai");
    expect(blocked).toMatchObject({ status: "BLOCKED", lastError: "Fireworks needs an API key" });
    expect((await lastRun()).status).toBe("SUCCEEDED");
  });

  it("rejects rows with no usable id and de-duplicates a source's own repeats", async () => {
    await runDiscovery({ sources: [source("groq", [item("groq", "  "), item("groq", "dup-1"), item("groq", "dup-1"), item("groq", "x".repeat(400))])] });
    expect((await db().select().from(modelCandidates)).map(r => r.modelRef)).toEqual(["dup-1"]);
  });

  it("gives every candidate of a provider's own catalog that provider, whatever the adapter guessed", async () => {
    await runDiscovery({ sources: [source("nvidia_nim", [item("nvidia_nim", "some/model-1b", { providerName: "not-a-provider" })], { providerSlug: "nvidia" })] });
    const [c] = await db().select().from(modelCandidates);
    const [p] = await db().select().from(providers).where(eq(providers.slug, "nvidia"));
    expect(c.providerId).toBe(p.id);
  });

  it("records a check history row per source outcome", async () => {
    await runDiscovery({ sources: [source("groq", [item("groq", "a-1")]), failing("cerebras", new Error("boom"))] });
    const statuses = (await db().select().from(sourceChecks)).map(c => c.status).sort();
    expect(statuses).toEqual(["FAILED", "HEALTHY"]);
  });
});

describe("I5 — model_sources is exactly the registry (plus custom rows)", () => {
  it("removes rows for sources the registry no longer has, keeps custom rows, links providers from the registry", async () => {
    const groq = await provider("groq", "Groq");
    await db().insert(modelSources).values([
      { name: "Old Retired Source", type: "CUSTOM_ADAPTER", adapterReference: "freellm_models", status: "HEALTHY" },
      { name: "Mistral Models API", type: "CUSTOM_ADAPTER", adapterReference: "mistral_models", status: "HEALTHY" },
      { name: "My Custom Feed", type: "JSON_FEED", url: "https://me.example/feed.json" },
    ]);
    await ensureModelSources();
    const rows = await db().select().from(modelSources);
    const refs = rows.map(r => r.adapterReference);
    expect(refs).not.toContain("freellm_models");
    expect(refs).not.toContain("mistral_models");
    expect(rows.some(r => r.name === "My Custom Feed")).toBe(true);
    expect(rows.find(r => r.adapterReference === "groq")?.providerId).toBe(groq.id);
    // and it is stable
    const count = rows.length;
    await ensureModelSources();
    expect(await db().select().from(modelSources)).toHaveLength(count);
  });

  it("never re-enables a source an operator switched off", async () => {
    await ensureModelSources();
    await db().update(modelSources).set({ enabled: false }).where(eq(modelSources.adapterReference, "groq"));
    await ensureModelSources();
    expect((await db().select().from(modelSources).where(eq(modelSources.adapterReference, "groq")))[0].enabled).toBe(false);
  });
});

// ── offers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("provider offers keep the source's words and attach only to real providers", () => {
  const offer = (over: Partial<ProviderOffer>): ProviderOffer => ({ source: "freellmapihub", providerName: "Groq", freeType: "RECURRING_CREDIT", ...over });
  const state = () => ({ providerIdBySlug: new Map((globalThis as unknown as { _ids?: Map<string, string> })._ids ?? []), touchedProviderIds: new Set<string>() });

  it("stores limits verbatim, matches a marketing name by slug or by API host, and ignores providers nothing else knows", async () => {
    const google = await provider("google-ai-studio", "Google AI Studio");
    const groq = await provider("groq", "Groq");
    const s = { providerIdBySlug: new Map([[google.slug, google.id], [groq.slug, groq.id]]), touchedProviderIds: new Set<string>() };
    const limits = "Varies by model: 5-30 RPM and 15-1,000 RPD (e.g. 2.5 Pro: 5 RPM/100 RPD)";
    const stored = await persistProviderOffers(db(), [
      offer({ providerName: "Google Gemini API (AI Studio)", slugHint: "google-gemini", rateLimitsText: limits, freeType: "RECURRING_CREDIT", cardRequired: false }),
      offer({ providerName: "Groq", rateLimitsText: "30 RPM", freeType: "RECURRING_CREDIT" }),
      offer({ providerName: "ElevenLabs", freeType: "TRIAL_CREDIT" }),
      offer({ providerName: "Totally Unknown Speech Co", openaiBaseUrl: "https://nowhere.example/v1", freeType: "TRIAL_CREDIT" }),
    ], s);
    expect(stored).toBe(2);
    expect((await db().select().from(providers)).map(p => p.slug).sort()).toEqual(["google-ai-studio", "groq"]); // no provider conjured by an offer
    const offers = await db().select().from(providerOffers);
    expect(offers.find(o => o.providerId === google.id)).toMatchObject({ rateLimitsText: limits, freeType: "RECURRING_CREDIT", cardRequired: false });
  });

  it("is an upsert per (provider, source): a second run updates in place", async () => {
    const groq = await provider("groq", "Groq");
    const s = { providerIdBySlug: new Map([[groq.slug, groq.id]]), touchedProviderIds: new Set<string>() };
    await persistProviderOffers(db(), [offer({ rateLimitsText: "30 RPM" })], s);
    await persistProviderOffers(db(), [offer({ rateLimitsText: "60 RPM" })], s);
    const offers = await db().select().from(providerOffers);
    expect(offers).toHaveLength(1);
    expect(offers[0].rateLimitsText).toBe("60 RPM");
    void state;
  });

  it("flows through a whole discovery run: models and the provider's offer arrive together", async () => {
    await runDiscovery({ sources: [source("freellmapihub", [item("freellmapihub", "gpt-oss-20b", { providerName: "Groq", freeType: "RECURRING_CREDIT" })], { offers: [offer({ providerName: "Groq", rateLimitsText: "30 RPM" })] })] });
    expect(await db().select().from(providerOffers)).toHaveLength(1);
    expect((await db().select().from(modelCandidates))[0].freeType).toBe("RECURRING_CREDIT");
  });
});

// ── I6: blockers ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe("I6 — a state where no call can be made is a blocker, not history", () => {
  const blockerOf = async (id: string) => (await row(id)).checkBlocker;

  it("classifies each way a candidate can be untestable, and clears it the moment the cause is fixed", async () => {
    const noCred = await provider("groq", "Groq");
    const unverified = await provider("cerebras", "Cerebras");
    const good = await provider("deepseek", "DeepSeek");
    const derived = await provider("eden-ai", "Eden AI", { origin: "DISCOVERED", adapterKey: "manual", adapterCapability: "MANUAL" });
    const keyless = await provider("pollinations", "Pollinations.ai");
    await credential(unverified.id, false, "K_UNVERIFIED");
    await credential(good.id, true, "K_GOOD");
    const a = await candidate({ modelRef: "a-7b", providerId: noCred.id });
    const b = await candidate({ modelRef: "b-7b", providerId: unverified.id });
    const c = await candidate({ modelRef: "c-7b", providerId: good.id });
    const d = await candidate({ modelRef: "d-7b", providerId: derived.id });
    const e = await candidate({ modelRef: "e-7b", providerId: keyless.id });
    const f = await candidate({ modelRef: "f-7b", providerId: null });
    const g = await candidate({ modelRef: "openai/whisper-large-v3", providerId: good.id, evidence: { nonChatReason: "Speech-to-text model" } });

    await reconcileCheckBlockers(db());
    expect(await blockerOf(a.id)).toBe("CREDENTIAL_MISSING");
    expect(await blockerOf(b.id)).toBe("CREDENTIAL_UNVERIFIED");
    expect(await blockerOf(c.id)).toBeNull();
    expect(await blockerOf(d.id)).toBe("NO_ENDPOINT");
    expect(await blockerOf(e.id)).toBeNull(); // credentialOptional: anonymous access is testable
    expect(await blockerOf(f.id)).toBe("PROVIDER_UNRESOLVED");
    expect(await blockerOf(g.id)).toBe("NOT_CHAT_MODEL");

    // idempotent
    expect(await reconcileCheckBlockers(db())).toBe(0);

    // fixing the cause clears it, and makes the candidate due right away
    await db().update(providerCredentialReferences).set({ valid: true }).where(eq(providerCredentialReferences.providerId, unverified.id));
    await db().update(modelCandidates).set({ nextCheckAt: new Date(Date.now() + 5 * DAY) }).where(eq(modelCandidates.id, b.id));
    await reconcileCheckBlockers(db());
    expect(await blockerOf(b.id)).toBeNull();
    expect((await row(b.id)).nextCheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("a provider becomes testable when a source publishes its OpenAI-compatible base URL", async () => {
    const derived = await provider("eden-ai", "Eden AI", { origin: "DISCOVERED", adapterKey: "manual", adapterCapability: "MANUAL" });
    await credential(derived.id, null, "K_EDEN");
    const r = await candidate({ modelRef: "m-7b", providerId: derived.id });
    await reconcileCheckBlockers(db());
    expect(await blockerOf(r.id)).toBe("NO_ENDPOINT");
    await db().insert(providerOffers).values({ providerId: derived.id, source: "freellmapihub", freeType: "TRIAL_CREDIT", openaiBaseUrl: "https://api.eden.example/v1" });
    await reconcileCheckBlockers(db());
    expect(await blockerOf(r.id)).toBeNull();
  });

  it("a blocked candidate is never called and never gets a history row", async () => {
    const groq = await provider("groq", "Groq"); // no credential
    const r = await candidate({ modelRef: "a-7b", providerId: groq.id });
    const calls = stubProvider(ok);
    const result = await verifyConnectedCandidates();
    expect(calls).toHaveLength(0);
    expect(result.processed).toBe(0);
    expect(await checksOf(r.id)).toHaveLength(0);
    expect((await row(r.id)).lastCheckStatus).toBeNull();
  });

  it("a provider switched off in the UI is never tested", async () => {
    const groq = await provider("groq", "Groq", { enabled: false });
    await credential(groq.id, true);
    await candidate({ modelRef: "a-7b", providerId: groq.id });
    const calls = stubProvider(ok);
    await verifyConnectedCandidates(); await verifyDueCandidates();
    expect(calls).toHaveLength(0);
  });
});

// ── I6, I7: recording and the streak ───────────────────────────────────────────────────────────────────────────────────
describe("I7 — the streak counts consecutive real passes", () => {
  const setup = async (over: Partial<typeof modelCandidates.$inferInsert> = {}) => {
    const groq = await provider("groq", "Groq");
    await credential(groq.id, true);
    return { groq, cand: await candidate({ modelRef: "llama-3.3-70b-versatile", providerId: groq.id, ...over }) };
  };

  it("records every real call and builds the streak, then breaks it on the first failure", async () => {
    const { cand } = await setup();
    let answer: () => Response = ok;
    stubProvider(() => answer());
    for (let i = 1; i <= PROMOTION_PASSES; i++) { await verifyConnectedCandidates(); expect((await row(cand.id)).consecutivePasses).toBe(i); }
    answer = () => fail(500, "boom");
    await verifyConnectedCandidates();
    const after = await row(cand.id);
    expect(after).toMatchObject({ consecutivePasses: 0, lastCheckStatus: "unavailable", everFailed: true });
    expect(after.lastPassedAt).not.toBeNull(); // a failure does not erase when it last passed
    expect((await checksOf(cand.id)).map(c => c.status)).toEqual([...Array(PROMOTION_PASSES).fill("available"), "unavailable"]);
  });

  it("treats out-of-credits as its own outcome, retried slowly, and not as a broken model", async () => {
    const { cand } = await setup();
    stubProvider(() => fail(402, "You need positive balance to do inference"));
    await verifyConnectedCandidates();
    const after = await row(cand.id);
    expect(after.lastCheckStatus).toBe("out_of_credits");
    expect(after.consecutivePasses).toBe(0);
    expect(after.nextCheckAt!.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);
  });

  it("proves a new candidate every 90 minutes but a trial-credit one only every 6 hours (testing burns the quota)", async () => {
    const { groq } = await setup();
    const standard = await candidate({ modelRef: "std-7b", providerId: groq.id, freeType: "FREE_TIER" });
    const trial = await candidate({ modelRef: "trial-7b", providerId: groq.id, freeType: "TRIAL_CREDIT" });
    stubProvider(ok);
    await verifyConnectedCandidates();
    const delay = async (id: string) => (await row(id)).nextCheckAt!.getTime() - Date.now();
    expect(await delay(standard.id)).toBeGreaterThan(80 * 60_000);
    expect(await delay(standard.id)).toBeLessThan(100 * 60_000);
    expect(await delay(trial.id)).toBeGreaterThan(5.9 * HOUR);
    expect(await delay(trial.id)).toBeLessThan(6.1 * HOUR);
  });

  it("falls back to the provider's published offer for cadence when the model itself says nothing", async () => {
    const { groq, cand } = await setup();
    await db().insert(providerOffers).values({ providerId: groq.id, source: "freellmapihub", freeType: "TRIAL_CREDIT" });
    stubProvider(ok);
    await verifyConnectedCandidates();
    expect((await row(cand.id)).nextCheckAt!.getTime() - Date.now()).toBeGreaterThan(5.9 * HOUR);
  });

  it("retries once with the id exactly as discovered before recording a 404", async () => {
    const { cand } = await setup({ modelRef: "groq/compound", source: "groq" });
    const calls = stubProvider(model => (model === "groq/compound" ? ok() : fail(404, "The model does not exist")));
    await verifyConnectedCandidates();
    expect(calls).toEqual(["compound", "groq/compound"]);
    expect((await row(cand.id)).lastCheckStatus).toBe("available");
  });

  it("a 429 backs off the whole provider for the rest of the run: the others are rescheduled, not called, not recorded", async () => {
    const { groq, cand } = await setup({ modelRef: "a-7b" });
    const other = await candidate({ modelRef: "b-7b", providerId: groq.id });
    const third = await candidate({ modelRef: "c-7b", providerId: groq.id });
    const calls = stubProvider(() => fail(429, "Rate limit reached"));
    await verifyDueCandidates(300, 1);
    expect(calls).toHaveLength(1); // only the first was actually sent
    const recorded = (await Promise.all([cand, other, third].map(c => checksOf(c.id)))).flat();
    expect(recorded).toHaveLength(1); // no call, no history
    const later = (await Promise.all([cand, other, third].map(c => row(c.id)))).map(r => r.nextCheckAt!.getTime());
    for (const time of later) expect(time - Date.now()).toBeGreaterThan(23 * HOUR);
  });

  it("selects due candidates in SQL and interleaves providers, so one huge provider cannot crowd out the rest", async () => {
    const big = await provider("groq", "Groq"); const small = await provider("cerebras", "Cerebras"); const tiny = await provider("deepseek", "DeepSeek");
    await credential(big.id, true, "K1"); await credential(small.id, true, "K2"); await credential(tiny.id, true, "K3");
    for (let i = 0; i < 30; i++) await candidate({ modelRef: `big-${i}-7b`, providerId: big.id });
    const s1 = await candidate({ modelRef: "small-1-7b", providerId: small.id });
    const t1 = await candidate({ modelRef: "tiny-1-7b", providerId: tiny.id });
    stubProvider(ok);
    const result = await verifyDueCandidates(6, 2);
    expect(result.processed).toBe(6);
    expect((await row(s1.id)).lastCheckStatus).toBe("available");
    expect((await row(t1.id)).lastCheckStatus).toBe("available");
  });

  it("stops checking a provider once its share of the daily call budget is spent, and lets it resume as calls age out", async () => {
    const orp = await provider("openrouter", "OpenRouter"); await credential(orp.id, true, "K1");
    const cands = [] as Awaited<ReturnType<typeof candidate>>[];
    for (let i = 0; i < 20; i++) cands.push(await candidate({ modelRef: `m-${i}-7b`, providerId: orp.id }));
    // 14 calls already spent in the last 24h: OpenRouter's budget is 24, of which candidate checks may use 14
    await db().insert(candidateChecks).values(Array.from({ length: 14 }, () => ({ candidateId: cands[19].id, status: "available" as const, httpStatus: 200 })));
    const calls = stubProvider(ok);
    await verifyDueCandidates();
    expect(calls).toHaveLength(0);
    // the same calls, but 25 hours old, no longer count
    await db().update(candidateChecks).set({ createdAt: new Date(Date.now() - 25 * HOUR) }).where(eq(candidateChecks.candidateId, cands[19].id));
    await verifyDueCandidates();
    expect(calls).toHaveLength(14);
  });

  it("within the allowance, candidates already on a pass streak are checked before untested ones", async () => {
    const orp = await provider("openrouter", "OpenRouter"); await credential(orp.id, true, "K1");
    const cold = [] as Awaited<ReturnType<typeof candidate>>[];
    for (let i = 0; i < 6; i++) cold.push(await candidate({ modelRef: `cold-${i}-7b`, providerId: orp.id }));
    await candidate({ modelRef: "streak-a-7b", providerId: orp.id, consecutivePasses: 3, lastCheckStatus: "available", nextCheckAt: new Date(Date.now() - HOUR) });
    await candidate({ modelRef: "streak-b-7b", providerId: orp.id, consecutivePasses: 2, lastCheckStatus: "available", nextCheckAt: new Date(Date.now() - HOUR) });
    // 10 of the 14 candidate-check calls are spent, leaving room for exactly 4
    await db().insert(candidateChecks).values(Array.from({ length: 10 }, () => ({ candidateId: cold[0].id, status: "available" as const, httpStatus: 200 })));
    const calls = stubProvider(ok);
    await verifyDueCandidates();
    expect(calls).toHaveLength(4);
    expect(calls).toEqual(expect.arrayContaining(["streak-a-7b", "streak-b-7b"]));
  });

  it("retries auto-add for candidates that earned promotion but were deferred, without waiting for their next scheduled check", async () => {
    const groq = await provider("groq", "Groq"); const orp = await provider("openrouter", "OpenRouter");
    const passed = { consecutivePasses: 6, lastCheckStatus: "available" as const, lastPassedAt: new Date(Date.now() - HOUR), nextCheckAt: new Date(Date.now() + 20 * HOUR) };
    const ready = await candidate({ modelRef: "ready-7b", providerId: groq.id, ...passed });
    const deferralOver = await candidate({ modelRef: "deferral-over-7b", providerId: groq.id, ...passed, evidence: { autoAddDeferredUntil: new Date(Date.now() - HOUR).toISOString() } });
    await candidate({ modelRef: "still-waiting-7b", providerId: groq.id, ...passed, evidence: { autoAddDeferredUntil: new Date(Date.now() + HOUR).toISOString() } });
    // added by RatLLM and live now (its deployment points back at it): nothing to do; added and later removed: eligible again
    const liveOne = await candidate({ modelRef: "live-7b", providerId: groq.id, ...passed, addedToLitellmAt: new Date() });
    const liveDeployment = await deployment(groq.id, "openai/live-7b");
    await db().update(modelDeployments).set({ rawMetadata: { model_info: { source_candidate_id: liveOne.id } } }).where(eq(modelDeployments.id, liveDeployment.id));
    const wasRemoved = await candidate({ modelRef: "was-removed-7b", providerId: groq.id, ...passed, addedToLitellmAt: new Date() });
    const removedDeployment = await deployment(groq.id, "openai/was-removed-7b", "REMOVED");
    await db().update(modelDeployments).set({ rawMetadata: { model_info: { source_candidate_id: wasRemoved.id } } }).where(eq(modelDeployments.id, removedDeployment.id));
    await candidate({ modelRef: "blocked-7b", providerId: groq.id, ...passed, checkBlocker: "NOT_CHAT_MODEL" });
    await candidate({ modelRef: "four-passes-7b", providerId: groq.id, ...passed, consecutivePasses: 4 });
    await candidate({ modelRef: "stale-pass-7b", providerId: groq.id, ...passed, lastPassedAt: new Date(Date.now() - 5 * 24 * HOUR) });
    await candidate({ modelRef: "failed-lately-7b", providerId: groq.id, ...passed, lastCheckStatus: "unavailable" });
    // a provider that has spent its whole discovery allowance is still retried: an add is one call and the best use of it
    const overBudget = await candidate({ modelRef: "over-budget-7b", providerId: orp.id, ...passed });
    await db().insert(candidateChecks).values(Array.from({ length: 14 }, () => ({ candidateId: overBudget.id, status: "available" as const, httpStatus: 200 })));
    const picked = (await selectAutoAddRetryable(db())).map(r => r.modelRef).sort();
    expect(picked).toEqual([deferralOver.modelRef, overBudget.modelRef, ready.modelRef, wasRemoved.modelRef].sort());
  });

  it("does not test a candidate before it is due, and tests it once it is", async () => {
    const { cand } = await setup({ nextCheckAt: new Date(Date.now() + 3 * HOUR) });
    const calls = stubProvider(ok);
    await verifyDueCandidates();
    expect(calls).toHaveLength(0);
    await db().update(modelCandidates).set({ nextCheckAt: new Date(Date.now() - 1000) }).where(eq(modelCandidates.id, cand.id));
    await verifyDueCandidates();
    expect(calls).toHaveLength(1);
  });

  it("a manual run covers every testable candidate, never-tested first, then longest-untested — not the first N alphabetically", async () => {
    const { groq } = await setup({ modelRef: "aaa-recent-7b", lastCheckedAt: new Date() });
    const stale = await candidate({ modelRef: "zzz-stale-7b", providerId: groq.id, lastCheckedAt: new Date(Date.now() - 10 * DAY) });
    const never = await candidate({ modelRef: "mmm-never-7b", providerId: groq.id });
    const order: string[] = [];
    stubProvider(model => { order.push(model); return ok(); });
    const result = await verifyConnectedCandidates(5000, 1);
    expect(result).toMatchObject({ targeted: 3, processed: 3, available: 3 });
    expect(order).toEqual(["mmm-never-7b", "zzz-stale-7b", "aaa-recent-7b"]);
    void stale; void never;
  });
});

// ── I8: automatic promotion ────────────────────────────────────────────────────────────────────────────────────────────
describe("I8 — automatic promotion happens exactly at the fifth consecutive pass", () => {
  const setup = async (over: Partial<typeof modelCandidates.$inferInsert> = {}) => {
    const groq = await provider("groq", "Groq");
    await credential(groq.id, true);
    return { groq, cand: await candidate({ modelRef: "llama-3.3-70b-versatile", providerId: groq.id, ...over }) };
  };

  it("adds on the 5th pass and not before, and adds once", async () => {
    const { cand } = await setup();
    stubProvider(ok);
    for (let i = 1; i < PROMOTION_PASSES; i++) { await verifyConnectedCandidates(); expect(promoted).toHaveLength(0); }
    await verifyConnectedCandidates();
    expect(promoted).toEqual([{ id: cand.id, trigger: "auto" }]);
  });

  it("does not add a model that is already live in LiteLLM, however long its streak", async () => {
    const { groq } = await setup({ consecutivePasses: 9 });
    await deployment(groq.id, "openai/llama-3.3-70b-versatile");
    stubProvider(ok);
    await verifyConnectedCandidates();
    expect(promoted).toHaveLength(0);
  });

  it("does not add when automatic adding is switched off in Settings → LiteLLM", async () => {
    await setup({ consecutivePasses: PROMOTION_PASSES - 1 });
    await setLiteLLMManagementSettings({ autoAdd: false });
    stubProvider(ok);
    await verifyConnectedCandidates();
    expect(promoted).toHaveLength(0);
  });

  it("never adds a model on a failure, or one whose streak was broken", async () => {
    const { cand } = await setup({ consecutivePasses: PROMOTION_PASSES - 1 });
    stubProvider(() => fail(500, "boom"));
    await verifyConnectedCandidates();
    expect(promoted).toHaveLength(0);
    stubProvider(ok);
    await verifyConnectedCandidates(); // streak restarts from 0 -> 1
    expect(promoted).toHaveLength(0);
    expect((await row(cand.id)).consecutivePasses).toBe(1);
  });

  it("the gate is enforced by the server for a manual add too, not just hidden in the UI", async () => {
    const { cand } = await setup({ consecutivePasses: 3, lastCheckStatus: "available" });
    const { promoteCandidate } = await vi.importActual<typeof import("@/server/lanes/promote")>("@/server/lanes/promote");
    await expect(promoteCandidate(cand.id)).rejects.toThrow(/Not eligible yet: 3 of 5 passes in a row/);
  });
});

// ── I10, I11, I12: identity, "Added", scale ────────────────────────────────────────────────────────────────────────────
describe("I10 — the same model at two providers is two candidates and two independent deployments", () => {
  it("keeps both rows, tells each about the other, and marks only the one that is actually in LiteLLM", async () => {
    const groq = await provider("groq", "Groq"); const cerebras = await provider("cerebras", "Cerebras");
    await runDiscovery({ sources: [source("openrouter", [item("openrouter", "gpt-oss-120b", { providerName: "Groq" }), item("openrouter", "openai/gpt-oss-120b", { providerName: "Cerebras" })], { minExpected: 2 })] });
    expect(await db().select().from(modelCandidates)).toHaveLength(2);
    await deployment(groq.id, "openai/gpt-oss-120b");
    const page = await getCandidatePage({ view: "all" });
    const at = (name: string) => page.rows.find(r => r.providerName === name)!;
    expect(at("Groq")).toMatchObject({ alsoAt: 1, liteLLMDeploymentId: expect.any(String) });
    expect(at("Cerebras")).toMatchObject({ alsoAt: 1, liteLLMDeploymentId: null });
    void cerebras;
  });

  it("does not merge a model into another provider's row during consolidation", async () => {
    const a = await provider("groq", "Groq"); const b = await provider("cerebras", "Cerebras");
    await candidate({ modelRef: "shared-model-7b", providerId: a.id, source: "openrouter" });
    await candidate({ modelRef: "shared-model-7b", providerId: b.id, source: "cerebras" });
    expect(await consolidateModelCandidates()).toMatchObject({ duplicatesMerged: 0 });
    expect(await db().select().from(modelCandidates)).toHaveLength(2);
  });
});

describe("consolidation merges, moves history, and retires safely", () => {
  it("merges the same model from two sources into one row, keeps both as evidence, moves the checks and recomputes the streak", async () => {
    const groq = await provider("groq", "Groq");
    const a = await candidate({ modelRef: "llama-3.3-70b", providerId: groq.id, source: "openrouter", verifiedFree: true, lastCheckedAt: new Date() });
    const b = await candidate({ modelRef: "Llama-3.3-70B", providerId: groq.id, source: "cerebras" });
    const now = Date.now();
    await db().insert(candidateChecks).values([
      { candidateId: a.id, status: "unavailable", createdAt: new Date(now - 3 * HOUR) },
      { candidateId: a.id, status: "available", createdAt: new Date(now - 2 * HOUR) },
      { candidateId: b.id, status: "available", createdAt: new Date(now - 1 * HOUR) },
    ]);
    expect(await consolidateModelCandidates()).toMatchObject({ duplicatesMerged: 1, groupsMerged: 1 });
    const rows = await db().select().from(modelCandidates);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(a.id);
    expect((rows[0].evidence.corroboratingSources as Array<{ source: string }>).map(s => s.source)).toEqual(["cerebras"]);
    expect(await checksOf(a.id)).toHaveLength(3);
    expect(rows[0]).toMatchObject({ consecutivePasses: 2, lastCheckStatus: "available", everFailed: true });
    expect(await consolidateModelCandidates()).toMatchObject({ duplicatesMerged: 0 }); // idempotent
  });

  it("retires a model its own working source stopped listing for a week, and nothing else", async () => {
    const groq = await provider("groq", "Groq");
    const old = new Date(Date.now() - RETIRE_AFTER_MS - HOUR);
    const unlisted = { firstSeenAt: new Date(old.getTime() - DAY), lastSeenAt: old }; // seen-order check: first <= last
    const gone = await candidate({ modelRef: "gone-7b", providerId: groq.id, source: "groq", ...unlisted });
    const fresh = await candidate({ modelRef: "fresh-7b", providerId: groq.id, source: "groq" });
    const otherSourceDown = await candidate({ modelRef: "kept-7b", providerId: groq.id, source: "cerebras", ...unlisted });
    const inLiteLLM = await candidate({ modelRef: "live-7b", providerId: groq.id, source: "groq", ...unlisted });
    await deployment(groq.id, "openai/live-7b", "REMOVED");
    const stamped = await candidate({ modelRef: "stamped-7b", providerId: groq.id, source: "groq", ...unlisted, addedToLitellmAt: new Date(Date.now() - 30 * DAY) });

    const result = await consolidateModelCandidates({ succeededSourceIds: new Set(["groq"]) });
    expect(result.retired).toBe(1);
    const remaining = new Set((await db().select().from(modelCandidates)).map(r => r.id));
    expect(remaining.has(gone.id)).toBe(false);
    for (const survivor of [fresh, otherSourceDown, inLiteLLM, stamped]) expect(remaining.has(survivor.id)).toBe(true);
  });

  it("retires nothing when no source succeeded in the run, so an outage can never empty the table", async () => {
    const groq = await provider("groq", "Groq");
    await candidate({ modelRef: "old-7b", providerId: groq.id, source: "groq", firstSeenAt: new Date(Date.now() - 90 * DAY), lastSeenAt: new Date(Date.now() - 60 * DAY) });
    expect((await consolidateModelCandidates({ succeededSourceIds: new Set() })).retired).toBe(0);
    expect((await consolidateModelCandidates()).retired).toBe(0);
    expect(await db().select().from(modelCandidates)).toHaveLength(1);
  });
});

describe("I11 — 'Added' shows when a model was added, by whom", () => {
  it("uses the stamp a promotion left, and falls back to the oldest live deployment for models added before stamps existed", async () => {
    const groq = await provider("groq", "Groq");
    const stamp = new Date("2026-08-01T10:00:00Z");
    await candidate({ modelRef: "stamped-7b", providerId: groq.id, addedToLitellmAt: stamp, addedBy: "auto" });
    await candidate({ modelRef: "legacy-7b", providerId: groq.id });
    await candidate({ modelRef: "notlive-7b", providerId: groq.id, addedToLitellmAt: stamp, addedBy: "manual" });
    await deployment(groq.id, "openai/stamped-7b");
    await deployment(groq.id, "openai/legacy-7b", "ACTIVE", new Date("2026-07-01T00:00:00Z"));
    await deployment(groq.id, "openai/legacy-7b", "ACTIVE", new Date("2026-07-15T00:00:00Z"));
    await deployment(groq.id, "openai/notlive-7b", "REMOVED");
    const page = await getCandidatePage({ view: "all" });
    const by = (ref: string) => page.rows.find(r => r.modelRef === ref)!;
    expect(by("stamped-7b")).toMatchObject({ addedAt: stamp, addedBy: "auto" });
    expect(by("legacy-7b").addedAt).toEqual(new Date("2026-07-01T00:00:00Z"));
    expect(by("notlive-7b")).toMatchObject({ addedAt: null, addedBy: null }); // removed: no longer "added"
  });
});

describe("I12 — the Discovered Models page is paginated and filtered in SQL", () => {
  it("pages through every row exactly once, in a stable order, with correct totals and filter counts", async () => {
    const groq = await provider("groq", "Groq");
    await Promise.all(Array.from({ length: 250 }, (_, i) => candidate({ modelRef: `model-${String(i).padStart(3, "0")}-7b`, providerId: groq.id, consecutivePasses: i % 7, lastCheckStatus: i % 2 ? "available" : "unavailable" })));
    const seen = new Set<string>();
    let total = 0;
    for (const page of [1, 2, 3]) {
      const result = await getCandidatePage({ page, pageSize: 100 });
      total = result.total;
      expect(result.pageCount).toBe(3);
      for (const r of result.rows) { expect(seen.has(r.id)).toBe(false); seen.add(r.id); }
      expect(result.rows.length).toBe(page < 3 ? 100 : 50);
    }
    expect(total).toBe(250);
    expect(seen.size).toBe(250);
    const passing = await getCandidatePage({ view: "passing" });
    expect(passing.total).toBe(125);
    expect(passing.counts.all).toBe(250);
    // page beyond the end clamps instead of returning nothing
    expect((await getCandidatePage({ page: 99, pageSize: 100 })).page).toBe(3);
  });

  it("searches names, refs and providers, treating % and _ as ordinary characters", async () => {
    const groq = await provider("groq", "Groq");
    await candidate({ modelRef: "llama_3-7b", providerId: groq.id, providerName: "Groq" });
    await candidate({ modelRef: "llamaX3-7b", providerId: groq.id, providerName: "Groq" });
    await candidate({ modelRef: "50%-off-7b", providerId: groq.id, providerName: "Groq" });
    expect((await getCandidatePage({ q: "llama_3" })).rows.map(r => r.modelRef)).toEqual(["llama_3-7b"]);
    expect((await getCandidatePage({ q: "50%" })).rows.map(r => r.modelRef)).toEqual(["50%-off-7b"]);
    expect((await getCandidatePage({ q: "groq" })).total).toBe(3);
    expect((await getCandidatePage({ provider: "groq" })).total).toBe(3);
    expect((await getCandidatePage({ provider: "nope" })).total).toBe(0);
  });

  it("ranks the models closest to being added first", async () => {
    const groq = await provider("groq", "Groq");
    await candidate({ modelRef: "low-7b", providerId: groq.id, consecutivePasses: 1, lastPassedAt: new Date() });
    await candidate({ modelRef: "high-7b", providerId: groq.id, consecutivePasses: 5, lastPassedAt: new Date(Date.now() - DAY) });
    await candidate({ modelRef: "never-7b", providerId: groq.id });
    expect((await getCandidatePage({})).rows.map(r => r.modelRef)).toEqual(["high-7b", "low-7b", "never-7b"]);
  });

  it("'Ready to add' is 5+ passes and not live; 'In LiteLLM' is live; both are consistent with each row's own flags", async () => {
    const groq = await provider("groq", "Groq");
    const ready = await candidate({ modelRef: "ready-7b", providerId: groq.id, consecutivePasses: 5, lastCheckStatus: "available" });
    await candidate({ modelRef: "almost-7b", providerId: groq.id, consecutivePasses: 4, lastCheckStatus: "available" });
    await candidate({ modelRef: "live-7b", providerId: groq.id, consecutivePasses: 9, lastCheckStatus: "available" });
    await deployment(groq.id, "openai/live-7b");
    await credential(groq.id, true);
    await reconcileCheckBlockers(db());
    expect((await getCandidatePage({ view: "ready" })).rows.map(r => r.id)).toEqual([ready.id]);
    expect((await getCandidatePage({ view: "added" })).rows.map(r => r.modelRef)).toEqual(["live-7b"]);
    const readyRow = (await getCandidatePage({ view: "ready" })).rows[0];
    expect(readyRow.promotable).toBe(true);
    const almost = (await getCandidatePage({ q: "almost" })).rows[0];
    expect(almost).toMatchObject({ promotable: false, promotableReason: "4 of 5 passes in a row" });
  });
});

// ── "New": SQL agrees with its specification ───────────────────────────────────────────────────────────────────────────
describe("'New' — the SQL the page runs equals the pure specification", () => {
  it("flags exactly the same candidates as newlyDiscoveredIds across every exclusion", async () => {
    const groq = await provider("groq", "Groq"); const cerebras = await provider("cerebras", "Cerebras");
    const ago = (h: number) => new Date(Date.now() - h * HOUR);
    // Every source needs an older row, otherwise all of its rows are its own first ingest.
    await candidate({ modelRef: "anchor-a-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(24 * 30) });
    await candidate({ modelRef: "anchor-b-7b", providerId: cerebras.id, source: "cerebras", firstSeenAt: ago(24 * 30) });
    await candidate({ modelRef: "fresh-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(2) });                        // new
    await candidate({ modelRef: "old-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(30) });                          // found over a day ago and still not in LiteLLM: still new
    await candidate({ modelRef: "live-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(2) });                          // in LiteLLM
    await candidate({ modelRef: "removed-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(2) });                       // was in LiteLLM
    await candidate({ modelRef: "nobody-7b", providerId: null, source: "groq", firstSeenAt: ago(2) });                           // no provider
    await candidate({ modelRef: "known-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(24 * 10) });                   // older sibling...
    await candidate({ modelRef: "Known-7B", providerId: groq.id, source: "cerebras", firstSeenAt: ago(2) });                     // ...so this is not new
    await candidate({ modelRef: "known-7b", providerId: cerebras.id, source: "cerebras", firstSeenAt: ago(2) });                 // same name, other provider: new
    await candidate({ modelRef: "edge-7b", providerId: groq.id, source: "groq", firstSeenAt: new Date(Date.now() - 24 * HOUR + 60_000) });
    await candidate({ modelRef: "boot-7b", providerId: cerebras.id, source: "fireworks_ai", firstSeenAt: ago(20) });             // first ingest of its source
    await candidate({ modelRef: "boot-8b", providerId: cerebras.id, source: "fireworks_ai", firstSeenAt: ago(20) });
    await candidate({ modelRef: "after-7b", providerId: cerebras.id, source: "fireworks_ai", firstSeenAt: ago(1) });             // a later run of that source: new
    await candidate({ modelRef: "embed-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(2), checkBlocker: "NOT_CHAT_MODEL", evidence: { nonChatReason: "Embedding model" } }); // can never be added: not new
    await candidate({ modelRef: "nokey-7b", providerId: groq.id, source: "groq", firstSeenAt: ago(2), checkBlocker: "CREDENTIAL_MISSING" });                                          // only waiting on a key: still new
    await deployment(groq.id, "openai/live-7b"); await deployment(groq.id, "openai/removed-7b", "REMOVED");

    const page = await getCandidatePage({ view: "new", pageSize: 500 });
    const everything = await getCandidatePage({ view: "all", pageSize: 500 });
    const deployments = await db().select().from(modelDeployments);
    const expected = newlyDiscoveredIds((await db().select().from(modelCandidates)).map(r => ({
      id: r.id, source: r.source, providerId: r.providerId, modelRef: r.modelRef, firstSeenAt: r.firstSeenAt,
      liteLLMLifecycle: deployments.find(d => d.providerId === r.providerId && bareModelKey(d.providerModelId) === r.modelKey)?.lifecycle ?? null, liteLLMDeploymentId: null,
      checkBlocker: r.checkBlocker, evidence: r.evidence,
    })));
    expect(new Set(page.rows.map(r => r.id))).toEqual(expected);
    expect(page.counts.new).toBe(expected.size);
    // the badge on each row agrees with the filter
    expect(new Set(everything.rows.filter(r => r.isNew).map(r => r.id))).toEqual(expected);
    expect(page.rows.map(r => r.modelRef).sort()).toEqual(["after-7b", "edge-7b", "fresh-7b", "known-7b", "known-7b", "nokey-7b", "old-7b"]);   // both "known-7b" rows: the 10-day-old groq one is still not in LiteLLM, so it keeps its badge
  });
});

describe("'New' — the identity epoch: the first run after the change is a baseline", () => {
  it("does not flag what the first post-change run surfaced, does flag a later run, and the SQL still equals the specification", async () => {
    const models = await provider("groq", "Groq");
    const ago = (h: number) => new Date(Date.now() - h * HOUR);
    const epoch = ago(20);
    await db().insert(systemSettings).values({ key: BASELINE_EPOCH_KEY, value: epoch.toISOString() });
    await candidate({ modelRef: "old-7b", providerId: models.id, source: "models_dev", firstSeenAt: ago(24 * 30) });                 // long-standing
    await candidate({ modelRef: "hidden-1-7b", providerId: models.id, source: "models_dev", firstSeenAt: ago(19) });               // surfaced by the first post-change run
    await candidate({ modelRef: "hidden-2-7b", providerId: models.id, source: "models_dev", firstSeenAt: new Date(ago(19).getTime() + 60_000) });
    await candidate({ modelRef: "really-new-7b", providerId: models.id, source: "models_dev", firstSeenAt: ago(2) });             // found by a later run: a genuine discovery
    await candidate({ modelRef: "quiet-old-7b", providerId: models.id, source: "cerebras", firstSeenAt: ago(24 * 5) });            // a source with nothing since the epoch keeps its old baseline
    await candidate({ modelRef: "quiet-new-7b", providerId: models.id, source: "cerebras", firstSeenAt: ago(22) });   // before the epoch, inside the 24h window

    const page = await getCandidatePage({ view: "new", pageSize: 500 });
    const rows = await db().select().from(modelCandidates);
    const expected = newlyDiscoveredIds(rows.map(r => ({ id: r.id, source: r.source, providerId: r.providerId, modelRef: r.modelRef, firstSeenAt: r.firstSeenAt, liteLLMLifecycle: null, liteLLMDeploymentId: null, checkBlocker: r.checkBlocker, evidence: r.evidence })), epoch);
    expect(new Set(page.rows.map(r => r.id))).toEqual(expected);
    expect(page.rows.map(r => r.modelRef).sort()).toEqual(["quiet-new-7b", "really-new-7b"]);
  });
});

// ── the SQL model_key equals the TypeScript rule ───────────────────────────────────────────────────────────────────────
describe("model_key — the SQL backfill equals bareModelKey()", () => {
  it("agrees on awkward ids: prefixes, case, punctuation, spaces, unicode, short names", async () => {
    const refs = ["meta-llama/Llama-3.1-70B-Instruct", "llama3.1-8b", "zai-org/glm-4.7-flash", "GLM-4.7-Flash", "gpt-oss-120b", "@cf/meta/llama-3.1-8b-instruct", "a/b/c/model-1.5", "x/ab", "ab", "  spaced/Model 7B  ", "openai/gpt-4o:free", "Ünï/Cödé-7b", "models/gemini-2.5-flash", "org/1234", "org/abc", "just-a-name", "a//b", "trailing/", "/leading-7b"];
    const rows = await db().execute(sql`
      select r as ref, lower(regexp_replace(
        CASE WHEN substring(btrim(r) from '[^/]*$') ~ '[0-9]' AND length(substring(btrim(r) from '[^/]*$')) >= 4
             THEN substring(btrim(r) from '[^/]*$') ELSE btrim(r) END, '[^a-zA-Z0-9]+', '', 'g')) as key
      from unnest(${sql.raw(`ARRAY[${refs.map(r => `'${r.replace(/'/g, "''")}'`).join(",")}]::text[]`)}) as t(r)`) as unknown as Array<{ ref: string; key: string }>;
    for (const { ref, key } of rows) expect(key, JSON.stringify(ref)).toBe(bareModelKey(ref));
    expect(rows).toHaveLength(refs.length);
  });
});

describe("persistDiscoveredItems keeps a stable identity when a source's own spelling drifts", () => {
  it("re-lists the same model with different casing and prefix without creating a second row", async () => {
    const state = { providerIdBySlug: new Map<string, string>(), touchedProviderIds: new Set<string>() };
    await persistDiscoveredItems(db(), [item("groq", "llama-3.3-70b-versatile")], state);
    await persistDiscoveredItems(db(), [item("groq", "Llama-3.3-70B-Versatile"), item("groq", "groq/llama-3.3-70b-versatile")], state);
    expect(await db().select().from(modelCandidates)).toHaveLength(1);
  });
});

// ── the Providers page's data ──────────────────────────────────────────────────────────────────────────────────────────
import { getProviders } from "@/server/queries";

describe("getProviders — counts come from the right rows", () => {
  it("counts each provider's own candidates, passes, ready models and deployments, and reads its linked source's health", async () => {
    const groq = await provider("groq", "Groq"); const cerebras = await provider("cerebras", "Cerebras");
    await provider("eden-ai", "Eden AI", { origin: "DISCOVERED", adapterKey: "manual", adapterCapability: "MANUAL" });
    await credential(groq.id, true);
    await candidate({ modelRef: "a-7b", providerId: groq.id, lastCheckStatus: "available", consecutivePasses: 6, verifiedFree: true });
    await candidate({ modelRef: "b-7b", providerId: groq.id, lastCheckStatus: "unavailable" });
    await candidate({ modelRef: "c-7b", providerId: cerebras.id });
    await deployment(groq.id, "openai/a-7b");
    await db().insert(modelSources).values({ name: "Groq Model Catalog", type: "CUSTOM_ADAPTER", adapterReference: "groq", providerId: groq.id, status: "HEALTHY", lastSyncAt: new Date() });
    await db().insert(providerOffers).values({ providerId: groq.id, source: "freellmapihub", freeType: "RECURRING_CREDIT", rateLimitsText: "30 RPM" });

    const rows = await getProviders();
    const by = (slug: string) => rows.find(r => r.slug === slug)!;
    expect(by("groq")).toMatchObject({ knownCount: 2, verifiedCount: 1, passingCount: 1, readyCount: 1, modelCount: 1, credentialVerified: true, readiness: "READY", freeKind: "RECURRING", availability: "verified", origin: "CATALOG" });
    expect(by("groq").offer).toMatchObject({ rateLimitsText: "30 RPM", source: "freellmapihub" });
    expect(by("cerebras")).toMatchObject({ knownCount: 1, passingCount: 0, readyCount: 0, modelCount: 0, readiness: "NEEDS_CREDENTIAL" });
    expect(by("eden-ai")).toMatchObject({ knownCount: 0, readiness: "NO_ENDPOINT", origin: "DISCOVERED" });
    // providers with models are listed first
    expect(rows.map(r => r.slug)).toEqual(["groq", "cerebras", "eden-ai"]);
  });

  it("a linked source's health reaches the provider, and a published base URL makes a derived provider testable", async () => {
    const derived = await provider("eden-ai", "Eden AI", { origin: "DISCOVERED", adapterKey: "manual", adapterCapability: "MANUAL" });
    await credential(derived.id, null, "K_EDEN2");
    await db().insert(providerOffers).values({ providerId: derived.id, source: "models_dev", freeType: "UNKNOWN", openaiBaseUrl: "https://api.eden.example/v1" });
    await db().insert(modelSources).values({ name: "Eden", type: "CUSTOM_ADAPTER", adapterReference: "eden", providerId: derived.id, status: "FAILED", lastSyncAt: new Date() });
    const [row] = await getProviders();
    // Endpoint known and a credential stored. A derived provider has no credential-check endpoint, so nothing can be "verified" in advance:
    // the real completions call is its only verification (the verifier applies the same rule), and it is testable right now.
    expect(row.readiness).toBe("READY");
    expect(row.availability).toBe("failed");
  });
});

import { getSourceYield } from "@/server/queries";

describe("getSourceYield — one aggregate, correct per source", () => {
  it("counts what each source found, how much of it is verified free, what is live in LiteLLM, and which providers it touched", async () => {
    const groq = await provider("groq", "Groq"); const cerebras = await provider("cerebras", "Cerebras");
    await candidate({ modelRef: "a-7b", providerId: groq.id, source: "openrouter", verifiedFree: true });
    await candidate({ modelRef: "b-7b", providerId: groq.id, source: "openrouter" });
    await candidate({ modelRef: "c-7b", providerId: cerebras.id, source: "openrouter", verifiedFree: true });
    await candidate({ modelRef: "d-7b", providerId: cerebras.id, source: "cerebras" });
    await deployment(groq.id, "openai/a-7b"); await deployment(groq.id, "openai/b-7b", "REMOVED");
    const yields = await getSourceYield();
    expect(yields.get("openrouter")).toEqual({ source: "openrouter", discovered: 3, verifiedFree: 2, promoted: 1, providers: ["Cerebras", "Groq"] });
    expect(yields.get("cerebras")).toEqual({ source: "cerebras", discovered: 1, verifiedFree: 0, promoted: 0, providers: ["Cerebras"] });
    expect(yields.has("groq")).toBe(false);
  });

  it("works with no deployments and no candidates", async () => {
    expect((await getSourceYield()).size).toBe(0);
    const groq = await provider("groq", "Groq");
    await candidate({ modelRef: "a-7b", providerId: groq.id, source: "openrouter" });
    expect((await getSourceYield()).get("openrouter")).toMatchObject({ discovered: 1, promoted: 0 });
  });
});
