import "server-only";
import { decryptCredential } from "@/server/credentials/crypto";
import type { ProviderDefinition } from "@/server/providers/catalog";
import { buildExtraHeaders, resolveCompletionsEndpoint, supportsCredentialTest } from "@/server/providers/wiring";

export type CandidateVerificationStatus = "available" | "rate_limited" | "unavailable" | "auth_error" | "credential_missing" | "credential_unverified" | "provider_unresolved" | "provider_not_configured";
export interface CandidateVerificationResult { status: CandidateVerificationStatus; httpStatus: number | null; error: string | null; }
export interface CandidateVerificationInput { modelRef: string; source: string; provider: ProviderDefinition | null; providerBaseUrl: string | null; credential?: { environmentVariable: string; encryptedValue: string | null; valid: boolean | null; config?: Record<string, string> | null } | null; }

/** The chat-completions URL a candidate's provider is actually reachable at — the same URL LiteLLM would need to call it. */
export function resolveVerificationEndpoint(provider: ProviderDefinition, baseUrl: string | null) { return resolveCompletionsEndpoint(provider.slug, baseUrl); }
/** Strips a leading provider-prefix segment community sources sometimes bake into the model id, leaving the bare id the provider's own API expects. */
export function bareCandidateModelRef(input: CandidateVerificationInput) { if (input.source === "openrouter") return input.modelRef; const segment=input.modelRef.split("/",1)[0]?.toLowerCase(); const prefixes=new Set([input.provider?.slug,"mistral","groq","cerebras","sambanova","together_ai","together-ai","zai","zhipuai","gemini"]); return segment&&prefixes.has(segment)?input.modelRef.slice(segment.length+1):input.modelRef; }
/** Resolves a stored credential to its plaintext secret the same way the verifier does — env var takes precedence over the encrypted DB copy. */
export function resolveCredentialSecret(credential: {environmentVariable: string; encryptedValue: string | null}): string | null {
  const fromEnv = process.env[credential.environmentVariable];
  if (fromEnv) return fromEnv;
  if (credential.encryptedValue) { try { return decryptCredential(credential.encryptedValue); } catch { return null; } }
  return null;
}

/** Verifies the provider directly. It never adds a LiteLLM deployment. */
export async function verifyCandidateDirectly(input: CandidateVerificationInput): Promise<CandidateVerificationResult> {
  if (!input.provider) return { status: "provider_unresolved", httpStatus: null, error: "No provider could be resolved from this discovery record" };
  if (!input.credential) return { status: "credential_missing", httpStatus: null, error: `Add a credential for ${input.provider.name}` };
  // A provider with no safe way to pre-check a credential (its own docs confirm the check endpoint can't
  // discriminate a valid key from none) can never satisfy `valid === true` through any code path — blocking here
  // would strand it forever. The real completions call below becomes the only verification available for it.
  if (input.credential.valid !== true && supportsCredentialTest(input.provider.slug)) return { status: "credential_unverified", httpStatus: null, error: `Verify ${input.provider.name} credential before testing candidates` };
  const url=resolveVerificationEndpoint(input.provider,input.providerBaseUrl); if (!url) return { status: "provider_not_configured", httpStatus: null, error: `${input.provider.name} has no automated verification endpoint configured` };
  const apiKey=resolveCredentialSecret(input.credential);
  if (!apiKey) return { status:"credential_missing",httpStatus:null,error:`Credential ${input.credential.environmentVariable} is not available to the verifier` };
  try { const response=await fetch(url,{method:"POST",headers:{authorization:`Bearer ${apiKey}`,"content-type":"application/json",...buildExtraHeaders(input.provider.slug,input.credential.config)},body:JSON.stringify({model:bareCandidateModelRef(input),messages:[{role:"user",content:"Reply with OK"}],max_tokens:4,temperature:0}),signal:AbortSignal.timeout(30_000),cache:"no-store"}); const body=await response.json().catch(()=>({})) as {error?:{message?:string}|string;message?:string}; const error=typeof body.error==="string"?body.error:body.error?.message??body.message??null; if(response.ok)return{status:"available",httpStatus:response.status,error:null}; if(response.status===429)return{status:"rate_limited",httpStatus:response.status,error}; if(response.status===401||response.status===403)return{status:"auth_error",httpStatus:response.status,error}; return{status:"unavailable",httpStatus:response.status,error}; } catch(error) { return {status:"unavailable",httpStatus:null,error:error instanceof Error?error.message:"Provider request failed"}; }
}
