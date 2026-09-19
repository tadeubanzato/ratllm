import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA } from "../src/server/providers/gigachat-ca";

// Confirmed 2026-09-19 by downloading both certs directly from https://gu-st.ru/content/lending/ and comparing
// SHA-256 fingerprints byte-for-byte against what's embedded here. If this ever fails, the embedded PEM has been
// corrupted or swapped for something else — do not "fix" it by updating the expected fingerprint without
// re-verifying against the real certs, since a wrong CA here means GigaChat requests silently trust the wrong issuer.
const ROOT_FINGERPRINT_SHA256 = "D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31";
const SUB_FINGERPRINT_SHA256 = "BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B";

describe("GigaChat's pinned Russian Trusted Root/Sub CA certificates", () => {
  it("parse as valid X.509 certificates with the expected fingerprints", () => {
    const root = new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA);
    const sub = new X509Certificate(RUSSIAN_TRUSTED_SUB_CA);
    expect(root.fingerprint256).toBe(ROOT_FINGERPRINT_SHA256);
    expect(sub.fingerprint256).toBe(SUB_FINGERPRINT_SHA256);
  });

  it("form a real issuance chain (sub CA issued by the root, root self-signed)", () => {
    const root = new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA);
    const sub = new X509Certificate(RUSSIAN_TRUSTED_SUB_CA);
    expect(sub.checkIssued(root)).toBe(true);
    expect(root.checkIssued(root)).toBe(true);
  });

  it("are the Ministry of Digital Development's certs, not some other issuer", () => {
    const root = new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA);
    expect(root.subject).toContain("Russian Trusted Root CA");
    expect(root.subject).toContain("Ministry of Digital Development");
  });
});
