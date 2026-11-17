import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeNavigation, flushMicrotasks, navigate, navigationStub } from './support/runes';
import { effect_root, flush, proxy } from 'svelte/internal/client';

const { createDirtyTracker, deepEqual, UNSAVED_CHANGES_MESSAGE } = await import('../src/lib/dirty.svelte');

beforeEach(() => {
  navigationStub.beforeNavigate.length = 0;
  navigationStub.gotoCalls.length = 0;
});

describe('deepEqual', () => {
  test('structural comparison for form snapshots', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 'x' }] }, { b: [1, { c: 'x' }], a: 1 })).toBe(true);
    expect(deepEqual({ a: undefined }, {})).toBe(true);
    expect(deepEqual({ a: null }, {})).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Date(5), new Date(6))).toBe(false);
    expect(deepEqual(new Map([['k', { v: 1 }]]), new Map([['k', { v: 1 }]]))).toBe(true);
    expect(deepEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(deepEqual(new Set([1]), new Set([2]))).toBe(false);
    expect(deepEqual('1', 1)).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });
});

describe('createDirtyTracker', () => {
  test('tracks edits of a $state object against the baseline', () => {
    const form = proxy({ name: 'web', rules: ['a'], limits: { rps: 10 } });
    const dirty = createDirtyTracker(() => form);
    expect(dirty.isDirty).toBe(false);
    form.name = 'api';
    expect(dirty.isDirty).toBe(true);
    form.name = 'web';
    expect(dirty.isDirty).toBe(false);
    form.rules.push('b');
    expect(dirty.isDirty).toBe(true);
    form.rules.pop();
    form.limits.rps = 20;
    expect(dirty.isDirty).toBe(true);
  });

  test('reset() takes a new baseline (after load or save)', () => {
    const form = proxy({ name: 'web' });
    const dirty = createDirtyTracker(() => form);
    form.name = 'saved';
    expect(dirty.isDirty).toBe(true);
    dirty.reset();
    expect(dirty.isDirty).toBe(false);
    expect(dirty.baseline).toEqual({ name: 'saved' });
    dirty.reset({ name: 'server' });
    expect(dirty.isDirty).toBe(true);
  });

  test('the baseline is a snapshot, not a live reference', () => {
    const form = proxy({ list: [1] });
    const dirty = createDirtyTracker(() => form);
    form.list.push(2);
    expect(dirty.baseline).toEqual({ list: [1] });
    expect(dirty.isDirty).toBe(true);
  });

  test('custom equality', () => {
    const form = proxy({ text: 'a' });
    const dirty = createDirtyTracker(() => form, { equals: (x, y) => x.text.trim() === y.text.trim() });
    form.text = 'a  ';
    expect(dirty.isDirty).toBe(false);
  });

  test('confirmDiscard asks only when dirty', async () => {
    const form = proxy({ v: 1 });
    const prompts: string[] = [];
    const dirty = createDirtyTracker(() => form, { confirm: (m) => { prompts.push(m); return false; } });
    await expect(dirty.confirmDiscard()).resolves.toBe(true);
    expect(prompts).toEqual([]);
    form.v = 2;
    await expect(dirty.confirmDiscard()).resolves.toBe(false);
    await expect(dirty.confirmDiscard('Switch tab?')).resolves.toBe(false);
    expect(prompts).toEqual([UNSAVED_CHANGES_MESSAGE, 'Switch tab?']);
  });
});

describe('guardNavigation', () => {
  function guarded(confirm: (message: string) => boolean | Promise<boolean>) {
    const form = proxy({ v: 1 });
    const target = new EventTarget();
    const dirty = createDirtyTracker(() => form);
    const destroy = effect_root(() => { dirty.guardNavigation({ confirm, target }); });
    flush();
    return { form, target, dirty, destroy };
  }

  function unload(target: EventTarget): Event {
    const event = new Event('beforeunload', { cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  test('clean pages navigate without a prompt', () => {
    const prompts: string[] = [];
    const { target, destroy } = guarded((m) => { prompts.push(m); return false; });
    expect(navigate(fakeNavigation('link', '/projects')).cancelled).toBe(false);
    expect(unload(target).defaultPrevented).toBe(false);
    expect(prompts).toEqual([]);
    destroy();
  });

  test('dirty pages ask before an in-app navigation and cancel on "stay"', () => {
    const { form, destroy } = guarded(() => false);
    form.v = 2;
    expect(navigate(fakeNavigation('link', '/projects')).cancelled).toBe(true);
    expect(navigate(fakeNavigation('popstate', '/back')).cancelled).toBe(true);
    destroy();
  });

  test('confirming lets the navigation through', () => {
    const { form, destroy } = guarded(() => true);
    form.v = 2;
    expect(navigate(fakeNavigation('goto', '/elsewhere')).cancelled).toBe(false);
    destroy();
  });

  test('reload/close uses the native beforeunload prompt, not confirm()', () => {
    const prompts: string[] = [];
    const { form, target, destroy } = guarded((m) => { prompts.push(m); return true; });
    form.v = 2;
    expect(navigate(fakeNavigation('leave', null, true)).cancelled).toBe(false);
    expect(unload(target).defaultPrevented).toBe(true);
    expect(prompts).toEqual([]);
    destroy();
  });

  test('a confirmed external navigation does not prompt again on unload', () => {
    const { form, target, destroy } = guarded(() => true);
    form.v = 2;
    expect(navigate(fakeNavigation('link', 'https://docs.example.com/', true)).cancelled).toBe(false);
    expect(unload(target).defaultPrevented).toBe(false);
    destroy();
  });

  test('an async confirm cancels first and re-issues the navigation on "leave"', async () => {
    let answer!: (ok: boolean) => void;
    const { form, destroy } = guarded(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    form.v = 2;
    const nav = navigate(fakeNavigation('link', '/projects/p1/hosts'));
    expect(nav.cancelled).toBe(true);
    answer(true);
    await flushMicrotasks();
    expect(navigationStub.gotoCalls).toHaveLength(1);
    expect(String(navigationStub.gotoCalls[0].url)).toBe('http://localhost/projects/p1/hosts');
    destroy();
  });

  test('an async "stay" keeps the page', async () => {
    let answer!: (ok: boolean) => void;
    const { form, destroy } = guarded(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    form.v = 2;
    expect(navigate(fakeNavigation('link', '/x')).cancelled).toBe(true);
    answer(false);
    await flushMicrotasks();
    expect(navigationStub.gotoCalls).toHaveLength(0);
    destroy();
  });

  test('the unload listener is removed with the component', () => {
    const { form, target, destroy } = guarded(() => false);
    form.v = 2;
    destroy();
    expect(unload(target).defaultPrevented).toBe(false);
  });

  test('saving (reset) clears the guard', () => {
    const { form, target, dirty, destroy } = guarded(() => false);
    form.v = 2;
    dirty.reset();
    expect(navigate(fakeNavigation('link', '/x')).cancelled).toBe(false);
    expect(unload(target).defaultPrevented).toBe(false);
    destroy();
  });
});

// Custom rules: a modal tracks `open ? form : null`. Opening
// resets the baseline to the filled form; closing must reset it to null
// again, or every later navigation (a filter tab updates the URL) asks to
// leave "unsaved changes" after the modal was used once.
describe('modal tracker (open ? form : null)', () => {
  test('a closed modal is clean only when the baseline is reset on close', () => {
    const state = proxy({ open: false, form: { name: '' } });
    const dirty = createDirtyTracker(() => (state.open ? state.form : null));
    const destroy = effect_root(() => { dirty.guardNavigation({ confirm: () => false, target: null }); });
    flush();

    state.open = true;
    state.form.name = 'Sample path Test';
    dirty.reset(); // filled on open
    expect(dirty.isDirty).toBe(false);

    state.open = false; // saved or cancelled
    expect(dirty.isDirty).toBe(true); // the pitfall: last open form vs null
    dirty.reset(); // what CustomRuleModal now does when it closes
    expect(dirty.isDirty).toBe(false);
    expect(navigate(fakeNavigation('goto', '/projects/p/rules?tab=enabled')).cancelled).toBe(false);
    destroy();
  });
});
