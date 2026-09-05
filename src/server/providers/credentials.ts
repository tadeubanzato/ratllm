import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, providerCredentialReferences, providers } from "@/server/db/schema";
import { encryptCredential } from "@/server/credentials/crypto";

export class ProviderNotFoundError extends Error {}
export class CredentialNotFoundError extends Error {}
export class EnvironmentCredentialMissingError extends Error {}

export async function saveProviderCredential(providerId: string, input: {apiKey?: string; environmentVariable: string}, correlationId: string) {
  const db = getDb();
  const provider = (await db.select().from(providers).where(eq(providers.id, providerId)).limit(1))[0];
  if (!provider) throw new ProviderNotFoundError("Provider not found");
  if (!input.apiKey && !process.env[input.environmentVariable]) throw new EnvironmentCredentialMissingError("That environment reference is not available to the server");
  const encryptedValue = input.apiKey ? encryptCredential(input.apiKey) : null;
  await db.insert(providerCredentialReferences)
    .values({providerId, environmentVariable: input.environmentVariable, encryptedValue, valueHint: "Configured"})
    .onConflictDoUpdate({target: [providerCredentialReferences.providerId, providerCredentialReferences.environmentVariable], set: {encryptedValue, valueHint: "Configured", valid: null, disabled: false, lastValidatedAt: null, updatedAt: new Date()}});
  await db.insert(auditEvents).values({actor: "admin", action: "provider.credential.updated", entityType: "provider", entityId: providerId, after: {environmentVariable: input.environmentVariable, configured: true}, correlationId});
  return {configured: true, hint: "Configured"};
}

export async function setProviderCredentialDisabled(providerId: string, environmentVariable: string, disabled: boolean) {
  const [row] = await getDb().update(providerCredentialReferences).set({disabled, updatedAt: new Date()})
    .where(and(eq(providerCredentialReferences.providerId, providerId), eq(providerCredentialReferences.environmentVariable, environmentVariable)))
    .returning({environmentVariable: providerCredentialReferences.environmentVariable, disabled: providerCredentialReferences.disabled});
  if (!row) throw new CredentialNotFoundError("Credential not found");
  return row;
}

export async function deleteProviderCredential(providerId: string, environmentVariable: string) {
  await getDb().delete(providerCredentialReferences)
    .where(and(eq(providerCredentialReferences.providerId, providerId), eq(providerCredentialReferences.environmentVariable, environmentVariable)));
}
