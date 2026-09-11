import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers } from "@/server/db/schema";
import { getProviderPortal } from "@/server/providers/portals";
import { supportsCredentialTest } from "@/server/providers/verify";
import { saveProviderCredential } from "@/server/providers/credentials";

export class ProviderNotFoundError extends Error {}
export class DuplicateProviderError extends Error {}

export interface ProviderSettingsRow {
  id: string; slug: string; name: string; enabled: boolean; credentialState: "MISSING" | "CONFIGURED" | "INVALID" | "UNKNOWN";
  lastValidatedAt: Date | null; environmentVariable: string; testSupported: boolean; portal: {url: string; label: string} | null;
}

export async function listProviderSettings(): Promise<ProviderSettingsRow[]> {
  const db = getDb();
  const [rows, credentials] = await Promise.all([
    db.select().from(providers).orderBy(providers.name),
    db.select().from(providerCredentialReferences),
  ]);
  return rows.map(provider => {
    const refs = credentials.filter(ref => ref.providerId === provider.id && !ref.disabled);
    const available = refs.filter(ref => ref.encryptedValue || process.env[ref.environmentVariable]);
    const latest = refs.map(ref => ref.lastValidatedAt).filter((at): at is Date => Boolean(at)).sort((a, b) => b.getTime() - a.getTime())[0];
    const credentialState = !available.length ? "MISSING" : available.some(ref => ref.valid === true) ? "CONFIGURED" : available.some(ref => ref.valid === false) ? "INVALID" : "UNKNOWN";
    return {
      id: provider.id, slug: provider.slug, name: provider.name, enabled: provider.enabled, credentialState,
      lastValidatedAt: latest ?? null, environmentVariable: refs[0]?.environmentVariable ?? `${provider.slug.toUpperCase().replaceAll("-", "_")}_API_KEY`,
      testSupported: supportsCredentialTest(provider.slug), portal: getProviderPortal(provider.slug),
    };
  });
}

export async function setProviderEnabled(id: string, enabled: boolean) {
  const [row] = await getDb().update(providers).set({enabled, status: enabled ? "ACTIVE" : "DISABLED", updatedAt: new Date()}).where(eq(providers.id, id)).returning({id: providers.id, enabled: providers.enabled});
  if (!row) throw new ProviderNotFoundError("Provider not found");
  return row;
}

/** Some catalog providers (Cloudflare Workers AI's account-scoped endpoint, a self-hosted gateway, etc.) need a
 *  base URL before their models can actually be called — this is the same field resolveVerificationEndpoint and
 *  the promotion flow already check first, before falling back to any hardcoded default for that provider slug. */
export async function setProviderBaseUrl(id: string, baseUrl: string | null) {
  const [row] = await getDb().update(providers).set({baseUrl, updatedAt: new Date()}).where(eq(providers.id, id)).returning({id: providers.id, baseUrl: providers.baseUrl});
  if (!row) throw new ProviderNotFoundError("Provider not found");
  return row;
}

function slugify(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function createCustomProvider(input: {name: string; baseUrl?: string; apiKey?: string}, correlationId: string) {
  const db = getDb();
  const base = slugify(input.name);
  if (!base) throw new DuplicateProviderError("Provider name must contain at least one letter or number");
  let slug = base;
  for (let suffix = 2; (await db.select({id: providers.id}).from(providers).where(eq(providers.slug, slug)).limit(1)).length; suffix++) slug = `${base}-${suffix}`;

  const [provider] = await db.insert(providers).values({
    slug, name: input.name.trim(), adapterKey: input.baseUrl ? "openai-compatible" : "manual",
    adapterCapability: "MANUAL", baseUrl: input.baseUrl?.trim() || null, enabled: true, status: "ACTIVE",
  }).returning();

  const environmentVariable = `${slug.toUpperCase().replaceAll("-", "_")}_API_KEY`;
  if (input.apiKey) await saveProviderCredential(provider.id, {apiKey: input.apiKey, environmentVariable}, correlationId);
  return provider;
}
