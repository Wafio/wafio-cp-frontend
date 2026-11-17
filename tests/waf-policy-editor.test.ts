import { describe, expect, test } from 'bun:test';
import { FakeClock } from './support/runes';
import './support/runes';
import { fullRules, goDefaultRules } from './support/waf-policy-fixtures';
import { draftFromRules, rulesFromDraft, toJsonValue, tuningHasEffect, type PolicyDraft, type Json } from '../src/lib/components/waf-policy/model';
import { BYTE_UNIT_SIZE, amountFromBytes, bestByteUnit, bytesFromAmount } from '../src/lib/components/waf-policy/byte-size';
import {
  RESPONSE_PAGES,
  exampleTemplate,
  fillTokens,
  pageCustomized,
  pageFormat,
  previewDocument,
  PreviewScheduler,
  templateKey,
  type ResponsePage
} from '../src/lib/components/waf-policy/responses';
import { POLICY_SECTIONS, groupBySection, policySections } from '../src/lib/components/waf-policy/sections';
import { validatePolicy } from '../src/lib/components/waf-policy/validate';
import { diffPolicy } from '../src/lib/components/waf-policy/review';

const { WafPolicyForm, readPath } = await import('../src/lib/components/waf-policy/waf-policy-form.svelte');

// ── Every field survives fromRules(toRules(x)) ──────────────────────────────

type Leaf = { path: string; value: unknown };

function leaves(value: unknown, path = ''): Leaf[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
  }
  return [{ path, value }];
}

function setPath(target: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>;
  current[keys[keys.length - 1]] = value;
}

/** Enumerated fields: the mutation must pick another allowed value. */
const ENUMS: [RegExp, readonly (string | number)[]][] = [
  [/^bot\.mode$/, ['off', 'log', 'score', 'block']],
  [/^challenge\.type$/, ['js_challenge', 'adaptive', 'click_puzzle', 'turnstile', 'hcaptcha']],
  [/^challenge\.trigger$/, ['always', 'on_bot_detect']],
  [/^challenge\.powDifficulty$/, [8, 12, 14, 16]],
  [/^responses\.formats\./, ['html', 'json', 'xml']],
  [/^contentScan\.mode$/, ['block', 'log', 'disabled']],
  [/^contentScan\.onIncomplete$/, ['log', 'block', 'allow']],
  [/^pathRules\.\d+\.match$/, ['prefix', 'exact', 'regex']],
  [/\.ipRules\.mode$/, ['allowlist', 'blocklist']],
  [/\.fieldRules\.\d+\.source$/, ['any', 'body.json', 'form', 'query', 'header']],
  [/\.fieldRules\.\d+\.action$/, ['mask', 'encrypt_aes', 'decrypt_aes']],
  [/\.tuning\.target\.match$/, ['exact', 'prefix', 'regex', 'any']]
];

function mutate(path: string, value: unknown): unknown {
  const allowed = ENUMS.find(([pattern]) => pattern.test(path))?.[1];
  if (allowed) return allowed.find((option) => option !== value);
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  // Digits survive the upper-casing (countries) and lower-casing (fingerprints, hashes) on save.
  if (typeof value === 'string') return `${value}9`;
  return undefined;
}

function reload(draft: PolicyDraft, original: Json): PolicyDraft {
  const saved = toJsonValue(rulesFromDraft(draft, original, { includeWebSocket: true }));
  return draftFromRules(saved);
}

describe('every field round-trips', () => {
  for (const [name, rules] of [['fully populated config', fullRules()], ['Go project defaults', goDefaultRules()]] as const) {
    test(`fromRules(toRules(x)) keeps each edited field of the ${name}`, () => {
      const base = draftFromRules(rules);
      const checked: string[] = [];
      const failures: string[] = [];
      for (const leaf of leaves(base)) {
        if (leaf.path.includes('.raw.') || leaf.path.endsWith('.raw') || leaf.value === null) continue;
        // A tuning target is only saved together with a tuning effect (backend contract).
        const tuningRule = /^pathRules\.(\d+)\.tuning\.target\./.exec(leaf.path);
        if (tuningRule && !tuningHasEffect(base.pathRules[Number(tuningRule[1])].tuning)) continue;
        const next = mutate(leaf.path, leaf.value);
        if (next === undefined) continue;
        const draft = draftFromRules(rules);
        setPath(draft, leaf.path, next);
        // The proof-of-work difficulty is only written for the challenge types that use it.
        if (leaf.path === 'challenge.powDifficulty') draft.challenge.type = 'js_challenge';
        const got = readPath(reload(draft, rules), leaf.path);
        if (!Object.is(got, next)) failures.push(`${leaf.path}: set ${JSON.stringify(next)}, reloaded ${JSON.stringify(got)}`);
        checked.push(leaf.path);
      }
      expect(failures).toEqual([]);
      expect(checked.length).toBeGreaterThan(name === 'fully populated config' ? 150 : 100);
    });
  }
});

// ── WafPolicyForm.load ──────────────────────────────────────────────────────

describe('WafPolicyForm.load', () => {
  test('replaces the loaded rules, drops edits and keeps the new unknown keys', () => {
    const form = WafPolicyForm.fromRules(fullRules(), { includeWebSocket: true });
    form.draft.bot.scoreThreshold = 999;
    form.submitted = true;
    expect(form.isDirty).toBe(true);
    form.load({ bot_protection: { enabled: true, mode: 'score', score_threshold: 20 }, brand_new: { x: 1 } });
    expect(form.isDirty).toBe(false);
    expect(form.submitted).toBe(false);
    expect(form.draft.bot.scoreThreshold).toBe(20);
    const saved = form.toRules();
    expect(saved.brand_new).toEqual({ x: 1 });
    expect(saved).not.toHaveProperty('future_top_level');
  });

  test('an edit typed while a save is in flight stays unsaved', () => {
    const form = WafPolicyForm.fromRules(fullRules());
    form.draft.bot.scoreThreshold = 300;
    const rules = form.toRules();
    const atSave = form.snapshot();
    form.draft.flood.maxRequests = 77; // typed during the request
    form.markSaved(rules, atSave);
    expect(form.isDirty).toBe(true);
    expect(form.changes.map((c) => c.path)).toEqual(['flood.maxRequests']);
    expect((form.toRules().bot_protection as Json).score_threshold).toBe(300);
  });

  test('a save after load is written on top of the reloaded rules', () => {
    const form = WafPolicyForm.fromRules({});
    form.load(fullRules());
    form.draft.flood.maxRequests = 42;
    const saved = form.toRules();
    expect((saved.l7_flood as Json).max_requests).toBe(42);
    expect(saved.future_top_level).toEqual({ kept: true });
  });
});

// ── Byte sizes ──────────────────────────────────────────────────────────────

describe('ByteSizeInput units', () => {
  test('shows a value in the largest exact binary unit', () => {
    expect(bestByteUnit(5 * 1024 ** 2)).toBe('MiB');
    expect(bestByteUnit(1024 ** 3)).toBe('GiB');
    expect(bestByteUnit(65536)).toBe('KiB');
    expect(bestByteUnit(1500)).toBe('B');
    expect(bestByteUnit(null)).toBe('MiB');
    expect(bestByteUnit(0, 'KiB')).toBe('KiB');
  });

  test('converts amounts and units both ways', () => {
    expect(bytesFromAmount(1.5, 'KiB')).toBe(1536);
    expect(bytesFromAmount(null, 'MiB')).toBeNull();
    expect(bytesFromAmount(Number.NaN, 'MiB')).toBeNull();
    expect(amountFromBytes(10 * BYTE_UNIT_SIZE.MiB, 'MiB')).toBe(10);
    expect(amountFromBytes(null, 'MiB')).toBeNull();
    for (const bytes of [1, 1000, 1024, 65536, 5 * 1024 ** 2, 1024 ** 3]) {
      const unit = bestByteUnit(bytes);
      expect(bytesFromAmount(amountFromBytes(bytes, unit), unit)).toBe(bytes);
    }
  });
});

// ── Custom responses ────────────────────────────────────────────────────────

describe('custom responses', () => {
  const COLORS = { background: '#000', text: '#fff', muted: '#888', border: '#333', accent: '#0ff', font: 'sans-serif', mono: 'monospace' };

  test('templates are chosen by page and format', () => {
    const draft = draftFromRules(fullRules());
    expect(pageFormat(draft.responses, 'block')).toBe('json');
    expect(templateKey('block', 'json')).toBe('wafBlockJson');
    expect(templateKey('js', 'json')).toBe('jsChallengeHtml');
    expect(pageCustomized(draft.responses, 'geo')).toBe(true);
    expect(pageCustomized(draftFromRules({}).responses, 'geo')).toBe(false);
  });

  test('only the tokens the agent replaces for a page are filled in the preview', () => {
    expect(fillTokens('{{WAFIO_SCORE}} {{WAFIO_IP}}', 'block')).toBe('185 {{WAFIO_IP}}');
    expect(fillTokens('{{WAFIO_IP}} {{WAFIO_SCORE}}', 'iprep')).toBe('203.0.113.7 {{WAFIO_SCORE}}');
    expect(fillTokens('{{WAFIO_MESSAGE}}', 'geo')).toContain('country not allowed');
    expect(fillTokens('{{WAFIO_INJECT}}', 'js')).toBe('[challenge widget]');
  });

  test('JSON and XML previews are escaped code, HTML renders with marked values', () => {
    const xml = previewDocument('<message>{{WAFIO_MESSAGE}}</message>', 'policy', 'xml', COLORS);
    expect(xml).toContain('&lt;message&gt;');
    expect(xml).not.toContain('<message>');
    const html = previewDocument('<h1>{{WAFIO_MESSAGE}}</h1>', 'geo', 'html', COLORS);
    expect(html).toContain('<h1><mark');
    expect(previewDocument('  ', 'block', 'json', COLORS)).toContain('built-in WAFio JSON response');
  });

  test('examples only use tokens their page supports', () => {
    for (const page of RESPONSE_PAGES) {
      const formats = page.htmlOnly ? (['html'] as const) : (['html', 'json', 'xml'] as const);
      for (const format of formats) {
        const tokens = exampleTemplate(page.id as ResponsePage, format).match(/\{\{WAFIO_[A-Z]+\}\}/g) ?? [];
        expect(tokens.length).toBeGreaterThan(0);
        for (const token of tokens) expect(page.tokens).toContain(token);
      }
    }
  });
});

// ── ResponseEditor's preview scheduler (ResponsesSection > ResponseEditor) ──

describe('PreviewScheduler (custom-response preview debounce)', () => {
  test('the first call for a key always runs immediately (initial render, and every page/format switch)', () => {
    const clock = new FakeClock();
    const scheduler = new PreviewScheduler(300, clock);
    const calls: string[] = [];
    expect(scheduler.schedule('block/html', () => calls.push('block/html'))).toBe(true);
    expect(scheduler.schedule('geo/html', () => calls.push('geo/html'))).toBe(true);
    expect(calls).toEqual(['block/html', 'geo/html']);
    expect(clock.pending).toBe(0);
  });

  test('a repeated key (the template content changed) is debounced instead of rebuilt at once', async () => {
    const clock = new FakeClock();
    const scheduler = new PreviewScheduler(300, clock);
    const calls: string[] = [];
    scheduler.schedule('block/html', () => calls.push('opened'));
    calls.length = 0;

    const ranImmediately = scheduler.schedule('block/html', () => calls.push('typed-1'));
    expect(ranImmediately).toBe(false);
    expect(calls).toEqual([]); // not rebuilt yet: the debounce is pending, not "never firing"
    await clock.advance(299);
    expect(calls).toEqual([]);
    await clock.advance(1);
    expect(calls).toEqual(['typed-1']);
  });

  test('rapid edits within the debounce window collapse into a single rebuild of the latest value', async () => {
    const clock = new FakeClock();
    const scheduler = new PreviewScheduler(300, clock);
    const calls: string[] = [];
    scheduler.schedule('block/html', () => calls.push('opened'));
    calls.length = 0;

    scheduler.schedule('block/html', () => calls.push('typed-1'));
    await clock.advance(100);
    scheduler.schedule('block/html', () => calls.push('typed-2'));
    await clock.advance(100);
    scheduler.schedule('block/html', () => calls.push('typed-3'));
    expect(clock.pending).toBe(1); // the two superseded timers were cancelled, not left to also fire
    await clock.advance(300);
    expect(calls).toEqual(['typed-3']);
  });

  test('switching page or format while a rebuild is pending cancels it and rebuilds the new target at once', async () => {
    const clock = new FakeClock();
    const scheduler = new PreviewScheduler(300, clock);
    const calls: string[] = [];
    scheduler.schedule('block/html', () => calls.push('block/html:opened'));
    calls.length = 0;

    scheduler.schedule('block/html', () => calls.push('block/html:typed'));
    const ranImmediately = scheduler.schedule('geo/html', () => calls.push('geo/html:opened'));
    expect(ranImmediately).toBe(true);
    expect(calls).toEqual(['geo/html:opened']);
    await clock.advance(1000);
    expect(calls).toEqual(['geo/html:opened']); // the stale block/html timer never fires
  });

  test('dispose() cancels a pending rebuild (component teardown while typing)', async () => {
    const clock = new FakeClock();
    const scheduler = new PreviewScheduler(300, clock);
    scheduler.schedule('block/html', () => {});
    const calls: string[] = [];
    scheduler.schedule('block/html', () => calls.push('typed'));
    scheduler.dispose();
    expect(clock.pending).toBe(0);
    await clock.advance(1000);
    expect(calls).toEqual([]);
  });

  // markVisible(): the one-shot signal ResponseEditor uses to remount the preview
  // iframe once the host <dialog> is confirmed open (Chrome otherwise leaves an
  // iframe blank forever when its srcdoc was first assigned while the dialog was
  // still closed, even though the dialog later opens with that same srcdoc).
  test('markVisible() reports true exactly once, however many times it is called', () => {
    const scheduler = new PreviewScheduler(300, new FakeClock());
    expect(scheduler.markVisible()).toBe(true);
    expect(scheduler.markVisible()).toBe(false);
    expect(scheduler.markVisible()).toBe(false);
  });

  test('markVisible() is independent per scheduler instance (a fresh dialog open gets its own one-shot)', () => {
    const a = new PreviewScheduler(300, new FakeClock());
    const b = new PreviewScheduler(300, new FakeClock());
    expect(a.markVisible()).toBe(true);
    expect(b.markVisible()).toBe(true);
    expect(a.markVisible()).toBe(false);
  });
});

// ── Section index ───────────────────────────────────────────────────────────

describe('section index', () => {
  test('protection comes first; WebSocket and custom rules only for an application', () => {
    expect(POLICY_SECTIONS[0].id).toBe('protection');
    const project = policySections({ app: false }).map((s) => s.id);
    const app = policySections({ app: true }).map((s) => s.id);
    expect(project).not.toContain('websocket');
    expect(project).not.toContain('custom-rules');
    expect(app).toContain('websocket');
    expect(app).toContain('custom-rules');
  });

  test('IP reputation has its own section, right before Bot challenge, on projects and applications', () => {
    for (const app of [false, true]) {
      const ids = policySections({ app }).map((s) => s.id);
      expect(ids.indexOf('ip-reputation')).toBe(ids.indexOf('challenge') - 1);
    }
  });

  test('issues group by section in index order', () => {
    const draft = draftFromRules({});
    draft.siem.enabled = true;
    draft.semantic.sql.block = 900;
    draft.geo.blockIps = 'nope';
    const groups = groupBySection(validatePolicy(draft));
    expect(groups.map((g) => g.section.id)).toEqual(['protection', 'access', 'integrations']);
  });
});

// ── IP reputation ──────────────────────────────────────────────────────────

describe('IP reputation', () => {
  test('is kept on save while the bot challenge is off', () => {
    const original: Json = { challenge: { enabled: false, ip_rep_enabled: true, ip_rep_block_level1: true, ip_rep_block_level2: false } };
    const draft = draftFromRules(original);
    expect(draft.challenge.enabled).toBe(false);
    expect(draft.challenge.ipRepEnabled).toBe(true);
    const saved = toJsonValue(rulesFromDraft(draft, original)) as { challenge: Record<string, unknown> };
    expect(saved.challenge.enabled).toBe(false);
    expect(saved.challenge.ip_rep_enabled).toBe(true);
    expect(saved.challenge.ip_rep_block_level1).toBe(true);
    expect(saved.challenge.ip_rep_block_level2).toBe(false);
  });

  test('changes are reviewed under the IP reputation section', () => {
    const before = draftFromRules({});
    const after = draftFromRules({});
    after.challenge.ipRepEnabled = true;
    after.challenge.ipRepLevel2Block = true;
    const changes = diffPolicy(before, after).filter((c) => c.path.startsWith('challenge.ipRep'));
    expect(changes.map((c) => c.path).sort()).toEqual(['challenge.ipRepEnabled', 'challenge.ipRepLevel2Block']);
    expect(changes.every((c) => c.section === 'ip-reputation')).toBe(true);
  });
});
