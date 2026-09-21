import "server-only";
import { and, eq } from "drizzle-orm";
import { decryptCredential } from "@/server/credentials/crypto";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers } from "@/server/db/schema";
import { reconcileCheckBlockers } from "@/server/discovery/blockers";
import { getGigaChatAccessToken, gigachatFetch } from "./gigachat";
import { buildExtraHeaders, resolveCheck, supportsCredentialTest } from "./wiring";

export { supportsCredentialTest };

/** Re-verifies every enabled provider that has a configured, non-disabled credential and a supported check. Run on a schedule so credential status never goes stale between manual clicks. */
export async function verifyAllProviders() {
  const db = getDb();
  const raw = await db.select({ id: providers.id, slug: providers.slug })
    .from(providers)
    .innerJoin(providerCredentialReferences, and(eq(providerCredentialReferences.providerId, providers.id), eq(providerCredentialReferences.disabled, false)))
    .where(eq(providers.enabled, true));
  const rows = [...new Map(raw.map(row => [row.id, row])).values()];
  const candidates = rows.filter(row => supportsCredentialTest(row.slug));
  let verified = 0, authFailed = 0, degraded = 0;
  for (const row of candidates) {
    try {
      const result = await verifyProvider(row.id);
      if (result.ok) verified++;
      else if (result.message === "Provider rejected the credential") authFailed++;
      else degraded++;
    } catch { degraded++; }
  }
  return { checked: candidates.length, verified, authFailed, degraded, unsupported: rows.length - candidates.length };
}

export async function verifyProvider(providerId:string){const db=getDb();const provider=(await db.select().from(providers).where(eq(providers.id,providerId)).limit(1))[0];if(!provider)throw new Error("Provider not found");if(!provider.enabled)return {supported:true,ok:false,message:"Enable the provider before testing its credential"};const definition=resolveCheck(provider.slug,provider.baseUrl);if(!definition)return{supported:false,ok:false,message:"This adapter does not expose a safe credential check yet"};const credential=(await db.select().from(providerCredentialReferences).where(and(eq(providerCredentialReferences.providerId,providerId),eq(providerCredentialReferences.disabled,false))).limit(1))[0];if(!credential)throw new Error("No credential configured");let secret:string;if(credential.encryptedValue)secret=decryptCredential(credential.encryptedValue);else{secret=process.env[credential.environmentVariable]??"";if(!secret)throw new Error(`${credential.environmentVariable} is not available to the server`)}
// GigaChat's stored credential is an OAuth "Authorization key", not a Bearer token itself — exchange it for one
// (see gigachat.ts), and use its CA-pinned fetch since its hosts don't chain to a globally-trusted CA.
const isGigaChat=provider.slug==="gigachat";
if(isGigaChat){const tokenResult=await getGigaChatAccessToken(secret);if("error" in tokenResult){await db.update(providerCredentialReferences).set({valid:tokenResult.httpStatus===401||tokenResult.httpStatus===403?false:null,lastValidatedAt:new Date(),updatedAt:new Date()}).where(eq(providerCredentialReferences.id,credential.id));await db.update(providers).set({status:"AUTH_FAILED",updatedAt:new Date()}).where(eq(providers.id,providerId));return{supported:true,ok:false,message:tokenResult.error};}secret=tokenResult.token;}
const url=definition.auth==="query"?`${definition.url}?key=${encodeURIComponent(secret)}`:definition.url;let response:Response;try{response=await (isGigaChat?gigachatFetch:fetch)(url,{headers:{accept:"application/json","user-agent":"ratllm/0.1",...(definition.auth==="bearer"?{authorization:`Bearer ${secret}`}:{}),...buildExtraHeaders(provider.slug,credential.config)},signal:AbortSignal.timeout(20_000),cache:"no-store"})}catch{await db.update(providers).set({status:"DEGRADED",updatedAt:new Date()}).where(eq(providers.id,providerId));return{supported:true,ok:false,message:"Connection failed. Check provider availability and server network connectivity."}}const ok=response.ok;const authFailure=response.status===401||response.status===403;await db.update(providerCredentialReferences).set({valid:ok?true:authFailure?false:null,lastValidatedAt:new Date(),updatedAt:new Date()}).where(eq(providerCredentialReferences.id,credential.id));await db.update(providers).set({status:ok?"ACTIVE":authFailure?"AUTH_FAILED":"DEGRADED",updatedAt:new Date()}).where(eq(providers.id,providerId));await reconcileCheckBlockers(db);return{supported:true,ok,status:response.status,message:ok?"Credential verified":authFailure?"Provider rejected the credential":`Provider returned HTTP ${response.status}`};}
