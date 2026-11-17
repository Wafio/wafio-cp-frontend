// Host inventory helpers (routes/projects/[id]/hosts/host-info.ts) and the
// Firewall URL state (lib/components/firewall/tabs.ts).
import { describe, expect, test } from 'bun:test';
import {
  bpfLsmState,
  hostDisks,
  hostInfoBytes,
  hostInfoDisplay,
  hostInfoText,
  hostInterfaces,
  hostLoadAverage,
  hostNameError,
  hostSummary,
  parseLabels,
  usedPercent,
} from '../src/routes/projects/[id]/hosts/host-info';
import { DEFAULT_FIREWALL_TAB, firewallSearch, readFirewallUrl } from '../src/lib/components/firewall/tabs';
import { formatDateTime } from '../src/lib/format';

describe('host inventory', () => {
  test('reads the first alias an agent reported', () => {
    expect(hostInfoText({ os_name: 'Ubuntu' }, 'os')).toBe('Ubuntu');
    expect(hostInfoText({ os: 'Debian', os_name: 'Ubuntu' }, 'os')).toBe('Debian');
    expect(hostInfoText({ kernel_version: '6.8.0' }, 'kernel')).toBe('6.8.0');
    expect(hostInfoText({ os: '' }, 'os')).toBe('');
    expect(hostInfoText(null, 'hostname')).toBe('');
  });

  test('sizes are bytes whatever unit the agent used', () => {
    expect(hostInfoBytes({ memory_total_bytes: 8 * 1024 ** 3 }, 'memory_total')).toBe(8 * 1024 ** 3);
    expect(hostInfoBytes({ memory_total_mb: 2048 }, 'memory_total')).toBe(2048 * 1024 ** 2);
    expect(hostInfoBytes({ disk_total_gb: 40 }, 'disk_total')).toBe(40 * 1024 ** 3);
    expect(hostInfoBytes({ memory_total_bytes: 0 }, 'memory_total')).toBeNull();
    expect(hostInfoDisplay({ memory_total_mb: 1024 }, 'memory_total')).toBe('1 GiB');
    expect(hostInfoDisplay({}, 'memory_free')).toBe('n/a');
  });

  test('uptime is seconds, boot time is epoch seconds shown in local time', () => {
    expect(hostInfoDisplay({ uptime_seconds: 90_061 }, 'uptime_seconds')).toBe(hostInfoDisplay({ uptime_seconds: '90061' }, 'uptime_seconds'));
    expect(hostInfoDisplay({ uptime_seconds: 90_061 }, 'uptime_seconds')).toMatch(/1\s*d/);
    expect(hostInfoDisplay({ boot_time: Date.parse('2026-09-27T09:54:00Z') / 1000 }, 'boot_time')).toBe(formatDateTime('2026-09-27T09:54:00Z'));
    expect(hostInfoDisplay({ cpu_mhz: 2399.9 }, 'cpu_mhz')).toBe('2400 MHz');
  });

  test('load average, BPF LSM state, disks and interfaces', () => {
    expect(hostLoadAverage({ load_avg_1: 0.5, load_avg_5: 0.25, load_avg_15: 0.125 })).toBe('0.50 / 0.25 / 0.13');
    expect(hostLoadAverage({ load_average: '1 2 3' })).toBe('1 2 3');
    expect(hostLoadAverage(null)).toBe('n/a');
    expect(bpfLsmState({ bpf_lsm: true }).state).toBe('active');
    expect(bpfLsmState({ bpf_lsm_enabled: 'disabled' }).state).toBe('inactive');
    expect(bpfLsmState({}).state).toBe('unknown');
    expect(hostDisks({ disks: [{ mountpoint: '/', size_bytes: 100, used_bytes: 25, filesystem: 'ext4' }] })).toEqual([{ mount: '/', total: 100, used: 25, fs: 'ext4' }]);
    expect(usedPercent(25, 100)).toBe('25%');
    expect(usedPercent(null, 100)).toBe('n/a');
    expect(hostInterfaces({ network_interfaces: [{ iface: 'eth0', ips: ['10.0.0.2'], hw_addr: 'aa:bb' }, 'junk'] })).toEqual([{ name: 'eth0', addresses: ['10.0.0.2'], mac: 'aa:bb' }]);
  });

  test('list summary prefers the host columns, then host_info', () => {
    expect(hostSummary({ host_info: { hostname: 'web-1', os: 'Ubuntu', kernel_release: '6.8', arch: 'x86_64' } })).toEqual({ hostname: 'web-1', os: 'Ubuntu', kernel: '6.8', arch: 'x86_64' });
    expect(hostSummary({ host_info: null, host_os_version: 'Ubuntu 24.04', host_kernel: '6.9' })).toEqual({ hostname: '', os: 'Ubuntu 24.04', kernel: '6.9', arch: '' });
  });
});

describe('host registration', () => {
  test('labels are key=value pairs; bad entries are reported, not dropped', () => {
    expect(parseLabels('env=prod, region=eu-west-1')).toEqual({ labels: { env: 'prod', region: 'eu-west-1' }, invalid: [], error: null });
    const bad = parseLabels('env=prod, oops, =x');
    expect(bad.labels).toEqual({ env: 'prod' });
    expect(bad.invalid).toEqual(['oops', '=x']);
    expect(bad.error).toContain('oops');
    expect(parseLabels('').error).toBeNull();
  });

  test('host names are 2 to 64 characters', () => {
    expect(hostNameError('')).not.toBeNull();
    expect(hostNameError('a')).not.toBeNull();
    expect(hostNameError('edge-eu-1')).toBeNull();
    expect(hostNameError('x'.repeat(65))).not.toBeNull();
  });

  test('host names refuse terminal escapes and bidi characters', () => {
    for (const bad of ['\x1b]0;pwn\x07', 'a\x1b[2Jb', 'tab\tname', 'c1\u009b31m', 'bidi\u202egnp', 'zw\u200bname', 'bom\ufeffname']) {
      expect(hostNameError(bad)).not.toBeNull();
    }
    for (const good of ['srv-\u00fc-01', '\u6771\u4eac-1', 'web 1 (prod)']) {
      expect(hostNameError(good)).toBeNull();
    }
  });
});

describe('firewall URL state', () => {
  test('defaults and the four tabs', () => {
    expect(readFirewallUrl('')).toEqual({ tab: DEFAULT_FIREWALL_TAB, type: 'all', view: 'events' });
    expect(readFirewallUrl('?tab=rules&type=port').tab).toBe('rules');
    expect(readFirewallUrl('?tab=rules&type=port').type).toBe('port');
    expect(readFirewallUrl('?tab=bogus').tab).toBe('overview');
    expect(readFirewallUrl('?tab=live&view=bandwidth').view).toBe('bandwidth');
  });

  test('old tab names land on the same content', () => {
    expect(readFirewallUrl('?tab=blocklist')).toEqual({ tab: 'rules', type: 'block', view: 'events' });
    expect(readFirewallUrl('?tab=portpolicy').type).toBe('port');
    expect(readFirewallUrl('?tab=config').tab).toBe('settings');
    expect(readFirewallUrl('?tab=connections')).toEqual({ tab: 'live', type: 'all', view: 'connections' });
  });

  test('search keeps the host and range and drops defaults', () => {
    expect(firewallSearch('?host=h1&range=7d', { tab: 'rules', type: 'geo' })).toBe('?host=h1&range=7d&tab=rules&type=geo');
    expect(firewallSearch('?host=h1&tab=rules&type=geo', { tab: 'overview', type: 'all' })).toBe('?host=h1');
    expect(firewallSearch('?tab=blocklist', { view: 'bandwidth' })).toBe('?tab=rules&type=block&view=bandwidth');
    expect(firewallSearch('', {})).toBe('');
  });
});
