// Failures are shown as failures, not as empty data; the
// one-time private key is guarded; toasts announce through one permanent live
// region and their timers pause without re-arming; editor colours are tokens;
// plus the notice on the Custom rules page.
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import { renderComponent } from './support/ssr';
import { FakeClock } from './support/runes';
import { ToastTimers } from '../src/lib/toast-timers';
import { toast } from '../src/lib/stores/toast';
import {
  continueNoticeKey,
  continuingRules,
  dismissContinueNotice,
  isContinueNoticeDismissed,
} from '../src/lib/components/rules/continue-notice';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

// Svelte components are typed loosely here: the SSR plugin loads them at runtime.
async function render(path: string, props: Record<string, unknown>): Promise<string> {
  const mod = (await import(path)) as { default: never };
  return renderComponent(mod.default, props as never);
}

describe('firewall error states are not "no data"', () => {
  const overviewProps = {
    range: '24h',
    onrangechange: () => {},
    onretryanalytics: () => {},
    onreloadtopips: () => {},
    onblockip: () => {},
    status: { running: true },
  };

  test('top sources: a failed request shows the error, not "No dropped traffic"', async () => {
    const html = await render('../src/lib/components/firewall/FirewallOverview.svelte', { ...overviewProps, topIPsError: 'top sources exploded' });
    expect(html).toContain('top sources exploded');
    expect(html).not.toContain('No dropped traffic in this time range');
  });

  test('top sources: an empty successful answer still shows the empty state', async () => {
    const html = await render('../src/lib/components/firewall/FirewallOverview.svelte', overviewProps);
    expect(html).toContain('No dropped traffic in this time range');
  });

  test('drops by reason: a failed request shows the error, not "No drop summary yet"', async () => {
    const html = await render('../src/lib/components/firewall/FirewallOverview.svelte', { ...overviewProps, dropsError: 'drops exploded' });
    expect(html).toContain('drops exploded');
    expect(html).not.toContain('No drop summary yet');
  });

  test('Live tab: each view shows its own load error instead of the empty state', async () => {
    for (const view of ['events', 'connections', 'bandwidth'] as const) {
      const errors = { events: null, connections: null, bandwidth: null, [view]: `${view} exploded` };
      const html = await render('../src/lib/components/firewall/LivePanel.svelte', { view, errors, onrefresh: () => {} });
      expect(html).toContain(`${view} exploded`);
      expect(html).not.toMatch(/No packet events yet|No tracked connections|No bandwidth data yet/);
    }
    const ok = await render('../src/lib/components/firewall/LivePanel.svelte', { view: 'events', onrefresh: () => {} });
    expect(ok).toContain('No packet events yet');
  });

  test('the firewall page records per-request errors and clears figures of an old range', () => {
    const page = src('routes/projects/[id]/host/firewall/+page.svelte');
    expect(page).toContain('topIPsError = topRes.error');
    expect(page).toContain('dropsError = dropsRes.error');
    expect(page).toMatch(/liveErrors = \{ events: failure\(eventsRes/);
    expect(page).toMatch(/if \(overviewRange !== forRange\) \{[\s\S]*?analytics = null;[\s\S]*?topIPs = \[\];/);
  });
});

describe('country codes, app geo and range changes', () => {
  test('the WAF policy form shows an InlineError with retry when the country list fails', () => {
    const form = src('lib/components/ConfigWafForm.svelte');
    expect(form).toMatch(/<InlineError message=\{countriesError\} onretry=/);
    expect(form).toMatch(/countriesError = `Could not load the country list/);
  });

  test('app monitoring shows geo failures and clears data when the range changes', () => {
    const overview = src('lib/components/AppOverview.svelte');
    expect(overview).toContain('geoError = g.error');
    expect(overview).toMatch(/<InlineError message=\{geoError\}/);
    // The reset is keyed on project, app AND range, not only on the scope.
    expect(overview).toMatch(/const key = `\$\{projectId\}\|\$\{appId\}\|\$\{range\}`;[\s\S]*?if \(key !== lastKey\) \{[\s\S]*?summary = null;[\s\S]*?geo = \[\];/);
  });
});

describe('credential reveal guard', () => {
  test('an issued key registers a navigation guard until the bundle is downloaded', () => {
    const page = src('routes/projects/[id]/settings/credentials/+page.svelte');
    expect(page).toMatch(/createDirtyTracker\(\(\) => \(provisioned && provisioned\.id !== downloadedId \? provisioned\.id : null\)/);
    expect(page).toContain('keyGuard.guardNavigation()');
    expect(page).toMatch(/a\.click\(\);[\s\S]*?downloadedId = p\.id;/);
    expect(page).toMatch(/async function dismissReveal\(\) \{\s*if \(!\(await keyGuard\.confirmDiscard\(\)\)\) return;/);
  });
});

describe('toast timers', () => {
  function setup() {
    const clock = new FakeClock();
    const expired: string[] = [];
    const timers = new ToastTimers((id) => expired.push(id), {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    return { clock, expired, timers };
  }

  test('a toast expires after its duration; duration 0 never expires', async () => {
    const { clock, expired, timers } = setup();
    timers.sync([{ id: 'a', duration: 4000 }, { id: 'err', duration: 0 }]);
    await clock.advance(3999);
    expect(expired).toEqual([]);
    await clock.advance(1);
    expect(expired).toEqual(['a']);
    await clock.advance(60_000);
    expect(expired).toEqual(['a']);
    expect(timers.remaining('err')).toBeNull();
  });

  test('hover pauses and resumes with the time left, not the full duration', async () => {
    const { clock, expired, timers } = setup();
    timers.sync([{ id: 'a', duration: 4000 }]);
    await clock.advance(3000);
    timers.pause('a', 'hover');
    await clock.advance(10_000);
    expect(expired).toEqual([]);
    expect(timers.remaining('a')).toBe(1000);
    timers.resume('a', 'hover');
    await clock.advance(999);
    expect(expired).toEqual([]);
    await clock.advance(1);
    expect(expired).toEqual(['a']);
  });

  test('sync on a later store change does not re-arm a hovered toast', async () => {
    const { clock, expired, timers } = setup();
    timers.sync([{ id: 'a', duration: 4000 }]);
    timers.pause('a', 'hover');
    // Another toast arrives: the container effect runs sync() again.
    timers.sync([{ id: 'a', duration: 4000 }, { id: 'b', duration: 4000 }]);
    await clock.advance(5000);
    expect(expired).toEqual(['b']);
    expect(timers.isPaused('a')).toBe(true);
  });

  test('focus and hover pause independently; both must end to resume', async () => {
    const { clock, expired, timers } = setup();
    timers.sync([{ id: 'a', duration: 1000 }]);
    timers.pause('a', 'hover');
    timers.pause('a', 'focus');
    timers.resume('a', 'hover');
    await clock.advance(5000);
    expect(expired).toEqual([]);
    timers.resume('a', 'focus');
    await clock.advance(1000);
    expect(expired).toEqual(['a']);
  });

  test('toasts that left the store are forgotten; dispose clears every timer', async () => {
    const { clock, expired, timers } = setup();
    timers.sync([{ id: 'a', duration: 1000 }, { id: 'b', duration: 1000 }]);
    timers.sync([{ id: 'b', duration: 1000 }]);
    expect(clock.pending).toBe(1);
    timers.dispose();
    expect(clock.pending).toBe(0);
    await clock.advance(2000);
    expect(expired).toEqual([]);
  });

  test('error toasts stay until dismissed; others default to 4 s', () => {
    toast.clear();
    toast.error('broken');
    toast.success('fine');
    const [err, ok] = get(toast);
    expect(err.duration).toBe(0);
    expect(ok.duration).toBe(4000);
    toast.clear();
  });

  test('the container keeps one permanent live region and no per-card live roles', async () => {
    toast.clear();
    const html = await render('../src/lib/components/ui/ToastContainer.svelte', {});
    expect(html).toMatch(/<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">/);
    const container = src('lib/components/ui/ToastContainer.svelte');
    const markup = container.slice(container.indexOf('</script>'));
    expect(markup.match(/aria-live=/g)).toHaveLength(1);
    expect(markup).not.toMatch(/role=\{item\.type/);
    expect(markup).toContain("onfocusin={() => pause(item.id, 'focus')}");
  });
});

describe('script editor colours are tokens', () => {
  test('codemirror-uddin.ts has no literal colours; every --code-* token it uses exists in app.css', () => {
    const editor = src('lib/codemirror-uddin.ts');
    expect(editor.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    const css = src('app.css');
    const used = [...editor.matchAll(/var\(--(code-[\w-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThanOrEqual(7);
    for (const name of used) expect(css.match(new RegExp(`--${name}:`, 'g'))?.length).toBe(2);
  });
});

describe('Custom rules notice: Log and Challenge rules continue', () => {
  const rule = (id: string, mode: string, action: string, enabled = true) => ({ id, name: `rule ${id}`, mode, action, enabled });

  test('lists Match & act rules with log or challenge, in list order', () => {
    const rules = [rule('1', 'gui', 'block'), rule('2', 'gui', 'log'), rule('3', 'script', 'log'), rule('4', 'gui', 'challenge', false), rule('5', 'tuning', 'challenge'), rule('6', 'gui', 'allow')];
    expect(continuingRules(rules).map((r) => r.id)).toEqual(['2', '4']);
  });

  test('dismissal is per project and survives a throwing or missing storage', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(isContinueNoticeDismissed('p1', storage)).toBe(false);
    expect(dismissContinueNotice('p1', storage)).toBe(true);
    expect(data.get(continueNoticeKey('p1'))).toBe('1');
    expect(isContinueNoticeDismissed('p1', storage)).toBe(true);
    expect(isContinueNoticeDismissed('p2', storage)).toBe(false);

    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(isContinueNoticeDismissed('p1', throwing)).toBe(false);
    expect(dismissContinueNotice('p1', throwing)).toBe(false);
    expect(isContinueNoticeDismissed('p1', null)).toBe(false);
    expect(dismissContinueNotice('', storage)).toBe(false);
  });

  test('the Custom rules page shows the notice from loaded rules and hides it on dismiss', () => {
    const page = src('routes/projects/[id]/rules/+page.svelte');
    expect(page).toContain('const continuing = $derived(continuingRules(rules));');
    expect(page).toMatch(/\{#if continuing\.length > 0 && !continueNoticeDismissed\}\s*<Alert [^>]*ondismiss=\{hideContinueNotice\}/);
  });
});
