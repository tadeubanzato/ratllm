import { CURATOR_MANAGED_BY } from "@/lib/constants";
import type { LiteLLMDeployment } from "./types";

export function deploymentIdentity(item: LiteLLMDeployment) {
  const params = item.litellm_params;
  const info = item.model_info;
  const providerModelId = String(params.model ?? info.model ?? item.model_name);
  const deploymentId = String(info.id ?? info.model_id ?? item.model_id ?? `${item.model_name}:${providerModelId}`);
  return { providerModelId, deploymentId };
}

export function isManagedDeployment(item: LiteLLMDeployment) {
  return item.model_info.managed_by === CURATOR_MANAGED_BY;
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
