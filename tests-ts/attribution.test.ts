import { describe, expect, it } from "vitest";
import { attributeProvider, catalogIdentity, cleanProviderName } from "../src/server/providers/attribution";

describe("attributeProvider — the single provider decision (I1)", () => {
  it("returns catalog providers as CATALOG, whatever their spelling", () => {
    for (const [name, slug] of [["W&B Inference", "wandb"], ["CoreWeave", "wandb"], ["Groq", "groq"], ["Deep Infra", "deepinfra"]] as const) {
      const identity = attributeProvider(name, "x/y");
      expect(identity?.slug, name).toBe(slug);
      expect(identity?.origin, name).toBe("CATALOG");
    }
  });

  it("derives a provider a source names but the catalog does not know (I3)", () => {
    const identity = attributeProvider("Eden AI", "deepinfra/ByteDance/Seed-2.0-mini");
    expect(identity).toMatchObject({ slug: "eden-ai", name: "Eden AI", origin: "DISCOVERED", adapterCapability: "MANUAL" });
  });

  it("never lets an aggregator's routing prefix decide the provider", () => {
    expect(attributeProvider("NanoGPT", "openai/gpt-4o")?.slug).toBe("nanogpt");
    expect(attributeProvider("LLM Gateway", "deepinfra/deepseek-v4-pro")?.slug).toBe("llm-gateway");
  });

  it("is deterministic: case, surrounding space and punctuation-as-separator never split a provider", () => {
    expect(new Set(["Poe", "poe", " POE "].map(name => attributeProvider(name, "m")?.slug)).size).toBe(1);
    expect(new Set(["Together.ai", "Together AI", "together-ai"].map(name => attributeProvider(name, "m")?.slug)).size).toBe(1);
  });

  it("documents its limit: names that differ by a space are different providers, so the slug stays predictable", () => {
    // "NanoGPT" and "Nano GPT" cannot be merged without also merging unrelated names; a source that flips between them
    // shows up as two providers, which is visible and correctable, rather than a silent wrong merge.
    expect(attributeProvider("NanoGPT", "m")?.slug).not.toBe(attributeProvider("Nano GPT", "m")?.slug);
  });

  it("falls back to the catalog's model-prefix hint only when the source names no provider", () => {
    expect(attributeProvider(null, "groq/llama-3-70b")?.slug).toBe("groq");
    expect(attributeProvider(undefined, "plain-model-name-7b")).toBeNull();
  });

  it("refuses a label that is not a real provider name", () => {
    for (const junk of ["", "   ", "unknown", "N/A", "null", "12345", "-", "!!!", "x".repeat(200), null, undefined]) {
      expect(attributeProvider(junk as string | null | undefined, "some-model-7b"), String(junk)).toBeNull();
    }
  });

  it("strips control characters and collapses whitespace in a stored name", () => {
    expect(cleanProviderName("  Some\u0000  Gateway\n AI ")).toBe("Some Gateway AI");
  });

  it("exposes catalog identities by slug for single-provider sources", () => {
    expect(catalogIdentity("groq")).toMatchObject({ slug: "groq", origin: "CATALOG" });
    expect(catalogIdentity("not-a-provider")).toBeNull();
  });
});
