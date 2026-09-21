import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, candidateChecks, modelCandidates, modelDeployments, smokeTests } from "@/server/db/schema";
import { runHealthMonitor, type HealthAdapter } from "@/server/health/monitor";
import { syncLiteLLM } from "@/server/litellm/sync";
import { setLiteLLMManagementSettings } from "@/server/settings/litellm-management";
import { CURATOR_MANAGED_BY } from "@/lib/constants";

type Reply = { ok: boolean; status: number };
const PASS: Reply = { ok: true, status: 200 };
const FAIL_500: Reply = { ok: false, status: 500 };
const AUTH_401: Reply = { ok: false, status: 401 };
const UNREACHABLE: Reply = { ok: false, status: 0 };

const MODELS: Record<string, string> = { groq: "groq/llama-3.3-70b-versatile", cerebras: "cerebras/llama3.1-8b", mistral: "mistral/mistral-small-latest", cohere: "cohere/command-r" };

/** A fleet of RatLLM-managed deployments, `count` per provider, ids like "groq-1". */
async function seedFleet(counts: Record<string, number>) {
  const items = Object.entries(counts).flatMap(([provider, count]) =>
    Array.from({ length: count }, (_, i) => ({ model_name: "smart-general", litellm_params: { model: `${MODELS[provider]}-${i + 1}` }, model_info: { id: `${provider}-${i + 1}`, managed_by: CURATOR_MANAGED_BY } })));
  await syncLiteLLM({}, { listDeployments: async () => items } as never);
  await setLiteLLMManagementSettings({ autoRemove: true });
}

/** A router whose per-deployment answers the test controls. Records every removal it is asked to perform. */
function fakeRouter(defaultReply: Reply = PASS) {
  const replies = new Map<string, Reply>();
  const removed: string[] = [];
  const adapter: HealthAdapter = {
    smokeTest: async (id: string) => { const reply = replies.get(id) ?? defaultReply; return { ...reply, latencyMs: 120, error: reply.ok ? undefined : `HTTP ${reply.status}`, content: reply.ok ? "OK" : undefined } as never; },
    removeDeployment: async (id: string) => { removed.push(id); },
  };
  return { adapter, removed, set: (ids: string[], reply: Reply) => ids.forEach(id => replies.set(id, reply)), clear: () => replies.clear() };
}
const runs = async (router: ReturnType<typeof fakeRouter>, times: number) => { for (let i = 0; i < times; i++) await runHealthMonitor({ limit: 100, adapter: router.adapter }); };
const ids = (provider: string, count: number) => Array.from({ length: count }, (_, i) => `${provider}-${i + 1}`);
const lifecycleOf = async (routerId: string) => (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, routerId)))[0]?.lifecycle;
const errorCodesFor = async (routerId: string) => {
  const dep = (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, routerId)))[0];
  return (await getDb().select().from(smokeTests).where(eq(smokeTests.deploymentId, dep.id))).map(row => row.errorCode);
};

describe("auto-removal still removes what is genuinely dead", () => {
  it("removes ONE broken deployment after 5 consecutive genuine failures, and only that one", async () => {
    await seedFleet({ groq: 2, cerebras: 3, mistral: 3 });
    const router = fakeRouter();
    router.set(["groq-1"], FAIL_500);
    await runs(router, 4);
    expect(router.removed).toEqual([]);                 // not yet: streak is 4
    await runs(router, 1);
    expect(router.removed).toEqual(["groq-1"]);         // 5th consecutive genuine failure
    expect(await lifecycleOf("groq-2")).toBe("ACTIVE");
  });
});

describe("a credential problem is not a dead model", () => {
  it("never removes deployments that fail with 401/403, however long the key stays broken", async () => {
    await seedFleet({ groq: 3, cerebras: 3, mistral: 3 });
    const router = fakeRouter();
    await runs(router, 1); // everything healthy once
    router.set(ids("groq", 3), AUTH_401);
    await runs(router, 12);
    expect(router.removed).toEqual([]);
    expect(await lifecycleOf("groq-1")).toBe("ACTIVE");
    expect(new Set(await errorCodesFor("groq-1"))).toEqual(new Set(["HEALTHY", "AUTH_ERROR"])); // recorded honestly as an auth error
  });
});

describe("an incident is not a mass extinction", () => {
  it("does not remove a widespread outage's victims, tags the failures SYSTEMIC, and records the incident", async () => {
    await seedFleet({ groq: 3, cerebras: 3, mistral: 2, cohere: 2 });
    const router = fakeRouter();
    await runs(router, 1); // all healthy: each deployment has a recent pass
    const victims = [...ids("groq", 3), ...ids("cerebras", 3), ...ids("mistral", 1)]; // 7 of 10 fail
    router.set(victims, FAIL_500);
    await runs(router, 8);
    expect(router.removed).toEqual([]);
    for (const victim of victims) expect(await lifecycleOf(victim)).toBe("ACTIVE");
    expect(await errorCodesFor("groq-1")).toContain("SYSTEMIC");
    const incidents = await getDb().select().from(auditEvents).where(eq(auditEvents.action, "litellm.health.systemic_failure"));
    expect(incidents.length).toBeGreaterThan(0);
  });

  it("does not remove anything when the router itself is unreachable", async () => {
    await seedFleet({ groq: 3, cerebras: 3 });
    const router = fakeRouter();
    await runs(router, 1);
    router.clear();
    const down = fakeRouter(UNREACHABLE);
    await runs(down, 8);
    expect(down.removed).toEqual([]);
    expect(await lifecycleOf("groq-1")).toBe("ACTIVE");
    expect(await errorCodesFor("groq-1")).toContain("SYSTEMIC");
  });

  it("does not remove a provider whose deployments ALL fail together (a provider outage)", async () => {
    await seedFleet({ groq: 3, cerebras: 3, mistral: 3 });
    const router = fakeRouter();
    await runs(router, 1);
    router.set(ids("groq", 3), FAIL_500); // 3 of 9 = 33%: not router-wide, but 100% of groq
    await runs(router, 8);
    expect(router.removed).toEqual([]);
    expect(await lifecycleOf("groq-2")).toBe("ACTIVE");
  });

  it("recovers cleanly: once the incident passes, deployments are healthy and their streak starts from zero", async () => {
    await seedFleet({ groq: 3, cerebras: 3, mistral: 3 });
    const router = fakeRouter();
    await runs(router, 1);
    router.set(ids("groq", 3), FAIL_500);
    await runs(router, 6);
    router.clear();
    await runs(router, 1);
    const dep = (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, "groq-1")))[0];
    expect(dep.health).toBe("HEALTHY");
    // One genuine failure now must not tip it over on the back of the incident's rows.
    router.set(["groq-1"], FAIL_500);
    await runs(router, 1);
    expect(router.removed).toEqual([]);
  });
});

describe("the incident shield expires, so a provider that retires everything is still cleaned up", () => {
  it("removes a whole provider's dead deployments once none has passed for over 24 hours", async () => {
    await seedFleet({ groq: 3, cerebras: 3, mistral: 3 });
    const router = fakeRouter();
    await runs(router, 1);
    // Age every groq pass beyond the grace window: these have been dead for a long time, not just during a blip.
    for (const id of ids("groq", 3)) {
      const dep = (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, id)))[0];
      await getDb().update(smokeTests).set({ createdAt: new Date(Date.now() - 30 * 60 * 60_000) }).where(eq(smokeTests.deploymentId, dep.id));
    }
    router.set(ids("groq", 3), FAIL_500);
    await runs(router, 5);
    expect(router.removed.sort()).toEqual(ids("groq", 3));
  });
});

describe("provider call budget", () => {
  it("is never starved by what discovery spent: candidate checks alone do not stop health probes", async () => {
    await seedFleet({ groq: 2, cerebras: 2 });
    const candidate = (await getDb().insert(modelCandidates).values({ source: "groq", modelRef: "m", displayName: "m", sourceUrl: "u", providerId: (await getDb().select().from(modelDeployments))[0].providerId }).returning())[0];
    // far more than the whole daily budget already spent on candidate checks at every provider
    await getDb().insert(candidateChecks).values(Array.from({ length: 500 }, () => ({ candidateId: candidate.id, status: "available" as const, httpStatus: 200 })));
    const probed: string[] = [];
    const adapter: HealthAdapter = { smokeTest: async (id: string) => { probed.push(id); return { ok: true, status: 200, latencyMs: 100, content: "OK" } as never; }, removeDeployment: async () => undefined };
    await runHealthMonitor({ limit: 100, adapter });
    expect(probed.length).toBe(4);
  });

  it("does not probe a provider whose daily budget is already spent, and keeps probing the rest", async () => {
    await seedFleet({ groq: 2, cerebras: 2 });
    const groqDeployment = (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, "groq-1")))[0];
    // groq's budget is 200 calls a day; 200 real probes in the last 24 hours use all of it
    await getDb().insert(smokeTests).values(Array.from({ length: 200 }, () => ({ deploymentId: groqDeployment.id, correlationId: "budget-test", status: "PASSED" as const, latencyMs: 100, httpStatus: 200 })));
    const probed: string[] = [];
    const adapter: HealthAdapter = { smokeTest: async (id: string) => { probed.push(id); return { ok: true, status: 200, latencyMs: 100, content: "OK" } as never; }, removeDeployment: async () => undefined };
    await runHealthMonitor({ limit: 100, adapter });
    expect(probed.sort()).toEqual(["cerebras-1", "cerebras-2"]);
  });
});
