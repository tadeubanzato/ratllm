import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Credential encryption at rest (AES-256-GCM) with a KEYRING, so the encryption key can be rotated without making every stored
 * credential unreadable.
 *
 * Configuration (all read from the environment when used, so a restart picks up changes):
 *   CREDENTIAL_ENCRYPTION_KEY      the original single key. Still works on its own, exactly as before.
 *   CREDENTIAL_ENCRYPTION_KEYS     optional keyring: comma-separated `id:secret` entries, e.g. `2026-09:<32+ chars>,legacy:<old key>`.
 *   CREDENTIAL_ENCRYPTION_KEY_ID   which keyring entry encrypts NEW values (default: the first entry).
 *
 * Formats:
 *   v1.<iv>.<tag>.<ciphertext>        written when only CREDENTIAL_ENCRYPTION_KEY is configured. Has no key id, so decryption tries
 *                                     the original key and then every keyring key.
 *   v2.<keyId>.<iv>.<tag>.<ciphertext> written once a keyring is configured; names the key that encrypted it.
 *
 * Rotation: add the new key to the keyring and make it active, keep the old key in the keyring, run `pnpm credentials:rotate` to
 * re-encrypt everything, and only then remove the old key. See docs/SECURITY.md.
 */

const KEY_ID = /^[A-Za-z0-9._-]{1,32}$/;
const MIN_SECRET_LENGTH = 32;

const derive = (secret: string) => createHash("sha256").update(secret).digest();

interface Keyring { keys: Map<string, Buffer>; legacy: Buffer | null; activeId: string | null }

/** Parses and validates the configured keys. Throws a clear message for a malformed keyring rather than silently ignoring it. */
export function loadKeyring(source: NodeJS.ProcessEnv = process.env): Keyring {
  const keys = new Map<string, Buffer>();
  const raw = source.CREDENTIAL_ENCRYPTION_KEYS?.trim();
  if (raw) {
    for (const entry of raw.split(",").map(part => part.trim()).filter(Boolean)) {
      const split = entry.indexOf(":");
      const id = split > 0 ? entry.slice(0, split).trim() : "";
      const secret = split > 0 ? entry.slice(split + 1) : "";
      if (!KEY_ID.test(id)) throw new Error("CREDENTIAL_ENCRYPTION_KEYS: each entry must look like id:secret, where id is 1-32 letters, digits, '.', '_' or '-'");
      if (secret.length < MIN_SECRET_LENGTH) throw new Error(`CREDENTIAL_ENCRYPTION_KEYS: the key "${id}" must be at least ${MIN_SECRET_LENGTH} characters`);
      if (keys.has(id)) throw new Error(`CREDENTIAL_ENCRYPTION_KEYS: the key id "${id}" appears twice`);
      keys.set(id, derive(secret));
    }
  }
  const legacySecret = source.CREDENTIAL_ENCRYPTION_KEY;
  const legacy = legacySecret ? derive(legacySecret) : null;
  const requested = source.CREDENTIAL_ENCRYPTION_KEY_ID?.trim();
  if (requested && !keys.has(requested)) throw new Error(`CREDENTIAL_ENCRYPTION_KEY_ID "${requested}" is not in CREDENTIAL_ENCRYPTION_KEYS`);
  return { keys, legacy, activeId: keys.size ? requested || [...keys.keys()][0] : null };
}

function requireAnyKey(ring: Keyring) {
  if (!ring.legacy && !ring.keys.size) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");
}

function seal(key: Buffer, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

function open(key: Buffer, iv: string, tag: string, ciphertext: string) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function encryptCredential(value: string): string {
  const ring = loadKeyring();
  requireAnyKey(ring);
  if (ring.activeId) {
    const { iv, tag, ciphertext } = seal(ring.keys.get(ring.activeId)!, value);
    return ["v2", ring.activeId, iv, tag, ciphertext].join(".");
  }
  const { iv, tag, ciphertext } = seal(ring.legacy!, value);
  return ["v1", iv, tag, ciphertext].join(".");
}

export function decryptCredential(value: string): string {
  const ring = loadKeyring();
  requireAnyKey(ring);
  const parts = value.split(".");
  if (parts[0] === "v2" && parts.length === 5) {
    const [, keyId, iv, tag, ciphertext] = parts;
    const key = ring.keys.get(keyId);
    if (!key) throw new Error(`Encryption key "${keyId}" is not configured`);
    return open(key, iv, tag, ciphertext);
  }
  if (parts[0] === "v1" && parts.length === 4) {
    const [, iv, tag, ciphertext] = parts;
    // v1 records no key id, so try the original key and then each keyring key; authentication makes a wrong key fail cleanly.
    for (const key of [ring.legacy, ...ring.keys.values()]) {
      if (!key) continue;
      try { return open(key, iv, tag, ciphertext); } catch { /* try the next key */ }
    }
    throw new Error("Stored credential could not be decrypted with any configured key");
  }
  throw new Error("Unsupported credential format");
}

/** Which envelope and key a stored value uses — safe to log and report; contains no secret. */
export function describeEnvelope(value: string): { version: "v1" | "v2" | "unknown"; keyId: string | null } {
  const parts = value.split(".");
  if (parts[0] === "v2" && parts.length === 5) return { version: "v2", keyId: parts[1] };
  if (parts[0] === "v1" && parts.length === 4) return { version: "v1", keyId: null };
  return { version: "unknown", keyId: null };
}

/** The key id new values are encrypted with, or null when only the original single key is configured (v1). */
export function activeKeyId(): string | null {
  return loadKeyring().activeId;
}
