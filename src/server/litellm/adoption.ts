import { CURATOR_MANAGED_BY } from "@/lib/constants";
import { SELF_HOSTED_PROVIDERS } from "@/server/providers/wiring";

/**
 * Adoption: an operator deliberately hands a deployment that another tool added over to RatLLM, by writing RatLLM's
 * `managed_by` into the router's metadata for that one deployment. From then on RatLLM health-checks it, and — if auto-remove
 * is switched on — may remove it after repeated failures, exactly like any other model it manages.
 *
 * It is never automatic and never bulk: one explicit, audited action per deployment.
 */

export interface AdoptionCandidate {
  managed: boolean;
  lifecycle: string;
  litellmDeploymentId: string | null;
  providerSlug: string;
}

export function planAdoption(deployment: AdoptionCandidate): { allowed: true } | { allowed: false; reason: string } {
  if (deployment.managed) return { allowed: false, reason: "RatLLM already manages this deployment." };
  if (!deployment.litellmDeploymentId || (deployment.lifecycle !== "ACTIVE" && deployment.lifecycle !== "DEACTIVATED")) return { allowed: false, reason: "This deployment is no longer in LiteLLM." };
  // A self-hosted model being unreachable is a laptop asleep, not a dead model; RatLLM never auto-mutates those.
  if (SELF_HOSTED_PROVIDERS.has(deployment.providerSlug)) return { allowed: false, reason: "Self-hosted (local) models are never handed to RatLLM's automation." };
  return { allowed: true };
}

/** What gets written into the router's model_info. Everything already there is kept; `adopted_from` records the previous manager. */
export function adoptionFields(previousOwner: string | null, now = new Date()): Record<string, string> {
  return { managed_by: CURATOR_MANAGED_BY, adopted_from: previousOwner || "unknown", adopted_at: now.toISOString() };
}

/**
 * Did the router keep everything it had and record the new manager? An update call that REPLACES model_info instead of merging
 * would silently drop every other field (lane, tier, rate limits, the previous tool's own bookkeeping), so any key that was
 * present before and is missing after counts as loss.
 */
export function verifyAdoption(before: Record<string, unknown>, after: Record<string, unknown>): { ok: boolean; managedNow: boolean; lostKeys: string[] } {
  const lostKeys = Object.keys(before).filter(key => !(key in after));
  const managedNow = after.managed_by === CURATOR_MANAGED_BY;
  return { ok: managedNow && lostKeys.length === 0, managedNow, lostKeys };
}

/** The router operations adoption needs. Kept narrow so the flow can be tested against a fake router. */
export interface AdoptionRouter {
  getModelInfo(id: string): Promise<Record<string, unknown> | null>;
  patchModelInfo(id: string, modelInfo: Record<string, unknown>): Promise<void>;
}

export type AdoptionResult =
  | { ok: true; before: Record<string, unknown>; after: Record<string, unknown> }
  | { ok: false; stage: "not_found" | "update_failed" | "verification_failed"; message: string; restored?: boolean; lostKeys?: string[] };

export async function adoptDeployment(router: AdoptionRouter, id: string, previousOwner: string | null, now = new Date()): Promise<AdoptionResult> {
  const before = await router.getModelInfo(id);
  if (!before) return { ok: false, stage: "not_found", message: "LiteLLM no longer lists this deployment." };

  try { await router.patchModelInfo(id, adoptionFields(previousOwner, now)); }
  catch (error) { return { ok: false, stage: "update_failed", message: error instanceof Error ? error.message : "LiteLLM rejected the update." }; }

  const after = (await router.getModelInfo(id)) ?? {};
  const check = verifyAdoption(before, after);
  if (check.ok) return { ok: true, before, after };

  // The router did not do what was asked, or dropped metadata while doing it. Put back exactly what was there before.
  let restored = false;
  try {
    await router.patchModelInfo(id, before);
    const again = (await router.getModelInfo(id)) ?? {};
    restored = Object.keys(before).every(key => key in again) && again.managed_by === before.managed_by;
  } catch { restored = false; }
  const detail = check.lostKeys.length ? `it dropped existing metadata (${check.lostKeys.slice(0, 5).join(", ")}${check.lostKeys.length > 5 ? ", …" : ""})` : "it did not record the new manager";
  return { ok: false, stage: "verification_failed", lostKeys: check.lostKeys, restored, message: `LiteLLM accepted the update but ${detail}. ${restored ? "The original metadata was restored." : "Restoring the original metadata FAILED — check this deployment in LiteLLM."}` };
}
