import { describe, expect, test } from 'bun:test';
import type { StoredCorrelationRule } from '../src/lib/api';
import {
  chainDraftFromRule,
  chainDraftToBody,
  correlationFieldsFor,
  emptyChainDraft,
  exampleChainDraft,
  formatSpan,
  formatStages,
  fromNanoseconds,
  toNanoseconds,
} from '../src/lib/components/runtime/correlation';
import './support/runes';

const { LiveBuffer } = await import('../src/lib/components/runtime/live.svelte');

describe('durations (no raw nanoseconds in the form)', () => {
  test('seconds and minutes convert to Go nanoseconds and back', () => {
    expect(toNanoseconds(60, 's')).toBe(60_000_000_000);
    expect(toNanoseconds(5, 'min')).toBe(300_000_000_000);
    expect(fromNanoseconds(300_000_000_000)).toEqual({ value: 5, unit: 'min' });
    expect(fromNanoseconds(90_000_000_000)).toEqual({ value: 90, unit: 's' });
    expect(fromNanoseconds(0)).toEqual({ value: null, unit: 's' });
    expect(formatSpan(120_000_000_000)).toBe('2 min');
  });
});

describe('chainDraftToBody mirrors ValidateCorrelationRule', () => {
  test('the example chain builds the wire format', () => {
    const result = chainDraftToBody(exampleChainDraft());
    expect(result.errors).toEqual([]);
    expect(result.body?.max_span_ms).toBe(300_000);
    expect(result.body?.stages).toHaveLength(3);
    expect(result.body?.stages[0].within).toBeUndefined();
    expect(result.body?.stages[1].within).toBe(60_000_000_000);
    expect(result.body?.stages[0].conditions[1]).toEqual({ field: 'filename', op: 'starts_with_any', value: ['/tmp/', '/dev/shm/'] });
  });

  test('rejects a missing name, a span over 30 minutes, one stage and empty values', () => {
    const draft = emptyChainDraft();
    draft.span = 31;
    draft.stages = [draft.stages[0]];
    const result = chainDraftToBody(draft);
    expect(result.body).toBeUndefined();
    expect(result.errors.join(' ')).toContain('chain name');
    expect(result.errors.join(' ')).toContain('30 minutes');
    expect(result.errors.join(' ')).toContain('2 to 8 stages');
    expect(result.fieldErrors['0.0']).toBe('Enter a value.');
  });

  test('a stage gap longer than the span or missing is rejected', () => {
    const draft = exampleChainDraft();
    draft.span = 30;
    draft.spanUnit = 's';
    draft.stages[1].within = 2;
    draft.stages[1].withinUnit = 'min';
    draft.stages[2].within = null;
    const result = chainDraftToBody(draft);
    expect(result.fieldErrors['1']).toContain('maximum span');
    expect(result.fieldErrors['2']).toContain('how soon');
  });

  test('severity is offered for new and existing conditions (the server reads JSON numbers)', () => {
    expect(correlationFieldsFor('event_name').map((f) => f.value)).toContain('severity');
    expect(correlationFieldsFor('severity').map((f) => f.value)).toContain('severity');
  });

  test('severity is numeric; "below" keeps neq', () => {
    const draft = exampleChainDraft();
    draft.stages[1].conditions = [{ field: 'severity', op: 'neq', value: '3' }];
    const result = chainDraftToBody(draft);
    expect(result.body?.stages[1].conditions[0]).toEqual({ field: 'severity', op: 'neq', value: 3 });
  });

  test('a stored rule round-trips through the builder', () => {
    const body = chainDraftToBody(exampleChainDraft()).body!;
    const stored: StoredCorrelationRule = {
      id: 'c1',
      project_id: 'p1',
      name: body.name,
      description: body.description ?? '',
      enabled: true,
      built_in: false,
      rule: { id: 'c1', name: body.name, entity: 'process', max_span: 300_000_000_000, stages: body.stages },
      created_at: '',
      updated_at: '',
    };
    const draft = chainDraftFromRule(stored);
    expect(draft.span).toBe(5);
    expect(draft.spanUnit).toBe('min');
    // 60 s is exactly one minute: the builder shows whole minutes.
    expect(draft.stages[1].within).toBe(1);
    expect(draft.stages[1].withinUnit).toBe('min');
    expect(draft.stages[0].conditions[1].value).toBe('/tmp/, /dev/shm/');
    expect(chainDraftToBody(draft).body).toEqual(body);
    expect(formatStages(body.stages)).toContain('within 1 min');
    expect(formatSpan(45_000_000_000)).toBe('45 s');
    expect(formatSpan(90_000_000_000)).toBe('90 s');
  });
});

describe('LiveBuffer (new rows wait for the operator)', () => {
  type Row = { id: string; t: string };
  test('keeps rows newest first, deduplicated and capped; take() empties it', () => {
    const buffer = new LiveBuffer<Row>((r) => r.id, (r) => r.t, { cap: 3 });
    buffer.push([{ id: 'a', t: '2026-09-27T09:00:01Z' }, { id: 'b', t: '2026-09-27T09:00:02Z' }]);
    buffer.push([{ id: 'b', t: '2026-09-27T09:00:02Z' }, { id: 'c', t: '2026-09-27T09:00:03Z' }, { id: 'd', t: '2026-09-27T09:00:04Z' }]);
    expect(buffer.pending.map((r) => r.id)).toEqual(['d', 'c', 'b']);
    expect(buffer.received).toBe(5);
    expect(buffer.take().map((r) => r.id)).toEqual(['d', 'c', 'b']);
    expect(buffer.pending).toEqual([]);
  });

  test('setAccept drops rows from before a log clear', () => {
    const buffer = new LiveBuffer<Row>((r) => r.id, (r) => r.t);
    buffer.push([{ id: 'old', t: '2026-09-27T08:00:00Z' }, { id: 'new', t: '2026-09-27T10:00:00Z' }]);
    buffer.setAccept((r) => r.t >= '2026-09-27T09:00:00Z');
    expect(buffer.pending.map((r) => r.id)).toEqual(['new']);
    buffer.push([{ id: 'late-old', t: '2026-09-27T08:30:00Z' }]);
    expect(buffer.pending.map((r) => r.id)).toEqual(['new']);
  });
});
