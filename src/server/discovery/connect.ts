import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates, providerCredentialReferences, providers } from "@/server/db/schema";
import { resolveProvider } from "@/server/providers/catalog";
import { verifyCandidateDirectly } from "./verify";

/**
 * Compatibility name for the historical endpoint. A candidate check only tests
 * the provider; deploying it into LiteLLM requires a separate routing plan.
 */
export async function connectCandidate(candidateId:string){
  const db=getDb();const candidate=(await db.select().from(modelCandidates).where(eq(modelCandidates.id,candidateId)).limit(1))[0];if(!candidate)throw new Error("Candidate not found");
  const definition=resolveProvider(candidate.source==="openrouter"?"openrouter":candidate.providerName,candidate.modelRef);const provider=definition?(await db.select().from(providers).where(eq(providers.slug,definition.slug)).limit(1))[0]??null:null;const credential=provider?(await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId,provider.id)).limit(1))[0]??null:null;
  const result=await verifyCandidateDirectly({modelRef:candidate.modelRef,source:candidate.source,provider:definition,providerBaseUrl:provider?.baseUrl??null,credential});if(result.status!=="available")throw new Error(result.error??`Candidate verification ${result.status}`);return{status:"verified",candidateId,smoke:{status:result.httpStatus}};
}
