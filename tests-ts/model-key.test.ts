import { describe, expect, it } from "vitest";
import { bareModelKey, matchDeployment, matchDeployments } from "../src/server/discovery/model-key";

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
