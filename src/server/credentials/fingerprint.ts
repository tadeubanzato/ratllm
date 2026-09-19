import { createHash } from "node:crypto";

/**
 * A non-secret, comparable identity for an API key: two keys have the same fingerprint only if they are the same key, and
 * the fingerprint can't be turned back into the key. It is a domain-separated SHA-256 prefix of the whole secret — not the
 * first/last characters, which would leak part of it. Used to record which key a deployment was created with, so
 * "do these deployments share a rate limit?" and "did this key rotate since?" can be answered without ever reading a key.
 *
 * 12 hex characters (48 bits) is plenty to tell a handful of keys apart; API keys are high-entropy, so a 48-bit prefix of
 * their hash gives an attacker nothing to search against.
 */
export function keyFingerprint(secret: string): string {
  return createHash("sha256").update(`ratllm-key-fingerprint:v1:${secret}`).digest("hex").slice(0, 12);
}

export type CredentialSource = "environment" | "database";

/**
 * The provenance fields written into a deployment's router metadata when RatLLM adds it. Field names deliberately avoid the
 * words key/secret/token/password, which the metadata sanitizer strips, so these survive the round trip through LiteLLM.
 *
 * They are prefixed `ratllm_` because that metadata is shared: other tools that add models to the same LiteLLM write their own
 * fields into it, and a production LiteLLM already carried a foreign `credential_fingerprint` (a different algorithm) on 58
 * deployments. Un-prefixed names made RatLLM read that value as its own and report a false "key changed" alarm.
 * Contains no secret: only which credential row, which env var name, where the value came from, and its fingerprint.
 */
export function credentialProvenance(credential: { id: string; environmentVariable: string }, resolved: { secret: string; source: CredentialSource }) {
  return {
    ratllm_credential_id: credential.id,
    ratllm_credential_env: credential.environmentVariable,
    ratllm_credential_source: resolved.source,
    ratllm_credential_fingerprint: keyFingerprint(resolved.secret),
  };
}
