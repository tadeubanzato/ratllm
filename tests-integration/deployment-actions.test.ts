import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, laneAssignments, lanes, modelDeployments, providers } from "@/server/db/schema";
import { syncLiteLLM } from "@/server/litellm/sync";
import { CURATOR_MANAGED_BY } from "@/lib/constants";

// A stand-in router the route talks to. `patchMode` decides whether its update merges model_info or (badly) replaces it.
const router = vi.hoisted(() => ({
  info: new Map<string, Record<string, unknown>>(),
  removed: [] as string[],
  blocked: [] as Array<[string, boolean]>,
  patchMode: "merge" as "merge" | "replace",
}));
vi.mock("@/server/litellm/client", () => ({
  HttpLiteLLMAdapter: class {
    async removeDeployment(id: string) { router.removed.push(id); }
    async setDeploymentBlocked(id: string, blocked: boolean) { router.blocked.push([id, blocked]); }
    async getModelInfo(id: string) { const info = router.info.get(id); return info ? { ...info } : null; }
    async patchModelInfo(id: string, patch: Record<string, unknown>) {
      router.info.set(id, router.patchMode === "merge" ? { ...router.info.get(id), ...patch } : { ...patch });
    }
  },
}));
const { POST } = await import("@/app/api/litellm/deployments/[id]/route");

const OWNER = "smart-free-sync";
const ORIGINAL = { managed_by: OWNER, lane: "smart-agent", tier: "free", rpm: 30 };
const inventory = (...items: unknown[]) => ({ listDeployments: async () => items }) as never;
const item = (id: string, alias = "smart-agent", model = "groq/llama-3.3-70b-versatile", info: Record<string, unknown> = ORIGINAL) =>
  ({ model_name: alias, litellm_params: { model }, model_info: { id, ...info } });
const local = async (routerId: string) => (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, routerId)))[0];
const call = (id: string, action: string, confirmation: string) =>
  POST(new Request("http://x/api", { method: "POST", body: JSON.stringify({ action, confirmation }) }), { params: Promise.resolve({ id }) });
const errorCode = async (response: Response) => (await response.json()).error?.code as string | undefined;

const ID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ID_B = "bbbbbbbb-2222-4222-8222-222222222222";

beforeEach(() => { router.info.clear(); router.removed.length = 0; router.blocked.length = 0; router.patchMode = "merge"; });

async function seedTwoCopies() {
  await syncLiteLLM({}, inventory(item(ID_A), item(ID_B))); // same alias, same model: two identical copies
  for (const id of [ID_A, ID_B]) router.info.set(id, { ...ORIGINAL });
  return { a: await local(ID_A), b: await local(ID_B) };
}

describe("confirmation names the exact deployment", () => {
  it("rejects the alias (shared by every copy) and the OTHER copy's phrase", async () => {
    const { a } = await seedTwoCopies();
    expect(await errorCode(await call(a.id, "delete", "DELETE smart-agent"))).toBe("CONFIRMATION_REQUIRED");
    expect(await errorCode(await call(a.id, "delete", "DELETE bbbbbbbb"))).toBe("CONFIRMATION_REQUIRED"); // copy B's phrase
    expect(router.removed).toEqual([]);
  });

  it("acts on only the copy whose ID was typed", async () => {
    const { a, b } = await seedTwoCopies();
    const response = await call(a.id, "delete", "DELETE aaaaaaaa");
    expect(response.status).toBe(200);
    expect(router.removed).toEqual([ID_A]);
    expect((await local(ID_B)).lifecycle).toBe("ACTIVE");
    expect(b.id).not.toBe(a.id);
  });
});

describe("delete", () => {
  it("keeps the LiteLLM ID for history, marks the deployment removed, and frees its lane slot", async () => {
    const { a } = await seedTwoCopies();
    const agent = (await getDb().insert(lanes).values({ slug: "smart-agent", name: "smart-agent", description: "x" }).returning())[0];
    await getDb().insert(laneAssignments).values({ laneId: agent.id, deploymentId: a.id, priority: 50 }).onConflictDoNothing();
    await call(a.id, "delete", "DELETE aaaaaaaa");
    const after = await local(ID_A);
    expect(after).toMatchObject({ lifecycle: "REMOVED", litellmDeploymentId: ID_A, health: "UNAVAILABLE" });
    const assignment = (await getDb().select().from(laneAssignments).where(eq(laneAssignments.deploymentId, a.id)))[0];
    expect(assignment.excluded).toBe(true);
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.action, "litellm.deployment.delete"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].after)).toContain(ID_A);
  });

  it("refuses a deployment that is already removed", async () => {
    const { a } = await seedTwoCopies();
    await call(a.id, "delete", "DELETE aaaaaaaa");
    expect(await errorCode(await call(a.id, "delete", "DELETE aaaaaaaa"))).toBe("DEPLOYMENT_NOT_LIVE");
    expect(router.removed).toEqual([ID_A]); // not attempted twice
  });
});

describe("adopt", () => {
  it("hands the deployment to RatLLM, keeps everything the other tool recorded, and audits it", async () => {
    const { a } = await seedTwoCopies();
    const response = await call(a.id, "adopt", "ADOPT aaaaaaaa");
    expect(response.status).toBe(200);
    expect(router.info.get(ID_A)).toMatchObject({ ...ORIGINAL, managed_by: CURATOR_MANAGED_BY, adopted_from: OWNER });
    expect(await local(ID_A)).toMatchObject({ managed: true, managedBy: CURATOR_MANAGED_BY });
    expect((await local(ID_B)).managed).toBe(false); // the other copy is untouched
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.action, "litellm.deployment.adopted"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].before)).toContain(OWNER);
  });

  it("rolls back and changes nothing locally when the router drops metadata", async () => {
    const { a } = await seedTwoCopies();
    router.patchMode = "replace";
    const response = await call(a.id, "adopt", "ADOPT aaaaaaaa");
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("ADOPTION_FAILED");
    expect(router.info.get(ID_A)).toEqual(ORIGINAL);                 // restored exactly
    expect((await local(ID_A)).managed).toBe(false);                 // RatLLM's own record unchanged
    const failed = await getDb().select().from(auditEvents).where(eq(auditEvents.action, "litellm.deployment.adopt_failed"));
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0].after)).toContain("\"restored\":true");
  });

  it("refuses a deployment RatLLM already manages", async () => {
    await syncLiteLLM({}, inventory(item(ID_A, "smart-agent", "groq/x", { managed_by: CURATOR_MANAGED_BY })));
    const row = await local(ID_A);
    expect(await errorCode(await call(row.id, "adopt", "ADOPT aaaaaaaa"))).toBe("ADOPTION_NOT_ALLOWED");
  });

  it("refuses self-hosted (local) models", async () => {
    await syncLiteLLM({}, inventory(item(ID_A)));
    const row = await local(ID_A);
    await getDb().update(providers).set({ slug: "local" }).where(eq(providers.id, row.providerId));
    router.info.set(ID_A, { ...ORIGINAL });
    expect(await errorCode(await call(row.id, "adopt", "ADOPT aaaaaaaa"))).toBe("ADOPTION_NOT_ALLOWED");
    expect(router.info.get(ID_A)).toEqual(ORIGINAL);
  });

  it("requires the exact phrase", async () => {
    const { a } = await seedTwoCopies();
    expect(await errorCode(await call(a.id, "adopt", "adopt aaaaaaaa"))).toBe("CONFIRMATION_REQUIRED");
    expect(router.info.get(ID_A)).toEqual(ORIGINAL);
  });
});
