// Failures are shown as failures, not as empty data; the
// one-time private key is guarded; toasts announce through one permanent live
// region and their timers pause without re-arming; editor colours are tokens.
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import { renderComponent } from './support/ssr';
import { FakeClock } from './support/runes';
import { ToastTimers } from '../src/lib/toast-timers';
import { toast } from '../src/lib/stores/toast';

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

describe('BPF map capacity', () => {
  const overview = '../src/lib/components/firewall/FirewallOverview.svelte';
  const banner = '../src/lib/components/firewall/FirewallStatusBanner.svelte';
  const props = (status: Record<string, unknown>) => ({
    range: '24h',
    onrangechange: () => {},
    onretryanalytics: () => {},
    onreloadtopips: () => {},
    onblockip: () => {},
    status: { running: true, ...status },
  });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  // Badge children render between empty comment markers.
  const plain = (html: string) => html.replace(/<!--.*?-->/g, '');
  const sizing = (maps: Record<string, unknown>[]) => ({
    scale: 0.2395,
    source: 'auto',
    memory_bytes: 2057306112,
    memory_source: 'meminfo',
    maps,
  });
  const conntrack = { name: 'wafio_conntrack', max_entries: 119750, default_max_entries: 500000, entries: 4210 };
  const syn = { name: 'wafio_syn_state', max_entries: 47900, default_max_entries: 200000, entries: 47900, full_count: 3 };

  test('the overview shows each map with its fill, its reduced size and the scale', async () => {
    const html = plain(await render(overview, props({ map_sizing: sizing([conntrack, { ...syn, last_full_at: ago(60 * 60_000) }]) })));
    expect(html).toContain('Map capacity');
    expect(html).toContain('Map scale 0.24, automatic, from 1.9 GiB memory');
    expect(html).toContain('Connection tracking');
    expect(html).toContain('4,210 of 119,750');
    expect(html).toContain('reduced from 500,000');
    expect(html).toContain('SYN flood sources');
    expect(html).toContain('>Was full</span>');
    expect(html).not.toContain('>Full</span>');
    expect(html).not.toContain('map full');
  });

  test('an agent without map_sizing shows "Not reported", not an empty or broken table', async () => {
    const html = await render(overview, props({}));
    expect(html).toContain('Map capacity');
    expect(html).toContain('Not reported');
    expect(html).not.toContain('Map scale');
  });

  test('a map that is full now is marked Full, counted in the summary and the advice is shown', async () => {
    const html = plain(await render(overview, props({ map_sizing: sizing([conntrack, { ...syn, last_full_at: ago(60_000) }]) })));
    expect(html).toContain('>Full</span>');
    expect(html).toContain('1 map full');
    expect(html).toContain('Raise WAFIO_EBPF_MAP_SCALE (at most 1) or look for a flood.');
    expect(html).toContain('>OK</span>');
  });

  test('the Coverage gap alert points to Map capacity only when the agent reports map_sizing', async () => {
    const base = { setupHref: '/host', metrics: { state_table_full: 3, packet_parse_failures: 0 } };
    const with_ = await render(banner, { ...base, status: { running: true, agent_online: true, map_sizing: sizing([conntrack]) } });
    expect(with_).toContain('Coverage gap');
    expect(with_).toContain('See Map capacity on the Firewall page.');
    const without = await render(banner, { ...base, status: { running: true, agent_online: true } });
    expect(without).toContain('Coverage gap');
    expect(without).not.toContain('Map capacity');
  });

  test('the trace view renders the component for the trace maps', () => {
    expect(src('lib/components/runtime/AgentView.svelte')).toContain('<MapCapacity sizing={status.map_sizing} />');
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
