import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/server/config", () => ({ env: { CREDENTIAL_ENCRYPTION_KEY: "test-encryption-key-at-least-32-characters" } }));

const state = vi.hoisted(() => ({ existingConfig: {} as Record<string, string>, inserted: [] as Array<{ table: string; row: unknown }> }));

vi.mock("@/server/db/schema", () => ({ providers: "providers", providerCredentialReferences: "providerCredentialReferences", auditEvents: "auditEvents" }));
vi.mock("@/server/db/client", () => ({
  getDb: () => ({
    select: (fields?: unknown) => ({
      from: (table: string) => ({
        where: () => ({
          limit: async () => (table === "providers" ? [{ id: "provider-1" }] : [{ config: state.existingConfig }]),
        }),
      }),
    }),
    insert: (table: string) => ({
      values: (row: unknown) => {
        state.inserted.push({ table, row });
        return { onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => { state.inserted.push({ table, row: set }); } };
      },
    }),
  }),
}));

import { saveProviderCredential } from "../src/server/providers/credentials";
import { decryptCredential } from "../src/server/credentials/crypto";

afterEach(() => { state.existingConfig = {}; state.inserted = []; });

describe("saveProviderCredential", () => {
  it("trims a pasted key with surrounding whitespace before encrypting it", async () => {
    await saveProviderCredential("provider-1", { apiKey: "  sk-real-key\n", environmentVariable: "FOO_API_KEY" }, "corr-1");
    const credentialWrite = state.inserted.find((entry) => entry.table === "providerCredentialReferences");
    const encrypted = (credentialWrite?.row as { encryptedValue: string }).encryptedValue;
    expect(decryptCredential(encrypted)).toBe("sk-real-key");
  });

  it("treats a whitespace-only key the same as no key", async () => {
    await expect(saveProviderCredential("provider-1", { apiKey: "   ", environmentVariable: "MISSING_ENV_VAR" }, "corr-1"))
      .rejects.toThrow("That environment reference is not available to the server");
  });
});
