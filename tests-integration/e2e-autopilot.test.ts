import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { candidateChecks, canonicalModels, laneAssignments, lanes, modelCandidates, modelDeployments, modelSources, providerCredentialReferences, providers } from "@/server/db/schema";
import { runDiscovery } from "@/server/discovery/run";
import { verifyDueCandidates } from "@/server/discovery/verify-due";
import type { DiscoveredCandidate, DiscoverySource, ProviderOffer } from "@/server/discovery/types";
import { runHealthMonitor } from "@/server/health/monitor";
import { compareInventory } from "@/server/litellm/parity";
import { adoptDeployment } from "@/server/litellm/adoption";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { unmanagedNotServing } from "@/server/litellm/ownership";
import { isFlapLimited, removalHistoryOf } from "@/server/discovery/auto-add-policy";
import { syncLiteLLM } from "@/server/litellm/sync";
import { saveProviderCredential } from "@/server/providers/credentials";
import { verifyAllProviders } from "@/server/providers/verify";
import { getCandidatePage, getDeployments, getProviders } from "@/server/queries";
import { saveConnection } from "@/server/settings/connections";
import { setLiteLLMManagementSettings } from "@/server/settings/litellm-management";
import { LANE_IDS, CURATOR_MANAGED_BY } from "@/lib/constants";
import { AUTO_REMOVE_AFTER_FAILURES } from "@/server/health/failure-streak";
import { PROMOTION_PASSES } from "@/server/discovery/verification-policy";
import { EMPTY, FakeWorld, OK, failWith } from "./support/fake-world";

/**
 * End to end, in RatLLM's own words: provider list -> model discovery -> model monitoring -> add to LiteLLM -> remove from LiteLLM,
 * all done by RatLLM. The outside world is simulated (support/fake-world.ts) — free-model providers and a LiteLLM router that speak
 * the real HTTP protocols — and RatLLM's real code runs against it in a disposable database.
 */

const db = () => getDb();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── the simulated sources: real registry ids, fake catalogs ────────────────────────────────────────────────────────────
const model = (source: string, modelRef: string, providerName: string, over: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate =>
  ({ source, modelRef, displayName: modelRef, providerName, freeType: "FREE_TIER", verifiedFree: true, sourceUrl: "https://catalog.fake.test", evidence: {}, ...over });
const groqCatalog = (...refs: string[]): DiscoverySource =>
  ({ id: "groq", minExpected: 1, providerSlug: "groq", discover: async () => ({ candidates: refs.map(ref => model("groq", ref, "Groq", ref.includes("whisper") ? { nonChatReason: "Speech-to-text model" } : {})), offers: [] }) });
const FAKECLOUD_BASE = "https://api.fakecloud.test/v1";
const fakecloudOffer: ProviderOffer = { source: "models_dev", providerName: "Fakecloud", freeType: "FREE_TIER", openaiBaseUrl: FAKECLOUD_BASE };
const communityCatalog = (...refs: string[]): DiscoverySource =>
  ({ id: "models_dev", minExpected: 1, discover: async () => ({ candidates: refs.map(ref => model("models_dev", ref, "Fakecloud", ref.includes("embed") ? { nonChatReason: "Embedding model" } : {})), offers: [fakecloudOffer] }) });

// ── the simulated world ────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  const world = new FakeWorld();
  world.install();
  const groq = world.provider("api.groq.com", "gsk-groq-key");
  const fakecloud = world.provider("api.fakecloud.test", "fc-key");
  groq.serve("llama-3.3-70b-versatile", "gpt-oss-20b", "gpt-oss-120b");
  fakecloud.serve("fc-chat-large", "fc-chat-mini");
  for (const slug of LANE_IDS) await db().insert(lanes).values({ slug, name: slug, description: slug });
  await saveConnection("litellm", { baseUrl: world.router.baseUrl, masterKey: world.router.masterKey });
  await setLiteLLMManagementSettings({ autoAdd: true, autoRemove: true });
  return { world, router: world.router, groq, fakecloud };
}

const providerBySlug = async (slug: string) => (await db().select().from(providers).where(eq(providers.slug, slug)))[0];
const candidateOf = async (source: string, modelRef: string) => (await db().select().from(modelCandidates).where(eq(modelCandidates.modelRef, modelRef))).find(row => row.source === source)!;
const refresh = async (id: string) => (await db().select().from(modelCandidates).where(eq(modelCandidates.id, id)))[0];
const liveDeployments = async () => (await db().select().from(modelDeployments)).filter(row => row.lifecycle === "ACTIVE");

/** Makes every candidate due now, then runs one verification pass — what the hourly job does, without waiting an hour. */
async function verifyPass() {
  await db().update(modelCandidates).set({ nextCheckAt: new Date(Date.now() - 1000) });
  return verifyDueCandidates();
}
/** Gives the provider a credential the way an operator would, and lets RatLLM verify it. */
async function connectProvider(slug: string, apiKey: string, envVar: string) {
  await saveProviderCredential((await providerBySlug(slug)).id, { apiKey, environmentVariable: envVar }, `e2e-${slug}`);
  await verifyAllProviders();
}

/** Pretends `ms` has passed for everything discovery has already recorded, so the next run is a later run, not the first ingest. */
const ageDiscovery = (ms: number) => db().execute(sql`update model_candidates set first_seen_at = first_seen_at - ${ms} * interval '1 millisecond', last_seen_at = last_seen_at - ${ms} * interval '1 millisecond'`);
const newIds = async () => new Set((await getCandidatePage({ view: "new", pageSize: 500 })).rows.map(row => row.modelRef));
/** The whole first half of the lifecycle for the usual Groq models, leaving them added to LiteLLM. */
async function groqAdded(models: string[] = ["llama-3.3-70b-versatile", "gpt-oss-20b", "gpt-oss-120b"]) {
  const context = await boot();
  context.groq.serve(...models);
  await runDiscovery({ sources: [groqCatalog(...models)] });
  await connectProvider("groq", "gsk-groq-key", "GROQ_API_KEY");
  for (let pass = 0; pass < PROMOTION_PASSES; pass++) await verifyPass();
  return context;
}
const trackedNow = async () => (await getDeployments()).map(row => ({ litellmDeploymentId: row.litellmDeploymentId, litellmModelName: row.litellmModelName, providerModelId: row.providerModelId, managed: row.managed, lifecycle: row.lifecycle ?? "ACTIVE" }));
const healthRuns = async (times: number) => { for (let run = 0; run < times; run++) await runHealthMonitor({ limit: 100 }); };
/** Moves a candidate's recorded removals into the past, as if `hours` had gone by since each one. */
async function ageRemovals(candidateId: string, hours: number) {
  const evidence = (await refresh(candidateId)).evidence as Record<string, unknown>;
  const history = removalHistoryOf(evidence).map((entry, index) => ({ ...entry, at: new Date(Date.now() - (hours + index) * HOUR).toISOString() }));
  await db().update(modelCandidates).set({ evidence: { ...evidence, removalHistory: history } }).where(eq(modelCandidates.id, candidateId));
}
const sourceRow = async (id: string) => (await db().select().from(modelSources).where(eq(modelSources.adapterReference, id)))[0];

describe("E2E autopilot: provider list -> discovery -> monitoring -> add -> remove", () => {
  it("runs the whole lifecycle with no human in the loop", async () => {
    const { router, groq, fakecloud } = await boot();

    // 1. PROVIDER LIST + DISCOVERY — sources publish catalogs; RatLLM derives the providers and lists the models.
    await runDiscovery({ sources: [groqCatalog("llama-3.3-70b-versatile", "gpt-oss-20b", "gpt-oss-120b", "whisper-large-v3"), communityCatalog("fc-chat-large", "fc-chat-mini", "fc-embed")] });
    const providerList = (await getProviders()).map(row => row.slug);
    expect(providerList).toEqual(expect.arrayContaining(["groq", "fakecloud"]));
    const groqModels = await candidateOf("groq", "llama-3.3-70b-versatile");
    expect(groqModels.providerId).toBe((await providerBySlug("groq")).id);
    expect((await candidateOf("models_dev", "fc-chat-large")).providerId).toBe((await providerBySlug("fakecloud")).id);
    // a non-chat model is discovered and listed, but is blocked, so it is never sent a chat call or added
    expect((await candidateOf("groq", "whisper-large-v3")).evidence).toMatchObject({ nonChatReason: "Speech-to-text model" });
    expect((await getCandidatePage({ pageSize: 100 })).rows.map(row => row.modelRef)).toEqual(expect.arrayContaining(["llama-3.3-70b-versatile", "fc-chat-large", "fc-embed", "whisper-large-v3"]));
    expect(router.count()).toBe(0);                                  // discovery alone adds nothing to LiteLLM

    // 2. CREDENTIALS — the operator adds keys; RatLLM verifies them against the providers' own check endpoints.
    await connectProvider("groq", "gsk-groq-key", "GROQ_API_KEY");
    await connectProvider("fakecloud", "fc-key", "FAKECLOUD_API_KEY");
    expect((await db().select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, (await providerBySlug("groq")).id)))[0].valid).toBe(true);

    // 3. MONITORING — hourly checks build a streak of real passes; nothing is added before the streak is earned.
    for (let pass = 1; pass < PROMOTION_PASSES; pass++) {
      await verifyPass();
      expect(router.count()).toBe(0);
      expect((await refresh(groqModels.id)).consecutivePasses).toBe(pass);
    }
    expect(groq.callsTo("whisper-large-v3")).toBe(0);               // the non-chat model never got a call
    expect(fakecloud.callsTo("fc-embed")).toBe(0);

    // 4. ADD — the fifth pass earns it, and RatLLM adds it to LiteLLM by itself.
    await verifyPass();
    expect(router.count()).toBeGreaterThan(0);
    const inRouter = router.list();
    expect(inRouter.every(item => item.model_info.managed_by === CURATOR_MANAGED_BY)).toBe(true);
    expect(inRouter.some(item => String(item.litellm_params.model).endsWith("llama-3.3-70b-versatile"))).toBe(true);
    expect(inRouter.some(item => String(item.litellm_params.model).endsWith("fc-chat-large"))).toBe(true);
    expect(inRouter.some(item => /whisper|embed/.test(String(item.litellm_params.model)))).toBe(false);
    const added = await refresh(groqModels.id);
    expect(added.addedBy).toBe("auto");
    expect(added.addedToLitellmAt).not.toBeNull();
    // RatLLM's own records match the router exactly: nothing missing, nothing extra, same owners
    const tracked = (await getDeployments()).map(row => ({ litellmDeploymentId: row.litellmDeploymentId, litellmModelName: row.litellmModelName, providerModelId: row.providerModelId, managed: row.managed, lifecycle: row.lifecycle ?? "ACTIVE" }));
    expect(compareInventory(tracked, router.list() as never).inSync).toBe(true);
    expect((await db().select().from(laneAssignments)).length).toBeGreaterThan(0);
    // it is no longer a "New" model, and it now shows as in LiteLLM
    expect((await getCandidatePage({ view: "new", pageSize: 100 })).rows.map(row => row.id)).not.toContain(groqModels.id);
    expect((await getCandidatePage({ view: "added", pageSize: 100 })).rows.map(row => row.id)).toContain(groqModels.id);

    // 5. MONITOR — healthy deployments stay healthy.
    await runHealthMonitor({ limit: 100 });
    expect((await liveDeployments()).every(row => row.health === "HEALTHY")).toBe(true);

    // 6. REMOVE — a model dies at its provider; after repeated failures RatLLM takes it out of LiteLLM by itself.
    // One model can sit in several lanes, and each of those deployments is failing for the same reason.
    const target = (await liveDeployments()).find(row => row.providerModelId.endsWith("gpt-oss-20b"))!;
    const victims = (await liveDeployments()).filter(row => row.providerId === target.providerId && row.providerModelId === target.providerModelId);
    expect(victims.length).toBeGreaterThan(0);
    groq.set(target.providerModelId.replace(/^openai\//, ""), failWith(500, "Internal error"));
    for (let run = 1; run < AUTO_REMOVE_AFTER_FAILURES; run++) {
      await runHealthMonitor({ limit: 100 });
      for (const victim of victims) expect(router.ids()).toContain(victim.litellmDeploymentId);   // not yet: the streak is still short
    }
    await runHealthMonitor({ limit: 100 });
    for (const victim of victims) {
      expect(router.ids()).not.toContain(victim.litellmDeploymentId);                 // removed from LiteLLM
      expect(router.eventsOf("delete").map(event => event.id)).toContain(victim.litellmDeploymentId);
      expect((await db().select().from(modelDeployments).where(eq(modelDeployments.id, victim.id)))[0].lifecycle).toBe("REMOVED");
      expect((await db().select().from(laneAssignments).where(eq(laneAssignments.deploymentId, victim.id))).every(row => row.excluded)).toBe(true);
      expect((await db().select().from(canonicalModels).where(eq(canonicalModels.id, victim.canonicalModelId)))[0].lifecycle).toBe("QUARANTINED");
    }
    // everything else was untouched, and RatLLM's records still match the router exactly
    expect(router.count()).toBe(inRouter.length - victims.length);
    const removed = (await refresh((await candidateOf("groq", "gpt-oss-20b")).id)).evidence as { removalHistory?: unknown[] };
    expect(removed.removalHistory?.length).toBe(1);
    expect(compareInventory((await getDeployments()).map(row => ({ litellmDeploymentId: row.litellmDeploymentId, litellmModelName: row.litellmModelName, providerModelId: row.providerModelId, managed: row.managed, lifecycle: row.lifecycle ?? "ACTIVE" })), router.list() as never).inSync).toBe(true);
    void EMPTY;
  });

  it("finds new models and new providers on later discovery runs, lists them, and adds them by itself", async () => {
    const { world, router, groq, fakecloud } = await boot();
    await runDiscovery({ sources: [groqCatalog("llama-3.3-70b-versatile"), communityCatalog("fc-chat-large")] });
    // the first ingest of a source is a baseline dump of what it already listed, not a set of discoveries
    expect(await newIds()).toEqual(new Set());
    await ageDiscovery(3 * DAY);

    // a later run: Groq publishes a new model, and a source starts listing a brand-new provider
    const nimbusOffer: ProviderOffer = { source: "models_dev", providerName: "Nimbus AI", freeType: "FREE_TIER", openaiBaseUrl: "https://api.nimbus.test/v1" };
    const nimbus = world.provider("api.nimbus.test", "nb-key").serve("nimbus-1");
    const later: DiscoverySource = { id: "models_dev", minExpected: 1, discover: async () => ({ candidates: [model("models_dev", "fc-chat-large", "Fakecloud"), model("models_dev", "nimbus-1", "Nimbus AI"), model("models_dev", "nimbus-embed", "Nimbus AI", { nonChatReason: "Embedding model" })], offers: [fakecloudOffer, nimbusOffer] }) };
    groq.serve("gpt-oss-safeguard-20b");
    await runDiscovery({ sources: [groqCatalog("llama-3.3-70b-versatile", "gpt-oss-safeguard-20b"), later] });

    expect((await getProviders()).map(row => row.slug)).toEqual(expect.arrayContaining(["groq", "fakecloud", "nimbus-ai"]));   // the provider list grew
    expect(await newIds()).toEqual(new Set(["gpt-oss-safeguard-20b", "nimbus-1"]));      // exactly the genuinely new chat models: not the old ones, not the embedding model
    const listed = (await getCandidatePage({ pageSize: 500 })).rows.map(row => row.modelRef);
    expect(listed).toEqual(expect.arrayContaining(["gpt-oss-safeguard-20b", "nimbus-1", "nimbus-embed", "llama-3.3-70b-versatile", "fc-chat-large"]));

    // it keeps the badge until it is in LiteLLM — days of waiting for a key does not lose it
    await ageDiscovery(5 * DAY);
    expect((await newIds()).has("nimbus-1")).toBe(true);

    // the operator connects Nimbus; RatLLM verifies, earns the streak and adds it, and the badge goes away
    await connectProvider("groq", "gsk-groq-key", "GROQ_API_KEY");
    await connectProvider("nimbus-ai", "nb-key", "NIMBUS_API_KEY");
    expect((await getCandidatePage({ view: "setup", pageSize: 500 })).rows.map(row => row.modelRef)).not.toContain("nimbus-1");
    for (let pass = 0; pass < PROMOTION_PASSES; pass++) await verifyPass();
    expect(router.list().some(item => String(item.litellm_params.model).endsWith("nimbus-1"))).toBe(true);
    expect(nimbus.callsTo("nimbus-embed")).toBe(0);
    expect((await newIds()).has("nimbus-1")).toBe(false);
    expect((await newIds()).has("nimbus-embed")).toBe(false);
    void fakecloud;
  });

  it("keeps working when a source fails, and a provider without a key waits on setup instead of being tested", async () => {
    const { router } = await boot();
    const broken: DiscoverySource = { id: "openrouter", discover: async () => { throw new Error("catalog is down"); } };
    const result = await runDiscovery({ sources: [groqCatalog("llama-3.3-70b-versatile"), broken, communityCatalog("fc-chat-large")] });
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "openrouter", status: "failed" }), expect.objectContaining({ source: "groq", status: "succeeded" })]));
    expect((await sourceRow("openrouter")).status).toBe("FAILED");
    expect((await sourceRow("groq")).status).toBe("HEALTHY");
    expect((await candidateOf("groq", "llama-3.3-70b-versatile")).id).toBeTruthy();     // the healthy sources still persisted

    // no credentials yet: nothing is tested, nothing is added, and the models say what they are waiting for
    await verifyPass();
    expect((await refresh((await candidateOf("groq", "llama-3.3-70b-versatile")).id)).checkBlocker).toBe("CREDENTIAL_MISSING");
    expect((await getCandidatePage({ view: "setup", pageSize: 500 })).rows.map(row => row.modelRef)).toEqual(expect.arrayContaining(["llama-3.3-70b-versatile", "fc-chat-large"]));
    expect(router.count()).toBe(0);
    expect((await db().select().from(candidateChecks)).length).toBe(0);                 // no call was made without a key

    // the source recovers on the next run and everything else is unaffected
    await runDiscovery({ sources: [{ id: "openrouter", minExpected: 1, discover: async () => ({ candidates: [model("openrouter", "vendor/free-model:free", "OpenRouter")], offers: [] }) }] });
    expect((await sourceRow("openrouter")).status).toBe("HEALTHY");
    expect((await db().select().from(modelCandidates)).map(row => row.modelRef)).toEqual(expect.arrayContaining(["llama-3.3-70b-versatile", "fc-chat-large", "vendor/free-model:free"]));
  });

  it("does not let one model's auth error condemn a provider's key, but does notice a really revoked key", async () => {
    const { router, groq } = await boot();
    groq.serve("quota-out-7b", "needs-payment-7b");
    await runDiscovery({ sources: [groqCatalog("llama-3.3-70b-versatile", "gpt-oss-20b", "gpt-oss-120b", "quota-out-7b", "needs-payment-7b")] });
    await connectProvider("groq", "gsk-groq-key", "GROQ_API_KEY");
    const credential = async () => (await db().select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, (await providerBySlug("groq")).id)))[0];
    expect((await credential()).valid).toBe(true);

    // two models answer 403 / 401 for their own reasons; the key is fine and every other model still works
    groq.set("quota-out-7b", failWith(403, "Free quota exhausted for this model"));
    groq.set("needs-payment-7b", failWith(401, "No payment method for this model"));
    for (let pass = 0; pass < PROMOTION_PASSES; pass++) await verifyPass();
    expect((await credential()).valid).toBe(true);                                       // still valid
    expect(router.list().some(item => String(item.litellm_params.model).endsWith("llama-3.3-70b-versatile"))).toBe(true);   // the healthy models were still added
    expect(router.list().some(item => /quota-out|needs-payment/.test(String(item.litellm_params.model)))).toBe(false);

    // now the key is genuinely revoked: the provider's own check says so, and RatLLM stops calling with it
    groq.rotateKey("gsk-some-other-key");
    await verifyPass();
    expect((await credential()).valid).toBe(false);
    const callsBefore = groq.calls.length;
    await verifyPass();
    expect(groq.calls.length).toBe(callsBefore);                                         // blocked: no more calls with a dead key
    // the operator rotates the key; RatLLM verifies it and resumes
    await connectProvider("groq", "gsk-some-other-key", "GROQ_API_KEY");
    expect((await credential()).valid).toBe(true);
    await verifyPass();
    expect(groq.calls.length).toBeGreaterThan(callsBefore);
  });

  it("keeps RatLLM's own probing of a small free tier inside its daily budget, and backs off when the provider says 429", async () => {
    const { world } = await boot();
    const or = world.provider("openrouter.ai", "sk-or-key");
    const refs = Array.from({ length: 40 }, (_, i) => `vendor/free-${i}:free`);
    for (const ref of refs) or.serve(ref);
    await runDiscovery({ sources: [{ id: "openrouter", minExpected: 1, providerSlug: "openrouter", discover: async () => ({ candidates: refs.map(ref => model("openrouter", ref, "OpenRouter")), offers: [] }) }] });
    await connectProvider("openrouter", "sk-or-key", "OPENROUTER_API_KEY");
    await verifyPass();
    const firstDay = or.calls.length;
    expect(firstDay).toBeLessThanOrEqual(14);                                            // OpenRouter's budget is 24 a day, 60% of it for discovery checks
    expect(firstDay).toBeGreaterThan(0);
    await verifyPass(); await verifyPass();
    expect(or.calls.length).toBe(firstDay);                                              // spent for the day: no more calls, however often the job runs
    // calls age out of the 24 hours and checking resumes
    await db().execute(sql`update candidate_checks set created_at = created_at - interval '25 hours'`);
    await verifyPass();
    expect(or.calls.length).toBeGreaterThan(firstDay);
  });

  it("brings a removed model back once it recovers and its cooldown passes, but stops re-adding one that keeps dying", async () => {
    const { router, groq } = await groqAdded();
    const candidate = await candidateOf("groq", "gpt-oss-20b");
    const inRouter = () => router.list().filter(item => String(item.litellm_params.model).endsWith("gpt-oss-20b")).length;
    const lanesOfModel = inRouter();
    expect(lanesOfModel).toBeGreaterThan(1);                          // one model in several lanes: the case that used to count one incident several times

    for (let cycle = 1; cycle <= 3; cycle++) {
      // it breaks and is taken out of LiteLLM
      groq.set("gpt-oss-20b", failWith(500, "Internal error"));
      await healthRuns(AUTO_REMOVE_AFTER_FAILURES);
      expect(inRouter()).toBe(0);
      const history = removalHistoryOf((await refresh(candidate.id)).evidence);
      expect(history).toHaveLength(cycle);                             // one incident is one removal, however many lanes it was in
      // it recovers at the provider, but RatLLM waits out the cooldown before trusting it again
      groq.set("gpt-oss-20b", OK);
      await verifyPass();
      expect(inRouter()).toBe(0);
      // cooldown over: it is added back automatically — unless it has now flapped too many times
      await ageRemovals(candidate.id, 7);
      await verifyPass();
      if (cycle < 3) {
        expect(inRouter()).toBe(lanesOfModel);
        expect(isFlapLimited(removalHistoryOf((await refresh(candidate.id)).evidence))).toBe(false);
      } else {
        expect(isFlapLimited(removalHistoryOf((await refresh(candidate.id)).evidence))).toBe(true);
        expect(inRouter()).toBe(0);                                    // three removals in 30 days: it now needs a human
      }
      await ageRemovals(candidate.id, 2 * DAY / HOUR / 2);              // spread the incidents apart in time
    }
    expect(compareInventory(await trackedNow(), router.list() as never).inSync).toBe(true);
  });

  it("notices changes made outside RatLLM, never auto-removes what it does not manage, and takes over what is adopted", async () => {
    const { router, groq } = await groqAdded(["llama-3.3-70b-versatile", "gpt-oss-20b", "gpt-oss-120b"]);
    // someone adds a model straight into LiteLLM
    groq.serve("legacy-model");
    const legacyId = router.addExternally("smart-general", "openai/legacy-model", "https://api.groq.com/openai/v1", "gsk-groq-key", "legacy-tool");
    const before = compareInventory(await trackedNow(), router.list() as never);
    expect(before.inSync).toBe(false);
    expect(before.unknownToRatllm.map(issue => issue.deploymentId)).toContain(legacyId);   // the LiteLLM page would warn about it right away
    await syncLiteLLM();
    expect(compareInventory(await trackedNow(), router.list() as never).inSync).toBe(true);
    const imported = (await db().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, legacyId)))[0];
    expect(imported.managed).toBe(false);

    // it breaks: RatLLM sees it fail, but only removes what it manages, and says so
    groq.set("legacy-model", failWith(500, "Internal error"));
    await healthRuns(AUTO_REMOVE_AFTER_FAILURES + 2);
    expect(router.ids()).toContain(legacyId);
    const stuck = unmanagedNotServing(await getDeployments());
    expect(stuck.map(row => row.litellmDeploymentId)).toContain(legacyId);

    // the operator adopts it; from then on it is RatLLM's, and auto-removal applies
    const result = await adoptDeployment(new HttpLiteLLMAdapter(), legacyId, "legacy-tool");
    expect(result.ok).toBe(true);
    expect(router.get(legacyId)?.model_info.managed_by).toBe(CURATOR_MANAGED_BY);
    expect(router.get(legacyId)?.model_info.adopted_from).toBe("legacy-tool");
    await syncLiteLLM();
    expect((await db().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, legacyId)))[0].managed).toBe(true);
    await healthRuns(AUTO_REMOVE_AFTER_FAILURES);
    expect(router.ids()).not.toContain(legacyId);

    // something removed from LiteLLM by hand is noticed on the next sync, not left looking live
    const other = (await liveDeployments()).find(row => row.providerModelId.endsWith("gpt-oss-120b"))!;
    router.removeExternally(other.litellmDeploymentId!);
    expect(compareInventory(await trackedNow(), router.list() as never).goneFromRouter.map(issue => issue.deploymentId)).toContain(other.litellmDeploymentId);
    await syncLiteLLM();
    expect((await db().select().from(modelDeployments).where(eq(modelDeployments.id, other.id)))[0].lifecycle).toBe("REMOVED");
    expect(compareInventory(await trackedNow(), router.list() as never).inSync).toBe(true);
  });

  it("obeys the auto-add and auto-remove switches and the lane caps, and adds a waiting model as soon as there is room", async () => {
    const { router, groq } = await boot();
    await runDiscovery({ sources: [groqCatalog("llama-3.3-70b-versatile", "gpt-oss-20b", "gpt-oss-120b")] });
    await connectProvider("groq", "gsk-groq-key", "GROQ_API_KEY");

    // auto-add off: the models earn their streak and wait; nothing is added
    await setLiteLLMManagementSettings({ autoAdd: false });
    for (let pass = 0; pass < PROMOTION_PASSES + 1; pass++) await verifyPass();
    expect(router.count()).toBe(0);
    expect((await getCandidatePage({ view: "ready", pageSize: 100 })).rows.length).toBe(3);   // "Ready to add" — for the human button
    // switched on: the next run adds them
    await setLiteLLMManagementSettings({ autoAdd: true });
    await verifyPass();
    expect(router.count()).toBeGreaterThan(0);

    // auto-remove off: a dead model stays, however long it fails
    await setLiteLLMManagementSettings({ autoRemove: false });
    const before = router.count();
    groq.set("gpt-oss-120b", failWith(500, "Internal error"));
    await healthRuns(AUTO_REMOVE_AFTER_FAILURES + 2);
    expect(router.count()).toBe(before);
    await setLiteLLMManagementSettings({ autoRemove: true });
    await healthRuns(1);
    expect(router.count()).toBeLessThan(before);

    // a full lane defers the add instead of overfilling it
    groq.serve("new-general-model");
    for (let i = 0; i < 12; i++) router.addExternally("smart-general", `openai/filler-${i}`, "https://api.groq.com/openai/v1", "gsk-groq-key", CURATOR_MANAGED_BY);
    await syncLiteLLM();
    await ageDiscovery(2 * DAY);
    await runDiscovery({ sources: [groqCatalog("llama-3.3-70b-versatile", "gpt-oss-20b", "new-general-model")] });
    for (let pass = 0; pass < PROMOTION_PASSES; pass++) await verifyPass();
    const waiting = await candidateOf("groq", "new-general-model");
    expect(router.list().some(item => String(item.litellm_params.model).endsWith("new-general-model") && item.model_name === "smart-general")).toBe(false);
    expect(((await refresh(waiting.id)).evidence as { autoAddDeferredUntil?: string }).autoAddDeferredUntil).toBeTruthy();
    // a place opens up and the deferral runs out: it is added without waiting for its next scheduled check
    // (the lane holds the real models added earlier plus the twelve fillers, so several places must open for it to be under its cap of 12)
    for (const id of router.ids("smart-general").filter(id => /filler-[0-4]$/.test(String(router.get(id)?.litellm_params.model)))) router.removeExternally(id);
    await syncLiteLLM();
    await db().update(modelCandidates).set({ evidence: { ...((await refresh(waiting.id)).evidence as object), autoAddDeferredUntil: new Date(Date.now() - HOUR).toISOString() } }).where(eq(modelCandidates.id, waiting.id));
    await verifyPass();
    expect(router.list().some(item => String(item.litellm_params.model).endsWith("new-general-model") && item.model_name === "smart-general")).toBe(true);
  });

  it("does not mistake a LiteLLM outage for dead models, and carries on when it is back", async () => {
    const { router } = await groqAdded();
    const before = router.count();
    router.down = 503;
    await healthRuns(AUTO_REMOVE_AFTER_FAILURES + 2);                    // the router is failing every probe, for longer than the removal threshold
    router.down = null;
    expect(router.count()).toBe(before);
    expect((await liveDeployments()).length).toBe(before);              // nothing was removed on the strength of an outage
    await healthRuns(1);
    expect((await liveDeployments()).every(row => row.health === "HEALTHY")).toBe(true);
    // a sync during the outage fails cleanly and changes nothing
    router.down = 503;
    await expect(syncLiteLLM()).rejects.toBeTruthy();
    router.down = null;
    expect(compareInventory(await trackedNow(), router.list() as never).inSync).toBe(true);
  });

  it("tells a dead model from a busy one: rate-limited stays, vanished or empty-answering is removed", async () => {
    const models = ["llama-3.3-70b-versatile", "gpt-oss-20b", "gpt-oss-120b", "gpt-oss-safeguard-20b", "steady-model"];
    const { router, groq } = await groqAdded(models);
    const lanesOf = (name: string) => router.list().filter(item => String(item.litellm_params.model).endsWith(name)).length;
    const before = Object.fromEntries(models.map(name => [name, lanesOf(name)]));
    expect(Object.values(before).every(count => count > 0)).toBe(true);

    groq.set("llama-3.3-70b-versatile", failWith(429, "Rate limit reached"));   // busy: it answered, just not now
    groq.drop("gpt-oss-20b");                                                   // vanished from the provider (404)
    groq.set("gpt-oss-120b", EMPTY);                                            // answers nothing
    await healthRuns(AUTO_REMOVE_AFTER_FAILURES + 3);

    expect(lanesOf("llama-3.3-70b-versatile")).toBe(before["llama-3.3-70b-versatile"]);   // a 429 never counts against a model
    expect(lanesOf("gpt-oss-20b")).toBe(0);
    expect(lanesOf("gpt-oss-120b")).toBe(0);
    expect(lanesOf("gpt-oss-safeguard-20b")).toBe(before["gpt-oss-safeguard-20b"]);
    expect(lanesOf("steady-model")).toBe(before["steady-model"]);
    // the discovered-models list still shows the vanished model; it is simply no longer in LiteLLM
    expect((await getCandidatePage({ pageSize: 100 })).rows.map(row => row.modelRef)).toEqual(expect.arrayContaining(models));
    expect((await getCandidatePage({ view: "added", pageSize: 100 })).rows.map(row => row.modelRef)).not.toContain("gpt-oss-20b");
    expect(compareInventory(await trackedNow(), router.list() as never).inSync).toBe(true);
  });
});
