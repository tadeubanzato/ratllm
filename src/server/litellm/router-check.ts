import "server-only";
import { HttpLiteLLMAdapter } from "./client";
import { compareInventory, type InventoryParity, type TrackedDeployment } from "./parity";

export type RouterCheck = { reachable: true; parity: InventoryParity } | { reachable: false };

/** Asks the live router whether RatLLM's copy of the inventory is complete and current, so a page can say so when it is not instead of
 *  quietly showing an out-of-date list. Times out rather than hanging a page on a slow router. */
export async function checkAgainstRouter(rows: ReadonlyArray<{ litellmDeploymentId: string | null; litellmModelName: string; providerModelId: string; managed: boolean; lifecycle?: string }>, adapter = new HttpLiteLLMAdapter(), timeoutMs = 6000): Promise<RouterCheck> {
  try {
    const remote = await Promise.race([adapter.listDeployments(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))]);
    const tracked: TrackedDeployment[] = rows.map(row => ({ litellmDeploymentId: row.litellmDeploymentId, litellmModelName: row.litellmModelName, providerModelId: row.providerModelId, managed: row.managed, lifecycle: row.lifecycle ?? "ACTIVE" }));
    return { reachable: true, parity: compareInventory(tracked, remote) };
  } catch { return { reachable: false }; }
}

export const IN_SYNC: RouterCheck = { reachable: true, parity: { unknownToRatllm: [], goneFromRouter: [], stateDiffers: [], inSync: true } };
