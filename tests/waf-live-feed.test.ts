// waf-live.ts: feed filter URL form and the /waf/stream agent status merge.
import { describe, expect, test } from 'bun:test';
import {
  EMPTY_FEED_FILTER,
  feedFilterActive,
  isWSDecision,
  mergeAgentStatus,
  normalizeFeedFilter,
  parseAgentStatusList,
  readFeedFilter,
  writeFeedFilter,
} from '../src/lib/waf-live';

describe('feed filter', () => {
  test('reads a valid filter from the URL and drops invalid values', () => {
    expect(readFeedFilter('?action=block&source=ws&q=%20203.0.113.9%20&method=post&category=SQLi')).toEqual({
      action: 'block',
      source: 'ws',
      q: '203.0.113.9',
      method: 'POST',
      category: 'SQLi',
      ip: '',
    });
    expect(readFeedFilter('?action=nuke&source=ftp&method=get%20x')).toEqual({ ...EMPTY_FEED_FILTER });
    expect(readFeedFilter('?q=' + 'a'.repeat(400)).q.length).toBe(256);
  });

  test('writes the filter over other parameters and removes empty keys', () => {
    const qs = writeFeedFilter('?tab=decisions&q=old&action=block', { ...EMPTY_FEED_FILTER, q: '10.0.0.1' });
    const p = new URLSearchParams(qs);
    expect(p.get('tab')).toBe('decisions');
    expect(p.get('q')).toBe('10.0.0.1');
    expect(p.has('action')).toBe(false);
    expect(writeFeedFilter('', { ...EMPTY_FEED_FILTER })).toBe('');
  });

  test('the exact-IP filter round-trips through the URL', () => {
    expect(readFeedFilter('?ip=%20203.0.113.9%20').ip).toBe('203.0.113.9');
    // An invalid address is kept so the feed can explain it next to the field.
    expect(readFeedFilter('?ip=not-an-ip').ip).toBe('not-an-ip');
    expect(new URLSearchParams(writeFeedFilter('?tab=decisions', { ...EMPTY_FEED_FILTER, ip: '2001:db8::1' })).get('ip')).toBe('2001:db8::1');
    expect(feedFilterActive({ ...EMPTY_FEED_FILTER, ip: '10.0.0.1' })).toBe(true);
  });

  test('active filter', () => {
    expect(feedFilterActive({ ...EMPTY_FEED_FILTER })).toBe(false);
    expect(feedFilterActive({ ...EMPTY_FEED_FILTER, category: 'XSS' })).toBe(true);
  });

  test('WebSocket rows by method or ws: match source', () => {
    expect(isWSDecision({ method: 'WEBSOCKET' })).toBe(true);
    expect(isWSDecision({ method: 'GET', match_source: 'ws:text' })).toBe(true);
    expect(isWSDecision({ method: 'GET', match_source: 'query:q' })).toBe(false);
  });
});

describe('agent status stream', () => {
  test('parses the agents event and rejects malformed payloads', () => {
    expect(parseAgentStatusList([{ id: 'a', name: 'edge', last_seen: '2026-09-27T10:00:00Z', is_online: true }])).toEqual([
      { id: 'a', name: 'edge', last_seen: '2026-09-27T10:00:00Z', is_online: true },
    ]);
    expect(parseAgentStatusList([{ id: 'a', is_online: 'yes' }])).toEqual([{ id: 'a', name: '', last_seen: null, is_online: false }]);
    expect(parseAgentStatusList({ id: 'a' })).toBeNull();
    expect(parseAgentStatusList([{ name: 'x' }])).toBeNull();
  });

  test('merges live status and reports added and removed agents', () => {
    const agents = [
      { id: 'a', is_online: false, last_seen: '2026-09-27T09:00:00Z' },
      { id: 'b', is_online: true, last_seen: '2026-09-27T09:59:00Z' },
    ];
    const merged = mergeAgentStatus(agents, [
      { id: 'a', name: 'a', is_online: true, last_seen: '2026-09-27T10:00:00Z' },
      { id: 'c', name: 'c', is_online: true, last_seen: null },
    ]);
    expect(merged.agents[0]).toEqual({ id: 'a', is_online: true, last_seen: '2026-09-27T10:00:00Z' });
    expect(merged.agents[1]).toBe(agents[1]);
    expect(merged.added).toEqual(['c']);
    expect(merged.removed).toEqual(['b']);
  });
});
