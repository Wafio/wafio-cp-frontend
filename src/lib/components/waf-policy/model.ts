/**
 * WAF policy draft model.
 *
 * `draftFromRules()` turns a saved `rules_json` into a typed, form-friendly
 * draft; `rulesFromDraft()` writes a draft back on top of the original rules
 * with `mergeWafRules`, so every key the form does not know (future fields,
 * method/route tuning, unknown categories, unknown path-rule keys) survives a
 * save. Pure functions only; the reactive wrapper is WafPolicyForm.
 *
 * Numbers edited in `<input type="number">` are `number | null` (null = the
 * field is empty); validation reports empty required fields before a save.
 */
import { effectLogsOnly, mergeWafRules, serializeSemanticPolicy, type PathTuningForm, type SemanticPolicy } from '../../waf-config';
import { INSPECTION_KEYS, inspectionFlagsToSave, inspectionOffFromFlags } from '../../inspection';

export type Json = Record<string, unknown>;
export type NumInput = number | null;

// ── Engine and category catalogue ───────────────────────────────────────────

export const SEMANTIC_KEYS = [
  'sql', 'xss', 'cmd', 'php', 'python', 'lfi', 'ssrf', 'java',
  'nosql', 'ssti', 'xxe', 'deser', 'ldap', 'proto_pollution', 'jwt', 'graphql',
  'header_injection', 'open_redirect', 'prompt_injection', 'anomaly'
] as const;
export type SemanticKey = (typeof SEMANTIC_KEYS)[number];

export interface SemanticEngineMeta {
  key: SemanticKey;
  label: string;
  /** Default evidence thresholds of a threshold engine; 0 for an engine that has none. */
  defaultBlock: number;
  defaultSoft: number;
  /**
   * LDAP, prototype pollution, JWT, GraphQL, header and line-break injection, open redirect, prompt injection and
   * anomalies: the stored entry takes only `disabled` and `action`, no evidence thresholds.
   */
  switchOnly?: boolean;
  /** One plain sentence of what the engine finds, shown under its name. */
  summary: string;
  /** What happens while the engine is off, when "Requests are not checked for this." is not the whole story. */
  offNote?: string;
}

export const SEMANTIC_ENGINES: readonly SemanticEngineMeta[] = [
  { key: 'sql', label: 'SQL injection', defaultBlock: 4.0, defaultSoft: 2.5, summary: 'Injected SQL that changes a database query.' },
  { key: 'xss', label: 'Cross-site scripting', defaultBlock: 3.8, defaultSoft: 2.2, summary: 'Script and markup injected into pages, and server-side include directives.' },
  { key: 'cmd', label: 'Command injection', defaultBlock: 3.2, defaultSoft: 1.6, summary: 'Shell commands injected into a request, and server-side include commands.' },
  { key: 'php', label: 'PHP injection', defaultBlock: 3.2, defaultSoft: 1.6, summary: 'PHP code injected into a request.' },
  { key: 'python', label: 'Python injection', defaultBlock: 3.2, defaultSoft: 1.6, summary: 'Python code injected into a request.' },
  { key: 'lfi', label: 'Local file inclusion', defaultBlock: 3.2, defaultSoft: 1.5, summary: 'Path traversal, file inclusion and uploads named like scripts.' },
  { key: 'ssrf', label: 'Server-side request forgery', defaultBlock: 2.5, defaultSoft: 1.5, summary: 'Requests that make the server call internal addresses or probe hosts.' },
  { key: 'java', label: 'Java / EL injection', defaultBlock: 3.2, defaultSoft: 1.6, summary: 'Java code and expression language injection.' },
  { key: 'nosql', label: 'NoSQL injection', defaultBlock: 3.0, defaultSoft: 1.5, summary: 'NoSQL operators injected into a query.' },
  { key: 'ssti', label: 'Template injection (SSTI)', defaultBlock: 3.0, defaultSoft: 1.8, summary: 'Template syntax injected into a server-side template.' },
  { key: 'xxe', label: 'XML external entities (XXE)', defaultBlock: 2.5, defaultSoft: 1.5, summary: 'External entities, XPath injection and probes in XML.' },
  { key: 'deser', label: 'Deserialization', defaultBlock: 2.5, defaultSoft: 1.5, summary: 'Serialized objects that run code when they are read.' },
  { key: 'ldap', label: 'LDAP injection', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Injected filters in an LDAP query.' },
  { key: 'proto_pollution', label: 'Prototype pollution', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Keys that change the prototype of an object.' },
  { key: 'jwt', label: 'JWT attacks', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Forged or tampered JWT headers.' },
  { key: 'graphql', label: 'GraphQL introspection and batch limit', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Blocks a batch over the operation limit. Introspection queries are only logged.', offNote: 'A batch over the limit is no longer blocked and introspection is no longer logged.' },
  { key: 'header_injection', label: 'Header and line-break injection', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Blocks a mail or cache command behind a line break, and a header behind an encoded one. A header behind a plain line break is only logged.', offNote: 'Line breaks that inject a header or a command are no longer blocked or logged.' },
  { key: 'open_redirect', label: 'Open redirect', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Logs redirect parameters that name another site. It never blocks.', offNote: 'Open redirects are no longer logged.' },
  { key: 'prompt_injection', label: 'Prompt injection', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Blocks instructions aimed at a language model on its chat paths. Anywhere else they are only logged.', offNote: 'Chat paths of language models are no longer blocked.' },
  { key: 'anomaly', label: 'Anomalies and scanners', defaultBlock: 0, defaultSoft: 0, switchOnly: true, summary: 'Blocks scanner User-Agents. Control characters, odd long values and unseen query parameters are only logged.', offNote: 'Scanner User-Agents are no longer blocked, and the list of known query parameters keeps learning.' }
];

/**
 * Engines a path exception may override (semantic_override): every semantic
 * engine. The engines without evidence thresholds take only `disabled` and `action`.
 */
export const PATH_OVERRIDE_ENGINES: readonly SemanticEngineMeta[] = SEMANTIC_ENGINES;

export function semanticMeta(key: SemanticKey): SemanticEngineMeta {
  return SEMANTIC_ENGINES.find((engine) => engine.key === key)!;
}

// ── Engine switches ─────────────────────────────────────────────────────────
// An engine has two stored keys, on `semantic_policies.<key>` (the policy) and on `semantic_override.<key>` (a path).
// `disabled: true` turns it off (the agent reports engine_disabled:<key>); `action: "log"` keeps it on and holds back
// what it would block, as a LOG decision (the agent reports engine_log_only:<key>). `action` is "block" or absent
// for Block. `disabled` wins over `action`. A path entry also replaces the engine's thresholds, so an entry carries
// them, and an entry without `action` inherits the policy's.

/**
 * What an engine does, in the words of the editor: Block (a detection of the engine can block a request), Log only
 * (the detection is recorded as LOG and the request goes on) or Off. The policy table and the path editor both build
 * their choice from this list.
 */
export const ENGINE_ACTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'log', label: 'Log only' },
  { value: 'off', label: 'Off' }
] as const;
export type EngineAction = (typeof ENGINE_ACTIONS)[number]['value'];
type EngineActionOption = { value: EngineAction; label: string };

/** A path adds one more choice: the engine does what the policy says. */
export type EngineState = 'inherit' | EngineAction;
const INHERIT = { value: 'inherit', label: 'Inherit' } as const;

/** The stored `action` of an engine policy. */
export type StoredEngineAction = 'block' | 'log';
const storedAction = (value: unknown): StoredEngineAction | undefined => (value === 'block' || value === 'log' ? value : undefined);

/**
 * Engines of which no detection blocks a request: they only record a LOG decision, so Block and Log only mean the same
 * for them and the editor offers one choice, Log. Every other engine can block, and a few of those also log a weaker
 * kind (see the sentence of each). Read from the agent source: wafio-agent-waf, crates/engine/src/fastscan.rs
 * scan_window, where only open redirect (15) produces no block result, and the three other engines with only a soft
 * result there block elsewhere (graphql batch limit and anomaly scanner User-Agents in crates/application/src/analyze.rs,
 * prompt injection on a chat path at analyze.rs:996). tests/engine-actions.test.ts pins this list.
 */
export const LOG_ONLY_ENGINES: readonly SemanticKey[] = ['open_redirect'];

/** The sentence under an engine that is on Log only. */
export const ENGINE_LOG_ONLY_NOTE = 'Detections are recorded as LOG and the request is let through.';

const optionOf = (value: EngineAction, key?: SemanticKey): EngineActionOption => {
  const option = ENGINE_ACTIONS.find((action) => action.value === value)!;
  return key && LOG_ONLY_ENGINES.includes(key) && value === 'log' ? { value, label: 'Log' } : option;
};

/** The choice of an engine in the policy: Block, Log only and Off, or Log and Off for an engine that never blocks. */
export function engineOptions(key: SemanticKey): EngineActionOption[] {
  const on = LOG_ONLY_ENGINES.includes(key) ? (['log'] as const) : (['block', 'log'] as const);
  return [...on, 'off' as const].map((value) => optionOf(value, key));
}

/** The choice of an engine on a rule path: Inherit, what it does when on, and Off. */
export function pathEngineOptions(key: SemanticKey): { value: EngineState; label: string }[] {
  return [INHERIT, ...engineOptions(key)];
}

/** What an engine does when it is on, from its stored action. */
function onActionOf(key: SemanticKey, action: StoredEngineAction | undefined): 'block' | 'log' {
  return LOG_ONLY_ENGINES.includes(key) || action === 'log' ? 'log' : 'block';
}

/** The action of an engine in the policy. */
export function engineActionOf(key: SemanticKey, engine: Pick<SemanticDraft, 'enabled' | 'action'>): EngineAction {
  return engine.enabled ? onActionOf(key, engine.action) : 'off';
}

/** The words for what an engine does in the policy (or "Off"). */
export function engineActionLabel(key: SemanticKey, engine: Pick<SemanticDraft, 'enabled' | 'action'>): string {
  return optionOf(engineActionOf(key, engine), key).label;
}

/** Sets what an engine does. Block drops a stored Log only; a stored "block" stays as the document had it. */
export function setEngineAction(key: SemanticKey, engine: Pick<SemanticDraft, 'enabled' | 'action'>, action: EngineAction): void {
  engine.enabled = action !== 'off';
  if (LOG_ONLY_ENGINES.includes(key) || action === 'off') return;
  if (action === 'log') engine.action = 'log';
  else if (engine.action === 'log') delete engine.action;
}

/** Policy engines that are switched off, in table order. */
export function enginesOff(draft: Pick<PolicyDraft, 'semantic'>): SemanticEngineMeta[] {
  return SEMANTIC_ENGINES.filter((meta) => !draft.semantic[meta.key]?.enabled);
}

/** Policy engines that are on and only log, in table order. Open redirect is not one of them: it never blocks. */
export function enginesLogOnly(draft: Pick<PolicyDraft, 'semantic'>): SemanticEngineMeta[] {
  return SEMANTIC_ENGINES.filter((meta) => !LOG_ONLY_ENGINES.includes(meta.key) && draft.semantic[meta.key]?.enabled && draft.semantic[meta.key].action === 'log');
}

/** The one-line warning that names the engines that are off ("2 engines are off: A, B."); empty when none is. */
export function enginesOffLine(engines: readonly { label: string }[], where = ''): string {
  if (engines.length === 0) return '';
  const count = engines.length === 1 ? '1 engine is' : `${engines.length} engines are`;
  return `${count} off${where}: ${engines.map((meta) => meta.label).join(', ')}.`;
}

/** The one-line notice that names the engines that only log ("2 engines only log: A, B."); empty when none does. */
export function enginesLogOnlyLine(engines: readonly { label: string }[], where = ''): string {
  if (engines.length === 0) return '';
  const count = engines.length === 1 ? '1 engine only logs' : `${engines.length} engines only log`;
  return `${count}${where}: ${engines.map((meta) => meta.label).join(', ')}.`;
}

/** The sentence under an engine that is off. */
export function engineOffNote(meta: Pick<SemanticEngineMeta, 'offNote'>): string {
  return meta.offNote ?? 'Requests are not checked for this.';
}

/**
 * What a rule path says about one engine: nothing (the policy decides), Block, Log only or off. An entry that is on and
 * names no action does what the policy does, which is Inherit while the policy has the engine on and the policy's
 * action while it has it off (the entry starts the engine).
 */
export function engineStateOf(rule: Pick<PathRuleDraft, 'semanticOverride'>, key: SemanticKey, policy: Pick<PolicyDraft, 'semantic'>): EngineState {
  const entry = rule.semanticOverride[key];
  if (!entry) return 'inherit';
  if (entry.disabled) return 'off';
  const global = policy.semantic[key];
  if (LOG_ONLY_ENGINES.includes(key)) return global.enabled ? 'inherit' : 'log';
  if (entry.action) return entry.action;
  return global.enabled ? 'inherit' : onActionOf(key, global.action);
}

/** A path entry that starts from the policy's values, so a choice for the path does not move thresholds. */
function entryFromPolicy(policy: Pick<PolicyDraft, 'semantic'>, key: SemanticKey, disabled: boolean): SemanticOverrideDraft {
  const meta = semanticMeta(key);
  const global = policy.semantic[key];
  if (meta.switchOnly) return { disabled, block: null, soft: null };
  return { disabled, block: global.block ?? meta.defaultBlock, soft: global.soft ?? meta.defaultSoft };
}

/**
 * Sets a path's choice for one engine. "Inherit" removes the entry (and so its thresholds). Block and Log only write
 * the action on the entry, Off writes `disabled` and drops the action, which it would override.
 */
export function setEngineState(rule: Pick<PathRuleDraft, 'semanticOverride'>, policy: Pick<PolicyDraft, 'semantic'>, key: SemanticKey, state: EngineState): void {
  if (state === 'inherit') {
    delete rule.semanticOverride[key];
    return;
  }
  const entry = (rule.semanticOverride[key] ??= entryFromPolicy(policy, key, state === 'off'));
  entry.disabled = state === 'off';
  // Open redirect never blocks, so its entry names no action: the choice is only on or off.
  if (state === 'off' || LOG_ONLY_ENGINES.includes(key)) delete entry.action;
  else entry.action = state;
}

/** Own values for an engine: an entry that keeps the engine on and inherits its action, starting from the policy's values. */
export function setOwnValues(rule: Pick<PathRuleDraft, 'semanticOverride'>, policy: Pick<PolicyDraft, 'semantic'>, key: SemanticKey, on: boolean): void {
  if (!on) delete rule.semanticOverride[key];
  else rule.semanticOverride[key] ??= entryFromPolicy(policy, key, false);
}

/** What a path chooses for the sensitivity of an engine: the policy's values, a level, or a pair that is no level. */
export type PathSensitivity = 'policy' | SensitivityLevel | 'custom';

/** The sensitivity choice of a path for an engine. An entry that is off, or no entry, follows the policy. */
export function pathSensitivityOf(rule: Pick<PathRuleDraft, 'semanticOverride'>, meta: SemanticEngineMeta): PathSensitivity {
  const entry = rule.semanticOverride[meta.key];
  if (!entry || entry.disabled) return 'policy';
  return sensitivityLevelOf(meta, entry.block, entry.soft);
}

/**
 * Sets the sensitivity choice of a path. 'policy' drops the path's own values (setOwnValues); a level gives the path
 * an entry with the values of that level. 'custom' is a state, not a choice, and changes nothing.
 */
export function setPathSensitivity(rule: Pick<PathRuleDraft, 'semanticOverride'>, policy: Pick<PolicyDraft, 'semantic'>, meta: SemanticEngineMeta, choice: PathSensitivity): void {
  if (choice === 'custom') return;
  if (choice === 'policy') return setOwnValues(rule, policy, meta.key, false);
  setOwnValues(rule, policy, meta.key, true);
  const entry = rule.semanticOverride[meta.key]!;
  const values = sensitivityValues(meta, choice);
  entry.block = values.block;
  entry.soft = values.soft;
}

/** Whether a path gives a threshold engine values of its own: an entry that is on and names no action, or one whose values differ from the policy's. */
export function pathHasOwnValues(rule: Pick<PathRuleDraft, 'semanticOverride'>, policy: Pick<PolicyDraft, 'semantic'>): boolean {
  return SEMANTIC_ENGINES.some((meta) => {
    const entry = rule.semanticOverride[meta.key];
    if (meta.switchOnly || !entry || entry.disabled) return false;
    if (!entry.action) return true;
    const base = entryFromPolicy(policy, meta.key, false);
    return entry.block !== base.block || entry.soft !== base.soft;
  });
}

/** Engines a path holds on Log only by its own entry (not counting an entry that is off), in table order. */
export function pathEnginesLogOnly(rule: Pick<PathRuleDraft, 'semanticOverride'>): SemanticKey[] {
  return SEMANTIC_ENGINES.filter((meta) => !LOG_ONLY_ENGINES.includes(meta.key) && rule.semanticOverride[meta.key]?.disabled === false && rule.semanticOverride[meta.key]?.action === 'log').map((meta) => meta.key);
}

/**
 * Engines that do not run on a path: switched off by the path's override, or skipped by its detection tuning
 * (tuning is applied after the override, so a skip wins). Skipping every engine is "inspection off", not counted here.
 */
export function pathEnginesOff(rule: Pick<PathRuleDraft, 'semanticOverride' | 'tuning'>): SemanticKey[] {
  const skipped = new Set(rule.tuning.effect.skip_semantic);
  return SEMANTIC_ENGINES.filter((meta) => rule.semanticOverride[meta.key]?.disabled === true || skipped.has(meta.key)).map((meta) => meta.key);
}

/**
 * Evidence thresholds of the defaults a new project starts with (internal/engine/config.go defaultRulesJSON).
 * "Reset to default" restores these values. tests/waf-policy-form.test.ts checks them against the backend defaults
 * fixture so the two cannot drift apart.
 */
export const PROJECT_DEFAULT_SENSITIVITY = {
  sql: { block: 4.0, soft: 2.5 },
  xss: { block: 3.8, soft: 2.2 },
  cmd: { block: 3.2, soft: 1.6 },
  lfi: { block: 3.2, soft: 1.5 },
  ssrf: { block: 2.5, soft: 1.5 },
  php: { block: 3.2, soft: 1.6 },
  python: { block: 3.2, soft: 1.6 },
  java: { block: 3.2, soft: 1.6 },
  nosql: { block: 3.0, soft: 1.5 },
  ssti: { block: 3.0, soft: 1.8 },
  xxe: { block: 2.5, soft: 1.5 },
  deser: { block: 2.5, soft: 1.5 }
} as const;

/** The bot score at which Score mode blocks, when the document sets none. */
export const DEFAULT_BOT_SCORE_THRESHOLD = 150;

// ── Draft types ─────────────────────────────────────────────────────────────

export interface SemanticDraft {
  enabled: boolean;
  /** Evidence thresholds (0–100) of threshold engines. */
  block: NumInput;
  soft: NumInput;
  /** The stored `action`: "log" holds the engine's blocks back as LOG, "block" is the default, absent means Block. */
  action?: StoredEngineAction;
}

export type BotMode = 'off' | 'log' | 'score' | 'block';
export type ChallengeType = 'js_challenge' | 'adaptive' | 'click_puzzle' | 'turnstile' | 'hcaptcha';
export type ResponseFormat = 'html' | 'json' | 'xml';

export interface ResponsesDraft {
  jsChallengeHtml: string;
  clickPuzzleHtml: string;
  ipRepHtml: string; ipRepJson: string; ipRepXml: string;
  wafBlockHtml: string; wafBlockJson: string; wafBlockXml: string;
  policyBlockHtml: string; policyBlockJson: string; policyBlockXml: string;
  geoBlockHtml: string; geoBlockJson: string; geoBlockXml: string;
  formats: { waf: ResponseFormat; policy: ResponseFormat; geo: ResponseFormat; ipRep: ResponseFormat };
}

export type PathMatch = 'prefix' | 'exact' | 'regex';
/** Request body a field rule reads (agent: matched on Content-Type). `form` = urlencoded or multipart; `query`/`header` are not applied. */
export type FieldSource = 'any' | 'body.json' | 'urlencoded' | 'multipart' | 'form' | 'query' | 'header';
export type FieldAction = 'mask' | 'encrypt_aes' | 'decrypt_aes';

export interface SemanticOverrideDraft {
  disabled: boolean;
  block: NumInput;
  soft: NumInput;
  /** The stored `action` of the entry; absent inherits the policy's. */
  action?: StoredEngineAction;
}

export interface PathRuleDraft {
  /** The saved JSON object of this rule (unknown keys are written back), null for a new rule. */
  raw: Json | null;
  path: string;
  match: PathMatch;
  /** null = auto: case-insensitive when the rule blocks or has IP rules. */
  caseInsensitive: boolean | null;
  active: boolean;
  /** Requests to this path are not checked for attacks (saved as both disable flags). */
  inspectionOff: boolean;
  comment: string;
  /** Only engines with an override; absent = global policy. */
  semanticOverride: Partial<Record<SemanticKey, SemanticOverrideDraft>>;
  ipRules: { mode: 'allowlist' | 'blocklist'; ips: string } | null;
  block: { status: NumInput; message: string } | null;
  rateLimit: { maxRequests: NumInput; windowSec: NumInput } | null;
  /** Bytes; 0 or null = inherit the global limit. */
  bodySizeLimit: NumInput;
  loginProtection: {
    enabled: boolean;
    maxAttempts: NumInput;
    windowSec: NumInput;
    lockoutSec: NumInput;
    byIp: boolean;
    byUserAgent: boolean;
    identifierField: string;
    methods: string[];
  } | null;
  fieldRules: { field: string; source: FieldSource; action: FieldAction; aesKey: string; methods: string[] }[];
  responseDecryptAes: string;
  responseFieldRules: { field: string; aesKey: string }[];
  tuning: PathTuningForm;
}

export interface PolicyDraft {
  engines: { inspectionOff: boolean; scanAllHeaders: boolean; recordWeakDetections: boolean };
  semantic: Record<SemanticKey, SemanticDraft>;
  geo: { allowIps: string; blockIps: string; allowCountries: string; blockCountries: string };
  blockPolicy: { enabled: boolean; afterN: NumInput; durationSec: NumInput; keyFields: string };
  flood: { enabled: boolean; maxRequests: NumInput; windowSec: NumInput; keyFields: string; allowIps: string };
  /** request_body_limit in bytes; null = no limit. */
  bodyLimit: NumInput;
  bot: {
    mode: BotMode;
    baseScore: NumInput;
    /** Score mode: the bot score at which a request blocks. */
    scoreThreshold: NumInput;
    emptyUA: boolean;
    headerChecks: boolean;
    clientHints: boolean;
    browserImpersonation: boolean;
    blockAICrawlers: boolean;
    uaBlocklist: string;
    uaAllowlist: string;
    ja4Blocklist: string;
    ja4Allowlist: string;
    /** Legacy JA3 hashes, still matched by the agent. */
    ja3Blocklist: string;
    ja3Allowlist: string;
  };
  challenge: {
    enabled: boolean;
    type: ChallengeType;
    siteKey: string;
    secretKey: string;
    cookieTTL: NumInput;
    trigger: 'always' | 'on_bot_detect';
    simulation: boolean;
    ipRepEnabled: boolean;
    ipRepLevel1Block: boolean;
    ipRepLevel2Block: boolean;
    allowLocalIPs: boolean;
    powDifficulty: number;
    goodBotAllowlist: string;
  };
  responses: ResponsesDraft;
  contentScan: {
    enabled: boolean;
    mode: 'block' | 'log' | 'disabled';
    onIncomplete: 'log' | 'block' | 'allow';
    maxBytes: NumInput;
    multipart: boolean;
    rawBody: boolean;
    blocklist: string;
    allowlist: string;
  };
  websocket: {
    enabled: boolean;
    originCheck: boolean;
    origins: string;
    maxTextBytes: NumInput;
    maxBinaryBytes: NumInput;
    maxMessagesPerMin: NumInput;
    scanServerFrames: boolean;
    scanBinaryHashes: boolean;
  };
  siem: { enabled: boolean; webhookUrl: string };
  /** SSRF destination blocklist: dashboard lines and the agent-side file path stay separate. */
  ssrf: { list: string; path: string };
  pathRules: PathRuleDraft[];
}

export interface PolicyOptions {
  /** WebSocket settings exist per application only (app override form). */
  includeWebSocket?: boolean;
}

// ── Small readers ───────────────────────────────────────────────────────────

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: NumInput): NumInput {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** The engines that never read a base score: a stored 0 under them means nothing. */
const UNSCORED_ENGINES: readonly SemanticKey[] = ['header_injection', 'open_redirect', 'prompt_injection', 'anomaly'];

/** The engines that fall back to a category's base score when they have none of their own. */
const CATEGORY_ENGINES: Record<string, SemanticKey[]> = {
  SQLi: ['sql'], XSS: ['xss'], RCE: ['cmd'], PHP: ['php'], Python: ['python'], LFI: ['lfi'], SSRF: ['ssrf'], Java: ['java']
};

/**
 * Whether a stored engine entry is off: `disabled`, or a base score of 0 from a document of version 1 (the control
 * plane rewrites it to `disabled` the same way). Any other base score means nothing now.
 */
function entryIsOff(entry: Json, key: SemanticKey): boolean {
  return entry.disabled === true || (entry.base_score === 0 && !UNSCORED_ENGINES.includes(key));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** One entry per line for a textarea. */
export function joinLines(value: unknown): string {
  return stringList(value).join('\n');
}

/**
 * Textarea → list. Newline separated; `commas` also splits on commas (IP and
 * country lists), `comments` drops lines starting with "#", `lower`
 * lowercases (fingerprints, hashes). Duplicates are kept: the form writes
 * back exactly what the operator entered.
 */
export function splitLines(text: string, opts: { commas?: boolean; comments?: boolean; lower?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (opts.comments && trimmed.startsWith('#'))) continue;
    for (const part of opts.commas ? trimmed.split(',') : [trimmed]) {
      const entry = part.trim();
      if (entry) out.push(opts.lower ? entry.toLowerCase() : entry);
    }
  }
  return out;
}

function listOrUndefined(values: string[]): string[] | undefined {
  return values.length ? values : undefined;
}

/** Number to write for a numeric input (empty inputs fall back). */
function n(value: NumInput, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ── Byte sizes (request_body_limit uses the agent's K/M/G strings) ─────────

/** Parses request_body_limit the way the engine does ("5M", "512K", 1048576). */
export function parseEngineByteSize(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d+)\s*([KMG])?\s*$/i.exec(value);
  if (!match) return null;
  const units: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const bytes = Number(match[1]) * units[(match[2] ?? '').toUpperCase()];
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/** Bytes → the shortest exact engine string ("5M", "512K", "1000"). */
export function formatEngineByteSize(bytes: number): string {
  for (const [unit, size] of [['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${unit}`;
  }
  return String(bytes);
}

// ── Defaults ────────────────────────────────────────────────────────────────

export function emptyTuning(): PathTuningForm {
  return {
    effect: { skip_semantic: [], logOnly: false }
  };
}

export function newPathRule(): PathRuleDraft {
  return {
    raw: null,
    path: '',
    match: 'prefix',
    caseInsensitive: null,
    active: true,
    inspectionOff: false,
    comment: '',
    semanticOverride: {},
    ipRules: null,
    block: null,
    rateLimit: null,
    bodySizeLimit: null,
    loginProtection: null,
    fieldRules: [],
    responseDecryptAes: '',
    responseFieldRules: [],
    tuning: emptyTuning()
  };
}

// ── Path tuning (form ⇄ JSON) ───────────────────────────────────────────────

export function tuningFromRaw(raw: unknown): PathTuningForm {
  const effect = obj(obj(raw).effect);
  return { effect: { skip_semantic: stringList(effect.skip_semantic), logOnly: effectLogsOnly(effect) } };
}

export function tuningLogsOnly(t: PathTuningForm | null | undefined): boolean {
  return t?.effect.logOnly === true;
}

export function tuningSkipCount(t: PathTuningForm | null | undefined): number {
  return t?.effect.skip_semantic.length ?? 0;
}

/** A path tuning that skips every detection engine: matching requests are not checked for attacks. */
export function tuningSkipsAll(t: PathTuningForm | null | undefined): boolean {
  return (t?.effect.skip_semantic ?? []).some((entry) => entry.trim() === '*');
}

export function tuningHasEffect(t: PathTuningForm | null | undefined): boolean {
  return tuningSkipCount(t) > 0 || tuningLogsOnly(t);
}

/**
 * Backend contract: undefined when the effect is empty; the target is always
 * the whole request (`target: null`). Never emits scan_mode (the path's
 * inspection switch owns it; the server rejects it).
 */
export function tuningToJson(t: PathTuningForm | null | undefined): Json | undefined {
  if (!t || !tuningHasEffect(t)) return undefined;
  const effect: Json = {};
  if (t.effect.skip_semantic.length) effect.skip_semantic = [...t.effect.skip_semantic];
  if (tuningLogsOnly(t)) effect.action = 'log';
  return { target: null, effect };
}

// ── Path rules ──────────────────────────────────────────────────────────────

type RestrictsFields = 'block' | 'ipRules' | 'rateLimit' | 'bodySizeLimit' | 'loginProtection' | 'inspectionOff' |
  'semanticOverride' | 'raw' | 'tuning' | 'fieldRules';

/**
 * Mirrors engine PathExceptionConfig.restrictsAccess: the rule only blocks,
 * filters IPs or limits (rate limit, body size, login protection) and exempts
 * nothing, it applies when either path reading matches.
 */
export function restrictsAccess(rule: Pick<PathRuleDraft, RestrictsFields>): boolean {
  if (rule.block || rule.ipRules) return true;
  const limits = !!rule.rateLimit || !!rule.loginProtection || (typeof rule.bodySizeLimit === 'number' && rule.bodySizeLimit > 0);
  const exempts = rule.inspectionOff || Object.keys(rule.semanticOverride).length > 0 ||
    tuningHasEffect(rule.tuning) ||
    rule.fieldRules.length > 0;
  return limits && !exempts;
}

/** Mirrors engine PathExceptionConfig.CaseInsensitiveMatch. */
export function effectiveCaseInsensitive(rule: Pick<PathRuleDraft, 'caseInsensitive' | RestrictsFields>): boolean {
  return rule.caseInsensitive ?? restrictsAccess(rule);
}

const PATH_RULE_KEYS = [
  'path', 'match', 'case_insensitive', 'disabled', ...INSPECTION_KEYS, 'comment',
  'semantic_override', 'rule_override', 'ip_rules', 'block', 'rate_limit', 'body_size_limit',
  'login_protection', 'field_rules', 'response_decrypt_aes', 'response_field_rules', 'tuning'
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export { HTTP_METHODS };

export function pathRuleFromRaw(raw: Json): PathRuleDraft {
  const semanticOverride: PathRuleDraft['semanticOverride'] = {};
  const rawSem = obj(raw.semantic_override);
  for (const meta of PATH_OVERRIDE_ENGINES) {
    const cat = rawSem[meta.key];
    if (!cat || typeof cat !== 'object') continue;
    const c = cat as Json;
    const entry: SemanticOverrideDraft = meta.switchOnly
      ? { disabled: entryIsOff(c, meta.key), block: null, soft: null }
      : { disabled: entryIsOff(c, meta.key), block: num(c.block_threshold, meta.defaultBlock), soft: num(c.soft_threshold, meta.defaultSoft) };
    const action = storedAction(c.action);
    if (action) entry.action = action;
    semanticOverride[meta.key] = entry;
  }
  const ip = raw.ip_rules && typeof raw.ip_rules === 'object' ? obj(raw.ip_rules) : null;
  const block = raw.block && typeof raw.block === 'object' ? obj(raw.block) : null;
  const rate = raw.rate_limit && typeof raw.rate_limit === 'object' ? obj(raw.rate_limit) : null;
  const lp = raw.login_protection && typeof raw.login_protection === 'object' ? obj(raw.login_protection) : null;
  return {
    raw,
    path: str(raw.path),
    match: oneOf<PathMatch>(raw.match, ['prefix', 'exact', 'regex'], 'prefix'),
    caseInsensitive: typeof raw.case_insensitive === 'boolean' ? raw.case_insensitive : null,
    active: raw.disabled !== true,
    inspectionOff: inspectionOffFromFlags(raw),
    comment: str(raw.comment),
    semanticOverride,
    ipRules: ip ? { mode: oneOf(ip.mode, ['allowlist', 'blocklist'] as const, 'allowlist'), ips: joinLines(ip.ips) } : null,
    block: block ? { status: num(block.status, 403) || 403, message: str(block.message) } : null,
    rateLimit: rate ? { maxRequests: num(rate.max_requests, 10) || 10, windowSec: num(rate.window_sec, 60) || 60 } : null,
    bodySizeLimit: typeof raw.body_size_limit === 'number' && raw.body_size_limit > 0 ? raw.body_size_limit : null,
    loginProtection: lp
      ? {
          enabled: lp.enabled === true,
          maxAttempts: num(lp.max_attempts, 3),
          windowSec: num(lp.window_sec, 60),
          lockoutSec: num(lp.lockout_sec, 300),
          byIp: typeof lp.by_ip === 'boolean' ? lp.by_ip : lp.by_user_agent !== true && !lp.identifier_field,
          byUserAgent: lp.by_user_agent === true,
          identifierField: str(lp.identifier_field),
          methods: stringList(lp.methods)
        }
      : null,
    fieldRules: Array.isArray(raw.field_rules)
      ? raw.field_rules.map((item) => {
          const fr = obj(item);
          // The agent lowercases the source and reads "json" as "body.json".
          const source = str(fr.source).toLowerCase();
          return {
            field: str(fr.field),
            source: oneOf<FieldSource>(source === 'json' ? 'body.json' : source, ['any', 'body.json', 'urlencoded', 'multipart', 'form', 'query', 'header'], 'any'),
            action: oneOf<FieldAction>(fr.action, ['mask', 'encrypt_aes', 'decrypt_aes'], 'mask'),
            aesKey: str(fr.aes_key),
            methods: stringList(fr.methods)
          };
        })
      : [],
    responseDecryptAes: str(raw.response_decrypt_aes),
    responseFieldRules: Array.isArray(raw.response_field_rules)
      ? raw.response_field_rules.map((item) => ({ field: str(obj(item).field), aesKey: str(obj(item).aes_key) }))
      : [],
    tuning: tuningFromRaw(raw.tuning)
  };
}

function withoutKeys(source: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) if (!keys.includes(key)) out[key] = value;
  return out;
}

export function pathRuleToJson(rule: PathRuleDraft): Json {
  const raw = rule.raw ?? {};
  const out: Json = withoutKeys(raw, PATH_RULE_KEYS);
  out.path = rule.path.trim();
  out.match = rule.match;
  // Omitted when auto so the engine default keeps following block / ip_rules.
  if (typeof rule.caseInsensitive === 'boolean') out.case_insensitive = rule.caseInsensitive;
  if (!rule.active) out.disabled = true;
  Object.assign(out, inspectionFlagsToSave(rule.inspectionOff));
  if (rule.comment.trim()) out.comment = rule.comment.trim();

  const rawSem = obj(raw.semantic_override);
  const semanticOverride: Json = withoutKeys(rawSem, PATH_OVERRIDE_ENGINES.map((engine) => engine.key));
  for (const meta of PATH_OVERRIDE_ENGINES) {
    const ov = rule.semanticOverride[meta.key];
    if (!ov) continue;
    // An entry that is off names no action: disabled wins over it.
    const action = ov.disabled ? undefined : ov.action;
    if (meta.switchOnly) {
      semanticOverride[meta.key] = withEngineAction({ ...withoutKeys(obj(rawSem[meta.key]), ['base_score']), disabled: ov.disabled }, action);
      continue;
    }
    semanticOverride[meta.key] = withEngineAction(
      serializeSemanticPolicy(withoutKeys(obj(rawSem[meta.key]), ['base_score']) as SemanticPolicy, n(ov.block, meta.defaultBlock), n(ov.soft, meta.defaultSoft), ov.disabled),
      action
    );
  }
  if (Object.keys(semanticOverride).length) out.semantic_override = semanticOverride;

  if (rule.ipRules) out.ip_rules = { ...obj(raw.ip_rules), mode: rule.ipRules.mode, ips: splitLines(rule.ipRules.ips, { commas: true }) };
  if (rule.block) {
    const block: Json = { ...obj(raw.block), status: n(rule.block.status, 403) || 403 };
    if (rule.block.message.trim()) block.message = rule.block.message.trim();
    else delete block.message;
    out.block = block;
  }
  if (rule.rateLimit) {
    out.rate_limit = { ...obj(raw.rate_limit), max_requests: n(rule.rateLimit.maxRequests, 0), window_sec: n(rule.rateLimit.windowSec, 0) };
  }
  if (rule.bodySizeLimit && rule.bodySizeLimit > 0) out.body_size_limit = rule.bodySizeLimit;
  if (rule.loginProtection) {
    const lp = rule.loginProtection;
    const json: Json = {
      ...obj(raw.login_protection),
      enabled: lp.enabled,
      max_attempts: n(lp.maxAttempts, 0),
      window_sec: n(lp.windowSec, 0),
      lockout_sec: n(lp.lockoutSec, 0),
      by_ip: lp.byIp,
      by_user_agent: lp.byUserAgent
    };
    if (lp.identifierField.trim()) json.identifier_field = lp.identifierField.trim();
    else delete json.identifier_field;
    if (lp.methods.length) json.methods = [...lp.methods];
    else delete json.methods;
    out.login_protection = json;
  }
  if (rule.fieldRules.length) {
    out.field_rules = rule.fieldRules.map((fr) => ({
      field: fr.field.trim(),
      source: fr.source,
      action: fr.action,
      ...(fr.aesKey.trim() ? { aes_key: fr.aesKey.trim() } : {}),
      ...(fr.methods.length ? { methods: [...fr.methods] } : {})
    }));
  }
  if (rule.responseDecryptAes.trim()) out.response_decrypt_aes = rule.responseDecryptAes.trim();
  if (rule.responseFieldRules.length) {
    out.response_field_rules = rule.responseFieldRules.map((r) => ({ field: r.field.trim(), action: 'decrypt_aes', aes_key: r.aesKey.trim() }));
  }
  const tuning = tuningToJson(rule.tuning);
  if (tuning) out.tuning = tuning;
  return out;
}

// ── rules_json → draft ──────────────────────────────────────────────────────

const positive = (value: unknown): number | null => (typeof value === 'number' && value > 0 ? value : null);

/**
 * A document of version 1 kept weak detections out of the log by setting the LOG score at the BLOCK score or above.
 * An absent or zero value read as its default (BLOCK 150, LOG 80, and an absent LOG capped at BLOCK). The control
 * plane rewrites it to `record_weak_detections: false` the same way.
 */
function weakDetectionsOffInV1(thresholds: Json): boolean {
  const block = positive(thresholds.block) ?? 150;
  const log = positive(thresholds.log) ?? (thresholds.log === undefined ? Math.min(80, block) : 80);
  return log >= block;
}

export function draftFromRules(rules: Json | null | undefined): PolicyDraft {
  const r = obj(rules);
  const geo = obj(r.geo);
  const siem = obj(r.siem);
  const bp = obj(r.block_policy);
  const l7 = obj(r.l7_flood);
  const ssrfSource = r.ssrf && typeof r.ssrf === 'object' ? obj(r.ssrf) : obj(r.fast_scan);
  const bot = obj(r.bot_protection);
  const cs = obj(r.content_scan);
  const ws = obj(r.websocket);
  const wsOrigin = obj(ws.origin_check);
  const wsLimits = obj(ws.limits);
  const ch = obj(r.challenge);
  const sp = obj(r.semantic_policies);

  const keyFields = (source: Json, fallback: string) =>
    Array.isArray(source.key_fields) ? stringList(source.key_fields).join(', ') : str(source.key_field, fallback);

  // A category with a base score of 0 (version 1) switched off the engines that take their score from it.
  const offByCategory = new Set<SemanticKey>();
  for (const [name, value] of Object.entries(obj(r.categories))) {
    if (obj(value).base_score === 0) CATEGORY_ENGINES[name]?.forEach((key) => offByCategory.add(key));
  }

  const semantic = {} as Record<SemanticKey, SemanticDraft>;
  for (const meta of SEMANTIC_ENGINES) {
    const p = obj(sp[meta.key]);
    const action = storedAction(p.action);
    const enabled = !entryIsOff(p, meta.key) && !(offByCategory.has(meta.key) && p.base_score == null);
    semantic[meta.key] = meta.switchOnly
      ? { enabled, block: null, soft: null }
      : { enabled, block: num(p.block_threshold, meta.defaultBlock), soft: num(p.soft_threshold, meta.defaultSoft) };
    if (action) semantic[meta.key].action = action;
  }

  const botActive = bot.enabled === true && bot.mode !== 'off';
  const format = (value: unknown) => oneOf<ResponseFormat>(value, ['html', 'json', 'xml'], 'html');

  return {
    engines: {
      inspectionOff: inspectionOffFromFlags(sp),
      scanAllHeaders: sp.scan_all_headers !== false,
      recordWeakDetections: typeof sp.record_weak_detections === 'boolean' ? sp.record_weak_detections : !weakDetectionsOffInV1(obj(r.thresholds))
    },
    semantic,
    geo: {
      allowIps: joinLines(geo.allow_ips),
      blockIps: joinLines(geo.block_ips),
      allowCountries: joinLines(geo.allow_countries),
      blockCountries: joinLines(geo.block_countries)
    },
    blockPolicy: {
      enabled: bp.enabled !== false,
      afterN: num(bp.block_after_n_blocks, 20),
      durationSec: num(bp.block_duration_sec, 60),
      keyFields: keyFields(bp, 'remote_addr, user_agent')
    },
    flood: {
      enabled: l7.enabled === true,
      maxRequests: num(l7.max_requests, 100),
      windowSec: num(l7.window_sec, 60),
      keyFields: keyFields(l7, 'remote_addr'),
      allowIps: joinLines(l7.allow_ips)
    },
    bodyLimit: parseEngineByteSize(r.request_body_limit),
    bot: {
      mode: botActive ? oneOf<BotMode>(bot.mode || 'log', ['log', 'score', 'block'], 'log') : 'off',
      baseScore: num(bot.base_score, 100),
      scoreThreshold: num(bot.score_threshold, bot.mode === 'score' ? positive(obj(r.thresholds).block) ?? DEFAULT_BOT_SCORE_THRESHOLD : DEFAULT_BOT_SCORE_THRESHOLD),
      emptyUA: bot.empty_ua_block === true,
      headerChecks: bot.header_checks !== false,
      clientHints: bot.client_hints_check !== false,
      browserImpersonation: bot.browser_impersonation_check !== false,
      blockAICrawlers: bot.block_ai_crawlers === true,
      uaBlocklist: joinLines(bot.ua_blocklist),
      uaAllowlist: joinLines(bot.ua_allowlist),
      ja4Blocklist: joinLines(bot.ja4_blocklist),
      ja4Allowlist: joinLines(bot.ja4_allowlist),
      ja3Blocklist: joinLines(bot.ja3_blocklist),
      ja3Allowlist: joinLines(bot.ja3_allowlist)
    },
    challenge: {
      enabled: ch.enabled === true,
      type: oneOf<ChallengeType>(ch.type, ['js_challenge', 'adaptive', 'click_puzzle', 'turnstile', 'hcaptcha'], 'js_challenge'),
      siteKey: str(ch.site_key),
      secretKey: str(ch.secret_key),
      cookieTTL: num(ch.cookie_ttl_sec, 3600),
      trigger: oneOf(ch.trigger, ['always', 'on_bot_detect'] as const, 'always'),
      simulation: ch.simulation === true,
      ipRepEnabled: ch.ip_rep_enabled === true,
      ipRepLevel1Block: ch.ip_rep_block_level1 !== false,
      ipRepLevel2Block: ch.ip_rep_block_level2 === true,
      allowLocalIPs: ch.allow_local_ips !== false,
      powDifficulty: [8, 12, 14, 16].includes(Number(ch.pow_difficulty)) ? Number(ch.pow_difficulty) : 12,
      goodBotAllowlist: joinLines(ch.good_bot_allowlist)
    },
    responses: {
      jsChallengeHtml: str(ch.custom_js_challenge_html),
      clickPuzzleHtml: str(ch.custom_click_puzzle_html),
      ipRepHtml: str(ch.custom_ip_rep_block_html),
      ipRepJson: str(ch.custom_ip_rep_block_json),
      ipRepXml: str(ch.custom_ip_rep_block_xml),
      wafBlockHtml: str(ch.custom_block_html),
      wafBlockJson: str(ch.custom_waf_block_json),
      wafBlockXml: str(ch.custom_waf_block_xml),
      policyBlockHtml: str(ch.custom_policy_block_html),
      policyBlockJson: str(ch.custom_policy_block_json),
      policyBlockXml: str(ch.custom_policy_block_xml),
      geoBlockHtml: str(ch.custom_geo_block_html),
      geoBlockJson: str(ch.custom_geo_block_json),
      geoBlockXml: str(ch.custom_geo_block_xml),
      formats: {
        waf: format(ch.waf_block_format),
        policy: format(ch.policy_block_format),
        geo: format(ch.geo_block_format),
        ipRep: format(ch.ip_rep_block_format)
      }
    },
    contentScan: {
      enabled: cs.enabled === true,
      mode: oneOf(cs.mode, ['block', 'log', 'disabled'] as const, 'block'),
      onIncomplete: oneOf(cs.on_incomplete, ['log', 'block', 'allow'] as const, 'log'),
      maxBytes: num(cs.max_scan_size_bytes, 10485760),
      multipart: cs.scan_multipart !== false,
      rawBody: cs.scan_raw_body === true,
      blocklist: joinLines(cs.custom_blocklist_hashes),
      allowlist: joinLines(cs.custom_allowlist_hashes)
    },
    websocket: {
      enabled: ws.enabled !== false,
      originCheck: wsOrigin.enabled === true,
      origins: joinLines(wsOrigin.allowed_origins),
      maxTextBytes: num(wsLimits.max_text_bytes, 0),
      maxBinaryBytes: num(wsLimits.max_binary_bytes, 0),
      maxMessagesPerMin: num(wsLimits.max_messages_per_min, 0),
      scanServerFrames: ws.scan_server_frames === true,
      scanBinaryHashes: ws.scan_binary_hashes === true
    },
    siem: { enabled: siem.enabled === true, webhookUrl: str(siem.webhook_url) },
    ssrf: { list: joinLines(ssrfSource.ssrf_blocklist), path: str(ssrfSource.ssrf_blocklist_path) },
    pathRules: Array.isArray(r.path_exceptions) ? r.path_exceptions.map((item) => pathRuleFromRaw(obj(item))) : []
  };
}

// ── draft → rules_json ──────────────────────────────────────────────────────

/**
 * The policy with its `action` set, or without the key when there is none. A policy that is merged over a stored one
 * (`replaces`) gets `undefined` where the stored one had an action, so that mergeWafRules clears it; JSON serialization
 * then omits it.
 */
function withEngineAction<T extends Record<string, unknown>>(policy: T, action: StoredEngineAction | undefined, replaces = false): T & { action?: StoredEngineAction } {
  const out: T & { action?: StoredEngineAction } = { ...policy };
  if (action) out.action = action;
  else if (replaces) out.action = undefined;
  else delete out.action;
  return out;
}

/**
 * Writes `draft` on top of `original`. Keys the form does not manage are
 * kept; clearing an optional value writes `undefined` so the merge removes
 * it (JSON serialization then omits it).
 */
export function rulesFromDraft(draft: PolicyDraft, original: Json | null | undefined, options: PolicyOptions = {}): Json {
  const orig = obj(original);
  const origSp = obj(orig.semantic_policies);
  const origBot = obj(orig.bot_protection);

  const semanticPolicies: Json = {
    // Off saves `inspection_off`; on saves nothing. Either way the two keys of a v1 document go.
    ...Object.fromEntries(INSPECTION_KEYS.map((key) => [key, undefined])),
    ...inspectionFlagsToSave(draft.engines.inspectionOff)
  };
  // Absent = true (engine default); only written once it was set or turned off.
  if (!draft.engines.scanAllHeaders || typeof origSp.scan_all_headers === 'boolean') {
    semanticPolicies.scan_all_headers = draft.engines.scanAllHeaders;
  }
  // Absent = true: written only while weak detections are not recorded, so the key of a document that had it is removed
  // when the switch is back on.
  semanticPolicies.record_weak_detections = draft.engines.recordWeakDetections ? undefined : false;
  // No editor control yet: keep a stored on_uninspected ("log" | "block").
  if (typeof origSp.on_uninspected === 'string') {
    semanticPolicies.on_uninspected = origSp.on_uninspected;
  }
  for (const meta of SEMANTIC_ENGINES) {
    const d = draft.semantic[meta.key];
    const saved = withoutKeys(obj(origSp[meta.key]), ['base_score']) as SemanticPolicy;
    // An engine that is off keeps the action the document had (disabled wins over it); the editor never newly writes one.
    const action = d.enabled ? d.action : storedAction(saved.action);
    if (meta.switchOnly) {
      // Only `disabled` is written, and only while the engine is off or the entry holds more than the flag:
      // an agent older than the key refuses a document that names it.
      const { disabled: _flag, action: _action, ...rest } = saved;
      const entry = withEngineAction(rest, action, saved.action !== undefined);
      const holds = Object.values(entry).some((value) => value !== undefined);
      if (!d.enabled) semanticPolicies[meta.key] = { ...entry, disabled: true };
      else semanticPolicies[meta.key] = holds ? { ...entry, disabled: false } : undefined;
      continue;
    }
    const policy = serializeSemanticPolicy(saved, n(d.block, meta.defaultBlock), n(d.soft, meta.defaultSoft), !d.enabled);
    semanticPolicies[meta.key] = withEngineAction(policy, action, saved.action !== undefined);
  }

  // Bot protection: one mode control. "Off" keeps the last active mode in
  // `mode` (the engine only runs when enabled && mode != off).
  const botMode = draft.bot.mode;
  const savedMode = typeof origBot.mode === 'string' && origBot.mode ? origBot.mode : 'off';
  const bot: Json = {
    enabled: botMode !== 'off',
    mode: botMode !== 'off' ? botMode : savedMode,
    base_score: n(draft.bot.baseScore, 100),
    score_threshold: n(draft.bot.scoreThreshold, DEFAULT_BOT_SCORE_THRESHOLD),
    empty_ua_block: draft.bot.emptyUA,
    ua_blocklist: listOrUndefined(splitLines(draft.bot.uaBlocklist)),
    ua_allowlist: listOrUndefined(splitLines(draft.bot.uaAllowlist)),
    ja4_blocklist: listOrUndefined(splitLines(draft.bot.ja4Blocklist, { lower: true })),
    ja4_allowlist: listOrUndefined(splitLines(draft.bot.ja4Allowlist, { lower: true })),
    ja3_blocklist: listOrUndefined(splitLines(draft.bot.ja3Blocklist, { lower: true })),
    ja3_allowlist: listOrUndefined(splitLines(draft.bot.ja3Allowlist, { lower: true })),
    header_checks: draft.bot.headerChecks,
    client_hints_check: draft.bot.clientHints,
    browser_impersonation_check: draft.bot.browserImpersonation,
    block_ai_crawlers: draft.bot.blockAICrawlers
  };

  const c = draft.challenge;
  const res = draft.responses;
  const origChallenge = obj(orig.challenge);
  // Empty text is omitted, unless the saved config spelled it out as "" (same meaning either way).
  const textFor = (key: string, value: string) => value.trim() || (origChallenge[key] === '' ? '' : undefined);
  const challenge: Json = {
    enabled: c.enabled,
    type: c.type,
    site_key: textFor('site_key', c.siteKey),
    secret_key: textFor('secret_key', c.secretKey),
    cookie_ttl_sec: n(c.cookieTTL, 3600) || 3600,
    trigger: c.trigger,
    simulation: c.simulation,
    ip_rep_enabled: c.ipRepEnabled,
    ip_rep_block_level1: c.ipRepLevel1Block,
    ip_rep_block_level2: c.ipRepLevel2Block,
    allow_local_ips: c.allowLocalIPs,
    pow_difficulty: c.type === 'js_challenge' || c.type === 'adaptive' ? c.powDifficulty : undefined,
    good_bot_allowlist: listOrUndefined(splitLines(c.goodBotAllowlist)),
    custom_js_challenge_html: textFor('custom_js_challenge_html', res.jsChallengeHtml),
    custom_click_puzzle_html: textFor('custom_click_puzzle_html', res.clickPuzzleHtml),
    custom_ip_rep_block_html: textFor('custom_ip_rep_block_html', res.ipRepHtml),
    custom_block_html: textFor('custom_block_html', res.wafBlockHtml),
    custom_policy_block_html: textFor('custom_policy_block_html', res.policyBlockHtml),
    custom_geo_block_html: textFor('custom_geo_block_html', res.geoBlockHtml),
    waf_block_format: res.formats.waf !== 'html' ? res.formats.waf : undefined,
    policy_block_format: res.formats.policy !== 'html' ? res.formats.policy : undefined,
    geo_block_format: res.formats.geo !== 'html' ? res.formats.geo : undefined,
    ip_rep_block_format: res.formats.ipRep !== 'html' ? res.formats.ipRep : undefined,
    custom_waf_block_json: textFor('custom_waf_block_json', res.wafBlockJson),
    custom_policy_block_json: textFor('custom_policy_block_json', res.policyBlockJson),
    custom_geo_block_json: textFor('custom_geo_block_json', res.geoBlockJson),
    custom_ip_rep_block_json: textFor('custom_ip_rep_block_json', res.ipRepJson),
    custom_waf_block_xml: textFor('custom_waf_block_xml', res.wafBlockXml),
    custom_policy_block_xml: textFor('custom_policy_block_xml', res.policyBlockXml),
    custom_geo_block_xml: textFor('custom_geo_block_xml', res.geoBlockXml),
    custom_ip_rep_block_xml: textFor('custom_ip_rep_block_xml', res.ipRepXml)
  };

  // request_body_limit: keep the saved spelling ("5M") when the size did not change.
  const savedBodyLimit = orig.request_body_limit;
  const bodyLimit = draft.bodyLimit && draft.bodyLimit > 0
    ? (parseEngineByteSize(savedBodyLimit) === draft.bodyLimit ? savedBodyLimit : formatEngineByteSize(draft.bodyLimit))
    : undefined;

  // SSRF blocklist: lines and file path round-trip to their own keys,
  // in the block the engine reads ("ssrf", or legacy "fast_scan" when that is
  // the only one present). The path is never turned into a blocklist entry.
  const ssrfKey = orig.ssrf && typeof orig.ssrf === 'object' ? 'ssrf' : orig.fast_scan && typeof orig.fast_scan === 'object' ? 'fast_scan' : 'ssrf';
  const ssrfList = splitLines(draft.ssrf.list, { comments: true });
  const ssrfPath = draft.ssrf.path.trim();
  const ssrfEdits: Json = { ssrf_blocklist: listOrUndefined(ssrfList), ssrf_blocklist_path: ssrfPath || undefined };
  const writeSsrf = ssrfKey in orig || ssrfList.length > 0 || ssrfPath !== '';

  const edits: Json = {
    geo: {
      allow_ips: splitLines(draft.geo.allowIps, { commas: true }),
      block_ips: splitLines(draft.geo.blockIps, { commas: true }),
      allow_countries: splitLines(draft.geo.allowCountries, { commas: true }).map((code) => code.toUpperCase()),
      block_countries: splitLines(draft.geo.blockCountries, { commas: true }).map((code) => code.toUpperCase())
    },
    siem: { enabled: draft.siem.enabled, webhook_url: draft.siem.webhookUrl.trim() },
    block_policy: {
      enabled: draft.blockPolicy.enabled,
      block_after_n_blocks: n(draft.blockPolicy.afterN, 20),
      block_duration_sec: n(draft.blockPolicy.durationSec, 60),
      key_fields: splitLines(draft.blockPolicy.keyFields, { commas: true })
    },
    request_body_limit: bodyLimit,
    content_scan: {
      enabled: draft.contentScan.enabled,
      mode: draft.contentScan.mode,
      on_incomplete: draft.contentScan.onIncomplete,
      max_scan_size_bytes: n(draft.contentScan.maxBytes, 10485760),
      scan_multipart: draft.contentScan.multipart,
      scan_raw_body: draft.contentScan.rawBody,
      custom_blocklist_hashes: listOrUndefined(splitLines(draft.contentScan.blocklist, { comments: true, lower: true })),
      custom_allowlist_hashes: listOrUndefined(splitLines(draft.contentScan.allowlist, { comments: true, lower: true }))
    },
    l7_flood: {
      enabled: draft.flood.enabled,
      max_requests: n(draft.flood.maxRequests, 100),
      window_sec: n(draft.flood.windowSec, 60),
      key_fields: splitLines(draft.flood.keyFields, { commas: true }),
      allow_ips: splitLines(draft.flood.allowIps, { commas: true })
    },
    ...(writeSsrf ? { [ssrfKey]: ssrfEdits } : {}),
    bot_protection: bot,
    challenge,
    semantic_policies: semanticPolicies,
    path_exceptions: draft.pathRules.length ? draft.pathRules.map(pathRuleToJson) : undefined
  };
  if (options.includeWebSocket) {
    const w = draft.websocket;
    edits.websocket = {
      enabled: w.enabled,
      origin_check: { enabled: w.originCheck, allowed_origins: splitLines(w.origins) },
      limits: {
        max_text_bytes: n(w.maxTextBytes, 0),
        max_binary_bytes: n(w.maxBinaryBytes, 0),
        max_messages_per_min: n(w.maxMessagesPerMin, 0)
      },
      scan_server_frames: w.scanServerFrames,
      scan_binary_hashes: w.scanBinaryHashes
    };
  }
  return withoutLegacyKeys(withoutAbsentDefaults(mergeWafRules(orig, edits), orig));
}

/**
 * Keys that mean the same absent as at this value. The form writes every field it shows, so these are left out
 * again when the stored document lacks them and the value is still the default.
 */
const ABSENT_IS_DEFAULT: readonly (readonly [string, unknown])[] = [
  ['bot_protection.score_threshold', DEFAULT_BOT_SCORE_THRESHOLD],
  ['bot_protection.empty_ua_block', false],
  ['bot_protection.header_checks', true],
  ['bot_protection.client_hints_check', true],
  ['bot_protection.browser_impersonation_check', true],
  ['bot_protection.block_ai_crawlers', false],
  ['challenge.allow_local_ips', true],
  ['challenge.pow_difficulty', 12],
  ...SEMANTIC_ENGINES.map((meta): readonly [string, unknown] => [`semantic_policies.${meta.key}.disabled`, false]),
  ['content_scan.enabled', false],
  ['content_scan.mode', 'block'],
  ['content_scan.on_incomplete', 'log'],
  ['content_scan.max_scan_size_bytes', 10485760],
  ['content_scan.scan_multipart', true],
  ['content_scan.scan_raw_body', false],
  ['websocket.enabled', true],
  ['websocket.origin_check.enabled', false],
  ['websocket.origin_check.allowed_origins', []],
  ['websocket.limits.max_text_bytes', 0],
  ['websocket.limits.max_binary_bytes', 0],
  ['websocket.limits.max_messages_per_min', 0],
  ['websocket.scan_server_frames', false],
  ['websocket.scan_binary_hashes', false]
];

/** Removes the ABSENT_IS_DEFAULT keys the stored document lacks, and the objects that leaves empty. */
function withoutAbsentDefaults(saved: Json, stored: Json): Json {
  const out = structuredClone(saved);
  for (const [path, value] of ABSENT_IS_DEFAULT) {
    const keys = path.split('.');
    const chain: Json[] = [out];
    for (const key of keys.slice(0, -1)) {
      const next = chain[chain.length - 1][key];
      if (!next || typeof next !== 'object' || Array.isArray(next)) break;
      chain.push(next as Json);
    }
    if (chain.length !== keys.length) continue;
    const leaf = keys[keys.length - 1];
    if (JSON.stringify(chain[chain.length - 1][leaf]) !== JSON.stringify(value)) continue;
    if (getPath(stored, keys) !== undefined) continue;
    delete chain[chain.length - 1][leaf];
    // Walk up: an object that is now empty and was not stored goes too.
    for (let depth = keys.length - 1; depth > 0; depth--) {
      if (Object.values(chain[depth]).some((value) => value !== undefined) || getPath(stored, keys.slice(0, depth)) !== undefined) break;
      delete chain[depth - 1][keys[depth - 1]];
    }
  }
  return out;
}

function getPath(source: Json, keys: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Json)[key];
  }
  return current;
}

/**
 * Drops what a v1 document carries and the form no longer manages: the thresholds, the categories, the base score
 * of every engine, and `skip_coraza_when_clean`, a switch of the removed rule engine. They go without an error;
 * the rest of the document is left as it is. What a score of 0 or a LOG score at the BLOCK score meant is already in
 * the draft (draftFromRules), so it is written back as `disabled` and `record_weak_detections`.
 */
function withoutLegacyKeys(rules: Json): Json {
  const out: Json = withoutKeys(rules, ['thresholds', 'categories']);
  const sp = obj(out.semantic_policies);
  if (Object.keys(sp).length) {
    const kept: Json = withoutKeys(sp, ['skip_coraza_when_clean']);
    for (const meta of SEMANTIC_ENGINES) {
      const entry = obj(sp[meta.key]);
      if (!('base_score' in entry)) continue;
      const rest = withoutKeys(entry, ['base_score']);
      if (Object.keys(rest).length) kept[meta.key] = rest;
      else delete kept[meta.key];
    }
    out.semantic_policies = kept;
  }
  return out;
}

/** JSON round trip: drops `undefined` members the merge leaves behind. */
export function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Detection settings the editor shows ─────────────────────────────────────

/** Engines with evidence thresholds; the others take only a switch. */
export const SENSITIVITY_ENGINES: readonly SemanticEngineMeta[] = SEMANTIC_ENGINES.filter((meta) => !meta.switchOnly);

/**
 * The three sensitivity levels of an engine. Balanced is the default pair of evidence values (defaultBlock and
 * defaultSoft). Strict asks for about a fifth less evidence and Relaxed for about a quarter more. The pairs below are the
 * ones the levels were measured with; the stored policy holds the numbers only.
 */
export const SENSITIVITY_LEVELS = [
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'strict', label: 'Strict' }
] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number]['value'];

/**
 * [block, soft] per engine key. Local file inclusion keeps its Balanced block value at Strict and only logs more: any
 * lower block value blocked about ninety more normal requests of the blazehttp sample set.
 */
const STRICT_VALUES: Record<string, readonly [number, number]> = {
  sql: [3.2, 2.0], xss: [3.0, 1.8], cmd: [2.6, 1.3], php: [2.6, 1.3], python: [2.6, 1.3], lfi: [3.2, 1.2],
  ssrf: [2.0, 1.2], java: [2.6, 1.3], nosql: [2.4, 1.2], ssti: [2.4, 1.4], xxe: [2.0, 1.2], deser: [2.0, 1.2]
};
const RELAXED_VALUES: Record<string, readonly [number, number]> = {
  sql: [5.0, 3.1], xss: [4.8, 2.8], cmd: [4.0, 2.0], php: [4.0, 2.0], python: [4.0, 2.0], lfi: [4.0, 1.9],
  ssrf: [3.1, 1.9], java: [4.0, 2.0], nosql: [3.8, 1.9], ssti: [3.8, 2.2], xxe: [3.1, 1.9], deser: [3.1, 1.9]
};

/** The evidence values an engine has at a level. */
export function sensitivityValues(meta: SemanticEngineMeta, level: SensitivityLevel): { block: number; soft: number } {
  if (level === 'balanced') return { block: meta.defaultBlock, soft: meta.defaultSoft };
  const [block, soft] = (level === 'strict' ? STRICT_VALUES : RELAXED_VALUES)[meta.key];
  return { block, soft };
}

/** The level a pair of evidence values is, or 'custom' when it is none of the three (an empty field is the default). */
export function sensitivityLevelOf(meta: SemanticEngineMeta, block: number | null | undefined, soft: number | null | undefined): SensitivityLevel | 'custom' {
  const b = block ?? meta.defaultBlock;
  const so = soft ?? meta.defaultSoft;
  if (meta.switchOnly) return 'balanced';
  for (const level of SENSITIVITY_LEVELS) {
    const v = sensitivityValues(meta, level.value);
    if (v.block === b && v.soft === so) return level.value;
  }
  return 'custom';
}

/** Number of engines whose block or soft threshold differs from its default (an empty field is the default). */
export function customSensitivityCount(draft: Pick<PolicyDraft, 'semantic'>): number {
  return SENSITIVITY_ENGINES.filter((meta) => {
    const s = draft.semantic[meta.key];
    return (s.block ?? meta.defaultBlock) !== meta.defaultBlock || (s.soft ?? meta.defaultSoft) !== meta.defaultSoft;
  }).length;
}

/** Puts the thresholds of every threshold engine back to their defaults. */
export function resetSensitivity(draft: Pick<PolicyDraft, 'semantic'>): void {
  for (const meta of SENSITIVITY_ENGINES) {
    draft.semantic[meta.key].block = meta.defaultBlock;
    draft.semantic[meta.key].soft = meta.defaultSoft;
  }
}
