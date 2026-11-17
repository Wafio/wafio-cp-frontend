import { describe, expect, test } from 'bun:test';
import { decideClose, focusInitial, isOutsideRect, type ClosePolicy } from '../src/lib/components/ui/dialog';
import { nextTabId, readTabParam, resolveTabId, tabDomIds, tabSearch } from '../src/lib/components/ui/tabs';
import { formatPageRange, pageInfo, slicePage } from '../src/lib/components/ui/pagination';
import { ariaSort, nextSort, sortRows } from '../src/lib/components/ui/table-sort';
import {
  DEFAULT_TIME_RANGE,
  parseTimeRange,
  timeRangeLabel,
  timeRangeMinutes,
  timeRangeOptions,
  timeRangeWindow
} from '../src/lib/components/ui/time-range';
import { backLabelText, defaultBackLabel } from '../src/lib/components/ui/page-header';

describe('dialog close policy', () => {
  const base: ClosePolicy = { dismissible: true, dirty: false, guardDirty: true, closeOnBackdrop: true };

  test('clean dialog closes from every source', () => {
    for (const source of ['escape', 'backdrop', 'close-button', 'native'] as const) {
      expect(decideClose(source, base)).toBe('close');
    }
  });

  test('dirty dialog asks before Escape/× and ignores the backdrop', () => {
    const dirty = { ...base, dirty: true };
    expect(decideClose('escape', dirty)).toBe('confirm-discard');
    expect(decideClose('close-button', dirty)).toBe('confirm-discard');
    expect(decideClose('native', dirty)).toBe('confirm-discard');
    expect(decideClose('backdrop', dirty)).toBe('ignore');
  });

  test('dirty without guard (ConfirmModal) only blocks the backdrop', () => {
    const policy = { ...base, dirty: true, guardDirty: false };
    expect(decideClose('escape', policy)).toBe('close');
    expect(decideClose('backdrop', policy)).toBe('ignore');
  });

  test('non-dismissible dialog (request in flight) ignores everything', () => {
    const busy = { ...base, dismissible: false };
    for (const source of ['escape', 'backdrop', 'close-button', 'native'] as const) {
      expect(decideClose(source, busy)).toBe('ignore');
    }
  });

  test('closeOnBackdrop=false keeps Escape working', () => {
    const policy = { ...base, closeOnBackdrop: false };
    expect(decideClose('backdrop', policy)).toBe('ignore');
    expect(decideClose('escape', policy)).toBe('close');
  });

  test('backdrop hit test', () => {
    const rect = { left: 100, right: 300, top: 50, bottom: 250 };
    expect(isOutsideRect(99, 100, rect)).toBe(true);
    expect(isOutsideRect(150, 251, rect)).toBe(true);
    expect(isOutsideRect(100, 50, rect)).toBe(false);
    expect(isOutsideRect(200, 200, rect)).toBe(false);
  });

  test('initial focus prefers explicit, then autofocus, then first focusable, then the dialog', () => {
    const focused: string[] = [];
    const el = (name: string, visible = true) => ({
      focus: () => focused.push(name),
      getClientRects: () => ({ length: visible ? 1 : 0 }),
      closest: () => null
    });
    const root = (explicit: unknown[], auto: unknown[], focusables: unknown[]) => ({
      ...el('dialog'),
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === '#pick' ? explicit : selector.includes('autofocus') ? auto : focusables
    });

    focusInitial(root([el('explicit')], [el('auto')], [el('first')]), null, '#pick');
    focusInitial(root([], [el('auto')], [el('first')]), null);
    // An autofocus target inside a closed nested dialog is invisible and skipped.
    focusInitial(root([], [el('hidden-auto', false), el('auto-2')], [el('first')]), null);
    focusInitial(root([], [el('hidden-auto', false)], [el('hidden', false), el('first')]), null);
    focusInitial(root([], [], []), null);
    expect(focused).toEqual(['explicit', 'auto', 'auto-2', 'first', 'dialog']);
  });
});

describe('tabs', () => {
  const tabs = [{ id: 'overview' }, { id: 'rules', disabled: true }, { id: 'live' }, { id: 'settings' }];

  test('arrow keys wrap and skip disabled tabs', () => {
    expect(nextTabId(tabs, 'overview', 'ArrowRight')).toBe('live');
    expect(nextTabId(tabs, 'live', 'ArrowLeft')).toBe('overview');
    expect(nextTabId(tabs, 'settings', 'ArrowRight')).toBe('overview');
    expect(nextTabId(tabs, 'overview', 'ArrowLeft')).toBe('settings');
    expect(nextTabId(tabs, 'live', 'Home')).toBe('overview');
    expect(nextTabId(tabs, 'overview', 'End')).toBe('settings');
    expect(nextTabId(tabs, 'overview', 'Enter')).toBeUndefined();
    expect(nextTabId([], 'x', 'ArrowRight')).toBeUndefined();
  });

  test('selection falls back to a valid enabled tab', () => {
    expect(resolveTabId(tabs, 'live')).toBe('live');
    expect(resolveTabId(tabs, 'rules')).toBe('overview');
    expect(resolveTabId(tabs, 'nope', 'settings')).toBe('settings');
    expect(resolveTabId(tabs, undefined)).toBe('overview');
  });

  test('URL sync keeps other params and drops the default tab', () => {
    expect(tabSearch('?host=a&tab=live', 'tab', 'settings', 'overview')).toBe('?host=a&tab=settings');
    expect(tabSearch('?host=a&tab=live', 'tab', 'overview', 'overview')).toBe('?host=a');
    expect(tabSearch('', 'tab', 'overview', 'overview')).toBe('');
    expect(readTabParam('?tab=live', 'tab', tabs, 'overview')).toBe('live');
    expect(readTabParam('?tab=rules', 'tab', tabs, 'overview')).toBe('overview');
    expect(readTabParam(new URLSearchParams('tab=%3Cscript%3E'), 'tab', tabs, 'overview')).toBe('overview');
  });

  test('DOM ids are safe for any tab id', () => {
    expect(tabDomIds('fw', 'port policy/1')).toEqual({ tab: 'fw-tab-port_policy_1', panel: 'fw-panel-port_policy_1' });
  });
});

describe('pagination', () => {
  test('single row disables both directions ("1–1 of 1")', () => {
    const info = pageInfo({ offset: 0, limit: 20, total: 1 });
    expect(info.hasPrev).toBe(false);
    expect(info.hasNext).toBe(false);
    expect(formatPageRange(info)).toBe('1 of 1');
  });

  test('middle and last pages', () => {
    const middle = pageInfo({ offset: 20, limit: 20, total: 134 });
    expect([middle.from, middle.to, middle.page, middle.pageCount]).toEqual([21, 40, 2, 7]);
    expect(middle.hasPrev && middle.hasNext).toBe(true);
    expect(formatPageRange(middle, 'en-US')).toBe('21–40 of 134');

    const last = pageInfo({ offset: 120, limit: 20, total: 134 });
    expect([last.from, last.to, last.hasNext, last.lastOffset]).toEqual([121, 134, false, 120]);
  });

  test('empty and out-of-range offsets are clamped', () => {
    const empty = pageInfo({ offset: 40, limit: 20, total: 0 });
    expect([empty.offset, empty.from, empty.to, empty.hasPrev, empty.hasNext]).toEqual([0, 0, 0, false, false]);
    expect(formatPageRange(empty)).toBe('No results');

    const past = pageInfo({ offset: 500, limit: 20, total: 45 });
    expect([past.offset, past.from, past.to]).toEqual([40, 41, 45]);
    expect(pageInfo({ offset: -5, limit: 0, total: 3 }).limit).toBe(1);
  });

  test('unknown total uses count and hasMore', () => {
    const info = pageInfo({ offset: 20, limit: 20, count: 20, hasMore: true });
    expect([info.from, info.to, info.hasNext, info.pageCount]).toEqual([21, 40, true, null]);
    expect(formatPageRange(info)).toBe('21–40');
    expect(pageInfo({ offset: 0, limit: 20, count: 7 }).hasNext).toBe(false);
  });

  test('client-side slice', () => {
    const rows = Array.from({ length: 45 }, (_, i) => i);
    expect(slicePage(rows, 40, 20)).toEqual([40, 41, 42, 43, 44]);
    expect(slicePage(rows, 999, 20)).toEqual([40, 41, 42, 43, 44]);
  });
});

describe('table sorting', () => {
  test('header clicks toggle and start new columns at their first direction', () => {
    expect(nextSort(null, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'hits', 'desc')).toEqual({ key: 'hits', dir: 'desc' });
  });

  test('aria-sort values', () => {
    expect(ariaSort({ key: 'a', dir: 'asc' }, 'a')).toBe('ascending');
    expect(ariaSort({ key: 'a', dir: 'desc' }, 'a')).toBe('descending');
    expect(ariaSort({ key: 'a', dir: 'desc' }, 'b')).toBe('none');
    expect(ariaSort(null, 'a')).toBe('none');
  });

  type Row = { id: number; name: string | null; hits?: number; seen?: Date };
  const rows: Row[] = [
    { id: 1, name: 'host-10', hits: 5 },
    { id: 2, name: 'host-9', hits: 50 },
    { id: 3, name: null, hits: 7 },
    { id: 4, name: 'Host-1' },
    { id: 5, name: 'host-9', hits: 5 }
  ];
  const get = (row: Row, key: string) => (row as unknown as Record<string, unknown>)[key];

  test('numeric-aware, case-insensitive, stable, empties last in both directions', () => {
    expect(sortRows(rows, { key: 'name', dir: 'asc' }, get).map((r) => r.id)).toEqual([4, 2, 5, 1, 3]);
    expect(sortRows(rows, { key: 'name', dir: 'desc' }, get).map((r) => r.id)).toEqual([1, 2, 5, 4, 3]);
    expect(sortRows(rows, { key: 'hits', dir: 'desc' }, get).map((r) => r.id)).toEqual([2, 3, 1, 5, 4]);
    expect(sortRows(rows, null, get)).not.toBe(rows);
  });

  test('dates compare by time', () => {
    const dated = [
      { id: 1, name: 'a', seen: new Date('2026-09-27T10:00:00Z') },
      { id: 2, name: 'b', seen: new Date('2026-09-26T10:00:00Z') }
    ];
    expect(sortRows(dated, { key: 'seen', dir: 'asc' }, get).map((r) => r.id)).toEqual([2, 1]);
  });
});

describe('time ranges', () => {
  test('one set, default 1h, "all" only on request', () => {
    expect(DEFAULT_TIME_RANGE).toBe('1h');
    expect(timeRangeOptions().map((o) => o.key)).toEqual(['5m', '1h', '24h', '7d', '30d']);
    expect(timeRangeOptions(true).map((o) => o.key)).toEqual(['5m', '1h', '24h', '7d', '30d', 'all']);
  });

  test('parsing validates URL input', () => {
    expect(parseTimeRange('24h')).toBe('24h');
    expect(parseTimeRange('15m')).toBe('1h');
    expect(parseTimeRange('all')).toBe('1h');
    expect(parseTimeRange('all', { includeAll: true })).toBe('all');
    expect(parseTimeRange(null, { fallback: '7d' })).toBe('7d');
  });

  test('minutes, labels and windows', () => {
    expect(timeRangeMinutes('7d')).toBe(10080);
    expect(timeRangeMinutes('all')).toBeNull();
    expect(timeRangeLabel('24h')).toBe('Last 24 hours');
    const now = new Date('2026-09-27T12:00:00Z');
    expect(timeRangeWindow('1h', now).from?.toISOString()).toBe('2026-09-27T11:00:00.000Z');
    expect(timeRangeWindow('all', now)).toEqual({ from: null, to: now });
  });
});

describe('page header back links', () => {
  test('project root and project list are derived', () => {
    expect(defaultBackLabel('/projects/abc')).toBe('← Overview');
    expect(defaultBackLabel('/base/projects/abc/')).toBe('← Overview');
    expect(defaultBackLabel('/projects/abc?tab=x')).toBe('← Overview');
    expect(defaultBackLabel('/projects')).toBe('← Projects');
    expect(defaultBackLabel('/base/projects')).toBe('← Projects');
  });

  test('deeper targets need an explicit label', () => {
    expect(defaultBackLabel('/projects/abc/hosts')).toBeUndefined();
    expect(defaultBackLabel('/admin')).toBeUndefined();
    expect(defaultBackLabel(undefined)).toBeUndefined();
  });

  test('the arrow is stripped from the readable text', () => {
    expect(backLabelText('← Hosts')).toBe('Hosts');
    expect(backLabelText('WAF agents')).toBe('WAF agents');
  });
});

describe('item label of the page range', () => {
  test('one row uses the singular, and "ies" becomes "y"', async () => {
    const { singularLabel } = await import('../src/lib/components/ui/pagination');
    expect(singularLabel('users')).toBe('user');
    expect(singularLabel('decisions')).toBe('decision');
    expect(singularLabel('entries')).toBe('entry');
    expect(singularLabel('data')).toBe('data');
  });
});
