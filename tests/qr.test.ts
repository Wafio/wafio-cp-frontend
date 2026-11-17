import { describe, expect, test } from 'bun:test';
import { qrSvg } from '../src/lib/qr';

const url = 'otpauth://totp/Wafio:user%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Wafio&period=30';

describe('QR code for the authenticator app', () => {
  test('draws an SVG about 200 px wide, whatever the length of the URL', () => {
    for (const text of [url, `${url}&extra=${'x'.repeat(80)}`]) {
      const svg = qrSvg(text);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('<path');
      const width = Number(/width="(\d+)px"/.exec(svg)?.[1]);
      expect(width).toBeGreaterThan(150);
      expect(width).toBeLessThanOrEqual(200);
    }
  });

  test('is deterministic', () => {
    expect(qrSvg(url)).toBe(qrSvg(url));
  });
});
