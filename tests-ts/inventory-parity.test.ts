import { describe, expect, it } from "vitest";
import { compareInventory, type TrackedDeployment } from "../src/server/litellm/parity";
import { CURATOR_MANAGED_BY } from "../src/lib/constants";
import type { LiteLLMDeployment } from "../src/server/litellm/types";

const remote = (id: string, over: { lane?: string; model?: string; managed_by?: string; blocked?: boolean } = {}): LiteLLMDeployment =>
  ({ model_name: over.lane ?? "smart-agent", litellm_params: { model: over.model ?? "openai/x" }, model_info: { id, managed_by: over.managed_by, blocked: over.blocked } }) as LiteLLMDeployment;
const tracked = (id: string, over: Partial<TrackedDeployment> = {}): TrackedDeployment =>
  ({ litellmDeploymentId: id, litellmModelName: "smart-agent", providerModelId: "openai/x", managed: false, lifecycle: "ACTIVE", ...over });

describe("compareInventory", () => {
  it("is in sync when every deployment, owner and blocked state agrees", () => {
    const result = compareInventory([tracked("a", { managed: true }), tracked("b", { lifecycle: "DEACTIVATED" })], [remote("a", { managed_by: CURATOR_MANAGED_BY }), remote("b", { blocked: true })]);
    expect(result).toMatchObject({ inSync: true, unknownToRatllm: [], goneFromRouter: [], stateDiffers: [] });
  });
  it("reports a deployment added to the router outside RatLLM", () => {
    const result = compareInventory([tracked("a")], [remote("a"), remote("z", { lane: "smart-deep", model: "openai/new" })]);
    expect(result.inSync).toBe(false);
    expect(result.unknownToRatllm).toEqual([expect.objectContaining({ deploymentId: "z", lane: "smart-deep", model: "openai/new" })]);
  });
  it("reports a deployment RatLLM still lists that the router no longer has", () => {
    const result = compareInventory([tracked("a"), tracked("gone")], [remote("a")]);
    expect(result.goneFromRouter).toEqual([expect.objectContaining({ deploymentId: "gone" })]);
  });
  it("reports managed and blocked state that differs, trusting the router", () => {
    const result = compareInventory([tracked("a", { managed: false }), tracked("b", { managed: true }), tracked("c")], [remote("a", { managed_by: CURATOR_MANAGED_BY }), remote("b", { managed_by: "smart-free-sync" }), remote("c", { blocked: true })]);
    expect(result.stateDiffers.map(issue => issue.deploymentId).sort()).toEqual(["a", "b", "c"]);
    expect(result.inSync).toBe(false);
  });
  it("ignores router entries that carry no deployment id", () => {
    expect(compareInventory([], [{ model_name: "x", litellm_params: {}, model_info: {} } as LiteLLMDeployment]).inSync).toBe(true);
  });
});
