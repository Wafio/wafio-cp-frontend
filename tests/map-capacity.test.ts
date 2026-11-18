import { describe, expect, test } from 'bun:test';
import type { MapCapacity, MapSizing } from '../src/lib/api';
import { FULL_WINDOW_MS, fullMapCount, mapCapacityView, mapLabel, mapPercent, mapState } from '../src/lib/firewall/map-capacity';

const now = Date.parse('2026-11-18T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;

const conntrack: MapCapacity = { name: 'wafio_conntrack', max_entries: 119750, default_max_entries: 500000, entries: 4210 };
const ring: MapCapacity = { name: 'trace_events', max_entries: 4 * 1024 * 1024, default_max_entries: 16 * 1024 * 1024 };
const sizing = (extra: Partial<MapSizing> = {}): MapSizing => ({
  scale: 0.2395,
  source: 'auto',
  memory_bytes: 2057306112,
  memory_source: 'meminfo',
  maps: [conntrack],
  ...extra,
});

describe('map labels and fill', () => {
  test('known names get their label, an unknown name is shown raw', () => {
    expect(mapLabel('wafio_conntrack')).toBe('Connection tracking');
    expect(mapLabel('wafio_syn_state')).toBe('SYN flood sources');
    expect(mapLabel('wafio_rate_state')).toBe('Rate limit sources');
    expect(mapLabel('wafio_portscan')).toBe('Port scan sources');
    expect(mapLabel('wafio_bandwidth')).toBe('Bandwidth accounting');
    expect(mapLabel('wafio_geoip')).toBe('GeoIP cache');
    expect(mapLabel('wafio_jail')).toBe('WAF jail');
    expect(mapLabel('trace_open_pending')).toBe('Pending file opens');
    expect(mapLabel('trace_events')).toBe('Event ring');
    expect(mapLabel('wafio_new_map')).toBe('wafio_new_map');
  });

  test('percent is entries over max, clamped, and null without a count', () => {
    expect(mapPercent({ name: 'a', max_entries: 200, entries: 50 })).toBe(25);
    expect(mapPercent({ name: 'a', max_entries: 200, entries: 0 })).toBe(0);
    expect(mapPercent({ name: 'a', max_entries: 200, entries: 250 })).toBe(100);
    expect(mapPercent({ name: 'a', max_entries: 200 })).toBeNull();
    expect(mapPercent({ name: 'a', max_entries: 0, entries: 0 })).toBeNull();
  });
});

describe('map state', () => {
  const at = (last_full_at?: string) => mapState({ name: 'a', max_entries: 10, last_full_at }, now);

  test('full within 10 minutes, was full after, ok when never', () => {
    expect(at(ago(MIN))).toBe('full');
    expect(at(ago(FULL_WINDOW_MS - 1))).toBe('full');
    expect(at(ago(FULL_WINDOW_MS))).toBe('was_full');
    expect(at(ago(3 * 60 * MIN))).toBe('was_full');
  });

  test('a missing, empty, zero or unreadable time is ok', () => {
    expect(at(undefined)).toBe('ok');
    expect(at('')).toBe('ok');
    expect(at('0001-01-01T00:00:00Z')).toBe('ok');
    expect(at('yesterday')).toBe('ok');
  });
});

describe('map capacity view', () => {
  test('an agent without map_sizing, or with no maps, gives null', () => {
    expect(mapCapacityView(undefined, now)).toBeNull();
    expect(mapCapacityView(null, now)).toBeNull();
    expect(mapCapacityView(sizing({ maps: [] }), now)).toBeNull();
    expect(mapCapacityView(sizing({ maps: undefined as never }), now)).toBeNull();
    expect(fullMapCount(undefined, now)).toBe(0);
  });

  test('the header names the scale, who set it and the memory', () => {
    expect(mapCapacityView(sizing(), now)?.header).toBe('Map scale 0.24, automatic, from 1.9 GiB memory');
    expect(mapCapacityView(sizing({ memory_bytes: undefined }), now)?.header).toBe('Map scale 0.24, automatic');
    expect(mapCapacityView(sizing({ scale: 1 }), now)?.header).toBe('Map scale 1, automatic, from 1.9 GiB memory');
    expect(mapCapacityView(sizing({ scale: 0.001, source: 'env' }), now)?.header).toBe('Map scale 0.001, set by WAFIO_EBPF_MAP_SCALE');
    expect(mapCapacityView(sizing({ scale: 0.5, source: '' }), now)?.header).toBe('Map scale 0.5');
  });

  test('a counted map shows entries out of max, the percent and what it was reduced from', () => {
    const [row] = mapCapacityView(sizing(), now)!.rows;
    expect(row).toMatchObject({
      name: 'wafio_conntrack',
      label: 'Connection tracking',
      usage: '4,210 of 119,750',
      percentText: '3.5%',
      reducedFrom: '500,000',
      state: 'ok',
      lastFullAt: null,
    });
  });

  test('a map at its default size is not reduced, and one without a default says nothing', () => {
    const rows = mapCapacityView(sizing({ maps: [{ ...conntrack, max_entries: 500000 }, { ...conntrack, name: 'wafio_geoip', default_max_entries: undefined }] }), now)!.rows;
    expect(rows.map((r) => r.reducedFrom)).toEqual([null, null]);
  });

  test('the ring is a size in bytes with no fill', () => {
    const [row] = mapCapacityView(sizing({ maps: [ring] }), now)!.rows;
    expect(row).toMatchObject({ label: 'Event ring', usage: '4 MiB', percent: null, percentText: '', reducedFrom: '16 MiB' });
  });

  test('a map without a count yet shows only its size', () => {
    const [row] = mapCapacityView(sizing({ maps: [{ name: 'wafio_syn_state', max_entries: 47900 }] }), now)!.rows;
    expect(row).toMatchObject({ usage: '47,900 entries', percent: null });
  });

  test('an unknown map name is shown raw and rows without a name or size are dropped', () => {
    const view = mapCapacityView(sizing({ maps: [{ name: 'wafio_new_map', max_entries: 10, entries: 5 }, { max_entries: 5 } as never, { name: 'x' } as never] }), now)!;
    expect(view.rows.map((r) => r.label)).toEqual(['wafio_new_map']);
  });

  test('state and time follow last_full_at per row', () => {
    const maps: MapCapacity[] = [
      { ...conntrack, last_full_at: ago(2 * MIN) },
      { name: 'wafio_jail', max_entries: 16384, entries: 10, full_count: 2, last_full_at: ago(60 * MIN) },
      { name: 'wafio_geoip', max_entries: 16384, entries: 10 },
    ];
    const rows = mapCapacityView(sizing({ maps }), now)!.rows;
    expect(rows.map((r) => r.state)).toEqual(['full', 'was_full', 'ok']);
    expect(rows[0].lastFullAt).toBe(ago(2 * MIN));
    expect(rows[1].lastFullAt).toBe(ago(60 * MIN));
    expect(rows[2].lastFullAt).toBeNull();
    expect(fullMapCount(sizing({ maps }), now)).toBe(1);
  });

  test('advice appears only while a map is full, and at scale 1 it does not offer a larger size', () => {
    const recent = [{ ...conntrack, last_full_at: ago(MIN) }];
    const old = [{ ...conntrack, last_full_at: ago(60 * MIN) }];
    expect(mapCapacityView(sizing({ maps: old }), now)?.advice).toBeNull();
    expect(mapCapacityView(sizing(), now)?.advice).toBeNull();
    expect(mapCapacityView(sizing({ maps: recent }), now)?.advice).toBe(
      'A map was full in the last 10 minutes. Raise WAFIO_EBPF_MAP_SCALE (at most 1) or look for a flood.',
    );
    const atFullSize = mapCapacityView(sizing({ scale: 1, maps: recent }), now)?.advice;
    expect(atFullSize).toBe('A map was full in the last 10 minutes. The maps are at full size: look for a flood.');
    expect(atFullSize).not.toContain('Raise');
  });
});
