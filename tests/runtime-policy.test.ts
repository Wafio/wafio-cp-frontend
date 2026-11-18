import { describe, expect, test } from 'bun:test';
import type { EnforcementPolicy, TraceConfig, TraceEvent } from '../src/lib/api';
import {
  blockPolicyEnforces,
  defaultPolicyDraft,
  draftFromEvent,
  draftFromPolicy,
  hasEnforcingPolicies,
  kernelWillDowngrade,
  needsKillAcknowledgement,
  policyMatchesEvent,
  policyMatchSummary,
  policyPlacement,
  policySaveTier,
  previewMatches,
  traceConfigLosses,
  traceConfigSaveTier,
  validatePolicyDraft,
} from '../src/lib/components/runtime/policy';
import { compatibleOp, draftFromRule, draftToBody, emptyRuleDraft, formatConditions, opsForField } from '../src/lib/components/runtime/detection';

function event(over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    timestamp: '2026-09-27T09:00:00Z',
    timestamp_ns: 0,
    cgroup_id: 0,
    pid: 10,
    tid: 10,
    ppid: 1,
    uid: 0,
    gid: 0,
    event_type: 1,
    event_name: 'execve',
    category: 'process',
    severity: 3,
    severity_name: 'high',
    comm: 'bash',
    filename: '/usr/bin/xmrig',
    action: 0,
    action_name: '',
    ...over,
  } as TraceEvent;
}

function policyShell(): EnforcementPolicy {
  return {
    id: 1,
    name: 'p',
    description: '',
    enabled: true,
    event_types: [],
    min_severity: 'info',
    match_comm: '',
    match_filename: '',
    match_uid: null,
    match_dest_port: '',
    action: 'alert',
    kernel_enforce: false,
    created_at: '',
    updated_at: '',
    hit_count: 0,
  };
}

describe('policy editor defaults and confirmation', () => {
  test('a new policy starts in Simulate and never needs a confirmation', () => {
    const draft = defaultPolicyDraft();
    expect(draft.action).toBe('simulate');
    expect(policySaveTier(draft)).toBe('none');
    expect(draftFromEvent({ event_name: 'connect', comm: 'nc' }).action).toBe('simulate');
  });

  test('saving or enabling kill/block is typed; disabled or non-enforcing is none', () => {
    expect(policySaveTier({ action: 'kill', enabled: true })).toBe('typed');
    expect(policySaveTier({ action: 'block', enabled: true })).toBe('typed');
    expect(policySaveTier({ action: 'kill', enabled: false })).toBe('none');
    expect(policySaveTier({ action: 'alert', enabled: true })).toBe('none');
  });

  test('a broad kill needs the acknowledgement; a narrowed kill does not', () => {
    expect(needsKillAcknowledgement(defaultPolicyDraft({ action: 'kill' }))).toBe(true);
    expect(needsKillAcknowledgement(defaultPolicyDraft({ action: 'kill', match_comm: 'xmrig' }))).toBe(false);
    expect(needsKillAcknowledgement(defaultPolicyDraft({ action: 'block' }))).toBe(false);
  });

  test('weak criteria do not narrow a kill (mirrors policyHasNarrowingMatch in Go)', () => {
    const kill = (over: Partial<ReturnType<typeof defaultPolicyDraft>>) => needsKillAcknowledgement(defaultPolicyDraft({ action: 'kill', ...over }));
    expect(kill({ match_uid: 0 })).toBe(true);
    expect(kill({ match_uid: 1000 })).toBe(false);
    expect(kill({ match_filename: '/' })).toBe(true);
    expect(kill({ match_filename: '///' })).toBe(true);
    expect(kill({ match_filename: '/tmp/' })).toBe(true);
    expect(kill({ match_filename: '/usr/' })).toBe(true);
    expect(kill({ match_filename: '/bin' })).toBe(true);
    expect(kill({ match_filename: 'lib' })).toBe(true);
    expect(kill({ match_filename: '/usr/bin/' })).toBe(true);
    expect(kill({ match_filename: '/dev/shm/' })).toBe(false);
    expect(kill({ match_filename: '/var/log/' })).toBe(false);
    expect(kill({ match_filename: 'xmrig' })).toBe(false);
    expect(kill({ match_filename: '/dev/shm/, /' })).toBe(true);
    expect(kill({ match_comm: 'nc' })).toBe(true);
    expect(kill({ match_comm: 'nc', match_comm_mode: 'exact' })).toBe(true);
    expect(kill({ match_comm: 'ncat, nc' })).toBe(true);
    expect(kill({ match_comm: ' , ' })).toBe(true);
    expect(kill({ match_comm: 'ncat' })).toBe(false);
    expect(kill({ match_comm: 'nc', match_uid: 1000 })).toBe(false);
    expect(kill({ match_comm: 'xmrig', match_uid: 0 })).toBe(false);
    expect(kill({ match_dest_port: '4444' })).toBe(false);
  });

  test('validation: name, uid and port list', () => {
    expect(validatePolicyDraft(defaultPolicyDraft()).name).toBeDefined();
    const errors = validatePolicyDraft(defaultPolicyDraft({ name: 'x', match_uid: -1, match_dest_port: '22, 70000' }));
    expect(errors.match_uid).toBeDefined();
    expect(errors.match_dest_port).toBeDefined();
    expect(validatePolicyDraft(defaultPolicyDraft({ name: 'x', match_uid: 0, match_dest_port: '22, 443' }))).toEqual({});
  });

  test('a block policy is enforced only as a connect denial on one destination IPv4', () => {
    const block = (over: Partial<ReturnType<typeof defaultPolicyDraft>> = {}) => defaultPolicyDraft({ action: 'block', match_dest_ip: '192.0.2.10', ...over });
    expect(blockPolicyEnforces(block())).toBe(true);
    expect(blockPolicyEnforces(block({ event_types: ['execve', 'Connect'] }))).toBe(true);
    expect(blockPolicyEnforces(block({ min_severity: '' }))).toBe(true);
    expect(blockPolicyEnforces(defaultPolicyDraft({ action: 'block' }))).toBe(false);
    expect(blockPolicyEnforces(block({ match_dest_ip: '  ' }))).toBe(false);
    expect(blockPolicyEnforces(block({ match_comm: 'nc' }))).toBe(false);
    expect(blockPolicyEnforces(block({ match_filename: '/tmp/x' }))).toBe(false);
    expect(blockPolicyEnforces(block({ match_uid: 0 }))).toBe(false);
    expect(blockPolicyEnforces(block({ match_dest_port: '443' }))).toBe(false);
    expect(blockPolicyEnforces(block({ event_types: ['execve'] }))).toBe(false);
    expect(blockPolicyEnforces(block({ min_severity: 'high' }))).toBe(false);
  });

  test('an enabled block policy the kernel cannot enforce is not saved; disabled or another action is', () => {
    const named = (over: Partial<ReturnType<typeof defaultPolicyDraft>>) => validatePolicyDraft(defaultPolicyDraft({ name: 'x', ...over }));
    expect(named({ action: 'block' }).action).toBeDefined();
    expect(named({ action: 'block', match_comm: 'nc', match_dest_ip: '192.0.2.10' }).action).toBeDefined();
    expect(named({ action: 'block', match_dest_ip: '192.0.2.10' })).toEqual({});
    expect(named({ action: 'block', enabled: false })).toEqual({});
    expect(named({ action: 'kill', match_comm: 'xmrig' })).toEqual({});
  });

  test('kernel enforcement is downgraded when process, file or uid is matched', () => {
    expect(kernelWillDowngrade(defaultPolicyDraft({ kernel_enforce: true, match_comm: 'nc' }))).toBe(true);
    expect(kernelWillDowngrade(defaultPolicyDraft({ kernel_enforce: true, match_uid: 0 }))).toBe(true);
    expect(kernelWillDowngrade(defaultPolicyDraft({ kernel_enforce: true }))).toBe(false);
  });
});

describe('policyMatchesEvent mirrors PolicyEngine.matchPolicy', () => {
  test('no criteria matches everything', () => {
    expect(policyMatchesEvent(defaultPolicyDraft(), event())).toBe(true);
  });

  test('event types are case-insensitive; severity is a minimum', () => {
    expect(policyMatchesEvent(defaultPolicyDraft({ event_types: ['EXECVE'] }), event())).toBe(true);
    expect(policyMatchesEvent(defaultPolicyDraft({ event_types: ['connect'] }), event())).toBe(false);
    expect(policyMatchesEvent(defaultPolicyDraft({ min_severity: 'critical' }), event())).toBe(false);
    expect(policyMatchesEvent(defaultPolicyDraft({ min_severity: 'high' }), event())).toBe(true);
  });

  test('comm terms follow the match mode; execve also matches the executed file basename', () => {
    expect(policyMatchesEvent(defaultPolicyDraft({ match_comm: 'nc, XMRIG' }), event())).toBe(true);
    expect(policyMatchesEvent(defaultPolicyDraft({ match_comm: 'xmrig' }), event({ event_name: 'openat' }))).toBe(false);
    expect(policyMatchesEvent(defaultPolicyDraft({ match_comm: 'bas', match_comm_mode: 'substring' }), event({ event_name: 'openat' }))).toBe(true);
    expect(policyMatchesEvent(defaultPolicyDraft({ match_comm: 'bas' }), event({ event_name: 'openat' }))).toBe(false);
  });

  test('word mode (default): nc is not runc, python is python3; exact is the whole name', () => {
    const on = (comm: string, match_comm: string, match_comm_mode?: 'exact' | 'word' | 'substring') =>
      policyMatchesEvent(defaultPolicyDraft({ match_comm, ...(match_comm_mode ? { match_comm_mode } : {}) }), event({ event_name: 'connect', comm }));
    expect(defaultPolicyDraft().match_comm_mode).toBe('word');
    expect(on('nc', 'nc')).toBe(true);
    expect(on('nc.openbsd', 'nc')).toBe(true);
    expect(on('runc', 'nc')).toBe(false);
    expect(on('rsync', 'nc')).toBe(false);
    expect(on('python3', 'python')).toBe(true);
    expect(on('sshd', 'sh')).toBe(false);
    expect(on('runc', 'nc', 'substring')).toBe(true);
    expect(on('nc.openbsd', 'nc', 'exact')).toBe(false);
    expect(on('systemd-journal', 'systemd-journald', 'exact')).toBe(true);
  });

  test('an existing policy without a mode keeps substring matching', () => {
    const legacy = { match_comm: 'nc' } as unknown as EnforcementPolicy;
    expect(draftFromPolicy({ ...policyShell(), ...legacy }).match_comm_mode).toBe('substring');
  });

  test('filename terms, exact uid and destination port list', () => {
    expect(policyMatchesEvent(defaultPolicyDraft({ match_filename: '/tmp/, /usr/bin' }), event())).toBe(true);
    expect(policyMatchesEvent(defaultPolicyDraft({ match_uid: 1000 }), event())).toBe(false);
    expect(policyMatchesEvent(defaultPolicyDraft({ match_uid: 0 }), event())).toBe(true);
    expect(policyMatchesEvent(defaultPolicyDraft({ match_dest_port: '4444, 22' }), event({ port: 22 }))).toBe(true);
    expect(policyMatchesEvent(defaultPolicyDraft({ match_dest_port: '4444' }), event({ port: 22 }))).toBe(false);
  });

  test('destination IP matches connect and sendto events to that address', () => {
    const toIp = (over: Partial<TraceEvent>) => policyMatchesEvent(defaultPolicyDraft({ match_dest_ip: '192.0.2.10' }), event(over));
    expect(toIp({ event_name: 'connect', addr: '192.0.2.10' })).toBe(true);
    expect(toIp({ event_name: 'sendto', addr: '::ffff:192.0.2.10' })).toBe(true);
    expect(toIp({ event_name: 'connect', addr: '192.0.2.11' })).toBe(false);
    expect(toIp({ event_name: 'bind', addr: '192.0.2.10' })).toBe(false);
  });

  test('previewMatches counts matches and top processes', () => {
    const preview = previewMatches(defaultPolicyDraft({ event_types: ['execve'] }), [event(), event({ comm: 'sh' }), event({ event_name: 'connect' }), event()]);
    expect(preview.matched).toBe(3);
    expect(preview.sampled).toBe(4);
    expect(preview.processes[0]).toEqual({ comm: 'bash', count: 2 });
  });
});

describe('policy display helpers', () => {
  const policy = {
    id: 1,
    name: 'p',
    description: '',
    enabled: true,
    event_types: ['execve', 'execveat', 'clone', 'kill'],
    min_severity: 'high',
    match_comm: 'nc',
    match_filename: '',
    match_uid: null,
    match_dest_port: '',
    action: 'kill',
    kernel_enforce: true,
    auto_downgraded: true,
    created_at: '',
    updated_at: '',
    hit_count: 0,
  } satisfies EnforcementPolicy;

  test('placement explains block, downgrade, kernel and userspace', () => {
    const connectBlock = { ...policy, action: 'block', event_types: [], min_severity: 'info', match_comm: '', match_dest_ip: '192.0.2.10' };
    expect(policyPlacement(connectBlock).label).toBe('Kernel BPF-LSM');
    expect(policyPlacement({ ...connectBlock, match_comm: 'nc' }).label).toBe('Not enforced');
    expect(policyPlacement({ ...policy, action: 'block' }).label).toBe('Not enforced');
    expect(policyPlacement(policy).label).toBe('Userspace (downgraded)');
    expect(policyPlacement({ ...policy, auto_downgraded: false }).label).toBe('Kernel');
    expect(policyPlacement({ ...policy, auto_downgraded: false, kernel_enforce: false }).label).toBe('Userspace');
  });

  test('match summary and enforcing detection', () => {
    // A policy saved before match_comm_mode matches substrings, and says so.
    expect(policyMatchSummary(policy)).toEqual(['4 event types', 'process (substring): nc']);
    expect(policyMatchSummary({ ...policy, match_comm_mode: 'word' })).toEqual(['4 event types', 'process: nc']);
    expect(policyMatchSummary({ ...policy, match_comm_mode: 'exact' })).toEqual(['4 event types', 'process (exact): nc']);
    expect(policyMatchSummary({ ...policy, event_types: [], match_comm: '' })).toEqual(['every event']);
    expect(hasEnforcingPolicies([policy])).toBe(true);
    expect(hasEnforcingPolicies([{ ...policy, enabled: false }, { ...policy, action: 'alert' }])).toBe(false);
    // A block policy counts only when the kernel enforces it.
    expect(hasEnforcingPolicies([{ ...policy, action: 'block' }])).toBe(false);
    expect(hasEnforcingPolicies([{ ...policy, action: 'block', event_types: [], min_severity: 'info', match_comm: '', match_dest_ip: '192.0.2.10' }])).toBe(true);
    expect(draftFromPolicy(policy).event_types).not.toBe(policy.event_types);
  });
});

describe('trace configuration tiers', () => {
  const all = ['execve', 'connect', 'openat'];
  const cfg = (over: Partial<TraceConfig> = {}): TraceConfig => ({ enabled: true, event_types: [], min_severity: 'info', filter_self: true, filtered_pids: [], ...over });

  test('disabling tracing is simple, or typed while kill/block policies are enabled', () => {
    expect(traceConfigSaveTier(cfg(), cfg({ enabled: false }), all, false)).toBe('simple');
    expect(traceConfigSaveTier(cfg(), cfg({ enabled: false }), all, true)).toBe('typed');
    expect(traceConfigLosses(cfg(), cfg({ enabled: false }), all)[0]).toContain('all runtime events');
  });

  test('capturing less asks; capturing more does not', () => {
    expect(traceConfigSaveTier(cfg(), cfg({ min_severity: 'high' }), all, false)).toBe('simple');
    expect(traceConfigSaveTier(cfg(), cfg({ event_types: ['execve'] }), all, false)).toBe('simple');
    expect(traceConfigLosses(cfg(), cfg({ event_types: ['execve'] }), all)).toEqual(['event types connect, openat']);
    expect(traceConfigSaveTier(cfg({ min_severity: 'high' }), cfg(), all, false)).toBe('none');
    expect(traceConfigSaveTier(cfg({ event_types: ['execve'] }), cfg(), all, false)).toBe('none');
    expect(traceConfigSaveTier(cfg(), cfg({ filter_self: false }), all, true)).toBe('none');
  });
});

describe('detection rule drafts', () => {
  test('operators follow the field type (RuleCondition.Validate)', () => {
    expect(opsForField('comm').map((o) => o.value)).toContain('glob');
    expect(opsForField('port').map((o) => o.value)).not.toContain('contains');
    expect(opsForField('port').map((o) => o.value)).not.toContain('bit_and');
    expect(opsForField('flags').map((o) => o.value)).toContain('bit_and');
    expect(opsForField('is_container').map((o) => o.value)).toEqual(['eq', 'neq']);
    expect(compatibleOp('port', 'contains')).toBe('eq');
    expect(compatibleOp('comm', 'glob')).toBe('glob');
  });

  test('draftToBody validates values and builds typed lists', () => {
    const draft = emptyRuleDraft();
    draft.name = 'Quiet cron';
    draft.conditions = [
      { field: 'comm', op: 'in', value: 'cron, anacron' },
      { field: 'port', op: 'eq', value: '99999' },
      { field: 'uid', op: 'contains', value: '0' },
    ];
    const bad = draftToBody(draft);
    expect(bad.body).toBeUndefined();
    expect(Object.keys(bad.conditionErrors).sort()).toEqual(['1', '2']);
    draft.conditions = [draft.conditions[0], { field: 'severity', op: 'gte', value: '3' }];
    const ok = draftToBody(draft);
    expect(ok.body?.conditions).toEqual([
      { field: 'comm', op: 'in', value: ['cron', 'anacron'] },
      { field: 'severity', op: 'gte', value: 3 },
    ]);
    expect(ok.body?.severity_override).toBeUndefined();
  });

  test('severity override only for escalate/downgrade; round trip from a stored rule', () => {
    const draft = { ...emptyRuleDraft(), name: 'x', action: 'escalate' as const, severity_override: 4, conditions: [{ field: 'comm', op: 'eq', value: 'nc' }] };
    expect(draftToBody(draft).body?.severity_override).toBe(4);
    expect(draftToBody({ ...draft, action: 'suppress' }).body?.severity_override).toBeUndefined();
    // DetectionRule.Validate: escalate and downgrade need the new severity.
    const missing = draftToBody({ ...draft, action: 'downgrade', severity_override: null });
    expect(missing.body).toBeUndefined();
    expect(missing.error).toContain('severity');
    const rule = { id: 'r', project_id: 'p', name: 'n', description: '', enabled: true, built_in: false, action: 'tag' as const, conditions: [{ field: 'event_name', op: 'in', value: ['a', 'b'] }], priority: 5, tags: ['t1', 't2'], hit_count: 0, created_at: '', updated_at: '' };
    expect(draftFromRule(rule).conditions[0].value).toBe('a, b');
    expect(draftFromRule(rule).tags).toBe('t1, t2');
    expect(formatConditions(rule.conditions)).toBe('Event (syscall) name is one of (comma-separated) "a, b"');
  });
});
