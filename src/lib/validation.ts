/**
 * Shared input validation.
 *
 * Replaces the per-page IP validators (one accepted invalid IPv6 such as
 * "1::2::3"), the six line-list parsers and the copies of the WAF key-field,
 * byte-size and AES-key checks. Pure functions only; every page reports the
 * returned message next to its own field.
 */

// ── Names (hosts, agents, label values) ────────────────────────────────────

// Control characters (C0, DEL, C1), format characters (zero-width, bidi
// controls, BOM) and line/paragraph separators: the server's
// validate.PlainText refuses them in host and agent names and label values,
// which the installer prints to a root terminal.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** True when `value` holds a character the server refuses in a name. */
export function hasUnsafeChars(value: string): boolean {
  return UNSAFE_TEXT.test(value);
}

// ── IP addresses and CIDR ranges ───────────────────────────────────────────

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;

/**
 * Dotted-quad IPv4. Leading zeros are rejected ("010.0.0.1" is octal in some
 * parsers and decimal in others, so it is ambiguous for a firewall rule).
 */
export function isIPv4(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => IPV4_OCTET.test(part) && Number(part) <= 255);
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/**
 * RFC 4291 text form: eight 16-bit hex groups, at most one "::" standing for
 * one or more zero groups, and an optional dotted IPv4 tail ("::ffff:1.2.3.4")
 * that counts as two groups. Zone identifiers ("fe80::1%eth0") and brackets
 * are rejected, neither is valid in a firewall or WAF rule.
 */
export function isIPv6(value: string): boolean {
  if (typeof value !== 'string' || value.length < 2 || value.length > 45) return false;
  const doubleColon = value.indexOf('::');
  if (doubleColon !== -1 && value.indexOf('::', doubleColon + 1) !== -1) return false;

  const countGroups = (section: string): number | null => {
    if (section === '') return 0;
    const groups = section.split(':');
    let count = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (i === groups.length - 1 && group.includes('.')) {
        if (!isIPv4(group)) return null;
        count += 2;
      } else if (HEX_GROUP.test(group)) {
        count += 1;
      } else {
        return null;
      }
    }
    return count;
  };

  if (doubleColon === -1) {
    return countGroups(value) === 8;
  }
  const head = value.slice(0, doubleColon);
  const tail = value.slice(doubleColon + 2);
  // An IPv4 tail is only valid at the very end, never before "::".
  if (head.includes('.')) return false;
  const headCount = countGroups(head);
  const tailCount = countGroups(tail);
  if (headCount === null || tailCount === null) return false;
  // "::" must stand for at least one zero group.
  return headCount + tailCount <= 7;
}

export type IPVersion = 4 | 6;

export function ipVersion(value: string): IPVersion | null {
  if (isIPv4(value)) return 4;
  if (isIPv6(value)) return 6;
  return null;
}

export function isIP(value: string): boolean {
  return ipVersion(value) !== null;
}

export interface ParsedCIDR {
  address: string;
  prefix: number;
  version: IPVersion;
  /** True when bits beyond the prefix are set ("10.0.0.1/24"). */
  hostBitsSet: boolean;
}

function ipv4ToBytes(value: string): number[] {
  return value.split('.').map(Number);
}

function ipv6ToBytes(value: string): number[] {
  let text = value;
  const bytes: number[] = [];
  let v4Tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    v4Tail = ipv4ToBytes(text.slice(lastColon + 1));
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: tail === undefined ? 0 : missing }, () => '0'), ...tailGroups];
  for (const group of groups) {
    const n = parseInt(group, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  if (v4Tail.length) bytes.splice(12, 4, ...v4Tail);
  return bytes;
}

/** Address bytes (4 for IPv4, 16 for IPv6) or null when invalid. */
export function ipToBytes(value: string): number[] | null {
  const version = ipVersion(value);
  if (version === 4) return ipv4ToBytes(value);
  if (version === 6) return ipv6ToBytes(value);
  return null;
}

const PREFIX = /^(?:0|[1-9]\d{0,2})$/;

/** "10.0.0.0/8" or "2001:db8::/32"; null when either part is invalid. */
export function parseCIDR(value: string): ParsedCIDR | null {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  if (slash === -1 || value.indexOf('/', slash + 1) !== -1) return null;
  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!PREFIX.test(prefixText)) return null;
  const version = ipVersion(address);
  if (version === null) return null;
  const prefix = Number(prefixText);
  if (prefix > (version === 4 ? 32 : 128)) return null;
  const bytes = ipToBytes(address) ?? [];
  let hostBitsSet = false;
  for (let bit = prefix; bit < bytes.length * 8; bit++) {
    if ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1) { hostBitsSet = true; break; }
  }
  return { address, prefix, version, hostBitsSet };
}

/**
 * CIDR range. `strict: true` also rejects host bits beyond the prefix
 * ("10.0.0.1/24", the operator probably meant "10.0.0.0/24").
 */
export function isCIDR(value: string, opts: { strict?: boolean } = {}): boolean {
  const parsed = parseCIDR(value);
  return parsed !== null && !(opts.strict && parsed.hostBitsSet);
}

/** A single address or a CIDR range, the shape every IP rule list accepts. */
export function isIPOrCIDR(value: string, opts: { strict?: boolean } = {}): boolean {
  return isIP(value) || isCIDR(value, opts);
}

// ── Lists ──────────────────────────────────────────────────────────────────

export interface ParseListOptions {
  /** Separators between entries. Default: newlines and commas. */
  separators?: RegExp;
  /** Drop lines starting with "#". Default true. */
  comments?: boolean;
  /** Remove duplicates (first occurrence wins). Default true. */
  dedupe?: boolean;
  /** Compare case-insensitively when deduplicating. Default false. */
  caseInsensitive?: boolean;
}

/**
 * Splits a textarea/comma list into trimmed, non-empty entries. With
 * `comments` (default) a line starting with "#" is dropped and a trailing
 * " # note" after an entry is removed. Pass `separators: /\n+/` for values
 * that may contain commas (user agents).
 */
export function parseList(text: string | readonly string[] | null | undefined, opts: ParseListOptions = {}): string[] {
  if (text === null || text === undefined) return [];
  const separators = opts.separators ?? /[\n,]+/;
  const comments = opts.comments ?? true;
  const lines = typeof text === 'string'
    ? text.split(/\r?\n/).flatMap((line) => {
      let trimmed = line.trim();
      if (comments) {
        if (trimmed.startsWith('#')) return [];
        trimmed = trimmed.replace(/\s+#.*$/, '');
      }
      return trimmed.split(separators);
    })
    : [...text];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of lines) {
    const value = String(entry).trim();
    if (!value) continue;
    if (opts.dedupe ?? true) {
      const key = opts.caseInsensitive ? value.toLowerCase() : value;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(value);
  }
  return out;
}

// ── WAF key fields ─────────────────────────────────────────────────────────

/** Request attributes the block policy and L7 flood limiter can key on. */
export const KEY_FIELDS = ['remote_addr', 'user_agent', 'host', 'request_id'] as const;
export type KeyField = (typeof KEY_FIELDS)[number] | `header:${string}`;

// RFC 9110 token characters.
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isHeaderName(value: string): boolean {
  return typeof value === 'string' && HTTP_TOKEN.test(value);
}

export function isKeyField(value: string): value is KeyField {
  if ((KEY_FIELDS as readonly string[]).includes(value)) return true;
  return value.startsWith('header:') && isHeaderName(value.slice('header:'.length));
}

// ── Byte sizes ─────────────────────────────────────────────────────────────

const BYTE_UNITS: Record<string, number> = {
  '': 1, b: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

/**
 * Parses "1048576", "512 KB", "10MiB", "1.5 GB" into bytes. Units are
 * binary (1 KB = 1024 B), matching the agents. Returns null for negative,
 * fractional-byte or malformed input.
 */
export function parseByteSize(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(value);
  if (!match) return null;
  const multiplier = BYTE_UNITS[match[2].toLowerCase()];
  if (multiplier === undefined) return null;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isFinite(bytes) || !Number.isInteger(bytes) || !Number.isSafeInteger(bytes)) return null;
  return bytes;
}

// ── Keys and URLs ──────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** AES-256 key as 64 hexadecimal characters (32 bytes). */
export function isAES256Key(value: string): boolean {
  return typeof value === 'string' && HEX64.test(value.trim());
}

/**
 * Absolute URL with one of the allowed protocols (default http/https) and a
 * host. Credentials in the URL ("https://user:pass@host") are rejected.
 */
export function isURL(value: string, opts: { protocols?: readonly string[] } = {}): boolean {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim())) return false;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  const protocols = opts.protocols ?? ['http', 'https'];
  if (!protocols.includes(url.protocol.replace(/:$/, ''))) return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}
