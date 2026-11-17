/**
 * Custom rules import and export.
 *
 * Export writes one JSON file per application:
 *
 *   { "app_id", "app_name", "exported_at", "rules": [ {name, description,
 *     enabled, priority, mode, conditions, condition_logic, action, script,
 *     tuning}, … ] }
 *
 * Import reads that file (or a bare array of rules), validates every entry
 * the way the server would (mode, action, conditions, script, tuning effect)
 * and returns one preview row per entry. Invalid rows cannot be selected and
 * never count towards the import. Selected rules are created DISABLED unless
 * the operator explicitly keeps the enabled state from the file, so an import
 * cannot switch on an Allow rule by itself.
 *
 * Pure functions only: the page owns the file input, the Blob download and
 * the API calls.
 */
import type { CreateCustomRuleBody, CustomRule, CustomRuleCondition, CustomRuleTuning } from './api';
import {
  ALL_TRANSFORMS,
  conditionFieldError,
  isAcceptedOperator,
  LEGACY_SCAN_MODES,
  scanModeFromStored,
  semanticEngineError,
} from './components/rules/registry';
import { enableRisk, type RuleRisk } from './components/rules/rule-risk';
import { effectLogsOnly } from './waf-config';
import { SCRIPT_OWNER_MESSAGE } from './components/rules/script-access';

/** Per-application rule cap (engine.MaxRulesPerApp). */
export const MAX_RULES_PER_APP = 200;
/** Condition cap per rule (engine.MaxConditionsPerRule). */
export const MAX_CONDITIONS_PER_RULE = 64;
/** Largest rules file the import accepts. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

const MODES = ['gui', 'script', 'tuning'] as const;
const ACTIONS = ['block', 'allow', 'challenge', 'log'] as const;
const TRANSFORMS = new Set(ALL_TRANSFORMS);

type Mode = (typeof MODES)[number];
type Action = (typeof ACTIONS)[number];

// ── Export ──────────────────────────────────────────────────────────────────

export interface ExportedRule {
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  mode: CustomRule['mode'];
  conditions: CustomRuleCondition[];
  condition_logic: 'and' | 'or';
  action: CustomRule['action'];
  script: string;
  tuning?: CustomRuleTuning;
}

export interface RulesExport {
  app_id: string;
  app_name?: string;
  exported_at: string;
  rules: ExportedRule[];
}

/** Export payload: rule content only (no ids, timestamps or hit counts). */
export function buildRulesExport(
  rules: readonly CustomRule[],
  app: { id: string; name?: string } | undefined,
  now: Date = new Date()
): RulesExport {
  return {
    app_id: app?.id ?? '',
    app_name: app?.name,
    exported_at: now.toISOString(),
    rules: rules.map((r) => {
      const out: ExportedRule = {
        name: r.name,
        description: r.description ?? '',
        enabled: r.enabled,
        priority: r.priority,
        mode: r.mode,
        conditions: r.conditions ?? [],
        condition_logic: r.condition_logic === 'or' ? 'or' : 'and',
        action: r.action,
        script: r.script ?? '',
      };
      if (r.tuning) out.tuning = r.tuning;
      return out;
    }),
  };
}

/** "custom-rules-<app-slug>.json". */
export function exportFileName(appName: string | undefined): string {
  const slug = (appName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `custom-rules-${slug || 'app'}.json`;
}

// ── Import: validation ──────────────────────────────────────────────────────

export type ImportCheck = { body: CreateCustomRuleBody; error?: undefined } | { body?: undefined; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Error for one condition object, or null. */
function conditionError(raw: unknown, index: number): string | null {
  const at = `condition ${index + 1}`;
  if (!isRecord(raw)) return `${at} is not an object`;
  if (typeof raw.field !== 'string') return `${at} has no field`;
  const fieldErr = conditionFieldError(raw.field);
  if (fieldErr) return `${at}: ${fieldErr}`;
  if (typeof raw.operator !== 'string' || !raw.operator.trim()) return `${at} has no operator`;
  if (!isAcceptedOperator(raw.operator.trim().toLowerCase())) return `${at}: unknown operator "${raw.operator}"`;
  if (raw.value !== undefined && typeof raw.value !== 'string') return `${at}: value must be text`;
  if (typeof raw.value === 'string' && raw.value.length > 2048) return `${at}: value is longer than 2048 characters`;
  if (raw.negate !== undefined && typeof raw.negate !== 'boolean') return `${at}: negate must be true or false`;
  if (raw.case_sensitive !== undefined && typeof raw.case_sensitive !== 'boolean') return `${at}: case_sensitive must be true or false`;
  if (raw.transforms !== undefined) {
    if (!Array.isArray(raw.transforms)) return `${at}: transforms must be a list`;
    if (raw.transforms.length > 16) return `${at}: more than 16 transforms`;
    const unknown = raw.transforms.find((t) => typeof t !== 'string' || !TRANSFORMS.has(t));
    if (unknown !== undefined) return `${at}: unknown transform "${String(unknown)}"`;
  }
  if (raw.body_scope !== undefined && !['all', 'key', 'value'].includes(String(raw.body_scope))) {
    return `${at}: body_scope must be all, key or value`;
  }
  return null;
}

function conditionsError(raw: unknown, label: string, required: boolean): string | null {
  if (raw === undefined || raw === null) return required ? `${label} needs at least one condition` : null;
  if (!Array.isArray(raw)) return `${label} must be a list`;
  if (required && raw.length === 0) return `${label} needs at least one condition`;
  if (raw.length > MAX_CONDITIONS_PER_RULE) return `${label} has more than ${MAX_CONDITIONS_PER_RULE} conditions`;
  for (let i = 0; i < raw.length; i++) {
    const err = conditionError(raw[i], i);
    if (err) return err;
  }
  return null;
}

function tuningError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'tuning rule has no tuning settings';
  const effect = isRecord(raw.effect) ? raw.effect : {};
  // A v1 file may carry engine, target, skip_crs and sensitivity_delta. They are left out of the saved rule
  // (see importedTuning), so they are not checked here.
  const list = effect.skip_semantic;
  if (list !== undefined) {
    if (!Array.isArray(list)) return 'skip_semantic must be a list';
    for (const entry of list) {
      if (typeof entry !== 'string') return 'skip_semantic entries must be text';
      const err = semanticEngineError(entry);
      if (err) return `skip_semantic: ${err}`;
    }
  }
  if (effect.scan_mode !== undefined && ![...LEGACY_SCAN_MODES, 'default', 'both', 'disabled', ''].includes(String(effect.scan_mode))) {
    return `unknown scan mode "${String(effect.scan_mode)}"`;
  }
  if (effect.action !== undefined && effect.action !== 'log' && effect.action !== '') return 'action must be "log"';
  return null;
}

/** The tuning a file's rule is saved with: what the editor still has, none of the keys a v1 file carries for the removed rule engine. */
function importedTuning(raw: Record<string, unknown>, scope: CustomRuleTuning['scope']): CustomRuleTuning {
  const effect = isRecord(raw.effect) ? raw.effect : {};
  const out: CustomRuleTuning['effect'] = {};
  if (Array.isArray(effect.skip_semantic) && effect.skip_semantic.length > 0) out.skip_semantic = effect.skip_semantic as string[];
  const mode = scanModeFromStored(effect.scan_mode);
  if (mode !== 'default') out.scan_mode = mode;
  // A weaken of a v1 file is kept as the log-only choice when it lowered scores or raised the block threshold.
  if (effectLogsOnly(effect)) out.action = 'log';
  return { scope, target: { components: [], match: 'exact' }, effect: out };
}

/**
 * Validates one entry of a rules file and builds the create body the server
 * accepts, keeping the file's `enabled` flag (the caller decides whether it
 * is used). Checks mirror validateCustomRuleBody in waf_custom_rules.go.
 */
export function checkImportEntry(raw: unknown): ImportCheck {
  if (!isRecord(raw)) return { error: 'entry is not an object' };
  if (typeof raw.name !== 'string' || !raw.name.trim()) return { error: 'name is missing' };
  const mode = raw.mode;
  if (!MODES.includes(mode as Mode)) return { error: `unknown mode "${String(mode ?? '')}"` };
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') {
    return { error: 'description must be text' };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return { error: 'enabled must be true or false' };
  if (raw.priority !== undefined && raw.priority !== null && !(typeof raw.priority === 'number' && Number.isInteger(raw.priority))) {
    return { error: 'priority must be a whole number' };
  }
  const logic = raw.condition_logic;
  if (logic !== undefined && logic !== null && logic !== '' && logic !== 'and' && logic !== 'or') {
    return { error: 'condition_logic must be "and" or "or"' };
  }

  const body: Record<string, unknown> = { name: raw.name.trim(), mode };
  if (typeof raw.description === 'string') body.description = raw.description;
  if (typeof raw.enabled === 'boolean') body.enabled = raw.enabled;
  if (typeof raw.priority === 'number') body.priority = raw.priority;
  if (logic === 'and' || logic === 'or') body.condition_logic = logic;

  if (mode === 'tuning') {
    const tuning = raw.tuning;
    const tErr = tuningError(tuning);
    if (tErr) return { error: tErr };
    const t = tuning as Record<string, unknown>;
    // The agent evaluates tuning.scope only (ListTuningRulesRaw); an empty
    // scope is valid and applies to every request, as on the server. The
    // top-level conditions are rewritten to the scope, like the editor does.
    if (t.scope !== undefined && t.scope !== null && !isRecord(t.scope)) return { error: 'tuning scope must be an object' };
    const scope = isRecord(t.scope) ? t.scope : {};
    if (scope.logic !== undefined && scope.logic !== '' && scope.logic !== 'and' && scope.logic !== 'or') {
      return { error: 'tuning scope logic must be "and" or "or"' };
    }
    const cErr = conditionsError(scope.conditions, 'tuning scope', false);
    if (cErr) return { error: cErr };
    const scopeConds = Array.isArray(scope.conditions) ? scope.conditions : [];
    body.action = 'log';
    body.conditions = scopeConds;
    body.condition_logic = scope.logic === 'or' ? 'or' : 'and';
    body.tuning = importedTuning(t, { logic: scope.logic === 'or' ? 'or' : 'and', conditions: scopeConds as CustomRuleCondition[] });
    return { body: body as unknown as CreateCustomRuleBody };
  }

  if (!ACTIONS.includes(raw.action as Action)) return { error: `unknown action "${String(raw.action ?? '')}"` };
  body.action = raw.action;
  if (mode === 'gui') {
    const cErr = conditionsError(raw.conditions, 'Match & act rule', true);
    if (cErr) return { error: cErr };
    body.conditions = raw.conditions;
    return { body: body as unknown as CreateCustomRuleBody };
  }
  // script
  if (typeof raw.script !== 'string' || !raw.script.trim()) return { error: 'script is empty' };
  body.script = raw.script;
  body.conditions = [];
  return { body: body as unknown as CreateCustomRuleBody };
}

// ── Import: preview rows ────────────────────────────────────────────────────

export interface ImportRow {
  /** Position in the file (0-based); the selection key. */
  index: number;
  /** Display name ("unnamed rule" when missing). */
  name: string;
  mode: string;
  action: string;
  /** `enabled` as written in the file (null when absent). */
  enabledInFile: boolean | null;
  priority: number | null;
  /** Create body for a valid entry, null for an invalid one. */
  body: CreateCustomRuleBody | null;
  /** Why the entry cannot be imported. */
  error: string | null;
  /** A rule with the same name (case-insensitive) exists or appears earlier in the file. */
  duplicate: boolean;
}

export type ParseResult = { ok: true; rows: ImportRow[]; appName?: string } | { ok: false; error: string };

function displayName(raw: unknown): string {
  if (isRecord(raw) && typeof raw.name === 'string' && raw.name.trim()) return raw.name.trim();
  return 'unnamed rule';
}

/**
 * Parses a rules file into preview rows. `existingNames` (the application's
 * current rules) marks duplicates; duplicates stay importable, the server
 * allows equal names, but the preview says so.
 */
export function parseRulesFile(text: string, existingNames: Iterable<string> = []): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  const list = Array.isArray(data) ? data : isRecord(data) ? data.rules : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'The file has no "rules" list.' };
  if (list.length === 0) return { ok: false, error: 'The file contains no rules.' };
  const seen = new Set(Array.from(existingNames, (n) => n.trim().toLowerCase()));
  const rows = list.map((raw, index): ImportRow => {
    const check = checkImportEntry(raw);
    const rec = isRecord(raw) ? raw : {};
    const name = displayName(raw);
    const key = name.toLowerCase();
    const duplicate = check.body !== undefined && seen.has(key);
    if (check.body) seen.add(key);
    return {
      index,
      name,
      mode: typeof rec.mode === 'string' ? rec.mode : '',
      action: rec.mode === 'tuning' ? '' : typeof rec.action === 'string' ? rec.action : '',
      enabledInFile: typeof rec.enabled === 'boolean' ? rec.enabled : null,
      priority: typeof rec.priority === 'number' && Number.isFinite(rec.priority) ? rec.priority : null,
      body: check.body ?? null,
      error: check.error ?? null,
      duplicate,
    };
  });
  const appName = isRecord(data) && typeof data.app_name === 'string' ? data.app_name : undefined;
  return { ok: true, rows, appName };
}

/** What the importing user may create: script rules need the project owner role. */
export interface ImportAccess {
  canEditScripts: boolean;
}

const FULL_ACCESS: ImportAccess = { canEditScripts: true };

/**
 * Why a valid row cannot be imported by this user (a script rule for a
 * non-owner: the server answers 403 SCRIPT_RULE_OWNER_REQUIRED), else null.
 */
export function importBlockedReason(row: ImportRow, access: ImportAccess = FULL_ACCESS): string | null {
  if (row.body?.mode === 'script' && !access.canEditScripts) return SCRIPT_OWNER_MESSAGE;
  return null;
}

/** A row this user can import: valid and not blocked by role. */
export function isImportable(row: ImportRow, access: ImportAccess = FULL_ACCESS): boolean {
  return row.body !== null && importBlockedReason(row, access) === null;
}

/** Indexes selected by default: every row this user can import. */
export function defaultImportSelection(rows: readonly ImportRow[], access: ImportAccess = FULL_ACCESS): Set<number> {
  return new Set(rows.filter((r) => isImportable(r, access)).map((r) => r.index));
}

/** Whether a row starts enabled after import. */
export function importsEnabled(row: ImportRow, keepEnabled: boolean): boolean {
  // An absent flag means enabled on the server (Create defaults to true).
  return keepEnabled && row.enabledInFile !== false;
}

/**
 * Create bodies for the selected valid rows, in file order. Every rule is
 * created disabled unless `keepEnabled` is set, in which case the file's
 * flag is kept.
 */
export function buildImportBodies(rows: readonly ImportRow[], selected: ReadonlySet<number>, opts: { keepEnabled: boolean } & Partial<ImportAccess>): CreateCustomRuleBody[] {
  return buildImportItems(rows, selected, opts).map((item) => item.body);
}

/** One rule to create, with the file row it came from (per-row errors). */
export interface ImportItem {
  index: number;
  body: CreateCustomRuleBody;
}

/** Like buildImportBodies, keeping each body's row index; rows the user may not import are left out. */
export function buildImportItems(rows: readonly ImportRow[], selected: ReadonlySet<number>, opts: { keepEnabled: boolean } & Partial<ImportAccess>): ImportItem[] {
  const access: ImportAccess = { canEditScripts: opts.canEditScripts ?? true };
  return rows
    .filter((r) => isImportable(r, access) && selected.has(r.index))
    .map((r) => ({ index: r.index, body: { ...(r.body as CreateCustomRuleBody), enabled: importsEnabled(r, opts.keepEnabled) } }));
}

/**
 * Rows left in the import dialog after an import: the ones that failed (with
 * their error) plus every row that was not sent; created rows are removed so
 * a second Import cannot create them twice.
 */
export function remainingImportRows(rows: readonly ImportRow[], created: ReadonlySet<number>): ImportRow[] {
  return rows.filter((r) => !created.has(r.index));
}

export interface ImportSummary {
  /** Rows in the file. */
  total: number;
  valid: number;
  invalid: number;
  /** Valid rows that are selected, the number that will be imported. */
  selected: number;
  /** Selected rows that start enabled. */
  enabledOnImport: number;
  /** Selected rows that start enabled and would need a confirmation to enable. */
  risky: { row: ImportRow; risk: RuleRisk }[];
  duplicates: number;
  /** Valid rows this user may not import (script rules for a non-owner). */
  blocked: number;
}

export function summarizeImport(rows: readonly ImportRow[], selected: ReadonlySet<number>, keepEnabled: boolean, access: ImportAccess = FULL_ACCESS): ImportSummary {
  const valid = rows.filter((r) => r.body);
  const chosen = valid.filter((r) => selected.has(r.index) && isImportable(r, access));
  const enabled = chosen.filter((r) => importsEnabled(r, keepEnabled));
  const risky = enabled
    .map((row) => ({ row, risk: enableRisk(row.body as CreateCustomRuleBody) }))
    .filter((x): x is { row: ImportRow; risk: RuleRisk } => x.risk !== null);
  return {
    total: rows.length,
    valid: valid.length,
    invalid: rows.length - valid.length,
    selected: chosen.length,
    enabledOnImport: enabled.length,
    risky,
    duplicates: chosen.filter((r) => r.duplicate).length,
    blocked: valid.filter((r) => !isImportable(r, access)).length,
  };
}

/** Error when importing `adding` rules would pass the per-application cap. */
export function capacityError(existing: number, adding: number, cap: number = MAX_RULES_PER_APP): string | null {
  if (existing + adding <= cap) return null;
  const room = Math.max(0, cap - existing);
  return `An application can hold at most ${cap} custom rules. It has ${existing}, so at most ${room} more can be imported.`;
}
