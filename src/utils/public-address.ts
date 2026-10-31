import { isIP } from "net";

/**
 * Whether an IP address is on the public internet: not this machine, not a
 * private or link-local network, not a carrier-grade NAT (a VPN's own
 * addresses), documentation, multicast or reserved block. A request made for
 * a page that only reads public data (the pane screenshot's HTTP bridge) is
 * refused for anything else, so a URL it is handed cannot reach a service on
 * the user's machine or network.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return isPublicIpv4(parseIpv4(bare)!);
  if (family === 6) {
    const groups = parseIpv6(bare);
    return groups !== null && isPublicIpv6(groups);
  }
  return false;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

/** [first octet, second octet, prefix bits of the second octet that count] per non-public block. */
const IPV4_BLOCKS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0.0.0.0/8, this network
  [10, 0, 0], // 10.0.0.0/8, private
  [100, 64, 2], // 100.64.0.0/10, carrier-grade NAT
  [127, 0, 0], // 127.0.0.0/8, loopback
  [169, 254, 8], // 169.254.0.0/16, link-local
  [172, 16, 4], // 172.16.0.0/12, private
  [192, 168, 8], // 192.168.0.0/16, private
  // 198.18.0.0/15 (benchmarking) stays public: proxies that answer every name with a stand-in address use it.
];

function isPublicIpv4([a, b, c]: number[]): boolean {
  for (const [first, second, bits] of IPV4_BLOCKS) {
    if (a !== first) continue;
    if (bits === 0) return false;
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((b! & mask) === second) return false;
  }
  // 192.0.0.0/24 protocol assignments, 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24 documentation.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved and the broadcast address.
  return a! < 224;
}

/** Eight 16-bit groups, or null when the text is not one IPv6 address. */
function parseIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]!);
    if (!v4) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    // `::1.2.3.4` keeps its `::`; `1:2:3:4:5:6:1.2.3.4` loses the colon before the dotted part.
    const before = text.slice(0, dotted.index);
    text = before.endsWith(":") ? `${before}:` : before;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (half: string) => (half ? half.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const head = read(halves[0]!);
  const rest = halves.length === 2 ? read(halves[1]!) : [];
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 && known !== 8) return null;
  if (halves.length === 2 && known > 7) return null;
  const groups = [...head, ...Array(8 - known).fill(0), ...rest, ...tail];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

function embeddedIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPublicIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  // ::ffff:a.b.c.d, an IPv4 address written as IPv6: as public as the address it carries.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isPublicIpv4(embeddedIpv4(g6, g7));
  // ::, ::1 and the retired IPv4-compatible block.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false;
  // 64:ff9b::/96 NAT64 carries an IPv4 address; 64:ff9b:1::/48 is a local NAT64.
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && isPublicIpv4(embeddedIpv4(g6, g7));
  // 2002::/16 6to4 carries an IPv4 address in its next 32 bits.
  if (g0 === 0x2002) return isPublicIpv4(embeddedIpv4(g1, g2));
  // 100::/64 discard.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false;
  // 2001::/23 protocol assignments (Teredo among them) and 2001:db8::/32 documentation.
  if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return false;
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  return (g0 & 0xfe00) !== 0xfc00 && (g0 & 0xffc0) !== 0xfe80 && (g0 & 0xffc0) !== 0xfec0 && (g0 & 0xff00) !== 0xff00;
}
