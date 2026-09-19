import { CURATOR_MANAGED_BY } from "@/lib/constants";
import type { LiteLLMDeployment } from "./types";

/** `deploymentId` is LiteLLM's own remote deployment ID or `null` when the router did not supply one. It is never
 *  synthesized from the alias/model name: that value is later used to delete, block, and probe a deployment, and an
 *  alias is shared by every member of a pool, so a guessed ID could target the wrong deployment. */
export function deploymentIdentity(item: LiteLLMDeployment) {
  const params = item.litellm_params;
  const info = item.model_info;
  const providerModelId = String(params.model ?? info.model ?? item.model_name);
  const raw = info.id ?? info.model_id ?? item.model_id;
  const deploymentId = raw === undefined || raw === null || String(raw).trim() === "" ? null : String(raw);
  return { providerModelId, deploymentId };
}

export function isManagedDeployment(item: LiteLLMDeployment) {
  return item.model_info.managed_by === CURATOR_MANAGED_BY;
}

/** True when the deployment has been blocked at the router (LiteLLM's PATCH /model/{id}/update {blocked:true} —
 *  the same mechanism setDeploymentBlocked uses, so this recognizes a block regardless of whether ratllm or an
 *  external tool applied it). A blocked deployment stays listed in /v1/model/info but is excluded from routing. */
export function isBlockedDeployment(item: LiteLLMDeployment) {
  return item.model_info.blocked === true;
}

export function sanitizedMetadata(item: LiteLLMDeployment): Record<string, unknown> {
  const forbidden = /key|secret|token|authorization|password/i;
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).map(([key, nested]) => [key, clean(nested)]));
    return value;
  };
  return clean(item) as Record<string, unknown>;
}
