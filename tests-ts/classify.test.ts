import { describe, expect, it } from "vitest";
import { deploymentIdentity, isManagedDeployment, sanitizedMetadata } from "../src/server/litellm/classify";

describe("LiteLLM ownership boundary", () => {
  it("only treats the exact Curator marker as managed", () => {
    expect(isManagedDeployment({ model_name:"smart-general", model_info:{managed_by:"ratllm-curator"}, litellm_params:{} })).toBe(true);
    expect(isManagedDeployment({ model_name:"manual", model_info:{managed_by:"ratllm"}, litellm_params:{} })).toBe(false);
    expect(isManagedDeployment({ model_name:"manual", model_info:{}, litellm_params:{} })).toBe(false);
  });
  it("uses stable remote identifiers", () => {
    expect(deploymentIdentity({model_name:"smart-coding",model_info:{id:"dep-1"},litellm_params:{model:"groq/qwen"}})).toEqual({providerModelId:"groq/qwen",deploymentId:"dep-1"});
  });
  it("removes nested secret fields from stored metadata", () => {
    const result=sanitizedMetadata({model_name:"x",model_info:{api_key:"secret",nested:{token:"secret",safe:true}},litellm_params:{model:"x"}});
    expect(JSON.stringify(result)).not.toContain("secret"); expect(JSON.stringify(result)).toContain("safe");
  });
});
