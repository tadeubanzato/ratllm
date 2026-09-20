import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));

const { bareCandidateModelRef } = await import("../src/server/discovery/verify");
const { resolveProvider } = await import("../src/server/providers/catalog");

describe("bareCandidateModelRef", () => {
  const input = (slugOrName: string, modelRef: string, source = "models_dev") =>
    ({ modelRef, source, provider: resolveProvider(slugOrName, modelRef), providerBaseUrl: null, credential: null }) as Parameters<typeof bareCandidateModelRef>[0];

  it("keeps the org in NVIDIA NIM ids — it is part of the model id, not a routing prefix", () => {
    expect(bareCandidateModelRef(input("NVIDIA NIM", "nvidia/llama-3.1-nemotron-70b-instruct"))).toBe("nvidia/llama-3.1-nemotron-70b-instruct");
    expect(bareCandidateModelRef(input("NVIDIA NIM", "meta/llama-3.1-70b-instruct"))).toBe("meta/llama-3.1-70b-instruct");
  });

  it("still strips a genuine routing prefix for other providers", () => {
    expect(bareCandidateModelRef(input("Groq", "groq/llama-3.3-70b-versatile"))).toBe("llama-3.3-70b-versatile");
    expect(bareCandidateModelRef(input("Google AI Studio", "gemini/gemma-4-26b-a4b-it"))).toBe("gemma-4-26b-a4b-it");
  });
});

describe("verifyCandidateDirectly — retry with the id as discovered", () => {
  const provider = resolveProvider("Groq", "groq/compound");
  const credential = { id: "c", environmentVariable: "TEST_GROQ_KEY", encryptedValue: null, valid: true, config: {} };
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
  const notFound = () => new Response(JSON.stringify({ error: { message: "model does not exist" } }), { status: 404 });
  const run = async (respond: (model: string) => Response) => {
    process.env.TEST_GROQ_KEY = "k";
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => { const model = JSON.parse(init.body).model as string; sent.push(model); return respond(model); }));
    const { verifyCandidateDirectly } = await import("../src/server/discovery/verify");
    const result = await verifyCandidateDirectly({ modelRef: "groq/compound", source: "groq", provider, providerBaseUrl: null, credential } as never);
    vi.unstubAllGlobals();
    return { result, sent };
  };

  it("passes a model whose real id keeps the prefix that stripping removed", async () => {
    const { result, sent } = await run(model => (model === "groq/compound" ? ok() : notFound()));
    expect(result.status).toBe("available");
    expect(sent).toEqual(["compound", "groq/compound"]);
  });

  it("still reports a model that is unknown under both forms as unavailable", async () => {
    const { result, sent } = await run(() => notFound());
    expect(result.status).toBe("unavailable");
    expect(sent).toEqual(["compound", "groq/compound"]);
  });

  it("does not retry when the first attempt already passes", async () => {
    const { result, sent } = await run(() => ok());
    expect(result.status).toBe("available");
    expect(sent).toEqual(["compound"]);
  });
});

describe("classifyProviderFailure — what a provider's refusal means", () => {
  it.each([
    [402, "You need positive balance to do inference", "out_of_credits"],
    [402, null, "out_of_credits"],
    [429, "You exceeded your current quota, please check your plan and billing details", "out_of_credits"],
    [429, "insufficient_quota", "out_of_credits"],
    [403, "Insufficient Balance", "out_of_credits"],
    [400, "This request requires more credits, or fewer max_tokens. You requested up to 128 tokens, but can only afford 5", "unavailable"],
    [429, "Rate limit reached for requests", "rate_limited"],
    [429, null, "rate_limited"],
    [401, "Invalid API key", "auth_error"],
    [403, "Forbidden", "auth_error"],
    [404, "The model `x` does not exist", "unavailable"],
    [410, null, "unavailable"],
    [500, "internal error", "unavailable"],
  ] as const)("HTTP %s %j -> %s", async (status, message, expected) => {
    const { classifyProviderFailure } = await import("../src/server/discovery/verify");
    expect(classifyProviderFailure(status, message)).toBe(expected);
  });
});
