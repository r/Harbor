/**
 * Decide whether agent.browser.fetch may read a URL.
 *
 * The extension fetches without CORS, so a page must not be able to point it
 * at the user's own machine or local network. This module refuses loopback,
 * private, link-local and other special-use addresses (IPv4 and IPv6), names
 * that only make sense locally, and, where the browser can resolve names
 * (Firefox's dns API), public names that resolve to such addresses.
 *
 * Limits: in Chrome there is no DNS check, so a public name that resolves to
 * a local address is not caught; and a name's answer can change between our
 * check and the request (DNS rebinding).
 */

/** IPv4 ranges that are not public unicast: [network, prefix length]. */
const BLOCKED_V4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

/** Name suffixes that only resolve on the user's machine or local network. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'home.arpa', 'internal', 'lan', 'intranet'];

function parseV4(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function v4Blocked(n: number): boolean {
  return BLOCKED_V4.some(([net, len]) => {
    const base = parseV4(net)!;
    const size = 2 ** (32 - len);
    return n >= base && n < base + size;
  });
}

/** Parse an IPv6 address (no brackets) into eight 16-bit groups. */
function parseV6(s: string): number[] | null {
  let addr = s.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // A trailing dotted IPv4 part (e.g. ::ffff:127.0.0.1) becomes two groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    addr = `${addr.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

function v6Blocked(g: number[]): boolean {
  const embeddedV4 = (g[6] << 16 >>> 0) + g[7];
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  if (zeros(0, 5) && g[5] === 0xffff) return v4Blocked(embeddedV4); // IPv4-mapped
  if (zeros(0, 6)) return true; // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4Blocked(embeddedV4); // NAT64
  if (g[0] === 0x2002) return v4Blocked(((g[1] << 16) >>> 0) + g[2]); // 6to4
  if (g[0] === 0x0100 && zeros(1, 4)) return true; // discard-only
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True if an IP address literal (v4 or v6, no brackets) is not public. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4 !== null) return v4Blocked(v4);
  const v6 = parseV6(ip);
  if (v6 !== null) return v6Blocked(v6);
  return true; // Unparseable: refuse rather than guess.
}

/**
 * True if a URL hostname (as `URL.hostname` gives it) is an address or name
 * that must not be fetched. Doesn't resolve names.
 */
export function isBlockedHostname(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) return isBlockedAddress(host.slice(1, -1));
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return true;
  if (parseV4(host) !== null) return isBlockedAddress(host);
  // Single-label names ("router", "intranet") resolve through local search domains.
  if (!host.includes('.')) return true;
  return LOCAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

type DnsApi = { resolve(host: string): Promise<{ addresses: string[] }> };

function dnsApi(): DnsApi | null {
  const b = (globalThis as { browser?: { dns?: DnsApi } }).browser;
  return b?.dns && typeof b.dns.resolve === 'function' ? b.dns : null;
}

/**
 * True if the URL must not be fetched or read. Where the browser can resolve
 * names, a name is refused if any of its addresses is not public. If the name
 * doesn't resolve, the fetch is left to fail on its own.
 */
export async function isBlockedUrl(url: URL): Promise<boolean> {
  if (isBlockedHostname(url.hostname)) return true;
  if (url.hostname.startsWith('[') || parseV4(url.hostname) !== null) return false;
  const dns = dnsApi();
  if (!dns) return false;
  let addresses: string[];
  try {
    ({ addresses } = await dns.resolve(url.hostname));
  } catch {
    return false;
  }
  return addresses.some(isBlockedAddress);
}
