import { describe, expect, it } from "vitest";
import { sourceRegistry } from "../src/server/discovery/registry";
import { providerDefinitionBySlug } from "../src/server/providers/catalog";

const ADAPTERS = new Set(["openrouter", "litellm_costmap", "openai_models", "huggingface", "text_candidates", "provider_dataset", "models_dev"]);

/** docs/DISCOVERY-PIPELINE.md §4: what every registry entry must satisfy. A future edit that breaks one fails here, before it can
 *  produce a source that "succeeds" with nothing, or a source pointing at a provider that does not exist. */
describe("source registry contract", () => {
  it("has unique ids and names", () => {
    expect(new Set(sourceRegistry.map(source => source.id)).size).toBe(sourceRegistry.length);
    expect(new Set(sourceRegistry.map(source => source.name)).size).toBe(sourceRegistry.length);
  });

  it.each(sourceRegistry.map(source => [source.id, source] as const))("%s declares a usable contract", (_id, source) => {
    expect(Number.isInteger(source.minExpected) && source.minExpected >= 1, "minExpected must be a positive integer").toBe(true);
    expect(source.url).toMatch(/^https:\/\//);
    expect(ADAPTERS.has(source.adapter), `unknown adapter ${source.adapter}`).toBe(true);
    expect(["A1", "A2"]).toContain(source.tier);
    if (source.refreshHours !== undefined) expect(source.refreshHours).toBeGreaterThan(0);
  });

  it("only points at catalog providers, and no two sources claim the same provider's own catalog", () => {
    const claimed = sourceRegistry.map(source => source.providerSlug).filter((slug): slug is string => Boolean(slug));
    for (const slug of claimed) expect(providerDefinitionBySlug(slug), `providerSlug "${slug}" is not in the catalog`).not.toBeNull();
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("gives every source that needs a key a way to find one, and never leaves a required key unnamed", () => {
    for (const source of sourceRegistry.filter(item => item.adapter === "openai_models" && item.authOptional === false))
      expect(source.authEnv, `${source.id} requires a key but names no environment variable`).toBeTruthy();
  });

  it("uses a provider's own API for every provider-catalog source except the one that has none", () => {
    const scrapers = sourceRegistry.filter(source => source.adapter === "text_candidates").map(source => source.id);
    expect(scrapers).toEqual(["cloudflare_workers_ai"]);
  });

  it("makes a scraper's contract meaningful: it must expect at least as many models as a broken parser could not fake", () => {
    for (const source of sourceRegistry.filter(item => item.adapter === "text_candidates")) expect(source.minExpected).toBeGreaterThanOrEqual(50);
  });
});
