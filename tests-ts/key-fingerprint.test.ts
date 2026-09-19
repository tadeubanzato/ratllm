import { describe, expect, it } from "vitest";
import { credentialProvenance, keyFingerprint } from "../src/server/credentials/fingerprint";
import { findDuplicateGroups } from "../src/server/litellm/duplicates";

const SECRET = "fake-credential-for-tests-0123456789abcdefghij"; // deliberately not key-shaped

describe("keyFingerprint", () => {
  it("is deterministic, and different for different keys", () => {
    expect(keyFingerprint(SECRET)).toBe(keyFingerprint(SECRET));
    expect(keyFingerprint(SECRET)).not.toBe(keyFingerprint(`${SECRET}x`));
    expect(keyFingerprint("a")).not.toBe(keyFingerprint("b"));
  });

  it("is a short hex string that reveals nothing of the key", () => {
    const fingerprint = keyFingerprint(SECRET);
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(SECRET).not.toContain(fingerprint);
    // Not derived from the key's own characters (a first/last-N hint would leak part of it).
    expect(fingerprint).not.toContain(SECRET.slice(0, 4));
    expect(fingerprint).not.toContain(SECRET.slice(-4));
  });
});

describe("credentialProvenance", () => {
  const credential = { id: "11111111-1111-4111-8111-111111111111", environmentVariable: "GOOGLE_AI_STUDIO_API_KEY" };

  it("records which credential, its source, and a fingerprint — and never the secret", () => {
    const meta = credentialProvenance(credential, { secret: SECRET, source: "database" });
    expect(meta).toEqual({ ratllm_credential_id: credential.id, ratllm_credential_env: "GOOGLE_AI_STUDIO_API_KEY", ratllm_credential_source: "database", ratllm_credential_fingerprint: keyFingerprint(SECRET) });
    expect(JSON.stringify(meta)).not.toContain(SECRET);
  });

  it("uses field names the router-metadata sanitizer will not strip", () => {
    const forbidden = /key|secret|token|authorization|password/i; // the sanitizer's rule in litellm/classify.ts
    for (const name of Object.keys(credentialProvenance(credential, { secret: SECRET, source: "environment" }))) expect(name).not.toMatch(forbidden);
  });
});

describe("findDuplicateGroups with key fingerprints", () => {
  const dep = (id: string, fingerprint?: string | null) => ({ id, litellmModelName: "smart-vision", providerName: "Google AI Studio", providerModelId: "openai/gemma", apiBase: "https://g.example/v1", litellmDeploymentId: `r-${id}`, credentialFingerprint: fingerprint });

  it("groups copies made with the same key", () => {
    expect(findDuplicateGroups([dep("a", "aaaa"), dep("b", "aaaa")])).toHaveLength(1);
  });

  it("does NOT flag copies made with different keys — they have separate quotas", () => {
    expect(findDuplicateGroups([dep("a", "aaaa"), dep("b", "bbbb")])).toEqual([]);
  });

  it("groups copies whose key isn't recorded, as before", () => {
    expect(findDuplicateGroups([dep("a"), dep("b", null)])).toHaveLength(1);
  });

  it("won't assume an unrecorded copy shares a key with a recorded one", () => {
    expect(findDuplicateGroups([dep("a", "aaaa"), dep("b")])).toEqual([]);
  });
  it("says the key is known only when a fingerprint is recorded, so the UI never claims a shared quota it can't prove", () => {
    expect(findDuplicateGroups([dep("a", "aaaa"), dep("b", "aaaa")])[0].keyKnown).toBe(true);
    expect(findDuplicateGroups([dep("a"), dep("b", null)])[0].keyKnown).toBe(false);
  });
});
