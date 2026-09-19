export type PromotionRunStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

/**
 * The status of a promotion run. Every required step counts: the lane targets AND the fallback chains pushed to the router.
 * The fallback sync used to be discarded with `.catch(() => undefined)`, so a run whose fallbacks failed still read
 * "succeeded" and LiteLLM and RatLLM quietly disagreed about routing.
 */
export function promotionRunStatus(input: { targetsFailed: number; targetsTotal: number; fallbackOk: boolean }): { status: PromotionRunStatus; error: string | null } {
  const { targetsFailed, targetsTotal, fallbackOk } = input;
  if (targetsTotal > 0 && targetsFailed === targetsTotal) return { status: "FAILED", error: "Every lane target failed" };
  if (targetsFailed > 0) return { status: "PARTIAL", error: "One or more lane targets failed" };
  if (!fallbackOk) return { status: "PARTIAL", error: "The model was added, but the router's fallback chains could not be updated" };
  return { status: "SUCCEEDED", error: null };
}
