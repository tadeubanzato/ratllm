import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, providerCredentialReferences, providers } from "@/server/db/schema";
import { encryptCredential } from "@/server/credentials/crypto";

export class ProviderNotFoundError extends Error {}
export class CredentialNotFoundError extends Error {}
export class EnvironmentCredentialMissingError extends Error {}

export async function saveProviderCredential(providerId: string, input: {apiKey?: string; environmentVariable: string; config?: Record<string, string>}, correlationId: string) {
  const db = getDb();
  const provider = (await db.select().from(providers).where(eq(providers.id, providerId)).limit(1))[0];
  if (!provider) throw new ProviderNotFoundError("Provider not found");
  // Trim before storing: a copy-pasted key with a trailing newline/space encrypts and stores fine, then fails
  // every auth check forever with no visible difference from a genuinely wrong key.
  const apiKey = input.apiKey?.trim() || undefined;
  if (!apiKey && !process.env[input.environmentVariable]) throw new EnvironmentCredentialMissingError("That environment reference is not available to the server");
  const encryptedValue = apiKey ? encryptCredential(apiKey) : null;
  // Extra config (e.g. a workspace ID) is merged onto whatever's already stored rather than replaced outright —
  // rotating just the API key shouldn't silently wipe out a previously-set workspace ID the user isn't re-typing.
  const existing = (await db.select({config: providerCredentialReferences.config}).from(providerCredentialReferences).where(and(eq(providerCredentialReferences.providerId, providerId), eq(providerCredentialReferences.environmentVariable, input.environmentVariable))).limit(1))[0];
  const config = {...(existing?.config ?? {}), ...(input.config ?? {})};
  await db.insert(providerCredentialReferences)
    .values({providerId, environmentVariable: input.environmentVariable, encryptedValue, valueHint: "Configured", config})
    .onConflictDoUpdate({target: [providerCredentialReferences.providerId, providerCredentialReferences.environmentVariable], set: {encryptedValue, valueHint: "Configured", config, valid: null, disabled: false, lastValidatedAt: null, updatedAt: new Date()}});
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
