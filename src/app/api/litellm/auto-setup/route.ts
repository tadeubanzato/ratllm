import { NextResponse } from "next/server";
import { apiError, correlationId } from "@/server/http";
import { connectionSummary } from "@/server/settings/connections";
import { reconcileLaneMembership } from "@/server/lanes/reconcile";

/**
 * One-click "make LiteLLM match ratllm's lane + fallback setup right now" — the same convergence the
 * LANE_RECONCILE job already runs on a schedule (re-adds any lane member missing from LiteLLM, then pushes the
 * declared cross-lane fallback chains), just triggered on demand instead of waiting for the next tick.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  const summary = await connectionSummary("litellm");
  if (!summary.configured) return apiError("LITELLM_NOT_CONFIGURED", "Set the LiteLLM master key in Settings → LiteLLM before running auto setup.", 409, id);
  try {
    const result = await reconcileLaneMembership();
    return NextResponse.json({ ok: result.failures.length === 0 && result.fallback.ok, ...result, correlationId: id });
  } catch (error) {
    return apiError("AUTO_SETUP_FAILED", error instanceof Error ? error.message : "Auto setup failed", 502, id);
  }
}
