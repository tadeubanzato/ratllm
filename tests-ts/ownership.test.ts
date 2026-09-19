import { describe, expect, it } from "vitest";
import { ownerLabel, summarizeOwners, unmanagedNotServing, type OwnedDeployment } from "../src/server/litellm/ownership";

const dep = (id: string, over: Partial<OwnedDeployment> = {}): OwnedDeployment =>
  ({ id, owner: "smart-free-sync", managed: false, lifecycle: "ACTIVE", health: "HEALTHY", litellmDeploymentId: `r-${id}`, litellmModelName: "smart-agent", providerModelId: `openai/m-${id}`, providerName: "P", ...over });

describe("ownerLabel", () => {
  it("names RatLLM for its own deployments and the recorded manager for the rest", () => {
    expect(ownerLabel({ managed: true, owner: "ratllm-curator" })).toBe("RatLLM");
    expect(ownerLabel({ managed: false, owner: "smart-free-sync" })).toBe("smart-free-sync");
  });
  it("says unknown when the router recorded no manager", () => {
    expect(ownerLabel({ managed: false, owner: null })).toBe("unknown");
    expect(ownerLabel({ managed: false })).toBe("unknown");
  });
});

describe("summarizeOwners", () => {
  const rows = [
    dep("a"), dep("b", { health: "UNAVAILABLE" }), dep("c", { health: "AUTH_ERROR" }),
    dep("d", { owner: "local-mac-mini" }), dep("e", { owner: "local-mac-mini" }), dep("f", { owner: "local-mac-mini" }),
    dep("g", { managed: true, owner: "ratllm-curator" }),
  ];

  it("groups live deployments by who manages them and counts healthy vs not serving", () => {
    const summary = summarizeOwners(rows);
    expect(summary.find(s => s.owner === "smart-free-sync")).toMatchObject({ live: 3, healthy: 1, notServing: 2 });
    expect(summary.find(s => s.owner === "local-mac-mini")).toMatchObject({ live: 3, healthy: 3, notServing: 0 });
    expect(summary.find(s => s.owner === "RatLLM")).toMatchObject({ live: 1, managedByRatllm: true });
  });

  it("lists RatLLM first, then the largest fleets (ties alphabetical)", () => {
    // RatLLM has 1; smart-free-sync and local-mac-mini both have 3, so they tie and sort by name.
    expect(summarizeOwners(rows).map(s => s.owner)).toEqual(["RatLLM", "local-mac-mini", "smart-free-sync"]);
  });

  it("ignores removed, blocked, and ID-less deployments", () => {
    const summary = summarizeOwners([dep("a"), dep("b", { lifecycle: "REMOVED" }), dep("c", { lifecycle: "DEACTIVATED" }), dep("d", { litellmDeploymentId: null })]);
    expect(summary).toHaveLength(1);
    expect(summary[0].live).toBe(1);
  });
});

describe("unmanagedNotServing", () => {
  it("returns live, unmanaged deployments that are not serving — the ones RatLLM won't act on itself", () => {
    const result = unmanagedNotServing([dep("a"), dep("b", { health: "UNAVAILABLE" }), dep("c", { health: "AUTH_ERROR" }), dep("d", { health: "DEGRADED" })]);
    expect(result.map(row => row.id).sort()).toEqual(["b", "c"]);
  });

  it("never includes RatLLM's own (its health monitor handles those), or removed ones", () => {
    expect(unmanagedNotServing([dep("a", { managed: true, health: "UNAVAILABLE" }), dep("b", { lifecycle: "REMOVED", health: "UNAVAILABLE" })])).toEqual([]);
  });

  it("does not treat rate limiting as not serving", () => {
    expect(unmanagedNotServing([dep("a", { health: "RATE_LIMITED" })])).toEqual([]);
  });
});
