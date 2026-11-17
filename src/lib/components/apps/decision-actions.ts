/**
 * Actions offered in the decision drawer:
 * - copy the recorded request as a cURL command;
 * - tune a false positive: open Custom rules with a tuning rule prefilled
 *   from the decision (scope and the engines to skip);
 * - block the client IP with an app custom rule.
 *
 * Pure functions, unit-tested in web/tests/apps-decision-actions.test.ts.
 */
import type { CreateCustomRuleBody, WAFDecisionRow } from '../../api';
import { gapFlags, SCRIPT_COVERAGE_FLAGS } from './decision-format';

type Decision = Pick<
  WAFDecisionRow,
  | 'id'
  | 'method'
  | 'host'
  | 'uri'
  | 'remote_addr'
  | 'action'
  | 'score'
  | 'categories'
  | 'match_detail'
  | 'match_source'
  | 'analyze_method'
  | 'content_type'
  | 'payload_type'
  | 'event_time'
  | 'request_headers'
  | 'request_body'
  | 'body_preview'
  | 'body_size'
>;

// ── cURL ────────────────────────────────────────────────────────────────────

/** POSIX shell single-quoting: `it's` → `'it'\''s'`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Headers curl derives itself or that would break a replay. */
const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'accept-encoding']);

/** Why a decision cannot be copied as cURL, or null when it can. */
export function curlUnavailableReason(d: Pick<Decision, 'method' | 'host' | 'match_source'>): string | null {
  if (d.method === 'WEBSOCKET' || (d.match_source ?? '').startsWith('ws:')) return 'WebSocket messages cannot be replayed with cURL.';
  if (!d.host) return 'The decision has no Host, so the request URL is unknown.';
  return null;
}

/**
 * The recorded request as a cURL command. Telemetry excludes sensitive
 * headers (Authorization is redacted by the agent) and may truncate the
 * body, so the command reproduces the shape of the request, not a faithful
 * replay. `scheme` defaults to http because the decision does not record it.
 */
export function curlCommand(d: Decision, opts: { scheme?: 'http' | 'https' } = {}): string {
  const scheme = opts.scheme ?? 'http';
  const path = d.uri ? (d.uri.startsWith('/') ? d.uri : `/${d.uri}`) : '/';
  const parts: string[] = ['curl', shellQuote(`${scheme}://${d.host}${path}`)];
  const method = (d.method || 'GET').toUpperCase();
  if (method === 'HEAD') parts.push('--head');
  else if (method !== 'GET') parts.push('-X', shellQuote(method));
  const headers = Object.entries(d.request_headers ?? {})
    .filter(([name]) => !SKIP_HEADERS.has(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [name, value] of headers) parts.push('-H', shellQuote(`${name}: ${value}`));
  const body = d.request_body || d.body_preview || '';
  if (body && method !== 'GET' && method !== 'HEAD') parts.push('--data-raw', shellQuote(body));
  // One option per line keeps long commands readable when pasted.
  const lines: string[] = [];
  let current = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i];
    if (token.startsWith('-') && !token.startsWith("'")) {
      lines.push(current);
      current = `  ${token}`;
    } else {
      current += ` ${token}`;
    }
  }
  lines.push(current);
  return lines.join(' \\\n');
}

/** True when the recorded body is shorter than the request body. */
export function curlBodyTruncated(d: Pick<Decision, 'request_body' | 'body_preview' | 'body_size'>): boolean {
  const body = d.request_body || d.body_preview || '';
  return d.body_size > 0 && body.length < d.body_size;
}

// ── Tune a false positive ─────────────────────────────────────────────────

/**
 * Semantic engine keys a tuning rule may skip: exactly the keys the backend
 * accepts in `skip_semantic` (internal/engine/custom_rules_validate.go
 * knownSemanticEngineKeys): the 16 engines and the four detectors that take only
 * a switch, so a decision from any category the agent reports prefills an engine.
 */
export const TUNABLE_SEMANTIC_ENGINES = [
  'sql', 'xss', 'cmd', 'php', 'python', 'lfi', 'ssrf', 'java', 'nosql', 'ssti', 'xxe', 'deser', 'ldap', 'proto_pollution',
  'jwt', 'graphql', 'header_injection', 'open_redirect', 'prompt_injection', 'anomaly',
] as const;

/** Category (decision / semantic category names, match-detail prefixes) → tunable engine key. */
const CATEGORY_ENGINE: Record<string, (typeof TUNABLE_SEMANTIC_ENGINES)[number]> = {
  sqli: 'sql',
  sql: 'sql',
  xss: 'xss',
  rce: 'cmd',
  cmd: 'cmd',
  cmdi: 'cmd',
  php: 'php',
  python: 'python',
  lfi: 'lfi',
  ssrf: 'ssrf',
  java: 'java',
  ldap: 'ldap',
  nosqli: 'nosql',
  nosql: 'nosql',
  prototypepollution: 'proto_pollution',
  prototype_pollution: 'proto_pollution',
  proto_pollution: 'proto_pollution',
  ssti: 'ssti',
  xxe: 'xxe',
  deserialization: 'deser',
  deser: 'deser',
  // engine.ReasonSemanticJWT / ReasonSemanticGraphQL (stored as categories).
  semantic_jwt: 'jwt',
  jwt: 'jwt',
  semantic_graphql: 'graphql',
  graphql: 'graphql',
  headerinjection: 'header_injection',
  header_injection: 'header_injection',
  openredirect: 'open_redirect',
  open_redirect: 'open_redirect',
  promptinjection: 'prompt_injection',
  prompt_injection: 'prompt_injection',
  anomaly: 'anomaly',
};

export function engineForCategory(category: string): string | null {
  const key = category.trim().toLowerCase();
  return CATEGORY_ENGINE[key.replace(/[\s-]/g, '')] ?? CATEGORY_ENGINE[key] ?? null;
}

export interface TuningDraft {
  app: string;
  /** Decision id, for the rule description. */
  decision: string;
  name: string;
  /** Scope: the request path (no query string). */
  path: string;
  method: string;
  skipSemantic: string[];
}

type CoverageRow = Pick<Decision, 'score' | 'categories' | 'match_detail'> & { coverage?: string | null };

/** Coverage gap flags of a row: the coverage column, or the "coverage:" note when it is empty. Engine marks are not gaps and are left out. */
function rowCoverageFlags(d: Pick<Decision, 'match_detail'> & { coverage?: string | null }): string[] {
  const flags = gapFlags(d.coverage);
  if (flags.length > 0) return flags;
  const note = (d.match_detail ?? '').trim();
  return note.startsWith('coverage:') ? gapFlags(note.split(';')[0]) : [];
}

const matchedNothing = (d: Pick<Decision, 'score' | 'categories'>) => !(d.score > 0) && (d.categories?.length ?? 0) === 0;

/**
 * A decision that only records an inspection gap: part of the request was not
 * inspected (scan coverage flags, or a "coverage:" note), and nothing matched,
 * so there is no score and no category. No rule fired, so no rule can be tuned.
 * A script rule that did not finish is not a gap: see isScriptIncomplete.
 */
export function isInspectionGap(d: CoverageRow): boolean {
  return matchedNothing(d) && rowCoverageFlags(d).some((flag) => !SCRIPT_COVERAGE_FLAGS.includes(flag));
}

/** A script rule of the application did not finish for this request (it timed out or failed, or the agent has no script runner). */
export function isScriptIncomplete(d: Pick<Decision, 'match_detail'> & { coverage?: string | null }): boolean {
  return rowCoverageFlags(d).some((flag) => SCRIPT_COVERAGE_FLAGS.includes(flag));
}

/** Whether "Tune false positive" makes sense: a decision that matched something. */
export function canTuneDecision(d: Pick<Decision, 'action' | 'score' | 'categories' | 'match_detail'> & { coverage?: string | null }): boolean {
  if (d.action !== 'block' && d.action !== 'log' && d.action !== 'monitor') return false;
  if (isInspectionGap(d) || (matchedNothing(d) && isScriptIncomplete(d))) return false;
  // A row whose only detail is a coverage note has no rule to tune.
  if (matchedNothing(d) && (d.match_detail ?? '').trim().startsWith('coverage:')) return false;
  return d.score > 0 || (d.categories?.length ?? 0) > 0 || Boolean(d.match_detail);
}

export function tuningDraftFromDecision(d: Decision, appId: string): TuningDraft {
  const path = (d.uri || '/').split('?')[0] || '/';
  const detail = d.match_detail ?? '';
  const engines = new Set<string>();
  // Semantic match details look like "sql:union_based" (engine.NormalizeSemanticForSIEM).
  const prefix = /^([a-z_]+):/i.exec(detail.trim())?.[1];
  if (prefix) {
    const engine = engineForCategory(prefix);
    if (engine) engines.add(engine);
  }
  for (const category of d.categories ?? []) {
    const engine = engineForCategory(String(category));
    if (engine) engines.add(engine);
  }
  const skipSemantic = [...engines];
  const what = skipSemantic[0] ?? 'detection';
  return {
    app: appId,
    decision: String(d.id || ''),
    name: `Tune ${what} on ${path}`.slice(0, 64),
    path,
    method: (d.method || '').toUpperCase() === 'WEBSOCKET' ? '' : (d.method || '').toUpperCase(),
    skipSemantic,
  };
}

/**
 * Query string for Custom rules (`/projects/:id/rules`) that opens a new
 * tuning rule prefilled from the draft. Keys: create=tuning, app, decision,
 * name, path, method, skip_semantic (comma list).
 */
export function tuningRuleSearch(draft: TuningDraft): string {
  const p = new URLSearchParams();
  p.set('create', 'tuning');
  p.set('app', draft.app);
  if (draft.decision && draft.decision !== '0') p.set('decision', draft.decision);
  p.set('name', draft.name);
  p.set('path', draft.path);
  if (draft.method) p.set('method', draft.method);
  if (draft.skipSemantic.length) p.set('skip_semantic', draft.skipSemantic.join(','));
  return `?${p.toString()}`;
}

export function tuningRuleHref(base: string, projectId: string, draft: TuningDraft): string {
  return `${base}/projects/${encodeURIComponent(projectId)}/rules${tuningRuleSearch(draft)}`;
}

// ── Block the client IP ─────────────────────────────────────────────────────

/** App custom rule that blocks one client IP (field `ip`, operator `equals`). */
export function blockIpRuleBody(ip: string, d: Pick<Decision, 'id' | 'event_time' | 'uri'>): CreateCustomRuleBody {
  const address = ip.trim();
  const source = d.id ? `decision #${d.id}` : 'a live decision';
  return {
    name: `Block ${address}`.slice(0, 64),
    description: `Created from ${source} (${d.event_time}) on ${(d.uri || '/').split('?')[0]}.`,
    enabled: true,
    priority: 0,
    mode: 'gui',
    conditions: [{ field: 'ip', operator: 'equals', value: address }],
    condition_logic: 'and',
    action: 'block',
  };
}
