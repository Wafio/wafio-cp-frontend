// Host fleet helpers (lib/host-fleet.ts).
import { describe, expect, test } from 'bun:test';
import type { FleetHost, HostApplyResponse, HostApplyResult } from '../src/lib/api';
import {
  EMPTY_FLEET_FILTERS,
  accessRuleToApply,
  applyCountText,
  applyFleetFilters,
  chunkIds,
  degradedReasonText,
  fleetCounts,
  fleetFilterSearch,
  headerCheckState,
  hostCountPhrase,
  hostsWithLabel,
  labelEditImpact,
  labelFacets,
  mergeApplyResponses,
  parseLabelEdit,
  payloadNeedsAllowlistPorts,
  pruneSelection,
  readFleetFilters,
  removeRuleToApply,
  replaceResults,
  retryableHostIds,
  targetHints,
  toggleAllIds,
} from '../src/lib/host-fleet';

function host(id: string, over: Partial<FleetHost> & { fw?: FleetHost['protection']['firewall']['state']; rt?: FleetHost['protection']['runtime']['state'] } = {}): FleetHost {
  const { fw = 'enforce', rt = 'on', ...rest } = over;
  return {
    id,
    name: id,
    labels: {},
    status: 'online',
    host_key_prefix: 'wafh_ab12',
    hostname: id,
    host_os: 'linux',
    host_os_version: 'Ubuntu 24.04 LTS',
    host_kernel: '6.8.0',
    host_arch: 'amd64',
    last_seen: '2026-10-16T08:00:00Z',
    created_at: '2026-09-01T10:00:00Z',
    revoked_at: null,
    protection: {
      firewall: { state: fw, attached: true, xdp_mode: 'native', features: ['allowlist_ports'], degraded: false, degraded_reasons: [], reported_at: null },
      runtime: { state: rt, enforcing_policies: 0, enabled_policies: 0, missing_probes: 0, reported_at: null },
      incidents: { open_critical: 0, open_high: 0, acknowledged: 0 },
      agents: {
        host: { id: `a-${id}`, name: id, version: 'v1.7.3', online: true, outdated: false },
        waf: { count: 0, online: 0, oldest_version: null, outdated: null, agents: [] },
      },
      attention: [],
    },
    ...rest,
  };
}

const fleet: FleetHost[] = [
  host('edge-eu-1', { labels: { env: 'prod', region: 'eu' } }),
  host('edge-us-2', { labels: { env: 'prod' }, status: 'offline', fw: 'monitor' }),
  host('db-1', { labels: { env: 'staging' }, rt: 'off' }),
  host('old-1', { labels: { env: 'prod' }, status: 'revoked', fw: 'no_agent', rt: 'no_agent' }),
];
fleet[1].protection.attention = ['host_offline'];
fleet[2].protection.agents.host!.outdated = true;
fleet[2].protection.attention = ['agent_outdated'];

describe('filters', () => {
  test('URL round trip keeps other parameters', () => {
    const state = { status: 'online', fw: 'monitor', rt: 'off', attention: true, label: { key: 'env', value: 'a=b' }, q: 'edge' } as const;
    const search = fleetFilterSearch(new URLSearchParams('tab=x&q=old'), { ...state });
    const params = new URLSearchParams(search);
    expect(params.get('tab')).toBe('x');
    expect(readFleetFilters(params)).toEqual({ ...state });
    expect(fleetFilterSearch(new URLSearchParams('status=online'), EMPTY_FLEET_FILTERS)).toBe('');
  });

  test('unknown values fall back to any', () => {
    const f = readFleetFilters(new URLSearchParams('status=gone&fw=nope&rt=x&attention=yes&label=novalue'));
    expect(f).toEqual(EMPTY_FLEET_FILTERS);
  });

  test('every filter narrows, q uses filterHosts', () => {
    expect(applyFleetFilters(fleet, { ...EMPTY_FLEET_FILTERS, status: 'offline' }).map((h) => h.id)).toEqual(['edge-us-2']);
    expect(applyFleetFilters(fleet, { ...EMPTY_FLEET_FILTERS, fw: 'monitor' }).map((h) => h.id)).toEqual(['edge-us-2']);
    expect(applyFleetFilters(fleet, { ...EMPTY_FLEET_FILTERS, rt: 'off' }).map((h) => h.id)).toEqual(['db-1']);
    expect(applyFleetFilters(fleet, { ...EMPTY_FLEET_FILTERS, attention: true }).map((h) => h.id)).toEqual(['edge-us-2', 'db-1']);
    expect(applyFleetFilters(fleet, { ...EMPTY_FLEET_FILTERS, label: { key: 'env', value: 'prod' } }).length).toBe(3);
    expect(applyFleetFilters(fleet, { ...EMPTY_FLEET_FILTERS, q: 'env=prod edge' }).map((h) => h.id)).toEqual(['edge-eu-1', 'edge-us-2']);
  });
});

test('label facets count hosts per key=value, sorted', () => {
  expect(labelFacets(fleet)).toEqual([
    { key: 'env', value: 'prod', count: 3 },
    { key: 'env', value: 'staging', count: 1 },
    { key: 'region', value: 'eu', count: 1 },
  ]);
});

test('KPI counts skip revoked hosts except the total', () => {
  expect(fleetCounts(fleet)).toEqual({ hosts: 4, online: 2, firewallEnforcing: 2, runtimeOn: 2, attention: 2, outdated: 1 });
});

describe('selection', () => {
  const filtered = applyFleetFilters(fleet, { ...EMPTY_FLEET_FILTERS, label: { key: 'env', value: 'prod' } }).map((h) => h.id);
  test('select all selects the whole filtered set and keeps other selections', () => {
    const next = toggleAllIds(['db-1'], filtered);
    expect(next.sort()).toEqual(['db-1', 'edge-eu-1', 'edge-us-2', 'old-1']);
    expect(headerCheckState(next, filtered)).toBe('all');
    expect(toggleAllIds(next, filtered)).toEqual(['db-1']);
    expect(headerCheckState(['edge-eu-1'], filtered)).toBe('some');
    expect(headerCheckState([], filtered)).toBe('none');
  });
  test('prune drops hosts that disappeared', () => {
    expect(pruneSelection(['edge-eu-1', 'gone'], fleet)).toEqual(['edge-eu-1']);
  });
});

describe('accessRuleToApply', () => {
  test('block, egress and allow map to list ops with ttl and ports', () => {
    expect(accessRuleToApply({ type: 'block', addresses: ['203.0.113.7'], ttlMs: 60_000 }).payload).toEqual({ op: 'blocklist.add', entries: [{ ip: '203.0.113.7', ttl_ms: 60_000 }] });
    expect(accessRuleToApply({ type: 'egress', addresses: ['198.51.100.0/24'] }).payload).toEqual({ op: 'egress_blocklist.add', entries: [{ ip: '198.51.100.0/24' }] });
    const allow = accessRuleToApply({ type: 'allow', addresses: ['10.0.0.0/8'], ports: [{ proto: 'tcp', from: 22 }] }).payload;
    expect(allow).toEqual({ op: 'allowlist.add', entries: [{ ip: '10.0.0.0/8', ports: [{ proto: 'tcp', from: 22 }] }] });
    expect(payloadNeedsAllowlistPorts(allow)).toBe(true);
    expect(payloadNeedsAllowlistPorts(accessRuleToApply({ type: 'allow', addresses: ['10.0.0.1'], ports: [] }).payload)).toBe(false);
  });
  test('port rules become one policy per port', () => {
    expect(accessRuleToApply({ type: 'port', ports: [22, 443], proto: 'tcp', direction: 'ingress', action: 'allow' }).payload).toEqual({
      op: 'port_policies.add',
      policies: [
        { port: 22, proto: 'tcp', direction: 'ingress', action: 'allow' },
        { port: 443, proto: 'tcp', direction: 'ingress', action: 'allow' },
      ],
    });
  });
  test('geo is refused', () => {
    const r = accessRuleToApply({ type: 'geo', codes: ['CN'] });
    expect(r.payload).toBeNull();
    expect(r.error).toContain('each host');
  });
  test('removals', () => {
    expect(removeRuleToApply({ type: 'allow', addresses: ['10.0.0.1'] })).toEqual({ op: 'allowlist.remove', entries: [{ ip: '10.0.0.1' }] });
    expect(removeRuleToApply({ type: 'port', ports: [22], proto: 'tcp', direction: 'both' })).toEqual({ op: 'port_policies.remove', policies: [{ port: 22, proto: 'tcp', direction: 'both' }] });
  });
});

test('chunking at 1000', () => {
  const ids = Array.from({ length: 2001 }, (_, i) => `h${i}`);
  const chunks = chunkIds(ids);
  expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 1]);
  expect(chunkIds([])).toEqual([]);
});

const result = (host_id: string, status: HostApplyResult['status'], code = ''): HostApplyResult => ({ host_id, host_name: host_id, status, code, error: '' });

test('retryable ids: failed/skipped with load or race codes only', () => {
  const results = [
    result('a', 'failed', 'STATE_CONFLICT'),
    result('b', 'failed', 'SSH_ALLOW_REQUIRED'),
    result('c', 'skipped', 'DEADLINE'),
    result('d', 'skipped', 'NO_HOST_AGENT'),
    result('e', 'failed', 'INTERNAL_ERROR'),
    result('f', 'failed', 'STATE_UNAVAILABLE'),
    result('g', 'applied'),
  ];
  expect(retryableHostIds(results)).toEqual(['a', 'c', 'e', 'f']);
});

test('merging chunks and replacing retried hosts', () => {
  const r1: HostApplyResponse = { apply_id: 'x', op: 'blocklist.add', dry_run: false, results: [result('a', 'applied'), result('b', 'failed', 'DEADLINE')], summary: { applied: 1, would_apply: 0, unchanged: 0, failed: 1, skipped: 0 }, total: 2 };
  const r2: HostApplyResponse = { ...r1, apply_id: 'y', results: [result('c', 'unchanged')], total: 1 };
  const merged = mergeApplyResponses([r1, r2])!;
  expect(merged.total).toBe(3);
  expect(merged.summary).toEqual({ applied: 1, would_apply: 0, unchanged: 1, failed: 1, skipped: 0 });
  const retried = replaceResults(merged, { ...r1, apply_id: 'z', results: [result('b', 'applied')], total: 1 });
  expect(retried.summary.applied).toBe(2);
  expect(retried.summary.failed).toBe(0);
  expect(retried.apply_id).toBe('z');
  expect(mergeApplyResponses([])).toBeNull();
  expect(merged.source_digest).toBeUndefined();
});

test('the source digest of a copy survives chunk merging and retries', () => {
  const r1: HostApplyResponse = { apply_id: null, op: 'trace_policies.copy', dry_run: true, results: [result('a', 'would_apply')], summary: { applied: 0, would_apply: 1, unchanged: 0, failed: 0, skipped: 0 }, total: 1, source_digest: 'sha256:abc' };
  const r2: HostApplyResponse = { ...r1, results: [result('b', 'would_apply')], source_digest: undefined };
  const merged = mergeApplyResponses([r2, r1])!;
  expect(merged.source_digest).toBe('sha256:abc');
  expect(replaceResults(merged, r2).source_digest).toBe('sha256:abc');
});

test('item counts read naturally for adds and removes', () => {
  expect(applyCountText({ count: 1 }, 'blocklist.remove', false)).toBe('1 removed');
  expect(applyCountText({ count: 1 }, 'port_policies.remove', true)).toBe('would remove 1');
  expect(applyCountText({ count: 2 }, 'allowlist.add', false)).toBe('2 added');
  expect(applyCountText({ count: 3 }, 'egress_blocklist.add', true)).toBe('would add 3');
  expect(applyCountText({ count: 0 }, 'blocklist.remove', false)).toBe('');
  expect(applyCountText({}, 'blocklist.add', false)).toBe('');
  expect(applyCountText({ count: 1, created: 1, existing: 2 }, 'trace_policies.copy', false)).toBe('1 created, 2 already there');
  expect(applyCountText({ count: 2 }, 'trace_policies.copy', false)).toBe('2 items');
});

test('label targets skip revoked hosts; count phrase', () => {
  expect(hostsWithLabel(fleet, { key: 'env', value: 'prod' }).map((h) => h.id)).toEqual(['edge-eu-1', 'edge-us-2']);
  expect(hostCountPhrase(1)).toBe('1 host');
  expect(hostCountPhrase(12)).toBe('12 hosts');
});

test('target hints', () => {
  const noAgent = host('n');
  noAgent.protection.agents.host = null;
  expect(targetHints(noAgent)[0].text).toContain('skipped');
  expect(targetHints(noAgent, { needsAgent: false })).toEqual([]);
  const offline = host('o');
  offline.protection.agents.host!.online = false;
  offline.protection.firewall.features = [];
  const hints = targetHints(offline, { scopedAllowlist: true }).map((h) => h.text);
  expect(hints.some((t) => t.includes('delivered on reconnect'))).toBe(true);
  expect(hints.some((t) => t.includes('refused'))).toBe(true);
});

test('degraded reason text keeps the code', () => {
  expect(degradedReasonText('bundle_refused:SSH_ALLOW_REQUIRED')).toContain('SSH_ALLOW_REQUIRED');
  expect(degradedReasonText('geo_degraded:GEO_DATASET_MISSING')).toContain('GEO_DATASET_MISSING');
  expect(degradedReasonText('xdp_detached')).toBe('XDP program not attached');
  expect(degradedReasonText('something_new')).toBe('something_new');
});

describe('label edits', () => {
  test('server rules: key pattern, value length, control characters, overlap', () => {
    expect(parseLabelEdit('env=prod, team = edge', 'old').errors).toEqual([]);
    expect(parseLabelEdit('env=prod', '').set).toEqual({ env: 'prod' });
    expect(parseLabelEdit('-bad=1', '').errors.length).toBe(1);
    expect(parseLabelEdit(`k=${'x'.repeat(129)}`, '').errors.length).toBe(1);
    expect(parseLabelEdit('k=a\u0007b', '').errors.length).toBe(1);
    expect(parseLabelEdit('k=a\u009bb', '').errors.length).toBe(1);
    expect(parseLabelEdit('k=a\u202eb', '').errors.length).toBe(1);
    expect(parseLabelEdit('k=\u6771\u4eac', '').errors).toEqual([]);
    expect(parseLabelEdit('env=prod', 'env').errors[0]).toContain('both');
    expect(parseLabelEdit('', 'a b,c').remove).toEqual(['a', 'b', 'c']);
  });
  test('impact counts changed hosts and the 32-label cap', () => {
    const hosts = [
      { id: '1', name: 'one', labels: { env: 'prod' } },
      { id: '2', name: 'two', labels: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, 'v'])) },
    ];
    const impact = labelEditImpact(hosts, { set: { env: 'prod', extra: '1' }, remove: [] });
    expect(impact.changed).toBe(2);
    expect(impact.overLimit).toEqual(['two']);
    expect(labelEditImpact(hosts, { set: { env: 'prod' }, remove: [] }).unchanged).toBe(1);
  });
});
