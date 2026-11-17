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

export interface ListValidation {
  valid: string[];
  invalid: string[];
}

/** Splits entries into those accepted by `predicate` and the rest. */
export function partitionList(entries: readonly string[], predicate: (entry: string) => boolean): ListValidation {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) (predicate(entry) ? valid : invalid).push(entry);
  return { valid, invalid };
}

/** Parses an IP/CIDR list and reports the entries that are not addresses. */
export function parseIPList(text: string | readonly string[] | null | undefined, opts: { strict?: boolean } = {}): ListValidation {
  return partitionList(parseList(text), (entry) => isIPOrCIDR(entry, opts));
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

export interface KeyFieldValidation {
  fields: KeyField[];
  error: string | null;
}

/**
 * Validates a comma/newline key-field list ("remote_addr, header:X-Api-Key").
 * An empty list is an error: a limiter without a key cannot tell clients
 * apart.
 */
export function validateKeyFields(input: string | readonly string[]): KeyFieldValidation {
  const entries = parseList(input);
  if (!entries.length) return { fields: [], error: 'Enter at least one key field.' };
  for (const entry of entries) {
    if (isKeyField(entry)) continue;
    if (entry.startsWith('header:')) {
      return { fields: [], error: `"${entry}" is not a valid header key. Use header:Header-Name, e.g. header:X-Request-ID.` };
    }
    return { fields: [], error: `"${entry}" is not a supported key field. Use ${KEY_FIELDS.join(', ')} or header:Header-Name.` };
  }
  return { fields: entries as KeyField[], error: null };
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

/** Error message for a byte size outside [min, max], or null when valid. */
export function validateByteSize(value: string | number | null | undefined, opts: { min?: number; max?: number; label?: string } = {}): string | null {
  const label = opts.label ?? 'Size';
  const bytes = parseByteSize(value);
  if (bytes === null) return `${label} must be a whole number of bytes, optionally with a unit (KB, MB, GB).`;
  if (opts.min !== undefined && bytes < opts.min) return `${label} must be at least ${opts.min} bytes.`;
  if (opts.max !== undefined && bytes > opts.max) return `${label} must be at most ${opts.max} bytes.`;
  return null;
}

// ── Keys, URLs and ports ───────────────────────────────────────────────────

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** AES-256 key as 64 hexadecimal characters (32 bytes). */
export function isAES256Key(value: string): boolean {
  return typeof value === 'string' && HEX64.test(value.trim());
}

/** Error message for an AES-256 key, or null when valid (or optional and empty). */
export function validateAES256Key(value: string | null | undefined, opts: { required?: boolean; label?: string } = {}): string | null {
  const label = opts.label ?? 'AES key';
  const key = (value ?? '').trim();
  if (!key) return opts.required ? `${label} is required (64 hexadecimal characters).` : null;
  return HEX64.test(key) ? null : `${label} must be exactly 64 hexadecimal characters.`;
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

/** Error message for a URL, or null when valid. */
export function validateURL(value: string | null | undefined, opts: { required?: boolean; protocols?: readonly string[]; label?: string } = {}): string | null {
  const label = opts.label ?? 'URL';
  const text = (value ?? '').trim();
  if (!text) return opts.required ? `${label} is required.` : null;
  const protocols = opts.protocols ?? ['http', 'https'];
  return isURL(text, { protocols }) ? null : `${label} must be a valid ${protocols.join(' or ')} URL.`;
}

/** TCP/UDP port 1–65535 (`allowZero` accepts 0 for "unset"). */
export function isPort(value: number | string | null | undefined, opts: { allowZero?: boolean } = {}): boolean {
  if (value === null || value === undefined || value === '') return false;
  const text = String(value).trim();
  if (!/^\d{1,5}$/.test(text)) return false;
  const port = Number(text);
  return port <= 65535 && (port >= 1 || (opts.allowZero === true && port === 0));
}

export function parsePort(value: number | string | null | undefined): number | null {
  return isPort(value) ? Number(String(value).trim()) : null;
}

export interface PortRange {
  from: number;
  to: number;
}

/**
 * Parses a port list such as "22, 80, 8000-8100" into ranges. Returns null
 * when any entry is not a port or a range is reversed.
 */
export function parsePortList(value: string): PortRange[] | null {
  const entries = parseList(value, { dedupe: true });
  if (!entries.length) return null;
  const ranges: PortRange[] = [];
  for (const entry of entries) {
    const match = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(entry);
    if (match) {
      const from = parsePort(match[1]);
      const to = parsePort(match[2]);
      if (from === null || to === null || from > to) return null;
      ranges.push({ from, to });
      continue;
    }
    const port = parsePort(entry);
    if (port === null) return null;
    ranges.push({ from: port, to: port });
  }
  return ranges;
}
