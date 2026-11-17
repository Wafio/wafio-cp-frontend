// Application monitoring helpers: escaped map popups, the traffic
// chart geometry with block rate, and the application page tabs/URLs.
import { describe, expect, test } from 'bun:test';
import type { GeoLocation, WAFEventTimelineBucket } from '../src/lib/api';
import {
  escapeHtml,
  geoMarkerHtml,
  geoPopupHtml,
  locationTone,
  mappableLocations,
  topCountries,
} from '../src/lib/components/apps/geo';
import { axisTimeLabel, buildTimeline, deltaText, nearestBucket, periodDelta, spansMultipleDays } from '../src/lib/components/apps/timeline';
import { formatDateTime } from '../src/lib/format';
import { groupBlockEntries, reasonLabel, unblockOperationText } from '../src/lib/components/apps/block-window';
import {
  appHref,
  appTabSearch,
  appTabs,
  legacyAppRedirect,
  normalizeAppTab,
  readAppRange,
  readAppTab,
  writeAppRange,
} from '../src/lib/components/apps/app-page';

function loc(over: Partial<GeoLocation> = {}): GeoLocation {
  return { remote_addr: '203.0.113.9', country_code: 'NL', country_name: 'Netherlands', count: 3, allow: 2, log: 0, block: 1, lat: 52.3, lon: 4.9, ...over };
}

describe('geo popups', () => {
  test('escapeHtml covers markup and attribute breakers', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&\``)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;&#96;');
    expect(escapeHtml(null)).toBe('');
  });

  test('telemetry values in the popup are escaped', () => {
    const html = geoPopupHtml(
      loc({
        city: '<script>alert(1)</script>',
        isp: '"><img src=x onerror=alert(2)>',
        remote_addr: '<b>1.2.3.4</b>',
        country_name: '<i>Evil</i>',
        country_code: 'QQ',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<i>Evil');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;1.2.3.4&lt;/b&gt;');
    expect(html).toContain('3 requests');
    expect(html).toContain('1 blocked');
  });

  test('markers carry a tone class and numbers only', () => {
    const marker = geoMarkerHtml({ count: 1500, block: 0, log: 2 });
    expect(marker.html).toContain('geo-dot-log');
    expect(marker.html).toContain('999+');
    expect(marker.size).toBeGreaterThanOrEqual(14);
    expect(locationTone({ block: 1, log: 5 })).toBe('block');
    expect(locationTone({ block: 0, log: 0 })).toBe('allow');
  });

  test('only real coordinates are mapped', () => {
    const points = mappableLocations([loc(), loc({ lat: 0, lon: 0 }), loc({ lat: undefined }), loc({ lat: 95 })]);
    expect(points).toHaveLength(1);
  });

  test('country ranking', () => {
    const rows = topCountries([loc(), loc({ remote_addr: 'b', count: 7, block: 0 }), loc({ remote_addr: 'c', country_code: 'US', country_name: 'United States', count: 5 })]);
    expect(rows.map((r) => [r.code, r.count, r.pct])).toEqual([
      ['NL', 10, 100],
      ['US', 5, 50],
    ]);
  });
});

describe('traffic timeline', () => {
  const buckets: WAFEventTimelineBucket[] = [
    { bucket_start: '2026-09-27T10:00:00Z', requests: 100, blocks: 10, allows: 90, monitors: 0, errors: 0 },
    { bucket_start: '2026-09-27T10:05:00Z', requests: 0, blocks: 0, allows: 0, monitors: 0, errors: 0 },
    { bucket_start: '2026-09-27T10:10:00Z', requests: 40, blocks: 20, allows: 20, monitors: 0, errors: 0 },
  ];

  test('block rate is per bucket with gaps where there was no traffic', () => {
    const g = buildTimeline(buckets);
    expect(g.buckets.map((b) => b.blockRate)).toEqual([0.1, null, 0.5]);
    expect(g.rateLine.match(/M/g)?.length).toBe(2);
    expect(g.totals).toEqual({ requests: 140, blocks: 30, blockRate: 30 / 140 });
    expect(g.maxRequests).toBe(100);
    expect(g.requestArea.endsWith('Z')).toBe(true);
  });

  test('empty and single-bucket input', () => {
    expect(buildTimeline([]).requestLine).toBe('');
    const one = buildTimeline([buckets[0]]);
    expect(one.buckets[0].x).toBeGreaterThan(one.box.padLeft);
  });

  test('period deltas come from the doubled window', () => {
    expect(periodDelta(120, 220)).toEqual({ previous: 100, ratio: 0.2 });
    expect(periodDelta(50, 50)).toEqual({ previous: 0, ratio: null });
    expect(periodDelta(50, null)).toBeNull();
    expect(deltaText(periodDelta(120, 220), 'Last hour')).toBe('+20% vs the previous hour');
    expect(deltaText(periodDelta(80, 180), 'Last 24 hours')).toBe('−20% vs the previous 24 hours');
    expect(deltaText(periodDelta(50, 50), 'Last hour')).toBe('none in the previous hour');
    expect(deltaText(periodDelta(100, 200), 'Last hour')).toBe('same as the previous hour');
    expect(deltaText(null, 'Last hour')).toBeUndefined();
  });

  test('nearest bucket and axis labels', () => {
    const g = buildTimeline(buckets);
    expect(nearestBucket(g, g.buckets[2].x - 1)).toBe(2);
    expect(axisTimeLabel('2026-09-27T10:05:00Z', false)).toBe(formatDateTime('2026-09-27T10:05:00Z', { format: 'time' }));
    expect(axisTimeLabel('2026-09-27T10:05:00Z', true)).toBe(formatDateTime('2026-09-27T10:05:00Z', { year: false }));
    expect(axisTimeLabel('2026-09-27T10:05:00Z', true)).not.toContain('UTC');
    expect(spansMultipleDays(buckets)).toBe(false);
    expect(spansMultipleDays([buckets[0], { ...buckets[1], bucket_start: '2026-09-28T00:00:00Z' }])).toBe(true);
  });
});

describe('application page URLs', () => {
  test('config and block window need an assigned agent', () => {
    const tabs = appTabs({ assigned: false });
    expect(tabs.filter((t) => t.disabled).map((t) => t.id)).toEqual(['config', 'blockwindow']);
    expect(appTabs({ assigned: true }).some((t) => t.disabled)).toBe(false);
    expect(readAppTab('?tab=config', { assigned: false })).toBe('monitoring');
    expect(readAppTab('?tab=config', { assigned: true })).toBe('config');
    expect(readAppTab('?tab=nope', { assigned: true })).toBe('monitoring');
  });

  test('old tab ids are accepted', () => {
    expect(normalizeAppTab('overview')).toBe('monitoring');
    expect(normalizeAppTab('Block-Window')).toBe('blockwindow');
    expect(normalizeAppTab('')).toBeNull();
  });

  test('switching tabs keeps shared params and drops the feed filter', () => {
    expect(appTabSearch('?tab=decisions&q=1.2.3.4&range=24h', 'monitoring')).toBe('?range=24h');
    expect(appTabSearch('?range=24h', 'decisions')).toBe('?range=24h&tab=decisions');
    expect(appHref('/b', 'p1', 'a1', 'decisions', { q: '1.2.3.4' })).toBe('/b/projects/p1/apps/a1?q=1.2.3.4&tab=decisions');
    expect(appHref('', 'p1', 'a1')).toBe('/projects/p1/apps/a1');
  });

  test('the old per-agent URL redirects to the single application page', () => {
    expect(legacyAppRedirect('/b', 'p1', 'a1', '')).toBe('/b/projects/p1/apps/a1');
    expect(legacyAppRedirect('/b', 'p1', 'a1', '?tab=config')).toBe('/b/projects/p1/apps/a1?tab=config');
    expect(legacyAppRedirect('', 'p1', 'a1', '?tab=blockwindow&x=1')).toBe('/projects/p1/apps/a1?x=1&tab=blockwindow');
    expect(legacyAppRedirect('', 'p1', 'a1', '?tab=weird')).toBe('/projects/p1/apps/a1');
  });

  test('range in the URL', () => {
    expect(readAppRange('?range=24h')).toBe('24h');
    expect(readAppRange('?range=all')).toBe('1h');
    expect(writeAppRange('?tab=decisions', '7d')).toBe('?tab=decisions&range=7d');
    expect(writeAppRange('?range=7d', '1h')).toBe('');
  });
});

describe('block window grouping', () => {
  test('one row per key with the latest times, all ids and the strongest unblock status', () => {
    const groups = groupBlockEntries([
      { id: '1', key: '203.0.113.9', key_type: 'ip', reason: 'SQLi', path: '/a', blocked_at: '2026-09-27T10:00:00Z', expires_at: '2026-09-27T10:10:00Z' },
      { id: '2', key: '203.0.113.9', key_type: 'ip', reason: 'LoginProtection', path: '/login', blocked_at: '2026-09-27T10:05:00Z', expires_at: '2026-09-27T10:08:00Z', unblock: { command_id: 'c', status: 'failed', expires_at: '' } },
      { id: '3', key: '203.0.113.9', key_type: 'ip', reason: 'SQLi', path: '/b', blocked_at: '2026-09-27T09:00:00Z', expires_at: '2026-09-27T09:10:00Z', unblock: { command_id: 'd', status: 'pending', expires_at: '' } },
      { id: '4', key: 'sqlmap', key_type: 'ua', reason: 'BlockPolicy', path: '/', blocked_at: '2026-09-27T10:06:00Z', expires_at: '2026-09-27T11:00:00Z' },
    ]);
    expect(groups.map((g) => g.key)).toEqual(['sqlmap', '203.0.113.9']);
    const ip = groups[1];
    expect(ip.ids).toEqual(['1', '2', '3']);
    expect(ip.reasons).toEqual(['SQLi', 'LoginProtection']);
    expect(ip.pathCount).toBe(3);
    expect(ip.blockedAt).toBe('2026-09-27T10:05:00Z');
    expect(ip.expiresAt).toBe('2026-09-27T10:10:00Z');
    expect(ip.persistent).toBe(true);
    expect(ip.unblock).toBe('pending');
    expect(ip.operations.map((op) => op.command_id)).toEqual(['c', 'd']);
    expect(unblockOperationText({ command_id: 'c', status: 'failed', error: 'agent offline', expires_at: '' })).toBe('failed · agent offline (command c)');
    expect(groups[0].operations).toEqual([]);
    expect(groups[0].persistent).toBe(true);
    expect(reasonLabel('BlockPolicy')).toBe('Block policy');
    expect(reasonLabel('SQLi')).toBe('SQLi');
  });
});
