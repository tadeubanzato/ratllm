import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { encryptCredential, decryptCredential, describeEnvelope, activeKeyId, loadKeyring } = await import("../src/server/credentials/crypto");

const LEGACY = "legacy-single-key-0123456789abcdefghijklmnop";
const K1 = "keyring-key-one-0123456789abcdefghijklmnopq";
const K2 = "keyring-key-two-zyxwvutsrqponmlkjihgfedcba98";
const SECRET = "provider-api-key-value-not-real-12345";

const saved = { ...process.env };
const configure = (env: Record<string, string | undefined>) => {
  for (const name of ["CREDENTIAL_ENCRYPTION_KEY", "CREDENTIAL_ENCRYPTION_KEYS", "CREDENTIAL_ENCRYPTION_KEY_ID"]) delete process.env[name];
  for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
};
beforeEach(() => configure({}));
afterEach(() => { process.env = { ...saved }; });

describe("with only the original single key (backward compatible)", () => {
  it("encrypts in the v1 format and round-trips, exactly as before", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEY: LEGACY });
    const stored = encryptCredential(SECRET);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(describeEnvelope(stored)).toEqual({ version: "v1", keyId: null });
    expect(decryptCredential(stored)).toBe(SECRET);
    expect(activeKeyId()).toBeNull();
  });

  it("never puts the plaintext or the key in the stored value", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEY: LEGACY });
    const stored = encryptCredential(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(LEGACY);
  });

  it("produces different ciphertext each time (random IV)", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEY: LEGACY });
    expect(encryptCredential(SECRET)).not.toBe(encryptCredential(SECRET));
  });

  it("throws a clear error when no key is configured at all", () => {
    expect(() => encryptCredential(SECRET)).toThrow(/CREDENTIAL_ENCRYPTION_KEY is not configured/);
  });
});

describe("with a keyring", () => {
  it("encrypts in the v2 format naming the active key", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `k1:${K1},k2:${K2}`, CREDENTIAL_ENCRYPTION_KEY_ID: "k2" });
    const stored = encryptCredential(SECRET);
    expect(stored.startsWith("v2.k2.")).toBe(true);
    expect(describeEnvelope(stored)).toEqual({ version: "v2", keyId: "k2" });
    expect(decryptCredential(stored)).toBe(SECRET);
  });

  it("defaults the active key to the first entry", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `first:${K1},second:${K2}` });
    expect(activeKeyId()).toBe("first");
  });

  it("still reads values written under an older key after the active key changes (this is what makes rotation safe)", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `k1:${K1}`, CREDENTIAL_ENCRYPTION_KEY_ID: "k1" });
    const old = encryptCredential(SECRET);
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `k2:${K2},k1:${K1}`, CREDENTIAL_ENCRYPTION_KEY_ID: "k2" });
    expect(decryptCredential(old)).toBe(SECRET);
    expect(encryptCredential(SECRET).startsWith("v2.k2.")).toBe(true);
  });

  it("fails with a clear message — not garbage — once the key a value used has been removed", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `k1:${K1}` });
    const old = encryptCredential(SECRET);
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `k2:${K2}` });
    expect(() => decryptCredential(old)).toThrow(/Encryption key "k1" is not configured/);
  });

  it("reads a v1 value written under the original key, whether that key is still set on its own or was moved into the keyring", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEY: LEGACY });
    const v1 = encryptCredential(SECRET);
    configure({ CREDENTIAL_ENCRYPTION_KEY: LEGACY, CREDENTIAL_ENCRYPTION_KEYS: `new:${K1}` });
    expect(decryptCredential(v1)).toBe(SECRET);
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `new:${K1},old:${LEGACY}` });      // legacy variable removed, key kept in the ring
    expect(decryptCredential(v1)).toBe(SECRET);
  });

  it("cannot read a v1 value if its key is in neither place", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEY: LEGACY });
    const v1 = encryptCredential(SECRET);
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `only:${K1}` });
    expect(() => decryptCredential(v1)).toThrow(/could not be decrypted with any configured key/);
  });

  it("detects tampering with the ciphertext, the tag, or the key id", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `k1:${K1},k2:${K2}`, CREDENTIAL_ENCRYPTION_KEY_ID: "k1" });
    const [v, id, iv, tag, ct] = encryptCredential(SECRET).split(".");
    const flip = (s: string) => s.slice(0, -2) + (s.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptCredential([v, id, iv, tag, flip(ct)].join("."))).toThrow();
    expect(() => decryptCredential([v, id, iv, flip(tag), ct].join("."))).toThrow();
    expect(() => decryptCredential([v, "k2", iv, tag, ct].join("."))).toThrow(); // relabelled as another key
  });
});

describe("configuration is validated loudly", () => {
  it.each([
    ["a malformed entry", "no-colon-here"],
    ["a bad key id", `bad id!:${K1}`],
    ["a short secret", "k1:tooshort"],
    ["a duplicate id", `k1:${K1},k1:${K2}`],
  ])("rejects %s", (_name, keys) => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: keys });
    expect(() => loadKeyring()).toThrow(/CREDENTIAL_ENCRYPTION_KEYS/);
  });

  it("rejects an active key id that is not in the keyring", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: `k1:${K1}`, CREDENTIAL_ENCRYPTION_KEY_ID: "missing" });
    expect(() => loadKeyring()).toThrow(/is not in CREDENTIAL_ENCRYPTION_KEYS/);
  });

  it("tolerates whitespace and secrets that contain colons", () => {
    configure({ CREDENTIAL_ENCRYPTION_KEYS: ` k1 : ${K1}:with:colons  , k2:${K2} ` });
    // The first colon separates the id; the rest (including further colons) belongs to the secret.
    expect(() => loadKeyring()).not.toThrow();
    expect(activeKeyId()).toBe("k1");
  });
});
