// The FastCGI keep-alive switch as the routing form renders it, on the server without a DOM. The warning must give a
// minimum PHP release for each series, so an operator on 8.3.20 cannot read "newer than 8.2.36" as safe.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { cloudflareHint, emptyRouteForm } from '../src/lib/components/apps/route-model';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { default: AppRouteForm } = await import('../src/lib/components/apps/AppRouteForm.svelte');

async function render(upstreamType: 'fcgi' | 'http', fcgiKeepConn = false): Promise<string> {
  const initial = { ...emptyRouteForm(), upstreamType, fcgiKeepConn };
  return renderComponent(AppRouteForm, { initial, onsubmit: async () => null } as never);
}

describe('FastCGI keep-alive switch', () => {
  test('names the minimum PHP release of each series and the agents that ignore it', async () => {
    const html = await render('fcgi');
    expect(html).toContain('Keep FastCGI connections open between requests');
    expect(html).toContain('at least 8.2.36, 8.3.37, 8.4.28 or 8.5.13 for its 8.2, 8.3, 8.4 or 8.5 series');
    expect(html).toContain('8.1 and older are not fixed');
    expect(html).not.toContain('or newer');
    expect(html).toContain('Agents released before this option ignore it and keep connections open.');
  });

  test('shows the stored state', async () => {
    const tag = (html: string) => /Keep FastCGI connections open between requests<\/label>[\s\S]*?(<button[^>]*role="switch"[^>]*>)/.exec(html)?.[1] ?? '';
    expect(tag(await render('fcgi', false))).toContain('aria-checked="false"');
    expect(tag(await render('fcgi', true))).toContain('aria-checked="true"');
  });

  test('is not offered for an HTTP upstream', async () => {
    expect(await render('http')).not.toContain('Keep FastCGI connections');
  });
});

describe('Trusted proxies, Cloudflare preset', () => {
  const props = (over: object = {}) => ({ initial: emptyRouteForm(), onsubmit: async () => null, ...over }) as never;

  test('is offered beside the list with its hint, and no dialog is open', async () => {
    const html = await renderComponent(AppRouteForm, props());
    expect(html.indexOf('Trusted proxies')).toBeGreaterThan(-1);
    expect(html.indexOf("Use Cloudflare's addresses")).toBeGreaterThan(html.indexOf('Trusted proxies'));
    expect(html).toContain(cloudflareHint());
    expect(html).not.toContain('Replace the trusted proxies?');
  });

  test('cannot be used on a read-only form', async () => {
    const html = await renderComponent(AppRouteForm, props({ disabled: true }));
    const open = html.search(/<fieldset[^>]*route-fieldset[^>]*disabled/);
    expect(open).toBeGreaterThan(-1);
    // Between that fieldset and the button every nested fieldset is closed again, so the button is still inside it.
    const before = html.slice(open, html.indexOf("Use Cloudflare's addresses"));
    expect(before.match(/<fieldset[\s>]/g)?.length).toBe((before.match(/<\/fieldset>/g)?.length ?? 0) + 1);
  });
});
