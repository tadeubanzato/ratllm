import { describe, expect, it } from "vitest";
import { nonChatModelReason } from "../src/server/discovery/model-type";

const reason = (modelRef: string, description?: string) => nonChatModelReason({ modelRef, displayName: modelRef, description });

describe("non-chat model names", () => {
  it.each([
    "whisper-large-v3", "openai/whisper-large-v3-turbo", "nvidia/parakeet-ctc-1.1b-asr", "nvidia/nemotron-3.5-asr-streaming-0.6b",
    "canopylabs/orpheus-v1-english", "playai-tts", "hexgrad/kokoro-82m", "some/model-tts-1",
    "nvidia/llama-nemotron-embed-vl-1b-v2", "text-embedding-3-large", "BAAI/bge-m3", "nomic-embed-text-v1.5", "intfloat/e5-large-v2",
    "cohere/rerank-v3.5", "BAAI/bge-reranker-v2-m3",
    "black-forest-labs/FLUX.1-schnell", "stabilityai/stable-diffusion-xl-base-1.0", "google/imagen-4.0-generate", "Qwen/Qwen-Image-Edit", "qwen-image-2.0-pro",
    "google/veo-3.1", "Wan-AI/Wan2.1-T2V-14B", "wan2.2-animate", "google/lyria-3-pro-preview", "facebook/musicgen-large",
    "nvidia/segformer-b4-finetuned-cityscapes-1024-1024", "openai/clip-vit-large", "google/siglip-so400m",
  ])("flags %s", ref => expect(reason(ref), ref).not.toBeNull());

  it.each([
    "llama-3.3-70b-versatile", "openai/gpt-oss-120b", "gemma-4-26b-a4b-it", "qwen3-235b-a22b", "deepseek-ai/DeepSeek-V4-Pro", "meta-llama/Llama-3.1-8B-Instruct",
    "claude-sonnet-5", "mistral-large-latest", "ibm-granite/granite-4.1-8b", "nemotron-3-nano:30b", "zai-org/GLM-5.3", "moonshotai/kimi-k2",
    "groq/compound", "gemini-2.5-flash", "qwen-plus", "wan-ai-chat-7b-not-a-video", "Kimi-K2-Thinking", "google/gemma-3n-e4b-it", "microsoft/phi-4-mini-instruct",
  ])("leaves the chat model %s alone", ref => expect(reason(ref), ref).toBeNull());

  it("still catches the original safety/classifier families", () => {
    expect(reason("meta-llama/llama-prompt-guard-2-22m")).toMatch(/Safety/);
    expect(reason("some-model", "A content moderation model")).toMatch(/Safety/);
  });
});
