// Host firewall geo allow mode: policy view, confirmation rule, table rows,
// add requests, live event labels and error hints.
import { describe, expect, test } from 'bun:test';
import {
  allowListAfter,
  eventReasonLabel,
  geoDegradedStateText,
  geoAllowNeedsAck,
  geoPolicyView,
} from '../src/lib/components/firewall/geo-policy';
import { addWarnings, buildAccessRules, describeAdd } from '../src/lib/components/firewall/rules';
import { firewallErrorMessage } from '../src/lib/components/firewall/guard-codes';

describe('geoPolicyView', () => {
  test('older control plane without mode fields is block mode, allow unsupported', () => {
    const view = geoPolicyView({ countries: [{ code: 'cn', blocked: true }, { code: 'RU', blocked: false }], count: 1 });
    expect(view).toEqual({ mode: 'block', blocked: ['CN'], allowed: [], allowSupported: false });
  });

  test('allow mode keeps the block list and normalises the allow list', () => {
    const view = geoPolicyView({ countries: [{ code: 'CN', blocked: true }], count: 1, mode: 'allow', allowed_countries: ['sg', 'ID', 'SG'], allow_supported: true });
    expect(view.mode).toBe('allow');
    expect(view.blocked).toEqual(['CN']);
    expect(view.allowed).toEqual(['ID', 'SG']);
    expect(view.allowSupported).toBe(true);
  });

  test('null data is an empty block policy', () => {
    expect(geoPolicyView(null).mode).toBe('block');
  });
});

describe('geoAllowNeedsAck', () => {
  test('switching to allow needs the confirmation', () => {
    expect(geoAllowNeedsAck({ current: 'block', next: 'allow' })).toBe(true);
  });
  test('removing an allowed country in allow mode needs it', () => {
    expect(geoAllowNeedsAck({ current: 'allow', next: 'allow', removesAllowed: true })).toBe(true);
  });
  test('adding in allow mode and switching to block do not', () => {
    expect(geoAllowNeedsAck({ current: 'allow', next: 'allow' })).toBe(false);
    expect(geoAllowNeedsAck({ current: 'allow', next: 'block' })).toBe(false);
    expect(geoAllowNeedsAck({ current: 'block', next: 'block', removesAllowed: true })).toBe(false);
  });
});

test('allowListAfter merges, upper-cases and sorts', () => {
  expect(allowListAfter(['SG'], ['id', 'SG'])).toEqual(['ID', 'SG']);
});

describe('access rule rows', () => {
  const geo = [{ code: 'CN', blocked: true }];
  test('block mode lists the blocked countries as drops', () => {
    const rows = buildAccessRules({ geo, geoMode: 'block', geoAllowed: ['ID'] }).filter((r) => r.type === 'geo');
    expect(rows.map((r) => [r.target, r.action])).toEqual([['CN', 'drop']]);
  });
  test('allow mode lists the allowed countries as allows', () => {
    const rows = buildAccessRules({ geo, geoMode: 'allow', geoAllowed: ['ID', 'sg'] }).filter((r) => r.type === 'geo');
    expect(rows.map((r) => [r.target, r.action])).toEqual([['ID', 'allow'], ['SG', 'allow']]);
  });
});

test('allow-mode add request is described as widening and skips the geo-off warning', () => {
  const request = { type: 'geo' as const, codes: ['ID'], allow: true };
  expect(describeAdd(request)).toBe('Allow inbound traffic from 1 more country');
  expect(addWarnings(request, { geoEnabled: false })).toEqual([]);
  expect(addWarnings({ type: 'geo', codes: ['CN'] }, { geoEnabled: false })).toHaveLength(1);
});

test('live event reason labels allow-mode geo drops', () => {
  expect(eventReasonLabel({ reason: 'geoblock', geo_mode: 'allow' })).toBe('Geo (allow mode)');
  expect(eventReasonLabel({ reason: 'geoblock', rule_id: 2 })).toBe('Geo (allow mode)');
  expect(eventReasonLabel({ reason: 'geoblock' })).toBe('geoblock');
  expect(eventReasonLabel({ reason: '' })).toBe('n/a');
});

test('geo error codes carry a hint', () => {
  expect(firewallErrorMessage({ error: 'allow list empty', code: 'GEO_ALLOW_EMPTY' })).toContain('at least one country');
  expect(firewallErrorMessage({ error: 'bad', code: 'GEO_COUNTRY_INVALID' })).toContain('ISO 3166-1');
});

test('degraded geo banner text names what the host enforces', () => {
  expect(geoDegradedStateText('kept')).toContain('keeps its previous geo state');
  expect(geoDegradedStateText(undefined)).toContain('keeps its previous geo state');
  expect(geoDegradedStateText('ranges_cleared')).toContain('without the country address ranges');
  expect(geoDegradedStateText('mixed')).toContain('restoring the previous geo state failed');
  for (const state of ['kept', 'ranges_cleared', 'mixed']) expect(geoDegradedStateText(state)).toContain('Every other firewall rule is applied');
});
