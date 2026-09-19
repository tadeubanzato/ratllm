import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, systemSettings } from "@/server/db/schema";
import { activeKeyId, decryptCredential, describeEnvelope, encryptCredential } from "./crypto";

export interface RotationReport {
  applied: boolean;
  targetKeyId: string;
  total: number;
  alreadyCurrent: number;
  rotated: number;
  /** Values no configured key can read. They are left exactly as they are. */
  unreadable: { where: string; reason: string }[];
  /** How many values are stored under each key id, before this run ("v1" = the original single key). */
  before: Record<string, number>;
}

const labelOf = (value: string) => { const { version, keyId } = describeEnvelope(value); return version === "v2" ? keyId! : version; };

/**
 * Re-encrypts every stored credential with the active key, so the old key can be retired. Dry run unless `apply`.
 *
 * Each value is decrypted, encrypted with the active key, and decrypted AGAIN to prove the new ciphertext round-trips before it
 * replaces the old one. A value that cannot be read is reported and left untouched, never overwritten. Plaintext never leaves
 * this function: the report holds only counts, key ids and locations.
 */
export async function rotateCredentials(options: { apply: boolean }): Promise<RotationReport> {
  const target = activeKeyId();
  if (!target) throw new Error("No keyring is configured: set CREDENTIAL_ENCRYPTION_KEYS (and optionally CREDENTIAL_ENCRYPTION_KEY_ID) before rotating.");
  const db = getDb();
  const report: RotationReport = { applied: options.apply, targetKeyId: target, total: 0, alreadyCurrent: 0, rotated: 0, unreadable: [], before: {} };

  const reencrypt = (where: string, stored: string): string | null => {
    report.total += 1;
    const label = labelOf(stored);
    report.before[label] = (report.before[label] ?? 0) + 1;
    if (label === target) { report.alreadyCurrent += 1; return null; }
    let plaintext: string;
    try { plaintext = decryptCredential(stored); }
    catch (error) { report.unreadable.push({ where, reason: error instanceof Error ? error.message : "unreadable" }); return null; }
    const next = encryptCredential(plaintext);
    if (decryptCredential(next) !== plaintext) { report.unreadable.push({ where, reason: "re-encrypted value failed its round-trip check" }); return null; }
    return next;
  };

  const credentials = await db.select({ id: providerCredentialReferences.id, env: providerCredentialReferences.environmentVariable, value: providerCredentialReferences.encryptedValue })
    .from(providerCredentialReferences).where(isNotNull(providerCredentialReferences.encryptedValue));
  for (const row of credentials) {
    const next = reencrypt(`provider credential ${row.env}`, row.value!);
    if (next === null) continue;
    report.rotated += 1;
    if (options.apply) await db.update(providerCredentialReferences).set({ encryptedValue: next, updatedAt: new Date() }).where(eq(providerCredentialReferences.id, row.id));
  }

  // LiteLLM's master key is stored inside the `litellm.config` settings document.
  const settings = await db.select().from(systemSettings).where(and(eq(systemSettings.key, "litellm.config"), sql`${systemSettings.value} ? 'encryptedMasterKey'`));
  for (const row of settings) {
    const value = row.value as Record<string, unknown>;
    if (typeof value.encryptedMasterKey !== "string") continue;
    const next = reencrypt("LiteLLM master key", value.encryptedMasterKey);
    if (next === null) continue;
    report.rotated += 1;
    if (options.apply) await db.update(systemSettings).set({ value: { ...value, encryptedMasterKey: next }, updatedAt: new Date() }).where(eq(systemSettings.key, row.key));
  }
  return report;
}
