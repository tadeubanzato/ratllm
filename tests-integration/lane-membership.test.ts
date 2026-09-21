import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { laneAssignments, lanes, modelDeployments } from "@/server/db/schema";
import { syncLiteLLM } from "@/server/litellm/sync";
import { laneHasCapacity } from "@/server/lanes/shared";
import { getLanes } from "@/server/queries";
import { LANE_RULES } from "@/server/lanes/rules";
import { CURATOR_MANAGED_BY } from "@/lib/constants";

// The reconciler talks to the network (promotion, fallback sync); replace both so its decisions can be observed.
const promoteCandidate = vi.fn(async () => ({ targets: [] }));
vi.mock("@/server/lanes/promote", () => ({ promoteCandidate: (...args: unknown[]) => (promoteCandidate as (...a: unknown[]) => unknown)(...args), PromotionBlocked: class PromotionBlocked extends Error {} }));
vi.mock("@/server/lanes/fallbacks", () => ({ syncFallbackConfig: async () => ({ ok: true, applied: [], errors: [] }) }));
const { reconcileLaneMembership } = await import("@/server/lanes/reconcile");

const CAP = LANE_RULES["smart-vision"].maxDeployments;

const inventory = (...items: unknown[]) => ({ listDeployments: async () => items }) as never;
const item = (id: string, alias: string, info: Record<string, unknown> = {}) =>
  ({ model_name: alias, litellm_params: { model: `groq/model-${id}` }, model_info: { id, ...info } });

async function lane(slug: string) {
  return (await getDb().insert(lanes).values({ slug, name: slug, description: slug }).returning())[0];
}
async function deployment(routerId: string) {
  return (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, routerId)))[0];
}
async function assign(laneId: string, deploymentId: string, excluded = false) {
  // Inventory sync already assigns RatLLM-managed deployments to the lane named by their alias, so this is an upsert.
  await getDb().insert(laneAssignments).values({ laneId, deploymentId, priority: 50, excluded })
    .onConflictDoUpdate({ target: [laneAssignments.laneId, laneAssignments.deploymentId], set: { excluded } });
}
const setLifecycle = (id: string, lifecycle: "ACTIVE" | "DEACTIVATED" | "REMOVED") => getDb().update(modelDeployments).set({ lifecycle }).where(eq(modelDeployments.id, id));

/** `n` deployments behind `alias`, each assigned to `laneId`; returns their local ids. */
async function fill(alias: string, laneId: string, n: number, prefix: string) {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  await syncLiteLLM({}, inventory(...ids.map(id => item(id, alias))));
  const rows = await Promise.all(ids.map(deployment));
  for (const row of rows) await assign(laneId, row.id);
  return rows.map(row => row.id);
}

beforeEach(() => promoteCandidate.mockClear());

describe("lane capacity counts live members, not ghosts", () => {
  it("has room when the lane's assignments are mostly left behind by removed deployments", async () => {
    const vision = await lane("smart-vision");
    const ids = await fill("smart-vision", vision.id, CAP, "v"); // CAP assignments: the old count says "full"
    for (const id of ids.slice(0, 3)) await setLifecycle(id, "REMOVED");
    expect(await laneHasCapacity("smart-vision")).toBe(true);       // 5 live of 8
  });

  it("is full once live members reach the cap", async () => {
    const vision = await lane("smart-vision");
    await fill("smart-vision", vision.id, CAP, "v");
    expect(await laneHasCapacity("smart-vision")).toBe(false);      // 8 live of 8
  });

  it("takes no new members once the lane is disabled, however empty it is", async () => {
    const vision = await lane("smart-vision");
    expect(await laneHasCapacity("smart-vision")).toBe(true);
    await getDb().update(lanes).set({ enabled: false }).where(eq(lanes.id, vision.id));
    expect(await laneHasCapacity("smart-vision")).toBe(false);
    await getDb().update(lanes).set({ enabled: true }).where(eq(lanes.id, vision.id));
    expect(await laneHasCapacity("smart-vision")).toBe(true);
  });

  it("is one short of full at cap - 1", async () => {
    const vision = await lane("smart-vision");
    await fill("smart-vision", vision.id, CAP - 1, "v");
    expect(await laneHasCapacity("smart-vision")).toBe(true);
  });

  it("does not count excluded assignments or blocked (DEACTIVATED) deployments", async () => {
    const vision = await lane("smart-vision");
    const ids = await fill("smart-vision", vision.id, CAP, "v");
    await setLifecycle(ids[0], "DEACTIVATED");
    await getDb().update(laneAssignments).set({ excluded: true }).where(eq(laneAssignments.deploymentId, ids[1]));
    expect(await laneHasCapacity("smart-vision")).toBe(true);       // 6 live of 8
  });
});

describe("lane status counts live members", () => {
  it("reports total and healthy from live members only", async () => {
    const vision = await lane("smart-vision");
    const ids = await fill("smart-vision", vision.id, 6, "v");
    for (const id of ids) await getDb().update(modelDeployments).set({ health: "HEALTHY" }).where(eq(modelDeployments.id, id));
    for (const id of ids.slice(0, 2)) await setLifecycle(id, "REMOVED");   // 2 ghosts, still marked HEALTHY
    const summary = (await getLanes()).find(row => row.slug === "smart-vision")!;
    expect(summary.total).toBe(4);
    expect(summary.healthy).toBe(4);
  });
});

describe("the reconciler repairs what is MISSING, not what is merely unhealthy", () => {
  const candidateId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it("re-promotes a managed member that left the router, never one that is live but UNAVAILABLE", async () => {
    const agent = await lane("smart-agent");
    await syncLiteLLM({}, inventory(
      item("live-unhealthy", "smart-agent", { managed_by: CURATOR_MANAGED_BY, source_candidate_id: candidateId(1) }),
      item("gone", "smart-agent", { managed_by: CURATOR_MANAGED_BY, source_candidate_id: candidateId(2) }),
    ));
    const unhealthy = await deployment("live-unhealthy");
    const gone = await deployment("gone");
    await getDb().update(modelDeployments).set({ health: "UNAVAILABLE" }).where(eq(modelDeployments.id, unhealthy.id)); // live, bad probe
    await setLifecycle(gone.id, "REMOVED");                                                                            // really gone
    await assign(agent.id, unhealthy.id);
    await assign(agent.id, gone.id);

    const summary = await reconcileLaneMembership();
    expect(promoteCandidate).toHaveBeenCalledTimes(1);
    expect(promoteCandidate).toHaveBeenCalledWith(candidateId(2), { lanes: ["smart-agent"], skipFallbackSync: true });
    expect(summary.repaired).toEqual([{ candidateId: candidateId(2), lanes: ["smart-agent"] }]);
  });

  it("does not try to repair a missing member with no discovery record (added outside RatLLM), and reports it", async () => {
    const agent = await lane("smart-agent");
    await syncLiteLLM({}, inventory(item("external-gone", "smart-agent", { managed_by: "smart-free-sync" })));
    const gone = await deployment("external-gone");
    await setLifecycle(gone.id, "REMOVED");
    await assign(agent.id, gone.id);
    const summary = await reconcileLaneMembership();
    expect(promoteCandidate).not.toHaveBeenCalled();
    expect(summary.orphans).toEqual(["smart-agent"]);
  });

  it("ignores excluded assignments", async () => {
    const agent = await lane("smart-agent");
    await syncLiteLLM({}, inventory(item("gone", "smart-agent", { managed_by: CURATOR_MANAGED_BY, source_candidate_id: candidateId(3) })));
    const gone = await deployment("gone");
    await setLifecycle(gone.id, "REMOVED");
    await assign(agent.id, gone.id, true);
    await reconcileLaneMembership();
    expect(promoteCandidate).not.toHaveBeenCalled();
  });
});
