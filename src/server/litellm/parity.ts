import { deploymentIdentity, isBlockedDeployment, isManagedDeployment } from "./classify";
import type { LiteLLMDeployment } from "./types";

/** What RatLLM currently believes about one deployment that is still in the router (live or deactivated). */
export interface TrackedDeployment { litellmDeploymentId: string | null; litellmModelName: string; providerModelId: string; managed: boolean; lifecycle: string }

export interface ParityIssue { deploymentId: string; lane: string; model: string; detail: string }
export interface InventoryParity {
  /** In the router but unknown to RatLLM: added outside RatLLM since the last sync. */
  unknownToRatllm: ParityIssue[];
  /** RatLLM lists it as still in the router, but the router no longer has it. */
  goneFromRouter: ParityIssue[];
  /** RatLLM's managed / blocked state differs from what the router says (the router is the truth). */
  stateDiffers: ParityIssue[];
  inSync: boolean;
}

/** Compares RatLLM's copy of the inventory with the live router, using the same rules the hourly sync uses to decide what
 *  "managed" and "blocked" mean, so the LiteLLM page can say so when its copy is out of date instead of silently showing it.
 *  Removed deployments are history, not inventory, and are left out by the caller. */
export function compareInventory(tracked: readonly TrackedDeployment[], remote: readonly LiteLLMDeployment[]): InventoryParity {
  const byId = new Map(tracked.filter(row => row.litellmDeploymentId).map(row => [row.litellmDeploymentId as string, row]));
  const unknownToRatllm: ParityIssue[] = [], stateDiffers: ParityIssue[] = [];
  const seen = new Set<string>();
  for (const item of remote) {
    const { deploymentId, providerModelId } = deploymentIdentity(item);
    if (!deploymentId) continue;
    seen.add(deploymentId);
    const known = byId.get(deploymentId);
    if (!known) { unknownToRatllm.push({ deploymentId, lane: item.model_name, model: providerModelId, detail: "Added to LiteLLM outside RatLLM since the last sync" }); continue; }
    const managed = isManagedDeployment(item), blocked = isBlockedDeployment(item);
    if (managed !== known.managed) stateDiffers.push({ deploymentId, lane: item.model_name, model: providerModelId, detail: managed ? "LiteLLM says RatLLM manages it, RatLLM does not" : "RatLLM says it manages it, LiteLLM does not" });
    if (blocked !== (known.lifecycle === "DEACTIVATED")) stateDiffers.push({ deploymentId, lane: item.model_name, model: providerModelId, detail: blocked ? "Blocked in LiteLLM, active in RatLLM" : "Active in LiteLLM, deactivated in RatLLM" });
  }
  const goneFromRouter = [...byId.values()].filter(row => !seen.has(row.litellmDeploymentId as string))
    .map(row => ({ deploymentId: row.litellmDeploymentId as string, lane: row.litellmModelName, model: row.providerModelId, detail: "No longer in LiteLLM" }));
  return { unknownToRatllm, goneFromRouter, stateDiffers, inSync: !unknownToRatllm.length && !goneFromRouter.length && !stateDiffers.length };
}
