/**
 * Labels for decision fields shown in the feed and the decision drawer.
 */
import { SEMANTIC_ENGINE_LABELS } from '../rules/registry';

/**
 * waf_decisions.analyze_method → short label. These are the methods the WAF
 * agent sends (the analyze method constants of crates/domain/src/request.rs,
 * the gate and WebSocket stages of crates/proxy).
 */
const METHOD_LABELS: Record<string, string> = {
  semantic: 'Semantic',
  policy: 'Policy',
  geo: 'Geo access',
  bot: 'Bot protection',
  body_limit: 'Body limit',
  challenge_gate: 'Bot challenge',
  content_scan: 'Content scan',
  custom_rule: 'Custom rule',
  error: 'Error',
  handshake: 'WebSocket handshake',
  ws_origin_check: 'WebSocket origin check',
  ws_frame_scan: 'WebSocket frame scan',
};

/** Methods that stored rows and older agents still carry. Both were semantic analysis. */
const LEGACY_METHOD_LABELS: Record<string, string> = {
  rule_based: METHOD_LABELS.semantic,
  hybrid: METHOD_LABELS.semantic,
};

export function analyzeMethodLabel(method: string | null | undefined): string {
  if (!method) return 'n/a';
  return METHOD_LABELS[method] ?? LEGACY_METHOD_LABELS[method] ?? method.replace(/_/g, ' ');
}

/** The analyze methods the agent sends, for the test against the agent source. The legacy ones are not in it. */
export const LABELED_ANALYZE_METHODS: readonly string[] = Object.keys(METHOD_LABELS);

/**
 * Scan coverage flags (decision.coverage, without the "coverage:" prefix) the
 * WAF agent sends (crates/application/src/coverage.rs coverage_marker(), script_rules.rs,
 * gui_rules.rs). Flags that carry a value are labelled by coverageLabel:
 * `engine_weakened:<engine>` and `body_content_encoding:<encoding>`.
 * `engine_disabled:<engine>` is not a gap. A current control plane sends it as `engines_off`; older rows and
 * control planes still carry it in `coverage`, so it keeps its label (see enginesOffOf).
 */
const COVERAGE_LABELS: Record<string, string> = {
  truncated: 'Value truncated',
  field_cap: 'Body field cap reached',
  query_cap: 'Query parameter cap reached',
  body_binary: 'Binary body not scanned',
  body_binary_text: 'Binary body: only text runs scanned',
  body_decompress_limit: 'Body too large to decompress',
  body_decompress_error: 'Body could not be decompressed',
  body_decompress_budget: 'Body not decompressed (agent memory budget)',
  header_count: 'Header count cap reached',
  header_len: 'Header length cap reached',
  headers_unscanned: 'Headers not scanned',
  engine_panic: 'Engine panic recovered',
  parse_budget: 'Parse budget exhausted',
  regex_budget: 'Regex time budget reached',
  script_timeout: 'Script rule did not finish',
  script_error: 'Script rule failed',
};

/** The plain coverage flags that have a label, for the test against the agent source. */
export const LABELED_COVERAGE_FLAGS: readonly string[] = Object.keys(COVERAGE_LABELS);

/**
 * Coverage flags that say a script rule did not finish, not that part of the request was left unscanned: the
 * request was analyzed in full, the script is what did not run to its end.
 */
export const SCRIPT_COVERAGE_FLAGS: readonly string[] = ['script_timeout', 'script_error'];

export function coverageFlags(coverage: string | null | undefined): string[] {
  return (coverage ?? '')
    .split(',')
    .map((flag) => flag.trim().replace(/^coverage:/, ''))
    .filter(Boolean);
}

function engineName(key: string): string {
  return SEMANTIC_ENGINE_LABELS[key] ?? key.replace(/_/g, ' ');
}

const ENGINE_OFF_FLAG = 'engine_disabled:';
const ENGINE_LOG_ONLY_FLAG = 'engine_log_only:';

/** The coverage gap flags of a decision: the `coverage` text without the engine marks. */
export function gapFlags(coverage: string | null | undefined): string[] {
  return coverageFlags(coverage).filter((flag) => !flag.startsWith(ENGINE_OFF_FLAG) && !flag.startsWith(ENGINE_LOG_ONLY_FLAG));
}

/**
 * The engines the operator switched off for a decision: `engines_off` of the API, plus the `engine_disabled:` flags
 * that older rows and an older control plane carry in `coverage`. Each key once.
 */
export function enginesOffOf(d: { coverage?: string | null; engines_off?: readonly string[] | null }): string[] {
  const marks = coverageFlags(d.coverage).filter((flag) => flag.startsWith(ENGINE_OFF_FLAG)).map((flag) => flag.slice(ENGINE_OFF_FLAG.length));
  return [...new Set([...(d.engines_off ?? []), ...marks].filter(Boolean))];
}

/**
 * The engines whose block was held back as a LOG decision (their action is Log only): `engines_log_only` of the API,
 * plus the `engine_log_only:` flags that a control plane without the field leaves in `coverage`. Each key once.
 */
export function enginesLogOnlyOf(d: { coverage?: string | null; engines_log_only?: readonly string[] | null }): string[] {
  const marks = coverageFlags(d.coverage).filter((flag) => flag.startsWith(ENGINE_LOG_ONLY_FLAG)).map((flag) => flag.slice(ENGINE_LOG_ONLY_FLAG.length));
  return [...new Set([...(d.engines_log_only ?? []), ...marks].filter(Boolean))];
}

/** Name of an engine key, for the lists of switched-off engines. */
export const engineLabel = engineName;

/** "Engines off: SQL injection, XSS" for the feed. */
export function enginesOffText(keys: readonly string[]): string {
  return `Engines off: ${keys.map(engineName).join(', ')}`;
}

/** "Log only: SQL injection" for the feed. */
export function enginesLogOnlyText(keys: readonly string[]): string {
  return `Log only: ${keys.map(engineName).join(', ')}`;
}

/** What a Log only decision means: the engine detected an attack and the request went on. */
export function logOnlyNote(keys: readonly string[]): string {
  const names = keys.map(engineName).join(', ');
  return `The request would have been blocked if ${keys.length === 1 ? `${names} were` : `these engines were`} set to Block.`;
}

export function coverageLabel(flag: string): string {
  if (COVERAGE_LABELS[flag]) return COVERAGE_LABELS[flag];
  if (flag.startsWith('engine_disabled:')) return `Engine off: ${engineName(flag.slice('engine_disabled:'.length))}`;
  if (flag.startsWith(ENGINE_LOG_ONLY_FLAG)) return `Log only: ${engineName(flag.slice(ENGINE_LOG_ONLY_FLAG.length))}`;
  if (flag.startsWith('engine_weakened:')) return `Engine weakened by tuning: ${engineName(flag.slice('engine_weakened:'.length))}`;
  if (flag.startsWith('body_content_encoding:')) return `Body encoding not supported (${flag.slice('body_content_encoding:'.length)})`;
  if (flag.startsWith('body_')) return `Body not decoded (${flag.slice(5).replace(/_/g, ' ')})`;
  return flag.replace(/_/g, ' ');
}

/** What a coverage gap means: the part of the request the engines could not analyze was not inspected. */
export function coverageGapNote(): string {
  return 'Part of this request was not analyzed, so that part was not inspected.';
}

/**
 * Explains a decision whose coverage names a script rule that did not finish. The decision carries no rule name,
 * so the note points to the script rules of the application.
 */
export function scriptIncompleteNote(): string {
  return 'A script rule of this application did not finish for this request, so a request that would have been allowed is logged instead. The detection engines analyzed the whole request; only the script did not run to its end. A script timed out or failed, or the agent cannot run script rules (the WAF agent page says so). Check the script rules of this application.';
}

/** Explains a decision that only records an inspection gap (no score, no category). */
export function inspectionGapNote(): string {
  return 'This request was recorded because part of it was not inspected, not because something matched. It has no score and no category, so there is nothing to tune.';
}

/** The status code, or "Not recorded" for 0, a missing value or anything outside 100 to 599. */
export function statusLabel(status: number | null | undefined): string {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'Not recorded';
}

/** The strength of the detection behind a decision: "Block" (it blocks), "Weak" (it logs) or "n/a" when no detection stands behind it. */
export function strengthLabel(strength: string | null | undefined): string {
  return strength === 'block' ? 'Block' : strength === 'weak' ? 'Weak' : 'n/a';
}

/** Decision action → label; unknown actions are shown as-is. */
export function actionLabel(action: string): string {
  switch (action) {
    case 'block':
      return 'Block';
    case 'allow':
      return 'Allow';
    case 'log':
      return 'Log';
    case 'monitor':
      return 'Monitor';
    case 'upstream_error':
      return 'Upstream error';
    default:
      return action || 'n/a';
  }
}

/**
 * The categories the WAF agent can put on a decision, so the feed filter works on quiet windows too. Source:
 * crates/application/src/analyze.rs (category_for_semantic_reason and the stage blocks), gui_rules.rs,
 * login_protection.rs, crates/proxy/src/pipeline.rs and websocket.rs. A decision can also carry
 * `tuning_rule:<id>`; categoryOptions adds such values from the data.
 */
export const CATEGORY_OPTIONS: readonly string[] = [
  // Detection engines.
  'SQLi', 'XSS', 'RCE', 'PHP', 'Python', 'LFI', 'SSRF', 'Java', 'LDAP', 'PrototypePollution', 'SSTI', 'XXE',
  'Deserialization', 'NoSQLi', 'OpenRedirect', 'HeaderInjection', 'PromptInjection', 'Anomaly', 'GraphQL', 'JWT', 'Semantic',
  // Other stages.
  'ProtocolAttack', 'BodyLimit', 'L7Flood', 'Policy', 'Geo', 'Bot', 'BotChallenge', 'IPReputation', 'Malware',
  'ContentScanIncomplete', 'CustomRule', 'LoginProtection', 'WebSocket',
];

export const METHOD_OPTIONS: readonly string[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'WEBSOCKET'];

/** Union of the canonical categories and the ones seen in data, sorted. */
export function categoryOptions(...seen: (readonly (string | null | undefined)[] | null | undefined)[]): string[] {
  const byKey = new Map<string, string>();
  for (const c of CATEGORY_OPTIONS) byKey.set(c.toLowerCase(), c);
  for (const list of seen) for (const c of list ?? []) if (c) byKey.set(String(c).toLowerCase(), String(c));
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}
