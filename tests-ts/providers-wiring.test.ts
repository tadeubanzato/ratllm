import { describe, expect, it } from "vitest";
import { providerDefinitions } from "../src/server/providers/catalog";
import { providerWiring, WIRING_PENDING } from "../src/server/providers/wiring";

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
});
