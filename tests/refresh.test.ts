import { expect, test } from 'bun:test';
import { coalesceAsync } from '../src/lib/refresh';

test('skips duplicate refreshes and reruns once for a changed key', async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const refresh = coalesceAsync(async () => {
    calls++;
    await new Promise<void>((resolve) => releases.push(resolve));
  });

  const first = refresh('app-a');
  refresh('app-a');
  refresh('app-b');
  refresh('app-b');
  expect(calls).toBe(1);
  releases.shift()?.();
  await Bun.sleep(0);
  expect(calls).toBe(2);
  releases.shift()?.();
  await first;
  expect(calls).toBe(2);
});

test('does not queue another refresh for the same key', async () => {
  let release: () => void = () => {};
  let calls = 0;
  const refresh = coalesceAsync(async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
  });
  const first = refresh('app-a');
  refresh('app-a');
  release();
  await first;
  expect(calls).toBe(1);
});
