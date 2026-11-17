import { describe, expect, test } from 'bun:test';
import {
  ipToBytes,
  ipVersion,
  isAES256Key,
  isCIDR,
  isHeaderName,
  isIP,
  isIPOrCIDR,
  isIPv4,
  isIPv6,
  isPort,
  isURL,
  parseByteSize,
  parseCIDR,
  parseIPList,
  parseList,
  parsePortList,
  validateAES256Key,
  validateByteSize,
  validateKeyFields,
  validateURL,
} from '../src/lib/validation';

describe('IPv4', () => {
  test('valid addresses', () => {
    for (const ip of ['0.0.0.0', '1.2.3.4', '10.0.0.1', '192.168.100.200', '255.255.255.255']) expect(isIPv4(ip)).toBe(true);
  });
  test('invalid addresses', () => {
    for (const ip of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-1', '01.2.3.4', '1.2.3.04', '1..3.4', ' 1.2.3.4', '1.2.3.4 ', 'a.b.c.d', '1.2.3.4/32', '0x1.2.3.4']) {
      expect(isIPv4(ip)).toBe(false);
    }
  });
});

describe('IPv6', () => {
  test('valid addresses including compression and IPv4 tails', () => {
    for (const ip of [
      '::',
      '::1',
      '1::',
      '2001:db8::1',
      '2001:0db8:0000:0000:0000:ff00:0042:8329',
      '1:2:3:4:5:6:7:8',
      '1:2:3:4:5:6:7::',
      '::2:3:4:5:6:7:8',
      'fe80::',
      'FE80::ABCD',
      '::ffff:192.0.2.1',
      '::192.0.2.1',
      '64:ff9b::192.0.2.33',
      '1:2:3:4:5:6:1.2.3.4',
      'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255',
    ]) {
      expect(isIPv6(ip)).toBe(true);
    }
  });

  test('invalid addresses the old validator accepted or mishandled', () => {
    for (const ip of [
      '',
      ':',
      ':::',
      '1::2::3',
      '::1::',
      ':1::',
      '1:',
      ':1:2:3:4:5:6:7:8',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7:8::',
      '::1:2:3:4:5:6:7:8',
      '12345::',
      'g::1',
      '1.2.3.4::',
      '::ffff:1.2.3',
      '::ffff:256.0.0.1',
      '::ffff:1.2.3.4:5',
      '1:2:3:4:5:6:7:1.2.3.4',
      'fe80::1%eth0',
      '[::1]',
      '::1/128',
      ' ::1',
    ]) {
      expect(isIPv6(ip)).toBe(false);
    }
  });

  test('version detection', () => {
    expect(ipVersion('1.2.3.4')).toBe(4);
    expect(ipVersion('::1')).toBe(6);
    expect(ipVersion('example.com')).toBeNull();
    expect(isIP('2001:db8::')).toBe(true);
  });

  test('byte expansion', () => {
    expect(ipToBytes('10.0.0.255')).toEqual([10, 0, 0, 255]);
    expect(ipToBytes('::1')).toEqual([...Array(15).fill(0), 1]);
    expect(ipToBytes('::ffff:192.0.2.1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 0, 2, 1]);
    expect(ipToBytes('2001:db8::8:800:200c:417a')).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0x08, 0x08, 0x00, 0x20, 0x0c, 0x41, 0x7a]);
    expect(ipToBytes('nope')).toBeNull();
  });
});

describe('CIDR', () => {
  test('parses both families and prefix bounds', () => {
    expect(parseCIDR('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8, version: 4, hostBitsSet: false });
    expect(parseCIDR('2001:db8::/32')).toEqual({ address: '2001:db8::', prefix: 32, version: 6, hostBitsSet: false });
    expect(parseCIDR('0.0.0.0/0')?.prefix).toBe(0);
    expect(parseCIDR('::/0')?.prefix).toBe(0);
    expect(parseCIDR('::1/128')?.prefix).toBe(128);
    expect(isCIDR('1.2.3.4/32')).toBe(true);
  });

  test('rejects malformed ranges', () => {
    for (const cidr of ['10.0.0.0', '10.0.0.0/', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/08', '10.0.0.0/8/8', '2001:db8::/129', '/24', 'x/24', '10.0.0.0/ 8', '1::2::3/64']) {
      expect(isCIDR(cidr)).toBe(false);
    }
  });

  test('host bits are reported and rejected in strict mode', () => {
    expect(parseCIDR('10.0.0.1/24')?.hostBitsSet).toBe(true);
    expect(isCIDR('10.0.0.1/24')).toBe(true);
    expect(isCIDR('10.0.0.1/24', { strict: true })).toBe(false);
    expect(isCIDR('2001:db8::1/64', { strict: true })).toBe(false);
    expect(isCIDR('2001:db8::/64', { strict: true })).toBe(true);
    expect(isCIDR('10.0.0.1/32', { strict: true })).toBe(true);
  });

  test('address or range', () => {
    expect(isIPOrCIDR('1.2.3.4')).toBe(true);
    expect(isIPOrCIDR('1.2.3.0/24')).toBe(true);
    expect(isIPOrCIDR('::1')).toBe(true);
    expect(isIPOrCIDR('1.2.3.4/33')).toBe(false);
  });
});

describe('lists', () => {
  test('newline and comma lists with comments and duplicates', () => {
    const text = '# office\n1.2.3.4, 5.6.7.8\n\n  1.2.3.4  \n10.0.0.0/8 # vpn\r\n';
    expect(parseList(text)).toEqual(['1.2.3.4', '5.6.7.8', '10.0.0.0/8']);
    expect(parseList(text, { dedupe: false })).toEqual(['1.2.3.4', '5.6.7.8', '1.2.3.4', '10.0.0.0/8']);
    expect(parseList('A\na', { caseInsensitive: true })).toEqual(['A']);
    expect(parseList('Mozilla/5.0 (X11, Linux)\ncurl/8', { separators: /\n+/ })).toEqual(['Mozilla/5.0 (X11, Linux)', 'curl/8']);
    expect(parseList(null)).toEqual([]);
    expect(parseList([' a ', '', 'b'])).toEqual(['a', 'b']);
  });

  test('IP lists report invalid entries', () => {
    expect(parseIPList('1.2.3.4\nnot-an-ip\n2001:db8::/32\n1::2::3')).toEqual({ valid: ['1.2.3.4', '2001:db8::/32'], invalid: ['not-an-ip', '1::2::3'] });
  });
});

describe('WAF key fields', () => {
  test('known fields and header keys', () => {
    expect(validateKeyFields('remote_addr, user_agent')).toEqual({ fields: ['remote_addr', 'user_agent'], error: null });
    expect(validateKeyFields(['host', 'header:X-Request-ID'])).toEqual({ fields: ['host', 'header:X-Request-ID'], error: null });
  });

  test('errors name the offending entry', () => {
    expect(validateKeyFields('remote_addr, cookie').error).toContain('"cookie"');
    expect(validateKeyFields('header:').error).toContain('header:Header-Name');
    expect(validateKeyFields('header:X Bad').error).toContain('"header:X Bad"');
    expect(validateKeyFields(' , ').error).toBe('Enter at least one key field.');
  });

  test('header names are RFC 9110 tokens', () => {
    expect(isHeaderName('X-Api-Key')).toBe(true);
    expect(isHeaderName('X Api')).toBe(false);
    expect(isHeaderName('X:Api')).toBe(false);
    expect(isHeaderName('')).toBe(false);
  });
});

describe('byte sizes', () => {
  test('parses bytes with binary units', () => {
    expect(parseByteSize('1048576')).toBe(1048576);
    expect(parseByteSize('512 KB')).toBe(524288);
    expect(parseByteSize('10MiB')).toBe(10 * 1024 * 1024);
    expect(parseByteSize('1.5 GB')).toBe(1.5 * 1024 ** 3);
    expect(parseByteSize('0')).toBe(0);
    expect(parseByteSize(4096)).toBe(4096);
  });

  test('rejects malformed sizes', () => {
    for (const value of ['', 'abc', '-1', '1.5', '10 XB', '1e3', 1.5, -2, null, undefined]) {
      expect(parseByteSize(value as never)).toBeNull();
    }
  });

  test('range validation', () => {
    expect(validateByteSize('1 MB', { min: 1024, max: 8 * 1024 * 1024 })).toBeNull();
    expect(validateByteSize('16 MB', { max: 8 * 1024 * 1024, label: 'Body limit' })).toBe('Body limit must be at most 8388608 bytes.');
    expect(validateByteSize('lots')).toContain('whole number of bytes');
  });
});

describe('AES-256 keys', () => {
  const key = 'a'.repeat(64);
  test('64 hex characters', () => {
    expect(isAES256Key(key)).toBe(true);
    expect(isAES256Key('0123456789ABCDEFabcdef'.padEnd(64, '0'))).toBe(true);
    expect(isAES256Key('a'.repeat(63))).toBe(false);
    expect(isAES256Key('g'.repeat(64))).toBe(false);
    expect(isAES256Key('a'.repeat(65))).toBe(false);
  });
  test('messages', () => {
    expect(validateAES256Key('')).toBeNull();
    expect(validateAES256Key('', { required: true })).toContain('required');
    expect(validateAES256Key('abc', { label: 'Field key' })).toBe('Field key must be exactly 64 hexadecimal characters.');
    expect(validateAES256Key(` ${key} `)).toBeNull();
  });
});

describe('URLs and ports', () => {
  test('http(s) URLs with a host and no credentials', () => {
    expect(isURL('https://siem.example.com/hook')).toBe(true);
    expect(isURL('http://10.0.0.5:8080')).toBe(true);
    expect(isURL('ftp://example.com')).toBe(false);
    expect(isURL('https://user:pass@example.com')).toBe(false);
    expect(isURL('example.com')).toBe(false);
    expect(isURL('https://exa mple.com')).toBe(false);
    expect(isURL('wss://example.com', { protocols: ['wss'] })).toBe(true);
    expect(validateURL('', { required: true, label: 'Webhook URL' })).toBe('Webhook URL is required.');
    expect(validateURL('javascript:alert(1)')).toBe('URL must be a valid http or https URL.');
  });

  test('ports', () => {
    expect(isPort(1)).toBe(true);
    expect(isPort('65535')).toBe(true);
    expect(isPort(0)).toBe(false);
    expect(isPort(0, { allowZero: true })).toBe(true);
    expect(isPort(65536)).toBe(false);
    expect(isPort('80.5')).toBe(false);
    expect(isPort('')).toBe(false);
    expect(isPort(-1)).toBe(false);
  });

  test('port lists and ranges', () => {
    expect(parsePortList('22, 80,8000-8100')).toEqual([{ from: 22, to: 22 }, { from: 80, to: 80 }, { from: 8000, to: 8100 }]);
    expect(parsePortList('8100-8000')).toBeNull();
    expect(parsePortList('22, http')).toBeNull();
    expect(parsePortList('')).toBeNull();
  });
});
