/**
 * Review of unsaved policy changes: a labelled, per-setting diff of two
 * drafts. Lists show added and removed entries, secrets never appear (only
 * "changed"), templates show their size. Used by the sticky save bar (count)
 * and the review drawer.
 */
import {
  SEMANTIC_ENGINES,
  engineActionLabel,
  splitLines,
  tuningSkipsAll,
  pathEnginesOff,
  pathEnginesLogOnly,
  enginesOff,
  enginesLogOnly,
  pathRuleToJson,
  type PathRuleDraft,
  type PolicyDraft
} from './model';
import type { SectionId } from './validate';
import { formatBytes } from '../../format';

export type ChangeKind = 'value' | 'list' | 'secret' | 'text';

export interface PolicyChange {
  section: SectionId;
  /** Stable key (draft path). */
  path: string;
  label: string;
  kind: ChangeKind;
  /** Display values for 'value' changes. */
  before?: string;
  after?: string;
  /** Entries for 'list' changes. */
  added?: string[];
  removed?: string[];
  /** Free text for 'secret' / 'text' changes. */
  note?: string;
}

type Getter = (d: PolicyDraft) => unknown;

interface FieldDef {
  path: string;
  label: string;
  section: SectionId;
  get: Getter;
  kind?: ChangeKind;
  /** Display for value changes. */
  show?: (value: unknown) => string;
  /** List parsing for 'list' changes. */
  list?: { commas?: boolean; comments?: boolean; lower?: boolean };
}

const onOff = (value: unknown) => (value ? 'On' : 'Off');
const plain = (value: unknown) => (value === null || value === undefined || value === '' ? 'empty' : String(value));
const bytes = (value: unknown) => (typeof value === 'number' && value > 0 ? formatBytes(value) : 'no limit');
const agentDefault = (value: unknown) => (typeof value === 'number' && value > 0 ? formatBytes(value) : 'agent default');
const seconds = (value: unknown) => (typeof value === 'number' ? `${value.toLocaleString('en-US')} s` : 'empty');

const BOT_MODES: Record<string, string> = { off: 'Off', log: 'Log only', score: 'Score', block: 'Block' };
const CHALLENGE_TYPES: Record<string, string> = {
  js_challenge: 'JS challenge', adaptive: 'Adaptive', click_puzzle: 'Click puzzle', turnstile: 'Cloudflare Turnstile', hcaptcha: 'hCaptcha'
};

const FIELDS: FieldDef[] = [
  { path: 'engines.recordWeakDetections', label: 'Record weak detections', section: 'protection', get: (d) => d.engines.recordWeakDetections, show: onOff },
  { path: 'engines.inspectionOff', label: 'Inspection off', section: 'protection', get: (d) => d.engines.inspectionOff, show: onOff },
  { path: 'engines.scanAllHeaders', label: 'Scan all request headers', section: 'protection', get: (d) => d.engines.scanAllHeaders, show: onOff },

  { path: 'geo.allowIps', label: 'Allowed IPs', section: 'access', get: (d) => d.geo.allowIps, kind: 'list', list: { commas: true } },
  { path: 'geo.blockIps', label: 'Blocked IPs', section: 'access', get: (d) => d.geo.blockIps, kind: 'list', list: { commas: true } },
  { path: 'geo.allowCountries', label: 'Allowed countries', section: 'access', get: (d) => d.geo.allowCountries, kind: 'list', list: { commas: true } },
  { path: 'geo.blockCountries', label: 'Blocked countries', section: 'access', get: (d) => d.geo.blockCountries, kind: 'list', list: { commas: true } },

  { path: 'ssrf.list', label: 'SSRF destination blocklist', section: 'ssrf', get: (d) => d.ssrf.list, kind: 'list', list: { comments: true } },
  { path: 'ssrf.path', label: 'SSRF blocklist file on the agent', section: 'ssrf', get: (d) => d.ssrf.path, show: plain },

  { path: 'blockPolicy.enabled', label: 'Repeat-offender blocking', section: 'rate-limits', get: (d) => d.blockPolicy.enabled, show: onOff },
  { path: 'blockPolicy.afterN', label: 'Block after (blocked requests)', section: 'rate-limits', get: (d) => d.blockPolicy.afterN, show: plain },
  { path: 'blockPolicy.durationSec', label: 'Block duration', section: 'rate-limits', get: (d) => d.blockPolicy.durationSec, show: seconds },
  { path: 'blockPolicy.keyFields', label: 'Repeat-offender client key', section: 'rate-limits', get: (d) => d.blockPolicy.keyFields, kind: 'list', list: { commas: true } },
  { path: 'blockPolicy.target', label: 'Where the block applies', section: 'rate-limits', get: (d) => d.blockPolicy.target, show: (v) => (v === 'kernel' ? 'WAFio and the server firewall' : v === 'waf' ? 'WAFio only' : plain(v)) },
  { path: 'flood.enabled', label: 'HTTP flood limit', section: 'rate-limits', get: (d) => d.flood.enabled, show: onOff },
  { path: 'flood.maxRequests', label: 'Flood: maximum requests', section: 'rate-limits', get: (d) => d.flood.maxRequests, show: plain },
  { path: 'flood.windowSec', label: 'Flood: period', section: 'rate-limits', get: (d) => d.flood.windowSec, show: seconds },
  { path: 'flood.keyFields', label: 'Flood client key', section: 'rate-limits', get: (d) => d.flood.keyFields, kind: 'list', list: { commas: true } },
  { path: 'flood.allowIps', label: 'Flood exempt clients', section: 'rate-limits', get: (d) => d.flood.allowIps, kind: 'list', list: { commas: true } },

  { path: 'bot.mode', label: 'Bot protection', section: 'bots', get: (d) => d.bot.mode, show: (v) => BOT_MODES[String(v)] ?? plain(v) },
  { path: 'bot.baseScore', label: 'Bot score', section: 'bots', get: (d) => d.bot.baseScore, show: plain },
  { path: 'bot.scoreThreshold', label: 'Bot score threshold', section: 'bots', get: (d) => d.bot.scoreThreshold, show: plain },
  { path: 'bot.emptyUA', label: 'Treat an empty User-Agent as a bot', section: 'bots', get: (d) => d.bot.emptyUA, show: onOff },
  { path: 'bot.headerChecks', label: 'Header checks', section: 'bots', get: (d) => d.bot.headerChecks, show: onOff },
  { path: 'bot.clientHints', label: 'Client Hints consistency', section: 'bots', get: (d) => d.bot.clientHints, show: onOff },
  { path: 'bot.browserImpersonation', label: 'Browser impersonation check', section: 'bots', get: (d) => d.bot.browserImpersonation, show: onOff },
  { path: 'bot.blockAICrawlers', label: 'Block AI crawlers', section: 'bots', get: (d) => d.bot.blockAICrawlers, show: onOff },
  { path: 'bot.uaBlocklist', label: 'User-Agent blocklist', section: 'bots', get: (d) => d.bot.uaBlocklist, kind: 'list' },
  { path: 'bot.uaAllowlist', label: 'User-Agent allowlist', section: 'bots', get: (d) => d.bot.uaAllowlist, kind: 'list' },
  { path: 'bot.ja4Blocklist', label: 'JA4 blocklist', section: 'bots', get: (d) => d.bot.ja4Blocklist, kind: 'list', list: { lower: true } },
  { path: 'bot.ja4Allowlist', label: 'JA4 allowlist', section: 'bots', get: (d) => d.bot.ja4Allowlist, kind: 'list', list: { lower: true } },
  { path: 'bot.ja3Blocklist', label: 'JA3 blocklist', section: 'bots', get: (d) => d.bot.ja3Blocklist, kind: 'list', list: { lower: true } },
  { path: 'bot.ja3Allowlist', label: 'JA3 allowlist', section: 'bots', get: (d) => d.bot.ja3Allowlist, kind: 'list', list: { lower: true } },

  { path: 'challenge.enabled', label: 'Bot challenge', section: 'challenge', get: (d) => d.challenge.enabled, show: onOff },
  { path: 'challenge.type', label: 'Challenge type', section: 'challenge', get: (d) => d.challenge.type, show: (v) => CHALLENGE_TYPES[String(v)] ?? plain(v) },
  { path: 'challenge.siteKey', label: 'Challenge site key', section: 'challenge', get: (d) => d.challenge.siteKey, show: plain },
  { path: 'challenge.secretKey', label: 'Challenge secret', section: 'challenge', get: (d) => d.challenge.secretKey, kind: 'secret' },
  { path: 'challenge.cookieTTL', label: 'Challenge cookie lifetime', section: 'challenge', get: (d) => d.challenge.cookieTTL, show: seconds },
  { path: 'challenge.trigger', label: 'Challenge trigger', section: 'challenge', get: (d) => d.challenge.trigger, show: (v) => (v === 'always' ? 'Every new visitor' : 'Only on bot detection') },
  { path: 'challenge.simulation', label: 'Challenge simulation mode', section: 'challenge', get: (d) => d.challenge.simulation, show: onOff },
  { path: 'challenge.powDifficulty', label: 'Proof-of-work difficulty', section: 'challenge', get: (d) => d.challenge.powDifficulty, show: (v) => `${v} bits` },
  { path: 'challenge.ipRepEnabled', label: 'IP reputation', section: 'ip-reputation', get: (d) => d.challenge.ipRepEnabled, show: onOff },
  { path: 'challenge.ipRepLevel1Block', label: 'IP reputation level 1', section: 'ip-reputation', get: (d) => d.challenge.ipRepLevel1Block, show: (v) => (v ? 'Block' : 'Challenge') },
  { path: 'challenge.ipRepLevel2Block', label: 'IP reputation level 2', section: 'ip-reputation', get: (d) => d.challenge.ipRepLevel2Block, show: (v) => (v ? 'Block' : 'Challenge') },
  { path: 'challenge.allowLocalIPs', label: 'Skip local and private IPs', section: 'challenge', get: (d) => d.challenge.allowLocalIPs, show: onOff },
  { path: 'challenge.goodBotAllowlist', label: 'Good bot allowlist', section: 'challenge', get: (d) => d.challenge.goodBotAllowlist, kind: 'list' },

  { path: 'bodyLimit', label: 'Request body limit', section: 'uploads', get: (d) => d.bodyLimit, show: bytes },
  { path: 'contentScan.enabled', label: 'Malicious upload scanning', section: 'uploads', get: (d) => d.contentScan.enabled, show: onOff },
  { path: 'contentScan.mode', label: 'When malware is detected', section: 'uploads', get: (d) => d.contentScan.mode, show: (v) => ({ block: 'Block upload', log: 'Log only', disabled: 'Scan disabled' })[String(v)] ?? plain(v) },
  { path: 'contentScan.onIncomplete', label: 'When scanning is incomplete', section: 'uploads', get: (d) => d.contentScan.onIncomplete, show: (v) => ({ log: 'Forward and log', block: 'Reject upload', allow: 'Forward with scan details' })[String(v)] ?? plain(v) },
  { path: 'contentScan.maxBytes', label: 'Scan budget per request', section: 'uploads', get: (d) => d.contentScan.maxBytes, show: bytes },
  { path: 'contentScan.multipart', label: 'Scan multipart uploads', section: 'uploads', get: (d) => d.contentScan.multipart, show: onOff },
  { path: 'contentScan.rawBody', label: 'Scan raw request bodies', section: 'uploads', get: (d) => d.contentScan.rawBody, show: onOff },
  { path: 'contentScan.blocklist', label: 'Blocked file hashes', section: 'uploads', get: (d) => d.contentScan.blocklist, kind: 'list', list: { comments: true, lower: true } },
  { path: 'contentScan.allowlist', label: 'Allowed file hashes', section: 'uploads', get: (d) => d.contentScan.allowlist, kind: 'list', list: { comments: true, lower: true } },

  { path: 'websocket.enabled', label: 'WebSocket inspection', section: 'websocket', get: (d) => d.websocket.enabled, show: onOff },
  { path: 'websocket.originCheck', label: 'Require allowed Origin', section: 'websocket', get: (d) => d.websocket.originCheck, show: onOff },
  { path: 'websocket.origins', label: 'Allowed WebSocket origins', section: 'websocket', get: (d) => d.websocket.origins, kind: 'list' },
  { path: 'websocket.maxTextBytes', label: 'Maximum text message', section: 'websocket', get: (d) => d.websocket.maxTextBytes, show: agentDefault },
  { path: 'websocket.maxBinaryBytes', label: 'Maximum binary message', section: 'websocket', get: (d) => d.websocket.maxBinaryBytes, show: agentDefault },
  { path: 'websocket.maxMessagesPerMin', label: 'Messages per minute', section: 'websocket', get: (d) => d.websocket.maxMessagesPerMin, show: (v) => (v ? String(v) : 'agent default') },
  { path: 'websocket.scanServerFrames', label: 'Scan server frames', section: 'websocket', get: (d) => d.websocket.scanServerFrames, show: onOff },
  { path: 'websocket.scanBinaryHashes', label: 'Scan binary hashes', section: 'websocket', get: (d) => d.websocket.scanBinaryHashes, show: onOff },

  { path: 'siem.enabled', label: 'SIEM delivery', section: 'integrations', get: (d) => d.siem.enabled, show: onOff },
  // A webhook URL often carries a token; it is reviewed as a secret.
  { path: 'siem.webhookUrl', label: 'SIEM webhook URL', section: 'integrations', get: (d) => d.siem.webhookUrl, kind: 'secret' }
];

const RESPONSE_FIELDS: [keyof PolicyDraft['responses'], string][] = [
  ['jsChallengeHtml', 'JS challenge page'],
  ['clickPuzzleHtml', 'Click puzzle page'],
  ['ipRepHtml', 'IP reputation block page (HTML)'],
  ['ipRepJson', 'IP reputation block response (JSON)'],
  ['ipRepXml', 'IP reputation block response (XML)'],
  ['wafBlockHtml', 'WAF block page (HTML)'],
  ['wafBlockJson', 'WAF block response (JSON)'],
  ['wafBlockXml', 'WAF block response (XML)'],
  ['policyBlockHtml', 'Block policy page (HTML)'],
  ['policyBlockJson', 'Block policy response (JSON)'],
  ['policyBlockXml', 'Block policy response (XML)'],
  ['geoBlockHtml', 'Geo block page (HTML)'],
  ['geoBlockJson', 'Geo block response (JSON)'],
  ['geoBlockXml', 'Geo block response (XML)']
];

const FORMAT_FIELDS: [keyof PolicyDraft['responses']['formats'], string][] = [
  ['waf', 'WAF block response format'],
  ['policy', 'Block policy response format'],
  ['geo', 'Geo block response format'],
  ['ipRep', 'IP reputation response format']
];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function listDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const count = (entries: string[]) => {
    const map = new Map<string, number>();
    for (const entry of entries) map.set(entry, (map.get(entry) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [entry, times] of b) for (let i = (a.get(entry) ?? 0); i < times; i++) added.push(entry);
  for (const [entry, times] of a) for (let i = (b.get(entry) ?? 0); i < times; i++) removed.push(entry);
  return { added, removed };
}

function characters(value: string): string {
  const length = value.trim().length;
  return length ? `${length.toLocaleString('en-US')} characters` : 'built-in default';
}

/** Short description of what a rule path does, without secrets. */
export function describePathRule(rule: PathRuleDraft): string {
  const parts: string[] = [`${rule.match} match`];
  if (!rule.active) parts.push('inactive');
  if (rule.inspectionOff || tuningSkipsAll(rule.tuning)) parts.push('inspection off');
  else if (pathEnginesOff(rule).length) parts.push(`${pathEnginesOff(rule).length} ${pathEnginesOff(rule).length === 1 ? 'engine' : 'engines'} off`);
  if (pathEnginesLogOnly(rule).length) parts.push(`${pathEnginesLogOnly(rule).length} ${pathEnginesLogOnly(rule).length === 1 ? 'engine' : 'engines'} log only`);
  if (rule.block) parts.push(`hard block ${rule.block.status ?? 403}`);
  if (rule.ipRules) parts.push(`IP ${rule.ipRules.mode}`);
  if (rule.rateLimit) parts.push('rate limit');
  if (rule.loginProtection?.enabled) parts.push('login protection');
  if (rule.fieldRules.length) parts.push(`${rule.fieldRules.length} field rule${rule.fieldRules.length === 1 ? '' : 's'}`);
  if (rule.responseDecryptAes || rule.responseFieldRules.length) parts.push('response decryption');
  return parts.join(', ');
}

/** Which aspects of a rule path differ (keys and secrets are never shown). */
function pathRuleChanges(before: PathRuleDraft, after: PathRuleDraft): string[] {
  const checks: [string, (r: PathRuleDraft) => unknown][] = [
    ['match', (r) => [r.match, r.caseInsensitive]],
    ['status', (r) => r.active],
    ['inspection', (r) => r.inspectionOff],
    ['engines off', (r) => pathEnginesOff(r)],
    ['engines log only', (r) => pathEnginesLogOnly(r)],
    ['detection tuning', (r) => r.tuning],
    ['engine sensitivity', (r) => r.semanticOverride],
    ['IP access', (r) => r.ipRules],
    ['hard block', (r) => r.block],
    ['rate limit', (r) => r.rateLimit],
    ['body limit', (r) => r.bodySizeLimit],
    ['login protection', (r) => r.loginProtection],
    ['field rules', (r) => r.fieldRules.map((fr) => ({ ...fr, aesKey: fr.aesKey ? `#${fr.aesKey.length}:${hash(fr.aesKey)}` : '' }))],
    ['response decryption', (r) => [hash(r.responseDecryptAes), r.responseFieldRules.map((x) => [x.field, hash(x.aesKey)])]],
    ['comment', (r) => r.comment]
  ];
  return checks.filter(([, get]) => !same(get(before), get(after))).map(([label]) => label);
}

/** Non-reversible fingerprint used only to detect a changed secret. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return h;
}

export interface DiffOptions {
  includeWebSocket?: boolean;
}

export function diffPolicy(before: PolicyDraft, after: PolicyDraft, options: DiffOptions = {}): PolicyChange[] {
  const changes: PolicyChange[] = [];
  for (const field of FIELDS) {
    if (field.section === 'websocket' && !options.includeWebSocket) continue;
    const a = field.get(before);
    const b = field.get(after);
    if (field.kind === 'list') {
      const diff = listDiff(splitLines(String(a ?? ''), field.list), splitLines(String(b ?? ''), field.list));
      if (diff.added.length || diff.removed.length) changes.push({ section: field.section, path: field.path, label: field.label, kind: 'list', ...diff });
      continue;
    }
    if (same(a, b)) continue;
    if (field.kind === 'secret') {
      const note = !a ? 'set' : !b ? 'removed' : 'changed';
      changes.push({ section: field.section, path: field.path, label: field.label, kind: 'secret', note: `${note} (value hidden)` });
      continue;
    }
    const show = field.show ?? plain;
    changes.push({ section: field.section, path: field.path, label: field.label, kind: 'value', before: show(a), after: show(b) });
  }

  for (const meta of SEMANTIC_ENGINES) {
    const a = before.semantic[meta.key];
    const b = after.semantic[meta.key];
    const was = engineActionLabel(meta.key, a);
    const now = engineActionLabel(meta.key, b);
    if (was !== now) changes.push({ section: 'protection', path: `semantic.${meta.key}.enabled`, label: `${meta.label}: engine`, kind: 'value', before: was, after: now });
    const props: [keyof typeof a, string, (v: unknown) => string][] = [
      ['block', 'block value', plain],
      ['soft', 'soft value', plain]
    ];
    for (const [prop, propLabel, show] of props) {
      if (same(a[prop], b[prop])) continue;
      changes.push({ section: 'protection', path: `semantic.${meta.key}.${prop}`, label: `${meta.label}: ${propLabel}`, kind: 'value', before: show(a[prop]), after: show(b[prop]) });
    }
  }

  for (const [key, label] of RESPONSE_FIELDS) {
    const a = before.responses[key] as string;
    const b = after.responses[key] as string;
    if (a === b) continue;
    changes.push({ section: 'responses', path: `responses.${key}`, label, kind: 'text', note: `${characters(a)} → ${characters(b)}` });
  }
  for (const [key, label] of FORMAT_FIELDS) {
    const a = before.responses.formats[key];
    const b = after.responses.formats[key];
    if (a !== b) changes.push({ section: 'responses', path: `responses.formats.${key}`, label, kind: 'value', before: a.toUpperCase(), after: b.toUpperCase() });
  }

  // Rule paths: matched by their saved JSON object (unchanged rules keep it), then by path.
  const beforeRules = before.pathRules;
  const afterRules = after.pathRules;
  const matched = new Set<number>();
  afterRules.forEach((rule, index) => {
    let beforeIndex = rule.raw ? beforeRules.findIndex((b, i) => !matched.has(i) && b.raw && same(b.raw, rule.raw)) : -1;
    if (beforeIndex === -1) beforeIndex = beforeRules.findIndex((b, i) => !matched.has(i) && b.path.trim() === rule.path.trim() && b.match === rule.match);
    const name = rule.path.trim() || `#${index + 1}`;
    if (beforeIndex === -1) {
      changes.push({ section: 'path-rules', path: `pathRules.${index}`, label: `Rule path ${name}`, kind: 'text', note: `added (${describePathRule(rule)})` });
      return;
    }
    matched.add(beforeIndex);
    const previous = beforeRules[beforeIndex];
    if (same(pathRuleToJson(previous), pathRuleToJson(rule))) return;
    const aspects = pathRuleChanges(previous, rule);
    const renamed = previous.path.trim() !== rule.path.trim() ? `path ${previous.path.trim()} → ${rule.path.trim()}; ` : '';
    changes.push({ section: 'path-rules', path: `pathRules.${index}`, label: `Rule path ${name}`, kind: 'text', note: `${renamed}changed: ${aspects.join(', ') || 'details'}` });
  });
  beforeRules.forEach((rule, index) => {
    if (matched.has(index)) return;
    changes.push({ section: 'path-rules', path: `pathRules.removed.${index}`, label: `Rule path ${rule.path.trim() || `#${index + 1}`}`, kind: 'text', note: 'removed' });
  });
  if (changes.every((c) => c.section !== 'path-rules') && !same(beforeRules.map(pathRuleToJson), afterRules.map(pathRuleToJson))) {
    changes.push({ section: 'path-rules', path: 'pathRules.order', label: 'Rule paths', kind: 'text', note: 'order changed' });
  }
  return changes;
}

/** What is off in a draft: the policy's engines and, per rule path, its engines (the review drawer lists them). */
export function enginesOffSummary(draft: PolicyDraft): { policy: string[]; paths: { path: string; engines: string[] }[] } {
  const label = (key: string) => SEMANTIC_ENGINES.find((meta) => meta.key === key)?.label ?? key;
  return {
    policy: enginesOff(draft).map((meta) => meta.label),
    paths: draft.pathRules
      .map((rule, index) => ({ path: rule.path.trim() || `#${index + 1}`, engines: pathEnginesOff(rule).map(label) }))
      .filter((entry) => entry.engines.length > 0)
  };
}

/** The engines that only log in a draft: the policy's and, per rule path, those the path sets to Log only. */
export function enginesLogOnlySummary(draft: PolicyDraft): { policy: string[]; paths: { path: string; engines: string[] }[] } {
  const label = (key: string) => SEMANTIC_ENGINES.find((meta) => meta.key === key)?.label ?? key;
  return {
    policy: enginesLogOnly(draft).map((meta) => meta.label),
    paths: draft.pathRules
      .map((rule, index) => ({ path: rule.path.trim() || `#${index + 1}`, engines: pathEnginesLogOnly(rule).map(label) }))
      .filter((entry) => entry.engines.length > 0)
  };
}
