import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, modelDeployments, providerCredentialReferences } from "@/server/db/schema";
import { encryptCredential } from "@/server/credentials/crypto";
import { keyFingerprint } from "@/server/credentials/fingerprint";
import { getDeploymentDetail } from "@/server/deployment-detail";
import { syncLiteLLM } from "@/server/litellm/sync";
import { CURATOR_MANAGED_BY } from "@/lib/constants";

const ENV_VAR = "GROQ_API_KEY";
const KEY_A = "gsk_test_key_A_0123456789abcdefghijklmnop";
const KEY_B = "gsk_test_key_B_zyxwvutsrqponmlkjihgfedcba";

const inventory = (...items: unknown[]) => ({ listDeployments: async () => items }) as never;
const item = (id: string, info: Record<string, unknown> = {}) =>
  ({ model_name: "smart-agent", litellm_params: { model: "groq/llama-3.3-70b-versatile" }, model_info: { id, ...info } });

afterEach(() => { delete process.env[ENV_VAR]; });

/** A deployment plus the provider's stored credential holding `secret`. */
async function seed(info: Record<string, unknown>, secret: string | null = KEY_A) {
  await syncLiteLLM({}, inventory(item("router-1", info)));
  const deployment = (await getDb().select().from(modelDeployments))[0];
  let credentialId: string | null = null;
  if (secret) {
    const [credential] = await getDb().insert(providerCredentialReferences).values({ providerId: deployment.providerId, environmentVariable: ENV_VAR, encryptedValue: encryptCredential(secret) }).returning();
    credentialId = credential.id;
  }
  return { deployment, credentialId };
}
const audit = (providerId: string, at: string) =>
  getDb().insert(auditEvents).values({ actor: "admin", action: "provider.credential.updated", entityType: "provider", entityId: providerId, correlationId: at, createdAt: new Date(at) });
const setCreatedAt = (id: string, at: string) => getDb().update(modelDeployments).set({ createdAt: new Date(at) }).where(eq(modelDeployments.id, id));
const recordedInfo = (credentialId: string, secret: string, source = "database") =>
  ({ managed_by: CURATOR_MANAGED_BY, credential_id: credentialId, credential_env: ENV_VAR, credential_source: source, credential_fingerprint: keyFingerprint(secret) });

describe("deployment API key provenance", () => {
  it("MATCHES when the recorded fingerprint equals the provider's current key", async () => {
    const first = await seed({});
    await getDb().delete(modelDeployments); // re-seed with the recorded fingerprint, pointing at the real credential row
    await syncLiteLLM({}, inventory(item("router-1", recordedInfo(first.credentialId!, KEY_A))));
    const detail = await getDeploymentDetail((await getDb().select().from(modelDeployments))[0].id);
    expect(detail!.credential.status).toBe("matches");
    expect(detail!.credential.recorded).toMatchObject({ envVar: ENV_VAR, source: "database", fingerprint: keyFingerprint(KEY_A) });
    expect(detail!.credential.current).toMatchObject({ envVar: ENV_VAR, source: "database", fingerprint: keyFingerprint(KEY_A) });
  });

  it("reports CHANGED when the provider's key was replaced after the deployment was created", async () => {
    const { credentialId } = await seed({});
    await getDb().delete(modelDeployments);
    await syncLiteLLM({}, inventory(item("router-1", recordedInfo(credentialId!, KEY_A))));
    await getDb().update(providerCredentialReferences).set({ encryptedValue: encryptCredential(KEY_B) }).where(eq(providerCredentialReferences.id, credentialId!)); // rotated
    const detail = await getDeploymentDetail((await getDb().select().from(modelDeployments))[0].id);
    expect(detail!.credential.status).toBe("changed");
    expect(detail!.credential.recorded!.fingerprint).toBe(keyFingerprint(KEY_A));
    expect(detail!.credential.current!.fingerprint).toBe(keyFingerprint(KEY_B));
  });

  it("uses the server environment when it overrides the stored key, and says so", async () => {
    const { credentialId } = await seed({});
    await getDb().delete(modelDeployments);
    await syncLiteLLM({}, inventory(item("router-1", recordedInfo(credentialId!, KEY_A))));
    process.env[ENV_VAR] = KEY_B; // the resolver prefers the environment over the stored value
    const detail = await getDeploymentDetail((await getDb().select().from(modelDeployments))[0].id);
    expect(detail!.credential.current).toMatchObject({ source: "environment", fingerprint: keyFingerprint(KEY_B) });
    expect(detail!.credential.environmentOverride).toBe(true);
    expect(detail!.credential.status).toBe("changed"); // the deployment was created with A; the server now resolves B
  });

  it("is UNKNOWN when the credential it was created with no longer exists", async () => {
    const { credentialId } = await seed({});
    await getDb().delete(modelDeployments);
    await syncLiteLLM({}, inventory(item("router-1", recordedInfo(credentialId!, KEY_A))));
    await getDb().delete(providerCredentialReferences).where(eq(providerCredentialReferences.id, credentialId!));
    const detail = await getDeploymentDetail((await getDb().select().from(modelDeployments))[0].id);
    expect(detail!.credential.status).toBe("unknown");
  });

  it("infers 'current key' for an unrecorded managed deployment when the credential last changed before it appeared", async () => {
    const { deployment } = await seed({ managed_by: CURATOR_MANAGED_BY });
    await audit(deployment.providerId, "2026-09-04T03:52:00Z");
    await setCreatedAt(deployment.id, "2026-09-13T09:11:00Z");
    const detail = await getDeploymentDetail(deployment.id);
    expect(detail!.credential.status).toBe("inferred_current");
    expect(detail!.credential.recorded).toBeNull();
    expect(detail!.credential.lastChangedAt!.toISOString()).toBe("2026-09-04T03:52:00.000Z");
  });

  it("infers 'may hold an older key' when the credential changed after the deployment appeared", async () => {
    const { deployment } = await seed({ managed_by: CURATOR_MANAGED_BY });
    await setCreatedAt(deployment.id, "2026-09-13T09:11:00Z");
    await audit(deployment.providerId, "2026-09-15T00:00:00Z");
    expect((await getDeploymentDetail(deployment.id))!.credential.status).toBe("inferred_stale");
  });

  it("says the key is unknown for a deployment added outside RatLLM", async () => {
    const { deployment } = await seed({}); // no managed_by
    expect((await getDeploymentDetail(deployment.id))!.credential.status).toBe("external");
  });

  it("never returns a secret anywhere in what the page receives", async () => {
    const { credentialId } = await seed({});
    await getDb().delete(modelDeployments);
    await syncLiteLLM({}, inventory(item("router-1", recordedInfo(credentialId!, KEY_A))));
    process.env[ENV_VAR] = KEY_B;
    const detail = await getDeploymentDetail((await getDb().select().from(modelDeployments))[0].id);
    const everything = JSON.stringify(detail);
    for (const secret of [KEY_A, KEY_B, encryptCredential(KEY_A).split(".")[3]]) expect(everything).not.toContain(secret);
    expect(everything).toContain(keyFingerprint(KEY_B)); // only the fingerprint is present
  });

  it("survives the metadata round trip: provenance fields are not stripped by the sanitizer", async () => {
    const { credentialId } = await seed({});
    await getDb().delete(modelDeployments);
    await syncLiteLLM({}, inventory(item("router-1", recordedInfo(credentialId!, KEY_A))));
    const stored = (await getDb().select().from(modelDeployments))[0].rawMetadata as { model_info: Record<string, unknown> };
    expect(stored.model_info).toMatchObject({ credential_id: credentialId, credential_env: ENV_VAR, credential_source: "database", credential_fingerprint: keyFingerprint(KEY_A) });
  });
});
