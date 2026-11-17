// Contrast and token-integrity checks for the design tokens in src/app.css.
// Parses the `:root` (dark) and `[data-theme='light']` blocks, resolves var()/color-mix(), and asserts WCAG
// ratios for both themes: text ≥ 4.5:1, UI boundaries and marks ≥ 3:1.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8');

// ── Token parsing ───────────────────────────────────────────────────────────

type Tokens = Record<string, string>;

function block(selector: string): string {
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = src.indexOf(selector + ' {');
  if (at < 0) throw new Error(`selector ${selector} not found in app.css`);
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  return src.slice(open + 1, close);
}

function declarations(body: string): Tokens {
  const out: Tokens = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const ROOT = declarations(block(':root'));
const LIGHT_ONLY = declarations(block("[data-theme='light']"));
const THEMES: Record<'dark' | 'light', Tokens> = { dark: ROOT, light: { ...ROOT, ...LIGHT_ONLY } };
type Theme = keyof typeof THEMES;

function resolve(value: string, tokens: Tokens, depth = 0): string {
  if (depth > 20) throw new Error(`var() cycle while resolving ${value}`);
  const re = /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/;
  let out = value;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const inner = tokens[m[1]] ?? m[2];
    if (inner === undefined) throw new Error(`undefined token --${m[1]}`);
    out = out.slice(0, m.index) + resolve(inner, tokens, depth + 1) + out.slice(m.index + m[0].length);
  }
  return out;
}

function tokenValue(theme: Theme, name: string): string {
  const raw = THEMES[theme][name];
  if (raw === undefined) throw new Error(`--${name} is not defined for the ${theme} theme`);
  return resolve(raw, THEMES[theme]);
}

// ── Colour math (sRGB, WCAG 2.x, OKLab) ────────────────────────────────────

type RGBA = { r: number; g: number; b: number; a: number }; // r,g,b 0–255, a 0–1

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function parseColor(input: string): RGBA {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) throw new Error(`bad hex ${input}`);
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = /^rgba?\((.*)\)$/.exec(s);
  if (rgb) {
    const p = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  const mix = /^color-mix\(\s*in srgb\s*,(.*)\)$/.exec(s);
  if (mix) {
    const [a, b] = splitTopLevel(mix[1]);
    const pct = (part: string) => {
      const m = /\s(\d+(?:\.\d+)?)%\s*$/.exec(part);
      return m ? { color: part.slice(0, m.index), p: Number(m[1]) / 100 } : { color: part, p: undefined };
    };
    const A = pct(a);
    const B = pct(b);
    const pa = A.p ?? (B.p !== undefined ? 1 - B.p : 0.5);
    const pb = B.p ?? 1 - pa;
    const ca = parseColor(A.color);
    const cb = parseColor(B.color);
    // CSS Color 5: interpolate premultiplied, then un-premultiply.
    const alpha = ca.a * pa + cb.a * pb;
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k: 'r' | 'g' | 'b') => (ca[k] * ca.a * pa + cb[k] * cb.a * pb) / alpha;
    return { r: ch('r'), g: ch('g'), b: ch('b'), a: alpha };
  }
  throw new Error(`unsupported colour syntax: ${input}`);
}

function over(fg: RGBA, bg: RGBA): RGBA {
  if (bg.a !== 1) throw new Error('backdrop must be opaque');
  const k = (c: 'r' | 'g' | 'b') => fg[c] * fg.a + bg[c] * (1 - fg.a);
  return { r: k('r'), g: k('g'), b: k('b'), a: 1 };
}

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function luminance(c: RGBA): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrast(a: RGBA, b: RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function oklab(c: RGBA): [number, number, number] {
  const r = lin(c.r);
  const g = lin(c.g);
  const b = lin(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

/** Euclidean OKLab distance ×100 (the dataviz skill's ΔE scale; 15 = normal-vision floor). */
function deltaE(a: RGBA, b: RGBA): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

function hueDeg(c: RGBA): number {
  const [, a, b] = oklab(c);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

const color = (theme: Theme, name: string) => parseColor(tokenValue(theme, name));
const opaque = (theme: Theme, name: string) => {
  const c = color(theme, name);
  if (c.a !== 1) throw new Error(`--${name} must be opaque in the ${theme} theme`);
  return c;
};
const tintPct = (theme: Theme) => Number(tokenValue(theme, 'tint').replace('%', '')) / 100;
/** The tinted background a Badge/alert paints: color-mix(fg tint%, transparent) over a surface. */
const tinted = (theme: Theme, fg: string, surface: string) =>
  over({ ...opaque(theme, fg), a: tintPct(theme) }, opaque(theme, surface));

// ── Token families ─────────────────────────────────────────────────────────

const SURFACES = ['bg-primary', 'bg-secondary', 'bg-card', 'bg-elevated', 'bg-tertiary', 'surface-input'];
const TEXT = ['text-primary', 'text-secondary', 'text-muted', 'accent'];
const BASE = ['success', 'warning', 'danger', 'info'];
const VERDICT = ['allow', 'log', 'block'];
const STATUS = ['status-online', 'status-pending', 'status-offline'];
const MODE = ['mode-block', 'mode-monitor'];
const SEVERITY = ['sev-critical', 'sev-high', 'sev-medium', 'sev-low', 'sev-info'];
const CATEGORICAL = ['cat-1', 'cat-2', 'cat-3', 'cat-4', 'cat-5', 'cat-6', 'cat-7'];
/** Script-editor syntax colours (codemirror-uddin.ts); keywords use --accent. */
const CODE = ['code-comment', 'code-builtin', 'code-context', 'code-string', 'code-number', 'code-operator', 'code-punctuation'];
/** Every colour a Badge (or inline status text) renders as text. */
const SEMANTIC_TEXT = [...BASE, ...VERDICT, ...STATUS, ...MODE, ...SEVERITY];
/** Surfaces a tinted badge/alert is placed on. */
const TINT_SURFACES = ['bg-primary', 'bg-card', 'bg-elevated', 'bg-tertiary'];
/** Chart and dot marks sit on page and card surfaces. */
const MARK_SURFACES = ['bg-primary', 'bg-card'];
const THEME_NAMES: Theme[] = ['dark', 'light'];

function ratioReport(theme: Theme, fgs: string[], bgs: string[], paint: (fg: string, bg: string) => [RGBA, RGBA], min: number) {
  const failures: string[] = [];
  for (const fg of fgs)
    for (const bg of bgs) {
      const [a, b] = paint(fg, bg);
      const r = contrast(a, b);
      if (r < min) failures.push(`${theme}: --${fg} on ${bg} = ${r.toFixed(2)}:1 (< ${min})`);
    }
  return failures;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('token integrity', () => {
  test('every family token exists and resolves to a colour in both themes', () => {
    const all = [...SURFACES, ...TEXT, ...SEMANTIC_TEXT, ...CATEGORICAL, ...CODE, 'bg-code', 'border-strong', 'ring-color', 'text-on-accent', 'accent-dim', 'danger-solid', 'danger-solid-hover', 'text-on-danger', 'chart-neutral'];
    for (const theme of THEME_NAMES) for (const name of all) expect(() => color(theme, name)).not.toThrow();
  });

  test('the light theme overrides every literal colour token of :root', () => {
    const literal = Object.entries(ROOT).filter(([, v]) => /^(#|rgba?\()/i.test(v)).map(([k]) => k);
    const missing = literal.filter((k) => !(k in LIGHT_ONLY));
    expect(missing).toEqual([]);
  });

  test('verdict aliases point at the base colours; other families never reuse a verdict alias', () => {
    expect(ROOT.allow).toBe('var(--success)');
    expect(ROOT.log).toBe('var(--warning)');
    expect(ROOT.block).toBe('var(--danger)');
    for (const name of [...STATUS, ...MODE, ...SEVERITY, ...CATEGORICAL])
      for (const theme of THEME_NAMES) expect(THEMES[theme][name]).not.toMatch(/var\(--(allow|log|block)\b/);
    // Verdict aliases are only defined once (in :root) so a theme cannot re-point them.
    for (const name of VERDICT) expect(LIGHT_ONLY[name]).toBeUndefined();
  });

  test('tints are derived with color-mix(), not hand-written rgba()', () => {
    for (const name of ['accent-soft', 'success-tint', 'warning-tint', 'danger-tint', 'info-tint']) {
      expect(ROOT[name]).toMatch(/^color-mix\(in srgb, var\(--[\w-]+\) var\(--tint\), transparent\)$/);
      expect(LIGHT_ONLY[name]).toBeUndefined();
    }
  });

  test('app.css carries no stale var() fallbacks', () => {
    expect(CSS.match(/var\(--[\w-]+\s*,/g) ?? []).toEqual([]);
  });
});

describe.each(THEME_NAMES)('%s theme contrast', (theme) => {
  test('text tokens ≥ 4.5:1 on every surface', () => {
    const fails = ratioReport(theme, TEXT, SURFACES, (fg, bg) => [opaque(theme, fg), opaque(theme, bg)], 4.5);
    expect(fails).toEqual([]);
  });

  test('semantic text (base, verdict, status, mode, severity) ≥ 4.5:1 on every surface', () => {
    const fails = ratioReport(theme, SEMANTIC_TEXT, SURFACES, (fg, bg) => [opaque(theme, fg), opaque(theme, bg)], 4.5);
    expect(fails).toEqual([]);
  });

  test('semantic text ≥ 4.5:1 on its own tint (Badge, inline alerts)', () => {
    const fails = ratioReport(theme, SEMANTIC_TEXT, TINT_SURFACES, (fg, bg) => [opaque(theme, fg), tinted(theme, fg, bg)], 4.5);
    expect(fails).toEqual([]);
  });

  test('categorical Badge: label text ≥ 4.5:1 on the categorical tint, dot mark ≥ 3:1', () => {
    const text = ratioReport(theme, CATEGORICAL, TINT_SURFACES, (fg, bg) => [opaque(theme, 'text-primary'), tinted(theme, fg, bg)], 4.5);
    const marks = ratioReport(theme, CATEGORICAL, MARK_SURFACES, (fg, bg) => [opaque(theme, fg), opaque(theme, bg)], 3);
    expect([...text, ...marks]).toEqual([]);
  });

  test('script-editor syntax colours ≥ 4.5:1 on --bg-code and on the active line', () => {
    const code = opaque(theme, 'bg-code');
    const activeLine = over(color(theme, 'bg-hover'), code);
    const fails = [
      ...ratioReport(theme, [...CODE, 'accent', 'text-primary'], ['bg-code'], (fg) => [opaque(theme, fg), code], 4.5),
      ...ratioReport(theme, [...CODE, 'accent', 'text-primary'], ['active line'], (fg) => [opaque(theme, fg), activeLine], 4.5),
    ];
    expect(fails).toEqual([]);
  });

  test('neutral Badge text ≥ 4.5:1 on --bg-tertiary', () => {
    expect(contrast(opaque(theme, 'text-secondary'), opaque(theme, 'bg-tertiary'))).toBeGreaterThanOrEqual(4.5);
  });

  test('solid fills carry their text at ≥ 4.5:1 (primary, danger, success, warning; incl. hover)', () => {
    const pairs: [string, string][] = [
      ['text-on-accent', 'accent'],
      ['text-on-accent', 'accent-dim'],
      ['text-on-danger', 'danger-solid'],
      ['text-on-danger', 'danger-solid-hover'],
      ['text-on-success', 'success'],
      ['text-on-warning', 'warning']
    ];
    const fails = pairs
      .map(([fg, bg]) => [fg, bg, contrast(opaque(theme, fg), opaque(theme, bg))] as const)
      .filter(([, , r]) => r < 4.5)
      .map(([fg, bg, r]) => `${fg} on ${bg} = ${r.toFixed(2)}`);
    expect(fails).toEqual([]);
  });

  test('focus ring ≥ 3:1 against card, page and elevated surfaces', () => {
    expect(THEMES[theme].ring).toContain('var(--ring-color)');
    expect(parseFloat(tokenValue(theme, 'ring-width'))).toBeGreaterThanOrEqual(2);
    const fails = ratioReport(theme, ['ring-color'], ['bg-card', 'bg-primary', 'bg-elevated', 'surface-input'], (fg, bg) => [opaque(theme, fg), opaque(theme, bg)], 3);
    expect(fails).toEqual([]);
  });

  test('control boundaries (--border-strong) ≥ 3:1 against the surfaces controls sit on', () => {
    const fails = ratioReport(theme, ['border-strong'], ['bg-card', 'bg-primary', 'bg-elevated', 'surface-input', 'bg-tertiary'], (fg, bg) => [opaque(theme, fg), opaque(theme, bg)], 3);
    expect(fails).toEqual([]);
  });

  test('chart marks (--chart-neutral, status and severity dots) ≥ 3:1 on chart surfaces', () => {
    const fails = ratioReport(theme, ['chart-neutral', ...STATUS, ...SEVERITY], MARK_SURFACES, (fg, bg) => [opaque(theme, fg), opaque(theme, bg)], 3);
    expect(fails).toEqual([]);
  });
});

// Distinctness is measured as OKLab ΔE×100. 15 is the
// normal-vision floor for colours that must be told apart without reading the
// label (verdicts, statuses, chart series). Severity is always rendered with its
// text; at text contrast the three warm levels cannot all reach 15 in the
// light theme, so adjacent severity levels need ≥ 10 and high vs
// medium must additionally sit in different hue families (≥ 30° OKLCH hue).
describe.each(THEME_NAMES)('%s theme distinctness (OKLab ΔE×100)', (theme) => {
  const d = (a: string, b: string) => deltaE(opaque(theme, a), opaque(theme, b));
  const hueGap = (a: string, b: string) => {
    const g = Math.abs(hueDeg(opaque(theme, a)) - hueDeg(opaque(theme, b)));
    return Math.min(g, 360 - g);
  };
  const tooClose = (pairs: [string, string][], min: number) =>
    pairs
      .map(([a, b]) => [a, b, d(a, b)] as const)
      .filter(([, , v]) => v < min)
      .map(([a, b, v]) => `${theme}: ${a}↔${b} ΔE ${v.toFixed(1)} < ${min}`);
  const adjacent = (list: string[]) => list.slice(1).map((x, i) => [list[i], x] as [string, string]);

  test('WAF verdicts ALLOW / LOG / BLOCK are pairwise ≥ 15 apart', () => {
    expect(tooClose([['allow', 'log'], ['log', 'block'], ['allow', 'block']], 15)).toEqual([]);
  });

  test('adjacent severity levels ≥ 10 apart; high and medium in different hue families', () => {
    expect(tooClose([...adjacent(SEVERITY), ['sev-critical', 'sev-medium']], 10)).toEqual([]);
    expect(hueGap('sev-high', 'sev-medium')).toBeGreaterThanOrEqual(30);
  });

  test('severity low is never the ALLOW green', () => {
    expect(tooClose([['sev-low', 'allow'], ['sev-low', 'success']], 15)).toEqual([]);
    const h = hueDeg(opaque(theme, 'sev-low'));
    // OKLCH green band ≈ 110°–170°; low must sit outside it.
    expect(h < 110 || h > 170).toBe(true);
  });

  test('Block mode never looks like ALLOW; Monitor mode differs from Block mode', () => {
    expect(tooClose([['mode-block', 'allow'], ['mode-block', 'mode-monitor']], 15)).toEqual([]);
  });

  test('status online / pending / offline are pairwise ≥ 15 apart', () => {
    const pairs: [string, string][] = [['status-online', 'status-pending'], ['status-pending', 'status-offline'], ['status-online', 'status-offline']];
    expect(tooClose(pairs, 15)).toEqual([]);
  });

  test('adjacent categorical slots are ≥ 15 apart', () => {
    expect(tooClose(adjacent(CATEGORICAL), 15)).toEqual([]);
  });
});

