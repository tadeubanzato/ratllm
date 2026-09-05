import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers } from "@/server/db/schema";
import { supportsCredentialTest } from "@/server/providers/verify";

export class ProviderNotFoundError extends Error {}

export interface ProviderSettingsRow {
  id: string; slug: string; name: string; enabled: boolean; credentialState: "MISSING" | "CONFIGURED" | "INVALID" | "UNKNOWN";
  lastValidatedAt: Date | null; environmentVariable: string; testSupported: boolean;
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
      testSupported: supportsCredentialTest(provider.slug),
    };
  });
}

export async function setProviderEnabled(id: string, enabled: boolean) {
  const [row] = await getDb().update(providers).set({enabled, status: enabled ? "ACTIVE" : "DISABLED", updatedAt: new Date()}).where(eq(providers.id, id)).returning({id: providers.id, enabled: providers.enabled});
  if (!row) throw new ProviderNotFoundError("Provider not found");
  return row;
}
