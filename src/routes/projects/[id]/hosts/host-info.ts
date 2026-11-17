/**
 * Host inventory helpers shared by the Hosts list and the host detail page
 * (one formatter set for both).
 *
 * Agents report `host_info` as loose JSON whose key names changed between
 * agent versions (os / os_name, kernel_release / kernel_version, *_bytes vs
 * *_mb). These helpers read the first alias present and format with
 * $lib/format, so every page shows the same value the same way.
 */
import type { Host, TraceStatus } from '#lib/api.js';
import { formatBytes, formatDateTime, formatDuration } from '#lib/format.js';
import { capabilityTone, type BadgeTone } from '#lib/tone.js';
import { lsmReport } from '#lib/trace-status.js';
import { hasUnsafeChars } from '#lib/validation.js';

export type HostInfo = Record<string, unknown>;

/** UI field → keys agents have used for it, first non-empty wins. */
export const HOST_INFO_ALIASES = {
  hostname: ['hostname'],
  os: ['os', 'os_name'],
  os_version: ['os_version', 'os_pretty_name'],
  distribution: ['distro', 'distribution'],
  kernel: ['kernel_release', 'kernel_version'],
  arch: ['arch', 'architecture'],
  boot_time: ['boot_time'],
  uptime_seconds: ['uptime_seconds'],
  timezone: ['timezone'],
  cpu_cores: ['cpu_count', 'cpu_cores'],
  cpu_model: ['cpu_model'],
  cpu_mhz: ['cpu_mhz'],
  memory_total: ['memory_total_mb', 'memory_total_bytes'],
  memory_free: ['memory_free_mb', 'memory_free_bytes', 'memory_available_bytes'],
  memory_used: ['memory_used_bytes'],
  primary_ip: ['primary_ip', 'public_ip'],
  interface: ['primary_interface', 'interface'],
  selinux: ['selinux_mode', 'selinux'],
  apparmor: ['apparmor', 'apparmor_enabled'],
  bpf_lsm: ['bpf_lsm', 'bpf_lsm_enabled'],
  container_runtime: ['container_runtime'],
  virtualization: ['virt_type', 'virtualization'],
  agent_version: ['agent_version'],
  disk_total: ['disk_total_gb', 'disk_total_bytes'],
  disk_free: ['disk_free_gb', 'disk_free_bytes'],
} as const satisfies Record<string, readonly string[]>;

export type HostInfoField = keyof typeof HOST_INFO_ALIASES;

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** The first alias of `field` that carries a value, with the key it came from. */
export function hostInfoEntry(info: HostInfo | null | undefined, field: HostInfoField): { key: string; value: unknown } | null {
  if (!info) return null;
  for (const key of HOST_INFO_ALIASES[field]) {
    if (present(info[key])) return { key, value: info[key] };
  }
  return null;
}

/** Raw text of a field, or '' when the agent did not report it. */
export function hostInfoText(info: HostInfo | null | undefined, field: HostInfoField): string {
  const entry = hostInfoEntry(info, field);
  return entry ? String(entry.value) : '';
}

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Bytes for a size reported either in bytes (`*_bytes`), MB (`*_mb`) or GB (`*_gb`). */
export function hostInfoBytes(info: HostInfo | null | undefined, field: 'memory_total' | 'memory_free' | 'memory_used' | 'disk_total' | 'disk_free'): number | null {
  const entry = hostInfoEntry(info, field);
  if (!entry) return null;
  const n = positive(entry.value);
  if (n === null) return null;
  if (entry.key.endsWith('_mb')) return n * 1024 * 1024;
  if (entry.key.endsWith('_gb')) return n * 1024 * 1024 * 1024;
  return n;
}

const EMPTY = 'n/a';

/** Display text for one inventory field (sizes, durations and times formatted). */
export function hostInfoDisplay(info: HostInfo | null | undefined, field: HostInfoField): string {
  switch (field) {
    case 'memory_total':
    case 'memory_free':
    case 'memory_used':
    case 'disk_total':
    case 'disk_free': {
      const bytes = hostInfoBytes(info, field);
      return bytes === null ? EMPTY : formatBytes(bytes);
    }
    case 'uptime_seconds': {
      const seconds = positive(hostInfoEntry(info, field)?.value);
      return seconds === null ? EMPTY : formatDuration(seconds, 's');
    }
    case 'boot_time': {
      const entry = hostInfoEntry(info, field);
      if (!entry) return EMPTY;
      // Agents send epoch seconds; older ones an RFC 3339 string.
      return formatDateTime(typeof entry.value === 'number' ? entry.value : String(entry.value), { epochUnit: 's', fallback: String(entry.value) });
    }
    case 'cpu_mhz': {
      const n = positive(hostInfoEntry(info, field)?.value);
      return n === null ? EMPTY : `${Math.round(n)} MHz`;
    }
    case 'bpf_lsm':
      return bpfLsmState(info).label;
    default:
      return hostInfoText(info, field) || EMPTY;
  }
}

/** "0.42 / 0.35 / 0.30" from load_avg_1/5/15, or the single load_average value. */
export function hostLoadAverage(info: HostInfo | null | undefined): string {
  if (!info) return EMPTY;
  if (typeof info.load_avg_1 === 'number') {
    return [info.load_avg_1, info.load_avg_5, info.load_avg_15].map((v) => (typeof v === 'number' ? v.toFixed(2) : EMPTY)).join(' / ');
  }
  return present(info.load_average) ? String(info.load_average) : EMPTY;
}

/** BPF LSM availability: decides whether runtime `block` policies can be enforced. */
export function bpfLsmState(info: HostInfo | null | undefined): { state: 'active' | 'inactive' | 'unknown'; label: string } {
  const raw = hostInfoText(info, 'bpf_lsm').toLowerCase();
  if (['true', 'active', 'enabled', '1'].includes(raw)) return { state: 'active', label: 'Active' };
  if (['false', 'inactive', 'disabled', '0'].includes(raw)) return { state: 'inactive', label: 'Inactive (kprobe fallback)' };
  return { state: 'unknown', label: raw ? raw : EMPTY };
}

export interface BpfLsmDisplay {
  /** The agent's own trace status, or the host inventory when the agent reports no state. */
  source: 'agent' | 'inventory';
  /** null: plain text without a badge (the inventory has no usable value). */
  tone: BadgeTone | null;
  label: string;
  /** Short inline remark, inventory only. */
  hint: string | null;
  /** What the agent's state means, and what to do about it; agent only. */
  meaning: string | null;
  action: string | null;
}

/**
 * The BPF LSM line of the host page. The agent's `lsm_state` is the truth; an agent
 * that does not report it keeps the display of the host inventory field.
 */
export function bpfLsmDisplay(status: Pick<TraceStatus, 'lsm_state'> | null | undefined, info: HostInfo | null | undefined): BpfLsmDisplay {
  const report = lsmReport(status);
  if (report) return { source: 'agent', tone: report.tone, label: report.label, hint: null, meaning: report.meaning, action: report.action };
  const inventory = bpfLsmState(info);
  const base = { source: 'inventory', meaning: null, action: null } as const;
  if (inventory.state === 'active') return { ...base, tone: capabilityTone(true), label: 'Active', hint: null };
  if (inventory.state === 'inactive') return { ...base, tone: capabilityTone(false), label: 'Inactive', hint: 'kprobe fallback; block policies cannot deny' };
  return { ...base, tone: null, label: inventory.label, hint: null };
}

export interface HostDisk {
  mount: string;
  total: number | null;
  used: number | null;
  fs: string;
}

export interface HostInterface {
  name: string;
  addresses: string[];
  mac: string;
}

function list(info: HostInfo | null | undefined, key: string): Record<string, unknown>[] {
  const value = info?.[key];
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === 'object') as Record<string, unknown>[]) : [];
}

function str(...values: unknown[]): string {
  for (const value of values) if (present(value)) return String(value);
  return '';
}

export function hostDisks(info: HostInfo | null | undefined): HostDisk[] {
  return list(info, 'disks').map((disk) => ({
    mount: str(disk.mount, disk.mountpoint) || EMPTY,
    total: positive(disk.total_bytes ?? disk.size_bytes),
    used: positive(disk.used_bytes),
    fs: str(disk.fs_type, disk.filesystem) || EMPTY,
  }));
}

export function hostInterfaces(info: HostInfo | null | undefined): HostInterface[] {
  return list(info, 'network_interfaces').map((nic) => {
    const addresses = Array.isArray(nic.addresses) ? nic.addresses : Array.isArray(nic.ips) ? nic.ips : present(nic.ip) ? [nic.ip] : [];
    return {
      name: str(nic.name, nic.iface) || EMPTY,
      addresses: addresses.map(String),
      mac: str(nic.mac, nic.hw_addr) || EMPTY,
    };
  });
}

/** Share of `used` in `total` as "42%", or '-'. */
export function usedPercent(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) return EMPTY;
  return `${Math.round((used / total) * 100)}%`;
}

/** Hostname / OS / kernel / arch of a host for list rows (host_info first, then the host columns). */
export function hostSummary(host: Pick<Host, 'host_info' | 'host_os' | 'host_os_version' | 'host_kernel' | 'host_arch'>): { hostname: string; os: string; kernel: string; arch: string } {
  const info = host.host_info ?? null;
  return {
    hostname: hostInfoText(info, 'hostname'),
    os: host.host_os_version || hostInfoText(info, 'os_version') || host.host_os || hostInfoText(info, 'os'),
    kernel: host.host_kernel || hostInfoText(info, 'kernel'),
    arch: host.host_arch || hostInfoText(info, 'arch'),
  };
}

// ── Labels ────────────────────────────────────────────────────────────────

export interface LabelParseResult {
  labels: Record<string, string>;
  /** Entries that are not key=value, or use an invalid key. */
  invalid: string[];
  error: string | null;
}

const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;

/**
 * Parses "env=prod, region=eu-west-1". Unlike the old form, entries that are
 * not key=value are reported instead of being dropped silently.
 */
export function parseLabels(text: string): LabelParseResult {
  const labels: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const key = eq > 0 ? entry.slice(0, eq).trim() : '';
    if (!key || !LABEL_KEY.test(key)) {
      invalid.push(entry);
      continue;
    }
    labels[key] = entry.slice(eq + 1).trim();
  }
  const error = invalid.length ? `Use key=value pairs separated by commas; not valid: ${invalid.join(', ')}.` : null;
  return { labels, invalid, error };
}

/** Why `name` is not a valid host name (2–64 characters, no control, format or bidi characters), or null. */
export function hostNameError(name: string): string | null {
  const text = name.trim();
  if (!text) return 'Enter a host name.';
  if (text.length < 2) return 'Use at least 2 characters.';
  if (text.length > 64) return 'Use at most 64 characters.';
  if (hasUnsafeChars(text)) return 'Remove control, formatting or bidi characters.';
  return null;
}

// The install command moved to $lib/host-connect: the
// old one hard-coded eth0 and skipped the eBPF/trace flags and object paths.
