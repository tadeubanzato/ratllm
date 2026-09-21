/** Detects candidates that are safety/classifier models rather than chat-completion models — pure, no DB, safe to
 *  unit-test in isolation. Discovered 2026-09-14: meta-llama/llama-prompt-guard-2-{22m,86m} passed direct-to-provider
 *  verification (verify.ts never sets `stream`) and got promoted, then flapped through the auto-remove/re-add cycle
 *  forever because Groq's live API rejects `stream: true` for these models — a fact that shows up nowhere in
 *  structured metadata: models.dev reports `modalities: {input: [text], output: [text]}` like an ordinary chat
 *  model, and LiteLLM's own cost map reports `mode: "chat"`. The only real signal is the model family name and,
 *  where available, models.dev's free-text `description`. This is a heuristic on purpose, not a modality flag. */

const NAME_PATTERNS: RegExp[] = [
  /prompt-?guard/i,
  /llama-?guard/i,
  /shield-?gemma/i,
  /granite-?guardian/i,
  /wildguard/i,
];

/** Model families whose *names* say they do not produce chat text (speech, embeddings, ranking, image/video/music
 *  generation, vision encoders). Each was seen failing chat-completion tests on live providers (Groq's whisper and orpheus,
 *  NVIDIA's segformer and embed models, OpenRouter's lyria). A name match is a heuristic, so the list is deliberately limited
 *  to families that are never chat models, and tests/non-chat.test.ts pins both what it catches and what it must leave alone. */
const NON_CHAT_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/whisper|parakeet|canary-|speech-to-text|(^|[\/_-])asr([\/_-]|$)|transcri/i, "Speech-to-text model — not a chat-completions model"],
  [/(^|[\/_-])tts([\/_-]|$)|text-to-speech|orpheus|kokoro|playai/i, "Text-to-speech model — not a chat-completions model"],
  [/embed(ding)?s?([\/_.0-9-]|$)|(^|[\/_-])(bge|gte|e5|nomic-embed|minilm|mpnet)-/i, "Embedding model — not a chat-completions model"],
  [/rerank/i, "Reranking model — not a chat-completions model"],
  [/(^|[\/_-])(flux|sdxl|stable-diffusion|stable-image|dall-?e|imagen|midjourney|seedream)([\/_.0-9-]|$)|image-(gen|edit)|qwen-image|text-to-image/i, "Image-generation model — not a chat-completions model"],
  [/(^|[\/_-])(veo|sora|kling|hailuo)[-_.0-9]|wan-ai\/wan|(^|[\/_-])wan[0-9]|text-to-video|video-gen/i, "Video-generation model — not a chat-completions model"],
  [/lyria|musicgen|text-to-music|stable-audio/i, "Music-generation model — not a chat-completions model"],
  [/segformer|(^|[\/_-])(clip|siglip)([\/_.0-9-]|$)|(^|[\/_-])(dinov2|vit-)/i, "Vision-encoder model — not a chat-completions model"],
];

const DESCRIPTION_PATTERNS: RegExp[] = [
  /safety model/i,
  /content moderation/i,
  /policy screening/i,
  /content filtering/i,
  /jailbreak detection/i,
  /prompt injection detection/i,
  /risk-aware routing/i,
];

/** Returns a human-readable reason this candidate isn't a chat-completions model, or null if it looks like one. */
export function nonChatModelReason(input: { modelRef: string; displayName: string; description?: string | null }): string | null {
  const name = `${input.modelRef} ${input.displayName}`;
  if (NAME_PATTERNS.some(pattern => pattern.test(name))) return "Safety/classifier model — not a chat-completions model";
  const family = NON_CHAT_NAME_PATTERNS.find(([pattern]) => pattern.test(input.modelRef));
  if (family) return family[1];
  if (input.description && DESCRIPTION_PATTERNS.some(pattern => pattern.test(input.description!))) return "Safety/classifier model — not a chat-completions model";
  return null;
}
