import { describe, expect, it } from "vitest";
import { resolveProvider } from "../src/server/providers/catalog";

describe("resolveProvider", () => {
  it("does not attribute an aggregator's own routing-label model ids to the provider named in the label", () => {
    // models.dev's "llmgateway-providers" and "edenai" buckets prefix their OWN model ids with a backend name
    // like "deepinfra/" purely as a routing label — that string was never a real DeepInfra model id, and treating
    // it as one meant DeepInfra (and many other providers) accumulated hundreds of candidates that could only
    // ever 404 against the real API, masking whether discovery/verification was actually working.
    expect(resolveProvider("LLM Gateway", "deepinfra/deepseek-v4-pro")).toBeNull();
    expect(resolveProvider("EdenAI", "deepinfra/ByteDance/Seed-2.0-mini")).toBeNull();
    expect(resolveProvider("hf-inference", "nvidia/Nemotron-3-Embed-1B-BF16")).toBeNull();
  });

  it("still resolves via the model-ref prefix when there is no providerName to contradict it", () => {
    expect(resolveProvider(null, "deepinfra/some-model")?.slug).toBe("deepinfra");
    expect(resolveProvider(undefined, "groq/llama-3-70b")?.slug).toBe("groq");
  });

  it("still resolves via the model-ref prefix when providerName corroborates the same provider", () => {
    expect(resolveProvider("ModelScope API-Inference", "modelscope/qwen-qwen3-8-flash-next")?.slug).toBe("modelscope");
  });

  it("resolves models.dev display names that don't literally normalize to their own catalog slug", () => {
    expect(resolveProvider("Deep Infra", "deepseek-ai/DeepSeek-V4-Flash")?.slug).toBe("deepinfra");
    expect(resolveProvider("StepFun (China)", "some-model")?.slug).toBe("stepfun");
    expect(resolveProvider("MiniMax (minimax.io)", "some-model")?.slug).toBe("minimax");
    expect(resolveProvider("CoreWeave", "some-model")?.slug).toBe("wandb");
    expect(resolveProvider("Kilo Gateway", "some-model")?.slug).toBe("kilo");
    expect(resolveProvider("Sarvam AI", "some-model")?.slug).toBe("sarvam");
    expect(resolveProvider("AI21 Labs", "some-model")?.slug).toBe("ai21");
  });

  it("keeps the curated GLM/Qwen family fallbacks regardless of providerName, since no catalogued provider is named that", () => {
    expect(resolveProvider("Bothub", "glm-5.3-flash")?.slug).toBe("zhipu");
    expect(resolveProvider("GreenPT", "qwen-max")?.slug).toBe("alibaba-model-studio");
  });
});
