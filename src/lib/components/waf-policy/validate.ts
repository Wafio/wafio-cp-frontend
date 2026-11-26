/**
 * All-field validation of a policy draft. Mirrors the server checks in
 * internal/engine/config.go (validateLoadResult, validateSemanticPolicies)
 * and adds a few the server cannot report precisely (regex patterns that
 * would silently disable the User-Agent list, SHA-256 hash format).
 *
 * Every issue names the draft path it belongs to, the DOM id of the control
 * (for the error summary links) and the form section.
 */
import { validateWebSocketConfig } from '../../waf-config';
import { isIPOrCIDR, isKeyField, KEY_FIELDS, isURL, isAES256Key } from '../../validation';
import {
  SENSITIVITY_ENGINES,
  semanticMeta,
  splitLines,
  type PathRuleDraft,
  type PolicyDraft,
  type SemanticKey
} from './model';
import { SEMANTIC_ENGINES as TUNING_ENGINES } from '../rules/registry';

export type SectionId =
  | 'protection'
  | 'access'
  | 'ssrf'
  | 'rate-limits'
  | 'bots'
  | 'ip-reputation'
  | 'challenge'
  | 'uploads'
  | 'websocket'
  | 'path-rules'
  | 'custom-rules'
  | 'responses'
  | 'integrations';

export interface PolicyIssue {
  /** Draft path, e.g. "semantic.sql.block" or "pathRules.2". */
  path: string;
  /** DOM id of the control to focus. */
  id: string;
  section: SectionId;
  /** Sub-group that may be collapsed (e.g. "sensitivity"). */
  group?: 'sensitivity' | 'legacy-ja3';
  message: string;
}

export interface ValidationContext {
  /** ISO 3166-1 alpha-2 codes known to the server (upper case); empty = not loaded yet. */
  countryCodes?: ReadonlySet<string>;
  includeWebSocket?: boolean;
}

/** DOM id of the control for a draft path ("geo.allowIps" → "wp-geo-allowIps"). */
export function fieldId(path: string): string {
  return `wp-${path.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

const MAX_BODY_BYTES = 1024 ** 3;
const MAX_CONTENT_SCAN_BYTES = 100 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/i;
const COUNTRY = /^[A-Za-z]{2}$/;
const REGEX_META = /[.*+?[\]()|^$\\]/;

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Integer in [min, max]; null message when valid. */
function intRange(value: unknown, min: number, max: number, label: string): string | null {
  if (value === null || value === undefined || (value as unknown) === '') return `${label} is required.`;
  if (!isInt(value)) return `${label} must be a whole number.`;
  if (value < min || value > max) return `${label} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`;
  return null;
}

/** Number in [min, max]; an empty value is fine, it means the engine default. */
function optionalNumRange(value: unknown, min: number, max: number, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isNum(value)) return `${label} must be a number such as 2.5.`;
  if (value < min || value > max) return `${label} must be between ${min} and ${max}.`;
  return null;
}

function keyFieldError(text: string, label: string): string | null {
  for (const entry of splitLines(text, { commas: true })) {
    if (isKeyField(entry)) continue;
    if (entry.startsWith('header:')) return `${label}: "${entry}" is not a valid header key. Use header:Header-Name, e.g. header:X-Request-ID.`;
    return `${label}: "${entry}" is not supported. Use ${KEY_FIELDS.join(', ')} or header:Header-Name.`;
  }
  return null;
}

function firstInvalid(entries: string[], valid: (entry: string) => boolean): string | undefined {
  return entries.find((entry) => !valid(entry));
}

/** User-Agent patterns with regex metacharacters must compile, or the agent drops the whole list. */
function badPattern(entries: string[]): string | undefined {
  return entries.find((entry) => {
    if (!REGEX_META.test(entry)) return false;
    try {
      new RegExp(entry, 'i');
      return false;
    } catch {
      return true;
    }
  });
}

export function validatePolicy(draft: PolicyDraft, ctx: ValidationContext = {}): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const add = (path: string, section: SectionId, message: string | null | undefined, group?: PolicyIssue['group']) => {
    if (message) issues.push({ path, id: fieldId(path), section, message, ...(group ? { group } : {}) });
  };

  // ── Protection: engine sensitivity. An empty threshold is the default. ──
  for (const meta of SENSITIVITY_ENGINES) {
    const s = draft.semantic[meta.key];
    const blockError = optionalNumRange(s.block, 0, 100, `${meta.label}: block threshold`);
    const softError = optionalNumRange(s.soft, 0, 100, `${meta.label}: soft threshold`);
    add(`semantic.${meta.key}.block`, 'protection', blockError, 'sensitivity');
    add(`semantic.${meta.key}.soft`, 'protection', softError, 'sensitivity');
    const block = s.block ?? meta.defaultBlock;
    const soft = s.soft ?? meta.defaultSoft;
    if (!blockError && !softError && s.enabled && soft > 0 && block > 0 && soft > block) {
      add(`semantic.${meta.key}.soft`, 'protection', `${meta.label}: soft threshold must not exceed the block threshold.`, 'sensitivity');
    }
  }

  // ── Access ──
  const ipList = (path: 'allowIps' | 'blockIps', label: string) => {
    const bad = firstInvalid(splitLines(draft.geo[path], { commas: true }), (entry) => isIPOrCIDR(entry));
    add(`geo.${path}`, 'access', bad !== undefined ? `${label}: "${bad}" is not an IP address or CIDR range (e.g. 203.0.113.7, 10.0.0.0/8, 2001:db8::/32).` : null);
  };
  ipList('allowIps', 'Allowed IPs');
  ipList('blockIps', 'Blocked IPs');
  const countries = (path: 'allowCountries' | 'blockCountries', label: string) => {
    const codes = ctx.countryCodes;
    const bad = firstInvalid(splitLines(draft.geo[path], { commas: true }), (entry) =>
      COUNTRY.test(entry) && (!codes || codes.size === 0 || codes.has(entry.toUpperCase()))
    );
    add(`geo.${path}`, 'access', bad !== undefined ? `${label}: "${bad}" is not an ISO 3166-1 alpha-2 country code (e.g. ID, US, SG).` : null);
  };
  countries('allowCountries', 'Allowed countries');
  countries('blockCountries', 'Blocked countries');

  // ── SSRF ──
  const badHost = firstInvalid(splitLines(draft.ssrf.list, { comments: true }), (entry) => !/\s/.test(entry));
  add('ssrf.list', 'ssrf', badHost !== undefined ? `SSRF blocklist: "${badHost}" must be one host, .suffix or IP per line.` : null);

  // ── Rate limits (block_policy is validated by the server even when disabled) ──
  add('blockPolicy.afterN', 'rate-limits', intRange(draft.blockPolicy.afterN, 1, 999, 'Block after'));
  add('blockPolicy.durationSec', 'rate-limits', intRange(draft.blockPolicy.durationSec, 1, 604800, 'Block duration'));
  add('blockPolicy.keyFields', 'rate-limits', keyFieldError(draft.blockPolicy.keyFields, 'Client key'));
  const target = draft.blockPolicy.target;
  add('blockPolicy.target', 'rate-limits', target === 'waf' || target === 'kernel' ? null : `Where the block applies: "${target}" is not a choice. Use WAFio only or WAFio and the server firewall.`);
  if (draft.flood.enabled) {
    add('flood.maxRequests', 'rate-limits', intRange(draft.flood.maxRequests, 1, 100000, 'Maximum requests'));
    add('flood.windowSec', 'rate-limits', intRange(draft.flood.windowSec, 1, 86400, 'Period'));
    add('flood.keyFields', 'rate-limits', keyFieldError(draft.flood.keyFields, 'Client key'));
  }
  // The server checks flood allow_ips even when the flood limit is off.
  const badExempt = firstInvalid(splitLines(draft.flood.allowIps, { commas: true }), (entry) => isIPOrCIDR(entry));
  add('flood.allowIps', 'rate-limits', badExempt !== undefined ? `Exempt clients: "${badExempt}" is not an IP address or CIDR range (e.g. 203.0.113.7, 10.0.0.0/8, 2001:db8::/32).` : null);

  // ── Bots (bot_protection is validated by the server whenever present) ──
  add('bot.baseScore', 'bots', intRange(draft.bot.baseScore, 0, 999, 'Bot score'));
  // The threshold is only shown in Score mode, so only that mode checks it.
  if (draft.bot.mode === 'score') add('bot.scoreThreshold', 'bots', intRange(draft.bot.scoreThreshold, 1, 9999, 'Score threshold'));
  for (const [path, label] of [['uaBlocklist', 'User-Agent blocklist'], ['uaAllowlist', 'User-Agent allowlist']] as const) {
    const bad = badPattern(splitLines(draft.bot[path]));
    add(`bot.${path}`, 'bots', bad !== undefined ? `${label}: "${bad}" is not a valid regular expression; the agent would ignore the whole list.` : null);
  }

  // ── Challenge ──
  const c = draft.challenge;
  if (c.enabled) {
    if (c.type === 'turnstile' || c.type === 'hcaptcha') {
      const provider = c.type === 'turnstile' ? 'Turnstile' : 'hCaptcha';
      add('challenge.siteKey', 'challenge', c.siteKey.trim() ? null : `${provider} site key is required.`);
      add('challenge.secretKey', 'challenge', c.secretKey.trim() ? null : `${provider} secret key is required.`);
    }
    add('challenge.cookieTTL', 'challenge', intRange(c.cookieTTL, 60, 86400, 'Cookie lifetime'));
  }

  // ── Uploads and body limits ──
  if (draft.bodyLimit !== null) {
    add('bodyLimit', 'uploads', intRange(draft.bodyLimit, 1, MAX_BODY_BYTES, 'Request body limit') ? 'Request body limit must be between 1 byte and 1 GiB, or empty for no limit.' : null);
  }
  if (draft.contentScan.enabled) {
    add('contentScan.maxBytes', 'uploads', intRange(draft.contentScan.maxBytes, 0, MAX_CONTENT_SCAN_BYTES, 'Scan budget') ? 'Scan budget must be between 0 and 100 MiB.' : null);
    for (const [path, label] of [['blocklist', 'Blocked hashes'], ['allowlist', 'Allowed hashes']] as const) {
      const bad = firstInvalid(splitLines(draft.contentScan[path], { comments: true }), (entry) => SHA256.test(entry));
      add(`contentScan.${path}`, 'uploads', bad !== undefined ? `${label}: "${bad}" is not a SHA-256 hash (64 hexadecimal characters).` : null);
    }
  }

  // ── WebSocket (app override only) ──
  if (ctx.includeWebSocket) {
    const w = draft.websocket;
    const origins = splitLines(w.origins);
    const originError = validateWebSocketConfig({
      enabled: w.enabled,
      origin_check: { enabled: w.originCheck, allowed_origins: origins },
      limits: { max_text_bytes: 0, max_binary_bytes: 0, max_messages_per_min: 0 },
      scan_server_frames: w.scanServerFrames,
      scan_binary_hashes: w.scanBinaryHashes
    });
    add('websocket.origins', 'websocket', originError);
    // Empty = 0 = agent default.
    for (const [key, label] of [['maxTextBytes', 'Maximum text message'], ['maxBinaryBytes', 'Maximum binary message'], ['maxMessagesPerMin', 'Messages per minute']] as const) {
      if (w[key] !== null) add(`websocket.${key}`, 'websocket', intRange(w[key], 0, Number.MAX_SAFE_INTEGER, label));
    }
  }

  // ── Integrations (the server checks a non-empty URL even when SIEM is off) ──
  const url = draft.siem.webhookUrl.trim();
  if (draft.siem.enabled && !url) add('siem.webhookUrl', 'integrations', 'Webhook URL is required while SIEM delivery is on.');
  else if (url && !isURL(url)) add('siem.webhookUrl', 'integrations', 'Webhook URL must be an http or https address without credentials.');

  // ── Path rules ──
  if (draft.pathRules.length > 50) add('pathRules', 'path-rules', `At most 50 rule paths are allowed (${draft.pathRules.length} configured).`);
  draft.pathRules.forEach((rule, index) => {
    const problems = validatePathRule(rule);
    if (problems.length) {
      issues.push({
        path: `pathRules.${index}`,
        id: fieldId(`pathRules.${index}.edit`),
        section: 'path-rules',
        message: `Rule path ${rule.path.trim() || `#${index + 1}`}: ${problems[0].message}`
      });
    }
  });

  return issues;
}

export interface PathRuleIssue {
  /** Path inside the rule, e.g. "path", "fieldRules.0.aesKey". */
  path: string;
  /** Editor tab that holds the control. */
  tab: 'path' | 'inspection' | 'access' | 'limits' | 'login' | 'fields' | 'sensitivity';
  message: string;
}

/** Validation of one rule path (editor dialog and save). */
export function validatePathRule(rule: PathRuleDraft): PathRuleIssue[] {
  const issues: PathRuleIssue[] = [];
  const add = (path: string, tab: PathRuleIssue['tab'], message: string | null | undefined) => {
    if (message) issues.push({ path, tab, message });
  };
  const path = rule.path.trim();
  if (!path) add('path', 'path', 'Path is required.');
  else if (path.length > 500) add('path', 'path', 'Path must be at most 500 characters.');
  else if (rule.match !== 'regex' && !path.startsWith('/')) add('path', 'path', 'Prefix and exact paths start with "/".');
  else if (rule.match === 'regex') {
    try {
      new RegExp(path);
    } catch (error) {
      add('path', 'path', `Invalid regular expression: ${(error as Error).message}`);
    }
  }
  if (rule.comment.trim().length > 200) add('comment', 'path', 'Comment must be at most 200 characters.');

  const t = rule.tuning;
  const badEngine = t.effect.skip_semantic.find((engine) => engine !== '*' && !TUNING_ENGINES.includes(engine));
  add('tuning', 'inspection', badEngine !== undefined ? `Skip semantic entry "${badEngine}" is not a known engine.` : null);

  // Only the thresholds of a threshold engine are edited on a path.
  for (const [key, ov] of Object.entries(rule.semanticOverride) as [SemanticKey, NonNullable<PathRuleDraft['semanticOverride'][SemanticKey]>][]) {
    const meta = semanticMeta(key);
    if (meta.switchOnly) continue;
    const blockError = optionalNumRange(ov.block, 0, 100, `${meta.label}: block threshold`);
    const softError = optionalNumRange(ov.soft, 0, 100, `${meta.label}: soft threshold`);
    add(`semanticOverride.${key}.block`, 'sensitivity', blockError);
    add(`semanticOverride.${key}.soft`, 'sensitivity', softError);
    const block = ov.block ?? meta.defaultBlock;
    const soft = ov.soft ?? meta.defaultSoft;
    if (!blockError && !softError && soft > 0 && block > 0 && soft > block) {
      add(`semanticOverride.${key}.soft`, 'sensitivity', `${meta.label}: soft threshold must not exceed the block threshold.`);
    }
  }

  if (rule.ipRules) {
    const ips = splitLines(rule.ipRules.ips, { commas: true });
    if (!ips.length) add('ipRules.ips', 'access', 'Add at least one IP address or CIDR range, or turn IP access control off.');
    const bad = firstInvalid(ips, (entry) => isIPOrCIDR(entry));
    if (bad !== undefined) add('ipRules.ips', 'access', `"${bad}" is not an IP address or CIDR range (e.g. 203.0.113.7, 10.0.0.0/24).`);
  }
  if (rule.block) {
    add('block.status', 'access', intRange(rule.block.status, 400, 599, 'Status code'));
    if (rule.block.message.trim().length > 200) add('block.message', 'access', 'Message must be at most 200 characters.');
  }
  if (rule.rateLimit) {
    add('rateLimit.maxRequests', 'limits', intRange(rule.rateLimit.maxRequests, 1, 1_000_000, 'Maximum requests'));
    add('rateLimit.windowSec', 'limits', intRange(rule.rateLimit.windowSec, 1, 86400, 'Window'));
  }
  if (rule.bodySizeLimit !== null && !(isInt(rule.bodySizeLimit) && rule.bodySizeLimit >= 0)) {
    add('bodySizeLimit', 'limits', 'Body size limit must be a whole number of bytes.');
  }
  const lp = rule.loginProtection;
  if (lp) {
    add('loginProtection.maxAttempts', 'login', intRange(lp.maxAttempts, 1, 1_000_000, 'Maximum attempts'));
    add('loginProtection.windowSec', 'login', intRange(lp.windowSec, 1, 86400 * 7, 'Window'));
    add('loginProtection.lockoutSec', 'login', intRange(lp.lockoutSec, 0, 86400 * 30, 'Lockout'));
    if (!lp.byIp && !lp.byUserAgent && !lp.identifierField.trim()) {
      add('loginProtection.byIp', 'login', 'Track attempts by client IP, User-Agent or a body field.');
    }
  }
  rule.fieldRules.forEach((fr, index) => {
    const label = `Field rule ${fr.field.trim() || index + 1}`;
    if (!fr.field.trim()) add(`fieldRules.${index}.field`, 'fields', `Field rule ${index + 1}: field name is required.`);
    if (fr.action === 'encrypt_aes' || fr.action === 'decrypt_aes') {
      if (!fr.aesKey.trim()) add(`fieldRules.${index}.aesKey`, 'fields', `${label}: an AES-256 key is required (64 hexadecimal characters).`);
      else if (!isAES256Key(fr.aesKey)) add(`fieldRules.${index}.aesKey`, 'fields', `${label}: the AES-256 key must be exactly 64 hexadecimal characters.`);
    } else if (fr.aesKey.trim() && !isAES256Key(fr.aesKey)) {
      add(`fieldRules.${index}.aesKey`, 'fields', `${label}: the AES-256 key must be exactly 64 hexadecimal characters.`);
    }
  });
  if (rule.responseDecryptAes.trim() && !isAES256Key(rule.responseDecryptAes)) {
    add('responseDecryptAes', 'fields', 'Response decryption key must be exactly 64 hexadecimal characters.');
  }
  rule.responseFieldRules.forEach((rfr, index) => {
    if (!rfr.field.trim()) add(`responseFieldRules.${index}.field`, 'fields', `Response field ${index + 1}: field path is required.`);
    if (!isAES256Key(rfr.aesKey)) add(`responseFieldRules.${index}.aesKey`, 'fields', `Response field ${rfr.field.trim() || index + 1}: the AES-256 key must be exactly 64 hexadecimal characters.`);
  });
  return issues;
}
