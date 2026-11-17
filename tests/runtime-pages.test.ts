import { describe, expect, test } from 'bun:test';
import { loadAllPages } from '../src/lib/components/runtime/pages';

function server(total: number) {
  const calls: Array<[number, number]> = [];
  const rows = Array.from({ length: total }, (_, i) => i);
  const fetchPage = async (limit: number, offset: number) => {
    calls.push([limit, offset]);
    return { data: { rows: rows.slice(offset, offset + limit), total } };
  };
  return { calls, fetchPage };
}

describe('loadAllPages (rule lists follow limit/offset + total)', () => {
  test('follows pages until the total is reached', async () => {
    const s = server(250);
    const result = await loadAllPages(s.fetchPage, { pageSize: 100 });
    expect(result?.rows).toHaveLength(250);
    expect(result?.capped).toBe(false);
    expect(s.calls).toEqual([
      [100, 0],
      [100, 100],
      [100, 200],
    ]);
  });

  test('stops at the cap and reports it', async () => {
    const s = server(1500);
    const result = await loadAllPages(s.fetchPage, { pageSize: 100, cap: 300 });
    expect(result?.rows).toHaveLength(300);
    expect(result?.total).toBe(1500);
    expect(result?.capped).toBe(true);
  });

  test('an error keeps the rows loaded so far; a stale scope drops the result', async () => {
    let n = 0;
    const failing = await loadAllPages(async () => (n++ === 0 ? { data: { rows: [1, 2], total: 4 } } : { error: 'boom' }), { pageSize: 2 });
    expect(failing?.error).toBe('boom');
    expect(failing?.rows).toEqual([1, 2]);
    const stale = await loadAllPages(async () => ({ data: { rows: [1], total: 1 } }), { isStale: () => true });
    expect(stale).toBeNull();
  });
});
