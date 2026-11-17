// Minimal ustar writer for small text bundles generated in the browser (e.g.
// an agent credential bundle). One archive = one download, so browsers that
// block multiple automatic downloads from a single click still deliver every
// file. Regular files only, flat names ≤ 100 bytes.

export interface TarEntry {
  name: string;
  content: string;
  mode?: number; // POSIX permission bits, default 0o644
}

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(buf: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  buf.set(bytes.subarray(0, length), offset);
}

// Numeric header fields are zero-padded octal terminated by NUL.
function writeOctal(buf: Uint8Array, offset: number, length: number, value: number) {
  writeString(buf, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

function header(entry: TarEntry, size: number, mtime: number): Uint8Array {
  const name = encoder.encode(entry.name);
  if (name.length === 0 || name.length > 100) {
    throw new Error(`tar: entry name must be 1-100 bytes: ${entry.name}`);
  }
  const h = new Uint8Array(BLOCK);
  h.set(name, 0);
  writeOctal(h, 100, 8, entry.mode ?? 0o644);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156); // checksum is computed with its own field as spaces
  h[156] = 0x30; // typeflag '0' = regular file
  writeString(h, 257, 6, 'ustar\0');
  writeString(h, 263, 2, '00');
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

/** Builds a ustar archive; mtime is Unix seconds (injectable for tests). */
export function createTar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const data = encoder.encode(entry.content);
    const padded = Math.ceil(data.length / BLOCK) * BLOCK;
    const body = new Uint8Array(padded);
    body.set(data);
    parts.push(header(entry, data.length, mtime), body);
    total += BLOCK + padded;
  }
  const out = new Uint8Array(total + 2 * BLOCK); // two zero blocks end the archive
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
