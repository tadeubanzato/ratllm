/**
 * A dedup/match key for a model id that's stable across sources' formatting
 * quirks (org/repo prefixes, dashes vs dots, casing) without collapsing
 * genuinely different models that happen to share a short generic name.
 * "zai-org/glm-4.7-flash", "zai/glm-4.7-flash" and "GLM-4.7-Flash" all key
 * to the same value; "gpt-oss-120b" and "gpt-oss-20b" stay distinct.
 */
export function bareModelKey(modelRef: string): string {
  const trimmed = modelRef.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  const suffix = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const candidate = /[0-9]/.test(suffix) && suffix.length >= 4 ? suffix : trimmed;
  return candidate.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Every LiteLLM deployment a discovery candidate corresponds to — one per lane it was added to, plus any direct alias. */
export function matchDeployments<T extends {providerId: string; providerModelId: string}>(deployments: readonly T[], providerId: string, modelRef: string): T[] {
  const key = bareModelKey(modelRef);
  return deployments.filter(deployment => deployment.providerId === providerId && bareModelKey(deployment.providerModelId) === key);
}

/** Finds the LiteLLM deployment (if any) a discovery candidate already corresponds to, so the UI/promotion flow never
 *  depends on having written a link back at add-time. A candidate can match more than one deployment row (e.g.
 *  re-added under a new LiteLLM entry after the old one was removed) — an ACTIVE match always wins over a stale
 *  DEACTIVATED/REMOVED one when a `lifecycle` field is present, so callers see the live deployment, not history. */
export function matchDeployment<T extends {providerId: string; providerModelId: string; lifecycle?: string}>(deployments: readonly T[], providerId: string, modelRef: string): T | null {
  const matches = matchDeployments(deployments, providerId, modelRef);
  return matches.find(deployment => deployment.lifecycle === "ACTIVE") ?? matches[0] ?? null;
}
