import { describe, expect, test } from 'bun:test';
import './support/runes';
import { fullRules, goDefaultRules, v1DefaultRules, v1Rules } from './support/waf-policy-fixtures';
import {
  draftFromRules,
  rulesFromDraft,
  toJsonValue,
  pathRuleToJson,
  pathRuleFromRaw,
  newPathRule,
  parseEngineByteSize,
  formatEngineByteSize,
  PROJECT_DEFAULT_SENSITIVITY,
  SEMANTIC_ENGINES,
  type PolicyDraft,
  type Json
} from '../src/lib/components/waf-policy/model';
import { validatePolicy, validatePathRule, fieldId } from '../src/lib/components/waf-policy/validate';
import { diffPolicy } from '../src/lib/components/waf-policy/review';

const { WafPolicyForm } = await import('../src/lib/components/waf-policy/waf-policy-form.svelte');

/** Draft without the per-rule JSON carriers (`raw`), for round-trip comparison. */
function comparable(draft: PolicyDraft): unknown {
  const copy = JSON.parse(JSON.stringify(draft)) as PolicyDraft;
  for (const rule of copy.pathRules) rule.raw = null;
  return copy;
}

/** Leaves of `before` whose value differs in `after` (keys only added in `after` are ignored). */
function changedLeaves(before: unknown, after: unknown, path = ''): string[] {
  if (before && typeof before === 'object') {
    if (!after || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) return [path];
    if (Array.isArray(before) && (after as unknown[]).length !== before.length) return [path];
    return Object.entries(before).flatMap(([key, value]) => changedLeaves(value, (after as Record<string, unknown>)[key], `${path}.${key}`));
  }
  return Object.is(before, after) ? [] : [path];
}

const roundTrip = (rules: Json, includeWebSocket = true) => {
  const draft = draftFromRules(rules);
  const saved = toJsonValue(rulesFromDraft(draft, rules, { includeWebSocket }));
  return { draft, saved, reloaded: draftFromRules(saved) };
};

/** Every key path of a document (objects and leaves; an array is a leaf). */
function keyPaths(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => [`${path}.${key}`, ...keyPaths(child, `${path}.${key}`)]);
}

describe('draft ⇄ rules round trip', () => {
  test('fromRules(toRules(x)) keeps every field of a fully populated config', () => {
    const rules = fullRules();
    const { draft, reloaded } = roundTrip(rules);
    expect(comparable(reloaded)).toEqual(comparable(draft));
    // Spot-check that the fixture really moved fields off their defaults.
    expect(draft.engines.inspectionOff).toBe(true);
    expect(draft.bot.mode).toBe('score');
    expect(draft.engines.recordWeakDetections).toBe(false);
    expect(draft.bot.scoreThreshold).toBe(200);
    expect(draft.semantic.ssti.enabled).toBe(false);
    expect(draft.semantic.proto_pollution.enabled).toBe(false);
    expect(draft.pathRules[0].tuning.effect.logOnly).toBe(true);
    expect(draft.pathRules[0].semanticOverride.xss).toEqual({ disabled: false, block: 6, soft: 3 });
    expect(draft.pathRules[0].loginProtection?.identifierField).toBe('username');
  });

  test('saving without edits keeps every loaded value and is idempotent', () => {
    const rules = fullRules();
    const { saved } = roundTrip(rules);
    // Only keys the engine treats as absent-by-default may be added (e.g. disabled:false).
    expect(changedLeaves(toJsonValue(rules), saved)).toEqual([]);
    expect(roundTrip(saved).saved).toEqual(saved);
  });

  test('unknown keys survive at every level', () => {
    const { saved } = roundTrip(fullRules());
    expect(saved.future_top_level).toEqual({ kept: true });
    expect((saved.geo as Json).future).toBe(7);
    expect((saved.ssrf as Json).future).toBe('x');
    expect((saved.bot_protection as Json).future).toBe(1);
    expect((saved.challenge as Json).template_version).toBe(3);
    const sql = (saved.semantic_policies as Record<string, Json>).sql;
    expect(sql.method_threshold).toEqual({ POST: { block: 8 } });
    expect(sql.route_threshold).toEqual({ '/login': { soft: 4 } });
    expect(((saved.websocket as Json).limits as Json).future_limit).toBe(1);
    const rule = (saved.path_exceptions as Json[])[0];
    expect(rule.future_rule_key).toEqual({ kept: 1 });
    expect((rule.semantic_override as Record<string, Json>).xss.method_risk).toEqual({ POST: 2 });
    expect((rule.semantic_override as Json).future_engine).toEqual({ x: 1 });
    expect((rule.login_protection as Json).future).toBe('lp');
  });

  test('the Go project defaults round-trip and a second save is identical', () => {
    const defaults = goDefaultRules();
    const first = roundTrip(defaults);
    expect(comparable(first.reloaded)).toEqual(comparable(first.draft));
    const second = roundTrip(first.saved);
    expect(second.saved).toEqual(first.saved);
    expect(changedLeaves(defaults, first.saved)).toEqual([]);
  });

  test('a save without edits does not change the default document: same keys, same values, project and application', () => {
    const defaults = goDefaultRules();
    // template_version is a stored key of the default document: the form keeps it and adds nothing.
    expect((defaults.challenge as Json).template_version).toBe(3);
    for (const includeWebSocket of [false, true]) {
      const { saved } = roundTrip(defaults, includeWebSocket);
      expect(saved).toEqual(defaults);
      expect(keyPaths(saved).sort()).toEqual(keyPaths(defaults).sort());
    }
  });

  test('a save without edits of the version 1 default document leaves with the key set of today\'s default and adds nothing', () => {
    const v1 = v1DefaultRules();
    const defaults = goDefaultRules();
    expect(keyPaths(v1).length).toBeGreaterThan(keyPaths(defaults).length);
    // The control plane stamps template_version on a save; the dashboard does not add it.
    const expected = structuredClone(defaults);
    delete (expected.challenge as Json).template_version;
    for (const includeWebSocket of [false, true]) {
      const { saved } = roundTrip(v1, includeWebSocket);
      expect(saved).toEqual(expected);
      const added = keyPaths(saved).filter((path) => !keyPaths(v1).includes(path));
      expect(added).toEqual([]);
    }
  });

  test('a default-valued key is left out only while the stored document lacks it', () => {
    const stored = { content_scan: { enabled: false, mode: 'block' }, semantic_policies: { sql: { disabled: false } }, websocket: { enabled: true } };
    const kept = roundTrip(stored, true).saved;
    expect(kept.content_scan).toMatchObject({ enabled: false, mode: 'block' });
    expect((kept.semantic_policies as Json).sql).toMatchObject({ disabled: false });
    expect(kept.websocket).toMatchObject({ enabled: true });
    const rules = goDefaultRules();
    const draft = draftFromRules(rules);
    draft.contentScan.enabled = true;
    draft.semantic.sql.enabled = false;
    draft.bot.blockAICrawlers = true;
    const saved = toJsonValue(rulesFromDraft(draft, rules)) as Json;
    expect(saved.content_scan).toEqual({ enabled: true });
    expect((saved.semantic_policies as Record<string, Json>).sql).toMatchObject({ disabled: true });
    expect((saved.semantic_policies as Record<string, Json>).xss).not.toHaveProperty('disabled');
    expect(saved.bot_protection).toMatchObject({ block_ai_crawlers: true });
    expect(saved.bot_protection).not.toHaveProperty('header_checks');
  });

  test('the default document has none of the version 1 keys and a save does not add them', () => {
    const defaults = goDefaultRules();
    const sp = defaults.semantic_policies as Json;
    for (const key of ['skip_coraza_when_clean', 'inspection_off', 'disable_semantic', 'disable_rule_based']) expect(sp).not.toHaveProperty(key);
    expect(defaults).not.toHaveProperty('thresholds');
    expect(defaults).not.toHaveProperty('categories');
    expect(sp).not.toHaveProperty('record_weak_detections');
    const saved = roundTrip(defaults).saved;
    expect(saved.semantic_policies).not.toHaveProperty('skip_coraza_when_clean');
    expect(saved.semantic_policies).not.toHaveProperty('inspection_off');
    expect(saved.semantic_policies).not.toHaveProperty('record_weak_detections');
    expect(saved).not.toHaveProperty('thresholds');
    expect(saved).not.toHaveProperty('categories');
    expect(saved.bot_protection).not.toHaveProperty('score_threshold');
  });

  test('a stored semantic_policies.on_uninspected survives a save', () => {
    const rules = { semantic_policies: { on_uninspected: 'block' } };
    const saved = toJsonValue(rulesFromDraft(draftFromRules(rules), rules, { includeWebSocket: false })) as Record<string, Record<string, unknown>>;
    expect(saved.semantic_policies.on_uninspected).toBe('block');
    const plain = { thresholds: { log: 80, block: 150 } };
    const savedPlain = toJsonValue(rulesFromDraft(draftFromRules(plain), plain, { includeWebSocket: false })) as Record<string, Record<string, unknown>>;
    expect(savedPlain.semantic_policies).not.toHaveProperty('on_uninspected');
  });

  test('WebSocket settings are only written for an application override', () => {
    const rules = { thresholds: { log: 80, block: 150 } };
    const changed = draftFromRules(rules);
    changed.websocket.enabled = false;
    expect(toJsonValue(rulesFromDraft(changed, rules, { includeWebSocket: false }))).not.toHaveProperty('websocket');
    expect(toJsonValue(rulesFromDraft(changed, rules, { includeWebSocket: true })).websocket).toEqual({ enabled: false });
    expect(toJsonValue(rulesFromDraft(draftFromRules(rules), rules, { includeWebSocket: true }))).not.toHaveProperty('websocket');
  });
});

describe('specific round-trip defects', () => {
  test('ssrf_blocklist_path stays a path and is never re-saved as a blocklist entry', () => {
    const rules = { ssrf: { ssrf_blocklist_path: '/etc/wafio/ssrf.txt' } };
    const { draft, saved } = roundTrip(rules);
    expect(draft.ssrf).toEqual({ list: '', path: '/etc/wafio/ssrf.txt' });
    expect(saved.ssrf).toEqual({ ssrf_blocklist_path: '/etc/wafio/ssrf.txt' });
  });

  test('the legacy fast_scan block is edited in place, not shadowed by a new ssrf block', () => {
    const rules = { fast_scan: { ssrf_blocklist_path: '/srv/ssrf.txt' } };
    const draft = draftFromRules(rules);
    draft.ssrf.list = '.corp\n# comment\n10.0.0.1';
    const saved = toJsonValue(rulesFromDraft(draft, rules));
    expect(saved).not.toHaveProperty('ssrf');
    expect(saved.fast_scan).toEqual({ ssrf_blocklist_path: '/srv/ssrf.txt', ssrf_blocklist: ['.corp', '10.0.0.1'] });
  });

  test('an untouched config without SSRF settings gets no ssrf block', () => {
    expect(roundTrip({ thresholds: { log: 1, block: 2 } }).saved).not.toHaveProperty('ssrf');
  });

  test('JA3 hashes stay in the JA3 lists (not copied into JA4)', () => {
    const rules = { bot_protection: { enabled: true, mode: 'log', ja3_blocklist: ['e7d705a3286e19ea42f587b344ee6865'] } };
    const { draft, saved } = roundTrip(rules);
    expect(draft.bot.ja4Blocklist).toBe('');
    expect(draft.bot.ja3Blocklist).toBe('e7d705a3286e19ea42f587b344ee6865');
    expect((saved.bot_protection as Json).ja4_blocklist).toBeUndefined();
    expect((saved.bot_protection as Json).ja3_blocklist).toEqual(['e7d705a3286e19ea42f587b344ee6865']);
  });

  test('bot protection is one mode: Off disables and keeps the last active mode', () => {
    const rules = { bot_protection: { enabled: true, mode: 'block', base_score: 100 } };
    const draft = draftFromRules(rules);
    expect(draft.bot.mode).toBe('block');
    draft.bot.mode = 'off';
    const saved = toJsonValue(rulesFromDraft(draft, rules)).bot_protection as Json;
    expect(saved.enabled).toBe(false);
    expect(saved.mode).toBe('block');
    expect(draftFromRules({ bot_protection: saved }).bot.mode).toBe('off');
    expect(draftFromRules({ bot_protection: { enabled: true, mode: 'off' } }).bot.mode).toBe('off');
    expect(draftFromRules({ bot_protection: { enabled: true, mode: '' } }).bot.mode).toBe('log');
  });

  test('request_body_limit keeps its saved spelling and formats edits exactly', () => {
    expect(parseEngineByteSize('5M')).toBe(5 * 1024 ** 2);
    expect(parseEngineByteSize(2048)).toBe(2048);
    expect(parseEngineByteSize('1.5M')).toBeNull();
    expect(formatEngineByteSize(512 * 1024)).toBe('512K');
    expect(formatEngineByteSize(1000)).toBe('1000');
    expect(formatEngineByteSize(1024 ** 3)).toBe('1G');
    const rules = { request_body_limit: '5120K' };
    expect(roundTrip(rules).saved.request_body_limit).toBe('5120K');
    const draft = draftFromRules(rules);
    draft.bodyLimit = 2 * 1024 ** 2;
    expect(toJsonValue(rulesFromDraft(draft, rules)).request_body_limit).toBe('2M');
    draft.bodyLimit = null;
    expect(toJsonValue(rulesFromDraft(draft, rules))).not.toHaveProperty('request_body_limit');
  });

  test('a base score of a version 1 document is dropped, and a 0 is an engine that is off', () => {
    const rules = { semantic_policies: { nosql: { block_threshold: 3, soft_threshold: 1.5, base_score: 250 }, xxe: { block_threshold: 2.5, soft_threshold: 1.5, base_score: 0 } } };
    const draft = draftFromRules(rules);
    expect(draft.semantic.nosql.enabled).toBe(true);
    expect(draft.semantic.xxe.enabled).toBe(false);
    const sp = toJsonValue(rulesFromDraft(draft, rules)).semantic_policies as Record<string, Json>;
    expect(sp.nosql).toEqual({ block_threshold: 3, soft_threshold: 1.5 });
    expect(sp.xxe).toEqual({ block_threshold: 2.5, soft_threshold: 1.5, disabled: true });
  });

  test('a category with a base score of 0 switches off the engines that fall back to it, unless they have a score of their own', () => {
    const rules = { categories: { XSS: { base_score: 0 }, SQLi: { base_score: 0 }, LFI: { base_score: 150 } }, semantic_policies: { sql: { base_score: 120 } } };
    const draft = draftFromRules(rules);
    expect(draft.semantic.xss.enabled).toBe(false);
    expect(draft.semantic.sql.enabled).toBe(true);
    expect(draft.semantic.lfi.enabled).toBe(true);
    const saved = toJsonValue(rulesFromDraft(draft, rules));
    expect(saved).not.toHaveProperty('categories');
    expect((saved.semantic_policies as Record<string, Json>).xss).toMatchObject({ disabled: true });
    expect((saved.semantic_policies as Record<string, Json>).sql).not.toHaveProperty('base_score');
  });

  test('a LOG score at the BLOCK score of a version 1 document is a switch that records no weak detection', () => {
    for (const [thresholds, recorded] of [
      [{ log: 150, block: 150 }, false], [{ log: 200, block: 150 }, false], [{ block: 80 }, false], [{ log: 100 }, true],
      [{ log: 80, block: 150 }, true], [{}, true], [{ log: 0, block: 0 }, true]
    ] as const) {
      const rules = { thresholds };
      expect(draftFromRules(rules).engines.recordWeakDetections).toBe(recorded);
      const saved = toJsonValue(rulesFromDraft(draftFromRules(rules), rules));
      expect(saved).not.toHaveProperty('thresholds');
      expect((saved.semantic_policies as Json).record_weak_detections).toBe(recorded ? undefined : false);
    }
    // The new key wins, and switching it back on removes it.
    const rules = { semantic_policies: { record_weak_detections: false }, thresholds: { log: 80, block: 150 } };
    const draft = draftFromRules(rules);
    expect(draft.engines.recordWeakDetections).toBe(false);
    draft.engines.recordWeakDetections = true;
    expect((toJsonValue(rulesFromDraft(draft, rules)).semantic_policies as Json)).not.toHaveProperty('record_weak_detections');
  });

  test('the block value of a version 1 document is the threshold of bot Score mode', () => {
    const rules = { thresholds: { block: 200 }, bot_protection: { enabled: true, mode: 'score', base_score: 100 } };
    const draft = draftFromRules(rules);
    expect(draft.bot.scoreThreshold).toBe(200);
    expect((toJsonValue(rulesFromDraft(draft, rules)).bot_protection as Json).score_threshold).toBe(200);
    expect(draftFromRules({ bot_protection: { enabled: true, mode: 'score', score_threshold: 120 }, thresholds: { block: 200 } }).bot.scoreThreshold).toBe(120);
    expect(draftFromRules({}).bot.scoreThreshold).toBe(150);
  });

  test('a new rule path serializes only what is set', () => {
    const rule = newPathRule();
    rule.path = ' /admin ';
    expect(pathRuleToJson(rule)).toEqual({ path: '/admin', match: 'prefix' });
  });

  test('project default sensitivity matches the Go defaults', () => {
    const defaults = goDefaultRules();
    const sp = defaults.semantic_policies as Record<string, Json>;
    for (const meta of SEMANTIC_ENGINES) {
      if (meta.switchOnly) {
        expect(sp[meta.key]).toBeUndefined();
        continue;
      }
      const def = PROJECT_DEFAULT_SENSITIVITY[meta.key as keyof typeof PROJECT_DEFAULT_SENSITIVITY];
      expect(sp[meta.key]).toEqual({ block_threshold: def.block, soft_threshold: def.soft });
      expect([meta.defaultBlock, meta.defaultSoft]).toEqual([def.block, def.soft]);
    }
  });
});

describe('validation', () => {
  test('reports every invalid field at once with field ids and sections', () => {
    const draft = draftFromRules({});
    draft.geo.allowIps = '10.0.0.1\n1::2::3';
    draft.geo.blockCountries = 'XX';
    draft.flood.allowIps = '10.0.0.0/8\nfrontend-host';
    draft.blockPolicy.keyFields = 'remote_addr, cookie';
    draft.bot.baseScore = null;
    draft.siem.enabled = true;
    draft.semantic.sql.soft = 9;
    draft.semantic.sql.block = 4;
    const issues = validatePolicy(draft, { countryCodes: new Set(['ID', 'US']) });
    const byPath = Object.fromEntries(issues.map((issue) => [issue.path, issue]));
    expect(byPath['geo.allowIps'].message).toContain('"1::2::3"');
    expect(byPath['geo.blockCountries'].message).toContain('"XX"');
    expect(byPath['flood.allowIps'].message).toContain('"frontend-host"');
    expect(byPath['blockPolicy.keyFields'].message).toContain('"cookie"');
    expect(byPath['bot.baseScore'].message).toContain('required');
    expect(byPath['siem.webhookUrl'].section).toBe('integrations');
    expect(byPath['semantic.sql.soft'].id).toBe(fieldId('semantic.sql.soft'));
    expect(byPath['semantic.sql.soft'].group).toBe('sensitivity');
    expect(byPath['semantic.sql.soft'].message).toContain('must not exceed');
    expect(issues.length).toBeGreaterThanOrEqual(7);
  });

  test('the bot score threshold is checked in Score mode only', () => {
    const draft = draftFromRules({});
    draft.bot.scoreThreshold = null;
    expect(validatePolicy(draft).map((issue) => issue.path)).not.toContain('bot.scoreThreshold');
    draft.bot.mode = 'score';
    const issue = () => validatePolicy(draft).find((item) => item.path === 'bot.scoreThreshold');
    expect(issue()?.message).toContain('required');
    expect(issue()?.section).toBe('bots');
    draft.bot.scoreThreshold = 10000;
    expect(issue()?.message).toContain('between 1 and 9,999');
    draft.bot.scoreThreshold = 150;
    expect(issue()).toBeUndefined();
  });

  test('a valid default config has no issues', () => {
    expect(validatePolicy(draftFromRules(goDefaultRules()), { includeWebSocket: true })).toEqual([]);
  });

  test('rule path checks include the server rules the old form missed', () => {
    const rule = newPathRule();
    rule.path = '/login';
    rule.ipRules = { mode: 'allowlist', ips: '' };
    rule.fieldRules = [{ field: '', source: 'any', action: 'decrypt_aes', aesKey: 'abc', methods: [] }];
    rule.responseFieldRules = [{ field: 'data', aesKey: '' }];
    rule.tuning.effect.skip_semantic = ['not-an-engine'];
    const paths = validatePathRule(rule).map((issue) => issue.path);
    expect(paths).toContain('ipRules.ips');
    expect(paths).toContain('fieldRules.0.field');
    expect(paths).toContain('fieldRules.0.aesKey');
    expect(paths).toContain('responseFieldRules.0.aesKey');
    expect(paths).toContain('tuning');
    rule.path = '[';
    rule.match = 'regex';
    expect(validatePathRule(rule)[0].message).toContain('Invalid regular expression');
  });

  test('a User-Agent pattern that does not compile is reported', () => {
    const draft = draftFromRules({});
    draft.bot.uaBlocklist = 'curl\nbad(pattern';
    expect(validatePolicy(draft).find((issue) => issue.path === 'bot.uaBlocklist')?.message).toContain('bad(pattern');
  });
});

describe('review diff', () => {
  test('lists show added and removed entries; secrets never appear', () => {
    const rules = fullRules();
    const before = draftFromRules(rules);
    const after = draftFromRules(rules);
    after.geo.blockIps = '203.0.113.7\n192.0.2.1';
    after.geo.allowIps = '10.0.0.0/8';
    after.challenge.secretKey = 'brand-new-secret';
    after.siem.webhookUrl = 'https://siem.example.test/hook?token=NEWTOKEN';
    after.pathRules[0].fieldRules[0].aesKey = 'f'.repeat(64);
    after.pathRules.push({ ...newPathRule(), path: '/new' });
    after.responses.wafBlockHtml = '<p>changed</p>';
    after.semantic.sql.block = 4.5;
    const changes = diffPolicy(before, after);
    const byPath = Object.fromEntries(changes.map((change) => [change.path, change]));
    expect(byPath['geo.blockIps']).toMatchObject({ kind: 'list', added: ['192.0.2.1'], removed: [] });
    expect(byPath['geo.allowIps']).toMatchObject({ kind: 'list', added: [], removed: ['2001:db8::1'] });
    expect(byPath['challenge.secretKey']).toMatchObject({ kind: 'secret', note: 'changed (value hidden)' });
    expect(byPath['semantic.sql.block']).toMatchObject({ before: '5', after: '4.5' });
    expect(byPath['pathRules.0'].note).toContain('field rules');
    expect(byPath['pathRules.2'].note).toContain('added');
    expect(byPath['responses.wafBlockHtml'].note).toContain('characters');
    const text = JSON.stringify(changes);
    for (const secret of ['brand-new-secret', 'super-secret', 'NEWTOKEN', 'token=abc', 'f'.repeat(64), 'c'.repeat(64)]) expect(text).not.toContain(secret);
  });

  test('removed rule paths are reported', () => {
    const rules = fullRules();
    const after = draftFromRules(rules);
    after.pathRules.splice(1, 1);
    const changes = diffPolicy(draftFromRules(rules), after);
    expect(changes).toEqual([expect.objectContaining({ section: 'path-rules', note: 'removed', label: 'Rule path ^/v[0-9]+/upload$' })]);
  });
});

describe('WafPolicyForm', () => {
  test('tracks dirty state and changes, discards and marks saved', () => {
    const form = WafPolicyForm.fromRules(fullRules(), { includeWebSocket: true });
    expect(form.isDirty).toBe(false);
    expect(form.changeCount).toBe(0);
    form.draft.semantic.sql.block = 6;
    form.draft.geo.blockCountries = 'RU\nCN';
    expect(form.isDirty).toBe(true);
    expect(form.changeCount).toBe(2);
    expect(form.isChanged('semantic.sql.block')).toBe(true);
    expect(form.isChanged('semantic.sql.soft')).toBe(false);
    form.discard();
    expect(form.isDirty).toBe(false);
    expect(form.draft.semantic.sql.block).toBe(5);
    form.draft.engines.inspectionOff = false;
    const saved = form.toRules();
    form.markSaved(saved);
    expect(form.isDirty).toBe(false);
    expect(WafPolicyForm.fromRules(saved).draft.engines.inspectionOff).toBe(false);
    expect(WafPolicyForm.fromRules(saved).draft.bot.scoreThreshold).toBe(200);
  });

  test('errors show for edited fields before a save attempt and for all fields after it', () => {
    const form = WafPolicyForm.fromRules({ siem: { enabled: true, webhook_url: '' } });
    expect(form.issues.map((issue) => issue.path)).toContain('siem.webhookUrl');
    expect(form.error('siem.webhookUrl')).toBeUndefined();
    form.draft.semantic.sql.block = -1;
    expect(form.error('semantic.sql.block')).toContain('between');
    expect(form.visibleIssues.map((issue) => issue.path)).toEqual(['semantic.sql.block']);
    form.submitted = true;
    expect(form.error('siem.webhookUrl')).toContain('required');
    expect(form.issueCount('integrations')).toBe(1);
  });

  test('toRules preserves unknown keys and fromRules(toRules()) is stable', () => {
    const form = WafPolicyForm.fromRules(fullRules(), { includeWebSocket: true });
    form.draft.flood.maxRequests = 999;
    const saved = form.toRules();
    expect(saved.future_top_level).toEqual({ kept: true });
    expect(comparable(WafPolicyForm.fromRules(saved).draft)).toEqual(comparable(form.draft));
  });

  test('country codes loaded later tighten validation', () => {
    const form = WafPolicyForm.fromRules({ geo: { allow_countries: ['ZZ'] } });
    expect(form.validate().find((issue) => issue.path === 'geo.allowCountries')).toBeUndefined();
    form.countryCodes = new Set(['ID']);
    expect(form.validate().find((issue) => issue.path === 'geo.allowCountries')?.message).toContain('"ZZ"');
  });
});

describe('the inspection switch in the policy document', () => {
  const read = (flags: Json) => draftFromRules({ semantic_policies: flags }).engines.inspectionOff;
  const save = (flags: Json, mutate: (draft: PolicyDraft) => void = () => {}) => {
    const rules = { semantic_policies: flags };
    const draft = draftFromRules(rules);
    mutate(draft);
    return toJsonValue(rulesFromDraft(draft, rules)).semantic_policies as Json;
  };
  const V1_KEYS = ['disable_semantic', 'disable_rule_based'];

  test('reading: inspection_off is off; so are the version 1 pair and disable_semantic alone; disable_rule_based alone has no effect', () => {
    expect(read({})).toBe(false);
    expect(read({ inspection_off: true })).toBe(true);
    expect(read({ inspection_off: false })).toBe(false);
    expect(read({ disable_semantic: true })).toBe(true);
    expect(read({ disable_semantic: true, disable_rule_based: true })).toBe(true);
    expect(read({ disable_rule_based: true })).toBe(false);
    expect(read({ disable_semantic: false, disable_rule_based: true })).toBe(false);
  });

  test('saving: off writes inspection_off only, on writes nothing, and no version 1 key travels on', () => {
    expect(save({}, (draft) => (draft.engines.inspectionOff = true))).toMatchObject({ inspection_off: true });
    for (const stored of [{}, { inspection_off: true }, { disable_semantic: true, disable_rule_based: true }, { disable_rule_based: true }, { disable_semantic: true }]) {
      const out = save(stored, (draft) => (draft.engines.inspectionOff = false));
      expect(out).not.toHaveProperty('inspection_off');
      for (const key of V1_KEYS) expect(out).not.toHaveProperty(key);
    }
  });

  test('a version 1 document saved without a change leaves with the new key only', () => {
    // The pair, and disable_semantic alone, were off and stay off.
    for (const stored of [{ disable_semantic: true, disable_rule_based: true }, { disable_semantic: true }, { inspection_off: true, disable_semantic: true, disable_rule_based: true }]) {
      const out = save(stored);
      expect(out).toMatchObject({ inspection_off: true });
      for (const key of V1_KEYS) expect(out).not.toHaveProperty(key);
    }
    // disable_rule_based alone meant nothing: it is dropped and inspection stays on.
    const lone = save({ disable_rule_based: true });
    expect(lone).not.toHaveProperty('inspection_off');
    expect(lone).not.toHaveProperty('disable_rule_based');
  });

  test('a path: the same mapping in both directions', () => {
    const lone = (flags: Json) => pathRuleFromRaw({ path: '/a', match: 'exact', ...flags });
    expect(lone({ inspection_off: true }).inspectionOff).toBe(true);
    expect(lone({ disable_semantic: true }).inspectionOff).toBe(true);
    expect(lone({ disable_semantic: true, disable_rule_based: true }).inspectionOff).toBe(true);
    expect(lone({ disable_rule_based: true }).inspectionOff).toBe(false);
    const rule = lone({ disable_rule_based: true });
    expect(pathRuleToJson(rule)).toEqual({ path: '/a', match: 'exact' });
    rule.inspectionOff = true;
    expect(pathRuleToJson(rule)).toEqual({ path: '/a', match: 'exact', inspection_off: true });
  });

  test('a path with the version 1 pair or a stale inspection_off is saved with the new key only', () => {
    expect(pathRuleToJson(pathRuleFromRaw({ path: '/a', match: 'exact', disable_semantic: true, disable_rule_based: true }))).toEqual({ path: '/a', match: 'exact', inspection_off: true });
    expect(pathRuleToJson(pathRuleFromRaw({ path: '/a', match: 'exact', disable_semantic: true }))).toEqual({ path: '/a', match: 'exact', inspection_off: true });
    expect(pathRuleToJson(pathRuleFromRaw({ path: '/a', match: 'exact', inspection_off: true, disable_semantic: true, disable_rule_based: true }))).toEqual({ path: '/a', match: 'exact', inspection_off: true });
    const off = pathRuleFromRaw({ path: '/a', match: 'exact', inspection_off: true, disable_semantic: true });
    off.inspectionOff = false;
    expect(pathRuleToJson(off)).toEqual({ path: '/a', match: 'exact' });
  });
});

describe('loading a v1 document', () => {
  test('it loads without an error and the form shows what is in effect', () => {
    const draft = draftFromRules(v1Rules());
    // The lone disable_rule_based of the policy has no effect.
    expect(draft.engines.inspectionOff).toBe(false);
    expect(draft.pathRules[0].inspectionOff).toBe(true);
    expect(draft.pathRules[1].inspectionOff).toBe(false);
    expect(draft.pathRules[2].inspectionOff).toBe(true);
    // What the version 1 scores meant is in the draft: weak detections are recorded (70 is below 170), a base score of 0 is
    // an engine that is off, any other base score means nothing.
    expect(draft.engines.recordWeakDetections).toBe(true);
    expect(draft.semantic.jwt.enabled).toBe(false);
    expect(draft.semantic.nosql.enabled).toBe(true);
    expect(draft.semantic.ldap.enabled).toBe(true);
    expect(draft.pathRules[0].semanticOverride.graphql?.disabled).toBe(true);
    expect(draft.pathRules[0].tuning.effect).toEqual({ skip_semantic: ['xss'], logOnly: true });
    expect(draft.pathRules[1].tuning.effect.logOnly).toBe(false);
    expect(draft.bot.scoreThreshold).toBe(150);
  });

  test('saving drops the keys of the removed rule engine and keeps the rest', () => {
    const rules = v1Rules();
    const saved = toJsonValue(rulesFromDraft(draftFromRules(rules), rules));
    const sp = saved.semantic_policies as Json;
    expect(sp).not.toHaveProperty('skip_coraza_when_clean');
    expect(sp).not.toHaveProperty('disable_rule_based');
    expect(sp).not.toHaveProperty('disable_semantic');
    expect(sp).not.toHaveProperty('inspection_off');
    expect(sp.on_uninspected).toBe('log');
    expect(sp.sql).toMatchObject({ block_threshold: 5, soft_threshold: 3 });
    expect(sp.nosql).toEqual({ block_threshold: 3, soft_threshold: 1.5 });
    expect(sp).not.toHaveProperty('ldap');
    expect(sp.jwt).toEqual({ disabled: true });
    expect(saved).not.toHaveProperty('categories');
    expect(saved).not.toHaveProperty('thresholds');
    expect(saved.future_top_level).toEqual({ kept: true });
    expect(keyPaths(saved).filter((path) => path.endsWith('.base_score') && !path.startsWith('.bot_protection'))).toEqual([]);
  });

  test('saving writes inspection_off for an off path and none of the version 1 keys', () => {
    const rules = v1Rules();
    const [editor, legacy, pair] = (toJsonValue(rulesFromDraft(draftFromRules(rules), rules)).path_exceptions as Json[]);
    expect(editor).toMatchObject({ path: '/api/editor', inspection_off: true });
    expect(editor).not.toHaveProperty('disable_semantic');
    expect(editor).not.toHaveProperty('disable_rule_based');
    expect(pair).toEqual({ path: '/pair', match: 'prefix', inspection_off: true });
    // The scores of a path go, and so does a weaken: this one lowered scores, so it is the log-only choice.
    expect(editor).not.toHaveProperty('rule_override');
    expect(editor.semantic_override).toEqual({ sql: { block_threshold: 6, soft_threshold: 3, disabled: false }, graphql: { disabled: true } });
    expect(editor.tuning).toEqual({ target: null, effect: { skip_semantic: ['xss'], action: 'log' } });
    // A weaken that changed no verdict shows as nothing.
    expect(legacy).toEqual({ path: '/legacy', match: 'exact' });
  });

  test('a second save of the saved document is identical', () => {
    const rules = v1Rules();
    const first = toJsonValue(rulesFromDraft(draftFromRules(rules), rules));
    expect(toJsonValue(rulesFromDraft(draftFromRules(first), first))).toEqual(first);
  });
});
