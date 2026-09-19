export interface OwnedDeployment {
  id: string;
  owner?: string | null;
  managed: boolean;
  lifecycle?: string;
  health: string;
  litellmDeploymentId: string | null;
  litellmModelName: string;
  providerModelId: string;
  providerName: string;
}

/** Health values that mean a live deployment is not currently serving. */
const NOT_SERVING = new Set(["UNAVAILABLE", "AUTH_ERROR"]);

const isLive = (row: OwnedDeployment) => (row.lifecycle ?? "ACTIVE") === "ACTIVE" && !!row.litellmDeploymentId;

/** The tool that manages a deployment, as recorded in the router's own metadata. RatLLM-managed ones are "ratllm-curator". */
export const ownerLabel = (row: Pick<OwnedDeployment, "owner" | "managed">) => row.managed ? "RatLLM" : row.owner || "unknown";

export interface OwnerSummary { owner: string; managedByRatllm: boolean; live: number; healthy: number; notServing: number }

/** Live deployments grouped by who manages them. Several tools write to one router; this makes that visible. */
export function summarizeOwners(rows: readonly OwnedDeployment[]): OwnerSummary[] {
  const groups = new Map<string, OwnerSummary>();
  for (const row of rows.filter(isLive)) {
    const owner = ownerLabel(row);
    const group = groups.get(owner) ?? { owner, managedByRatllm: row.managed, live: 0, healthy: 0, notServing: 0 };
    group.live += 1;
    if (row.health === "HEALTHY") group.healthy += 1;
    if (NOT_SERVING.has(row.health)) group.notServing += 1;
    groups.set(owner, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.managedByRatllm) - Number(a.managedByRatllm) || b.live - a.live || a.owner.localeCompare(b.owner));
}

/**
 * Live deployments that are not serving but that RatLLM will not act on by itself, because it doesn't manage them
 * (auto-removal only ever touches RatLLM's own). They stay in their lanes until someone deals with them in the router.
 */
export function unmanagedNotServing(rows: readonly OwnedDeployment[]): OwnedDeployment[] {
  return rows.filter(row => !row.managed && isLive(row) && NOT_SERVING.has(row.health))
    .sort((a, b) => a.litellmModelName.localeCompare(b.litellmModelName) || a.providerModelId.localeCompare(b.providerModelId));
}
