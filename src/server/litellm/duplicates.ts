import { bareModelKey } from "@/server/discovery/model-key";

export interface DuplicateGroup { alias: string; providerName: string; providerModelId: string; count: number; ids: string[] }

/** The same model deployed more than once behind one alias, from one provider. Only live (ACTIVE) deployments count: a
 *  removed or blocked copy isn't taking traffic. Identical copies add no capacity to a router pool — they just skew routing
 *  toward one model and multiply its provider rate-limit consumption. */
export function findDuplicateGroups(rows: readonly { id: string; litellmModelName: string; providerName: string; providerModelId: string; lifecycle?: string; litellmDeploymentId: string | null }[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const row of rows) {
    if ((row.lifecycle ?? "ACTIVE") !== "ACTIVE" || !row.litellmDeploymentId) continue;
    const key = [row.litellmModelName, row.providerName, bareModelKey(row.providerModelId)].join("|");
    const group = groups.get(key) ?? { alias: row.litellmModelName, providerName: row.providerName, providerModelId: row.providerModelId, count: 0, ids: [] };
    group.count += 1;
    group.ids.push(row.id);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.count > 1).sort((a, b) => b.count - a.count || a.alias.localeCompare(b.alias));
}
