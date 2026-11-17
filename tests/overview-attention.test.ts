import { describe, expect, test } from 'bun:test';
import type { HostIncident, OverviewAgentEvidence, OverviewEvidenceAction } from '../src/lib/api';
import {
  credentialsHref,
  groupAttention,
  installCommand,
  matchesDecisionFilter,
  mergeEvidenceActions,
  overviewBucketSeconds,
  runtimeHref,
  setupChecklist,
  type SetupState,
} from '../src/lib/overview';

const ROOT = '/b/projects/p1';

function agent(id: string, kind: 'waf' | 'host', hostId: string | null, extra: Partial<OverviewAgentEvidence> = {}): OverviewAgentEvidence {
  return {
    id, name: `${kind}-${id}`, kind, host_id: hostId, last_seen: '2026-09-27T10:00:00Z', state_at: null, freshness: 'fresh',
    desired_generation: null, applied_generation: null, apply_state: 'unknown', apply_observed_at: null, capabilities: {}, ...extra,
  };
}

function action(id: string, kind: string, severity: string, target: string, extra: Partial<OverviewEvidenceAction> = {}): OverviewEvidenceAction {
  return { id, kind, severity, target_id: target, target_name: '', observed_at: '2026-09-27T10:00:00Z', due_at: null, message: `${kind} message`, ...extra };
}

function incident(id: string, agentId: string, technique: string, comm: string, extra: Partial<HostIncident> = {}): HostIncident {
  return {
    id, project_id: 'p1', agent_id: agentId, technique_id: technique, tactic: 'Command and Control', comm, severity: 4, severity_name: 'critical',
    status: 'open', event_count: 10, first_seen_at: '2026-09-27T09:00:00Z', last_seen_at: '2026-09-27T10:00:00Z', sample_description: '', ...extra,
  };
}

describe('groupAttention', () => {
  const agents = [agent('h1a', 'host', 'H1'), agent('h2a', 'host', 'H2'), agent('w1', 'waf', null)];

  test('incidents group by host × rule, with counts, processes and events', () => {
    const incidents = [
      incident('i1', 'h1a', 'T1071', 'sshd', { event_count: 9201 }),
      incident('i2', 'h1a', 'T1071', 'cron', { event_count: 5 }),
      incident('i3', 'h1a', 'T1071', 'health-check', { event_count: 7 }),
      incident('i4', 'h2a', 'T1071', 'sshd'),
      incident('i5', 'h1a', 'T1059', 'bash', { severity_name: 'high', severity: 3 }),
    ];
    const groups = groupAttention({ evidence: { actions: [], agents }, incidents, projectRoot: ROOT, hostNames: { H1: 'web-01', H2: 'db-01' } });
    expect(groups.map((g) => g.title)).toEqual([
      'T1071 Command and Control on web-01',
      'T1071 Command and Control on db-01',
      'T1059 Command and Control on web-01',
    ]);
    const big = groups[0];
    expect(big.count).toBe(3);
    expect(big.summary).toBe('3 open incidents · sshd, cron, health-check · 9,213 events');
    expect(big.action.label).toBe('Review 3 incidents');
    expect(big.action.href).toBe(`${ROOT}/host/trace?host=H1&tab=triage&technique=T1071`);
    // a single incident opens the incident itself
    expect(groups[1].action).toEqual({ label: 'Open incident', href: `${ROOT}/host/trace?host=H2&tab=triage&incident=i4` });
  });

  test('without incident details, incidents group by host from the evidence', () => {
    const actions = [action('x1', 'incident', 'critical', 'h1a'), action('x2', 'incident', 'high', 'h1a')];
    const groups = groupAttention({ evidence: { actions, agents }, incidents: null, projectRoot: ROOT });
    expect(groups).toHaveLength(1);
    expect(groups[0].severity).toBe('critical');
    expect(groups[0].count).toBe(2);
  });

  test('heartbeat gaps split by agent kind; single items link to the agent', () => {
    const actions = [
      action('heartbeat:w1', 'heartbeat', 'warning', 'w1'),
      action('heartbeat:h1a', 'heartbeat', 'warning', 'h1a'),
      action('heartbeat:h2a', 'heartbeat', 'warning', 'h2a'),
    ];
    const groups = groupAttention({ evidence: { actions, agents }, incidents: [], projectRoot: ROOT });
    const waf = groups.find((g) => g.key === 'heartbeat:waf')!;
    const host = groups.find((g) => g.key === 'heartbeat:host')!;
    expect(waf.action).toEqual({ label: 'Open agent', href: `${ROOT}/waf/w1` });
    expect(host.count).toBe(2);
    expect(host.action).toEqual({ label: 'Review 2 agents', href: `${ROOT}/hosts` });
    expect(host.items.map((i) => i.href).sort()).toEqual([`${ROOT}/hosts/H1`, `${ROOT}/hosts/H2`]);
  });

  test('certificates deep-link to the credential; expired counts as critical', () => {
    const actions = [
      action('certificate:c1', 'certificate', 'critical', 'c1', { target_name: 'edge', due_at: '2026-09-01T00:00:00Z' }),
      action('certificate:c2', 'certificate', 'warning', 'c2', { target_name: 'core', due_at: '2026-10-10T00:00:00Z' }),
    ];
    const [group] = groupAttention({ evidence: { actions, agents }, incidents: [], projectRoot: ROOT });
    expect(group.kind).toBe('certificate');
    expect(group.severity).toBe('critical');
    expect(group.summary).toBe('1 certificate expired · 1 certificate expiring within 30 days');
    expect(group.action.href).toBe(`${ROOT}/settings/credentials?filter=expiring`);
    expect(group.items[0].href).toBe(`${ROOT}/settings/credentials?credential=c1`);
  });

  test('groups sort by worst severity, then kind', () => {
    const actions = [
      action('config:w1', 'configuration', 'warning', 'w1'),
      action('certificate:c1', 'certificate', 'critical', 'c1'),
    ];
    const groups = groupAttention({ evidence: { actions, agents }, incidents: [incident('i1', 'h1a', 'T1', 'x', { severity_name: 'high', severity: 3 })], projectRoot: ROOT });
    expect(groups.map((g) => g.kind)).toEqual(['certificate', 'incident', 'configuration']);
  });

  test('resolved incidents are ignored', () => {
    const groups = groupAttention({ evidence: { actions: [], agents }, incidents: [incident('i1', 'h1a', 'T1', 'x', { status: 'resolved' })], projectRoot: ROOT });
    expect(groups).toEqual([]);
  });
});

test('mergeEvidenceActions drops duplicates across pages', () => {
  const a = action('a', 'incident', 'high', 't');
  const b = action('b', 'incident', 'high', 't');
  expect(mergeEvidenceActions([[a, b], [b]]).map((x) => x.id)).toEqual(['a', 'b']);
});

test('deep-link helpers', () => {
  expect(runtimeHref('/p', { host: null, incident: 'i' })).toBe('/p/host/trace?tab=triage&incident=i');
  expect(credentialsHref('/p')).toBe('/p/settings/credentials');
});

describe('setupChecklist', () => {
  const empty: SetupState = { hosts: 0, credentials: 0, apps: 0, assignedApps: 0, wafAgents: 0, agentsSeen: 0, decisions: 0 };

  test('a new project has five open steps in order', () => {
    const { steps, complete, remaining } = setupChecklist(empty, ROOT);
    expect(steps.map((s) => s.id)).toEqual(['host', 'credential', 'app', 'heartbeat', 'decision']);
    expect(complete).toBe(false);
    expect(remaining).toBe(5);
    expect(steps[0].action?.href).toBe(`${ROOT}/hosts`);
    expect(steps[1].action?.href).toBe(`${ROOT}/settings/credentials`);
    expect(steps[2].action).toEqual({ label: 'Register a WAF agent', href: `${ROOT}/waf` });
    expect(steps[3].waitingFor).toBe('an agent credential');
  });

  test('an app exists but is not assigned: the step points to assignment', () => {
    const { steps } = setupChecklist({ ...empty, apps: 2, wafAgents: 1 }, ROOT);
    expect(steps[2].done).toBe(false);
    expect(steps[2].action?.label).toBe('Assign an application');
  });

  test('complete when every source reports progress', () => {
    const result = setupChecklist({ hosts: 1, credentials: 1, apps: 1, assignedApps: 1, wafAgents: 1, agentsSeen: 2, decisions: 5 }, ROOT);
    expect(result.complete).toBe(true);
    expect(result.remaining).toBe(0);
  });

  test('unknown sources never count as done', () => {
    const result = setupChecklist({ hosts: 1, credentials: null, apps: null, assignedApps: null, wafAgents: 1, agentsSeen: 1, decisions: null }, ROOT);
    expect(result.steps[1].done).toBeNull();
    expect(result.complete).toBe(false);
  });
});

describe('installCommand', () => {
  test('WAF agent: certificates where the installer looks, readable by the wafio user, then the installer', () => {
    const cmd = installCommand('edge waf/1', 'waf');
    expect(cmd).toContain('tar --no-same-owner -xf wafio-edge_waf_1-bundle.tar -C /etc/wafio/certs/waf ca.crt client.crt client.key');
    expect(cmd).toContain('chmod 0600 /etc/wafio/certs/waf/client.key');
    expect(cmd).toContain('chown -R wafio:wafio /etc/wafio/certs/waf');
    expect(cmd).toContain('# Agent name: edge waf/1.');
    expect(cmd.trim().split('\n').at(-1)).toBe('sudo bash install.sh');
    // The installer writes its own unit; the bundle's sample unit is not enabled next to it.
    expect(cmd).not.toContain('systemctl enable');
    expect(cmd).not.toContain('WAFIO_HOST_KEY');
  });

  test('host agent: runs as root, adds the host key the unit reads from host-agent.env', () => {
    const cmd = installCommand('host-1', 'host');
    expect(cmd).toContain('-C /etc/wafio/certs/host ca.crt client.crt client.key');
    expect(cmd).toContain('sudo bash install.sh');
    expect(cmd).toContain("WAFIO_HOST_KEY=<host key from Hosts>' | sudo tee -a /etc/wafio/host-agent.env");
    expect(cmd).toContain('systemctl restart wafio-host-agent');
    expect(cmd).not.toContain('chown -R wafio');
  });

  test('a name with a line break cannot end the comment it appears in', () => {
    const cmd = installCommand('evil\nrm -rf /', 'waf');
    expect(cmd.split('\n').filter((line) => line.startsWith('rm '))).toEqual([]);
    expect(cmd).toContain('# Agent name: evil rm -rf /.');
  });
});

describe('decision filters', () => {
  test('IP, category, country and action match the stored values', () => {
    const row = { remote_addr: '203.0.113.9', categories: 'sqli,xss', country_code: 'id', action: 'block' };
    expect(matchesDecisionFilter(row, { kind: 'ip', value: '203.0.113.9', label: '' })).toBe(true);
    expect(matchesDecisionFilter(row, { kind: 'ip', value: '203.0.113.90', label: '' })).toBe(false);
    expect(matchesDecisionFilter(row, { kind: 'category', value: 'xss', label: '' })).toBe(true);
    expect(matchesDecisionFilter(row, { kind: 'category', value: 'xs', label: '' })).toBe(false);
    expect(matchesDecisionFilter(row, { kind: 'country', value: 'ID', label: '' })).toBe(true);
    expect(matchesDecisionFilter(row, { kind: 'action', value: 'log', label: '' })).toBe(false);
  });

  test('filters from the top lists leave allowed requests out unless asked', () => {
    const allowed = { remote_addr: '203.0.113.9', categories: '', country_code: 'ID', action: 'allow' };
    const monitored = { ...allowed, action: 'log' };
    const ip = { kind: 'ip' as const, value: '203.0.113.9', label: '' };
    expect(matchesDecisionFilter(allowed, { ...ip, flaggedOnly: true })).toBe(false);
    expect(matchesDecisionFilter(monitored, { ...ip, flaggedOnly: true })).toBe(true);
    expect(matchesDecisionFilter(allowed, ip)).toBe(true);
  });
});

test('timeline buckets match the server cache warm-up formula', () => {
  expect(overviewBucketSeconds(60)).toBe(150);
  expect(overviewBucketSeconds(5)).toBe(60);
  expect(overviewBucketSeconds(1440)).toBe(3600);
});
