import { deploymentModelKey } from "@/server/discovery/model-key";

interface KnownDeployment { litellmModelName: string; providerModelId: string; litellmDeploymentId: string | null; lifecycle: string }

/** A deployment is still "in LiteLLM" while RatLLM holds its router ID and it hasn't been removed. A blocked (DEACTIVATED)
 *  one is still there — it just isn't routed to. */
export function isPresentInRouter(row: Pick<KnownDeployment, "litellmDeploymentId" | "lifecycle">) {
  return Boolean(row.litellmDeploymentId) && (row.lifecycle === "ACTIVE" || row.lifecycle === "DEACTIVATED");
}

/**
 * The deployment that already satisfies a promotion target (same alias, same model), if any.
 *
 * Health is deliberately NOT part of this. It used to be ("exists unless UNAVAILABLE"), so whenever a live deployment had
 * one bad probe or a rate-limited moment, the next promotion pass decided the target was missing and added another copy —
 * production ended up with the same model four times behind one alias. An unhealthy deployment is the health monitor's
 * to remove (with its failure streak and cooldown rules), never the promoter's to duplicate.
 */
export function findExistingTarget<T extends KnownDeployment>(rows: readonly T[], modelName: string, providerModelId: string): T | undefined {
  const key = deploymentModelKey(providerModelId);
  return rows.find(row => row.litellmModelName === modelName && deploymentModelKey(row.providerModelId) === key && isPresentInRouter(row));
}
