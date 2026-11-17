// Shared registry + converters for Custom rules v2 (Match & act + Engine tuning).
// Field/operator/transform lists mirror the backend field registry contract
// (internal/engine/custom_rules_validate.go); the semantic engine keys mirror
// the tuning validator there, so the editor rejects what the server would reject.
import type {
  CreateCustomRuleBody,
  CustomRule,
  CustomRuleCondition,
  CustomRuleTuning,
} from '#lib/api.js';
import { effectLogsOnly } from '#lib/waf-config.js';

// ── Condition row model (editable UI shape) ─────────────────────────────────

export interface ConditionRowModel {
  /** Stable key for the editor's keyed list; never sent to the server. */
  id: string;
  fieldType: string; // registry key, or raw field string for legacy/unknown fields
  name: string; // nested name for prefixed fields (header:<n>, query:<n>, …)
  operator: string;
  value: string;
  negate: boolean;
  caseSensitive: boolean;
  transforms: string[];
  bodyScope: 'all' | 'key' | 'value';
}

let rowSeq = 0;

/** A new, page-unique key for a condition row. */
export function newRowId(): string {
  rowSeq += 1;
  return `cond-${rowSeq}`;
}

export function emptyConditionRow(): ConditionRowModel {
  return {
    id: newRowId(),
    fieldType: 'path',
    name: '',
    operator: 'contains',
    value: '',
    negate: false,
    caseSensitive: false,
    transforms: [],
    bodyScope: 'all',
  };
}

// ── Field registry (grouped exactly like the UI spec) ───────────────────────

export interface FieldDef {
  value: string; // select value / registry key
  label: string;
  needsName?: boolean; // shows the nested name input
  placeholder?: string;
  prefix?: string; // final field prefix when a name is provided
  lowerName?: boolean; // header names are lowercased on save
  jsonScope?: boolean; // shows the All/Keys/Values body_scope select
}

export const FIELD_GROUPS: { label: string; fields: FieldDef[] }[] = [
  {
    label: 'URI',
    fields: [
      { value: 'uri', label: 'Full URI' },
      { value: 'path', label: 'Path' },
      { value: 'path_ext', label: 'Path extension' },
      { value: 'query', label: 'Query parameter', needsName: true, placeholder: 'Name or dot path, e.g. token, user.email', prefix: 'query' },
    ],
  },
  {
    label: 'HTTP',
    fields: [
      { value: 'method', label: 'Method' },
      { value: 'host', label: 'Host' },
      { value: 'header', label: 'Header', needsName: true, placeholder: 'Header name, e.g. authorization', prefix: 'header', lowerName: true },
      { value: 'header_names', label: 'Any header name' },
    ],
  },
  {
    label: 'Cookies',
    fields: [
      { value: 'cookie', label: 'Cookie', needsName: true, placeholder: 'Cookie name, e.g. session', prefix: 'cookie' },
    ],
  },
  {
    label: 'Any parameter',
    fields: [
      { value: 'param', label: 'Query, form, multipart or JSON', needsName: true, placeholder: 'Name or dot path, e.g. user.email, items.sku', prefix: 'param' },
    ],
  },
  {
    label: 'Body (raw)',
    fields: [
      { value: 'body', label: 'Raw body' },
      { value: 'body_size', label: 'Body size (bytes)' },
      { value: 'body_truncated', label: 'Body truncated flag' },
    ],
  },
  {
    label: 'Body (JSON)',
    fields: [
      { value: 'json', label: 'Whole JSON document', jsonScope: true },
      { value: 'json_pointer', label: 'JSON field (pointer)', needsName: true, placeholder: 'JSON pointer, e.g. /user/name, /items/*/sku', prefix: 'json', jsonScope: true },
    ],
  },
  {
    label: 'Body (form)',
    fields: [
      { value: 'form', label: 'Form field', needsName: true, placeholder: 'Name or dot path, e.g. password, items.photo', prefix: 'form' },
    ],
  },
  {
    label: 'Body (multipart)',
    fields: [
      { value: 'multipart', label: 'Part value', needsName: true, placeholder: 'Name or dot path, e.g. avatar, items.photo', prefix: 'multipart' },
      { value: 'multipart_filename', label: 'Part filename', needsName: true, placeholder: 'Part name, blank targets all parts', prefix: 'multipart:filename' },
      { value: 'multipart_content_type', label: 'All part content types' },
      { value: 'files_count', label: 'Files count' },
    ],
  },
  {
    label: 'Client',
    fields: [
      { value: 'ip', label: 'Client IP' },
      { value: 'country', label: 'Country code' },
      { value: 'user_agent', label: 'User-Agent' },
    ],
  },
];

export const ALL_FIELDS: Record<string, FieldDef> = Object.fromEntries(
  FIELD_GROUPS.flatMap((g) => g.fields.map((f) => [f.value, f]))
);

// ── Operators ────────────────────────────────────────────────────────────────

export const OPERATORS: { value: string; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'contains_word', label: 'contains word' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'equals', label: 'equals' },
  { value: 'matches', label: 'matches (regex)' },
  { value: 'wildcard', label: 'wildcard (glob)' },
  { value: 'in', label: 'in (comma list)' },
  { value: 'cidr', label: 'in CIDR range' },
  { value: 'exists', label: 'exists' },
  { value: 'len_eq', label: 'length =' },
  { value: 'len_gt', label: 'length >' },
  { value: 'len_lt', label: 'length <' },
  { value: 'num_gt', label: 'number >' },
  { value: 'num_ge', label: 'number ≥' },
  { value: 'num_lt', label: 'number <' },
  { value: 'num_le', label: 'number ≤' },
];

export function isKnownOperator(op: string): boolean {
  return OPERATORS.some((o) => o.value === op);
}

// Legacy negated operators → positive operator + negate=true.
const LEGACY_OPERATORS: Record<string, string> = {
  not_contains: 'contains',
  not_equals: 'equals',
  not_cidr: 'cidr',
  not_in: 'in',
  regex: 'matches', // old GUI builder stored the display alias
};

/** An operator the server accepts (current or legacy spelling). */
export function isAcceptedOperator(op: string): boolean {
  return isKnownOperator(op) || op in LEGACY_OPERATORS;
}

// Field bases the server accepts (engine.ConditionFields, part before ":").
const FIELD_BASES = new Set([
  'uri', 'path', 'path_ext', 'query', 'method', 'host', 'header', 'cookie', 'body', 'body_size',
  'body_truncated', 'json', 'form', 'multipart', 'files_count', 'ip', 'country', 'user_agent', 'param',
]);
// "query" alone is rejected too: the server's field table lets query:<name>
// replace the raw-query entry (ValidateCondition).
const NAMED_FIELD_BASES = new Set(['header', 'cookie', 'form', 'query', 'param']);

/** Error text for a condition field the server would reject, else null. */
export function conditionFieldError(field: string): string | null {
  const f = field.trim();
  if (!f) return 'a condition has no field';
  const sep = f.indexOf(':');
  const base = (sep === -1 ? f : f.slice(0, sep)).toLowerCase();
  const name = sep === -1 ? '' : f.slice(sep + 1);
  if (!FIELD_BASES.has(base)) return `unknown condition field "${field}"`;
  if (NAMED_FIELD_BASES.has(base) && !name.trim()) return `field "${field}" needs a name`;
  if (base === 'json' && name && !name.startsWith('/')) return `JSON pointer in "${field}" must start with "/"`;
  if (base === 'multipart' && !name) return `field "${field}" needs a part name`;
  return null;
}

// ── Transforms ───────────────────────────────────────────────────────────────

export const TRANSFORM_GROUPS: { label: string; transforms: { value: string; label: string }[] }[] = [
  {
    label: 'Case',
    transforms: [
      { value: 'lowercase', label: 'lowercase' },
      { value: 'uppercase', label: 'uppercase' },
    ],
  },
  {
    label: 'Decode',
    transforms: [
      { value: 'url_decode', label: 'URL decode' },
      { value: 'url_decode_uni', label: 'URL decode uni' },
      { value: 'html_entity_decode', label: 'HTML entity decode' },
      { value: 'js_decode', label: 'JS decode' },
      { value: 'css_decode', label: 'CSS decode' },
      { value: 'base64_decode', label: 'Base64 decode' },
      { value: 'hex_decode', label: 'Hex decode' },
      { value: 'sql_hex_decode', label: 'SQL hex decode' },
      { value: 'escape_seq_decode', label: 'Escape sequences' },
    ],
  },
  {
    label: 'Path',
    transforms: [
      { value: 'normalize_path', label: 'Normalize path' },
      { value: 'normalize_path_win', label: 'Path (Windows)' },
    ],
  },
  {
    label: 'Whitespace',
    transforms: [
      { value: 'trim', label: 'Trim' },
      { value: 'trim_left', label: 'Trim left' },
      { value: 'trim_right', label: 'Trim right' },
      { value: 'compress_whitespace', label: 'Compress spaces' },
      { value: 'remove_whitespace', label: 'Remove whitespace' },
      { value: 'remove_nulls', label: 'Remove nulls' },
      { value: 'replace_nulls', label: 'Replace nulls' },
    ],
  },
  {
    label: 'Comments',
    transforms: [
      { value: 'remove_comments_char', label: 'Remove comment chars' },
      { value: 'replace_comments', label: 'Replace comments' },
      { value: 'cmd_line', label: 'Command line' },
    ],
  },
  {
    label: 'Hash',
    transforms: [
      { value: 'md5', label: 'MD5' },
      { value: 'sha1', label: 'SHA1' },
      { value: 'sha256', label: 'SHA256' },
      { value: 'length', label: 'Length' },
    ],
  },
];

export const ALL_TRANSFORMS: string[] = TRANSFORM_GROUPS.flatMap((g) => g.transforms.map((t) => t.value));

// ── Semantic engines (skip_semantic multiselect) ─────────────────────────────
// The keys the agent reads in a tuning skip list: the 16 engines and the four
// detectors that take only a switch (header injection, open redirect, prompt
// injection, anomalies). "*" names all 20.

export const SEMANTIC_ENGINES: string[] = [
  'sql', 'xss', 'cmd', 'php', 'python', 'lfi', 'ssrf', 'java', 'ldap', 'nosql',
  'proto_pollution', 'ssti', 'xxe', 'deser', 'jwt', 'graphql',
  'header_injection', 'open_redirect', 'prompt_injection', 'anomaly',
];

export const SEMANTIC_ENGINE_LABELS: Record<string, string> = {
  sql: 'SQL injection',
  xss: 'XSS',
  cmd: 'Command injection',
  php: 'PHP injection',
  python: 'Python injection',
  lfi: 'Path traversal (LFI)',
  ssrf: 'SSRF',
  java: 'Java injection',
  ldap: 'LDAP injection',
  nosql: 'NoSQL injection',
  proto_pollution: 'Prototype pollution',
  ssti: 'Template injection (SSTI)',
  xxe: 'XXE',
  deser: 'Deserialization',
  jwt: 'JWT attacks',
  graphql: 'GraphQL introspection and batch limit',
  header_injection: 'Header and line-break injection',
  open_redirect: 'Open redirect',
  prompt_injection: 'Prompt injection',
  anomaly: 'Anomalies and scanners',
};

/** Label of a skip_semantic entry ("*" = every engine). */
export function semanticEngineLabel(key: string): string {
  if (key === '*') return 'All engines';
  return SEMANTIC_ENGINE_LABELS[key] ?? key;
}

/** Error text for a skip_semantic entry the server would reject, else null. */
export function semanticEngineError(key: string): string | null {
  const k = key.trim().toLowerCase();
  if (!k) return 'Empty engine name.';
  if (k === '*' || SEMANTIC_ENGINES.includes(k)) return null;
  return `"${key}" is not a semantic engine that can be skipped.`;
}

// ── Row ⇄ condition conversion ───────────────────────────────────────────────

export function conditionToRow(c: CustomRuleCondition): ConditionRowModel {
  let fieldType = c.field;
  let name = '';
  if (c.field.startsWith('header:')) {
    fieldType = 'header';
    name = c.field.slice(7);
  } else if (c.field.startsWith('query:')) {
    fieldType = 'query';
    name = c.field.slice(6);
  } else if (c.field.startsWith('cookie:')) {
    fieldType = 'cookie';
    name = c.field.slice(7);
  } else if (c.field.startsWith('json:')) {
    fieldType = 'json_pointer';
    name = c.field.slice(5);
  } else if (c.field.startsWith('form:')) {
    fieldType = 'form';
    name = c.field.slice(5);
  } else if (c.field.startsWith('param:')) {
    fieldType = 'param';
    name = c.field.slice(6);
  } else if (c.field.startsWith('multipart:filename:')) {
    fieldType = 'multipart_filename';
    name = c.field.slice('multipart:filename:'.length);
  } else if (c.field === 'multipart:filename') {
    fieldType = 'multipart_filename';
  } else if (c.field === 'multipart:content_type') {
    fieldType = 'multipart_content_type';
  } else if (c.field.startsWith('multipart:')) {
    fieldType = 'multipart';
    name = c.field.slice('multipart:'.length);
  } else if (!ALL_FIELDS[c.field]) {
    // Unknown/legacy field, keep raw so it round-trips untouched.
    fieldType = c.field;
  }
  const legacy = LEGACY_OPERATORS[c.operator];
  return {
    id: newRowId(),
    fieldType,
    name,
    operator: legacy ?? c.operator,
    value: c.value,
    negate: legacy !== undefined || c.negate === true,
    caseSensitive: c.case_sensitive === true,
    transforms: Array.isArray(c.transforms) ? c.transforms.filter((t) => ALL_TRANSFORMS.includes(t)) : [],
    bodyScope: c.body_scope === 'key' || c.body_scope === 'value' ? c.body_scope : 'all',
  };
}

export function rowToCondition(row: ConditionRowModel): CustomRuleCondition {
  const def = ALL_FIELDS[row.fieldType];
  let field = row.fieldType;
  if (def?.prefix) {
    let name = row.name.trim();
    if (def.lowerName) name = name.toLowerCase();
    if (def.prefix === 'json' && name && !name.startsWith('/')) name = `/${name}`;
    field = name ? `${def.prefix}:${name}` : def.prefix;
  }
  const cond: CustomRuleCondition = {
    field,
    operator: row.operator,
    value: row.value,
    negate: row.negate,
    case_sensitive: row.caseSensitive,
    transforms: [...row.transforms],
  };
  if (def?.jsonScope) cond.body_scope = row.bodyScope;
  return cond;
}

export function rowsToConditions(rows: ConditionRowModel[]): CustomRuleCondition[] {
  return rows.map(rowToCondition);
}

// ── Tuning tab state ─────────────────────────────────────────────────────────

/**
 * The scan modes the editor offers. `both` clears the skips of earlier tuning rules; `disabled` is inspection off.
 */
export type ScanMode = 'default' | 'both' | 'disabled';

/** Modes of a version 1 rule. They read as `default`: neither changes what is inspected now. */
export const LEGACY_SCAN_MODES = ['semantic_only', 'crs_only'] as const;

export function scanModeFromStored(mode: unknown): ScanMode {
  return mode === 'both' || mode === 'disabled' ? mode : 'default';
}

export interface TuningFormState {
  scopeLogic: 'and' | 'or';
  scopeConditions: ConditionRowModel[];
  skipSemantic: string[];
  scanMode: ScanMode;
  /** Saved as `action: "log"`: a detection that would block is recorded as LOG and the request goes on. */
  logOnly: boolean;
}

export const LOG_ONLY_LABEL = 'Log only for matched requests';
export const LOG_ONLY_HINT = 'A detection that would block is recorded as LOG and the request goes on.';

export function emptyTuningState(): TuningFormState {
  return {
    scopeLogic: 'and',
    scopeConditions: [],
    skipSemantic: [],
    scanMode: 'default',
    logOnly: false,
  };
}

export function tuningFromRule(rule: CustomRule | null | undefined): TuningFormState {
  const st = emptyTuningState();
  if (!rule) return st;
  const t = rule.tuning;
  if (!t) {
    // No tuning payload yet (e.g. a Match & act rule switched to tuning):
    // start from its conditions.
    if (Array.isArray(rule.conditions)) st.scopeConditions = rule.conditions.map(conditionToRow);
    if (rule.condition_logic === 'or') st.scopeLogic = 'or';
    return st;
  }
  // The agent reads tuning.scope only, so the editor shows exactly that scope
  // (an empty one applies to every request) and never the top-level conditions.
  // Keys of a v1 rule the editor no longer has (engine, skip_crs, target,
  // sensitivity_delta) are left out here, so they are not saved again. A weaken of a v1 rule shows as the
  // log-only choice when it lowered scores or raised the block threshold, and as nothing otherwise.
  if (Array.isArray(t.scope?.conditions)) st.scopeConditions = t.scope.conditions.map(conditionToRow);
  if (t.scope?.logic === 'or') st.scopeLogic = 'or';
  if (Array.isArray(t.effect?.skip_semantic)) st.skipSemantic = t.effect.skip_semantic.filter((x) => typeof x === 'string');
  st.scanMode = scanModeFromStored(t.effect?.scan_mode);
  st.logOnly = effectLogsOnly(t.effect);
  return st;
}

export function tuningHasEffect(st: TuningFormState): boolean {
  return st.skipSemantic.length > 0 || st.scanMode !== 'default' || st.logOnly;
}

/**
 * First problem that keeps a tuning rule from saving, or null. Mirrors the
 * server validation (skip entries, engine keys) plus the
 * editor's own guard: a tuning rule needs at least one scope condition, so it
 * cannot lower protection for the whole application by accident.
 */
export function tuningStateError(st: TuningFormState): string | null {
  if (st.scopeConditions.length === 0) return 'Engine tuning needs at least one "Apply when" condition.';
  if (!tuningHasEffect(st)) {
    return 'Engine tuning needs at least one effect: skip semantic engines, change the scan mode, or log only.';
  }
  for (const key of st.skipSemantic) {
    const err = semanticEngineError(key);
    if (err) return `Skip semantic engines: ${err}`;
  }
  return null;
}

export function buildTuningPayload(st: TuningFormState): CustomRuleTuning {
  const effect: CustomRuleTuning['effect'] = {};
  if (st.skipSemantic.length > 0) effect.skip_semantic = [...st.skipSemantic];
  if (st.scanMode !== 'default') effect.scan_mode = st.scanMode;
  if (st.logOnly) effect.action = 'log';
  return {
    scope: { logic: st.scopeLogic, conditions: rowsToConditions(st.scopeConditions) },
    // The effect always applies to the whole request.
    target: { components: [], match: 'exact' },
    effect,
  };
}

// ── Tuning rule save body ────────────────────────────────────────────────────

export function buildTuningRuleBody(st: TuningFormState, meta: {
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
}): CreateCustomRuleBody {
  const tuning = buildTuningPayload(st);
  return {
    name: meta.name,
    description: meta.description,
    enabled: meta.enabled,
    priority: meta.priority,
    mode: 'tuning',
    conditions: tuning.scope.conditions,
    condition_logic: st.scopeLogic,
    action: 'log', // fixed for tuning rows, backend ignores it
    tuning,
  };
}
