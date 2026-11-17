/**
 * Correlation chains (multi-stage detection, internal/application/correlation.go):
 * a stage builder model with durations in seconds/minutes instead of raw
 * nanoseconds, validated like ValidateCorrelationRule before it is sent.
 *
 * Wire format: stage `within` and the stored rule's `max_span` are Go
 * time.Duration values (nanoseconds); the request carries `max_span_ms`.
 */
import type { CorrelationCondition, CorrelationRuleBody, CorrelationStage, StoredCorrelationRule } from '#lib/api.js';
import { SEVERITY_LEVELS } from './detection';

export type DurationUnit = 's' | 'min';

export const MAX_SPAN_MINUTES = 30;
export const MIN_STAGES = 2;
export const MAX_STAGES = 8;

const NS_PER_SECOND = 1_000_000_000;
const UNIT_SECONDS: Record<DurationUnit, number> = { s: 1, min: 60 };

export const CORRELATION_ENTITIES = [
  { value: 'process', label: 'Process tree', help: 'Stages must come from the same process or its descendants.' },
  { value: 'cgroup', label: 'Container / cgroup', help: 'Stages may come from any process in the same cgroup (container).' },
] as const;

export const CORRELATION_FIELDS = [
  { value: 'event_name', label: 'Event (syscall) name' },
  { value: 'category', label: 'Category' },
  { value: 'comm', label: 'Process name' },
  { value: 'parent_comm', label: 'Parent process' },
  { value: 'filename', label: 'File path' },
  { value: 'severity', label: 'Severity' },
  { value: 'addr', label: 'Destination address' },
  { value: 'dest_scope', label: 'Destination scope' },
  { value: 'exe_verified', label: 'Verified executable' },
] as const;

/** dest_scope values (application.DestScope*): where a connect/sendto goes. */
export const DEST_SCOPES = [
  { value: 'public', label: 'Public internet' },
  { value: 'private', label: 'Private network' },
  { value: 'loopback', label: 'Loopback' },
  { value: 'local', label: 'Link-local' },
  { value: 'none', label: 'No address' },
] as const;

/** How a condition value is entered and sent. */
export type ConditionValueKind = 'severity' | 'boolean' | 'scope' | 'scope_list' | 'list' | 'text';

/**
 * Fields offered for a condition. Severity is a threshold (0–4; "at least" =
 * eq, "below" = neq); the control plane reads the stored JSON number and
 * refuses other operators or values (ValidateCorrelationRule).
 */
export function correlationFieldsFor(_current: string): ReadonlyArray<{ value: string; label: string }> {
  return CORRELATION_FIELDS;
}

export const CORRELATION_OPS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'starts_with_any', label: 'starts with any of' },
  { value: 'contains', label: 'contains' },
] as const;

/** Operators that take a comma-separated list. */
export const LIST_OPS: readonly string[] = ['in', 'not_in', 'starts_with_any'];

/** exe_verified is a boolean: eq / neq only (ValidateCorrelationRule). */
export const BOOLEAN_OPS = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
] as const;

/** dest_scope compares whole values: no prefix or substring operators. */
export const SCOPE_OPS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
] as const;

/** Input kind for a field and operator. */
export function conditionValueKind(field: string, op: string): ConditionValueKind {
  if (field === 'severity') return 'severity';
  if (field === 'exe_verified') return 'boolean';
  if (field === 'dest_scope') return LIST_OPS.includes(op) ? 'scope_list' : 'scope';
  return LIST_OPS.includes(op) ? 'list' : 'text';
}

/** Operator and value a condition gets when its field changes to `field`. */
export function conditionDefaultsFor(field: string): { op: string; value: string } {
  if (field === 'severity') return { op: 'eq', value: '3' };
  if (field === 'exe_verified') return { op: 'eq', value: 'true' };
  if (field === 'dest_scope') return { op: 'eq', value: 'public' };
  return { op: 'eq', value: '' };
}

/** Adds or removes one item of a comma-separated list value (dest_scope checkboxes). */
export function toggleListItem(text: string, item: string, on: boolean): string {
  const items = listValue(text).filter((v) => v !== item);
  if (on) items.push(item);
  return items.join(', ');
}

export interface ChainConditionDraft {
  field: string;
  op: string;
  /** Text as typed; list operators take comma-separated values; severity takes 0–4. */
  value: string;
}

export interface ChainStageDraft {
  /** Gap to the previous stage; ignored for the first stage. */
  within: number | null;
  withinUnit: DurationUnit;
  conditions: ChainConditionDraft[];
}

export interface ChainDraft {
  name: string;
  description: string;
  entity: 'process' | 'cgroup';
  span: number | null;
  spanUnit: DurationUnit;
  stages: ChainStageDraft[];
}

export function secondsFor(value: number, unit: DurationUnit): number {
  return value * UNIT_SECONDS[unit];
}

/** Nanoseconds (Go time.Duration) for a builder duration. */
export function toNanoseconds(value: number, unit: DurationUnit): number {
  return Math.round(secondsFor(value, unit) * NS_PER_SECOND);
}

/** Builder duration for nanoseconds: whole minutes when exact, else seconds. */
export function fromNanoseconds(ns: number | null | undefined): { value: number | null; unit: DurationUnit } {
  if (!ns || ns <= 0) return { value: null, unit: 's' };
  const seconds = ns / NS_PER_SECOND;
  if (seconds >= 60 && Number.isInteger(seconds / 60)) return { value: seconds / 60, unit: 'min' };
  return { value: Math.round(seconds * 1000) / 1000, unit: 's' };
}

/** "90 s", "5 min" for display. */
export function formatSpan(ns: number | null | undefined): string {
  const { value, unit } = fromNanoseconds(ns);
  return value === null ? 'n/a' : `${value} ${unit}`;
}

function emptyCondition(field = 'event_name'): ChainConditionDraft {
  return { field, op: 'eq', value: '' };
}

export function emptyStage(first = false): ChainStageDraft {
  return { within: first ? null : 60, withinUnit: 's', conditions: [emptyCondition()] };
}

export function emptyChainDraft(): ChainDraft {
  return { name: '', description: '', entity: 'process', span: 5, spanUnit: 'min', stages: [emptyStage(true), emptyStage()] };
}

/** A worked example: file dropped in /tmp, made executable, run by a web server child. */
export function exampleChainDraft(): ChainDraft {
  return {
    name: 'Web shell drop chain',
    description: 'A file written under /tmp or /dev/shm is made executable and then run by a web server child.',
    entity: 'process',
    span: 5,
    spanUnit: 'min',
    stages: [
      { within: null, withinUnit: 's', conditions: [{ field: 'event_name', op: 'eq', value: 'openat' }, { field: 'filename', op: 'starts_with_any', value: '/tmp/, /dev/shm/' }] },
      { within: 60, withinUnit: 's', conditions: [{ field: 'event_name', op: 'in', value: 'fchmodat, chmod' }] },
      { within: 60, withinUnit: 's', conditions: [{ field: 'event_name', op: 'eq', value: 'execve' }, { field: 'parent_comm', op: 'in', value: 'nginx, php-fpm' }] },
    ],
  };
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Editable text of a stored value: lists comma-joined, booleans "true"/"false". */
export function conditionText(condition: CorrelationCondition): string {
  const value = condition.value;
  if (Array.isArray(value)) return value.map(scalarText).join(', ');
  return scalarText(value);
}

/** Builder draft for a stored chain (for editing a custom chain). */
export function chainDraftFromRule(rule: StoredCorrelationRule): ChainDraft {
  const span = fromNanoseconds(rule.rule.max_span);
  return {
    name: rule.name,
    description: rule.description ?? '',
    entity: rule.rule.entity === 'cgroup' ? 'cgroup' : 'process',
    span: span.value,
    spanUnit: span.unit,
    stages: (rule.rule.stages ?? []).map((stage, index) => {
      const within = index === 0 ? { value: null, unit: 's' as DurationUnit } : fromNanoseconds(stage.within);
      return {
        within: within.value,
        withinUnit: within.unit,
        conditions: (stage.conditions ?? []).map((c) => ({ field: c.field, op: c.op, value: conditionText(c) })),
      };
    }),
  };
}

export function listValue(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export interface ChainValidation {
  body?: CorrelationRuleBody;
  errors: string[];
  /** Error per "stageIndex.conditionIndex" or "stageIndex" (within). */
  fieldErrors: Record<string, string>;
}

/** Validates like ValidateCorrelationRule and builds the API body. */
export function chainDraftToBody(draft: ChainDraft): ChainValidation {
  const errors: string[] = [];
  const fieldErrors: Record<string, string> = {};
  const name = draft.name.trim();
  if (!name) errors.push('Enter a chain name.');
  const spanSeconds = draft.span === null ? NaN : secondsFor(draft.span, draft.spanUnit);
  if (!Number.isFinite(spanSeconds) || spanSeconds <= 0 || spanSeconds > MAX_SPAN_MINUTES * 60) {
    errors.push(`Maximum span must be more than 0 and at most ${MAX_SPAN_MINUTES} minutes.`);
    fieldErrors.span = `1 second to ${MAX_SPAN_MINUTES} minutes.`;
  }
  if (draft.stages.length < MIN_STAGES || draft.stages.length > MAX_STAGES) {
    errors.push(`A chain has ${MIN_STAGES} to ${MAX_STAGES} stages (one stage is a plain detection rule).`);
  }
  const stages: CorrelationStage[] = draft.stages.map((stage, si) => {
    const out: CorrelationStage = { conditions: [] };
    if (si > 0) {
      const withinSeconds = stage.within === null ? NaN : secondsFor(stage.within, stage.withinUnit);
      if (!Number.isFinite(withinSeconds) || withinSeconds <= 0) fieldErrors[`${si}`] = 'Enter how soon this stage must follow the previous one.';
      else if (Number.isFinite(spanSeconds) && withinSeconds > spanSeconds) fieldErrors[`${si}`] = 'Cannot be longer than the maximum span.';
      else out.within = toNanoseconds(stage.within as number, stage.withinUnit);
    }
    if (stage.conditions.length === 0) fieldErrors[`${si}`] = fieldErrors[`${si}`] ?? 'Add at least one condition.';
    stage.conditions.forEach((condition, ci) => {
      const id = `${si}.${ci}`;
      const text = condition.value.trim();
      if (!text) {
        fieldErrors[id] = 'Enter a value.';
        return;
      }
      if (condition.field === 'severity') {
        const level = Number(text);
        if (!Number.isInteger(level) || level < 0 || level > 4) {
          fieldErrors[id] = 'Choose a severity.';
          return;
        }
        out.conditions.push({ field: 'severity', op: condition.op === 'neq' ? 'neq' : 'eq', value: level });
        return;
      }
      if (condition.field === 'exe_verified') {
        if (text !== 'true' && text !== 'false') {
          fieldErrors[id] = 'Choose true or false.';
          return;
        }
        out.conditions.push({ field: 'exe_verified', op: condition.op === 'neq' ? 'neq' : 'eq', value: text === 'true' });
        return;
      }
      if (condition.field === 'dest_scope') {
        const values = LIST_OPS.includes(condition.op) ? listValue(text) : [text];
        const bad = values.find((v) => !DEST_SCOPES.some((scope) => scope.value === v));
        if (values.length === 0 || bad !== undefined) {
          fieldErrors[id] = `Destination scope must be one of ${DEST_SCOPES.map((scope) => scope.value).join(', ')}.`;
          return;
        }
        if (!SCOPE_OPS.some((op) => op.value === condition.op)) {
          fieldErrors[id] = 'Destination scope supports equals and is (not) one of.';
          return;
        }
        out.conditions.push({ field: 'dest_scope', op: condition.op, value: LIST_OPS.includes(condition.op) ? values : text });
        return;
      }
      if (LIST_OPS.includes(condition.op)) {
        const values = listValue(text);
        if (values.length === 0) {
          fieldErrors[id] = 'Enter at least one value.';
          return;
        }
        out.conditions.push({ field: condition.field, op: condition.op, value: values });
        return;
      }
      out.conditions.push({ field: condition.field, op: condition.op, value: text });
    });
    return out;
  });
  if (Object.keys(fieldErrors).length > 0) errors.push('Fix the highlighted stages.');
  if (errors.length > 0) return { errors, fieldErrors };
  return {
    errors,
    fieldErrors,
    body: {
      name,
      description: draft.description.trim(),
      entity: draft.entity,
      max_span_ms: Math.round(spanSeconds * 1000),
      stages,
    },
  };
}

function labelOf(list: ReadonlyArray<{ value: string; label: string }>, value: string): string {
  return list.find((item) => item.value === value)?.label ?? value;
}

function conditionSummary(condition: CorrelationCondition): string {
  if (condition.field === 'severity') {
    const level = SEVERITY_LEVELS.find((s) => s.value === Number(condition.value));
    return `severity ${condition.op === 'neq' ? 'below' : 'at least'} ${level?.name ?? condition.value}`;
  }
  if (condition.field === 'exe_verified') {
    return `exe_verified ${labelOf(BOOLEAN_OPS, condition.op)} ${conditionText(condition)}`;
  }
  return `${condition.field} ${labelOf(CORRELATION_OPS, condition.op)} ${conditionText(condition)}`;
}

/** "event_name equals openat ∧ filename starts with any of /tmp/ → within 60 s: …" */
export function formatStages(stages: readonly CorrelationStage[] | null | undefined): string {
  if (!stages?.length) return 'n/a';
  return stages
    .map((stage, index) => {
      const conditions = (stage.conditions ?? []).map(conditionSummary).join(' ∧ ');
      return index === 0 ? conditions : `within ${formatSpan(stage.within)}: ${conditions}`;
    })
    .join('  →  ');
}

export function isSeverityField(field: string): boolean {
  return field === 'severity';
}

/** Severity is compared as "at least" (any operator but neq) or "below" (neq). */
export const SEVERITY_OPS = [
  { value: 'eq', label: 'is at least' },
  { value: 'neq', label: 'is below' },
] as const;

/** Operators offered for a field. */
export function correlationOpsFor(field: string): ReadonlyArray<{ value: string; label: string }> {
  if (isSeverityField(field)) return SEVERITY_OPS;
  if (field === 'exe_verified') return BOOLEAN_OPS;
  if (field === 'dest_scope') return SCOPE_OPS;
  return CORRELATION_OPS;
}
