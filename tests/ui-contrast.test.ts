// Contrast of the text/background pairs the UI primitives rely on, computed
// from the tokens in app.css for both themes (danger button text).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8');

function block(selector: RegExp): Record<string, string> {
  const match = css.match(selector);
  if (!match) throw new Error(`token block not found: ${selector}`);
  const tokens: Record<string, string> = {};
  for (const decl of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[decl[1]] = decl[2].trim();
  return tokens;
}

const dark = block(/:root\s*\{([\s\S]*?)\n\}/);
const light = { ...dark, ...block(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/) };

type RGB = [number, number, number];

function resolve(tokens: Record<string, string>, value: string, depth = 0): string {
  if (depth > 10) throw new Error(`var() cycle: ${value}`);
  const ref = value.match(/^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (!ref) return value;
  const next = tokens[ref[1]] ?? ref[2];
  if (next === undefined) throw new Error(`undefined token ${ref[1]}`);
  return resolve(tokens, next.trim(), depth + 1);
}

function hex(value: string): RGB {
  const m = value.match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`expected #rrggbb, got ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function color(tokens: Record<string, string>, expr: string): RGB {
  return hex(resolve(tokens, expr));
}

/** color-mix(in srgb, a p%, b) */
function mix(a: RGB, b: RGB, p: number): RGB {
  return a.map((c, i) => Math.round(c * p + b[i] * (1 - p))) as RGB;
}

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Button.svelte .btn-danger: var(--text-on-danger) on var(--danger-solid),
// hover var(--danger-solid-hover).
describe.each([
  ['dark', dark],
  ['light', light]
] as const)('%s theme', (_name, tokens) => {
  test('danger button text >= 4.5:1, at rest and on hover', () => {
    const fg = color(tokens, 'var(--text-on-danger)');
    expect(contrast(fg, color(tokens, 'var(--danger-solid)'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg, color(tokens, 'var(--danger-solid-hover)'))).toBeGreaterThanOrEqual(4.5);
  });

  test('primary button text >= 4.5:1', () => {
    expect(contrast(color(tokens, 'var(--text-on-accent)'), color(tokens, 'var(--accent)'))).toBeGreaterThanOrEqual(4.5);
  });

  test('body text on alert and warning-button tints >= 4.5:1', () => {
    const card = color(tokens, 'var(--bg-card)');
    for (const tone of ['--danger', '--warning', '--info', '--success']) {
      const tint = mix(color(tokens, `var(${tone})`), card, 0.07);
      expect(contrast(color(tokens, 'var(--text-primary)'), tint)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(tokens, 'var(--text-secondary)'), tint)).toBeGreaterThanOrEqual(4.5);
    }
    const warningFill = mix(color(tokens, 'var(--warning)'), card, 0.24);
    expect(contrast(color(tokens, 'var(--text-primary)'), warningFill)).toBeGreaterThanOrEqual(4.5);
  });

  test('secondary and muted text on cards >= 4.5:1', () => {
    const card = color(tokens, 'var(--bg-card)');
    expect(contrast(color(tokens, 'var(--text-secondary)'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color(tokens, 'var(--text-muted)'), card)).toBeGreaterThanOrEqual(4.5);
  });
});

// Switch.svelte and the segmented choice of an engine (SegmentedRadio.svelte): the track, the thumb, the state
// words, the chosen segment and its ring, in both themes.
describe.each([
  ['dark', dark],
  ['light', light]
] as const)('%s theme: switch and segmented choice', (_name, tokens) => {
  const c = (token: string) => color(tokens, `var(${token})`);

  test('the switch edge, its thumb and its state words pass', () => {
    const card = c('--bg-card');
    expect(contrast(c('--border-strong'), card)).toBeGreaterThanOrEqual(3);
    expect(contrast(c('--text-secondary'), c('--bg-tertiary'))).toBeGreaterThanOrEqual(3);
    expect(contrast(c('--accent'), card)).toBeGreaterThanOrEqual(3);
    expect(contrast(c('--text-on-accent'), c('--accent'))).toBeGreaterThanOrEqual(3);
    expect(contrast(c('--text-secondary'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c('--text-muted'), card)).toBeGreaterThanOrEqual(4.5);
  });

  test('a segment passes unchosen and chosen, and the chosen ring and the edge stand out from the card', () => {
    const input = c('--surface-input');
    expect(contrast(c('--text-secondary'), input)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c('--text-primary'), mix(c('--accent'), input, 0.12))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c('--accent'), c('--bg-card'))).toBeGreaterThanOrEqual(3);
    expect(contrast(c('--border-strong'), c('--bg-card'))).toBeGreaterThanOrEqual(3);
  });

  test('the warning line under an engine that is off passes on the card', () => {
    expect(contrast(c('--warning'), c('--bg-card'))).toBeGreaterThanOrEqual(4.5);
  });

  test('the wordmark passes on the header', () => {
    expect(contrast(c('--text-primary'), c('--bg-secondary'))).toBeGreaterThanOrEqual(4.5);
  });
});
