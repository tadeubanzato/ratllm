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
/** Path suffixes to try under each candidate domain. Most providers are flat (`/v1/chat/completions`), but a
 *  few nest their OpenAI-compatible layer under an extra segment (Groq's real path is `/openai/v1/chat/completions`
 *  — a plain domain guess without this would land on the right host and still suggest the wrong URL). */
const PATH_SUFFIXES = ["/v1/chat/completions", "/openai/v1/chat/completions"];

function candidateUrls(slug: string, existingBaseUrl: string | null): string[] {
  const bases = new Set<string>();
  if (existingBaseUrl) bases.add(existingBaseUrl.replace(/\/$/, "").replace(/\/v1$/, ""));
  const portal = getProviderPortal(slug);
  if (portal) {
    try {
      const host = new URL(portal.url).hostname;
      const apex = apexDomain(host);
      bases.add(`https://api.${apex}`);
      bases.add(`https://${apex}`);
      if (host !== apex) bases.add(`https://${host}`);
    } catch { /* malformed portal URL — skip domain-derived guesses */ }
  }
  const urls = new Set<string>();
  for (const base of bases) for (const suffix of PATH_SUFFIXES) urls.add(`${base}${suffix}`);
  return [...urls].slice(0, 8);
}

/** Ranks how convincingly a response looks like a genuine OpenAI-compatible completions endpoint, without
 *  knowing a real model id to test with. A generic JSON 404 from an unrelated route or gateway is common and
 *  must NOT count as a hit just for being JSON-shaped — it only counts when the body actually references the
 *  probe model (the real "model not found" rejection every OpenAI-compatible API gives for an unknown id), or
 *  when the status itself is a strong signal on its own (a real completion, or an auth layer engaging at all). */
function scoreResponse(status: number, body: unknown): { hit: boolean; detail: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (record && Array.isArray(record.choices)) return { hit: true, detail: `HTTP ${status} · returned a real completion` };
  if (status === 401 || status === 403) return record ? { hit: true, detail: `HTTP ${status} · reached a real auth layer` } : { hit: false, detail: `HTTP ${status} · not JSON — likely a generic gateway rejection, not this API` };
  if (record) {
    const text = JSON.stringify(record).toLowerCase();
    if (text.includes("__ratllm_autodetect_probe__") || (text.includes("model") && (status === 400 || status === 404 || status === 422))) {
      return { hit: true, detail: `HTTP ${status} · structured "model not found" rejection (expected — the probe model id isn't real)` };
    }
  }
  return { hit: false, detail: `HTTP ${status} · doesn't reference the probe — likely the wrong path even if JSON-shaped` };
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
