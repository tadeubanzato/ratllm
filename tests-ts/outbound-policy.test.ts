import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { classifyAddress, assertSafeOutboundUrl, OutboundPolicyError } = await import("../src/server/net/outbound-policy");

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"], ["1.1.1.1", "public"], ["172.15.0.1", "public"], ["172.32.0.1", "public"], ["100.63.0.1", "public"],
    ["127.0.0.1", "private"], ["10.0.0.5", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.5.48", "private"], ["100.64.0.1", "private"],
    ["169.254.169.254", "always-blocked"], ["169.254.0.1", "always-blocked"], ["0.0.0.0", "always-blocked"], ["224.0.0.1", "always-blocked"], ["255.255.255.255", "always-blocked"], ["100.100.100.200", "always-blocked"],
    ["::1", "private"], ["fd12:3456::1", "private"], ["fe80::1", "always-blocked"], ["ff02::1", "always-blocked"], ["::", "always-blocked"], ["fd00:ec2::254", "always-blocked"],
    ["2606:4700:4700::1111", "public"],
  ])("%s -> %s", (ip, expected) => { expect(classifyAddress(ip)).toBe(expected); });

  it("judges IPv4-mapped IPv6 addresses as the IPv4 they wrap", () => {
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("always-blocked");
    expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("always-blocked");
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
  });
});

describe("assertSafeOutboundUrl", () => {
  const strict = { allowPrivate: false };
  const lan = { allowPrivate: true };

  it("rejects non-http schemes and embedded credentials", async () => {
    await expect(assertSafeOutboundUrl("file:///etc/passwd", strict)).rejects.toBeInstanceOf(OutboundPolicyError);
    await expect(assertSafeOutboundUrl("ftp://8.8.8.8/x", strict)).rejects.toThrow(/http/);
    await expect(assertSafeOutboundUrl("https://user:pw@8.8.8.8/", strict)).rejects.toThrow(/credentials/);
    await expect(assertSafeOutboundUrl("nonsense", strict)).rejects.toThrow(/valid URL/);
  });

  it("always refuses cloud metadata, even when private networks are allowed", async () => {
    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data", lan)).rejects.toThrow(/blocked/);
    await expect(assertSafeOutboundUrl("http://[::ffff:169.254.169.254]/", lan)).rejects.toThrow(/blocked/);
    await expect(assertSafeOutboundUrl("http://[fd00:ec2::254]/", lan)).rejects.toThrow(/blocked/);
  });

  it("catches encoded spellings of loopback / metadata (the URL parser normalizes them)", async () => {
    await expect(assertSafeOutboundUrl("http://2130706433/", strict)).rejects.toThrow(/private/);      // 127.0.0.1 as a decimal
    await expect(assertSafeOutboundUrl("http://0x7f.1/", strict)).rejects.toThrow(/private/);           // hex + shorthand
    await expect(assertSafeOutboundUrl("http://2852039166/", lan)).rejects.toThrow(/blocked/);          // 169.254.169.254 as a decimal
  });

  it("blocks private and loopback targets unless explicitly allowed", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1:4000", strict)).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl("http://192.168.5.48:4000", strict)).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl("http://[::1]:4000", strict)).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl("http://192.168.5.48:4000", lan)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl("http://localhost:4000", lan)).resolves.toBeInstanceOf(URL);
  });

  it("allows public addresses", async () => {
    await expect(assertSafeOutboundUrl("https://8.8.8.8/models", strict)).resolves.toBeInstanceOf(URL);
  });
});
