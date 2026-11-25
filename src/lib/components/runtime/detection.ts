/**
 * Detection rules (trace ingest rules, shared/tracefilter/trace_rules.go):
 * field and operator vocabulary, the editor draft and its conversion to the
 * API body. Conditions are AND-ed; rules apply in priority order.
 */
import type { CreateDetectionRuleBody, DetectionRule, RuleCondition } from '#lib/api.js';
import { conditionValue } from '../../detection-rule';

export type DetectionAction = CreateDetectionRuleBody['action'];

export const DETECTION_ACTIONS: ReadonlyArray<{ value: DetectionAction; label: string; help: string }> = [
  { value: 'suppress', label: 'Suppress', help: 'Drop matching events at ingest: they are not stored, do not raise incidents and do not count in statistics.' },
  { value: 'escalate', label: 'Escalate', help: 'Raise the severity of matching events.' },
  { value: 'downgrade', label: 'Downgrade', help: 'Lower the severity of matching events.' },
  { value: 'tag', label: 'Tag', help: 'Add tags to matching events without changing them otherwise.' },
];

/** Fixed vocabulary for categorical badge tones (identity, not a verdict). */
export const DETECTION_ACTION_VALUES = DETECTION_ACTIONS.map((a) => a.value);

export const DETECTION_FIELDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'comm', label: 'Process name (comm)' },
  { value: 'parent_comm', label: 'Parent process' },
  { value: 'grandparent_comm', label: 'Grandparent process' },
  { value: 'event_name', label: 'Event (syscall) name' },
  { value: 'category', label: 'Category' },
  { value: 'severity', label: 'Severity level (0 info – 4 critical)' },
  { value: 'filename', label: 'File path' },
  { value: 'args', label: 'Rename destination (args)' },
  { value: 'addr', label: 'Network address' },
  { value: 'port', label: 'Port' },
  { value: 'uid', label: 'User ID (uid)' },
  { value: 'gid', label: 'Group ID (gid)' },
  { value: 'detail', label: 'Operation detail (target ID or socket type)' },
  { value: 'flags', label: 'Operation flags' },
  { value: 'addr_family', label: 'Address family' },
  { value: 'container_image', label: 'Container image' },
  { value: 'container_name', label: 'Container name' },
  { value: 'is_container', label: 'Runs in a container (true/false)' },
];

const NUMERIC_FIELDS = new Set(['severity', 'port', 'uid', 'gid', 'addr_family', 'flags', 'detail']);
const BITWISE_FIELDS = new Set(['flags', 'detail']);

export const DETECTION_OPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'glob', label: 'matches glob' },
  { value: 'in', label: 'is one of (comma-separated)' },
  { value: 'not_in', label: 'is none of (comma-separated)' },
  { value: 'gte', label: 'is at least' },
  { value: 'lte', label: 'is at most' },
  { value: 'bit_and', label: 'has any of the bits' },
  { value: 'bit_none', label: 'has none of the bits' },
];

/**
 * Operators the server accepts for a field (RuleCondition.Validate): string
 * fields take the text operators, numeric fields the comparisons (bitwise only
 * for flags and detail), is_container only equality.
 */
export function opsForField(field: string): ReadonlyArray<{ value: string; label: string }> {
  let allowed: string[];
  if (field === 'is_container') allowed = ['eq', 'neq'];
  else if (NUMERIC_FIELDS.has(field)) {
    allowed = ['eq', 'neq', 'in', 'not_in', 'gte', 'lte'];
    if (BITWISE_FIELDS.has(field)) allowed.push('bit_and', 'bit_none');
  } else allowed = ['eq', 'neq', 'contains', 'starts_with', 'glob', 'in', 'not_in'];
  return DETECTION_OPS.filter((op) => allowed.includes(op.value));
}

/** `op` when the field accepts it, otherwise the field's first operator. */
export function compatibleOp(field: string, op: string): string {
  const ops = opsForField(field);
  return ops.some((o) => o.value === op) ? op : ops[0].value;
}

export const SEVERITY_LEVELS: ReadonlyArray<{ value: number; name: 'info' | 'low' | 'medium' | 'high' | 'critical'; label: string }> = [
  { value: 0, name: 'info', label: 'Info' },
  { value: 1, name: 'low', label: 'Low' },
  { value: 2, name: 'medium', label: 'Medium' },
  { value: 3, name: 'high', label: 'High' },
  { value: 4, name: 'critical', label: 'Critical' },
];

export interface ConditionDraft {
  field: string;
  op: string;
  /** Text as typed; lists are comma-separated. */
  value: string;
}

export interface DetectionRuleDraft {
  name: string;
  description: string;
  enabled: boolean;
  action: DetectionAction;
  conditions: ConditionDraft[];
  /** 0–4 or null to keep the event's severity. */
  severity_override: number | null;
  priority: number;
  /** Comma-separated. */
  tags: string;
}

export function emptyRuleDraft(): DetectionRuleDraft {
  return {
    name: '',
    description: '',
    enabled: true,
    action: 'suppress',
    conditions: [{ field: 'comm', op: 'eq', value: '' }],
    severity_override: null,
    priority: 100,
    tags: '',
  };
}

function valueText(value: RuleCondition['value']): string {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

export function draftFromRule(rule: DetectionRule): DetectionRuleDraft {
  return {
    name: rule.name,
    description: rule.description ?? '',
    enabled: rule.enabled,
    action: rule.action,
    conditions: (rule.conditions ?? []).map((c) => ({ field: c.field, op: c.op, value: valueText(c.value) })),
    severity_override: rule.severity_override ?? null,
    priority: rule.priority,
    tags: (rule.tags ?? []).join(', '),
  };
}

export interface RuleDraftResult {
  body?: Omit<CreateDetectionRuleBody, 'host_id'>;
  /** Form-level problem (name, priority, no conditions). */
  error?: string;
  /** Problem per condition index. */
  conditionErrors: Record<number, string>;
}

/** Validates a draft and builds the create/update body. */
export function draftToBody(draft: DetectionRuleDraft): RuleDraftResult {
  const conditionErrors: Record<number, string> = {};
  const name = draft.name.trim();
  if (!name) return { error: 'Enter a rule name.', conditionErrors };
  if (!Number.isInteger(draft.priority) || draft.priority < 1 || draft.priority > 999) {
    return { error: 'Priority must be a whole number from 1 to 999.', conditionErrors };
  }
  if (draft.conditions.length === 0) return { error: 'Add at least one condition.', conditionErrors };
  const withSeverity = draft.action === 'escalate' || draft.action === 'downgrade';
  // The server requires the new severity for escalate and downgrade (DetectionRule.Validate).
  if (withSeverity && (draft.severity_override === null || !SEVERITY_LEVELS.some((s) => s.value === draft.severity_override))) {
    return { error: `Choose the severity to ${draft.action === 'escalate' ? 'raise' : 'lower'} matching events to.`, conditionErrors };
  }
  const conditions: RuleCondition[] = [];
  draft.conditions.forEach((condition, index) => {
    if (condition.value.trim() === '') {
      conditionErrors[index] = 'Enter a value.';
      return;
    }
    if (!opsForField(condition.field).some((op) => op.value === condition.op)) {
      conditionErrors[index] = `"${opLabel(condition.op)}" does not apply to ${fieldLabel(condition.field)}.`;
      return;
    }
    try {
      conditions.push({ field: condition.field, op: condition.op, value: conditionValue(condition.field, condition.op, condition.value) });
    } catch (error) {
      conditionErrors[index] = error instanceof Error ? error.message : 'Invalid value.';
    }
  });
  // The server refuses an args condition without event_name eq rename (DetectionRule.Validate).
  if (Object.keys(conditionErrors).length === 0 && !conditions.some((c) => c.field === 'event_name' && c.op === 'eq' && c.value === 'rename')) {
    draft.conditions.forEach((condition, index) => {
      if (condition.field === 'args') conditionErrors[index] = 'A condition on the rename destination needs the condition Event (syscall) name equals rename.';
    });
  }
  if (Object.keys(conditionErrors).length > 0) return { error: 'Fix the highlighted conditions.', conditionErrors };
  const body: Omit<CreateDetectionRuleBody, 'host_id'> = {
    name,
    description: draft.description.trim(),
    enabled: draft.enabled,
    action: draft.action,
    conditions,
    priority: draft.priority,
    tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  if (withSeverity && draft.severity_override !== null) body.severity_override = draft.severity_override;
  return { body, conditionErrors };
}

export function fieldLabel(field: string): string {
  return DETECTION_FIELDS.find((f) => f.value === field)?.label ?? field;
}

export function opLabel(op: string): string {
  return DETECTION_OPS.find((o) => o.value === op)?.label ?? op;
}

/** One-line summary: `Process name (comm) equals "sshd" AND …`. */
export function formatConditions(conditions: readonly RuleCondition[] | null | undefined): string {
  return (conditions ?? [])
    .map((c) => `${fieldLabel(c.field)} ${opLabel(c.op)} "${valueText(c.value)}"`)
    .join(' AND ');
}

export function severityLevelName(level: number | null | undefined): string {
  if (level === null || level === undefined) return '';
  return SEVERITY_LEVELS.find((s) => s.value === level)?.name ?? '';
}
