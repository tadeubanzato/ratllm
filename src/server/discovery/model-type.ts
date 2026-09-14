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
  if (input.description && DESCRIPTION_PATTERNS.some(pattern => pattern.test(input.description!))) return "Safety/classifier model — not a chat-completions model";
  return null;
}
