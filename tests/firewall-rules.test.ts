// Firewall access rules, lockout checks and Settings draft helpers
import { describe, expect, test } from 'bun:test';
import type { EBPFFullConfig, EBPFIPListEntry, EBPFPortPolicy } from '../src/lib/api';
import {
  addWarnings,
  addressError,
  buildAccessRules,
  countByType,
  countryName,
  describeTtl,
  filterAccessRules,
  isCountryCode,
  isPermanentIngressAllow,
  matchesEverything,
  parseAddressList,
  parseCountryCodes,
  parsePortInput,
  portRuleKey,
  removalLocksOut,
  resolveTtl,
  timeLeft,
} from '../src/lib/components/firewall/rules';
import {
  firewallChanges,
  firewallChangeTier,
  firewallState,
  hasBlockingFailure,
  lockoutChecks,
  type FirewallState,
} from '../src/lib/components/firewall/lockout';
import {
  changedParts,
  countChanges,
  normalizeConfig,
  normalizePortPolicy,
  saveOrder,
  validateSettings,
  MAX_PORT_SCAN_UNIQUE_PORTS,
  type SettingsDraft,
} from '../src/lib/components/firewall/settings';
import { bundleStateNotes, firewallErrorMessage, firewallWarningsOf, mergeWarnings } from '../src/lib/components/firewall/guard-codes';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const entry = (ip: string, extra: Partial<EBPFIPListEntry> = {}): EBPFIPListEntry => ({ ip, added_at: '2026-09-27T10:00:00Z', hit_count: 3, ...extra });
const port = (p: number, extra: Partial<EBPFPortPolicy> = {}): EBPFPortPolicy => ({ port: p, proto: 'tcp', direction: 'ingress', action: 'allow', ...extra });

describe('addresses', () => {
  test('accepts addresses, prefixes and IPv4 ranges within the control-plane limits', () => {
    for (const ok of ['1.2.3.4', '2001:db8::1', '10.0.0.0/24', '10.0.0.1/24', '10.0.0.0/16', '2001:db8::/112', '1.2.3.1-1.2.3.50', '0.0.0.0/0', '::/0']) {
      expect(addressError(ok)).toBeNull();
    }
  });

  test('rejects malformed, reversed, oversized and IPv6 ranges with a reason', () => {
    expect(addressError('1.2.3')).toContain('IPv4 or IPv6');
    expect(addressError('1::2::3')).toContain('IPv4 or IPv6');
    expect(addressError('1.2.3.50-1.2.3.1')).toContain('reversed');
    expect(addressError('10.0.0.0-10.2.0.0')).toContain('limit');
    expect(addressError('2001:db8::1-2001:db8::9')).toContain('IPv4 only');
    expect(addressError('10.0.0.0/15')).toContain('/16');
    expect(addressError('2001:db8::/64')).toContain('/112');
    expect(addressError('10.0.0.0/33')).toContain('CIDR');
    expect(addressError('1.2.3.4-5.6.7.8-9.9.9.9')).toContain('exactly one');
  });

  test('parses a pasted list and reports invalid entries separately', () => {
    const result = parseAddressList('1.2.3.4, 5.6.7.8\n# office\n10.0.0.0/24  bogus\n1.2.3.4');
    expect(result.valid).toEqual(['1.2.3.4', '5.6.7.8', '10.0.0.0/24']);
    expect(result.invalid.map((item) => item.value)).toEqual(['bogus']);
  });

  test('flags prefixes that match every address', () => {
    expect(matchesEverything('0.0.0.0/0')).toBe(true);
    expect(matchesEverything('::/0')).toBe(true);
    expect(matchesEverything('10.0.0.0/8')).toBe(false);
  });
});

describe('countries and ports', () => {
  test('country codes are validated against known regions', () => {
    expect(isCountryCode('cn')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode('USA')).toBe(false);
    expect(countryName('DE')).toBe('Germany');
    expect(parseCountryCodes('cn, ru ir;QQ')).toEqual({ valid: ['CN', 'RU', 'IR'], invalid: ['QQ'] });
  });

  test('port input accepts a deduplicated list and caps the batch', () => {
    expect(parsePortInput('22, 443 22')).toEqual({ ports: [22, 443], invalid: [], error: null });
    expect(parsePortInput('0, 70000').error).toContain('Not a port');
    expect(parsePortInput('').error).toContain('at least one');
    expect(parsePortInput(Array.from({ length: 21 }, (_, i) => String(i + 1)).join(',')).error).toContain('at most 20');
  });
});

describe('TTL', () => {
  test('chips map to milliseconds and permanent to no ttl', () => {
    expect(resolveTtl('15m')).toEqual({ ms: 900_000, error: null });
    expect(resolveTtl('24h')).toEqual({ ms: 86_400_000, error: null });
    expect(resolveTtl('permanent')).toEqual({ ms: undefined, error: null });
  });

  test('custom expiry is a whole positive amount up to a year', () => {
    expect(resolveTtl('custom', { amount: 3, unit: 'days' })).toEqual({ ms: 3 * 86_400_000, error: null });
    expect(resolveTtl('custom', { amount: '', unit: 'hours' }).error).not.toBeNull();
    expect(resolveTtl('custom', { amount: 1.5, unit: 'hours' }).error).not.toBeNull();
    expect(resolveTtl('custom', { amount: 400, unit: 'days' }).error).toContain('365');
  });

  test('describes TTLs and time left', () => {
    expect(describeTtl(undefined)).toBe('Permanent');
    expect(describeTtl(3_600_000)).toBe('1h');
    expect(describeTtl(2 * 86_400_000)).toBe('2d');
    expect(timeLeft(undefined, NOW)).toBe('Permanent');
    expect(timeLeft('2026-09-27T12:10:00Z', NOW)).toBe('10 min left');
    expect(timeLeft('2026-09-27T11:00:00Z', NOW)).toBe('Expiring');
  });
});

describe('access rule table', () => {
  const rules = buildAccessRules({
    blocklist: [entry('1.2.3.4'), entry('10.0.0.0/24', { expires_at: '2026-09-27T13:00:00Z' }), entry('9.9.9.9', { expires_at: '2026-09-27T11:00:00Z' })],
    allowlist: [entry('192.0.2.10')],
    egress: [entry('203.0.113.5')],
    geo: [{ code: 'cn', blocked: true }, { code: 'RU', blocked: false }],
    ports: [port(22), port(8080, { action: 'drop', proto: 'udp', direction: 'egress', ttl_ms: 60_000 })],
  }, NOW);

  test('merges the five lists and drops expired entries', () => {
    expect(rules.map((rule) => rule.key)).toEqual([
      'block:1.2.3.4',
      'block:10.0.0.0/24',
      'allow:192.0.2.10',
      'egress:203.0.113.5',
      'geo:CN',
      'port:22/tcp/ingress',
      'port:8080/udp/egress',
    ]);
    expect(countByType(rules)).toEqual({ block: 2, allow: 1, egress: 1, geo: 1, port: 2 });
  });

  test('rows carry action, direction, permanence and subnet flags', () => {
    const subnet = rules.find((rule) => rule.key === 'block:10.0.0.0/24')!;
    expect(subnet).toMatchObject({ action: 'drop', direction: 'ingress', subnet: true, permanent: false });
    const geo = rules.find((rule) => rule.type === 'geo')!;
    expect(geo.label).toContain('China');
    expect(geo).toMatchObject({ target: 'CN', hits: null, permanent: true });
    expect(rules.find((rule) => rule.key === 'port:8080/udp/egress')).toMatchObject({ action: 'drop', direction: 'egress', permanent: false });
  });

  test('filters by type and text', () => {
    expect(filterAccessRules(rules, { type: 'port' })).toHaveLength(2);
    expect(filterAccessRules(rules, { query: 'china' }).map((rule) => rule.key)).toEqual(['geo:CN']);
    expect(filterAccessRules(rules, { type: 'block', query: '10.0' })).toHaveLength(1);
  });
});

describe('ingress allow guard', () => {
  test('only non-expiring ingress allow rules on a real port count', () => {
    expect(isPermanentIngressAllow(port(22))).toBe(true);
    expect(isPermanentIngressAllow(port(22, { direction: 'both' }))).toBe(true);
    expect(isPermanentIngressAllow(port(22, { direction: 'egress' }))).toBe(false);
    expect(isPermanentIngressAllow(port(22, { ttl_ms: 60_000 }))).toBe(false);
    expect(isPermanentIngressAllow(port(22, { expires_at: '2026-10-01T00:00:00Z' }))).toBe(false);
    expect(isPermanentIngressAllow(port(22, { action: 'drop' }))).toBe(false);
    expect(isPermanentIngressAllow(port(0))).toBe(false);
  });

  test('removing the rule that keeps SSH open under ingress Deny all locks the host out', () => {
    const deny = { enabled: true, default_ingress: 'deny' };
    const ssh = port(22);
    expect(removalLocksOut(ssh, [ssh], deny)).toBe(true);
    // Another port does not keep SSH open any more; another SSH rule does.
    expect(removalLocksOut(ssh, [ssh, port(443)], deny)).toBe(true);
    expect(removalLocksOut(ssh, [ssh, port(22, { proto: 'any' })], deny)).toBe(false);
    // Reported sshd port 2222: the 22 rule is not the guard.
    expect(removalLocksOut(ssh, [ssh, port(2222)], deny, [2222])).toBe(false);
    expect(removalLocksOut(port(2222), [ssh, port(2222)], deny, [2222])).toBe(true);
    expect(removalLocksOut(ssh, [ssh], { enabled: false, default_ingress: 'deny' })).toBe(false);
    expect(removalLocksOut(ssh, [ssh], { enabled: true, default_ingress: 'allow' })).toBe(false);
    expect(removalLocksOut(port(8080, { action: 'drop' }), [ssh, port(8080, { action: 'drop' })], deny)).toBe(false);
    expect(portRuleKey({ port: 22, proto: 'TCP', direction: '' })).toBe('22/tcp/ingress');
  });
});

describe('lockout checks', () => {
  const base: FirewallState = firewallState(
    { enabled: true, monitor_only: true, enable_conntrack: true },
    { enabled: true, default_ingress: 'allow', default_egress: 'allow' },
  );
  const with_ = (patch: Partial<FirewallState>): FirewallState => ({ ...base, ...patch });
  const ids = (checks: ReturnType<typeof lockoutChecks>) => checks.map((check) => `${check.id}:${check.status}`);

  test('no change, no checks', () => {
    expect(lockoutChecks(base, base)).toEqual([]);
    expect(firewallChanges(base, base)).toEqual([]);
  });

  test('ingress Deny all without conntrack or a permanent allow rule is blocked', () => {
    const next = with_({ default_ingress: 'deny', enable_conntrack: false });
    const checks = lockoutChecks(base, next, { portRules: [port(22, { ttl_ms: 60_000 })], agentOnline: true });
    expect(ids(checks)).toContain('conntrack:fail');
    expect(ids(checks)).toContain('ssh-allow:fail');
    expect(ids(checks)).toContain('ssh-assumed:warn');
    expect(hasBlockingFailure(checks)).toBe(true);
  });

  test('ingress Deny all with conntrack and a permanent allow rule passes', () => {
    const next = with_({ default_ingress: 'deny' });
    const checks = lockoutChecks(base, next, { portRules: [port(22)], allowlist: [entry('192.0.2.10')], agentOnline: true, sshPorts: [22] });
    expect(ids(checks)).toEqual(['agent-online:pass', 'conntrack:pass', 'ssh-allow:pass', 'allowlist:info', 'monitor-only:info']);
    expect(hasBlockingFailure(checks)).toBe(false);
    expect(firewallChangeTier(base, next)).toBe('typed');
  });

  test('turning conntrack off under Deny all fails', () => {
    const prev = with_({ default_ingress: 'deny' });
    const checks = lockoutChecks(prev, with_({ default_ingress: 'deny', enable_conntrack: false }), { portRules: [port(22)] });
    expect(ids(checks)).toContain('conntrack:fail');
  });

  test('egress Deny all: conntrack, exemptions, control-plane and DNS rules', () => {
    const checks = lockoutChecks(base, with_({ default_egress: 'deny' }), { portRules: [port(443, { direction: 'egress' })] });
    expect(ids(checks)).toEqual(['conntrack:pass', 'egress-exempt:info', 'egress-control-plane:warn', 'egress-dns:warn', 'egress-allow:info', 'monitor-only:info']);
    const ok = lockoutChecks(base, with_({ default_egress: 'deny' }), {
      portRules: [port(9090, { direction: 'egress' }), port(53, { proto: 'udp', direction: 'egress' })],
    });
    expect(ids(ok)).toContain('egress-control-plane:pass');
    expect(ids(ok)).toContain('egress-dns:pass');
    const noCt = lockoutChecks(base, with_({ default_egress: 'deny', enable_conntrack: false }), { portRules: [] });
    expect(ids(noCt)).toContain('conntrack:fail');
    expect(noCt.find((c) => c.id === 'egress-exempt')?.detail).toContain('Replies to inbound connections');
  });

  test('an expiring DROP ahead of the SSH allow fails, the exact protocol wins over any', () => {
    const next = with_({ default_ingress: 'deny' });
    const drop = port(22, { proto: 'tcp', action: 'drop', ttl_ms: 60_000 });
    expect(ids(lockoutChecks(base, next, { portRules: [port(22, { proto: 'any' }), drop], sshPorts: [22] }))).toContain('ssh-allow:fail');
    expect(ids(lockoutChecks(base, next, { portRules: [port(22, { proto: 'any', action: 'drop' }), port(22)], sshPorts: [22] }))).toContain('ssh-allow:pass');
    expect(ids(lockoutChecks(base, next, { portRules: [port(22, { proto: 'udp' })], sshPorts: [22] }))).toContain('ssh-allow:fail');
  });

  test('a wildcard blocklist entry needs a same-family permanent allowlist entry and conntrack', () => {
    const enforce = with_({ monitor_only: false });
    const blocklist = [entry('0.0.0.0/0')];
    expect(ids(lockoutChecks(base, enforce, { blocklist, allowlist: [entry('2001:db8::1')] }))).toContain('wildcard-allowlist-4:fail');
    expect(ids(lockoutChecks(base, enforce, { blocklist, allowlist: [entry('192.0.2.0/24')] }))).not.toContain('wildcard-allowlist-4:fail');
    expect(ids(lockoutChecks(base, enforce, { blocklist, allowlist: [entry('192.0.2.0/24', { expires_at: '2026-12-01T00:00:00Z' })] }))).toContain('wildcard-allowlist-4:fail');
    expect(ids(lockoutChecks(base, with_({ enable_conntrack: false }), { blocklist, allowlist: [entry('192.0.2.1')] }))).toContain('conntrack:fail');
  });

  test('enforce reports would-drop evidence and escalates when Deny all becomes active', () => {
    const enforce = with_({ monitor_only: false });
    expect(ids(lockoutChecks(base, enforce, { wouldDropPackets: 12, agentOnline: false }))).toEqual(['agent-offline:warn', 'would-drop:warn', 'impact:info']);
    expect(ids(lockoutChecks(base, enforce, { wouldDropPackets: 0 }))).toContain('would-drop:pass');
    expect(firewallChangeTier(base, enforce)).toBe('simple');
    const denyPrev = with_({ default_ingress: 'deny' });
    const denyEnforce = with_({ default_ingress: 'deny', monitor_only: false });
    expect(firewallChangeTier(denyPrev, denyEnforce)).toBe('typed');
    expect(ids(lockoutChecks(denyPrev, denyEnforce, { portRules: [] }))).toContain('ssh-allow:fail');
  });

  test('disable and leave-enforce are typed and summarise the impact', () => {
    const enforcing = with_({ monitor_only: false });
    expect(firewallChangeTier(enforcing, with_({ monitor_only: true }))).toBe('typed');
    expect(firewallChangeTier(enforcing, with_({ enabled: false, monitor_only: false }))).toBe('typed');
    const checks = lockoutChecks(enforcing, with_({ enabled: false, monitor_only: false }), { counts: { blocklist: 2, geo: 1, egress: 0, ports: 3 } });
    expect(checks.find((check) => check.id === 'impact')?.detail).toContain('blocklist (2 entries), geo-blocking (1 country), egress blocklist (0 entries), port rules (3 rules)');
  });
});

describe('settings draft', () => {
  const config: EBPFFullConfig = {
    global: { enabled: true, monitor_only: true, log_allowed: false, log_blocked: true, enable_conntrack: true, enable_synflood: true, enable_ratelimit: false, enable_geoblock: false, max_payload_bytes: 0 },
    rate: { window_ms: 1000, max_pps: 100, max_bps: 0, max_syn_pps: 10, burst_pps: 10, burst_syn: 5, drop_on_limit: true },
    anomaly: { detect_xmas: true, detect_null: true, detect_fin_only: false, drop_on_detect: false },
    port_scan: { enabled: true, window_ms: 10_000, max_unique_ports: 20, drop_on_detect: true },
  };
  const draft = (): SettingsDraft => ({ config: structuredClone(config), portPolicy: normalizePortPolicy({ enabled: true, default_ingress: 'deny' }) });

  test('normalizes partial agent answers', () => {
    expect(normalizeConfig({})).toBeNull();
    const { port_scan: _omit, ...legacy } = config;
    expect(normalizeConfig(legacy)?.port_scan).toEqual({ enabled: false, window_ms: 10_000, max_unique_ports: 20, drop_on_detect: true });
    expect(normalizePortPolicy(null)).toEqual({ enabled: false, default_ingress: 'allow', default_egress: 'allow' });
  });

  test('validation mirrors the control-plane bounds', () => {
    expect(validateSettings(draft())).toEqual({});
    const bad = draft();
    bad.config.rate.window_ms = 5;
    bad.config.port_scan.max_unique_ports = 500;
    bad.config.global.max_payload_bytes = -1;
    expect(Object.keys(validateSettings(bad)).sort()).toEqual(['global.max_payload_bytes', 'port_scan.max_unique_ports', 'rate.window_ms']);
    bad.config.port_scan.enabled = false;
    expect(validateSettings(bad)['port_scan.max_unique_ports']).toBeUndefined();
  });

  test('port-scan threshold stops at the XDP table size', () => {
    const ok = draft();
    ok.config.port_scan.max_unique_ports = MAX_PORT_SCAN_UNIQUE_PORTS;
    expect(validateSettings(ok)['port_scan.max_unique_ports']).toBeUndefined();
    const over = draft();
    over.config.port_scan.max_unique_ports = MAX_PORT_SCAN_UNIQUE_PORTS + 1;
    expect(validateSettings(over)['port_scan.max_unique_ports']).toBe('Use 1 to 32 ports.');
  });

  test('counts changed fields and orders saves so every step is valid', () => {
    const a = draft();
    const b = draft();
    b.config.global.monitor_only = false;
    b.config.rate.max_pps = 200;
    expect(countChanges(a, b)).toBe(2);
    expect(changedParts(a, b)).toEqual({ config: true, portPolicy: false });
    expect(saveOrder(b)).toEqual(['config', 'portPolicy']);
    b.portPolicy.default_ingress = 'allow';
    expect(saveOrder(b)).toEqual(['portPolicy', 'config']);
  });
});

describe('guard codes and host bundle states', () => {
  test('errors add a hint; the old INGRESS_ALLOW_REQUIRED is still understood', () => {
    expect(firewallErrorMessage({ error: 'refused', code: 'SSH_ALLOW_REQUIRED' })).toContain('SSH port');
    expect(firewallErrorMessage({ error: 'refused', code: 'INGRESS_ALLOW_REQUIRED' })).toContain('management port');
    expect(firewallErrorMessage({ error: 'plain' })).toBe('plain');
    expect(firewallErrorMessage({ error: 'refused', code: 'PORT_POLICY_INVALID' })).not.toBe('refused');
    expect(firewallErrorMessage({ error: 'refused', code: 'OTHER' })).toBe('refused');
  });

  test('warnings are read from an accepted save and deduplicated', () => {
    const w = firewallWarningsOf({ status: 'ok', warnings: [{ code: 'SSH_PORT_ASSUMED', message: 'm' }, { nope: 1 }] });
    expect(w).toEqual([{ code: 'SSH_PORT_ASSUMED', message: 'm' }]);
    expect(firewallWarningsOf({ status: 'ok' })).toEqual([]);
    expect(mergeWarnings(w, w)).toHaveLength(1);
  });

  test('bundle_status notes: refused, saved policy, DNS relaxed', () => {
    const notes = bundleStateNotes({ status: 'refused', code: 'SSH_ALLOW_REQUIRED', source: 'saved', saved_generation: '7', dns_relaxed: true });
    expect(notes.map((n) => n.title)).toEqual(['Apply refused (SSH_ALLOW_REQUIRED)', 'Running saved policy', 'DNS relaxed until control plane pinned']);
    expect(notes[1].message).toContain('generation 7');
    expect(bundleStateNotes({ status: 'applied', source: 'live' })).toEqual([]);
    expect(bundleStateNotes(undefined)).toEqual([]);
  });

  test('adding a wildcard block warns about the allowlist and conntrack guards', () => {
    const request = { type: 'block' as const, addresses: ['0.0.0.0/0'], ttlMs: undefined };
    const warnings = addWarnings(request as Parameters<typeof addWarnings>[0], { conntrack: false, allowlist: [] });
    expect(warnings.some((w) => w.includes('WILDCARD_BLOCK_NEEDS_ALLOWLIST'))).toBe(true);
    expect(warnings.some((w) => w.includes('CONNTRACK_REQUIRED'))).toBe(true);
    expect(addWarnings(request as Parameters<typeof addWarnings>[0], { conntrack: true, allowlist: [entry('10.0.0.0/8')] }).some((w) => w.includes('WILDCARD'))).toBe(false);
  });
});
