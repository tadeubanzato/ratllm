import "server-only";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { decryptCredential } from "@/server/credentials/crypto";
import { getDb } from "@/server/db/client";
import { modelDeployments, providerCredentialReferences, providers } from "@/server/db/schema";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { log } from "@/server/logging";
import { RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA } from "./gigachat-ca";

// Duplicated from discovery/verify.ts's resolveCredentialSecret rather than imported: that module imports this one
// (to swap in the OAuth token ahead of its generic bearer-token path), and importing it back here would cycle.
function resolveCredentialSecret(credential: { environmentVariable: string; encryptedValue: string | null }): string | null {
  const fromEnv = process.env[credential.environmentVariable];
  if (fromEnv) return fromEnv;
  if (credential.encryptedValue) { try { return decryptCredential(credential.encryptedValue); } catch { return null; } }
  return null;
}

/** Verified live against ngw.devices.sberbank.ru:9443 and gigachat.devices.sberbank.ru — TLS "Verify return code: 0". */
const gigachatAgent = new https.Agent({ ca: [RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA] });

interface GigaChatFetchInit { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; }
/** A `fetch`-shaped wrapper around Node's `https` module (not global `fetch`, which has no way to pin a
 *  non-default CA without an extra dependency) so callers can treat GigaChat like any other provider. */
export function gigachatFetch(url: string, init: GigaChatFetchInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: init.method ?? "GET", headers: init.headers, agent: gigachatAgent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === "string") headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(", "));
        }
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
      });
    });
    request.on("error", reject);
    if (init.signal) init.signal.addEventListener("abort", () => request.destroy(new Error("Aborted")));
    if (init.body) request.write(init.body);
    request.end();
  });
}

export type GigaChatScope = "GIGACHAT_API_PERS" | "GIGACHAT_API_B2B" | "GIGACHAT_API_CORP";
const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
export const GIGACHAT_MODELS_URL = "https://gigachat.devices.sberbank.ru/api/v1/models";
export const GIGACHAT_COMPLETIONS_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";

// Only the free/personal scope: this app's mission is discovering free models, and GIGACHAT_API_B2B/CORP are
// paid business tiers with their own contract terms — not something to reach for without being asked.
const DEFAULT_SCOPE: GigaChatScope = "GIGACHAT_API_PERS";
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export type GigaChatTokenResult = { token: string } | { error: string; httpStatus: number | null };

/** Exchanges the stored "Authorization key" (base64 client_id:client_secret, issued by Sber) for a Bearer access
 *  token good for ~30 minutes, per Sber's own OAuth reference. Cached in-process so a burst of calls against the
 *  same credential (verifying many candidates, or refreshing many deployments) shares one exchange. */
export async function getGigaChatAccessToken(authorizationKey: string, scope: GigaChatScope = DEFAULT_SCOPE): Promise<GigaChatTokenResult> {
  const cacheKey = `${authorizationKey}:${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) return { token: cached.token };
  try {
    const response = await gigachatFetch(OAUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", rquid: randomUUID(), authorization: `Basic ${authorizationKey}` },
      body: `scope=${encodeURIComponent(scope)}`,
    });
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_at?: number; message?: string };
    if (!response.ok || !body.access_token) {
      return { error: body.message ?? `GigaChat token exchange failed (HTTP ${response.status})`, httpStatus: response.status || null };
    }
    // Sber returns expires_at as an epoch in milliseconds; guard against a seconds-based value defensively
    // (13-digit ms vs 10-digit seconds) since this was confirmed from third-party docs, not a live token.
    const expiresAt = typeof body.expires_at === "number" && body.expires_at > 10_000_000_000 ? body.expires_at : Date.now() + 25 * 60_000;
    tokenCache.set(cacheKey, { token: body.access_token, expiresAt });
    return { token: body.access_token };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "GigaChat token request failed", httpStatus: null };
  }
}

/** Re-mints GigaChat's access token and pushes it to every LiteLLM deployment we manage for it. Necessary because
 *  this app registers providers with LiteLLM as a static api_base+api_key pair (see lanes/promote.ts) — GigaChat's
 *  token expires every ~30 minutes, so without this a promoted GigaChat model would silently 401 shortly after
 *  being added. Runs on its own short cron (see automation/schedule.ts) rather than piggybacking on a slower job. */
export async function refreshGigaChatTokens() {
  const db = getDb();
  const [provider] = await db.select().from(providers).where(eq(providers.slug, "gigachat")).limit(1);
  if (!provider) return { refreshed: 0, deployments: 0 };
  const credential = (await db.select().from(providerCredentialReferences)
    .where(and(eq(providerCredentialReferences.providerId, provider.id), eq(providerCredentialReferences.disabled, false))).limit(1))[0];
  if (!credential) return { refreshed: 0, deployments: 0 };
  const secret = resolveCredentialSecret(credential);
  if (!secret) return { refreshed: 0, deployments: 0 };

  const deployments = await db.select().from(modelDeployments)
    .where(and(eq(modelDeployments.providerId, provider.id), eq(modelDeployments.managed, true), isNotNull(modelDeployments.litellmDeploymentId)));
  if (!deployments.length) return { refreshed: 0, deployments: 0 };

  const tokenResult = await getGigaChatAccessToken(secret);
  if ("error" in tokenResult) {
    log("warn", "GigaChat token refresh failed", { error: tokenResult.error, httpStatus: tokenResult.httpStatus });
    return { refreshed: 0, deployments: deployments.length, error: tokenResult.error };
  }

  const adapter = new HttpLiteLLMAdapter();
  let refreshed = 0;
  for (const deployment of deployments) {
    try { await adapter.updateDeploymentApiKey(deployment.litellmDeploymentId!, tokenResult.token); refreshed++; }
    catch (error) { log("warn", "Failed to push refreshed GigaChat token to a LiteLLM deployment", { deploymentId: deployment.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { refreshed, deployments: deployments.length };
}
