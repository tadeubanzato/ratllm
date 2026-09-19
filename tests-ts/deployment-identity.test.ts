import { describe, expect, it } from "vitest";
import { deploymentIdentity } from "../src/server/litellm/classify";
import type { LiteLLMDeployment } from "../src/server/litellm/types";

const item = (overrides: Record<string, unknown>) => ({ model_name: "smart-general", litellm_params: { model: "groq/llama" }, model_info: {}, ...overrides }) as unknown as LiteLLMDeployment;

describe("deploymentIdentity", () => {
  it("uses model_info.id as the remote ID", () => {
    expect(deploymentIdentity(item({ model_info: { id: "abc-123" } })).deploymentId).toBe("abc-123");
  });

  it("falls back to model_info.model_id, then the top-level model_id", () => {
    expect(deploymentIdentity(item({ model_info: { model_id: "m-1" } })).deploymentId).toBe("m-1");
    expect(deploymentIdentity(item({ model_id: 42 })).deploymentId).toBe("42");
  });

  it("returns null instead of synthesizing an ID from the alias", () => {
    const identity = deploymentIdentity(item({}));
    expect(identity.deploymentId).toBeNull();
    expect(identity.providerModelId).toBe("groq/llama");
  });

  it("treats a blank ID as missing", () => {
    expect(deploymentIdentity(item({ model_info: { id: "  " } })).deploymentId).toBeNull();
  });
});
