import { describe, expect, it } from "vitest";
import { adoptDeployment, adoptionFields, planAdoption, verifyAdoption, type AdoptionRouter } from "../src/server/litellm/adoption";
import { CURATOR_MANAGED_BY } from "../src/lib/constants";

const base = { managed: false, lifecycle: "ACTIVE", litellmDeploymentId: "r-1", providerSlug: "groq" };

describe("planAdoption", () => {
  it("allows a live, unmanaged, cloud-hosted deployment", () => {
    expect(planAdoption(base)).toEqual({ allowed: true });
    expect(planAdoption({ ...base, lifecycle: "DEACTIVATED" })).toEqual({ allowed: true });
  });
  it("refuses what RatLLM already manages", () => {
    expect(planAdoption({ ...base, managed: true })).toMatchObject({ allowed: false });
  });
  it("refuses a deployment that is gone from the router", () => {
    expect(planAdoption({ ...base, lifecycle: "REMOVED" })).toMatchObject({ allowed: false });
    expect(planAdoption({ ...base, litellmDeploymentId: null })).toMatchObject({ allowed: false });
  });
  it("refuses self-hosted providers — a sleeping laptop is not a dead model", () => {
    expect(planAdoption({ ...base, providerSlug: "local" })).toMatchObject({ allowed: false });
    expect(planAdoption({ ...base, providerSlug: "lemonade" })).toMatchObject({ allowed: false });
  });
});

describe("adoptionFields / verifyAdoption", () => {
  it("records RatLLM as manager and remembers the previous one", () => {
    expect(adoptionFields("smart-free-sync", new Date("2026-09-19T00:00:00Z"))).toEqual({ managed_by: CURATOR_MANAGED_BY, adopted_from: "smart-free-sync", adopted_at: "2026-09-19T00:00:00.000Z" });
    expect(adoptionFields(null).adopted_from).toBe("unknown");
  });
  it("is ok only when the new manager is recorded AND nothing that was there is gone", () => {
    const before = { managed_by: "smart-free-sync", lane: "smart-agent", rpm: 30 };
    expect(verifyAdoption(before, { ...before, managed_by: CURATOR_MANAGED_BY, adopted_from: "x" })).toEqual({ ok: true, managedNow: true, lostKeys: [] });
    expect(verifyAdoption(before, { managed_by: CURATOR_MANAGED_BY })).toMatchObject({ ok: false, lostKeys: ["lane", "rpm"] });
    expect(verifyAdoption(before, before)).toMatchObject({ ok: false, managedNow: false });
  });
  it("does not count a field that was empty before as lost when the router leaves it out afterwards", () => {
    const before = { managed_by: "manual-free-add", lane: "smart-agent", team_id: null, base_model: null, created_at: null };
    expect(verifyAdoption(before, { managed_by: CURATOR_MANAGED_BY, lane: "smart-agent" })).toEqual({ ok: true, managedNow: true, lostKeys: [] });
    expect(verifyAdoption(before, { managed_by: CURATOR_MANAGED_BY })).toMatchObject({ ok: false, lostKeys: ["lane"] });
  });
  it("treats empty lists and objects as empty, but still counts false and real values as data", () => {
    const before = { managed_by: "smart-free-sync", access_groups: [], extra: {}, blocked: false, teams: ["a"] };
    expect(verifyAdoption(before, { managed_by: CURATOR_MANAGED_BY, blocked: false, teams: ["a"] })).toEqual({ ok: true, managedNow: true, lostKeys: [] });
    expect(verifyAdoption(before, { managed_by: CURATOR_MANAGED_BY, teams: ["a"] })).toMatchObject({ ok: false, lostKeys: ["blocked"] });
  });
});

/** A fake router. `mode` decides what its PATCH does to model_info: merge it in, or (badly) replace it. */
function fakeRouter(initial: Record<string, unknown> | null, mode: "merge" | "replace" | "ignore" | "reject", log: string[] = []): AdoptionRouter & { state: Record<string, unknown> | null } {
  const router = {
    state: initial ? { ...initial } : null,
    async getModelInfo() { return router.state ? { ...router.state } : null; },
    async patchModelInfo(_id: string, info: Record<string, unknown>) {
      log.push(`patch:${Object.keys(info).join(",")}`);
      if (mode === "reject") throw new Error("HTTP 422");
      if (mode === "merge") router.state = { ...router.state, ...info };
      if (mode === "replace") router.state = { ...info };
    },
  };
  return router;
}
const original = { managed_by: "smart-free-sync", lane: "smart-agent", tier: "free", rpm: 30, managed_version: "2026.08.22-v2.9" };

describe("adoptDeployment", () => {
  it("adopts cleanly when the router merges metadata, keeping every existing field", async () => {
    const router = fakeRouter(original, "merge");
    const result = await adoptDeployment(router, "r-1", "smart-free-sync");
    expect(result.ok).toBe(true);
    expect(router.state).toMatchObject({ ...original, managed_by: CURATOR_MANAGED_BY, adopted_from: "smart-free-sync" });
    expect(router.state!.lane).toBe("smart-agent");
  });

  it("detects a router that REPLACES metadata, and restores the original exactly", async () => {
    const log: string[] = [];
    const router = fakeRouter(original, "replace", log);
    const result = await adoptDeployment(router, "r-1", "smart-free-sync");
    expect(result).toMatchObject({ ok: false, stage: "verification_failed", restored: true });
    expect(router.state).toEqual(original); // nothing lost
    expect(log).toEqual(["patch:managed_by,adopted_from,adopted_at", `patch:${Object.keys(original).join(",")}`]);
    if (!result.ok) expect(result.lostKeys).toEqual(["lane", "tier", "rpm", "managed_version"]);
  });

  it("reports failure without claiming success when the router ignores the update", async () => {
    const router = fakeRouter(original, "ignore");
    const result = await adoptDeployment(router, "r-1", "smart-free-sync");
    expect(result).toMatchObject({ ok: false, stage: "verification_failed" });
    expect(router.state).toEqual(original);
  });

  it("changes nothing when the router rejects the update", async () => {
    const log: string[] = [];
    const router = fakeRouter(original, "reject", log);
    const result = await adoptDeployment(router, "r-1", "smart-free-sync");
    expect(result).toMatchObject({ ok: false, stage: "update_failed" });
    expect(router.state).toEqual(original);
    expect(log).toHaveLength(1); // one attempt, no follow-up writes
  });

  it("stops if the router no longer lists the deployment", async () => {
    expect(await adoptDeployment(fakeRouter(null, "merge"), "r-1", null)).toMatchObject({ ok: false, stage: "not_found" });
  });
});
