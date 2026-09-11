import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers } from "@/server/db/schema";
import { resolveCredentialSecret } from "@/server/discovery/verify";
import { getProviderPortal } from "./portals";

export interface DetectCandidateResult { url: string; outcome: "hit" | "miss"; status: number | null; detail: string }
export interface DetectResult { candidates: DetectCandidateResult[]; suggestion: string | null }

function apexDomain(hostname: string): string {
  const parts = hostname.split(".");
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

/** A small, bounded set of plausible completions URLs to actually try — derived from the provider's own
 *  registration/console domain (already stored for the portal link) plus anything already typed as a Base URL.
 *  This only catches providers that follow the common `api.{domain}/v1/chat/completions` convention; providers
 *  with a distinct subdomain (router.*, ark.*, api-inference.*), a different TLD, or an unconventional path are
 *  real research, not something guessable — auto-detect says so honestly rather than reporting a false miss as success. */
function candidateUrls(slug: string, existingBaseUrl: string | null): string[] {
  const urls = new Set<string>();
  if (existingBaseUrl) urls.add(`${existingBaseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions`);
  const portal = getProviderPortal(slug);
  if (portal) {
    try {
      const host = new URL(portal.url).hostname;
      const apex = apexDomain(host);
      urls.add(`https://api.${apex}/v1/chat/completions`);
      urls.add(`https://${apex}/v1/chat/completions`);
      if (host !== apex) urls.add(`https://${host}/v1/chat/completions`);
    } catch { /* malformed portal URL — skip domain-derived guesses */ }
  }
  return [...urls].slice(0, 5);
}

/** Ranks how convincingly a response looks like a genuine OpenAI-compatible completions endpoint, without
 *  knowing a real model id to test with (a "hit" doesn't have to succeed — a structured "model not found" is
 *  just as strong a signal that we reached the right host and path as a real completion would be). */
function scoreResponse(status: number, body: unknown): { hit: boolean; detail: string } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.choices)) return { hit: true, detail: `HTTP ${status} · returned a real completion` };
    if (typeof record.error === "string" || (record.error && typeof record.error === "object") || typeof record.message === "string" || typeof record.detail === "string") {
      return { hit: true, detail: `HTTP ${status} · structured API error (expected — the probe model id isn't real)` };
    }
  }
  return { hit: false, detail: `HTTP ${status} · not a recognizable API response` };
}

/** Tries each candidate with a live, minimal chat-completions request using the provider's real saved credential.
 *  Never applies a result itself — always returns a suggestion for the caller (the UI) to confirm and save. */
export async function autoDetectCompletionsEndpoint(providerId: string): Promise<DetectResult> {
  const db = getDb();
  const provider = (await db.select().from(providers).where(eq(providers.id, providerId)).limit(1))[0];
  if (!provider) throw new Error("Provider not found");
  const credential = (await db.select().from(providerCredentialReferences).where(and(eq(providerCredentialReferences.providerId, providerId), eq(providerCredentialReferences.disabled, false))).limit(1))[0];
  if (!credential) throw new Error("Add a credential for this provider before auto-detecting its endpoint");
  const apiKey = resolveCredentialSecret(credential);
  if (!apiKey) throw new Error(`Credential ${credential.environmentVariable} is not available to the server`);

  const urls = candidateUrls(provider.slug, provider.baseUrl);
  if (!urls.length) return { candidates: [], suggestion: null };

  const results: DetectCandidateResult[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "__ratllm_autodetect_probe__", messages: [{ role: "user", content: "OK" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10_000), cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      const { hit, detail } = scoreResponse(response.status, body);
      results.push({ url, outcome: hit ? "hit" : "miss", status: response.status, detail });
    } catch (error) {
      results.push({ url, outcome: "miss", status: null, detail: error instanceof Error ? error.message : "Request failed" });
    }
  }

  const hits = results.filter(item => item.outcome === "hit");
  // Only suggest when exactly one candidate looks real — if two both look plausible we can't tell which is right,
  // and guessing wrong here would be worse than saying nothing.
  const suggestion = hits.length === 1 ? hits[0].url.replace(/\/chat\/completions$/, "") : null;
  return { candidates: results, suggestion };
}
