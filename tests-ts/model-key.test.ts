import { describe, expect, it } from "vitest";
import { bareModelKey, deploymentModelKey, matchDeployment, matchDeployments } from "../src/server/discovery/model-key";

const deployment = (overrides: Partial<{providerId: string; providerModelId: string; lifecycle: string}>) =>
  ({providerId: "provider-1", providerModelId: "org/glm-4.7-flash", lifecycle: "ACTIVE", ...overrides});

describe("bareModelKey", () => {
  it("normalizes org-prefixed and differently-cased spellings to the same key", () => {
    expect(bareModelKey("zai-org/glm-4.7-flash")).toBe(bareModelKey("GLM-4.7-Flash"));
  });
  it("keeps genuinely distinct models apart", () => {
    expect(bareModelKey("gpt-oss-120b")).not.toBe(bareModelKey("gpt-oss-20b"));
  });
});

describe("matchDeployment", () => {
  it("prefers an ACTIVE match over a stale REMOVED one for the same candidate", () => {
    const deployments = [deployment({lifecycle: "REMOVED"}), deployment({lifecycle: "ACTIVE"})];
    expect(matchDeployment(deployments, "provider-1", "org/glm-4.7-flash")?.lifecycle).toBe("ACTIVE");
  });
  it("falls back to the first match when nothing is ACTIVE", () => {
    const deployments = [deployment({lifecycle: "DEACTIVATED"}), deployment({lifecycle: "REMOVED"})];
    expect(matchDeployment(deployments, "provider-1", "org/glm-4.7-flash")?.lifecycle).toBe("DEACTIVATED");
  });
  it("returns null when no deployment matches", () => {
    expect(matchDeployment([deployment({})], "provider-1", "some-other-model")).toBeNull();
  });
  it("matchDeployments returns every match, not just the preferred one", () => {
    const deployments = [deployment({lifecycle: "REMOVED"}), deployment({lifecycle: "ACTIVE"})];
    expect(matchDeployments(deployments, "provider-1", "org/glm-4.7-flash")).toHaveLength(2);
  });
});

describe("deploymentModelKey — a LiteLLM deployment's id against its candidate", () => {
  // LiteLLM stores "<routing>/<provider model id>"; the routing part is not part of the model's identity.
  const cases: Array<[string, string]> = [
    ["qwen-flash", "openai/qwen-flash"],                                           // no digit in the name: bareModelKey() alone missed these
    ["qwen-max", "openai/qwen-max"],
    ["qwen-plus-latest", "openai/qwen-plus-latest"],
    ["codestral-latest", "openai/codestral-latest"],
    ["gemini-flash-lite-latest", "openai/gemini-flash-lite-latest"],
    ["gemini-flash-lite-latest", "gemini/gemini-flash-lite-latest"],
    ["gpt-oss-120b", "groq/openai/gpt-oss-120b"],                                  // digit in the name: always worked
    ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b"],
    ["poolside/laguna-s-2.1:free", "openrouter/poolside/laguna-s-2.1:free"],
    ["meta-llama/llama-guard", "openai/meta-llama/llama-guard"],                    // org-prefixed and digit-less
  ];
  it.each(cases)("candidate %s matches deployment %s", (candidate, deploymentId) => {
    expect(deploymentModelKey(deploymentId)).toBe(bareModelKey(candidate));
  });
  it("still keeps genuinely different models apart", () => {
    expect(deploymentModelKey("openai/qwen-plus")).not.toBe(bareModelKey("qwen-plus-latest"));
    expect(deploymentModelKey("groq/openai/gpt-oss-20b")).not.toBe(bareModelKey("gpt-oss-120b"));
  });
  it("leaves an id with no routing part alone", () => {
    expect(deploymentModelKey("qwen-flash")).toBe(bareModelKey("qwen-flash"));
  });
  it("matchDeployments finds the deployment of a model whose name has no digit", () => {
    const rows = [deployment({ providerModelId: "openai/qwen-flash" }), deployment({ providerModelId: "openai/qwen-max" }), deployment({ providerId: "other", providerModelId: "openai/qwen-flash" })];
    expect(matchDeployments(rows, "provider-1", "qwen-flash")).toHaveLength(1);
    expect(matchDeployment(rows, "provider-1", "qwen-max")?.providerModelId).toBe("openai/qwen-max");
    expect(matchDeployment(rows, "provider-1", "qwen-plus")).toBeNull();
  });
});

