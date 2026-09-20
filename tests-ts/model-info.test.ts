import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));
const { extractModelInfo } = await import("../src/server/discovery/sources");

// Shapes captured from the live provider APIs on 2026-09-20 (trimmed to the fields that matter).
describe("extractModelInfo against real provider listings", () => {
  it("Kilo: an isFree flag is free evidence; a price of -1 (variable, auto-routed) is not", () => {
    expect(extractModelInfo({ id: "kilo-auto/free", isFree: true, context_length: 200000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } }))
      .toMatchObject({ free: true, freeReason: expect.stringMatching(/isFree/), contextWindow: 200000, nonChatReason: undefined });
    expect(extractModelInfo({ id: "kilo-auto/efficient", isFree: false, pricing: { prompt: "-1", completion: "-1" } }).free).toBe(false);
    expect(extractModelInfo({ id: "x", pricing: { prompt: "-1", completion: "-1" } }).free).toBe(false);
  });

  it("Together: reads the type, so embedding and image models are never sent a chat call", () => {
    expect(extractModelInfo({ id: "deepseek-ai/DeepSeek-V4.1-Flash", type: "chat", context_length: 1048576, pricing: { input: 0.3, output: 1.2 } })).toMatchObject({ nonChatReason: undefined, free: false, priced: true, contextWindow: 1048576 });
    expect(extractModelInfo({ id: "BAAI/bge-large", type: "embedding" }).nonChatReason).toMatch(/embedding/);
    expect(extractModelInfo({ id: "black-forest-labs/FLUX.1", type: "image" }).nonChatReason).toMatch(/image/);
  });

  it("Groq: string prices are numbers, context and output limits come from the provider's own field names", () => {
    const info = extractModelInfo({ id: "openai/gpt-oss-20b", context_window: 131072, max_completion_tokens: 65536, input_modalities: ["text"], output_modalities: ["text"], pricing: { prompt: "0.000000075", completion: "0.0000003" }, supported_features: ["tools", "reasoning"] });
    expect(info).toMatchObject({ contextWindow: 131072, maxOutputTokens: 65536, supportsTools: true, supportsReasoning: true, supportsVision: false, free: false, priced: true });
  });

  it("Groq TTS and audio models are recognised by their output modality", () => {
    expect(extractModelInfo({ id: "canopylabs/orpheus-arabic-saudi", output_modalities: ["audio"] }).nonChatReason).toMatch(/audio/);
  });

  it("OpenRouter: a :free variant and a zero price are both free", () => {
    expect(extractModelInfo({ id: "meta-llama/llama-3.3-70b-instruct:free" }).free).toBe(true);
    expect(extractModelInfo({ id: "google/gemma-3-27b-it", pricing: { prompt: "0", completion: "0" }, top_provider: { context_length: 96000, max_completion_tokens: 8192 } })).toMatchObject({ free: true, contextWindow: 96000, maxOutputTokens: 8192 });
  });

  it("Chutes: numeric prices, context under max_model_len", () => {
    expect(extractModelInfo({ id: "deepseek-ai/DeepSeek-V3.2-TEE", max_model_len: 163840, pricing: { prompt: 1, completion: 1 }, input_modalities: ["text"], output_modalities: ["text"] })).toMatchObject({ contextWindow: 163840, free: false, priced: true });
  });

  it("Vercel: modalities as an object, type language is chat", () => {
    expect(extractModelInfo({ id: "alibaba/qwen-3.6-max-preview", type: "language", context_window: 262144, max_tokens: 65536, modalities: { input: ["text", "image"], output: ["text"] } })).toMatchObject({ nonChatReason: undefined, supportsVision: true, contextWindow: 262144, maxOutputTokens: 65536 });
  });

  it("a bare listing with only an id (NVIDIA, Alibaba, ModelScope, Gemini) yields no claims rather than false ones", () => {
    expect(extractModelInfo({ id: "adept/fuyu-8b", object: "model", owned_by: "adept" })).toEqual({ displayName: undefined, contextWindow: undefined, maxOutputTokens: undefined, supportsVision: undefined, supportsTools: undefined, supportsReasoning: undefined, free: false, freeReason: undefined, priced: false, nonChatReason: undefined });
  });

  it("never treats a missing or blank price as free", () => {
    for (const pricing of [{}, { prompt: "", completion: "" }, { prompt: null, completion: null }, { prompt: "0" }]) expect(extractModelInfo({ id: "m", pricing }).free, JSON.stringify(pricing)).toBe(false);
  });
});
