import "server-only";
import { decryptCredential } from "@/server/credentials/crypto";
import type { ProviderDefinition } from "@/server/providers/catalog";
import { buildExtraHeaders, providerWiring, resolveCompletionsEndpoint, supportsCredentialTest } from "@/server/providers/wiring";
import { getGigaChatAccessToken, gigachatFetch } from "@/server/providers/gigachat";

export type CandidateVerificationStatus = "available" | "rate_limited" | "unavailable" | "auth_error" | "out_of_credits" | "credential_missing" | "credential_unverified" | "provider_unresolved" | "provider_not_configured";
export interface CandidateVerificationResult { status: CandidateVerificationStatus; httpStatus: number | null; error: string | null; }
export interface CandidateVerificationInput { modelRef: string; source: string; provider: ProviderDefinition | null; providerBaseUrl: string | null; credential?: { environmentVariable: string; encryptedValue: string | null; valid: boolean | null; config?: Record<string, string> | null } | null; }

/** The chat-completions URL a candidate's provider is actually reachable at — the same URL LiteLLM would need to call it. */
export function resolveVerificationEndpoint(provider: ProviderDefinition, baseUrl: string | null) { return resolveCompletionsEndpoint(provider.slug, baseUrl); }

/** A provider saying the *account* has nothing left to spend, as opposed to the model being broken or busy. */
const OUT_OF_CREDITS_MESSAGE = /insufficient[_ ](balance|funds|credit|quota)|out of (credit|balance)|no (remaining )?credit|(add|top[- ]?up) (balance|credit)|positive balance|credit limit|exceeded your current quota|more credits|can only afford|payment required|billing (hard )?limit/i;

/** What a non-2xx answer from a provider means. 402 is "pay first" by definition; some providers say the same in a 429
 *  ("insufficient_quota") or 403, which must not be read as a rate limit that a retry fixes or a credential that is wrong.
 *  Out of credits is a fact about the *account*, not the model: it neither proves the model works nor that it is gone, so it
 *  is its own status and is retried slowly instead of counting as a failure. Pure, and tested against real responses. */
export function classifyProviderFailure(httpStatus: number, message: string | null): "rate_limited" | "auth_error" | "out_of_credits" | "unavailable" {
  const text = message ?? "";
  if (httpStatus === 402) return "out_of_credits";
  if ((httpStatus === 429 || httpStatus === 403) && OUT_OF_CREDITS_MESSAGE.test(text)) return "out_of_credits";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 401 || httpStatus === 403) return "auth_error";
  return "unavailable";
}
/** Strips a leading provider-prefix segment community sources sometimes bake into the model id, leaving the bare id the provider's own API expects. */
export function bareCandidateModelRef(input: CandidateVerificationInput) { if (input.source === "openrouter") return input.modelRef; const segment=input.modelRef.split("/",1)[0]?.toLowerCase();
  // NVIDIA NIM ids are "<org>/<model>" and the org is part of the id ("nvidia/llama-3.1-nemotron-70b-instruct"), so its own
  // slug must not be treated as a routing prefix the way "groq/…" or "cerebras/…" is — stripping it 404s every nvidia-org model.
  const prefixes=new Set([input.provider?.slug==="nvidia"?undefined:input.provider?.slug,"mistral","groq","cerebras","sambanova","together_ai","together-ai","zai","zhipuai","gemini"]); return segment&&prefixes.has(segment)?input.modelRef.slice(segment.length+1):input.modelRef; }
/** Resolves a stored credential to its plaintext secret the same way the verifier does — env var takes precedence over the encrypted DB copy. */
export function resolveCredentialWithSource(credential: {environmentVariable: string; encryptedValue: string | null}): {secret: string; source: "environment" | "database"} | null {
  const fromEnv = process.env[credential.environmentVariable];
  if (fromEnv) return {secret: fromEnv, source: "environment"};
  if (credential.encryptedValue) { try { return {secret: decryptCredential(credential.encryptedValue), source: "database"}; } catch { return null; } }
  return null;
}
export function resolveCredentialSecret(credential: {environmentVariable: string; encryptedValue: string | null}): string | null {
  return resolveCredentialWithSource(credential)?.secret ?? null;
}

/** Verifies the provider directly. It never adds a LiteLLM deployment. */
export async function verifyCandidateDirectly(input: CandidateVerificationInput): Promise<CandidateVerificationResult> {
  if (!input.provider) return { status: "provider_unresolved", httpStatus: null, error: "No provider could be resolved from this discovery record" };
  // Some providers (Pollinations, LLM7, Kilo's free models, Chutes) serve anonymous requests; a key only raises their limits.
  // Requiring a credential row for them meant they could never be tested at all.
  const keyless = Boolean(providerWiring[input.provider.slug]?.credentialOptional);
  if (!input.credential && !keyless) return { status: "credential_missing", httpStatus: null, error: `Add a credential for ${input.provider.name}` };
  // A provider with no safe way to pre-check a credential (its own docs confirm the check endpoint can't
  // discriminate a valid key from none) can never satisfy `valid === true` through any code path — blocking here
  // would strand it forever. The real completions call below becomes the only verification available for it.
  if (input.credential && input.credential.valid !== true && supportsCredentialTest(input.provider.slug)) return { status: "credential_unverified", httpStatus: null, error: `Verify ${input.provider.name} credential before testing candidates` };
  const url=resolveVerificationEndpoint(input.provider,input.providerBaseUrl); if (!url) return { status: "provider_not_configured", httpStatus: null, error: `${input.provider.name} has no automated verification endpoint configured` };
  const secret=input.credential?resolveCredentialSecret(input.credential):null;
  if (!secret&&!keyless) return { status:"credential_missing",httpStatus:null,error:`Credential ${input.credential?.environmentVariable??"(none)"} is not available to the verifier` };
  // GigaChat's stored credential is an OAuth "Authorization key", not a Bearer token itself — exchange it for one
  // (see providers/gigachat.ts), and use its CA-pinned fetch since its hosts don't chain to a globally-trusted CA.
  const isGigaChat=input.provider.slug==="gigachat";
  let apiKey=secret??"";
  if(isGigaChat){const tokenResult=await getGigaChatAccessToken(secret??"");if("error" in tokenResult)return{status:tokenResult.httpStatus===401||tokenResult.httpStatus===403?"auth_error":"unavailable",httpStatus:tokenResult.httpStatus,error:tokenResult.error};apiKey=tokenResult.token;}
  const doFetch=isGigaChat?gigachatFetch:fetch;
  try {
    const send=(model:string)=>doFetch(url,{method:"POST",headers:{...(apiKey?{authorization:`Bearer ${apiKey}`}:{}),"content-type":"application/json",...buildExtraHeaders(input.provider!.slug,input.credential?.config??null)},body:JSON.stringify({model,messages:[{role:"user",content:"Reply with exactly: OK"}],max_tokens:128,temperature:0}),signal:AbortSignal.timeout(30_000),cache:"no-store"});
    // Stripping a leading provider prefix is a heuristic ("groq/llama-3" -> "llama-3"), and it is wrong for ids where the
    // prefix is part of the real name (Groq's own "groq/compound"). A model that answers "unknown" only under the stripped id
    // is not proof it is unavailable, so retry once with the id exactly as discovered before recording a failure.
    const stripped=bareCandidateModelRef(input);
    let response=await send(stripped);
    if((response.status===400||response.status===404)&&stripped!==input.modelRef){const retry=await send(input.modelRef);if(retry.ok)response=retry;}
    const body=await response.json().catch(()=>({})) as {error?:{message?:string}|string;message?:string;choices?:Array<{message?:{content?:string}}>};
    const error=typeof body.error==="string"?body.error:body.error?.message??body.message??null;
    if(!response.ok)return{status:classifyProviderFailure(response.status,error),httpStatus:response.status,error};
    // HTTP 200 alone isn't proof the model actually answered — a reasoning model can burn its whole token
    // budget on hidden reasoning and return empty visible content, or a provider can 200 an error envelope.
    // The same bar the live LiteLLM smoke test judges a deployment by (client.ts's smokeTest) applies here too,
    // so "N passes" during discovery reliably predicts it'll also pass once actually added to LiteLLM.
    const content=body.choices?.[0]?.message?.content?.trim()??"";
    if(!content)return{status:"unavailable",httpStatus:response.status,error:"Empty completion"};
    return{status:"available",httpStatus:response.status,error:null};
  } catch(error) { return {status:"unavailable",httpStatus:null,error:error instanceof Error?error.message:"Provider request failed"}; }
}
