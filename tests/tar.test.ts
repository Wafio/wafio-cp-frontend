import { expect, test } from 'bun:test';
import { createTar } from '../src/lib/tar';

const dec = new TextDecoder();
const field = (b: Uint8Array, off: number, len: number) => dec.decode(b.subarray(off, off + len)).replace(/\0.*$/s, '');

test('ustar headers, padding and terminator', () => {
  const tar = createTar([
    { name: 'ca.crt', content: 'CA\n' },
    { name: 'client.key', content: 'K'.repeat(600), mode: 0o600 },
  ], 1_700_000_000);
  // 2 headers + 1 + 2 data blocks + 2 terminator blocks
  expect(tar.length).toBe(512 * 7);
  expect(field(tar, 0, 100)).toBe('ca.crt');
  expect(parseInt(field(tar, 124, 12), 8)).toBe(3);
  expect(field(tar, 257, 6)).toBe('ustar');
  expect(dec.decode(tar.subarray(512, 515))).toBe('CA\n');
  const second = 1024;
  expect(field(tar, second, 100)).toBe('client.key');
  expect(parseInt(field(tar, second + 100, 8), 8)).toBe(0o600);
  expect(parseInt(field(tar, second + 124, 12), 8)).toBe(600);
  expect(tar.subarray(512 * 5).every((b) => b === 0)).toBe(true);
});

test('header checksum matches the ustar definition', () => {
  const tar = createTar([{ name: 'client.crt', content: 'x' }], 0);
  const h = tar.slice(0, 512);
  const stored = parseInt(field(h, 148, 8).trim(), 8);
  h.fill(0x20, 148, 156);
  expect(h.reduce((s, b) => s + b, 0)).toBe(stored);
});

test('rejects names that do not fit the ustar name field', () => {
  expect(() => createTar([{ name: '', content: '' }])).toThrow();
  expect(() => createTar([{ name: 'a'.repeat(101), content: '' }])).toThrow();
});
