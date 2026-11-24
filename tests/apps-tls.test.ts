import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ApiError, ApiResult, AppTLSCertificate, AppTLSCertificateInput, AppTLSInput, AppTLSState, AppTLSStatus } from '../src/lib/api';
import {
  ACME_REQUEST_GAP_MS,
  NO_REPORT_AFTER_MS,
  OWN_LISTENER,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  TLS_LIMITS,
  backToProxyText,
  canonicalListen,
  certificateCoversHost,
  checkTLSFit,
  chooseMode,
  classifyTLSRefusal,
  confirmFor,
  createEpoch,
  currentStatus,
  dnsWarningText,
  expiryOf,
  formFromTLS,
  gatewayChecks,
  gatewaySteps,
  inputFromForm,
  listenersOverlap,
  mergeEdits,
  mergePoll,
  noReportYet,
  noticeText,
  normalizeTLS,
  pollIntervalMs,
  portsText,
  readPemFile,
  renewalStart,
  requestOpensAt,
  retryUntil,
  sameTLS,
  savedInGatewayText,
  sendCertificate,
  setRedirect,
  sourceChangeText,
  sourceSwitchText,
  switchDisabled,
  tlsNotices,
  tlsProblem,
  trustText,
  waitingSince,
  withoutDnsHints,
  type CertificateForm,
  type CheckState,
  type TLSCheck,
} from '../src/lib/components/apps/tls';

// The control plane's cases (domain.TLSSettings.Normalize and CertificateCoversHost).
interface NormalizeCase {
  name: string;
  in: AppTLSInput;
  result?: AppTLSInput;
  field?: string;
  message?: string;
}
const backend = JSON.parse(readFileSync(new URL('./fixtures/backend/tls-checks.json', import.meta.url), 'utf8')) as {
  normalize: NormalizeCase[];
  covers_host: { names: string[]; host: string; covered: boolean }[];
};

const NON_ASCII = /[^\u0000-\u007f]/;
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function input(over: Partial<AppTLSInput> = {}): AppTLSInput {
  return { mode: 'gateway', hosts: ['a.example.com'], listen: '', redirect_listen: '', source: 'uploaded', ...over };
}

function certificate(over: Partial<AppTLSCertificate> = {}): AppTLSCertificate {
  return {
    id: 'cert-1',
    source: 'uploaded',
    names: ['shop.example.com'],
    issuer: 'Example CA',
    not_before: iso(NOW - 10 * 24 * HOUR),
    not_after: iso(NOW + 80 * 24 * HOUR),
    days_left: 80,
    leaf_sha256: 'a'.repeat(64),
    key_type: 'ecdsa-p256',
    trusted: true,
    created_at: iso(NOW - HOUR),
    ...over,
  };
}

function status(over: Partial<AppTLSStatus> = {}): AppTLSStatus {
  return {
    agent_id: 'agent-1',
    source: 'acme',
    state: 'active',
    certificate_id: null,
    leaf_sha256: 'b'.repeat(64),
    error: '',
    next_attempt_at: null,
    request_id: 'req-1',
    received_at: iso(NOW - MINUTE),
    names: ['shop.example.com'],
    issuer: 'Example CA',
    not_before: null,
    not_after: null,
    ...over,
  };
}

function state(over: Partial<AppTLSState> = {}): AppTLSState {
  return {
    mode: 'gateway',
    hosts: ['shop.example.com'],
    listen: '0.0.0.0:443',
    redirect_listen: '',
    source: 'acme',
    certificate: null,
    acme: { request_id: 'req-1', requested_at: iso(NOW - 30 * MINUTE) },
    status: status(),
    agent_supported: true,
    agent_host_bound: true,
    warnings: [],
    ...over,
  };
}

describe('control plane parity', () => {
  test('the fixture holds the characters Go and JavaScript fold differently', () => {
    const text = JSON.stringify(backend);
    for (const ch of ['\u0130', '\ufeff', '\u0085', '\u212a']) expect(text).toContain(ch);
  });

  test('every ASCII case of Normalize gets the stored form or the refusal of the server', () => {
    const judged = backend.normalize.filter((c) => !NON_ASCII.test(JSON.stringify(c.in)));
    expect(judged.length).toBeGreaterThanOrEqual(62);
    for (const c of judged) {
      const got = normalizeTLS(c.in);
      if (c.result) expect({ name: c.name, got: got.settings, error: got.error }).toEqual({ name: c.name, got: c.result, error: undefined });
      else expect({ name: c.name, error: got.error }).toEqual({ name: c.name, error: { field: c.field, message: c.message } });
    }
  });

  test('a case with a non-ASCII value is never refused when the server takes it', () => {
    const unjudged = backend.normalize.filter((c) => NON_ASCII.test(JSON.stringify(c.in)));
    expect(unjudged.length).toBeGreaterThanOrEqual(5);
    for (const c of unjudged) {
      if (c.result) expect({ name: c.name, error: normalizeTLS(c.in).error }).toEqual({ name: c.name, error: undefined });
    }
  });

  test('coverage agrees with the server', () => {
    expect(backend.covers_host.length).toBeGreaterThanOrEqual(79);
    for (const c of backend.covers_host) {
      expect({ ...c, got: certificateCoversHost(c.names, c.host) }).toEqual({ ...c, got: c.covered });
    }
  });
});

describe('ASCII-only folding', () => {
  const hosts = (...list: string[]) => normalizeTLS(input({ hosts: list }));

  test('ASCII letters are lower-cased and ASCII white space is trimmed', () => {
    expect(hosts('\t Shop.EXAMPLE.com\r\n').settings?.hosts).toEqual(['shop.example.com']);
  });

  test('other characters stay as typed and go to the server', () => {
    expect(hosts('Shop.İ.example.com').settings?.hosts).toEqual(['shop.İ.example.com']);
    expect(hosts('a.example.com﻿').settings?.hosts).toEqual(['a.example.com﻿']);
    expect(hosts('\u0085a.example.com ').settings?.hosts).toEqual(['\u0085a.example.com ']);
  });

  test('the host limit is judged only when every name was', () => {
    const many = Array.from({ length: TLS_LIMITS.hosts + 1 }, (_, i) => `h${i}.example.com`);
    expect(hosts(...many).error).toEqual({ field: 'hosts', message: 'at most 100 hosts' });
    expect(hosts(...many.slice(0, TLS_LIMITS.hosts), 'İ.example.com').error).toBeUndefined();
  });

  test('a listener with a non-ASCII character is left to the server', () => {
    expect(normalizeTLS(input({ listen: ' 10.0.0.1:443' })).settings?.listen).toBe(' 10.0.0.1:443');
  });
});

describe('listeners', () => {
  test('two addresses on one port overlap when one is a wildcard', () => {
    const overlap: [string, string][] = [
      ['0.0.0.0:443', '10.0.0.1:443'],
      ['10.0.0.1:443', '0.0.0.0:443'],
      ['[::]:443', '10.0.0.1:443'],
      ['[::]:443', '[2001:db8::1]:443'],
      ['[::]:443', '0.0.0.0:443'],
    ];
    for (const [a, b] of overlap) expect({ a, b, overlap: listenersOverlap(a, b) }).toEqual({ a, b, overlap: true });
  });

  test('the same address, other ports, other families and two specific addresses do not overlap', () => {
    const apart: [string, string][] = [
      ['0.0.0.0:443', '0.0.0.0:443'],
      ['0.0.0.0:443', '10.0.0.1:8443'],
      ['0.0.0.0:443', '[2001:db8::1]:443'],
      ['0.0.0.0:443', '[::ffff:10.0.0.1]:443'],
      ['10.0.0.1:443', '10.0.0.2:443'],
      ['', '0.0.0.0:443'],
      ['0.0.0.0:443', 'not an address'],
    ];
    for (const [a, b] of apart) expect({ a, b, overlap: listenersOverlap(a, b) }).toEqual({ a, b, overlap: false });
  });

  test('canonical form follows Go', () => {
    expect(canonicalListen('[2001:0db8:0:0:1:0:0:1]:0443')).toBe('[2001:db8::1:0:0:1]:443');
    expect(canonicalListen('[1:0:2:3:4:5:6:7]:80')).toBe('[1:0:2:3:4:5:6:7]:80');
    expect(canonicalListen('[0:0:0:0:0:0:0:0]:80')).toBe('[::]:80');
    expect(canonicalListen('[::ffff:a00:5]:80')).toBe('[::ffff:10.0.0.5]:80');
    expect(canonicalListen('[::1.2.3.4]:80')).toBe('[::102:304]:80');
    for (const bad of ['', '0.0.0.0', '0.0.0.0:0', '0.0.0.0:65536', '::1:443', '[1.2.3.4]:80', '[fe80::1%eth0]:80', '01.2.3.4:80']) {
      expect({ bad, got: canonicalListen(bad) }).toEqual({ bad, got: null });
    }
  });

  test('the own listener of the application counts in the fit check', () => {
    const own = 'The listen address on the Routing tab of this application uses it.';
    const settings = { listen: '0.0.0.0:443', redirect_listen: '0.0.0.0:80' };
    expect(checkTLSFit(settings, { host: '', port: 8080 })).toBeNull();
    expect(checkTLSFit(settings, { host: '', port: null })).toBeNull();
    expect(checkTLSFit(settings, { host: '', port: 443 })).toEqual({ field: 'listen', message: own });
    expect(checkTLSFit(settings, { host: '127.0.0.1', port: 443 })).toEqual({ field: 'listen', message: own });
    expect(checkTLSFit(settings, { host: '0.0.0.0', port: 80 })).toEqual({ field: 'redirect_listen', message: own });
    expect(checkTLSFit({ listen: '[::]:443', redirect_listen: '' }, { host: '::1', port: 443 })).toEqual({ field: 'listen', message: own });
    expect(checkTLSFit({ listen: '10.0.0.5:443', redirect_listen: '' }, { host: '10.0.0.6', port: 443 })).toBeNull();
  });
});

describe('coverage of the host names', () => {
  test('a name matches exactly, or a wildcard matches one label', () => {
    expect(certificateCoversHost(['shop.example.com'], 'SHOP.example.com')).toBe(true);
    expect(certificateCoversHost(['*.example.com'], 'shop.example.com')).toBe(true);
    expect(certificateCoversHost(['*.example.com'], 'example.com')).toBe(false);
    expect(certificateCoversHost(['*.example.com'], 'a.b.example.com')).toBe(false);
    expect(certificateCoversHost([], 'shop.example.com')).toBe(false);
  });

  test('only A to Z fold, so a look-alike character covers nothing', () => {
    expect(certificateCoversHost(['istanbul.example.com', 'kyoto.example.com'], '\u0130stanbul.example.com')).toBe(false);
    expect(certificateCoversHost(['istanbul.example.com', 'kyoto.example.com'], '\u212ayoto.example.com')).toBe(false);
    expect(certificateCoversHost(['m\u00fcnchen.de', '*.example.com'], 'shop.example.com')).toBe(true);
    expect(certificateCoversHost(['M\u00dcNCHEN.de'], 'm\u00fcnchen.de')).toBe(false);
  });
});

describe('expiry', () => {
  test('5 hours left is the last day, shown in hours', () => {
    expect(expiryOf(iso(NOW + 5 * HOUR), NOW)).toEqual({ expired: false, days: 0, hours: 5 });
  });

  test('1 hour past is expired, and days round down as the server does', () => {
    expect(expiryOf(iso(NOW - HOUR), NOW)).toEqual({ expired: true, days: -1, hours: 0 });
    expect(expiryOf(iso(NOW), NOW)).toEqual({ expired: true, days: 0, hours: 0 });
  });

  test('a part of an hour counts as an hour and 36 hours are one day', () => {
    expect(expiryOf(iso(NOW + 30 * MINUTE), NOW)?.hours).toBe(1);
    expect(expiryOf(iso(NOW + 36 * HOUR), NOW)).toEqual({ expired: false, days: 1, hours: 36 });
  });

  test('something that is not a date gives nothing', () => {
    expect(expiryOf('soon', NOW)).toBeNull();
  });
});

describe('renewal start', () => {
  test('a third of the lifetime before the end', () => {
    const at = renewalStart('2026-11-01T00:00:00Z', '2027-01-30T00:00:00Z');
    expect(at === null ? null : iso(at)).toBe('2026-12-31T00:00:00.000Z');
  });

  test('without a start, or with an end before it, there is no date', () => {
    expect(renewalStart(null, '2027-01-30T00:00:00Z')).toBeNull();
    expect(renewalStart('2027-01-30T00:00:00Z', '2026-11-01T00:00:00Z')).toBeNull();
    expect(renewalStart('2026-11-01T00:00:00Z', null)).toBeNull();
  });
});

describe('request window', () => {
  test('5 minutes after the last request', () => {
    const requested = iso(NOW - MINUTE);
    expect(requestOpensAt(requested, null, NOW)).toBe(NOW - MINUTE + ACME_REQUEST_GAP_MS);
    expect(requestOpensAt(iso(NOW - 6 * MINUTE), null, NOW)).toBeLessThan(NOW);
    expect(requestOpensAt(null, null, NOW)).toBe(0);
  });

  test('the wait a refusal named comes first, while it runs', () => {
    const requested = iso(NOW - MINUTE);
    expect(requestOpensAt(requested, NOW + 20_000, NOW)).toBe(NOW + 20_000);
    expect(requestOpensAt(requested, NOW + 3600_000, NOW)).toBe(NOW + 3600_000);
    expect(requestOpensAt(requested, NOW - 1, NOW)).toBe(NOW - MINUTE + ACME_REQUEST_GAP_MS);
  });

  test('retry_after of a 409 ACME_REQUEST_TOO_SOON is a time, nothing else is', () => {
    const tooSoon: ApiError = { kind: 'http', status: 409, error: 'wait', code: 'ACME_REQUEST_TOO_SOON', retry_after: 90 };
    expect(retryUntil(tooSoon, NOW)).toBe(NOW + 90_000);
    expect(retryUntil({ ...tooSoon, code: 'LISTEN_CONFLICT' }, NOW)).toBeNull();
    expect(retryUntil({ ...tooSoon, retry_after: undefined }, NOW)).toBeNull();
    expect(retryUntil(undefined, NOW)).toBeNull();
  });
});

describe('current status', () => {
  const uploaded = (over: Partial<AppTLSState> = {}) =>
    state({ source: 'uploaded', certificate: certificate(), acme: null, status: status({ source: 'uploaded', certificate_id: 'cert-1', request_id: '' }), ...over });

  test('a Let\'s Encrypt report is current for the saved request id', () => {
    const s = state();
    expect(currentStatus(s)).toBe(s.status);
    expect(currentStatus(state({ status: status({ request_id: 'req-0' }) }))).toBeNull();
    expect(currentStatus(state({ acme: null }))).toBeNull();
    expect(currentStatus(state({ acme: { request_id: '', requested_at: null }, status: status({ request_id: '' }) }))).toBeNull();
  });

  test('an uploaded report is current for the saved certificate id', () => {
    const s = uploaded();
    expect(currentStatus(s)).toBe(s.status);
    expect(currentStatus(uploaded({ certificate: certificate({ id: 'cert-2' }) }))).toBeNull();
    expect(currentStatus(uploaded({ certificate: null }))).toBeNull();
    expect(currentStatus(uploaded({ status: status({ source: 'uploaded', certificate_id: null }) }))).toBeNull();
  });

  test('the old row of another source is never current, whatever its ids say', () => {
    expect(currentStatus(uploaded({ status: status({ source: 'acme', request_id: 'req-1', certificate_id: 'cert-1' }), acme: { request_id: 'req-1', requested_at: null } }))).toBeNull();
    expect(currentStatus(state({ source: '' }))).toBeNull();
  });
});

describe('poll merge', () => {
  const dns = { code: 'dns_mismatch' as const, host: 'shop.example.com', resolved: ['203.0.113.7'], agent_addresses: ['203.0.113.9'] };
  const soon = { code: 'expires_soon' as const, days_left: 3 };

  test('the server state replaces the old one, the DNS hints of the last save stay', () => {
    const current = state({ warnings: [dns, { code: 'not_trusted' }] });
    const polled = state({ status: status({ state: 'pending' }), warnings: [soon] });
    expect(mergePoll(current, polled)).toEqual({ ...polled, warnings: [soon, dns] });
  });

  test('a poll without hints on a state without hints changes nothing else', () => {
    const polled = state({ warnings: [soon] });
    expect(mergePoll(state(), polled)).toEqual(polled);
  });

  test('the page keeps the state without the DNS hints, and every other warning', () => {
    const dns = { code: 'dns_mismatch' as const, host: 'shop.example.com', resolved: ['203.0.113.7'], agent_addresses: ['203.0.113.9'] };
    const soon = { code: 'expires_soon' as const, days_left: 3 };
    const kept = withoutDnsHints(state({ warnings: [dns, soon, { ...dns, host: 'www.example.com' }] }));
    expect(kept.warnings).toEqual([soon]);
    expect(kept).toEqual(state({ warnings: [soon] }));
    // A poll on the state the page kept brings none back.
    expect(mergePoll(kept, state({ warnings: [] })).warnings).toEqual([]);
  });

  test('an edited field stays, the others follow the poll', () => {
    const base = { hosts: 'a.example.com', listen: '', source: 'acme' };
    const draft = { hosts: 'a.example.com\nb.example.com', listen: '', source: 'acme' };
    const polled = { hosts: 'c.example.com', listen: '0.0.0.0:8443', source: 'uploaded' };
    expect(mergeEdits(draft, base, polled)).toEqual({ hosts: 'a.example.com\nb.example.com', listen: '0.0.0.0:8443', source: 'uploaded' });
    expect(mergeEdits(base, base, polled)).toEqual(polled);
  });
});

describe('epoch', () => {
  test('an answer that was asked for before a newer one is late', () => {
    const epoch = createEpoch();
    const first = epoch.next();
    const second = epoch.next();
    expect(epoch.isCurrent(first)).toBe(false);
    expect(epoch.isCurrent(second)).toBe(true);
    epoch.next();
    expect(epoch.isCurrent(second)).toBe(false);
  });
});

describe('cadence and the wait for the agent', () => {
  const interval = (s: AppTLSState, over: { agent?: boolean; action?: number | null } = {}) =>
    pollIntervalMs(s, over.agent ?? true, over.action ?? null, NOW);
  const uploadedWith = (st: AppTLSStatus | null) =>
    state({ source: 'uploaded', certificate: certificate(), acme: null, status: st });

  test('10 seconds until the agent has reported, 60 once it has', () => {
    expect(interval(state({ status: null }))).toBe(POLL_FAST_MS);
    expect(interval(state({ status: status({ request_id: 'old' }) }))).toBe(POLL_FAST_MS);
    expect(interval(state({ status: status({ state: 'pending' }) }))).toBe(POLL_FAST_MS);
    expect(interval(uploadedWith(status({ source: 'uploaded', certificate_id: 'cert-1', state: 'missing' })))).toBe(POLL_FAST_MS);
    expect(interval(state())).toBe(POLL_SLOW_MS);
    expect(interval(state({ status: status({ state: 'failed' }) }))).toBe(POLL_SLOW_MS);
    expect(interval(uploadedWith(status({ source: 'uploaded', certificate_id: 'cert-1', state: 'active' })))).toBe(POLL_SLOW_MS);
  });

  test('10 seconds for 2 minutes after an action, even when the old report is current', () => {
    expect(interval(state(), { action: NOW - 119_000 })).toBe(POLL_FAST_MS);
    expect(interval(state(), { action: NOW - NO_REPORT_AFTER_MS })).toBe(POLL_SLOW_MS);
  });

  test('nothing to wait for behind a proxy or without an agent', () => {
    expect(interval(state({ mode: 'proxy', status: null }), { action: NOW })).toBe(POLL_SLOW_MS);
    expect(interval(state({ status: null }), { agent: false, action: NOW })).toBe(POLL_SLOW_MS);
  });

  test('the 2 minutes count from the later of the request and the last action', () => {
    const requested = NOW - 10 * MINUTE;
    const s = state({ acme: { request_id: 'req-1', requested_at: iso(requested) } });
    expect(waitingSince(s, null)).toBe(requested);
    expect(waitingSince(s, requested + MINUTE)).toBe(requested + MINUTE);
    expect(waitingSince(s, requested - MINUTE)).toBe(requested);
    expect(waitingSince(state({ acme: null }), null)).toBe(0);
  });

  test('an uploaded certificate counts from its upload', () => {
    const s = state({ source: 'uploaded', certificate: certificate({ created_at: iso(NOW - 5 * MINUTE) }), acme: { request_id: 'req-1', requested_at: iso(NOW - 99 * MINUTE) } });
    expect(waitingSince(s, null)).toBe(NOW - 5 * MINUTE);
  });

  test('the agent is late from 2 minutes on', () => {
    const s = state({ acme: { request_id: 'req-1', requested_at: iso(NOW - NO_REPORT_AFTER_MS + 1000) } });
    expect(noReportYet(s, null, NOW)).toBe(false);
    expect(noReportYet(s, null, NOW + 1000)).toBe(true);
    expect(noReportYet(s, NOW, NOW + NO_REPORT_AFTER_MS - 1)).toBe(false);
    expect(noReportYet(state({ acme: null }), null, NOW)).toBe(true);
  });
});

describe('sendCertificate', () => {
  const BEGIN_KEY = '-----BEGIN ' + 'PRIVATE KEY-----';
  const END_KEY = '-----END ' + 'PRIVATE KEY-----';
  const CHAIN = '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n';
  const form = (over: Partial<CertificateForm> = {}): CertificateForm => ({ chain: CHAIN, key: 'KEYTEXT', keyFile: null, ...over });
  const httpError = (status: number, over: Partial<ApiError> = {}): ApiResult<AppTLSCertificate> => ({
    error: { kind: 'http', status, error: 'Refused by the server.', ...over },
  });

  /** A send that records what it was given and answers `answer`. */
  function sender(answer: ApiResult<AppTLSCertificate> | (() => never)) {
    const bodies: AppTLSCertificateInput[] = [];
    const send = async (body: AppTLSCertificateInput) => {
      bodies.push({ ...body });
      return typeof answer === 'function' ? answer() : answer;
    };
    return { send, bodies };
  }

  function expectDropped(f: CertificateForm) {
    expect(f.key).toBe('');
    expect(f.keyFile).toBeNull();
  }

  test('201: the certificate comes back, the chain stays and the key is dropped', async () => {
    const f = form();
    const { send, bodies } = sender({ data: certificate() });
    expect(await sendCertificate(f, send)).toEqual({ ok: true, certificate: certificate() });
    expect(bodies).toEqual([{ chain_pem: CHAIN, key_pem: 'KEYTEXT' }]);
    expect(f.chain).toBe(CHAIN);
    expectDropped(f);
  });

  test('400: the field of the server decides where its text goes', async () => {
    for (const [field, place] of [['chain_pem', 'chain'], ['key_pem', 'key'], ['body', 'form'], [undefined, 'form']] as const) {
      const f = form();
      const outcome = await sendCertificate(f, sender(httpError(400, { code: 'INVALID_CERTIFICATE', field, reason: 'bad_pem' })).send);
      expect({ field, outcome }).toEqual({ field, outcome: { ok: false, aborted: false, place, message: 'Refused by the server.' } });
      expectDropped(f);
    }
  });

  test('409: the codes the dashboard has its own text for', async () => {
    const f = form();
    const notBound = await sendCertificate(f, sender(httpError(409, { code: 'AGENT_NOT_HOST_BOUND' })).send, 'edge-1');
    expect(notBound).toMatchObject({ ok: false, place: 'form' });
    expect(notBound.ok ? '' : notBound.message).toStartWith('edge-1 needs a credential bound to its host to receive an uploaded key.');
    expect(notBound.ok ? '' : notBound.message).toContain('WAFIO_HOST_KEY in /etc/wafio/waf-agent.env');
    expectDropped(f);

    const unnamed = await sendCertificate(form(), sender(httpError(409, { code: 'AGENT_NOT_HOST_BOUND' })).send);
    expect(unnamed.ok ? '' : unnamed.message).toStartWith('The WAF agent needs a credential bound to its host');

    const other = await sendCertificate(form(), sender(httpError(409, { code: 'SOMETHING_ELSE', error: 'The server says so.' })).send);
    expect(other).toEqual({ ok: false, aborted: false, place: 'form', message: 'The server says so.' });
  });

  test('429 and a control plane without an encryption key', async () => {
    const f = form();
    expect(await sendCertificate(f, sender(httpError(429)).send)).toEqual({
      ok: false,
      aborted: false,
      place: 'form',
      message: 'Too many uploads in the last minute. Try again soon.',
    });
    expectDropped(f);
    expect(await sendCertificate(form(), sender(httpError(503, { code: 'KEY_ENCRYPTION_UNAVAILABLE' })).send)).toEqual({
      ok: false,
      aborted: false,
      place: 'form',
      message: 'The control plane cannot store keys: totp.enc_key is not set.',
    });
  });

  test('a failed send keeps the text of the call, an aborted one says nothing', async () => {
    const failed = form();
    expect(await sendCertificate(failed, sender({ error: { kind: 'network', error: 'Unable to reach the server. Please retry.' } }).send)).toEqual({
      ok: false,
      aborted: false,
      place: 'form',
      message: 'Unable to reach the server. Please retry.',
    });
    expectDropped(failed);

    const aborted = form();
    expect(await sendCertificate(aborted, sender({ error: { kind: 'aborted', error: 'Request cancelled' } }).send)).toEqual({ ok: false, aborted: true, place: 'form', message: '' });
    expectDropped(aborted);
  });

  test('a send that throws never puts what it carried into the answer', async () => {
    const thrown = form();
    const outcome = await sendCertificate(thrown, sender(() => { throw new Error('boom KEYTEXT'); }).send);
    expect(outcome).toEqual({ ok: false, aborted: false, place: 'form', message: 'Unable to reach the server. Please retry.' });
    expect(JSON.stringify(outcome)).not.toContain('KEYTEXT');
    expectDropped(thrown);

    const abort = form();
    const stopped = await sendCertificate(abort, sender(() => { throw new DOMException('stopped', 'AbortError'); }).send);
    expect(stopped).toEqual({ ok: false, aborted: true, place: 'form', message: '' });
    expectDropped(abort);
  });

  test('a chain with a private key is not sent and is cleared with the key', async () => {
    const f = form({ chain: `${CHAIN}${BEGIN_KEY}\nQUJD\n${END_KEY}\n` });
    const { send, bodies } = sender({ data: certificate() });
    expect(await sendCertificate(f, send)).toEqual({
      ok: false,
      aborted: false,
      place: 'chain',
      message: 'This text holds a private key. Put only certificates here and the key in the key field.',
    });
    expect(bodies).toEqual([]);
    expect(f.chain).toBe('');
    expectDropped(f);
  });

  test('a key file is read when sending, wins over the text and is dropped', async () => {
    const f = form({ key: '', keyFile: new File(['KEYFROMFILE'], 'server.key') });
    const { send, bodies } = sender({ data: certificate() });
    expect((await sendCertificate(f, send)).ok).toBe(true);
    expect(bodies).toEqual([{ chain_pem: CHAIN, key_pem: 'KEYFROMFILE' }]);
    expectDropped(f);
  });

  test('a key file that is not UTF-8 text is not sent', async () => {
    const f = form({ key: '', keyFile: new File([new Uint8Array([0x30, 0x82, 0x01, 0x0a])], 'server.der') });
    const { send, bodies } = sender({ data: certificate() });
    const outcome = await sendCertificate(f, send);
    expect(outcome).toMatchObject({ ok: false, place: 'key' });
    expect(outcome.ok ? '' : outcome.message).toStartWith('This file is not PEM text. Convert it first (.pfx: openssl pkcs12 -in file.pfx -nodes -nocerts for the key, -nokeys for the chain).');
    expect(bodies).toEqual([]);
    expectDropped(f);
  });

  test('a key file over 16 KiB is not read and not sent, one of 16 KiB is', async () => {
    let reads = 0;
    class Spy extends File {
      override arrayBuffer() {
        reads++;
        return super.arrayBuffer();
      }
    }
    const big = form({ key: '', keyFile: new Spy(['k'.repeat(TLS_LIMITS.keyBytes + 1)], 'big.key') });
    const refused = sender({ data: certificate() });
    expect(await sendCertificate(big, refused.send)).toEqual({ ok: false, aborted: false, place: 'key', message: 'This file is larger than 16 KiB.' });
    expect(reads).toBe(0);
    expect(refused.bodies).toEqual([]);
    expectDropped(big);

    const edge = form({ key: '', keyFile: new Spy(['k'.repeat(TLS_LIMITS.keyBytes)], 'edge.key') });
    const taken = sender({ data: certificate() });
    expect((await sendCertificate(edge, taken.send)).ok).toBe(true);
    expect(reads).toBe(1);
    expect(taken.bodies[0].key_pem).toHaveLength(TLS_LIMITS.keyBytes);
  });

  test('a chain file is capped at 64 KiB and must be text', async () => {
    let reads = 0;
    class Spy extends File {
      override arrayBuffer() {
        reads++;
        return super.arrayBuffer();
      }
    }
    expect(await readPemFile(new Spy(['c'.repeat(TLS_LIMITS.chainBytes + 1)], 'big.pem'), 'chain')).toEqual({ message: 'This file is larger than 64 KiB.' });
    expect(reads).toBe(0);
    expect(await readPemFile(new Spy(['c'.repeat(TLS_LIMITS.chainBytes)], 'edge.pem'), 'chain')).toEqual({ text: 'c'.repeat(TLS_LIMITS.chainBytes) });
    const binary = await readPemFile(new File([new Uint8Array([0x30, 0x82, 0xff])], 'chain.p12'), 'chain');
    expect(binary.message).toStartWith('This file is not PEM text.');
  });

  test('a chain file that holds a private key gives the message and no text, a key file is returned as it is', async () => {
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      const combined = `${CHAIN}-----BEGIN ${label}-----\nQUJD\n-----END ${label}-----\n`;
      const read = await readPemFile(new File([combined], 'fullchain.pem'), 'chain');
      expect({ label, read }).toEqual({ label, read: { message: 'This text holds a private key. Put only certificates here and the key in the key field.' } });
    }
    const keyText = `${BEGIN_KEY}\nQUJD\n${END_KEY}\n`;
    expect(await readPemFile(new File([keyText], 'server.key'), 'key')).toEqual({ text: keyText });
    expect(await readPemFile(new File([CHAIN], 'chain.pem'), 'chain')).toEqual({ text: CHAIN });
  });
});

describe('the five calls of api.ts', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function answer(body: unknown, status = 200) {
    const calls: { url: string; method: string; body: string | undefined }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(url), 'http://localhost').pathname, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    return calls;
  }

  test('paths, methods and bodies', async () => {
    const api = await import('../src/lib/api');
    const settings = input({ source: 'acme' });
    const calls = answer(state());
    expect((await api.getAppTLS('p1', 'a1')).data?.mode).toBe('gateway');
    expect((await api.putAppTLS('p1', 'a1', settings)).data?.mode).toBe('gateway');
    expect((await api.requestAppACME('p1', 'a1')).data?.mode).toBe('gateway');
    expect(calls).toEqual([
      { url: '/api/projects/p1/apps/a1/tls', method: 'GET', body: undefined },
      { url: '/api/projects/p1/apps/a1/tls', method: 'PUT', body: JSON.stringify(settings) },
      { url: '/api/projects/p1/apps/a1/tls/acme', method: 'POST', body: undefined },
    ]);

    const upload = answer(certificate());
    const sent = { chain_pem: 'chain', key_pem: 'key' };
    expect((await api.uploadAppCertificate('p1', 'a1', sent)).data?.id).toBe('cert-1');
    expect(upload).toEqual([{ url: '/api/projects/p1/apps/a1/tls/certificate', method: 'POST', body: JSON.stringify(sent) }]);

    const removal = answer({ deleted: true });
    expect((await api.deleteAppCertificate('p1', 'a1')).data).toEqual({ deleted: true });
    expect(removal).toEqual([{ url: '/api/projects/p1/apps/a1/tls/certificate', method: 'DELETE', body: undefined }]);
  });

  test('an answer of another shape is a protocol failure', async () => {
    const api = await import('../src/lib/api');
    answer({ maintenance: {} });
    expect((await api.getAppTLS('p1', 'a1')).error?.kind).toBe('protocol');
    answer({ id: 7 });
    expect((await api.uploadAppCertificate('p1', 'a1', { chain_pem: '', key_pem: '' })).error?.kind).toBe('protocol');
    answer({ ok: true });
    expect((await api.deleteAppCertificate('p1', 'a1')).error?.kind).toBe('protocol');
  });

  test('a refusal keeps reason, host and retry_after', async () => {
    const api = await import('../src/lib/api');
    answer({ error: 'The leaf does not cover a.example.com', code: 'INVALID_CERTIFICATE', field: 'chain_pem', reason: 'names_do_not_cover', host: 'a.example.com' }, 400);
    expect((await api.uploadAppCertificate('p1', 'a1', { chain_pem: '', key_pem: '' })).error).toMatchObject({
      status: 400,
      code: 'INVALID_CERTIFICATE',
      field: 'chain_pem',
      reason: 'names_do_not_cover',
      host: 'a.example.com',
    });
    answer({ error: 'Wait', code: 'ACME_REQUEST_TOO_SOON', retry_after: 90 }, 409);
    expect((await api.requestAppACME('p1', 'a1')).error).toMatchObject({ status: 409, code: 'ACME_REQUEST_TOO_SOON', retry_after: 90 });
  });
});

describe('the form of the tab', () => {
  test('host names are one per line; blank lines go and only ASCII spaces are trimmed', () => {
    const form = formFromTLS(input({ hosts: ['a.example.com', 'b.example.com'] }));
    expect(form.hosts).toBe('a.example.com\nb.example.com');
    expect(inputFromForm({ ...form, hosts: ' a.example.com \r\n\n\t\nB.example.com\n \n' }).hosts).toEqual(['a.example.com', 'B.example.com', ' ']);
  });

  test('the redirect is an address while its switch is on, and empty while it is off', () => {
    const form = formFromTLS(input({ redirect_listen: '0.0.0.0:80' }));
    expect(form).toMatchObject({ redirect: true, redirectListen: '0.0.0.0:80' });
    expect(inputFromForm(form).redirect_listen).toBe('0.0.0.0:80');
    const off = setRedirect(form, false);
    expect(inputFromForm(off).redirect_listen).toBe('');
    expect(off.redirectListen).toBe('0.0.0.0:80');
    expect(setRedirect({ ...form, redirectListen: '' }, true)).toMatchObject({ redirect: true, redirectListen: '0.0.0.0:80' });
    expect(setRedirect({ ...form, redirectListen: '10.0.0.1:8080' }, true).redirectListen).toBe('10.0.0.1:8080');
  });

  test('choosing Gateway the first time turns the redirect on at port 80, and later keeps what is there', () => {
    const proxy = input({ mode: 'proxy', hosts: [], source: '' });
    const first = chooseMode(formFromTLS(proxy), 'gateway', proxy);
    expect(first).toMatchObject({ mode: 'gateway', redirect: true, redirectListen: '0.0.0.0:80' });
    // An address typed before stays, and an app that is in Gateway already is not touched.
    const typed = { ...formFromTLS(proxy), redirectListen: '10.0.0.1:8080' };
    expect(chooseMode(typed, 'gateway', proxy)).toMatchObject({ redirect: false, redirectListen: '10.0.0.1:8080' });
    const gateway = input({ redirect_listen: '' });
    expect(chooseMode({ ...formFromTLS(gateway), mode: 'proxy' }, 'gateway', gateway)).toMatchObject({ mode: 'gateway', redirect: false, redirectListen: '' });
  });

  test('choosing Behind a proxy puts the saved listeners back, and keeps the rest of the edits', () => {
    const saved = input({ listen: '0.0.0.0:8443', redirect_listen: '0.0.0.0:80', hosts: ['a.example.com'] });
    const edited = { ...formFromTLS(saved), listen: 'junk', redirect: false, redirectListen: '', hosts: 'b.example.com', source: 'acme' as const };
    expect(chooseMode(edited, 'proxy', saved)).toEqual({ ...formFromTLS(saved), mode: 'proxy', hosts: 'b.example.com', source: 'acme' });
  });

  test('settings count as the same once the server normal form is applied', () => {
    expect(sameTLS(input({ listen: '' }), input({ listen: '0.0.0.0:443' }))).toBe(true);
    expect(sameTLS(input({ hosts: [' A.example.com', 'a.example.com'] }), input({ hosts: ['a.example.com'] }))).toBe(true);
    expect(sameTLS(input({ listen: '0.0.0.0:8443' }), input({ listen: '0.0.0.0:443' }))).toBe(false);
    expect(sameTLS(input({ mode: 'proxy' }), input({ mode: 'gateway' }))).toBe(false);
    // A form the server would refuse differs from the saved one, whatever it holds.
    expect(sameTLS(input({ hosts: [] }), input({ hosts: ['a.example.com'] }))).toBe(false);
    expect(sameTLS(input({ listen: 'junk' }), input({ listen: '0.0.0.0:443' }))).toBe(false);
  });
});

describe('what the form would be refused for', () => {
  const own = { host: '', port: 8080 };

  test('the first refused field is named with the text of the server', () => {
    expect(tlsProblem(input({ hosts: ['10.0.0.1'] }), own)).toEqual({ field: 'hosts', message: '"10.0.0.1" must be a DNS name, not an IP address' });
    expect(tlsProblem(input({ listen: 'junk' }), own)?.field).toBe('listen');
    expect(tlsProblem(input({ hosts: [] }), own)).toEqual({ field: 'hosts', message: 'at least one host is required when mode is "gateway"' });
  });

  test('a switch to Gateway leaves a missing source and host name to the checks of its dialog, but not a badly written one', () => {
    const bare = input({ mode: 'gateway', hosts: [], source: '' });
    expect(tlsProblem(bare, own)?.field).toBe('source');
    expect(tlsProblem(bare, own, true)).toBeNull();
    expect(tlsProblem({ ...bare, hosts: ['shop'] }, own, true)?.field).toBe('hosts');
    expect(tlsProblem({ ...bare, listen: 'junk' }, own, true)?.field).toBe('listen');
  });

  test('the own listener clashes in Gateway only, under the address it takes', () => {
    expect(tlsProblem(input(), { host: '', port: 443 })).toEqual({ field: 'listen', message: OWN_LISTENER });
    expect(tlsProblem(input({ redirect_listen: '0.0.0.0:80' }), { host: '', port: 80 })).toEqual({ field: 'redirect_listen', message: OWN_LISTENER });
    expect(tlsProblem(input({ mode: 'proxy' }), { host: '', port: 443 })).toBeNull();
    expect(tlsProblem(input({ mode: 'gateway' }), { host: '', port: 443 }, true)).toEqual({ field: 'listen', message: OWN_LISTENER });
    expect(tlsProblem(input(), { host: '', port: null })).toBeNull();
  });
});

describe('the switch and the notices', () => {
  test('the Gateway switch waits for an agent that serves certificates; not known passes; a Gateway app stays editable', () => {
    const ok = { canConfigure: true, busy: false };
    expect(switchDisabled({ ...ok, to: 'gateway', supported: false })).toBe(true);
    expect(switchDisabled({ ...ok, to: 'gateway', supported: null })).toBe(false);
    expect(switchDisabled({ ...ok, to: 'gateway', supported: true })).toBe(false);
    // Switching back and saving in Gateway never ask the agent.
    expect(switchDisabled({ ...ok, to: 'proxy', supported: false })).toBe(false);
    expect(switchDisabled({ ...ok, to: null, supported: false })).toBe(false);
    expect(switchDisabled({ canConfigure: false, busy: false, to: null, supported: true })).toBe(true);
    expect(switchDisabled({ canConfigure: true, busy: true, to: null, supported: true })).toBe(true);
  });

  test('a save asks first for a switch either way and for a source change in Gateway, and for nothing else', () => {
    const gateway = input({ mode: 'gateway', source: 'acme' });
    const proxy = input({ mode: 'proxy', source: 'acme' });
    expect(confirmFor(proxy, { ...proxy, mode: 'gateway' })).toBe('gateway');
    expect(confirmFor(gateway, { ...gateway, mode: 'proxy' })).toBe('proxy');
    // A switch asks for the mode, whatever the source does with it.
    expect(confirmFor(proxy, { ...proxy, mode: 'gateway', source: 'uploaded' })).toBe('gateway');
    expect(confirmFor(gateway, { ...gateway, source: 'uploaded' })).toBe('source');
    expect(confirmFor(gateway, { ...gateway, source: '' })).toBe('source');
    // Behind a proxy a source change is a plain save: the agent does not act on it.
    expect(confirmFor(proxy, { ...proxy, source: 'uploaded' })).toBeNull();
    // Hosts and listeners, or no change at all.
    expect(confirmFor(gateway, { ...gateway, hosts: ['b.example.com'], listen: '0.0.0.0:8443', redirect_listen: '0.0.0.0:80' })).toBeNull();
    expect(confirmFor(gateway, gateway)).toBeNull();
  });

  test('notices come in a fixed order, and an unsupported agent reads differently in Gateway', () => {
    const base = { assigned: true, mode: 'proxy' as const, supported: true, online: true, canConfigure: true };
    expect(tlsNotices(base)).toEqual([]);
    expect(tlsNotices({ ...base, assigned: false, supported: null, online: undefined, canConfigure: false })).toEqual(['unassigned', 'readonly']);
    expect(tlsNotices({ ...base, supported: false, online: false, canConfigure: false })).toEqual(['unsupported', 'offline', 'readonly']);
    expect(tlsNotices({ ...base, mode: 'gateway', supported: false })).toEqual(['unsupported-gateway']);
  });

  test('the texts name the agent, or say the WAF agent', () => {
    expect(noticeText('offline', 'edge-1')).toBe('edge-1 is offline. The change takes effect when it reconnects.');
    expect(noticeText('offline', '')).toBe('The WAF agent is offline. The change takes effect when it reconnects.');
    expect(noticeText('unsupported', 'edge-1')).toBe(
      'edge-1 cannot serve certificates: it is older than this feature, or its key directory /var/lib/wafio-waf-agent/tls/ was unusable at start (its log says why). Upgrade it, or fix the directory and restart it.',
    );
    expect(noticeText('unsupported-gateway', 'edge-1')).toBe('edge-1 no longer serves certificates, so it serves this application in plain HTTP at its Routing listen address.');
    expect(noticeText('readonly', '')).toBe('Read-only: changing HTTPS settings needs member or owner access.');
  });
});

describe('the checks of a switch to Gateway', () => {
  const ok = {
    input: { hosts: ['shop.example.com'], source: 'acme' as const },
    certificate: null,
    supported: true,
    hostBound: true,
    assigned: true,
    trust: { forwarded: false, list: [] as string[] },
    agent: 'edge-1',
    now: NOW,
  };
  const states = (checks: TLSCheck[]): Record<string, CheckState> => Object.fromEntries(checks.map((c) => [c.id, c.state]));

  test('Let\'s Encrypt with everything in place passes every check', () => {
    expect(states(gatewayChecks(ok))).toEqual({ source: 'passed', hosts: 'passed', agent: 'passed', trust: 'passed' });
  });

  test('a missing source or host name fails, and a repeated host name counts once', () => {
    expect(states(gatewayChecks({ ...ok, input: { hosts: [], source: '' } }))).toMatchObject({ source: 'failed', hosts: 'failed' });
    expect(gatewayChecks({ ...ok, input: { hosts: ['a.example.com', 'A.example.com'], source: 'acme' } }).find((c) => c.id === 'hosts')?.text).toBe('One host name.');
  });

  test('an agent that cannot serve certificates fails; one not known yet only says so', () => {
    const failed = gatewayChecks({ ...ok, supported: false }).find((c) => c.id === 'agent');
    expect(failed).toMatchObject({ state: 'failed' });
    expect(failed?.text).toContain('edge-1 cannot serve certificates');
    expect(states(gatewayChecks({ ...ok, supported: null })).agent).toBe('unknown');
  });

  test('forwarded headers on with an empty list are a warning that names the default ranges and never fail the switch', () => {
    const checks = gatewayChecks({ ...ok, trust: { forwarded: true, list: [] } });
    expect(checks.find((c) => c.id === 'trust')).toEqual({ id: 'trust', state: 'warning', text: trustText([]) });
    expect(trustText([]).startsWith('Forwarded headers are trusted from loopback and the private ranges. In Gateway mode')).toBe(true);
    expect(checks.some((c) => c.state === 'failed')).toBe(false);
  });

  test('forwarded headers on with a list name the list and give the advice, as a pass', () => {
    const list = ['127.0.0.1', '10.0.0.0/8'];
    const trust = gatewayChecks({ ...ok, trust: { forwarded: true, list } }).find((c) => c.id === 'trust');
    expect(trust).toEqual({ id: 'trust', state: 'passed', text: trustText(list) });
    expect(trust?.text.startsWith('Forwarded headers are trusted from 127.0.0.1, 10.0.0.0/8. In Gateway mode')).toBe(true);
    expect(trust?.text).toContain('turn this off on the Routing tab; behind a CDN, keep only its addresses.');
    expect(trust?.text).not.toContain('private ranges');
  });

  test('forwarded headers off say so, whatever the list holds', () => {
    expect(gatewayChecks({ ...ok, trust: { forwarded: false, list: ['127.0.0.1'] } }).find((c) => c.id === 'trust')).toEqual({ id: 'trust', state: 'passed', text: 'Forwarded headers are off.' });
  });

  test('an uploaded certificate must exist, be valid now and cover every host name', () => {
    const uploaded = { ...ok, input: { hosts: ['shop.example.com'], source: 'uploaded' as const } };
    const cert = (over = {}) => gatewayChecks({ ...uploaded, certificate: certificate(over) }).find((c) => c.id === 'certificate');
    expect(gatewayChecks(uploaded).find((c) => c.id === 'certificate')).toMatchObject({ state: 'failed', text: 'No certificate is uploaded. Upload one before you switch.' });
    expect(cert()).toMatchObject({ state: 'passed' });
    expect(cert({ not_after: iso(NOW) })).toMatchObject({ state: 'failed', text: 'The uploaded certificate has expired.' });
    expect(cert({ not_after: iso(NOW - HOUR) })).toMatchObject({ state: 'failed' });
    expect(cert({ not_after: iso(NOW + HOUR) })).toMatchObject({ state: 'passed' });
    expect(cert({ names: ['*.example.com'] })).toMatchObject({ state: 'passed' });
    expect(cert({ names: ['other.example.com'] })).toMatchObject({ state: 'failed', text: 'The uploaded certificate does not cover shop.example.com.' });
    const two = gatewayChecks({ ...uploaded, input: { hosts: ['shop.example.com', 'blog.example.com'], source: 'uploaded' }, certificate: certificate() });
    expect(two.find((c) => c.id === 'certificate')?.text).toBe('The uploaded certificate does not cover blog.example.com.');
  });

  test('what is not known yet: the control plane asks an assigned agent at the switch, and an unassigned app only when one is assigned', () => {
    const uploaded = { ...ok, input: { hosts: ['shop.example.com'], source: 'uploaded' as const }, certificate: certificate() };
    const text = (checks: TLSCheck[], id: string) => checks.find((c) => c.id === id)?.text;
    const waiting = gatewayChecks({ ...uploaded, supported: null, hostBound: null });
    expect(text(waiting, 'agent')).toBe('It is not known yet whether the WAF agent can serve certificates. The control plane checks again when you switch.');
    expect(text(waiting, 'bound')).toBe('It is not known yet whether the WAF agent can receive an uploaded key. The control plane checks again when you switch.');
    const unassigned = gatewayChecks({ ...uploaded, assigned: false, supported: null, hostBound: null });
    const none = 'No WAF agent is assigned yet. The agent is checked when you assign one on the Assignment tab.';
    expect(text(unassigned, 'agent')).toBe(none);
    expect(text(unassigned, 'bound')).toBe(none);
    expect(states(unassigned)).toMatchObject({ agent: 'unknown', bound: 'unknown' });
  });

  test('an uploaded certificate needs an agent with a credential bound to its host; Let\'s Encrypt does not', () => {
    const uploaded = { ...ok, input: { hosts: ['shop.example.com'], source: 'uploaded' as const }, certificate: certificate() };
    expect(states(gatewayChecks(uploaded)).bound).toBe('passed');
    expect(gatewayChecks({ ...uploaded, hostBound: false }).find((c) => c.id === 'bound')?.text).toContain('edge-1 needs a credential bound to its host to receive an uploaded key.');
    expect(states(gatewayChecks({ ...uploaded, hostBound: null })).bound).toBe('unknown');
    expect(states(gatewayChecks({ ...ok, hostBound: false }))).not.toHaveProperty('bound');
    expect(states(gatewayChecks({ ...ok, certificate: null }))).not.toHaveProperty('certificate');
  });
});

describe('the texts of the dialogs', () => {
  test('ports are the HTTPS port, and the redirect port when it is on', () => {
    expect(portsText('0.0.0.0:443', '')).toBe('port 443');
    expect(portsText('', '')).toBe('port 443');
    expect(portsText('0.0.0.0:443', '0.0.0.0:80')).toBe('ports 443 and 80');
    expect(portsText('[::]:8443', '[::]:8080')).toBe('ports 8443 and 8080');
    expect(portsText('10.0.0.1:443', '10.0.0.2:443')).toBe('port 443');
  });

  test('the Let\'s Encrypt switch says what visitors get, per redirect, and carries the agreement line', () => {
    const on = sourceSwitchText('acme', { agent: 'edge-1', redirect: true });
    const off = sourceSwitchText('acme', { agent: 'edge-1', redirect: false });
    expect(on).toBe(
      "Until the certificate is issued, HTTPS visitors get a browser warning, then a 503 page, and HTTP visitors get 503. A try takes up to 3 minutes; after a failure the agent waits 10 minutes, then longer. Switching places the first request: by switching, you accept the Let's Encrypt Subscriber Agreement.",
    );
    expect(off).toContain('then a 503 page. Nothing answers on HTTP. A try takes up to 3 minutes');
    expect(off).not.toContain('HTTP visitors get 503');
    for (const text of [on, off]) expect(text).toContain("by switching, you accept the Let's Encrypt Subscriber Agreement.");
  });

  test('the uploaded switch names the agent, says what happens on HTTP, and has no agreement line', () => {
    expect(sourceSwitchText('uploaded', { agent: 'edge-1', redirect: true })).toBe('Until edge-1 has the certificate, usually within a minute, HTTPS connections fail, and HTTP visitors get 503.');
    expect(sourceSwitchText('uploaded', { agent: '', redirect: false })).toBe('Until the WAF agent has the certificate, usually within a minute, HTTPS connections fail. Nothing answers on HTTP.');
    expect(sourceSwitchText('uploaded', { agent: 'edge-1', redirect: false })).not.toContain('Subscriber Agreement');
  });

  test('a source change in Gateway keeps what the agent serves: no failing HTTPS, no 503 unless nothing is served', () => {
    const agreement = "Switching places the first request: by switching, you accept the Let's Encrypt Subscriber Agreement.";
    expect(sourceChangeText('acme', { agent: 'edge-1', hasLeaf: true })).toBe(`Requesting a certificate from Let's Encrypt. The current certificate stays in use until then. ${agreement}`);
    expect(sourceChangeText('acme', { agent: 'edge-1', hasLeaf: false })).toBe(
      `Requesting a certificate from Let's Encrypt. Until it is issued, HTTPS visitors get a browser warning and a 503 page. ${agreement}`,
    );
    expect(sourceChangeText('uploaded', { agent: 'edge-1', hasLeaf: true })).toBe('edge-1 switches to it within about a minute and serves the current certificate until then, if it has one.');
    expect(sourceChangeText('uploaded', { agent: '', hasLeaf: false })).toBe('The WAF agent switches to it within about a minute and serves the current certificate until then, if it has one.');
    // Not the texts of a switch: those say HTTPS fails and the redirect answers 503.
    for (const text of [sourceChangeText('acme', { agent: 'edge-1', hasLeaf: true }), sourceChangeText('uploaded', { agent: 'edge-1', hasLeaf: true })]) {
      expect(text).not.toContain('connections fail');
      expect(text).not.toContain('HTTP visitors get 503');
    }
    expect(sourceChangeText('uploaded', { agent: 'edge-1', hasLeaf: false })).not.toContain('Subscriber Agreement');
  });

  test('the steps outside WAFio name the ports and the agent; the Let\'s Encrypt remark only for Let\'s Encrypt', () => {
    const steps = gatewaySteps({ agent: 'edge-1', ports: 'ports 443 and 80', source: 'acme' });
    expect(steps).toEqual([
      "Point each host name's DNS at this server, or at a CDN that connects here over HTTPS (Cloudflare: Full).",
      "Free ports 443 and 80 on edge-1's host: stop or move the web server there. Until then edge-1 keeps its current settings for all its applications and retries every minute.",
      'If you reach this dashboard through that web server, set up another way in first, or switching back needs a shell.',
      "Open ports 443 and 80 to visitors in every firewall; Let's Encrypt checks from several networks.",
    ]);
    expect(gatewaySteps({ agent: '', ports: 'port 443', source: 'uploaded' })[3]).toBe('Open port 443 to visitors in every firewall.');
    expect(gatewaySteps({ agent: '', ports: 'port 443', source: 'uploaded' })[1]).toContain("on the WAF agent's host");
  });

  test('switching back names the listen address of the Routing tab and the ports it frees', () => {
    expect(backToProxyText({ agent: 'edge-1', own: { host: '127.0.0.1', port: 8080 }, ports: 'ports 443 and 80' })).toBe(
      'edge-1 stops serving HTTPS for this application and listens on 127.0.0.1:8080 again, which frees ports 443 and 80. Then start the web server in front of it; a load balancer on another machine can be switched first.',
    );
    expect(backToProxyText({ agent: '', own: { host: '', port: 8080 }, ports: 'port 443' })).toContain('The WAF agent stops serving HTTPS');
    expect(backToProxyText({ agent: '', own: { host: '', port: 8080 }, ports: 'port 443' })).toContain('listens on 0.0.0.0:8080 again');
    expect(backToProxyText({ agent: '', own: { host: '::1', port: 8080 }, ports: 'port 443' })).toContain('listens on [::1]:8080 again');
    expect(backToProxyText({ agent: '', own: { host: '', port: null }, ports: 'port 443' })).toContain('listens on the listen address on the Routing tab again');
  });

  test('a save in Gateway and a DNS hint', () => {
    expect(savedInGatewayText('edge-1')).toBe(
      'Saved. edge-1 applies it within about a minute. If it cannot (a port in use, say), it keeps its current settings for all its applications; its log says why.',
    );
    expect(savedInGatewayText('')).toContain('Saved. The WAF agent applies it');
    const warning = { code: 'dns_mismatch' as const, host: 'shop.example.com', resolved: ['203.0.113.7', '203.0.113.8'], agent_addresses: ['198.51.100.2'] };
    expect(dnsWarningText(warning, 'edge-1')).toBe(
      "shop.example.com resolves to 203.0.113.7, 203.0.113.8, but edge-1's host reports 198.51.100.2. Visitors and Let's Encrypt go where DNS points; behind a CDN that is expected.",
    );
    expect(dnsWarningText(warning, '')).toContain("but the WAF agent's host reports");
  });
});

describe('where a refused save is shown', () => {
  const refused = (error: Partial<ApiError>) => classifyTLSRefusal({ error: 'The server says no', status: 400, ...error }, 'edge-1');

  test('a refused field goes under it, without the "field: " prefix of the server', () => {
    expect(refused({ code: 'INVALID_TLS_SETTINGS', field: 'hosts', error: 'hosts: "shop" must contain at least one dot' })).toEqual({ kind: 'field', field: 'hosts', message: '"shop" must contain at least one dot' });
    expect(refused({ code: 'INVALID_TLS_SETTINGS', field: 'redirect_listen', error: 'redirect_listen: must differ from listen' })).toEqual({ kind: 'field', field: 'redirect_listen', message: 'must differ from listen' });
    expect(refused({ code: 'INVALID_TLS_SETTINGS', field: 'source', error: 'source: is required when mode is "gateway"' })).toMatchObject({ kind: 'field', field: 'source' });
  });

  test('a conflict or a bundle that is too large goes under its field with the text of the server', () => {
    for (const [code, field] of [['LISTEN_CONFLICT', 'listen'], ['LISTEN_CONFLICT', 'redirect_listen'], ['HOST_CONFLICT', 'hosts'], ['TLS_BUNDLE_TOO_LARGE', 'hosts']] as const) {
      expect(refused({ status: 409, code, field, error: 'Text of the server' })).toEqual({ kind: 'field', field, message: 'Text of the server' });
    }
  });

  test('a conflict with the listener of the Routing tab has no field here', () => {
    expect(refused({ status: 409, code: 'LISTEN_CONFLICT', field: 'listen_port', error: 'address 0.0.0.0:443 is already used by application shop' })).toEqual({
      kind: 'routing',
      message: 'address 0.0.0.0:443 is already used by application shop',
    });
  });

  test('a certificate that does not cover a host goes under the host names, naming the host', () => {
    const text = 'The current certificate does not cover blog.example.com. Upload a certificate that covers every host, or change the hosts.';
    expect(refused({ status: 409, code: 'CERTIFICATE_DOES_NOT_COVER', host: 'blog.example.com', error: text })).toEqual({ kind: 'field', field: 'hosts', message: text });
  });

  test('the answers with no field get the text of the dashboard', () => {
    const texts = {
      CERTIFICATE_REQUIRED: 'Upload a certificate that is valid now before you choose Uploaded certificate.',
      KEY_ENCRYPTION_UNAVAILABLE: 'The control plane cannot store keys: totp.enc_key is not set.',
      CERTIFICATE_IN_USE: 'In use. Switch to Let\'s Encrypt or Behind a proxy first, or upload a replacement.',
    };
    for (const [code, message] of Object.entries(texts)) expect(refused({ status: 409, code })).toEqual({ kind: 'save', message });
    expect(refused({ status: 409, code: 'AGENT_NOT_HOST_BOUND' })).toMatchObject({ kind: 'save' });
    expect((refused({ status: 409, code: 'AGENT_NOT_HOST_BOUND' }) as { message: string }).message).toContain('edge-1 needs a credential bound to its host to receive an uploaded key.');
  });

  test('an agent that cannot serve certificates is told to the panel, with the text of the dashboard', () => {
    const refusal = refused({ status: 409, code: 'TLS_UNSUPPORTED' });
    expect(refusal.kind).toBe('unsupported');
    expect(refusal.message).toContain('edge-1 cannot serve certificates');
  });

  test('anything else keeps the text of the server, a rate limit included', () => {
    expect(refused({ status: 429, code: 'RATE_LIMITED', error: 'Too many requests' })).toEqual({ kind: 'save', message: 'Too many requests' });
    expect(refused({ status: 400, code: 'INVALID_TLS_SETTINGS', field: 'mode', error: 'mode: must be "proxy" or "gateway"' })).toMatchObject({ kind: 'save' });
    expect(classifyTLSRefusal(undefined, '')).toEqual({ kind: 'save', message: 'Could not save the HTTPS settings.' });
  });
});

describe('where the Not saved alert is', () => {
  const source = readFileSync(new URL('../src/lib/components/apps/AppTLS.svelte', import.meta.url), 'utf8');
  const alerts = [...source.matchAll(/<Alert[^>]*title="Not saved"[^>]*>/g)];

  test('inside the form that focus looks in after a refused save, ahead of the footer', () => {
    expect(alerts.length).toBeGreaterThan(0);
    const first = alerts[0].index!;
    expect(first).toBeGreaterThan(source.indexOf('class="tls-form" bind:this={root}'));
    expect(first).toBeLessThan(source.indexOf('class="tls-actions"'));
  });

  test('with the Routing link in the dialog as well as above the form', () => {
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) expect(alert[0]).toContain('actions={routingError ? routingLink : undefined}');
  });
});

describe('the TLS files hold no storage, log or markup', () => {
  test.each(['tls.ts', 'AppTLS.svelte'])('%s', (file) => {
    const source = readFileSync(new URL(`../src/lib/components/apps/${file}`, import.meta.url), 'utf8');
    for (const word of ['{@html', 'localStorage', 'sessionStorage', 'console.']) expect(source).not.toContain(word);
  });
});
