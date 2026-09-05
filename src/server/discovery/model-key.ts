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

/** Finds the LiteLLM deployment (if any) a discovery candidate already corresponds to, so the UI/promotion flow never depends on having written a link back at add-time. */
export function matchDeployment<T extends {providerId: string; providerModelId: string}>(deployments: readonly T[], providerId: string, modelRef: string): T | null {
  const key = bareModelKey(modelRef);
  return deployments.find(deployment => deployment.providerId === providerId && bareModelKey(deployment.providerModelId) === key) ?? null;
}
