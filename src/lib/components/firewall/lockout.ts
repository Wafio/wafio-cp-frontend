/**
 * Lockout checks and confirmation tiers for firewall mode changes.
 *
 * Before Enforce, Deny all or Disable the Firewall page shows what the change
 * does to reachability and what evidence supports it. A failing check blocks
 * the change (the control plane rejects the same states:
 * shared/hostpolicy/firewall_validation.go); warnings need an informed confirm.
 *
 * Kernel behaviour the checks describe (internal/ebpf/bpf):
 * - allowlisted source addresses pass XDP before geo, blocklist, port rules
 *   and rate limits, on every port, or for a port-scoped entry only on its
 *   TCP/UDP ports (other ports and ICMP meet the normal path);
 * - ingress Deny all drops every new inbound flow without an ingress ALLOW
 *   port rule; the guard requires a permanent TCP ALLOW on the SSH port(s)
 *   the host agent reports (else 22) that no other rule overrides;
 * - Deny all (either direction) and 0.0.0.0/0 or ::/0 blocklist entries need
 *   connection tracking: replies are recognised through it;
 * - under egress Deny all, replies to inbound connections (SSH sessions), the
 *   agent's own control-plane connection, DHCP client requests and IPv6
 *   neighbour discovery always pass;
 * - a 0.0.0.0/0 or ::/0 blocklist entry needs a permanent allowlist entry of
 *   the same address family that is a lockout escape (no ports, or a tcp/any
 *   scope covering an SSH port);
 * - monitor-only logs would-drops and forwards every packet.
 */
import type { EBPFAllowlistEntry, EBPFIPListEntry, EBPFPortPolicy } from '#lib/api.js';
import { strictestTier, tierFor, tierForFirewallMode, tierForPortPolicyConfig, type ConfirmTier } from '#lib/confirm-tiers.js';
import {
  DEFAULT_CONTROL_PLANE_PORT,
  egressAllows,
  guardedSSHPorts,
  hasPermanentAllowlistFamily,
  isLockoutEscape,
  isExpired,
  portAlwaysAllowed,
  portRuleLabel,
  sshAllowed,
  wildcardFamilies,
} from './rules';

/** The switches that decide what the host drops. */
export interface FirewallState {
  enabled: boolean;
  monitor_only: boolean;
  enable_conntrack: boolean;
  port_policy_enabled: boolean;
  default_ingress: string;
  default_egress: string;
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info';

/** Where the operator can fix a failing check. */
export type CheckFix = 'rules' | 'settings' | 'overview' | 'live';

export interface LockoutCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  fix?: CheckFix;
}

export interface LockoutContext {
  portRules?: readonly EBPFPortPolicy[] | null;
  allowlist?: readonly EBPFAllowlistEntry[] | null;
  /** Inbound and egress blocklists, for the 0.0.0.0/0 and ::/0 guards. */
  blocklist?: readonly EBPFIPListEntry[] | null;
  egressList?: readonly EBPFIPListEntry[] | null;
  /** sshd ports the host agent reported (host_info.ssh_ports); empty or missing = 22 assumed. */
  sshPorts?: readonly number[] | null;
  /** Agent gRPC port of the control plane; default 9090. */
  controlPlanePort?: number;
  /** Rule counts for the impact summary. */
  counts?: { blocklist?: number; egress?: number; geo?: number; ports?: number };
  /** Host agent liveness; undefined when unknown. */
  agentOnline?: boolean | null;
  /** Packets monitor-only mode would have dropped since the agent started. */
  wouldDropPackets?: number | null;
  now?: number;
}

export type FirewallChangeKind =
  | 'enable'
  | 'disable'
  | 'enforce'
  | 'leave-enforce'
  | 'deny-ingress'
  | 'deny-egress'
  | 'allow-ingress'
  | 'allow-egress'
  | 'port-policy-on'
  | 'port-policy-off'
  | 'conntrack-on'
  | 'conntrack-off';

const enforcing = (state: FirewallState) => state.enabled && !state.monitor_only;
const ingressDeny = (state: FirewallState) => state.port_policy_enabled && state.default_ingress === 'deny';
const egressDeny = (state: FirewallState) => state.port_policy_enabled && state.default_egress === 'deny';

/** What changes between two states, in a stable order. */
export function firewallChanges(previous: FirewallState, next: FirewallState): FirewallChangeKind[] {
  const changes: FirewallChangeKind[] = [];
  if (previous.enabled && !next.enabled) changes.push('disable');
  if (!previous.enabled && next.enabled) changes.push('enable');
  if (!enforcing(previous) && enforcing(next)) changes.push('enforce');
  if (enforcing(previous) && next.enabled && next.monitor_only) changes.push('leave-enforce');
  if (!previous.port_policy_enabled && next.port_policy_enabled) changes.push('port-policy-on');
  if (previous.port_policy_enabled && !next.port_policy_enabled) changes.push('port-policy-off');
  if (!ingressDeny(previous) && ingressDeny(next)) changes.push('deny-ingress');
  if (ingressDeny(previous) && !ingressDeny(next) && next.port_policy_enabled) changes.push('allow-ingress');
  if (!egressDeny(previous) && egressDeny(next)) changes.push('deny-egress');
  if (egressDeny(previous) && !egressDeny(next) && next.port_policy_enabled) changes.push('allow-egress');
  if (!previous.enable_conntrack && next.enable_conntrack) changes.push('conntrack-on');
  if (previous.enable_conntrack && !next.enable_conntrack) changes.push('conntrack-off');
  return changes;
}

const CHANGE_TEXT: Record<FirewallChangeKind, string> = {
  enable: 'Turn the firewall on',
  disable: 'Turn the firewall off',
  enforce: 'Switch from monitor-only to enforce: matching packets are dropped',
  'leave-enforce': 'Switch to monitor-only: matching packets are logged, not dropped',
  'deny-ingress': 'Set the ingress default to Deny all',
  'deny-egress': 'Set the egress default to Deny all',
  'allow-ingress': 'Set the ingress default back to Allow all',
  'allow-egress': 'Set the egress default back to Allow all',
  'port-policy-on': 'Turn port rules on',
  'port-policy-off': 'Turn port rules off',
  'conntrack-on': 'Turn connection tracking on',
  'conntrack-off': 'Turn connection tracking off',
};

export function describeChange(kind: FirewallChangeKind): string {
  return CHANGE_TEXT[kind];
}

/**
 * Confirmation tier of a change: disabling, leaving enforce and
 * Deny all are typed; entering enforce while a Deny all default is configured
 * activates it, so it is typed too; other switches are simple.
 */
export function firewallChangeTier(previous: FirewallState, next: FirewallState): ConfirmTier {
  const changes = firewallChanges(previous, next);
  const tiers: ConfirmTier[] = [
    tierForFirewallMode(previous, next),
    tierForPortPolicyConfig(
      { enabled: previous.port_policy_enabled, default_ingress: previous.default_ingress, default_egress: previous.default_egress },
      { enabled: next.port_policy_enabled, default_ingress: next.default_ingress, default_egress: next.default_egress },
    ),
  ];
  if ((changes.includes('enforce') || changes.includes('enable')) && (ingressDeny(next) || egressDeny(next)) && enforcing(next)) {
    tiers.push(tierFor('deny-all'));
  }
  if (changes.includes('conntrack-off')) tiers.push(tierFor('lower-protection'));
  return strictestTier(...tiers);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function listLabels(rules: readonly EBPFPortPolicy[], max = 4): string {
  const labels = rules.map((rule) => portRuleLabel(rule));
  const unique = [...new Set(labels)];
  return unique.length > max ? `${unique.slice(0, max).join(', ')} and ${unique.length - max} more` : unique.join(', ');
}

function impactSummary(ctx: LockoutContext): string {
  const counts = ctx.counts ?? {};
  const parts = [
    counts.blocklist !== undefined ? `blocklist (${plural(counts.blocklist, 'entry', 'entries')})` : 'blocklist',
    counts.geo !== undefined ? `geo-blocking (${plural(counts.geo, 'country', 'countries')})` : 'geo-blocking',
    counts.egress !== undefined ? `egress blocklist (${plural(counts.egress, 'entry', 'entries')})` : 'egress blocklist',
    counts.ports !== undefined ? `port rules (${plural(counts.ports, 'rule')})` : 'port rules',
  ];
  return parts.join(', ');
}

/**
 * Checks for moving from `previous` to `next`. Empty when the change touches
 * none of the switches that decide what the host drops.
 */
export function lockoutChecks(previous: FirewallState, next: FirewallState, ctx: LockoutContext = {}): LockoutCheck[] {
  const changes = firewallChanges(previous, next);
  if (!changes.length) return [];
  const now = ctx.now ?? Date.now();
  const checks: LockoutCheck[] = [];
  const has = (kind: FirewallChangeKind) => changes.includes(kind);
  const activates = has('enforce') || has('enable') || has('port-policy-on');

  if (ctx.agentOnline === false) {
    checks.push({
      id: 'agent-offline',
      status: 'warn',
      title: 'Host agent is offline',
      detail: 'The change is stored and reaches the host when its agent reconnects. This page cannot confirm when it takes effect.',
    });
  } else if (ctx.agentOnline === true) {
    checks.push({
      id: 'agent-online',
      status: 'pass',
      title: 'Host agent is online',
      detail: 'The agent receives the change within seconds; Configuration delivery on Overview shows when it is applied.',
    });
  }

  const allowlist = (ctx.allowlist ?? []).filter((entry) => !isExpired(entry.expires_at, now));
  const permanentAllowlist = allowlist.filter((entry) => !entry.expires_at);

  const conntrackCheck = (why: string): LockoutCheck =>
    next.enable_conntrack
      ? { id: 'conntrack', status: 'pass', title: 'Connection tracking is on', detail: 'Replies to connections this host opens and to inbound connections are recognised and let through.' }
      : { id: 'conntrack', status: 'fail', title: 'Connection tracking is off', detail: `${why} requires connection tracking: without it the replies would be dropped. Turn it on in Settings first.`, fix: 'settings' };
  let conntrackChecked = false;

  if (ingressDeny(next) && (has('deny-ingress') || activates || has('conntrack-off'))) {
    checks.push(conntrackCheck('Ingress deny all'));
    conntrackChecked = true;
    const reported = (ctx.sshPorts ?? []).length > 0;
    const ports = guardedSSHPorts(ctx.sshPorts);
    const portText = ports.map((p) => `${p}/tcp`).join(', ');
    checks.push(
      sshAllowed(ctx.portRules, ctx.sshPorts, now)
        ? { id: 'ssh-allow', status: 'pass', title: 'SSH stays open', detail: `A permanent ingress TCP ALLOW covers the SSH port (${portText}) and no other rule overrides it.` }
        : { id: 'ssh-allow', status: 'fail', title: 'SSH port is not always allowed', detail: `Add a permanent ingress ALLOW rule for ${portText} (TCP, or any protocol) in Access rules first. An expiring rule, or an expiring DROP on the same port, does not count. The control plane refuses the change otherwise (SSH_ALLOW_REQUIRED).`, fix: 'rules' },
    );
    if (!reported) {
      checks.push({ id: 'ssh-assumed', status: 'warn', title: 'SSH port assumed to be 22', detail: 'The host agent reported no sshd listener (socket-activated sshd, dropbear or a separate PID namespace), so 22/tcp is guarded. Make sure your real management port is allowed too.' });
    }
    const escapes = permanentAllowlist.filter((entry) => isLockoutEscape(entry, ctx.sshPorts));
    const scoped = allowlist.filter((entry) => (entry.ports ?? []).length > 0).length;
    const scopedNote = scoped ? ` ${plural(scoped, 'entry is', 'entries are')} scoped to ports and bypass Deny all only on those ports; on other ports, and for ICMP, they meet the normal checks.` : '';
    checks.push(
      escapes.length
        ? { id: 'allowlist', status: 'info', title: `${plural(escapes.length, 'permanent allowlist entry', 'permanent allowlist entries')} keep${escapes.length === 1 ? 's' : ''} management access`, detail: `Allowlisted sources pass before port rules on the ports they cover: all ports, or a scope that includes the SSH port over TCP.${scopedNote}` }
        : { id: 'allowlist', status: 'warn', title: 'No permanent allowlist entry that keeps management access', detail: `Consider allowlisting your management network, on all ports or scoped to the SSH port over TCP, so it keeps access even if a port rule is removed.${scopedNote}`, fix: 'rules' },
    );
  }

  if (egressDeny(next) && (has('deny-egress') || activates || has('conntrack-off'))) {
    if (!conntrackChecked) {
      checks.push(conntrackCheck('Egress deny all'));
      conntrackChecked = true;
    }
    checks.push({
      id: 'egress-exempt',
      status: 'info',
      title: 'Replies and the control plane stay open',
      detail: 'Replies to inbound connections (your SSH session included), the agent\'s own control-plane connection, DHCP client requests and IPv6 neighbour discovery always pass. Everything else outbound needs an egress ALLOW rule.',
    });
    const cpPort = ctx.controlPlanePort ?? DEFAULT_CONTROL_PLANE_PORT;
    checks.push(
      portAlwaysAllowed(ctx.portRules, cpPort, 'tcp', 'egress', now)
        ? { id: 'egress-control-plane', status: 'pass', title: 'Control-plane port allowed', detail: `A permanent egress ALLOW covers ${cpPort}/tcp.` }
        : { id: 'egress-control-plane', status: 'warn', title: `No permanent egress ALLOW for ${cpPort}/tcp`, detail: 'Current agents keep their own control-plane connection open; agents with older eBPF objects refuse this policy.', fix: 'rules' },
    );
    checks.push(
      portAlwaysAllowed(ctx.portRules, 53, 'udp', 'egress', now)
        ? { id: 'egress-dns', status: 'pass', title: 'DNS stays reachable', detail: 'A permanent egress ALLOW covers 53/udp.' }
        : { id: 'egress-dns', status: 'warn', title: 'No permanent egress ALLOW for DNS (53/udp)', detail: 'Name resolution stops, and with it package updates and most outbound clients. An agent that has not pinned the control-plane address yet refuses the policy (CONTROL_PLANE_UNPINNED).', fix: 'rules' },
    );
    const allows = egressAllows(ctx.portRules, now);
    checks.push(
      allows.length
        ? { id: 'egress-allow', status: 'info', title: 'Outbound ports that stay open', detail: listLabels(allows) + '.' }
        : { id: 'egress-allow', status: 'warn', title: 'No egress ALLOW rule', detail: 'All other outbound traffic from this host would be dropped.', fix: 'rules' },
    );
  }

  const inboundWildcards = wildcardFamilies(ctx.blocklist, now);
  const egressWildcards = wildcardFamilies(ctx.egressList, now);
  if ((inboundWildcards.length || egressWildcards.length) && has('conntrack-off') && !conntrackChecked) {
    checks.push({ id: 'conntrack', status: 'fail', title: 'A 0.0.0.0/0 or ::/0 blocklist entry needs connection tracking', detail: 'Remove the entry that blocks every address first, or keep connection tracking on (CONNTRACK_REQUIRED).', fix: 'rules' });
  }
  if (activates || has('conntrack-off')) {
    for (const family of inboundWildcards) {
      if (!hasPermanentAllowlistFamily(ctx.allowlist, family, ctx.sshPorts)) {
        checks.push({ id: `wildcard-allowlist-${family}`, status: 'fail', title: `Blocking every IPv${family} address without an IPv${family} allowlist entry`, detail: `Add a permanent IPv${family} allowlist entry for your management network first, on all ports or covering the SSH port over TCP; an entry scoped to other ports does not count (WILDCARD_BLOCK_NEEDS_ALLOWLIST).`, fix: 'rules' });
      }
    }
  }

  if ((ingressDeny(next) || egressDeny(next)) && (has('deny-ingress') || has('deny-egress') || has('port-policy-on')) && next.enabled && next.monitor_only) {
    checks.push({ id: 'monitor-only', status: 'info', title: 'Monitor-only mode', detail: 'Deny all is logged, not enforced, until you switch to Enforce.' });
  }

  if (has('enforce')) {
    const wouldDrop = ctx.wouldDropPackets;
    if (typeof wouldDrop === 'number' && wouldDrop > 0) {
      checks.push({ id: 'would-drop', status: 'warn', title: `${plural(wouldDrop, 'packet')} would have been dropped`, detail: 'Counted in monitor-only mode since the agent started. Review Top sources of dropped traffic and Live packet events to confirm none of it is your own traffic.', fix: 'overview' });
    } else if (wouldDrop === 0) {
      checks.push({ id: 'would-drop', status: 'pass', title: 'No packet would have been dropped', detail: 'Monitor-only mode recorded no would-drop packet since the agent started.' });
    } else {
      checks.push({ id: 'would-drop', status: 'info', title: 'Would-drop count unavailable', detail: 'The agent has not reported monitor-only counters; review Live events before enforcing.', fix: 'live' });
    }
    checks.push({ id: 'impact', status: 'info', title: 'Rules that start dropping', detail: impactSummary(ctx) + '.' });
  }

  if (has('disable') || has('leave-enforce')) {
    checks.push({
      id: 'impact',
      status: 'warn',
      title: has('disable') ? 'Protection stops' : 'Nothing is dropped any more',
      detail: `${impactSummary(ctx)} ${has('disable') ? 'stop filtering traffic' : 'are only logged'} on this host.`,
    });
  }

  if (has('port-policy-off')) {
    checks.push({ id: 'port-policy-off', status: 'warn', title: 'Port rules stop applying', detail: 'Drop rules no longer drop and the Deny all defaults are ignored.' });
  }

  if (has('conntrack-off') && !ingressDeny(next)) {
    checks.push({ id: 'conntrack-off', status: 'info', title: 'Connection tracking turns off', detail: 'Ingress deny all cannot be used while it is off.' });
  }

  return checks;
}

export function hasBlockingFailure(checks: readonly LockoutCheck[]): boolean {
  return checks.some((check) => check.status === 'fail');
}

/** Firewall state from a config/port-policy pair (either may be missing). */
export function firewallState(
  global: { enabled?: boolean; monitor_only?: boolean; enable_conntrack?: boolean } | null | undefined,
  portPolicy: { enabled?: boolean; default_ingress?: string; default_egress?: string } | null | undefined,
): FirewallState {
  return {
    enabled: global?.enabled ?? false,
    monitor_only: global?.monitor_only ?? false,
    enable_conntrack: global?.enable_conntrack ?? false,
    port_policy_enabled: portPolicy?.enabled ?? false,
    default_ingress: portPolicy?.default_ingress ?? 'allow',
    default_egress: portPolicy?.default_egress ?? 'allow',
  };
}
