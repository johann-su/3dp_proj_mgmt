// Pure IP-range checks backing the BOM image proxy's SSRF guard (see
// src/app/api/bom-image/route.ts) — split out so the range logic can be unit
// tested without spinning up a route or doing a real DNS lookup.
import { isIPv4, isIPv6 } from "node:net";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(ip: number, base: string, prefixBits: number): boolean {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

// RFC 1918/5735/6598 private, loopback, link-local (incl. the 169.254.169.254
// cloud-metadata endpoint), and other non-public IPv4 ranges.
const IPV4_BLOCKED_RANGES: [base: string, prefixBits: number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const intIp = ipv4ToInt(ip);
  return IPV4_BLOCKED_RANGES.some(([base, bits]) => inIpv4Range(intIp, base, bits));
}

// Matches an embedded IPv4 in an IPv4-mapped (::ffff:a.b.c.d) or NAT64
// (64:ff9b::a.b.c.d) address, so those don't sail past the v6 checks below.
const EMBEDDED_IPV4_RE = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/;

export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  const embedded = normalized.match(EMBEDDED_IPV4_RE);
  if (embedded) return isPrivateOrReservedIpv4(embedded[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
  if (normalized.startsWith("2001:db8:")) return true; // documentation range
  return false;
}

// True for any address that isn't routable on the public internet — used to
// reject a resolved hostname before the proxy fetches it. Addresses in a
// format we don't recognize are treated as unsafe (fail closed).
export function isPrivateOrReservedIp(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateOrReservedIpv4(ip);
  if (isIPv6(ip)) return isPrivateOrReservedIpv6(ip);
  return true;
}
