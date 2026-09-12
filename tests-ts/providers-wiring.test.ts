import { describe, expect, it } from "vitest";
import { providerDefinitions } from "../src/server/providers/catalog";
import { providerWiring, WIRING_PENDING, SELF_HOSTED_PROVIDERS, CUSTOM_ADAPTER_PROVIDERS, getIntegrationStatus } from "../src/server/providers/wiring";

describe("provider wiring completeness", () => {
  it("every AUTOMATED/PARTIAL provider has a completions endpoint or a documented pending reason", () => {
    const unwired = providerDefinitions
      .filter(provider => provider.adapterCapability !== "MANUAL")
      .filter(provider => !providerWiring[provider.slug]?.completions && !WIRING_PENDING[provider.slug])
      .map(provider => provider.slug);
    expect(unwired).toEqual([]);
  });

  it("every wired endpoint is a well-formed https URL", () => {
    for (const [slug, wiring] of Object.entries(providerWiring)) {
      if (wiring.completions) expect(wiring.completions, slug).toMatch(/^https:\/\/.+\/chat\/completions$/);
      if (wiring.check) expect(wiring.check.url, slug).toMatch(/^https:\/\//);
    }
  });

  it("every WIRING_PENDING entry corresponds to a real catalog provider", () => {
    const slugs = new Set(providerDefinitions.map(provider => provider.slug));
    for (const slug of Object.keys(WIRING_PENDING)) expect(slugs.has(slug), slug).toBe(true);
  });

  it("every SELF_HOSTED / CUSTOM_ADAPTER entry corresponds to a real catalog provider, and the two never overlap", () => {
    const slugs = new Set(providerDefinitions.map(provider => provider.slug));
    for (const slug of SELF_HOSTED_PROVIDERS) expect(slugs.has(slug), slug).toBe(true);
    for (const slug of Object.keys(CUSTOM_ADAPTER_PROVIDERS)) expect(slugs.has(slug), slug).toBe(true);
    for (const slug of SELF_HOSTED_PROVIDERS) expect(CUSTOM_ADAPTER_PROVIDERS[slug], slug).toBeUndefined();
  });

  it("getIntegrationStatus reflects each provider's real wiring state", () => {
    expect(getIntegrationStatus("lemonade", {configured: false, verified: false})).toBe("SELF_HOSTED");
    expect(getIntegrationStatus("vertex-ai", {configured: false, verified: false})).toBe("NEEDS_CUSTOM_ADAPTER");
    expect(getIntegrationStatus("some-unknown-slug", {configured: false, verified: false})).toBe("NOT_WIRED");
    expect(getIntegrationStatus("llm7", {configured: false, verified: false})).toBe("NO_CREDENTIAL_NEEDED");
    expect(getIntegrationStatus("kilo", {configured: false, verified: false})).toBe("NO_CREDENTIAL_NEEDED");
    expect(getIntegrationStatus("cohere", {configured: false, verified: false})).toBe("READY");
    expect(getIntegrationStatus("cohere", {configured: true, verified: true})).toBe("LIVE");
  });
});
