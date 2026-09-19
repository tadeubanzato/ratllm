import { describe, expect, it } from "vitest";
import { findExistingTarget, isPresentInRouter } from "../src/server/lanes/existing-target";
import { findDuplicateGroups } from "../src/server/litellm/duplicates";

const dep = (over: Partial<{ id: string; litellmModelName: string; providerModelId: string; litellmDeploymentId: string | null; lifecycle: string; health: string; providerName: string }> = {}) =>
  ({ id: "d1", litellmModelName: "smart-vision", providerModelId: "openai/gemma-4-26b-a4b-it", litellmDeploymentId: "router-1", lifecycle: "ACTIVE", health: "HEALTHY", providerName: "Google AI Studio", ...over });

describe("findExistingTarget", () => {
  it("finds a live deployment of the same model behind the same alias", () => {
    expect(findExistingTarget([dep()], "smart-vision", "openai/gemma-4-26b-a4b-it")?.id).toBe("d1");
  });

  it("still finds it when the model is spelled differently (same bare key)", () => {
    expect(findExistingTarget([dep({ providerModelId: "gemini/gemma-4-26b-a4b-it" })], "smart-vision", "openai/gemma-4-26b-a4b-it")?.id).toBe("d1");
  });

  it("REGRESSION: a live deployment that is momentarily UNAVAILABLE still exists, so it is not added a second time", () => {
    for (const health of ["UNAVAILABLE", "DEGRADED", "RATE_LIMITED", "UNKNOWN"]) {
      expect(findExistingTarget([dep({ health })], "smart-vision", "openai/gemma-4-26b-a4b-it")).toBeDefined();
    }
  });

  it("treats a blocked (DEACTIVATED) deployment as still present", () => {
    expect(findExistingTarget([dep({ lifecycle: "DEACTIVATED" })], "smart-vision", "openai/gemma-4-26b-a4b-it")).toBeDefined();
  });

  it("does not count a removed deployment, or one with no router ID, so a genuine re-add is still allowed", () => {
    expect(findExistingTarget([dep({ lifecycle: "REMOVED" })], "smart-vision", "openai/gemma-4-26b-a4b-it")).toBeUndefined();
    expect(findExistingTarget([dep({ litellmDeploymentId: null })], "smart-vision", "openai/gemma-4-26b-a4b-it")).toBeUndefined();
  });

  it("does not match a different alias or a different model", () => {
    expect(findExistingTarget([dep()], "smart-agent", "openai/gemma-4-26b-a4b-it")).toBeUndefined();
    expect(findExistingTarget([dep()], "smart-vision", "openai/another-model")).toBeUndefined();
  });

  it("isPresentInRouter mirrors the same rule", () => {
    expect(isPresentInRouter({ litellmDeploymentId: "x", lifecycle: "ACTIVE" })).toBe(true);
    expect(isPresentInRouter({ litellmDeploymentId: "x", lifecycle: "REMOVED" })).toBe(false);
    expect(isPresentInRouter({ litellmDeploymentId: null, lifecycle: "ACTIVE" })).toBe(false);
  });
});

describe("findDuplicateGroups", () => {
  const rows = [
    dep({ id: "a", litellmDeploymentId: "r-a" }), dep({ id: "b", litellmDeploymentId: "r-b" }), dep({ id: "c", litellmDeploymentId: "r-c" }), dep({ id: "d", litellmDeploymentId: "r-d" }),
    dep({ id: "e", litellmModelName: "smart-vision", providerModelId: "gemini/gemini-3.7-flash", litellmDeploymentId: "r-e" }),
  ];

  it("reports the same model deployed several times behind one alias", () => {
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ alias: "smart-vision", providerModelId: "openai/gemma-4-26b-a4b-it", count: 4, ids: ["a", "b", "c", "d"] });
  });

  it("does not flag the same model under different aliases — that's a legitimate lane membership", () => {
    expect(findDuplicateGroups([dep({ id: "a" }), dep({ id: "b", litellmModelName: "smart-agent", litellmDeploymentId: "r-b" })])).toEqual([]);
  });

  it("ignores removed, blocked, and ID-less copies", () => {
    expect(findDuplicateGroups([dep({ id: "a" }), dep({ id: "b", lifecycle: "REMOVED", litellmDeploymentId: "r-b" }), dep({ id: "c", lifecycle: "DEACTIVATED", litellmDeploymentId: "r-c" }), dep({ id: "d", litellmDeploymentId: null })])).toEqual([]);
  });

  it("does not merge the same model name from different providers", () => {
    expect(findDuplicateGroups([dep({ id: "a" }), dep({ id: "b", providerName: "Other", litellmDeploymentId: "r-b" })])).toEqual([]);
  });

  it("orders the worst offender first", () => {
    const many = [...rows, dep({ id: "x", litellmModelName: "smart-agent", providerModelId: "openai/y", litellmDeploymentId: "r-x" }), dep({ id: "y", litellmModelName: "smart-agent", providerModelId: "openai/y", litellmDeploymentId: "r-y" })];
    expect(findDuplicateGroups(many).map(group => group.count)).toEqual([4, 2]);
  });
});
