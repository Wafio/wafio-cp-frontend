/**
 * Lockout-guard codes of the host firewall: 400 codes a
 * save can return, warnings an accepted save can carry, and the host's
 * bundle_status states ("refused", saved policy, DNS relaxed).
 */
import type { ApiError } from '#lib/api.js';
import type { CheckFix } from './lockout';

/** `warnings[]` item of an accepted firewall save. */
export interface FirewallWarning {
  code: string;
  message: string;
}

const ERROR_TEXT: Record<string, { hint: string; fix?: CheckFix }> = {
  CONNTRACK_REQUIRED: { hint: 'Turn connection tracking on in Settings first: Deny all and 0.0.0.0/0 or ::/0 blocklist entries rely on it to let replies through.', fix: 'settings' },
  SSH_ALLOW_REQUIRED: { hint: 'Add a permanent ingress TCP ALLOW rule for the SSH port (no expiring DROP on the same port) before ingress Deny all.', fix: 'rules' },
  // Earlier code of the same guard, still sent by older control planes.
  INGRESS_ALLOW_REQUIRED: { hint: 'Add a permanent ingress ALLOW rule for your management port (SSH) before ingress Deny all.', fix: 'rules' },
  WILDCARD_BLOCK_NEEDS_ALLOWLIST: { hint: 'Add a permanent allowlist entry of the same address family (your management network), on all ports or covering the SSH port over TCP, before blocking 0.0.0.0/0, ::/0 or half of a family or more. An entry scoped to other ports does not count.', fix: 'rules' },
  EGRESS_BLOCK_TOO_BROAD: { hint: 'Egress entries other than 0.0.0.0/0 and ::/0 also drop replies to inbound connections such as SSH; block the whole family (replies stay open) or use egress Deny all in Settings.', fix: 'rules' },
  ALLOWLIST_NESTING_TOO_DEEP: { hint: 'More than four nested expiring allowlist entries cover one address; merge them or make one of the four longest permanent.', fix: 'rules' },
  BLOCKLIST_NESTING_TOO_DEEP: { hint: 'More than four nested expiring blocklist entries cover one address; merge them or make one of the four longest permanent.', fix: 'rules' },
  IP_LIST_FULL: { hint: 'The list does not fit the kernel map (counted in prefixes); remove entries or merge addresses into CIDR prefixes.', fix: 'rules' },
  PORT_POLICY_INVALID: { hint: 'Port rules need a port from 1 to 65535, action allow, drop or log, protocol tcp, udp or any, and direction ingress, egress or both.', fix: 'rules' },
  CONTROL_PLANE_UNPINNED: { hint: 'The agent has not pinned the control-plane address yet; add a permanent egress ALLOW for DNS (53/udp) or wait until the agent reconnects.', fix: 'rules' },
  FIREWALL_DATAPLANE_OUTDATED: { hint: 'The host runs older eBPF objects without the reply and control-plane exemptions; update the host agent first.' },
  // Port-scoped allowlist entries.
  INVALID_PORTS: { hint: 'Write each port scope as 22/tcp, 8000-8100/udp or 53/any (ports 1 to 65535, the lower port first), and give an address the same ports everywhere it is listed.', fix: 'rules' },
  ALLOWLIST_PORTS_TOO_MANY: { hint: 'An allowlist entry takes at most 8 port scopes after merging; merge neighbouring ports into ranges or allow all ports.', fix: 'rules' },
  ALLOWLIST_WILDCARD_SCOPED: { hint: '0.0.0.0/0 and ::/0 cannot be scoped to ports; a port ALLOW rule is the right tool to open a port to everyone.', fix: 'rules' },
  ALLOWLIST_PORTS_UNSUPPORTED: { hint: 'This host does not enforce port-scoped allowlist entries; update the host agent together with its eBPF objects, or add the entry for all ports.' },
  GEO_ALLOW_NO_ESCAPE: { hint: 'Geo allow mode is enforced without a lockout escape: add a permanent allowlist entry for your management network, on all ports or covering the SSH port over TCP.', fix: 'rules' },
  // Geo allow mode.
  GEO_ALLOW_UNACKNOWLEDGED: { hint: 'Confirm the allow-mode warning to switch to allow mode or remove an allowed country.' },
  GEO_ALLOW_EMPTY: { hint: 'Add at least one country to the allowed countries; allow mode with an empty list would drop every new inbound connection.', fix: 'rules' },
  GEO_ALLOW_UNSUPPORTED: { hint: 'Update the host agent and its eBPF objects, and install the GeoIP country database, then try again.' },
  GEO_COUNTRY_INVALID: { hint: 'Use two-letter ISO 3166-1 country codes, for example ID or SG.' },
  GEO_MODE_INVALID: { hint: 'The geo mode must be block or allow.' },
};

/** True for a lockout-guard code the Firewall page explains. */
export function isFirewallGuardCode(code: string | null | undefined): boolean {
  return Boolean(code && code in ERROR_TEXT);
}

/** Where the operator fixes a refused save, if known. */
export function firewallErrorFix(code: string | null | undefined): CheckFix | undefined {
  return code ? ERROR_TEXT[code]?.fix : undefined;
}

/** Server message plus what to do, e.g. for an inline error next to the rule or the Settings save. */
export function firewallErrorMessage(err: Pick<ApiError, 'error' | 'code'> | null | undefined, fallback = 'The change was not saved.'): string {
  if (!err) return fallback;
  const text = err.error || fallback;
  const info = err.code ? ERROR_TEXT[err.code] : undefined;
  return info ? `${text} ${info.hint}` : text;
}

/** `warnings` of an accepted save (top-level array), tolerating any shape. */
export function firewallWarningsOf(data: unknown): FirewallWarning[] {
  const list = (data as { warnings?: unknown } | null | undefined)?.warnings;
  if (!Array.isArray(list)) return [];
  return list
    .filter((w): w is FirewallWarning => Boolean(w) && typeof (w as FirewallWarning).message === 'string')
    .map((w) => ({ code: typeof w.code === 'string' ? w.code : '', message: w.message }));
}

/** A warning's message plus what to do when its code is known (e.g. GEO_ALLOW_NO_ESCAPE). */
export function firewallWarningText(warning: FirewallWarning): string {
  const hint = warning.code ? ERROR_TEXT[warning.code]?.hint : undefined;
  return hint && !warning.message.includes(hint) ? `${warning.message} ${hint}` : warning.message;
}

/** Appends warnings, dropping repeats of the same code and message. */
export function mergeWarnings(into: readonly FirewallWarning[], more: readonly FirewallWarning[]): FirewallWarning[] {
  const out = [...into];
  for (const w of more) if (!out.some((o) => o.code === w.code && o.message === w.message)) out.push(w);
  return out;
}

/** One entry of the host's bundle_status (ebpf_state and friends). */
export interface HostBundleStatusEntry {
  status: string;
  code?: string;
  source?: string;
  saved_generation?: string;
  dns_relaxed?: boolean;
  error?: string;
}

export interface BundleStateNote {
  tone: 'warning' | 'info' | 'error';
  title: string;
  message: string;
}

/**
 * Notes for the host view: "apply refused (<code>)", "running saved policy",
 * "DNS relaxed until control plane pinned".
 */
export function bundleStateNotes(entry: HostBundleStatusEntry | null | undefined): BundleStateNote[] {
  if (!entry) return [];
  const notes: BundleStateNote[] = [];
  if (entry.status === 'refused') {
    const code = entry.code || 'unknown';
    notes.push({
      tone: 'error',
      title: `Apply refused (${code})`,
      message: `The host agent's lockout guard refused the saved firewall policy before changing anything; the host keeps its last good policy. ${ERROR_TEXT[code]?.hint ?? ''}`.trim(),
    });
  }
  if (entry.source === 'saved') {
    const gen = entry.saved_generation ? ` (generation ${entry.saved_generation})` : '';
    notes.push({
      tone: 'info',
      title: 'Running saved policy',
      message: `The host restored its last good policy${gen} from disk at agent start and has not applied a push from this control plane since.`,
    });
  }
  if (entry.dns_relaxed) {
    notes.push({
      tone: 'warning',
      title: 'DNS relaxed until control plane pinned',
      message: 'The saved egress Deny all runs with DNS allowed because the agent could not pin the control-plane address yet.',
    });
  }
  return notes;
}
