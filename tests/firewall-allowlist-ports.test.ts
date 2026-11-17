// Port-scoped allowlist entries: port
// scope parsing/normalising, the lockout-escape rule, row badges and the
// guard codes the add can return.
import { describe, expect, test } from 'bun:test';
import type { EBPFAllowlistEntry } from '../src/lib/api';
import {
  addWarnings,
  allowAddProblem,
  allowPortPresets,
  allowPortsLabel,
  buildAccessRules,
  describeAdd,
  filterAccessRules,
  formatPortScope,
  hasPermanentAllowlistFamily,
  hasPortToken,
  isLockoutEscape,
  normalizePortScopes,
  parsePortScopeItem,
  parsePortScopes,
  togglePortToken,
} from '../src/lib/components/firewall/rules';
import { lockoutChecks, type FirewallState } from '../src/lib/components/firewall/lockout';
import { firewallErrorFix, firewallErrorMessage, firewallWarningText, isFirewallGuardCode } from '../src/lib/components/firewall/guard-codes';
import { allowlistBadgeTone } from '../src/lib/tone';

const entry = (ip: string, extra: Partial<EBPFAllowlistEntry> = {}): EBPFAllowlistEntry => ({ ip, added_at: '2026-10-01T00:00:00Z', hit_count: 0, ...extra });

describe('port scope items', () => {
  test('single ports, ranges and protocols', () => {
    expect(parsePortScopeItem('22/tcp').scope).toEqual({ proto: 'tcp', from: 22 });
    expect(parsePortScopeItem('8000-8100/UDP').scope).toEqual({ proto: 'udp', from: 8000, to: 8100 });
    expect(parsePortScopeItem('53/any').scope).toEqual({ proto: 'any', from: 53 });
    expect(parsePortScopeItem('53/tcp+udp').scope).toEqual({ proto: 'any', from: 53 });
    expect(parsePortScopeItem('80-80/tcp').scope).toEqual({ proto: 'tcp', from: 80 });
  });

  test('rejects what the server rejects (INVALID_PORTS)', () => {
    expect(parsePortScopeItem('0/tcp').error).toContain('1 to 65535');
    expect(parsePortScopeItem('65536/tcp').error).toContain('1 to 65535');
    expect(parsePortScopeItem('100-90/tcp').error).toContain('reversed');
    expect(parsePortScopeItem('22/icmp').error).toContain('tcp, udp or any');
    expect(parsePortScopeItem('22').error).toContain('22/tcp');
    expect(parsePortScopeItem('8000-8100').error).toContain('8000-8100/tcp');
    expect(parsePortScopeItem('ssh').scope).toBeNull();
    expect(parsePortScopeItem('-5/tcp').scope).toBeNull();
  });

  test('formats single ports, ranges and any', () => {
    expect(formatPortScope({ proto: 'tcp', from: 22 })).toBe('22/tcp');
    expect(formatPortScope({ proto: 'tcp', from: 22, to: 0 })).toBe('22/tcp');
    expect(formatPortScope({ proto: 'udp', from: 8000, to: 8100 })).toBe('8000-8100/udp');
    expect(formatPortScope({ proto: 'any', from: 53 })).toBe('53/any');
  });
});

describe('normalising and limits', () => {
  test('sorts by port and merges overlapping or adjacent ranges of one protocol', () => {
    expect(normalizePortScopes([
      { proto: 'tcp', from: 5432 },
      { proto: 'tcp', from: 22 },
      { proto: 'tcp', from: 23, to: 25 },
      { proto: 'tcp', from: 24, to: 30 },
    ])).toEqual([{ proto: 'tcp', from: 22, to: 30 }, { proto: 'tcp', from: 5432 }]);
  });

  test('keeps tcp and udp apart and drops ranges inside an any range', () => {
    expect(normalizePortScopes([
      { proto: 'udp', from: 53 },
      { proto: 'tcp', from: 53 },
      { proto: 'any', from: 50, to: 60 },
      { proto: 'tcp', from: 55, to: 70 },
    ])).toEqual([{ proto: 'any', from: 50, to: 60 }, { proto: 'tcp', from: 55, to: 70 }]);
    expect(normalizePortScopes([{ proto: 'tcp', from: 80 }, { proto: 'udp', from: 80 }])).toEqual([{ proto: 'tcp', from: 80 }, { proto: 'udp', from: 80 }]);
  });

  test('parses a list, duplicates collapse', () => {
    const result = parsePortScopes('22/tcp, 5432/tcp\n8000-8100/udp 53/any; 22/tcp');
    expect(result.error).toBeNull();
    expect(result.scopes.map(formatPortScope)).toEqual(['22/tcp', '53/any', '5432/tcp', '8000-8100/udp']);
  });

  test('at most 8 items after merging (ALLOWLIST_PORTS_TOO_MANY)', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `${1000 + i * 10}/tcp`).join(', ');
    expect(parsePortScopes(nine).error).toContain('at most 8');
    // Nine adjacent ports merge into one range and pass.
    const adjacent = Array.from({ length: 9 }, (_, i) => `${1000 + i}/tcp`).join(', ');
    expect(parsePortScopes(adjacent).scopes).toEqual([{ proto: 'tcp', from: 1000, to: 1008 }]);
    const eight = Array.from({ length: 8 }, (_, i) => `${1000 + i * 10}/tcp`).join(', ');
    expect(parsePortScopes(eight).error).toBeNull();
    // An any range swallowing tcp items brings the count under the limit.
    expect(parsePortScopes(`${nine}, 1000-1100/any`).scopes).toEqual([{ proto: 'any', from: 1000, to: 1100 }]);
  });

  test('empty and invalid input', () => {
    expect(parsePortScopes('  ').error).toContain('All ports');
    expect(parsePortScopes('22/tcp, 70000/udp').error).toContain('70000/udp');
    expect(parsePortScopes('x, y').invalid).toHaveLength(2);
  });

  test('wildcard prefixes cannot be scoped (ALLOWLIST_WILDCARD_SCOPED)', () => {
    expect(allowAddProblem(['0.0.0.0/0'], [{ proto: 'tcp', from: 22 }])).toContain('port rule');
    expect(allowAddProblem(['::/0', '192.0.2.1'], [{ proto: 'tcp', from: 22 }])).toContain('::/0');
    expect(allowAddProblem(['0.0.0.0/0'], [])).toBeNull();
    expect(allowAddProblem(['192.0.2.0/24'], [{ proto: 'tcp', from: 22 }])).toBeNull();
  });
});

describe('presets', () => {
  test('detected SSH ports first, 22 when none reported', () => {
    expect(allowPortPresets([]).map((p) => p.label)).toEqual(['SSH (22/tcp)', 'HTTPS (443/tcp)', 'PostgreSQL (5432/tcp)']);
    expect(allowPortPresets([2222, 22]).slice(0, 2).map((p) => p.token)).toEqual(['2222/tcp', '22/tcp']);
    // An SSH port on 443 is not listed twice.
    expect(allowPortPresets([443]).map((p) => p.token)).toEqual(['443/tcp', '5432/tcp']);
  });

  test('toggle adds and removes a token', () => {
    expect(togglePortToken('', '22/tcp')).toBe('22/tcp');
    expect(togglePortToken('5432/tcp', '22/tcp')).toBe('5432/tcp, 22/tcp');
    expect(togglePortToken('22/TCP, 5432/tcp', '22/tcp')).toBe('5432/tcp');
    expect(hasPortToken('5432/tcp,22/tcp', '22/tcp')).toBe(true);
    expect(hasPortToken('2222/tcp', '22/tcp')).toBe(false);
  });
});

describe('lockout escape', () => {
  test('unscoped permanent entry is an escape', () => {
    expect(isLockoutEscape(entry('192.0.2.0/24'))).toBe(true);
    expect(isLockoutEscape(entry('192.0.2.0/24', { ports: [] }))).toBe(true);
  });

  test('scoped entry for other ports is not', () => {
    expect(isLockoutEscape(entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 5432 }] }))).toBe(false);
    expect(isLockoutEscape(entry('192.0.2.1', { ports: [{ proto: 'udp', from: 22 }] }))).toBe(false);
  });

  test('scoped 22/tcp, or any covering 22, is', () => {
    expect(isLockoutEscape(entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 22 }] }))).toBe(true);
    expect(isLockoutEscape(entry('192.0.2.1', { ports: [{ proto: 'any', from: 20, to: 30 }] }))).toBe(true);
    expect(isLockoutEscape(entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 1, to: 1024 }] }))).toBe(true);
  });

  test('expiring never is', () => {
    expect(isLockoutEscape(entry('192.0.2.1', { expires_at: '2099-01-01T00:00:00Z' }))).toBe(false);
    expect(isLockoutEscape(entry('192.0.2.1', { expires_at: '2099-01-01T00:00:00Z', lockout_escape: true }))).toBe(false);
  });

  test('detected non-22 SSH port', () => {
    const on22 = entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 22 }] });
    const on2222 = entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 2222 }] });
    expect(isLockoutEscape(on22, [2222])).toBe(false);
    expect(isLockoutEscape(on2222, [2222])).toBe(true);
    expect(isLockoutEscape(on2222, [])).toBe(false);
  });

  test('the server flag wins over the local computation', () => {
    expect(isLockoutEscape(entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 5432 }], lockout_escape: true }))).toBe(true);
    expect(isLockoutEscape(entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 22 }], lockout_escape: false }))).toBe(false);
  });

  test('wildcard block guard counts only escapes of the family', () => {
    expect(hasPermanentAllowlistFamily([entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 5432 }] })], 4)).toBe(false);
    expect(hasPermanentAllowlistFamily([entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 22 }] })], 4)).toBe(true);
    expect(hasPermanentAllowlistFamily([entry('2001:db8::1')], 4)).toBe(false);
    const warnings = addWarnings({ type: 'block', addresses: ['0.0.0.0/0'] }, { allowlist: [entry('192.0.2.1', { ports: [{ proto: 'tcp', from: 443 }] })] });
    expect(warnings.some((w) => w.includes('WILDCARD_BLOCK_NEEDS_ALLOWLIST'))).toBe(true);
  });

  test('lockout checks refuse a wildcard block backed only by a scoped non-SSH entry', () => {
    const base: FirewallState = { enabled: true, monitor_only: true, enable_conntrack: true, port_policy_enabled: false, default_ingress: 'allow', default_egress: 'allow' };
    const enforce = { ...base, monitor_only: false };
    const blocklist = [entry('0.0.0.0/0')];
    const ids = (checks: ReturnType<typeof lockoutChecks>) => checks.map((c) => `${c.id}:${c.status}`);
    expect(ids(lockoutChecks(base, enforce, { blocklist, allowlist: [entry('192.0.2.0/24', { ports: [{ proto: 'tcp', from: 443 }] })] }))).toContain('wildcard-allowlist-4:fail');
    expect(ids(lockoutChecks(base, enforce, { blocklist, allowlist: [entry('192.0.2.0/24', { ports: [{ proto: 'tcp', from: 22 }] })] }))).not.toContain('wildcard-allowlist-4:fail');
  });
});

describe('allowlist rows', () => {
  test('ports badge text and lockout escape flag', () => {
    const rows = buildAccessRules({
      allowlist: [
        entry('192.0.2.1'),
        entry('192.0.2.2', { ports: [{ proto: 'tcp', from: 22 }, { proto: 'tcp', from: 5432 }] }),
        entry('192.0.2.3', { ports: [{ proto: 'udp', from: 8000, to: 8100 }, { proto: 'any', from: 53 }], lockout_escape: false }),
      ],
      sshPorts: [],
    });
    expect(rows.map((row) => allowPortsLabel(row.ports))).toEqual(['All ports', '22/tcp, 5432/tcp', '8000-8100/udp, 53/any']);
    expect(rows.map((row) => row.lockoutEscape)).toEqual([true, true, false]);
    expect(filterAccessRules(rows, { query: '5432' }).map((row) => row.target)).toEqual(['192.0.2.2']);
  });

  test('other list rows carry no ports', () => {
    const [row] = buildAccessRules({ blocklist: [entry('198.51.100.1')] });
    expect(row.ports).toBeUndefined();
    expect(row.lockoutEscape).toBeUndefined();
  });

  test('badge tones are not verdict colours', () => {
    expect(allowlistBadgeTone('ports')).toBe('neutral');
    expect(allowlistBadgeTone('lockout-escape')).toBe('info');
  });
});

describe('add review text', () => {
  test('describes scoped and unscoped adds', () => {
    expect(describeAdd({ type: 'allow', addresses: ['192.0.2.1'], ports: [{ proto: 'tcp', from: 22 }] })).toBe('Allow 1 source address past the inbound checks on 22/tcp only, permanent');
    expect(describeAdd({ type: 'allow', addresses: ['192.0.2.1'] })).toBe('Allow 1 source address past every inbound check on every port, permanent');
  });

  test('warnings say what a scoped entry bypasses', () => {
    const scoped = addWarnings({ type: 'allow', addresses: ['192.0.2.1'], ports: [{ proto: 'tcp', from: 5432 }] });
    expect(scoped[0]).toContain('only on 5432/tcp');
    expect(scoped[0]).toContain('ICMP');
    expect(addWarnings({ type: 'allow', addresses: ['192.0.2.1'] })[0]).toContain('every port');
  });

  test('re-adding replaces ports and flags a lost escape', () => {
    const ctx = { allowlist: [entry('192.0.2.1')] };
    const warnings = addWarnings({ type: 'allow', addresses: ['192.0.2.1'], ports: [{ proto: 'tcp', from: 5432 }] }, ctx);
    expect(warnings.some((w) => w.includes('already allowlisted'))).toBe(true);
    expect(warnings.some((w) => w.includes('stops being a lockout escape'))).toBe(true);
    const keeps = addWarnings({ type: 'allow', addresses: ['192.0.2.1'], ports: [{ proto: 'tcp', from: 22 }] }, ctx);
    expect(keeps.some((w) => w.includes('lockout escape'))).toBe(false);
    const expiring = addWarnings({ type: 'allow', addresses: ['192.0.2.1'], ttlMs: 3_600_000 }, ctx);
    expect(expiring.some((w) => w.includes('stops being a lockout escape'))).toBe(true);
  });
});

describe('guard codes', () => {
  test('new codes have hints and fix targets', () => {
    for (const code of ['INVALID_PORTS', 'ALLOWLIST_PORTS_TOO_MANY', 'ALLOWLIST_WILDCARD_SCOPED', 'ALLOWLIST_PORTS_UNSUPPORTED', 'GEO_ALLOW_NO_ESCAPE']) {
      expect(isFirewallGuardCode(code)).toBe(true);
    }
    expect(firewallErrorFix('INVALID_PORTS')).toBe('rules');
    expect(firewallErrorFix('ALLOWLIST_PORTS_UNSUPPORTED')).toBeUndefined();
    expect(firewallErrorMessage({ error: 'host lacks the feature', code: 'ALLOWLIST_PORTS_UNSUPPORTED' })).toContain('eBPF objects');
  });

  test('a known warning code gets its hint', () => {
    expect(firewallWarningText({ code: 'GEO_ALLOW_NO_ESCAPE', message: 'Geo allow mode has no escape.' })).toContain('SSH port over TCP');
    expect(firewallWarningText({ code: 'SSH_PORT_ASSUMED', message: 'Assumed 22.' })).toBe('Assumed 22.');
  });
});
