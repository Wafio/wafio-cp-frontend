import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BADGE_TONES,
  SEVERITIES,
  actionTone,
  agentKindTone,
  categoricalColor,
  categoricalTone,
  enforcementTone,
  modeTone,
  normalizeSeverity,
  protocolTone,
  severityColor,
  severityRank,
  severityTone,
  statusTone
} from '../src/lib/tone';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('severityTone', () => {
  test('maps every level to its own severity tone', () => {
    expect(SEVERITIES.map(severityTone)).toEqual(['sev-critical', 'sev-high', 'sev-medium', 'sev-low', 'sev-info']);
  });

  test('high and medium never share a tone; low is never a verdict or success tone', () => {
    expect(severityTone('high')).not.toBe(severityTone('medium'));
    expect(['allow', 'success', 'log', 'block', 'info']).not.toContain(severityTone('low'));
  });

  test('is case- and whitespace-insensitive and accepts common aliases', () => {
    expect(severityTone(' CRITICAL ')).toBe('sev-critical');
    expect(severityTone('Moderate')).toBe('sev-medium');
    expect(severityTone('warning')).toBe('sev-medium');
    expect(severityTone('informational')).toBe('sev-info');
  });

  test('accepts the runtime numeric levels (0 info … 4 critical)', () => {
    expect([0, 1, 2, 3, 4].map(severityTone)).toEqual(['sev-info', 'sev-low', 'sev-medium', 'sev-high', 'sev-critical']);
    expect(severityTone(5)).toBe('neutral');
    expect(severityTone(1.5)).toBe('neutral');
  });

  test('unknown or missing severity is neutral, never a colour', () => {
    for (const v of ['', 'unknown', 'urgent', null, undefined, {}]) expect(severityTone(v)).toBe('neutral');
    expect(normalizeSeverity('bogus')).toBeNull();
  });

  test('severityColor and severityRank follow the same mapping', () => {
    expect(severityColor('high')).toBe('var(--sev-high)');
    expect(severityColor('low')).toBe('var(--sev-low)');
    expect(severityColor('nope')).toBe('var(--text-muted)');
    expect(SEVERITIES.map(severityRank)).toEqual([4, 3, 2, 1, 0]);
    expect(severityRank('nope')).toBe(-1);
  });
});

describe('actionTone (WAF and firewall decisions)', () => {
  test('maps WAF decision actions to verdict tones', () => {
    expect(actionTone('block')).toBe('block');
    expect(actionTone('allow')).toBe('allow');
    expect(actionTone('monitor')).toBe('log');
    expect(actionTone('log')).toBe('log');
    expect(actionTone('deny')).toBe('block');
    expect(actionTone('clean')).toBe('allow');
  });

  test('maps host-firewall actions', () => {
    expect(actionTone('drop')).toBe('block');
    expect(actionTone('ALLOW')).toBe('allow');
  });

  test('non-verdicts are neutral, never ALLOW (the old default)', () => {
    expect(actionTone('upstream_error')).toBe('neutral');
    expect(actionTone('')).toBe('neutral');
    expect(actionTone(undefined)).toBe('neutral');
    expect(actionTone('something-new')).toBe('neutral');
  });
});

describe('enforcementTone (runtime policy actions)', () => {
  test('kill/block enforce, alert logs, simulate is informational, monitor is neutral', () => {
    expect(enforcementTone('kill')).toBe('block');
    expect(enforcementTone('block')).toBe('block');
    expect(enforcementTone('alert')).toBe('log');
    expect(enforcementTone('simulate')).toBe('info');
    expect(enforcementTone('monitor')).toBe('neutral');
    expect(enforcementTone(undefined)).toBe('neutral');
  });
});

describe('statusTone', () => {
  test('maps agent/host statuses to status tones', () => {
    expect(statusTone('online')).toBe('status-online');
    expect(statusTone('pending')).toBe('status-pending');
    expect(statusTone('offline')).toBe('status-offline');
    expect(statusTone('Reconnecting')).toBe('status-pending');
  });

  test('accepts an is_online boolean', () => {
    expect(statusTone(true)).toBe('status-online');
    expect(statusTone(false)).toBe('status-offline');
  });

  test('revoked, unknown and missing are neutral', () => {
    for (const v of ['revoked', 'disabled', 'unknown', '', null, undefined]) expect(statusTone(v)).toBe('neutral');
  });

  test('never returns a verdict tone', () => {
    for (const v of ['online', 'pending', 'offline', true, false])
      expect(['allow', 'log', 'block']).not.toContain(statusTone(v));
  });
});

describe('modeTone', () => {
  test('Block mode has its own tone and is never the ALLOW (or BLOCK verdict) tone', () => {
    expect(modeTone('block')).toBe('mode-block');
    expect(modeTone('block')).not.toBe('allow');
    expect(modeTone('block')).not.toBe('block');
  });

  test('Monitor mode differs from Block mode', () => {
    expect(modeTone('monitor')).toBe('mode-monitor');
    expect(modeTone('monitor')).not.toBe(modeTone('block'));
  });

  test('host firewall enforce reads as block mode; unknown is neutral', () => {
    expect(modeTone('enforce')).toBe('mode-block');
    expect(modeTone('Monitor')).toBe('mode-monitor');
    expect(modeTone('')).toBe('neutral');
    expect(modeTone(undefined)).toBe('neutral');
  });
});

describe('categorical tones', () => {
  test('slots are assigned in fixed order and never cycle', () => {
    expect([0, 1, 6].map(categoricalTone)).toEqual(['cat1', 'cat2', 'cat7']);
    expect(categoricalTone(7)).toBe('neutral');
    expect(categoricalTone(-1)).toBe('neutral');
    expect(categoricalColor(0)).toBe('var(--cat-1)');
    expect(categoricalColor(9)).toBe('var(--chart-neutral)');
  });

  test('fixed vocabularies keep one colour per value and never use verdict tones', () => {
    expect(protocolTone('TCP')).toBe('cat1');
    expect(protocolTone('udp')).toBe('cat2');
    expect(agentKindTone('host')).toBe('cat1');
    expect(agentKindTone('waf')).toBe('cat2');
    expect(protocolTone('sctp')).toBe('neutral');
  });
});

describe('Badge and app.css cover every tone', () => {
  const badge = read('../src/lib/components/ui/Badge.svelte');
  const css = read('../src/app.css');

  test('Badge.svelte defines a .tone-<name> rule for every BADGE_TONES entry', () => {
    const missing = BADGE_TONES.filter((t) => !new RegExp(`\\.tone-${t}\\b`).test(badge));
    expect(missing).toEqual([]);
  });

  test('Badge derives tints with color-mix(), not hand-written rgba()', () => {
    expect(badge).toContain('color-mix(in srgb, var(--tone) var(--tint), transparent)');
    expect(badge).not.toMatch(/rgba?\(/);
    expect(badge).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  test('every token a Badge tone references is defined in app.css', () => {
    const referenced = [...badge.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]);
    const undefinedTokens = [...new Set(referenced)].filter((name) => name !== 'tone' && !new RegExp(`--${name}\\s*:`).test(css));
    expect(undefinedTokens).toEqual([]);
  });
});

describe('StatusDot uses defined tokens', () => {
  const statusDot = read('../src/lib/components/ui/StatusDot.svelte');
  const css = read('../src/app.css');

  test('every token StatusDot references is defined in app.css', () => {
    const referenced = [...statusDot.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]);
    const undefinedTokens = [...new Set(referenced)].filter((name) => name !== 'status-color' && !new RegExp(`--${name}\\s*:`).test(css));
    expect(undefinedTokens).toEqual([]);
  });
});
