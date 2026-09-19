import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class OutboundPolicyError extends Error {
  constructor(message: string) { super(message); this.name = "OutboundPolicyError"; }
}

function ipv4Parts(ip: string) { return ip.split(".").map(Number); }

/** IPv6 addresses that embed an IPv4 one (::ffff:a.b.c.d, or its hex form ::ffff:7f00:1) must be judged as that IPv4. */
function mappedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return null;
}

export type AddressClass = "public" | "private" | "always-blocked";

/**
 * Classifies a literal IP address.
 *  - "always-blocked": never a legitimate integration target — cloud metadata / link-local, multicast, unspecified,
 *    reserved. Refused even when private networks are allowed.
 *  - "private": loopback and private ranges. Legitimate for a LiteLLM proxy or a local model server on your own
 *    network, but not for a public catalog URL.
 */
export function classifyAddress(ip: string): AddressClass {
  const mapped = mappedIPv4(ip);
  if (mapped) return classifyAddress(mapped);
  if (isIP(ip) === 4) {
    const [a, b] = ipv4Parts(ip);
    if (a === 0) return "always-blocked";                          // 0.0.0.0/8 "this network" / unspecified
    if (a === 169 && b === 254) return "always-blocked";           // link-local, incl. 169.254.169.254 cloud metadata
    if (a >= 224) return "always-blocked";                         // multicast + reserved + broadcast
    if (a === 100 && b === 100) return "always-blocked";           // 100.100.100.200 (Alibaba metadata) lives in CGNAT space
    if (a === 127 || a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private";        // CGNAT (Tailscale etc.)
    return "public";
  }
  const lower = ip.toLowerCase();
  if (lower === "::" ) return "always-blocked";
  if (lower === "::1") return "private";
  if (/^fe[89ab]/.test(lower)) return "always-blocked";            // fe80::/10 link-local
  if (lower.startsWith("ff")) return "always-blocked";             // multicast
  if (lower.startsWith("fd00:ec2")) return "always-blocked";       // AWS IPv6 metadata
  if (/^f[cd]/.test(lower)) return "private";                      // fc00::/7 unique-local
  return "public";
}

export interface OutboundOptions {
  /** Allow loopback / private-range targets. Set for operator-configured integrations (LiteLLM, local model servers). */
  allowPrivate: boolean;
}

/**
 * Validates a user-supplied URL before the server fetches it or stores it for later fetching. Rejects non-HTTP(S)
 * schemes and embedded credentials, then resolves the hostname and checks EVERY returned address, so a public-looking
 * name that points at 169.254.169.254 or 127.0.0.1 is caught. Decimal/hex/octal IP spellings are normalized by the WHATWG
 * URL parser before this sees them.
 *
 * Limits: this checks at validation time, so a hostile DNS server can still change its answer between this check and
 * the later connection (rebinding). Pair it with `redirect: "manual"` on the fetch and with egress firewall rules.
 */
export async function assertSafeOutboundUrl(raw: string, options: OutboundOptions): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OutboundPolicyError("Not a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new OutboundPolicyError("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new OutboundPolicyError("URLs with embedded credentials are not allowed");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new OutboundPolicyError(`Could not resolve ${host}`); })).map(entry => entry.address);
  if (!addresses.length) throw new OutboundPolicyError(`Could not resolve ${host}`);

  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === "always-blocked") throw new OutboundPolicyError(`${host} resolves to a blocked address (${address})`);
    if (kind === "private" && !options.allowPrivate) throw new OutboundPolicyError(`${host} resolves to a private or loopback address (${address}); only public URLs are allowed here`);
  }
  return url;
}
