import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers } from "@/server/db/schema";
import { encryptCredential } from "@/server/credentials/crypto";
import { getProvider } from "@/server/queries";

const LEGACY_HINT = "sk-••••w0O"; // first three + last three characters of a key, as older versions stored them
const migration = readFileSync("drizzle/0013_clear_partial_key_hints.sql", "utf8");

async function provider(slug: string) {
  return (await getDb().insert(providers).values({ slug, name: slug, adapterKey: "manual", adapterCapability: "MANUAL" }).returning())[0];
}

describe("partial key hints", () => {
  it("are never sent to the provider page, even when the database still holds a legacy one", async () => {
    const p = await provider("acme");
    await getDb().insert(providerCredentialReferences).values({ providerId: p.id, environmentVariable: "ACME_API_KEY", encryptedValue: encryptCredential("fake-credential-for-tests-0123456789"), valueHint: LEGACY_HINT });
    const data = await getProvider(p.id);
    const everything = JSON.stringify(data);
    expect(everything).not.toContain("••••");
    expect(everything).not.toContain(LEGACY_HINT);
    expect(everything).not.toContain("valueHint");
    expect(data!.credentials[0]).toMatchObject({ environmentVariable: "ACME_API_KEY", stored: true });
  });

  it("reports a credential with no stored value as not stored", async () => {
    const p = await provider("acme");
    await getDb().insert(providerCredentialReferences).values({ providerId: p.id, environmentVariable: "ACME_API_KEY" });
    expect((await getProvider(p.id))!.credentials[0].stored).toBe(false);
  });
});

describe("migration 0013 (clear legacy hints)", () => {
  const hints = async () => (await getDb().select({ env: providerCredentialReferences.environmentVariable, hint: providerCredentialReferences.valueHint }).from(providerCredentialReferences)).sort((a, b) => a.env.localeCompare(b.env));

  it("replaces every legacy hint with the neutral label, leaves other rows alone, and is idempotent", async () => {
    const p = await provider("acme");
    await getDb().insert(providerCredentialReferences).values([
      { providerId: p.id, environmentVariable: "A_LEGACY", valueHint: LEGACY_HINT },
      { providerId: p.id, environmentVariable: "B_LEGACY", valueHint: "AQ.••••kHQ" },
      { providerId: p.id, environmentVariable: "C_CURRENT", valueHint: "Configured" },
      { providerId: p.id, environmentVariable: "D_ENV_ONLY", valueHint: null },
    ]);
    await getDb().execute(sql.raw(migration));
    expect(await hints()).toEqual([{ env: "A_LEGACY", hint: "Configured" }, { env: "B_LEGACY", hint: "Configured" }, { env: "C_CURRENT", hint: "Configured" }, { env: "D_ENV_ONLY", hint: null }]);
    await getDb().execute(sql.raw(migration)); // running it again changes nothing
    expect((await hints()).map(row => row.hint)).toEqual(["Configured", "Configured", "Configured", null]);
  });
});
