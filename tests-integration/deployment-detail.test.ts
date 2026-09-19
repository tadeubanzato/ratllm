import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments, smokeTests } from "@/server/db/schema";
import { getDeployment } from "@/server/queries";
import { getDeploymentDetail } from "@/server/deployment-detail";
import { syncLiteLLM } from "@/server/litellm/sync";

const inventory = (...items: unknown[]) => ({ listDeployments: async () => items }) as never;
const item = (id: string, alias: string, model: string, extraInfo: Record<string, unknown> = {}) =>
  ({ model_name: alias, litellm_params: { model }, model_info: { id, ...extraInfo } });
const idOf = async (remoteId: string) => (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, remoteId)))[0].id;

describe("deployment identity on the detail page data", () => {
  it("returns the exact LiteLLM ID, distinct from the RatLLM ID and the alias", async () => {
    await syncLiteLLM({}, inventory(item("router-id-aaa", "smart-agent", "groq/llama-3.3-70b-versatile")));
    const local = await idOf("router-id-aaa");
    const row = await getDeployment(local);
    expect(row).toMatchObject({ id: local, litellmDeploymentId: "router-id-aaa", litellmModelName: "smart-agent", lifecycle: "ACTIVE" });
    expect(row!.id).not.toBe(row!.litellmDeploymentId);
    expect(row!.firstSeenAt).toBeInstanceOf(Date);
  });

  it("lists the other deployments behind the same alias, each with its own LiteLLM ID", async () => {
    await syncLiteLLM({}, inventory(
      item("router-id-aaa", "smart-agent", "groq/llama-3.3-70b-versatile"),
      item("router-id-bbb", "smart-agent", "cerebras/llama3.1-8b"),
      item("router-id-ccc", "smart-vision", "groq/llama-3.2-90b-vision"),
    ));
    const detail = await getDeploymentDetail(await idOf("router-id-aaa"));
    expect(detail!.siblings.map(sibling => sibling.litellmDeploymentId)).toEqual(["router-id-bbb"]); // not itself, not another alias
  });

  it("keeps the last known LiteLLM ID for a deployment that has left the router", async () => {
    await syncLiteLLM({}, inventory(item("router-id-aaa", "smart-agent", "groq/llama-3.3-70b-versatile"), item("router-id-bbb", "smart-agent", "cerebras/llama3.1-8b")));
    await syncLiteLLM({}, inventory(item("router-id-aaa", "smart-agent", "groq/llama-3.3-70b-versatile")));
    const row = await getDeployment(await idOf("router-id-bbb"));
    expect(row).toMatchObject({ lifecycle: "REMOVED", litellmDeploymentId: "router-id-bbb" });
  });

  it("reports blocked state and the failure streak from recent probes", async () => {
    await syncLiteLLM({}, inventory(item("router-id-aaa", "smart-agent", "groq/llama-3.3-70b-versatile", { blocked: true })));
    const local = await idOf("router-id-aaa");
    for (let i = 0; i < 3; i++) await getDb().insert(smokeTests).values({ deploymentId: local, status: "FAILED", httpStatus: 500, correlationId: `c${i}` });
    const detail = await getDeploymentDetail(local);
    expect(detail!.blocked).toBe(true);
    expect(detail!.failureStreak).toBe(3);
    expect(detail!.probes).toHaveLength(3);
  });

  it("returns null for an unknown deployment", async () => {
    expect(await getDeploymentDetail("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await getDeployment("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("lifecycle timeline", () => {
  it("counts only promotions that really added a target behind this alias, not hourly no-op re-runs", async () => {
    const { modelCandidates, auditEvents } = await import("@/server/db/schema");
    const db = getDb();
    await syncLiteLLM({}, inventory(item("router-id-aaa", "smart-vision", "groq/llama-3.2-90b-vision")));
    const local = await idOf("router-id-aaa");
    const [candidate] = await db.insert(modelCandidates).values({ source: "openrouter", modelRef: "groq/llama-3.2-90b-vision", displayName: "v", sourceUrl: "u", providerId: (await db.select().from(modelDeployments).where(eq(modelDeployments.id, local)))[0].providerId }).returning();
    // Link the deployment to its candidate the way RatLLM does: via model_info.source_candidate_id.
    await syncLiteLLM({}, inventory(item("router-id-aaa", "smart-vision", "groq/llama-3.2-90b-vision", { source_candidate_id: candidate.id })));
    const event = (at: string, targets: unknown[]) => db.insert(auditEvents).values({ actor: "user", action: "litellm.candidate.promoted", entityType: "model_candidate", entityId: candidate.id, after: { targets }, correlationId: at, createdAt: new Date(at) });
    await event("2026-09-13T09:12:00Z", [{ target: "smart-vision", lane: "smart-vision", status: "added" }, { target: "smart-agent", lane: "smart-agent", status: "added" }]);
    await event("2026-09-13T10:00:00Z", [{ target: "smart-vision", lane: "smart-vision", status: "exists" }]);   // no-op re-run
    await event("2026-09-13T11:00:00Z", [{ target: "smart-vision", lane: "smart-vision", status: "failed" }]);   // failed attempt
    const detail = await getDeploymentDetail(local);
    const added = detail!.timeline.filter(entry => entry.label === "Added to LiteLLM by RatLLM");
    expect(added).toHaveLength(1);                                   // not 3, and not the smart-agent target
    expect(added[0]).toMatchObject({ detail: "lane smart-vision" });
    expect(added[0].at.toISOString()).toBe("2026-09-13T09:12:00.000Z");
    expect(detail!.addedToLiteLLMAt!.toISOString()).toBe("2026-09-13T09:12:00.000Z");
    expect(detail!.discovery).toMatchObject({ link: "recorded", candidateId: candidate.id });
  });

  it("falls back to matching the discovery record by provider and model when no link was recorded", async () => {
    const { modelCandidates } = await import("@/server/db/schema");
    const db = getDb();
    await syncLiteLLM({}, inventory(item("router-id-aaa", "smart-agent", "groq/llama-3.3-70b-versatile")));
    const local = await idOf("router-id-aaa");
    const providerId = (await db.select().from(modelDeployments).where(eq(modelDeployments.id, local)))[0].providerId;
    await db.insert(modelCandidates).values({ source: "openrouter", modelRef: "llama-3.3-70b-versatile", displayName: "l", sourceUrl: "u", providerId });
    const detail = await getDeploymentDetail(local);
    expect(detail!.discovery).toMatchObject({ link: "matched", sourceId: "openrouter" });
    expect(detail!.addedToLiteLLMAt).toBeNull();                    // unmanaged: no RatLLM addition on record
    expect(detail!.timeline.some(entry => entry.label === "First seen in the LiteLLM inventory")).toBe(true);
  });
});
