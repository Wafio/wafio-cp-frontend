// The logo of the header: the portal's mark as an image with a size and no alternative text, and the wordmark as text.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { renderComponent } from './support/ssr';

const { default: BrandLogo } = await import('../src/lib/components/BrandLogo.svelte');

const staticFile = (name: string) => new URL(`../static/${name}`, import.meta.url).pathname;

describe('BrandLogo', () => {
  test('draws the mark as a decorative image with a width and a height, and the name as text', async () => {
    const html = await renderComponent(BrandLogo, { size: 38 } as never);
    expect(html).toMatch(/<img[^>]*src="\/app\/logo-only\.png"/);
    expect(html).toContain('alt=""');
    expect(html).toContain('width="36"');
    expect(html).toContain('height="38"');
    expect(html).toContain('>WAFio</span>');
    expect(html).not.toContain('<svg');
  });

  test('keeps the proportions of the file at any size', async () => {
    for (const [size, width] of [[24, 23], [34, 32], [38, 36], [48, 46]] as const) {
      const html = await renderComponent(BrandLogo, { size } as never);
      expect(html).toContain(`width="${width}"`);
      expect(html).toContain(`height="${size}"`);
    }
  });

  test('the file is the portal logo, 228 by 240 pixels, and the other brand files are in place', async () => {
    const header = new Uint8Array(await Bun.file(staticFile('logo-only.png')).slice(0, 24).arrayBuffer());
    expect([...header.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(header.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([228, 240]);
    for (const name of ['logo.png', 'logo-thumb.png', 'favicon.svg', 'favicon.ico']) expect(await Bun.file(staticFile(name)).exists()).toBe(true);
  });

  test('the page head names the control plane, with the portal social image and no font host', async () => {
    const html = await Bun.file(new URL('../src/app.html', import.meta.url).pathname).text();
    expect(html).toContain('<meta property="og:image" content="https://wafio.cloud/logo-thumb.png" />');
    expect(html).toContain('<meta property="og:title" content="WAFio control plane" />');
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).not.toContain('n/a');
  });
});
