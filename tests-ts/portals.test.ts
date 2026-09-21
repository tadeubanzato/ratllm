import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getCuratedPortal, getProviderPortal, portalAliases, portalSlugs } from "../src/server/providers/portals";

const LABELS = ["Generate API key", "Open provider console", "Open provider docs"];

describe("the curated provider links", () => {
  it("are all https addresses with a known label", () => {
    for (const slug of portalSlugs()) {
      const portal = getCuratedPortal(slug)!;
      expect(portal.url, slug).toMatch(/^https:\/\/[^\s]+$/);
      expect(LABELS, slug).toContain(portal.label);
      expect(portal.label, slug).not.toBe("Open provider docs");          // a curated link is a key page or a console, never just docs
    }
  });
  it("no longer point at addresses that moved or died", () => {
    expect(getCuratedPortal("fireworks")!.url).toContain("app.fireworks.ai/settings");
    expect(getCuratedPortal("hyperbolic")!.url).toContain("hyperbolic.ai");
    expect(getCuratedPortal("moonshot")!.url).toContain("platform.kimi.ai");
    expect(getCuratedPortal("llm7")!.url).not.toContain("token.llm7.io");
    expect(getCuratedPortal("anthropic")!.url).toContain("platform.claude.com");
  });
});

describe("provider aliases", () => {
  it("each points at an existing curated entry and never shadows one", () => {
    for (const [alias, target] of Object.entries(portalAliases())) {
      expect(portalSlugs(), `${alias} -> ${target}`).toContain(target);
      expect(portalSlugs(), `${alias} is itself curated`).not.toContain(alias);
    }
  });
  it("give a provider discovery spells differently the same key page", () => {
    expect(getProviderPortal("vertex")).toEqual(getCuratedPortal("vertex-ai"));
    expect(getProviderPortal("novitaai")).toEqual(getCuratedPortal("novita"));
    expect(getProviderPortal("hf-inference")).toEqual(getCuratedPortal("hugging-face"));
    expect(getProviderPortal("alibaba")).toEqual(getCuratedPortal("alibaba-model-studio"));
  });
});

describe("getProviderPortal", () => {
  it("prefers the curated page over a docs URL", () => {
    expect(getProviderPortal("groq", "https://console.groq.com/docs")).toEqual({ url: "https://console.groq.com/keys", label: "Generate API key" });
    expect(getProviderPortal("vertex", "https://cloud.google.com/vertex-ai/docs")!.label).not.toBe("Open provider docs");
  });
  it("falls back to the provider's own docs, labelled as docs because it is not a key page", () => {
    expect(getProviderPortal("some-new-gateway", "https://docs.some-gateway.example/start")).toEqual({ url: "https://docs.some-gateway.example/start", label: "Open provider docs" });
  });
  it("is null when nothing is known", () => {
    expect(getProviderPortal("some-new-gateway")).toBeNull();
    expect(getProviderPortal("some-new-gateway", null)).toBeNull();
    expect(getProviderPortal("some-new-gateway", "")).toBeNull();
  });
  it("never accepts a docs URL that is not a plain http(s) address: it comes from an external source and is rendered as a link", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "ftp://files.example/x", "//evil.example/x", "https://ok.example/a b", "vbscript:x"]) expect(getProviderPortal("some-new-gateway", bad), bad).toBeNull();
  });
  it("getCuratedPortal answers only for exactly-curated providers (credential autodetect depends on that)", () => {
    expect(getCuratedPortal("vertex")).toBeNull();
    expect(getCuratedPortal("groq")).not.toBeNull();
  });
});
