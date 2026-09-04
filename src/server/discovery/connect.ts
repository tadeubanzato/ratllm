import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates,providerCredentialReferences,providers } from "@/server/db/schema";
import { decryptCredential } from "@/server/credentials/crypto";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { syncLiteLLM } from "@/server/litellm/sync";

const providerPrefix:Readonly<Record<string,string>>={openrouter:"openrouter",groq:"groq",cerebras:"cerebras",mistral:"mistral",sambanova:"sambanova",cohere:"cohere",nvidia:"nvidia_nim",huggingface:"huggingface",zhipu:"zhipuai",llm7:"openai",opencode:"openai",alibaba:"openai"};
const slug=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80);

export async function connectCandidate(candidateId:string){
  const db=getDb();const candidate=(await db.select().from(modelCandidates).where(eq(modelCandidates.id,candidateId)).limit(1))[0];if(!candidate)throw new Error("Candidate not found");
  const providerSlug=(candidate.source==="openrouter"?"openrouter":(candidate.providerName??candidate.modelRef.split("/",1)[0]??"").toLowerCase().replace(/[^a-z0-9]+/g,"-"));const provider=(await db.select().from(providers).where(eq(providers.slug,providerSlug)).limit(1))[0];if(!provider)throw new Error("Provider is not configured in Curator");
  const credential=(await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId,provider.id)).limit(1))[0];if(!credential)throw new Error("Provider credential is not configured");if(credential.valid!==true)throw new Error("Verify the provider credential before connecting a model");
  const prefix=providerPrefix[providerSlug];if(!prefix)throw new Error("Provider model prefix is not safely configured");const providerModel=candidate.modelRef.includes("/")&&candidate.source!=="openrouter"?candidate.modelRef:`${prefix}/${candidate.modelRef}`;const modelName=`scout-${slug(candidate.modelRef)}`;
  const adapter=new HttpLiteLLMAdapter();const existing=(await adapter.listDeployments()).find(item=>item.model_name===modelName);if(existing)return{status:"already_exists",modelName};
  const encrypted=credential.encryptedValue?decryptCredential(credential.encryptedValue):undefined;const configuredInProcess=process.env[credential.environmentVariable];const apiKey=configuredInProcess?`os.environ/${credential.environmentVariable}`:encrypted;if(!apiKey)throw new Error(`Credential ${credential.environmentVariable} is unavailable to the Curator server`);
  const added=await adapter.addDeployment({modelName,model:providerModel,apiKey,metadata:{managed_by:"okame-model-curator",curator_candidate_id:candidate.id,curator_source:candidate.source,curator_version:"0.1.0"}});const smoke=await adapter.smokeTest(modelName);if(!smoke.ok){if(added.id)await adapter.removeDeployment(added.id);throw new Error(`Model smoke test failed (${smoke.status}): ${smoke.error??"empty response"}`)}await syncLiteLLM();return{status:"connected",modelName,providerModel,smoke:{status:smoke.status,latencyMs:smoke.latencyMs}};
}
