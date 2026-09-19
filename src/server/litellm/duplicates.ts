import { bareModelKey } from "@/server/discovery/model-key";

export interface DuplicateGroup { alias: string; providerName: string; providerModelId: string; apiBase: string | null; count: number; ids: string[];
  /** True when every copy's API key is recorded and identical, so they demonstrably share one quota. False when the key is unrecorded (deployments made before key provenance existed, or added outside RatLLM): the copies might use different keys. */
  keyKnown: boolean }

const normalizeBase = (value: string | null | undefined) => (value ?? "").trim().replace(/\/+$/, "").toLowerCase();

/** The same model deployed more than once behind one alias, through the SAME provider endpoint. Only live (ACTIVE)
 *  deployments count: a removed or blocked copy isn't taking traffic.
 *
 *  What is NOT a duplicate, because each has its own rate limits, cost and availability: the same model from a different
 *  provider (Google vs OpenRouter), or from the same provider through a different endpoint (another region or project).
 *  It also requires the same API key where that is recorded (each key has its own quota). Identical copies through one endpoint add no capacity to a router pool — they skew routing toward one model and multiply
 *  its use of a single shared quota. */
export function findDuplicateGroups(rows: readonly { id: string; litellmModelName: string; providerName: string; providerModelId: string; apiBase?: string | null; credentialFingerprint?: string | null; lifecycle?: string; litellmDeploymentId: string | null }[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const row of rows) {
    if ((row.lifecycle ?? "ACTIVE") !== "ACTIVE" || !row.litellmDeploymentId) continue;
    // A known key fingerprint separates copies that use different keys (separate quotas). Where it isn't recorded (older or
    // externally-added deployments) copies group as before — but never with a copy whose key IS known, since we can't say they match.
    const key = [row.litellmModelName, row.providerName, normalizeBase(row.apiBase), row.credentialFingerprint ?? "", bareModelKey(row.providerModelId)].join("|");
    const group = groups.get(key) ?? { alias: row.litellmModelName, providerName: row.providerName, providerModelId: row.providerModelId, apiBase: row.apiBase ?? null, count: 0, ids: [], keyKnown: Boolean(row.credentialFingerprint) };
    group.count += 1;
    group.ids.push(row.id);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.count > 1).sort((a, b) => b.count - a.count || a.alias.localeCompare(b.alias));
}
