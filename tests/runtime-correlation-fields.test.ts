import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { StoredCorrelationRule } from '../src/lib/api';
import {
  CORRELATION_FIELDS,
  CORRELATION_OPS,
  DEST_SCOPES,
  LIST_OPS,
  chainDraftFromRule,
  chainDraftToBody,
  conditionDefaultsFor,
  conditionValueKind,
  correlationOpsFor,
  formatStages,
  toggleListItem,
} from '../src/lib/components/runtime/correlation';

// The control plane's validator values (fields and operators sorted, scopes in the order its error names them).
const backend = JSON.parse(readFileSync(new URL('./fixtures/backend/correlation.json', import.meta.url), 'utf8')) as {
  fields: string[];
  ops: string[];
  dest_scopes: string[];
};

// The shape of the built-in cred-dump-exfil-chain as the API returns it.
const credDump: StoredCorrelationRule = {
  id: 'r1',
  project_id: 'p1',
  name: 'Credential_Dump_Exfiltration_Chain',
  description: '',
  enabled: true,
  built_in: true,
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
  rule: {
    id: 'cred-dump-exfil-chain',
    name: 'Credential_Dump_Exfiltration_Chain',
    entity: 'process',
    max_span: 300_000_000_000,
    stages: [
      {
        conditions: [
          { field: 'event_name', op: 'eq', value: 'openat' },
          { field: 'filename', op: 'in', value: ['/etc/shadow', '/etc/gshadow'] },
          { field: 'exe_verified', op: 'neq', value: true },
          { field: 'comm', op: 'not_in', value: ['unix_chkpwd', 'passwd'] },
        ],
      },
      {
        within: 60_000_000_000,
        conditions: [
          { field: 'event_name', op: 'in', value: ['connect', 'sendto'] },
          { field: 'dest_scope', op: 'eq', value: 'public' },
        ],
      },
    ],
  },
};

describe('correlation field and operator metadata', () => {
  test('fields and operators match ValidateCorrelationRule', () => {
    expect(CORRELATION_FIELDS.map((f) => f.value).sort()).toEqual(backend.fields);
    expect(CORRELATION_OPS.map((o) => o.value).sort()).toEqual(backend.ops);
    expect(LIST_OPS).toContain('not_in');
  });

  test('dest_scope values match the validator message', () => {
    expect(DEST_SCOPES.map((s) => s.value)).toEqual(backend.dest_scopes);
  });

  test('per-field operators and value kinds', () => {
    expect(correlationOpsFor('exe_verified').map((o) => o.value)).toEqual(['eq', 'neq']);
    expect(correlationOpsFor('dest_scope').map((o) => o.value)).toEqual(['eq', 'neq', 'in', 'not_in']);
    expect(correlationOpsFor('addr').map((o) => o.value)).toContain('not_in');
    expect(conditionValueKind('exe_verified', 'eq')).toBe('boolean');
    expect(conditionValueKind('dest_scope', 'eq')).toBe('scope');
    expect(conditionValueKind('dest_scope', 'not_in')).toBe('scope_list');
    expect(conditionValueKind('comm', 'not_in')).toBe('list');
    expect(conditionValueKind('addr', 'eq')).toBe('text');
    expect(conditionDefaultsFor('exe_verified')).toEqual({ op: 'eq', value: 'true' });
    expect(conditionDefaultsFor('dest_scope')).toEqual({ op: 'eq', value: 'public' });
  });

  test('toggleListItem adds and removes one scope', () => {
    expect(toggleListItem('', 'public', true)).toBe('public');
    expect(toggleListItem('public', 'private', true)).toBe('public, private');
    expect(toggleListItem('public, private', 'public', false)).toBe('private');
  });
});

describe('built-in cred-dump-exfil-chain', () => {
  test('summary renders booleans and not_in lists', () => {
    const text = formatStages(credDump.rule.stages);
    expect(text).not.toContain('[object');
    expect(text).toContain('exe_verified is not true');
    expect(text).toContain('comm is not one of unix_chkpwd, passwd');
    expect(text).toContain('dest_scope equals public');
  });

  test('draft round-trip keeps value types', () => {
    const draft = chainDraftFromRule(credDump);
    expect(draft.stages[0].conditions[2]).toEqual({ field: 'exe_verified', op: 'neq', value: 'true' });
    const result = chainDraftToBody(draft);
    expect(result.errors).toEqual([]);
    expect(result.body?.stages[0].conditions).toEqual(credDump.rule.stages[0].conditions);
    expect(result.body?.stages[1].conditions).toEqual(credDump.rule.stages[1].conditions);
    expect(typeof result.body?.stages[0].conditions[2].value).toBe('boolean');
  });

  test('a non-scalar value never renders as [object Object]', () => {
    const odd = { ...credDump, rule: { ...credDump.rule, stages: [{ conditions: [{ field: 'addr', op: 'eq', value: { a: 1 } }] }] } };
    expect(formatStages(odd.rule.stages)).toBe('addr equals {"a":1}');
  });
});

describe('validation of the new fields', () => {
  function body(conditions: { field: string; op: string; value: string }[]) {
    return chainDraftToBody({
      name: 'x',
      description: '',
      entity: 'process',
      span: 5,
      spanUnit: 'min',
      stages: [
        { within: null, withinUnit: 's', conditions },
        { within: 60, withinUnit: 's', conditions: [{ field: 'event_name', op: 'eq', value: 'connect' }] },
      ],
    });
  }

  test('exe_verified false is sent as a boolean', () => {
    expect(body([{ field: 'exe_verified', op: 'eq', value: 'false' }]).body?.stages[0].conditions[0]).toEqual({ field: 'exe_verified', op: 'eq', value: false });
    expect(body([{ field: 'exe_verified', op: 'eq', value: 'yes' }]).fieldErrors['0.0']).toBeDefined();
  });

  test('dest_scope values are checked; lists stay lists', () => {
    expect(body([{ field: 'dest_scope', op: 'not_in', value: 'private, loopback' }]).body?.stages[0].conditions[0]).toEqual({ field: 'dest_scope', op: 'not_in', value: ['private', 'loopback'] });
    expect(body([{ field: 'dest_scope', op: 'eq', value: 'internet' }]).fieldErrors['0.0']).toBeDefined();
    expect(body([{ field: 'dest_scope', op: 'contains', value: 'public' }]).fieldErrors['0.0']).toBeDefined();
  });

  test('addr not_in sends a list', () => {
    expect(body([{ field: 'addr', op: 'not_in', value: '10.0.0.1, 10.0.0.2' }]).body?.stages[0].conditions[0]).toEqual({ field: 'addr', op: 'not_in', value: ['10.0.0.1', '10.0.0.2'] });
  });
});
