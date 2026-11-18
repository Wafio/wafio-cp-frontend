import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import type { Maintenance } from '../src/lib/api';
import {
  MAINTENANCE_LIMITS,
  endPassed,
  enableConfirmMessage,
  formatKiB,
  formFromMaintenance,
  fromLocalInput,
  isMaintenanceField,
  isoSeconds,
  localInputBounds,
  maintenanceBody,
  maintenanceFromForm,
  maintenanceNotices,
  normalizeMaintenanceState,
  parseEndTime,
  parseLines,
  previewDocument,
  sameSettings,
  savedMessage,
  stripFieldPrefix,
  switchDisabled,
  toLocalInput,
  utf8Bytes,
  validateMaintenance,
} from '../src/lib/components/apps/maintenance';

// The control plane's page and limits.
const backend = JSON.parse(readFileSync(new URL('./fixtures/backend/maintenance.json', import.meta.url), 'utf8')) as {
  default_message: string;
  stock_html: string;
  limits: Record<string, number>;
};

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const IN_ONE_DAY = '2026-11-19T12:00:00Z';
const HOUR_AGO = '2026-11-18T11:00:00Z';

function off(over: Partial<Maintenance> = {}): Maintenance {
  return { enabled: false, message: '', end_time: '', custom_html: '', allow_ips: [], allow_paths: [], started_at: '', ...over };
}

function on(over: Partial<Maintenance> = {}): Maintenance {
  return off({ enabled: true, started_at: '2026-11-18T10:00:00Z', ...over });
}

describe('control plane parity', () => {
  test('the limits are the ones of the fixture', () => {
    expect(backend.limits).toEqual({
      message_chars: MAINTENANCE_LIMITS.messageChars,
      custom_html_bytes: MAINTENANCE_LIMITS.customHtmlBytes,
      allow_ips: MAINTENANCE_LIMITS.allowIps,
      allow_paths: MAINTENANCE_LIMITS.allowPaths,
      path_bytes: MAINTENANCE_LIMITS.pathBytes,
      end_time_max_days: MAINTENANCE_LIMITS.endTimeMaxDays,
    });
  });

  test('the standard page has both placeholders and the default message is set', () => {
    expect(backend.stock_html).toContain('{{WAFIO_MESSAGE}}');
    expect(backend.stock_html).toContain('{{WAFIO_END_TIME}}');
    expect(backend.default_message.length).toBeGreaterThan(0);
  });

  test('the standard page fits the custom page limit', () => {
    expect(utf8Bytes(backend.stock_html)).toBeLessThan(MAINTENANCE_LIMITS.customHtmlBytes);
  });
});

describe('lines and sizes', () => {
  test('parseLines trims, drops empty lines and repeats, keeps the order', () => {
    expect(parseLines('  /a \n\n/b\n/a\r\n   \n/c')).toEqual(['/a', '/b', '/c']);
    expect(parseLines('')).toEqual([]);
    expect(parseLines('\n\n')).toEqual([]);
  });

  test('utf8Bytes counts bytes, not characters', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('日本')).toBe(6);
    expect(utf8Bytes('😀')).toBe(4);
    expect(utf8Bytes('')).toBe(0);
  });

  test('formatKiB shows one decimal at most', () => {
    expect(formatKiB(0)).toBe('0');
    expect(formatKiB(1024)).toBe('1');
    expect(formatKiB(12_700)).toBe('12.4');
    expect(formatKiB(65536)).toBe('64');
  });

  test('field names', () => {
    expect(isMaintenanceField('end_time')).toBe(true);
    expect(isMaintenanceField('enabled')).toBe(false);
    expect(isMaintenanceField(undefined)).toBe(false);
  });
});

describe('times', () => {
  test('parseEndTime reads RFC 3339 and refuses what is not a real time', () => {
    expect(parseEndTime('2026-11-18T22:00:00Z')).toBe(Date.UTC(2026, 10, 18, 22, 0, 0));
    expect(parseEndTime('2026-11-18T22:00:00+07:00')).toBe(Date.UTC(2026, 10, 18, 15, 0, 0));
    expect(parseEndTime('2026-11-18T22:00:00.750Z')).toBe(Date.UTC(2026, 10, 18, 22, 0, 0, 750));
    expect(parseEndTime(' 2026-11-18T22:00:00Z ')).toBe(Date.UTC(2026, 10, 18, 22, 0, 0));
    for (const bad of ['', 'tomorrow', '2026-11-18', '2026-11-18 22:00:00Z', '2026-02-30T10:00:00Z', '2026-11-18T24:00:00Z', '2026-11-18T10:61:00Z', '2026-13-01T10:00:00Z']) {
      expect(parseEndTime(bad)).toBeNull();
    }
  });

  test('isoSeconds gives whole seconds in UTC', () => {
    expect(isoSeconds(Date.UTC(2026, 10, 18, 22, 0, 0, 999))).toBe('2026-11-18T22:00:00Z');
  });

  test('endPassed is true only for a readable time that is not after now', () => {
    expect(endPassed(HOUR_AGO, NOW)).toBe(true);
    expect(endPassed('2026-11-18T12:00:00Z', NOW)).toBe(true);
    expect(endPassed(IN_ONE_DAY, NOW)).toBe(false);
    expect(endPassed('', NOW)).toBe(false);
    expect(endPassed('soon', NOW)).toBe(false);
  });

  test('a time survives the trip through the datetime-local input in any time zone', () => {
    for (const iso of ['2026-11-18T22:00:00Z', '2026-03-29T01:30:00Z', '2026-12-31T23:59:00Z', '2026-11-18T22:00:45Z']) {
      const local = toLocalInput(iso);
      expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);
      expect(fromLocalInput(local)).toBe(iso);
    }
  });

  test('the input value is the local wall clock of the instant', () => {
    const iso = '2026-11-18T22:00:00Z';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(toLocalInput(iso)).toBe(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  });

  test('seconds are shown only when the stored time has them', () => {
    expect(toLocalInput('2026-11-18T22:00:00Z')).toHaveLength(16);
    expect(toLocalInput('2026-11-18T22:00:30Z')).toHaveLength(19);
  });

  test('an empty or impossible value gives nothing', () => {
    expect(toLocalInput('')).toBe('');
    expect(toLocalInput('later')).toBe('');
    expect(fromLocalInput('')).toBe('');
    expect(fromLocalInput('2026-11-18')).toBe('');
    expect(fromLocalInput('2026-02-30T10:00')).toBe('');
    expect(fromLocalInput('2026-11-18T25:00')).toBe('');
  });

  test('a time the clock skips at a daylight saving change is kept, not cleared', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
      // 2026-03-08 02:30 does not exist in New York: the clock goes from 02:00 EST to 03:00 EDT.
      expect(['2026-03-08T07:30:00Z', '2026-03-08T06:30:00Z']).toContain(fromLocalInput('2026-03-08T02:30'));
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  test('the end time input accepts from this minute to 365 days on', () => {
    const { min, max } = localInputBounds(NOW + 30_000);
    expect(fromLocalInput(min)).toBe('2026-11-18T12:00:00Z');
    expect(fromLocalInput(max)).toBe('2027-11-18T12:00:00Z');
  });
});

describe('checks', () => {
  test('a valid form has no error', () => {
    const draft = on({ message: 'Back soon', end_time: IN_ONE_DAY, custom_html: '<p>{{WAFIO_MESSAGE}}</p>', allow_ips: ['203.0.113.7', '10.0.0.0/8', '2001:db8::/32'], allow_paths: ['/healthz', '/api/payments/webhook'] });
    expect(validateMaintenance(draft, off(), NOW)).toEqual({});
    expect(validateMaintenance(off(), off(), NOW)).toEqual({});
  });

  test('message: length in characters, control characters, a newline is fine', () => {
    expect(validateMaintenance(off({ message: 'é'.repeat(500) }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ message: 'é'.repeat(501) }), off(), NOW).message).toBe('must be at most 500 characters');
    expect(validateMaintenance(off({ message: '😀'.repeat(500) }), off(), NOW)).toEqual({});
    // The server trims first.
    expect(validateMaintenance(off({ message: `  ${'a'.repeat(500)}  ` }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ message: 'two\nlines' }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ message: 'bell\u0007' }), off(), NOW).message).toBe('must not contain control characters');
    expect(validateMaintenance(off({ message: 'nul\u0000' }), off(), NOW).message).toBe('must not contain control characters');
    expect(validateMaintenance(off({ message: 'c1\u0085x' }), off(), NOW).message).toBe('must not contain control characters');
    expect(validateMaintenance(off({ message: 'tab\there' }), off(), NOW).message).toBe('must not contain control characters');
  });

  test('end time: shape, the future, 365 days', () => {
    expect(validateMaintenance(off({ end_time: 'tomorrow' }), off(), NOW).end_time).toBe('must be a date and time like 2026-11-18T22:00:00Z');
    expect(validateMaintenance(off({ end_time: '2026-02-30T10:00:00Z' }), off(), NOW).end_time).toBe('must be a date and time like 2026-11-18T22:00:00Z');
    expect(validateMaintenance(off({ end_time: HOUR_AGO }), off(), NOW).end_time).toBe('must be in the future');
    expect(validateMaintenance(off({ end_time: '2026-11-18T12:00:00Z' }), off(), NOW).end_time).toBe('must be in the future');
    expect(validateMaintenance(off({ end_time: '2026-11-18T12:00:01Z' }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ end_time: '2027-11-18T12:00:00Z' }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ end_time: '2027-11-18T12:00:01Z' }), off(), NOW).end_time).toBe('must be within 365 days');
  });

  test('end time: a time that passed is refused only when it changed or the switch goes on', () => {
    // Unchanged while on, or while it stays off: no complaint (the dashboard only warns).
    expect(validateMaintenance(on({ end_time: HOUR_AGO }), on({ end_time: HOUR_AGO }), NOW)).toEqual({});
    expect(validateMaintenance(off({ end_time: HOUR_AGO }), off({ end_time: HOUR_AGO }), NOW)).toEqual({});
    // Turning on with it, or changing it to another time in the past, is refused.
    expect(validateMaintenance(on({ end_time: HOUR_AGO }), off({ end_time: HOUR_AGO }), NOW).end_time).toBe('must be in the future');
    expect(validateMaintenance(on({ end_time: '2026-11-18T10:00:00Z' }), on({ end_time: HOUR_AGO }), NOW).end_time).toBe('must be in the future');
    // The same instant written with an offset counts as unchanged.
    expect(validateMaintenance(on({ end_time: '2026-11-18T18:00:00+07:00' }), on({ end_time: HOUR_AGO }), NOW)).toEqual({});
    // Too far away is refused even when unchanged.
    expect(validateMaintenance(on({ end_time: '2028-01-01T00:00:00Z' }), on({ end_time: '2028-01-01T00:00:00Z' }), NOW).end_time).toBe('must be within 365 days');
  });

  test('custom page: 64 KiB in bytes, no NUL, whitespace counts as empty', () => {
    expect(validateMaintenance(off({ custom_html: 'a'.repeat(65536) }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ custom_html: 'a'.repeat(65537) }), off(), NOW).custom_html).toBe('must be at most 64 KiB (65,536 bytes)');
    // 32,769 two-byte characters are under the character count and over the byte count.
    expect(validateMaintenance(off({ custom_html: 'é'.repeat(32769) }), off(), NOW).custom_html).toBe('must be at most 64 KiB (65,536 bytes)');
    expect(validateMaintenance(off({ custom_html: ' '.repeat(70000) }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ custom_html: '<p>a\u0000b</p>' }), off(), NOW).custom_html).toBe('must not contain NUL characters');
  });

  test('allowed IP addresses: the count, the form, a range that lets everyone through', () => {
    const many = Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`);
    expect(validateMaintenance(off({ allow_ips: many.slice(0, 50) }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ allow_ips: many }), off(), NOW).allow_ips).toBe('at most 50 entries');
    // Repeats count once, as on the server.
    expect(validateMaintenance(off({ allow_ips: [...many.slice(0, 50), ' 10.0.0.1 '] }), off(), NOW)).toEqual({});
    for (const ok of ['1.2.3.4', '::1', '2001:db8::1', '::ffff:1.2.3.4', '10.0.0.0/8', '10.1.2.3/8', '2001:db8::/32', '0.0.0.0/1', '1.2.3.4/32']) {
      expect(validateMaintenance(off({ allow_ips: [ok] }), off(), NOW)).toEqual({});
    }
    for (const bad of ['host.example.com', '1.2.3', '256.1.1.1', '01.2.3.4', '10.0.0.0/33', '10.0.0.0/08', '10.0.0.0/', '/8', 'fe80::1%eth0', '1::2::3', '1.2.3.4/8/8']) {
      expect(validateMaintenance(off({ allow_ips: [bad] }), off(), NOW).allow_ips).toBe(`"${bad}" is not an IP address or CIDR range`);
    }
    expect(validateMaintenance(off({ allow_ips: ['0.0.0.0/0'] }), off(), NOW).allow_ips).toBe('"0.0.0.0/0" lets every visitor through; remove it or turn maintenance mode off');
    expect(validateMaintenance(off({ allow_ips: ['::/0'] }), off(), NOW).allow_ips).toBe('"::/0" lets every visitor through; remove it or turn maintenance mode off');
  });

  test('allowed IP addresses: the first entry that is wrong is named, quoted and cut to 64 bytes', () => {
    expect(validateMaintenance(off({ allow_ips: ['1.2.3.4', 'a"b\\c', 'x'] }), off(), NOW).allow_ips).toBe('"a\\"b\\\\c" is not an IP address or CIDR range');
    const long = 'z'.repeat(100);
    expect(validateMaintenance(off({ allow_ips: [long] }), off(), NOW).allow_ips).toBe(`"${'z'.repeat(64)}" is not an IP address or CIDR range`);
    // Cut at a character boundary: 40 two-byte characters are 80 bytes, 32 fit.
    expect(validateMaintenance(off({ allow_ips: ['é'.repeat(40)] }), off(), NOW).allow_ips).toBe(`"${'é'.repeat(32)}" is not an IP address or CIDR range`);
    expect(validateMaintenance(off({ allow_ips: ['a\tb'] }), off(), NOW).allow_ips).toBe('"a\\tb" is not an IP address or CIDR range');
  });

  test('allowed paths: each rule of the server', () => {
    const many = Array.from({ length: 21 }, (_, i) => `/p${i}`);
    expect(validateMaintenance(off({ allow_paths: many.slice(0, 20) }), off(), NOW)).toEqual({});
    expect(validateMaintenance(off({ allow_paths: many }), off(), NOW).allow_paths).toBe('at most 20 entries');
    for (const ok of ['/healthz', '/api/payments/webhook', '/static/', '/a/b.c/d', '/.well-known/acme', '/ä']) {
      expect(validateMaintenance(off({ allow_paths: [ok] }), off(), NOW)).toEqual({});
    }
    expect(validateMaintenance(off({ allow_paths: ['healthz'] }), off(), NOW).allow_paths).toBe('"healthz" must start with /');
    expect(validateMaintenance(off({ allow_paths: ['/' + 'a'.repeat(256)] }), off(), NOW).allow_paths).toBe(`"${'/' + 'a'.repeat(63)}" must be at most 256 characters`);
    expect(validateMaintenance(off({ allow_paths: ['/' + 'a'.repeat(255)] }), off(), NOW)).toEqual({});
    // The limit is in bytes: 129 two-byte characters plus the slash are 259 bytes.
    expect(validateMaintenance(off({ allow_paths: ['/' + 'é'.repeat(129)] }), off(), NOW).allow_paths).toContain('must be at most 256 characters');
    for (const bad of ['/a b', '/a?b=1', '/a#top', '/a%2Fb', '/a\u0001b', '/a b', '/a　b']) {
      expect(validateMaintenance(off({ allow_paths: [bad] }), off(), NOW).allow_paths).toMatch(/ must not contain spaces, \?, #, % or control characters$/);
    }
    for (const bad of ['/a/./b', '/a/../b', '/..', '/.', '/a/..']) {
      expect(validateMaintenance(off({ allow_paths: [bad] }), off(), NOW).allow_paths).toMatch(/ must not contain \. or \.\. segments$/);
    }
  });

  test('allowed paths: "/" would let every request through', () => {
    expect(validateMaintenance(off({ allow_paths: ['/'] }), off(), NOW).allow_paths).toBe('"/" lets every visitor through; remove it or turn maintenance mode off');
    expect(validateMaintenance(off({ allow_paths: ['/healthz', '/'] }), off(), NOW).allow_paths).toContain('"/"');
  });

  test('every field is reported, a field once', () => {
    const errors = validateMaintenance(on({ message: 'a'.repeat(501), end_time: 'x', custom_html: 'a\u0000', allow_ips: ['nope'], allow_paths: ['nope'] }), off(), NOW);
    expect(Object.keys(errors).sort()).toEqual(['allow_ips', 'allow_paths', 'custom_html', 'end_time', 'message']);
  });

  test('the server text is shown without its field prefix', () => {
    expect(stripFieldPrefix('end_time: must be in the future', 'end_time')).toBe('must be in the future');
    expect(stripFieldPrefix('allow_ips: "x" is not an IP address or CIDR range', 'allow_ips')).toBe('"x" is not an IP address or CIDR range');
    expect(stripFieldPrefix('must be in the future', 'end_time')).toBe('must be in the future');
    expect(stripFieldPrefix('message: end_time: x', 'end_time')).toBe('message: end_time: x');
  });
});

describe('form model', () => {
  const stored = on({
    message: 'Upgrading the database',
    end_time: '2026-11-18T22:00:00Z',
    custom_html: '<h1>{{WAFIO_MESSAGE}}</h1>',
    allow_ips: ['203.0.113.7', '10.0.0.0/8'],
    allow_paths: ['/healthz'],
  });

  test('a stored page with its own HTML opens as Custom HTML, the lists as lines', () => {
    const form = formFromMaintenance(stored);
    expect(form.page).toBe('custom');
    expect(form.ips).toBe('203.0.113.7\n10.0.0.0/8');
    expect(form.paths).toBe('/healthz');
    expect(form.message).toBe('Upgrading the database');
    expect(formFromMaintenance(off()).page).toBe('standard');
    expect(formFromMaintenance(off({ custom_html: '  \n' })).page).toBe('standard');
  });

  test('the form gives back the stored settings: nothing to save', () => {
    const form = formFromMaintenance(stored);
    const back = maintenanceFromForm(form, true, stored.started_at);
    expect(back).toEqual({ ...stored, end_time: fromLocalInput(form.endLocal) });
    expect(back.end_time).toBe(stored.end_time);
    expect(sameSettings(back, stored)).toBe(true);
  });

  test('the standard page sends no HTML, and the text stays in the form', () => {
    const form = { ...formFromMaintenance(stored), page: 'standard' as const };
    expect(maintenanceFromForm(form, true).custom_html).toBe('');
    expect(form.customHtml).toBe('<h1>{{WAFIO_MESSAGE}}</h1>');
    expect(sameSettings(maintenanceFromForm(form, true), stored)).toBe(false);
  });

  test('an empty Custom HTML editor is the standard page', () => {
    const form = { ...formFromMaintenance(off()), page: 'custom' as const, customHtml: '   ' };
    expect(maintenanceFromForm(form, false).custom_html).toBe('');
    expect(sameSettings(maintenanceFromForm(form, false), off())).toBe(true);
  });

  test('values are trimmed and the lists are read line by line', () => {
    const form = { ...formFromMaintenance(off()), message: '  hello  ', ips: ' 1.2.3.4 \n\n1.2.3.4\n5.6.7.8', paths: '/a\n/a\n/b ' };
    const m = maintenanceFromForm(form, false);
    expect(m.message).toBe('hello');
    expect(m.allow_ips).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(m.allow_paths).toEqual(['/a', '/b']);
  });

  test('the switch and started_at are not settings', () => {
    expect(sameSettings(stored, { ...stored, enabled: false, started_at: '' })).toBe(true);
    expect(sameSettings(stored, { ...stored, message: 'other' })).toBe(false);
    expect(sameSettings(stored, { ...stored, allow_paths: ['/healthz', '/x'] })).toBe(false);
    expect(sameSettings(off({ message: ' x ' }), off({ message: 'x' }))).toBe(true);
  });

  test('the request body has no started_at', () => {
    expect(maintenanceBody(stored)).toEqual({
      enabled: true,
      message: stored.message,
      end_time: stored.end_time,
      custom_html: stored.custom_html,
      allow_ips: stored.allow_ips,
      allow_paths: stored.allow_paths,
    });
    expect('started_at' in maintenanceBody(stored)).toBe(false);
  });

  test('an answer with fields missing is filled in', () => {
    const state = normalizeMaintenanceState({ maintenance: { enabled: true, message: 'x' } as Maintenance });
    expect(state.maintenance).toEqual({ enabled: true, message: 'x', end_time: '', custom_html: '', allow_ips: [], allow_paths: [], started_at: '' });
    expect(state.agent_supported).toBeNull();
    expect(state.client_ip).toBe('');
    expect(normalizeMaintenanceState(null).maintenance.enabled).toBe(false);
    expect(normalizeMaintenanceState({ agent_supported: false }).agent_supported).toBe(false);
    expect(normalizeMaintenanceState({ maintenance: { allow_ips: 'x', enabled: 'yes' } as never }).maintenance).toMatchObject({ enabled: false, allow_ips: [] });
  });
});

describe('notices and texts', () => {
  const base = { enabled: false, supported: true as boolean | null, online: true as boolean | undefined, canConfigure: true, endTime: '', now: NOW };

  test('nothing to say when all is well, or when the agent never reported', () => {
    expect(maintenanceNotices(base)).toEqual([]);
    expect(maintenanceNotices({ ...base, supported: null, online: undefined })).toEqual([]);
  });

  test('an agent that does not support it: a warning while off, a danger while on', () => {
    expect(maintenanceNotices({ ...base, supported: false })).toEqual(['unsupported-off']);
    expect(maintenanceNotices({ ...base, supported: false, enabled: true })).toEqual(['unsupported-on']);
  });

  test('offline agent, passed end time (only while on), read-only', () => {
    expect(maintenanceNotices({ ...base, online: false })).toEqual(['offline']);
    expect(maintenanceNotices({ ...base, enabled: true, endTime: HOUR_AGO })).toEqual(['end-passed']);
    expect(maintenanceNotices({ ...base, enabled: false, endTime: HOUR_AGO })).toEqual([]);
    expect(maintenanceNotices({ ...base, enabled: true, endTime: IN_ONE_DAY })).toEqual([]);
    expect(maintenanceNotices({ ...base, canConfigure: false })).toEqual(['readonly']);
  });

  test('notices come in the order of the page', () => {
    expect(maintenanceNotices({ enabled: true, supported: false, online: false, canConfigure: false, endTime: HOUR_AGO, now: NOW })).toEqual([
      'unsupported-on',
      'offline',
      'end-passed',
      'readonly',
    ]);
  });

  test('the switch: locked for viewers and while working, and it cannot go on for an agent without support', () => {
    const open = { canConfigure: true, busy: false, enabled: false, supported: true as boolean | null };
    expect(switchDisabled(open)).toBe(false);
    expect(switchDisabled({ ...open, supported: null })).toBe(false);
    expect(switchDisabled({ ...open, canConfigure: false })).toBe(true);
    expect(switchDisabled({ ...open, busy: true })).toBe(true);
    expect(switchDisabled({ ...open, supported: false })).toBe(true);
    // It can always be turned off.
    expect(switchDisabled({ ...open, supported: false, enabled: true })).toBe(false);
  });

  test('the confirmation says who is locked out and what is saved with it', () => {
    const plain = enableConfirmMessage({ noAllowedIps: false, unsaved: false });
    expect(plain).toBe('Visitors will see the maintenance page instead of the site within a few seconds, with HTTP status 503. Requests from allowed IP addresses and paths still reach the site.');
    expect(enableConfirmMessage({ noAllowedIps: true, unsaved: false })).toBe(`${plain} No IP addresses are allowed, so your team cannot open the site either.`);
    expect(enableConfirmMessage({ noAllowedIps: false, unsaved: true })).toBe(`${plain} Your unsaved changes on this page are saved too.`);
    expect(enableConfirmMessage({ noAllowedIps: true, unsaved: true })).toBe(
      `${plain} No IP addresses are allowed, so your team cannot open the site either. Your unsaved changes on this page are saved too.`,
    );
  });

  test('the toast after saving depends on the switch', () => {
    expect(savedMessage(false)).toBe('Maintenance settings saved.');
    expect(savedMessage(true)).toBe('Maintenance settings saved. The agent applies them within a few seconds.');
  });

  test('no text has an em dash', () => {
    for (const text of [enableConfirmMessage({ noAllowedIps: true, unsaved: true }), savedMessage(true), savedMessage(false)]) expect(text).not.toContain('—');
  });
});

describe('preview', () => {
  const state = { default_message: backend.default_message, stock_html: backend.stock_html };

  test('the standard page gets the default message and no end time', () => {
    const html = previewDocument({ message: '', end_time: '', custom_html: '' }, state, NOW);
    expect(html).toContain(backend.default_message);
    expect(html).toContain('datetime=""');
    expect(html).not.toContain('{{WAFIO');
  });

  test('the message is trimmed and escaped for HTML', () => {
    const html = previewDocument({ message: '  <script>alert("x")</script> & \'q\'  ', end_time: '', custom_html: '' }, state, NOW);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain(backend.default_message);
  });

  test('an end time in the future is filled in as stored, a passed or invalid one leaves the placeholder empty', () => {
    expect(previewDocument({ message: '', end_time: IN_ONE_DAY, custom_html: '' }, state, NOW)).toContain(`datetime="${IN_ONE_DAY}"`);
    expect(previewDocument({ message: '', end_time: '2026-11-19T19:00:00+07:00', custom_html: '' }, state, NOW)).toContain(`datetime="${IN_ONE_DAY}"`);
    for (const end of [HOUR_AGO, '2026-11-18T12:00:00Z', 'soon', '']) {
      const html = previewDocument({ message: '', end_time: end, custom_html: '' }, state, NOW);
      expect(html).toContain('datetime=""');
    }
  });

  test('custom HTML replaces the standard page and gets the same values', () => {
    const html = previewDocument({ message: 'Back at 22:00', end_time: IN_ONE_DAY, custom_html: '<h1>{{WAFIO_MESSAGE}}</h1><p>{{WAFIO_END_TIME}}</p><p>{{WAFIO_MESSAGE}}</p>' }, state, NOW);
    expect(html).toBe(`<h1>Back at 22:00</h1><p>${IN_ONE_DAY}</p><p>Back at 22:00</p>`);
    expect(previewDocument({ message: '', end_time: HOUR_AGO, custom_html: '<p>{{WAFIO_END_TIME}}|</p>' }, state, NOW)).toBe('<p>|</p>');
    // Text of the page that is not a placeholder stays as written, scripts included.
    expect(previewDocument({ message: '', end_time: '', custom_html: '<script>var a = "{{OTHER}}"</script>' }, state, NOW)).toBe('<script>var a = "{{OTHER}}"</script>');
  });

  test('a whitespace-only custom page is the standard page', () => {
    expect(previewDocument({ message: 'x', end_time: '', custom_html: ' \n ' }, state, NOW)).toContain('<title>Down for maintenance</title>');
  });

  test('a message that holds a placeholder is not filled in again', () => {
    const html = previewDocument({ message: '{{WAFIO_END_TIME}}', end_time: IN_ONE_DAY, custom_html: '<p>{{WAFIO_MESSAGE}}</p>' }, state, NOW);
    expect(html).toBe('<p>{{WAFIO_END_TIME}}</p>');
  });
});

describe('the panel', () => {
  const file = new URL('../src/lib/components/apps/AppMaintenance.svelte', import.meta.url);
  const source = readFileSync(file, 'utf8');

  test('compiles without compiler or a11y warnings', () => {
    const { warnings } = compile(source, { filename: file.pathname, generate: 'client' });
    expect(warnings.map((w) => `${w.code}:${w.start?.line ?? '?'}`)).toEqual([]);
  });

  test('colours come from the tokens, the preview is sandboxed and no text has an em dash', () => {
    expect(source.split('<style>')[1]).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(source).toContain('sandbox="allow-scripts"');
    expect(source).not.toContain('allow-same-origin');
    expect(source).not.toContain('\u2014');
  });
});
