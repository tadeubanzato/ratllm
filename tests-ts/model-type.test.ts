import { describe, expect, it } from "vitest";
import { nonChatModelReason } from "../src/server/discovery/model-type";

describe("nonChatModelReason", () => {
  it("flags meta-llama prompt-guard models by name", () => {
    expect(nonChatModelReason({ modelRef: "meta-llama/llama-prompt-guard-2-22m", displayName: "meta-llama/llama-prompt-guard-2-22m" })).not.toBeNull();
    expect(nonChatModelReason({ modelRef: "meta-llama/llama-prompt-guard-2-86m", displayName: "meta-llama/llama-prompt-guard-2-86m" })).not.toBeNull();
  });

  it("flags known guard/classifier families by name", () => {
    expect(nonChatModelReason({ modelRef: "meta-llama/Llama-Guard-4-12B", displayName: "Llama Guard 4 12B" })).not.toBeNull();
    expect(nonChatModelReason({ modelRef: "google/shieldgemma-9b", displayName: "ShieldGemma 9B" })).not.toBeNull();
    expect(nonChatModelReason({ modelRef: "ibm-granite/granite-guardian-3.0-8b", displayName: "Granite Guardian 3.0 8B" })).not.toBeNull();
  });

  it("flags a candidate by description alone when the name gives no hint", () => {
    const reason = nonChatModelReason({ modelRef: "acme/sentinel-7b", displayName: "Sentinel 7B", description: "Safety model for policy screening, moderation, and risk-aware routing workflows" });
    expect(reason).not.toBeNull();
  });

  it("does not flag an ordinary chat model", () => {
    expect(nonChatModelReason({ modelRef: "meta-llama/llama-3.1-8b-instruct", displayName: "Llama 3.1 8B Instruct", description: "A general-purpose instruction-tuned chat model" })).toBeNull();
  });

  it("does not flag a chat model with no description", () => {
    expect(nonChatModelReason({ modelRef: "openrouter/inclusionai/ling-3.0-flash-fin:free", displayName: "Ling 3.0 Flash Fin" })).toBeNull();
  });
});
