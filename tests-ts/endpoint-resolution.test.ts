import { describe, expect, it } from "vitest";
import { completionsUrlFromSdkBase, endpointBaseHint, resolveCompletionsEndpoint } from "../src/server/providers/wiring";

describe("completions endpoint resolution", () => {
  it("appends /chat/completions to an SDK base URL without assuming a /v1", () => {
    expect(completionsUrlFromSdkBase("https://api.z.ai/api/paas/v4")).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(completionsUrlFromSdkBase("https://api.subconscious.dev/v1/")).toBe("https://api.subconscious.dev/v1/chat/completions");
    expect(completionsUrlFromSdkBase("https://generativelanguage.googleapis.com/v1beta/openai/")).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  });

  it("uses a complete completions URL exactly as given, and a typed Base URL as a host as before", () => {
    expect(resolveCompletionsEndpoint("some-derived", "https://x.example/api/v4/chat/completions")).toBe("https://x.example/api/v4/chat/completions");
    expect(resolveCompletionsEndpoint("some-derived", "https://x.example/api/v4/chat/completions/")).toBe("https://x.example/api/v4/chat/completions");
    expect(resolveCompletionsEndpoint("some-derived", "https://x.example")).toBe("https://x.example/v1/chat/completions");
    expect(resolveCompletionsEndpoint("some-derived", "https://x.example/v1/")).toBe("https://x.example/v1/chat/completions");
    expect(resolveCompletionsEndpoint("some-derived", null)).toBeNull();
  });

  it("ranks the sources of an endpoint: a person's Base URL, then the catalog's wiring, then what a source published", () => {
    expect(endpointBaseHint("groq", "https://mine.example", "https://published.example/v1")).toBe("https://mine.example");
    // groq has catalog wiring, so a published URL must not override it
    expect(endpointBaseHint("groq", null, "https://published.example/v1")).toBeNull();
    expect(resolveCompletionsEndpoint("groq", endpointBaseHint("groq", null, "https://published.example/v1"))).toBe("https://api.groq.com/openai/v1/chat/completions");
    // a derived provider has no wiring, so the published URL is all there is
    expect(endpointBaseHint("some-derived", null, "https://api.z.ai/api/paas/v4")).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(resolveCompletionsEndpoint("some-derived", endpointBaseHint("some-derived", null, "https://api.z.ai/api/paas/v4"))).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(endpointBaseHint("some-derived", null, null)).toBeNull();
  });
});
