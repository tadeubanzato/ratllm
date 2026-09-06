import "server-only";
import { LANE_IDS } from "@/lib/constants";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import type { FallbackType } from "@/server/litellm/types";
import { LANE_FALLBACKS, type FallbackKind } from "./rules";

const KIND_TYPE: Record<FallbackKind, FallbackType> = { general: "general", context_window: "context_window" };

/**
 * Pushes ratllm's cross-lane fallback chains to the LiteLLM router (POST/DELETE /fallback,
 * which needs STORE_MODEL_IN_DB=True). Declarative: every `smart-*` group is set to exactly
 * the chain in LANE_FALLBACKS, and cleared when it has none. Never touches non-lane models.
 */
export async function syncFallbackConfig(adapter: HttpLiteLLMAdapter = new HttpLiteLLMAdapter()) {
  const applied: { model: string; type: FallbackType; fallbackModels: string[] }[] = [];
  const errors: { model: string; type: FallbackType; error: string }[] = [];

  for (const kind of Object.keys(LANE_FALLBACKS) as FallbackKind[]) {
    const type = KIND_TYPE[kind];
    for (const slug of LANE_IDS) {
      const chain = LANE_FALLBACKS[kind][slug] ?? [];
      try {
        await adapter.setFallback(slug, chain, type); // setFallback deletes when the chain is empty
        applied.push({ model: slug, type, fallbackModels: chain });
      } catch (error) {
        errors.push({ model: slug, type, error: error instanceof Error ? error.message : "fallback update failed" });
      }
    }
  }
  return { applied, errors, ok: errors.length === 0 };
}
