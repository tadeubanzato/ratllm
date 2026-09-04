import "server-only";
import { decryptCredential } from "@/server/credentials/crypto";
import type { ProviderDefinition } from "@/server/providers/catalog";

export type CandidateVerificationStatus = "available" | "rate_limited" | "unavailable" | "auth_error" | "credential_missing" | "credential_unverified" | "provider_unresolved" | "provider_not_configured";
export interface CandidateVerificationResult { status: CandidateVerificationStatus; httpStatus: number | null; error: string | null; }
export interface CandidateVerificationInput { modelRef: string; source: string; provider: ProviderDefinition | null; providerBaseUrl: string | null; credential?: { environmentVariable: string; encryptedValue: string | null; valid: boolean | null } | null; }

const knownEndpoints: Readonly<Record<string, string>> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions", groq: "https://api.groq.com/openai/v1/chat/completions", cerebras: "https://api.cerebras.ai/v1/chat/completions", mistral: "https://api.mistral.ai/v1/chat/completions", sambanova: "https://api.sambanova.ai/v1/chat/completions", "together-ai": "https://api.together.xyz/v1/chat/completions", nvidia: "https://integrate.api.nvidia.com/v1/chat/completions", zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions", "alibaba-model-studio": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
};

function endpoint(provider: ProviderDefinition, baseUrl: string | null) { return baseUrl ? `${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions` : knownEndpoints[provider.slug] ?? null; }
function modelRef(input: CandidateVerificationInput) { if (input.source === "openrouter") return input.modelRef; const segment=input.modelRef.split("/",1)[0]?.toLowerCase(); const prefixes=new Set([input.provider?.slug,"mistral","groq","cerebras","sambanova","together_ai","together-ai","zai","zhipuai","gemini"]); return segment&&prefixes.has(segment)?input.modelRef.slice(segment.length+1):input.modelRef; }

/** Verifies the provider directly. It never adds a LiteLLM deployment. */
export async function verifyCandidateDirectly(input: CandidateVerificationInput): Promise<CandidateVerificationResult> {
  if (!input.provider) return { status: "provider_unresolved", httpStatus: null, error: "No provider could be resolved from this discovery record" };
  if (!input.credential) return { status: "credential_missing", httpStatus: null, error: `Add a credential for ${input.provider.name}` };
  if (input.credential.valid !== true) return { status: "credential_unverified", httpStatus: null, error: `Verify ${input.provider.name} credential before testing candidates` };
  const url=endpoint(input.provider,input.providerBaseUrl); if (!url) return { status: "provider_not_configured", httpStatus: null, error: `${input.provider.name} has no automated verification endpoint configured` };
  let apiKey=process.env[input.credential.environmentVariable];
  if (!apiKey&&input.credential.encryptedValue) { try { apiKey=decryptCredential(input.credential.encryptedValue); } catch { return { status:"credential_unverified",httpStatus:null,error:`Stored ${input.provider.name} credential could not be read by the verifier` }; } }
  if (!apiKey) return { status:"credential_missing",httpStatus:null,error:`Credential ${input.credential.environmentVariable} is not available to the verifier` };
  try { const response=await fetch(url,{method:"POST",headers:{authorization:`Bearer ${apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:modelRef(input),messages:[{role:"user",content:"Reply with OK"}],max_tokens:4,temperature:0}),signal:AbortSignal.timeout(30_000),cache:"no-store"}); const body=await response.json().catch(()=>({})) as {error?:{message?:string}|string;message?:string}; const error=typeof body.error==="string"?body.error:body.error?.message??body.message??null; if(response.ok)return{status:"available",httpStatus:response.status,error:null}; if(response.status===429)return{status:"rate_limited",httpStatus:response.status,error}; if(response.status===401||response.status===403)return{status:"auth_error",httpStatus:response.status,error}; return{status:"unavailable",httpStatus:response.status,error}; } catch(error) { return {status:"unavailable",httpStatus:null,error:error instanceof Error?error.message:"Provider request failed"}; }
}
