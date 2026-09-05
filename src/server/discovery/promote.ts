import "server-only";
import { eq } from "drizzle-orm";
import { CURATOR_MANAGED_BY, CURATOR_VERSION } from "@/lib/constants";
import { getDb } from "@/server/db/client";
import { modelCandidates, modelDeployments, providerCredentialReferences, providers } from "@/server/db/schema";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { syncLiteLLM } from "@/server/litellm/sync";
import { resolveProvider } from "@/server/providers/catalog";
import { matchDeployment } from "./model-key";
import { bareCandidateModelRef, resolveCredentialSecret, resolveVerificationEndpoint } from "./verify";

/**
 * Adds a discovered, verified-free candidate to LiteLLM as a live deployment.
 * Reuses the exact endpoint/credential path the automated verifier already
 * proved reachable — if a candidate can't be verified, it can't be promoted
 * either, since there is no other route this app knows to call it by.
 */
export async function promoteCandidateToLiteLLM(candidateId: string) {
  const db = getDb();
  const candidate = (await db.select().from(modelCandidates).where(eq(modelCandidates.id, candidateId)).limit(1))[0];
  if (!candidate) throw new Error("Candidate not found");

  const definition = resolveProvider(candidate.source === "openrouter" ? "openrouter" : candidate.providerName, candidate.modelRef);
  if (!definition) throw new Error("Could not resolve a known provider for this candidate");
  const providerRow = (await db.select().from(providers).where(eq(providers.slug, definition.slug)).limit(1))[0];
  if (!providerRow) throw new Error(`${definition.name} is not registered yet — run discovery or test this candidate first`);

  const existingDeployments = await db.select({id: modelDeployments.id, providerId: modelDeployments.providerId, providerModelId: modelDeployments.providerModelId, health: modelDeployments.health}).from(modelDeployments).where(eq(modelDeployments.providerId, providerRow.id));
  const already = matchDeployment(existingDeployments, providerRow.id, candidate.modelRef);
  if (already) return {status: "already_exists" as const, deploymentId: already.id};

  const credential = (await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, providerRow.id)).limit(1))[0];
  if (!credential) throw new Error(`Add a credential for ${definition.name} first`);
  if (credential.valid !== true) throw new Error(`Verify the ${definition.name} credential before adding models to LiteLLM`);
  const chatUrl = resolveVerificationEndpoint(definition, providerRow.baseUrl);
  if (!chatUrl) throw new Error(`${definition.name} has no known OpenAI-compatible endpoint configured yet, so this app can't tell LiteLLM how to reach it`);
  const apiKey = resolveCredentialSecret(credential);
  if (!apiKey) throw new Error(`Credential ${credential.environmentVariable} is not available to the server`);

  const bareModel = bareCandidateModelRef({modelRef: candidate.modelRef, source: candidate.source, provider: definition, providerBaseUrl: providerRow.baseUrl});
  const apiBase = chatUrl.replace(/\/chat\/completions$/, "");
  const modelName = `${definition.slug}/${bareModel}`;
  const adapter = new HttpLiteLLMAdapter();
  const added = await adapter.addDeployment({
    modelName,
    model: `openai/${bareModel}`,
    apiKey,
    apiBase,
    metadata: {managed_by: CURATOR_MANAGED_BY, curator_version: CURATOR_VERSION, source_provider: definition.name, source_model: candidate.modelRef, source_candidate_id: candidate.id, free_type: candidate.freeType},
  });
  await syncLiteLLM({dryRun: false});
  return {status: "added" as const, litellmModel: modelName, deploymentId: added.id ?? null};
}
