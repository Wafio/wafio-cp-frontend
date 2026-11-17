import { describe, expect, test } from 'bun:test';
import type { HostIncident } from '../src/lib/api';
import {
  actionableIncidentIds,
  compareGroups,
  groupIncidents,
  incidentAccepts,
  runBulk,
  summarizeSelection,
  suppressionPrefill,
  UNMAPPED_TACTIC,
} from '../src/lib/components/runtime/triage';
import { eventNamesForTechniques, SERVER_MITRE_BY_EVENT, tacticBreakdown } from '../src/lib/components/runtime/mitre';
import { draftToBody } from '../src/lib/components/runtime/detection';

let seq = 0;
function incident(over: Partial<HostIncident> = {}): HostIncident {
  seq += 1;
  return {
    id: `i${seq}`,
    project_id: 'p1',
    agent_id: 'a1',
    technique_id: 'T1071',
    tactic: 'Command and Control',
    comm: 'sshd',
    severity: 4,
    severity_name: 'critical',
    status: 'open',
    event_count: 10,
    first_seen_at: '2026-09-27T08:00:00Z',
    last_seen_at: '2026-09-27T09:00:00Z',
    sample_description: 'connect to 10.0.0.1:22',
    ...over,
  };
}

const host = { id: 'h1', label: 'web-1' };

describe('groupIncidents', () => {
  test('collapses host × tactic × process across agents and techniques', () => {
    const groups = groupIncidents(
      [
        incident({ agent_id: 'a1', technique_id: 'T1071', event_count: 9201 }),
        incident({ agent_id: 'a2', technique_id: 'T1571', event_count: 5 }),
        incident({ comm: 'cron', event_count: 3 }),
        incident({ comm: 'sshd', tactic: 'Execution', technique_id: 'T1059' }),
      ],
      { fallbackHost: host },
    );
    expect(groups).toHaveLength(3);
    const sshdC2 = groups.find((g) => g.comm === 'sshd' && g.tactic === 'Command and Control');
    expect(sshdC2?.incidents).toHaveLength(2);
    expect(sshdC2?.eventCount).toBe(9206);
    expect(sshdC2?.techniques).toEqual(['T1071', 'T1571']);
    expect(sshdC2?.agentIds).toEqual(['a1', 'a2']);
    expect(sshdC2?.host).toEqual(host);
  });

  test('maps agents to hosts in the all-hosts scope; unknown agents stay separate', () => {
    const hostOf = (agentId: string) => (agentId === 'a1' || agentId === 'a2' ? host : undefined);
    const groups = groupIncidents([incident({ agent_id: 'a1' }), incident({ agent_id: 'a2' }), incident({ agent_id: 'zzz-unknown' })], { hostOf });
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.host.id.startsWith('agent:'))).toBe(true);
  });

  test('keeps the most severe severity, counts statuses and the time span', () => {
    const [group] = groupIncidents(
      [
        incident({ severity_name: 'high', status: 'acknowledged', first_seen_at: '2026-09-26T00:00:00Z', last_seen_at: '2026-09-27T10:00:00Z' }),
        incident({ severity_name: 'critical', status: 'open', sample_description: 'critical sample' }),
        incident({ severity_name: 'high', status: 'resolved' }),
      ],
      { fallbackHost: host },
    );
    expect(group.severity).toBe('critical');
    expect(group.sample).toBe('critical sample');
    expect([group.open, group.acknowledged, group.resolved]).toEqual([1, 1, 1]);
    expect(group.firstSeen).toBe('2026-09-26T00:00:00Z');
    expect(group.lastSeen).toBe('2026-09-27T10:00:00Z');
  });

  test('empty tactic and process get explicit labels', () => {
    const [group] = groupIncidents([incident({ tactic: '', technique_id: '', comm: '' })], { fallbackHost: host });
    expect(group.tactic).toBe(UNMAPPED_TACTIC);
    expect(group.comm).toBe('unknown');
  });

  test('orders groups with open incidents first, then severity and volume', () => {
    const groups = groupIncidents(
      [
        incident({ comm: 'a', status: 'acknowledged', severity_name: 'critical' }),
        incident({ comm: 'b', status: 'open', severity_name: 'high', event_count: 1 }),
        incident({ comm: 'c', status: 'open', severity_name: 'high', event_count: 50 }),
        incident({ comm: 'd', status: 'open', severity_name: 'critical' }),
      ],
      { fallbackHost: host },
    );
    expect(groups.map((g) => g.comm)).toEqual(['d', 'c', 'b', 'a']);
    expect(compareGroups(groups[0], groups[0])).toBe(0);
  });
});

describe('bulk actions', () => {
  const groups = groupIncidents(
    [incident({ id: 'o1', status: 'open' }), incident({ id: 'k1', status: 'acknowledged' }), incident({ id: 'r1', status: 'resolved' })],
    { fallbackHost: host },
  );

  test('acknowledge changes open incidents; resolve changes every unresolved one', () => {
    expect(actionableIncidentIds(groups, 'ack')).toEqual(['o1']);
    expect(actionableIncidentIds(groups, 'resolve').sort()).toEqual(['k1', 'o1']);
    expect(incidentAccepts(incident({ status: 'resolved' }), 'resolve')).toBe(false);
  });

  test('summarizeSelection counts groups, incidents and actionable ones', () => {
    expect(summarizeSelection(groups)).toEqual({ groups: 1, incidents: 3, acknowledgeable: 1, resolvable: 2, events: 30 });
  });

  test('runBulk collects failures, reports progress and respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const progress: number[] = [];
    const result = await runBulk(
      ['a', 'b', 'c', 'd', 'e'],
      async (id) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        if (id === 'c') return { ok: false, error: 'conflict' };
        if (id === 'd') throw new Error('network');
        return { ok: true };
      },
      { concurrency: 2, onProgress: (done) => progress.push(done) },
    );
    expect(result.succeeded.sort()).toEqual(['a', 'b', 'e']);
    expect(result.failed).toEqual(expect.arrayContaining([{ id: 'c', error: 'conflict' }, { id: 'd', error: 'network' }]));
    expect(peak).toBeLessThanOrEqual(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });

  test('runBulk stops starting new requests once aborted', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const result = await runBulk(
      ['a', 'b', 'c'],
      async (id) => {
        seen.push(id);
        controller.abort();
        return { ok: true };
      },
      { concurrency: 1, signal: controller.signal },
    );
    expect(seen).toEqual(['a']);
    expect(result.succeeded).toEqual(['a']);
  });
});

describe('suppress from incident (prefilled exception)', () => {
  test('narrows to the process and the events behind the techniques', () => {
    const [group] = groupIncidents([incident({ technique_id: 'T1071' }), incident({ technique_id: 'T1571' })], { fallbackHost: host });
    const prefill = suppressionPrefill(group);
    expect(prefill.hostId).toBe('h1');
    expect(prefill.warning).toBeUndefined();
    expect(prefill.draft.action).toBe('suppress');
    expect(prefill.draft.conditions[0]).toEqual({ field: 'comm', op: 'eq', value: 'sshd' });
    expect(prefill.draft.conditions[1]).toEqual({ field: 'event_name', op: 'in', value: 'accept, bind, connect, listen, socket' });
    const built = draftToBody(prefill.draft);
    expect(built.error).toBeUndefined();
    expect(built.body?.conditions[1].value).toEqual(['accept', 'bind', 'connect', 'listen', 'socket']);
  });

  test('warns when the technique is unmapped and cannot be narrowed', () => {
    const [group] = groupIncidents([incident({ technique_id: '', tactic: '' })], { fallbackHost: host });
    const prefill = suppressionPrefill(group);
    expect(prefill.eventNames).toEqual([]);
    expect(prefill.draft.conditions).toHaveLength(1);
    expect(prefill.warning).toContain('cannot be narrowed');
  });

  test('the reverse map follows the server incident mapping exactly', () => {
    for (const [name, mapping] of Object.entries(SERVER_MITRE_BY_EVENT)) {
      expect(eventNamesForTechniques([mapping.technique_id])).toContain(name);
    }
    expect(eventNamesForTechniques(['T9999'])).toEqual([]);
  });
});

describe('tacticBreakdown', () => {
  test('sums event counts per heuristic tactic, largest first, skipping unmapped', () => {
    expect(tacticBreakdown({ connect: 10, accept: 5, execve: 7, exit: 100, mprotect: 1 })).toEqual([
      ['Command and Control', 15],
      ['Execution', 7],
      ['Defense Evasion', 1],
    ]);
    expect(tacticBreakdown(undefined)).toEqual([]);
  });
});
