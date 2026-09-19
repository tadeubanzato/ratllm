import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers, systemSettings } from "@/server/db/schema";
import { decryptCredential, describeEnvelope, encryptCredential } from "@/server/credentials/crypto";
import { rotateCredentials } from "@/server/credentials/rotate";

const NEW_KEY = "rotation-new-key-0123456789abcdefghijklmnopqrs";
const STRANGER = "a-key-nobody-configured-0123456789abcdefghij";
const SECRETS = { A: "provider-secret-A-0123456789", B: "provider-secret-B-0123456789", C: "provider-secret-C-0123456789", MASTER: "litellm-master-0123456789" };

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });
const useKeyring = (keys: string, active?: string) => { process.env.CREDENTIAL_ENCRYPTION_KEYS = keys; if (active) process.env.CREDENTIAL_ENCRYPTION_KEY_ID = active; };

/** Stored values written under the ORIGINAL single key (the v1 format), as every deployment has today. */
async function seedLegacy() {
  const db = getDb();
  const [provider] = await db.insert(providers).values({ slug: "acme", name: "Acme", adapterKey: "manual", adapterCapability: "MANUAL" }).returning();
  await db.insert(providerCredentialReferences).values(["A", "B", "C"].map(name => ({ providerId: provider.id, environmentVariable: `${name}_API_KEY`, encryptedValue: encryptCredential(SECRETS[name as "A" | "B" | "C"]) })));
  await db.insert(systemSettings).values({ key: "litellm.config", value: { baseUrl: "http://x", encryptedMasterKey: encryptCredential(SECRETS.MASTER), status: "HEALTHY" } });
}
const stored = async () => (await getDb().select().from(providerCredentialReferences)).map(row => ({ env: row.environmentVariable, value: row.encryptedValue! })).sort((a, b) => a.env.localeCompare(b.env));
const master = async () => ((await getDb().select().from(systemSettings).where(eq(systemSettings.key, "litellm.config")))[0].value as { encryptedMasterKey: string }).encryptedMasterKey;

describe("credential rotation", () => {
  it("refuses to run without a keyring — there is nothing to rotate to", async () => {
    await seedLegacy();
    await expect(rotateCredentials({ apply: true })).rejects.toThrow(/No keyring is configured/);
  });

  it("a dry run reports what would change and writes nothing", async () => {
    await seedLegacy();
    const before = await stored();
    useKeyring(`k2:${NEW_KEY}`, "k2");
    const report = await rotateCredentials({ apply: false });
    expect(report).toMatchObject({ applied: false, targetKeyId: "k2", total: 4, rotated: 4, alreadyCurrent: 0, before: { v1: 4 } });
    expect(await stored()).toEqual(before);            // untouched
    expect(describeEnvelope(await master()).version).toBe("v1");
  });

  it("re-encrypts everything under the new key, keeps every value readable, and reaches the LiteLLM master key too", async () => {
    await seedLegacy();
    useKeyring(`k2:${NEW_KEY}`, "k2");
    const report = await rotateCredentials({ apply: true });
    expect(report).toMatchObject({ applied: true, rotated: 4, unreadable: [] });
    for (const row of await stored()) expect(describeEnvelope(row.value)).toEqual({ version: "v2", keyId: "k2" });
    expect(describeEnvelope(await master())).toEqual({ version: "v2", keyId: "k2" });
    // Same secrets come back out.
    const byEnv = Object.fromEntries((await stored()).map(row => [row.env, decryptCredential(row.value)]));
    expect(byEnv).toEqual({ A_API_KEY: SECRETS.A, B_API_KEY: SECRETS.B, C_API_KEY: SECRETS.C });
    expect(decryptCredential(await master())).toBe(SECRETS.MASTER);
  });

  it("is safe to run twice: the second run finds nothing to do", async () => {
    await seedLegacy();
    useKeyring(`k2:${NEW_KEY}`, "k2");
    await rotateCredentials({ apply: true });
    const after = await stored();
    const again = await rotateCredentials({ apply: true });
    expect(again).toMatchObject({ rotated: 0, alreadyCurrent: 4, before: { k2: 4 } });
    expect(await stored()).toEqual(after);              // byte-for-byte unchanged, not re-encrypted needlessly
  });

  it("lets the old key be retired afterwards: everything still decrypts with only the new key configured", async () => {
    await seedLegacy();
    useKeyring(`k2:${NEW_KEY}`, "k2");
    await rotateCredentials({ apply: true });
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;       // the old key is gone for good
    for (const row of await stored()) expect(() => decryptCredential(row.value)).not.toThrow();
    expect(decryptCredential(await master())).toBe(SECRETS.MASTER);
  });

  it("leaves a value that no configured key can read exactly as it was, reports it, and still rotates the rest", async () => {
    await seedLegacy();
    // A value encrypted under a key that is not configured any more.
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = STRANGER;
    const orphan = encryptCredential("orphaned-secret-0123456789");
    process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    const [provider] = await getDb().select().from(providers);
    await getDb().insert(providerCredentialReferences).values({ providerId: provider.id, environmentVariable: "ORPHAN_API_KEY", encryptedValue: orphan });

    useKeyring(`k2:${NEW_KEY}`, "k2");
    const report = await rotateCredentials({ apply: true });
    expect(report.rotated).toBe(4);
    expect(report.unreadable).toHaveLength(1);
    expect(report.unreadable[0].where).toBe("provider credential ORPHAN_API_KEY");
    const row = (await stored()).find(entry => entry.env === "ORPHAN_API_KEY")!;
    expect(row.value).toBe(orphan);                     // never overwritten
  });

  it("never puts a secret in the report", async () => {
    await seedLegacy();
    useKeyring(`k2:${NEW_KEY}`, "k2");
    const text = JSON.stringify(await rotateCredentials({ apply: true }));
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toContain(NEW_KEY);
  });
});
