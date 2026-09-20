import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));

const { bareCandidateModelRef } = await import("../src/server/discovery/verify");
const { staleFirst } = await import("../src/server/discovery/verify-due");
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

describe("staleFirst — the order the manual verification run works through candidates", () => {
  const c = (displayName: string, testedAt?: string) => ({ displayName, evidence: testedAt ? { testedAt } : {} });

  it("puts never-tested candidates first, then the longest-untested, breaking ties by name", () => {
    const ordered = [c("b", "2026-09-20T10:00:00Z"), c("z-never"), c("a", "2026-09-19T10:00:00Z"), c("a-never")].sort(staleFirst).map(r => r.displayName);
    expect(ordered).toEqual(["a-never", "z-never", "a", "b"]);
  });

  it("does not depend on the alphabet, so a truncated run can no longer retest the same names forever", () => {
    const rows = [c("Aardvark", "2026-09-20T17:00:00Z"), c("Zebra", "2026-09-01T00:00:00Z")];
    expect(rows.sort(staleFirst)[0]!.displayName).toBe("Zebra");
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
