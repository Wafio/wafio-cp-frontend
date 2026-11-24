// The Speed tab as functions: the checks of the control plane (its fixture cases), the forms and what they send, the
// line under each part for every state of the agent, how often to ask, the texts of the refusals, and the numbers in
// words. What the panel renders for each state is in apps-speed-render.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ApiError } from '../src/lib/api';
import { appWriteErrorMessage } from '../src/lib/components/apps/route-errors';
import { checkStripPathPrefix } from '../src/lib/components/apps/route-model';
import { lifetimeFromParts, lifetimeParts } from '../src/lib/components/apps/inputs';
import { normalizeTLS } from '../src/lib/components/apps/tls';
import {
  BYTES_MESSAGE,
  FORBIDDEN_ROOTS,
  NO_ANSWER_AFTER_MS,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  ROOT_FORBIDDEN_MESSAGE,
  ROOT_INVALID_MESSAGE,
  agentRefusalText,
  classifySpeedRefusal,
  compressionForm,
  compressionInput,
  compressionNumbers,
  normalizeCompression,
  normalizeStaticFiles,
  partLine,
  pollIntervalMs,
  refusalReason,
  sameCompression,
  sameStaticFiles,
  staticFilesForm,
  staticFilesInput,
  staticRootConfirmText,
  staticRootForbidden,
  staticRootNeedsConfirm,
  tooOld,
  tooOldText,
  unsupportedPartsText,
  waitingForAgent,
  withSaved,
  type CompressionInput,
  type PartInput,
  type StaticFilesInput,
} from '../src/lib/components/apps/speed';
import { MINUTE, NOW, agent, delivery, feature, status } from './support/delivery-fixtures';

interface Cases {
  compression: { name: string; in: CompressionInput; result?: unknown; field?: string; message?: string }[];
  static_files: { name: string; in: StaticFilesInput; result?: unknown; field?: string; message?: string }[];
  strip_path_prefix: { name: string; in: string; message?: string }[];
  canonical_host: { name: string; host: string; hosts: string[]; message?: string }[];
}
const backend = JSON.parse(readFileSync(new URL('./fixtures/backend/delivery-checks.json', import.meta.url), 'utf8')) as Cases;
const NON_ASCII = /[^\u0000-\u007f]/;

describe('control plane parity', () => {
  test('every case of the compression checks gets the stored form or the refusal of the server', () => {
    expect(backend.compression.length).toBeGreaterThanOrEqual(7);
    for (const c of backend.compression) {
      const got = normalizeCompression(c.in);
      if (c.result) expect({ name: c.name, got: got.settings, error: got.error }).toEqual({ name: c.name, got: c.result, error: undefined });
      else expect({ name: c.name, error: got.error }).toEqual({ name: c.name, error: { field: c.field, message: c.message } });
    }
  });

  test('every ASCII case of the files checks gets the stored form or the refusal of the server', () => {
    const judged = backend.static_files.filter((c) => !NON_ASCII.test(JSON.stringify(c.in)));
    expect(judged.length).toBeGreaterThanOrEqual(20);
    for (const c of judged) {
      const got = normalizeStaticFiles(c.in);
      if (c.result) expect({ name: c.name, got: got.settings, error: got.error }).toEqual({ name: c.name, got: c.result, error: undefined });
      else expect({ name: c.name, error: got.error }).toEqual({ name: c.name, error: { field: c.field, message: c.message } });
    }
  });

  test('a folder with a character that is not ASCII is never refused when the server takes it', () => {
    const unjudged = backend.static_files.filter((c) => NON_ASCII.test(JSON.stringify(c.in)));
    expect(unjudged.length).toBeGreaterThanOrEqual(1);
    for (const c of unjudged) {
      if (c.result) expect({ name: c.name, error: normalizeStaticFiles(c.in).error }).toEqual({ name: c.name, error: undefined });
    }
  });

  test('every case of the path prefix check agrees with the server', () => {
    expect(backend.strip_path_prefix.length).toBeGreaterThanOrEqual(20);
    for (const c of backend.strip_path_prefix) expect({ name: c.name, got: checkStripPathPrefix(c.in) }).toEqual({ name: c.name, got: c.message ?? null });
  });

  test('every case of the main host name check agrees with the server', () => {
    expect(backend.canonical_host.length).toBeGreaterThanOrEqual(5);
    for (const c of backend.canonical_host) {
      const got = normalizeTLS({ mode: 'proxy', hosts: c.hosts, listen: '', redirect_listen: '', source: '', canonical_host: c.host });
      expect({ name: c.name, error: got.error }).toEqual({ name: c.name, error: c.message ? { field: 'canonical_host', message: c.message } : undefined });
    }
  });

  test('the folders that are refused are the ones of the server', () => {
    const table: Record<string, boolean> = {
      '/': true, '/etc': true, '/etc/nginx/html': true, '/root': true, '/root/site': true, '/proc/1': true, '/sys': true,
      '/dev/shm': true, '/run': true, '/run/user/1000/x': true, '/boot': true, '/usr': true, '/usr/share/nginx/html': true,
      '/var': true, '/var/lib': true, '/var/cache': true,
      '/var/lib/wafio-waf-agent': true, '/var/lib/wafio-waf-agent/tls': true, '/var/cache/wafio-waf': true, '/var/cache/wafio-waf/app/ab': true,
      '/var/www': false, '/var/www/shop/public': false, '/srv/www': false, '/home/deploy/site': false, '/opt/site/public': false,
      '/var/lib/wafio-waf-agent2': false, '/var/lib/other': false, '/etcetera': false, '/usr2': false, '/rootfs': false,
    };
    for (const [root, want] of Object.entries(table)) expect({ root, got: staticRootForbidden(root) }).toEqual({ root, got: want });
    expect(FORBIDDEN_ROOTS).toHaveLength(10);
  });

  test('a forbidden folder is refused with the sentence for it, under the folder field', () => {
    expect(normalizeStaticFiles({ enabled: true, root: '/etc/nginx', missing: '', max_age_s: 0 }).error).toEqual({ field: 'root', message: ROOT_FORBIDDEN_MESSAGE });
    expect(normalizeStaticFiles({ enabled: false, root: '/usr/share', missing: '', max_age_s: 0 }).error).toEqual({ field: 'root', message: ROOT_FORBIDDEN_MESSAGE });
    expect(normalizeStaticFiles({ enabled: true, root: 'var/www', missing: '', max_age_s: 0 }).error).toEqual({ field: 'root', message: ROOT_INVALID_MESSAGE });
  });
});

describe('compression form', () => {
  test('shows the stored size in the shortest exact words and sends it back as bytes', () => {
    expect(compressionForm({ enabled: true, min_bytes: 1024 })).toEqual({ enabled: true, minBytes: '1 KiB' });
    expect(compressionForm({ enabled: false, min_bytes: 1500 })).toEqual({ enabled: false, minBytes: '1500' });
    expect(compressionInput({ enabled: true, minBytes: '2 KiB' })).toEqual({ enabled: true, min_bytes: 2048 });
    expect(compressionInput({ enabled: true, minBytes: '1500' })).toEqual({ enabled: true, min_bytes: 1500 });
  });

  test('an empty size is the default and a size that cannot be read is refused', () => {
    expect(normalizeCompression(compressionInput({ enabled: true, minBytes: '  ' })).settings).toEqual({ enabled: true, min_bytes: 1024 });
    expect(normalizeCompression(compressionInput({ enabled: true, minBytes: 'big' })).error).toEqual({ field: 'min_bytes', message: BYTES_MESSAGE });
    expect(normalizeCompression(compressionInput({ enabled: true, minBytes: '1.0001 KiB' })).error?.field).toBe('min_bytes');
    expect(normalizeCompression(compressionInput({ enabled: true, minBytes: '2 MiB' })).error?.field).toBe('min_bytes');
    expect(normalizeCompression(compressionInput({ enabled: true, minBytes: '0' })).settings?.min_bytes).toBe(0);
  });

  test('is the same as the stored settings until the switch or the size changes', () => {
    const stored = { enabled: true, min_bytes: 1024 };
    expect(sameCompression(compressionForm(stored), stored)).toBe(true);
    expect(sameCompression({ enabled: true, minBytes: '' }, stored)).toBe(true);
    expect(sameCompression({ enabled: true, minBytes: '1024' }, stored)).toBe(true);
    expect(sameCompression({ enabled: false, minBytes: '1 KiB' }, stored)).toBe(false);
    expect(sameCompression({ enabled: true, minBytes: '2 KiB' }, stored)).toBe(false);
    expect(sameCompression({ enabled: true, minBytes: 'big' }, stored)).toBe(false);
  });
});

describe('files form', () => {
  const stored = { enabled: true, root: '/var/www/shop/public', missing: 'app' as const, max_age_s: 3600 };

  test('round trips the stored settings', () => {
    const form = staticFilesForm(stored);
    expect(form).toEqual({ enabled: true, root: '/var/www/shop/public', missing: 'app', maxAge: 3600 });
    expect(normalizeStaticFiles(staticFilesInput(form)).settings).toEqual(stored);
    expect(sameStaticFiles(form, stored)).toBe(true);
  });

  test('a folder typed with spaces and a slash at the end is the same folder', () => {
    expect(sameStaticFiles({ ...staticFilesForm(stored), root: ' /var/www/shop/public/ ' }, stored)).toBe(true);
    expect(sameStaticFiles({ ...staticFilesForm(stored), root: '/var/www/shop' }, stored)).toBe(false);
  });

  test('a browser cache time that cannot be read is refused under its field', () => {
    expect(normalizeStaticFiles(staticFilesInput({ ...staticFilesForm(stored), maxAge: Number.NaN })).error?.field).toBe('max_age_s');
    expect(normalizeStaticFiles(staticFilesInput({ ...staticFilesForm(stored), maxAge: 365 * 86400 + 1 })).error?.field).toBe('max_age_s');
    expect(normalizeStaticFiles(staticFilesInput({ ...staticFilesForm(stored), maxAge: 365 * 86400 })).settings?.max_age_s).toBe(365 * 86400);
  });
});

describe('the confirm before a folder is served', () => {
  const off = { enabled: false, root: '', missing: 'app' as const, max_age_s: 0 };
  const on = { enabled: true, root: '/var/www/shop/public', missing: 'app' as const, max_age_s: 0 };

  test('switching on, and a new folder, ask; saving the same settings again, and switching off, do not', () => {
    expect(staticRootNeedsConfirm(off, on)).toBe(true);
    expect(staticRootNeedsConfirm(on, { ...on, root: '/srv/site/public' })).toBe(true);
    expect(staticRootNeedsConfirm(on, { ...on, max_age_s: 60 })).toBe(false);
    expect(staticRootNeedsConfirm(on, off)).toBe(false);
    expect(staticRootNeedsConfirm(off, { ...on, enabled: false })).toBe(false);
  });

  test('answering Not found asks too, because the application then gets no requests', () => {
    expect(staticRootNeedsConfirm(on, { ...on, missing: 'not_found' })).toBe(true);
    expect(staticRootNeedsConfirm({ ...on, missing: 'not_found' }, { ...on, missing: 'not_found' })).toBe(false);
    expect(staticRootNeedsConfirm({ ...on, missing: 'not_found' }, on)).toBe(false);
  });

  test('says that the folder becomes public, and for Not found that the application gets nothing', () => {
    const text = staticRootConfirmText('app');
    expect(text).toBe("Every file in this folder and the folders below it becomes public at the same path on this application's host names. Check that it holds no backups, exports or private uploads.");
    expect(staticRootConfirmText('not_found')).toBe(`${text} Your application stops receiving requests.`);
  });
});

describe('the line under a part', () => {
  const base = (over: Partial<PartInput> = {}): PartInput => ({ delivery: delivery(), part: 'compression', inUse: true, now: NOW, waitingSince: NOW - MINUTE, ...over });
  const on = { compression: { enabled: true, min_bytes: 1024 } };
  const answered = (over = {}) => status({ compression: feature('compression'), ...over });

  test('says nothing before the settings are read, and nothing while the part is off', () => {
    expect(partLine(base({ delivery: null }))).toBeNull();
    expect(partLine(base({ inUse: false }))).toBeNull();
  });

  test('an application without an agent says so for a part that is on, unless the panel says it elsewhere', () => {
    const none = delivery({ ...on, agent: null, generation: null, status: null });
    expect(partLine(base({ delivery: none }))).toEqual({ tone: 'info', text: 'No WAF agent serves this application yet. Saved settings apply once you assign one on the Assignment tab.' });
    expect(partLine(base({ delivery: none, quiet: ['unassigned'] }))).toBeNull();
    expect(partLine(base({ delivery: none, inUse: false }))).toBeNull();
  });

  test('an agent that is too old for the part says so, also while the part is off', () => {
    const old = delivery({ agent: agent({}, { compression: false }) });
    expect(partLine(base({ delivery: old, inUse: false }))).toEqual({ tone: 'warning', text: 'edge-1 is too old for compression. Upgrade it to use this.' });
    expect(partLine(base({ delivery: delivery({ ...on, agent: agent({}, { compression: false }) }) }))?.text).toBe('edge-1 is too old for compression. Upgrade it to use this.');
    expect(partLine(base({ delivery: old, inUse: false, part: 'redirects', label: 'the path prefix' }))).toBeNull();
    expect(partLine(base({ delivery: delivery({ agent: agent({}, { redirects: false }) }), inUse: false, part: 'redirects', label: 'the path prefix' }))?.text).toBe(
      'edge-1 is too old for the path prefix. Upgrade it to use this.',
    );
  });

  test('an agent that never said which parts it applies is not too old', () => {
    expect(tooOld(delivery({ agent: agent({}, { compression: null }) }), 'compression')).toBe(false);
    expect(partLine(base({ delivery: delivery({ ...on, agent: agent({}, { compression: null }) }) }))?.text).toBe('Saved. Waiting for edge-1 to apply it.');
  });

  test('waiting: the agent has not answered the latest bundle', () => {
    const waiting = delivery({ ...on, generation: 101, status: answered() });
    expect(partLine(base({ delivery: waiting }))).toEqual({ tone: 'info', text: 'Saved. Waiting for edge-1 to apply it.' });
    expect(partLine(base({ delivery: delivery({ ...on, status: null }) }))?.text).toBe('Saved. Waiting for edge-1 to apply it.');
    // It answered the bundle but said nothing about this part.
    expect(partLine(base({ delivery: delivery({ ...on, status: status() }) }))?.text).toBe('Saved. Waiting for edge-1 to apply it.');
  });

  test('after 2 minutes without an answer it says so', () => {
    const waiting = delivery({ ...on, generation: 101, status: answered() });
    const text = 'No answer from edge-1 yet. Check that it is online.';
    expect(partLine(base({ delivery: waiting, waitingSince: NOW - NO_ANSWER_AFTER_MS + 1 }))?.text).toBe('Saved. Waiting for edge-1 to apply it.');
    expect(partLine(base({ delivery: waiting, waitingSince: NOW - NO_ANSWER_AFTER_MS }))).toEqual({ tone: 'warning', text });
  });

  test('an offline agent says its settings apply when it reconnects, unless the panel says that elsewhere', () => {
    const offline = delivery({ ...on, agent: agent({ online: false }), status: answered() });
    expect(partLine(base({ delivery: offline }))).toEqual({ tone: 'info', text: 'edge-1 is offline. Saved settings apply when it reconnects.' });
    expect(partLine(base({ delivery: offline, quiet: ['offline'] }))).toBeNull();
  });

  test('in use: the agent applied it at the latest bundle', () => {
    expect(partLine(base({ delivery: delivery({ ...on, status: answered() }) }))).toEqual({ tone: 'success', text: 'In use on edge-1.' });
    // A report of a newer bundle than the one the control plane knows is an answer too.
    expect(partLine(base({ delivery: delivery({ ...on, status: answered({ generation: 105 }) }) }))?.tone).toBe('success');
  });

  test('refused: the reason, and whether the previous settings still run or the part stays off', () => {
    const refused = (over = {}) => delivery({ ...on, status: answered({ compression: feature('compression', { state: 'refused', code: 'invalid', detail: 'min_bytes 7', ...over }) }) });
    expect(partLine(base({ delivery: refused() }))).toEqual({
      tone: 'warning',
      text: 'edge-1 did not apply this: the settings failed its own checks (min_bytes 7). Upgrade the agent.',
      more: 'This part stays off until you fix it.',
    });
    expect(partLine(base({ delivery: refused({ running_previous: true }) }))?.more).toBe('It still runs the previous settings.');
  });

  test('a refusal still shows while the agent is offline, and an old refusal is not shown as current', () => {
    const refused = status({ compression: feature('compression', { state: 'refused', code: 'invalid' }) });
    expect(partLine(base({ delivery: delivery({ ...on, agent: agent({ online: false }), status: refused }) }))?.text).toContain('did not apply this');
    expect(partLine(base({ delivery: delivery({ ...on, generation: 101, status: refused }) }))?.text).toBe('Saved. Waiting for edge-1 to apply it.');
  });

  test('a state the dashboard does not know is said as that, with the detail as plain text', () => {
    const odd = delivery({ ...on, status: answered({ compression: feature('compression', { state: 'unknown', detail: '<b>x</b>' }) }) });
    expect(partLine(base({ delivery: odd }))).toEqual({ tone: 'info', text: 'edge-1 sent a report this dashboard does not know: <b>x</b>.' });
  });
});

describe('the reasons of a refusal', () => {
  const reason = (code: string, detail = '', folder = '/srv/shop') => refusalReason({ code: code as never, detail }, folder);

  test('name the folder the person saved', () => {
    expect(reason('root_missing')).toBe('/srv/shop does not exist on its host');
    expect(reason('root_not_directory')).toBe('/srv/shop is a file, not a folder');
    expect(reason('root_unreadable')).toBe('it cannot read /srv/shop. It runs as the user wafio, and its service hides /home, /root and /run/user');
    expect(reason('root_forbidden')).toBe('/srv/shop holds system or WAFio files');
  });

  test('fall back to what the agent said about the folder when none was saved', () => {
    expect(reason('root_missing', '/gone', '')).toBe('/gone does not exist on its host');
  });

  test('invalid names the detail when there is one; any other code gives its detail or says there is none', () => {
    expect(reason('invalid', 'root 7')).toBe('the settings failed its own checks (root 7). Upgrade the agent');
    expect(reason('invalid')).toBe('the settings failed its own checks. Upgrade the agent');
    expect(reason('unknown', 'disk is full')).toBe('disk is full');
    expect(reason('unknown')).toBe('it gave no reason');
  });
});

describe('how often to ask', () => {
  const on = { compression: { enabled: true, min_bytes: 1024 } };

  test('every 10 s while a part that is on has no answer, else every 60 s', () => {
    expect(pollIntervalMs(delivery({ ...on, generation: 101 }), null, NOW)).toBe(POLL_FAST_MS);
    expect(pollIntervalMs(delivery({ ...on, status: status({ compression: feature('compression') }) }), null, NOW)).toBe(POLL_SLOW_MS);
    expect(pollIntervalMs(delivery(), null, NOW)).toBe(POLL_SLOW_MS);
    expect(pollIntervalMs(null, null, NOW)).toBe(POLL_SLOW_MS);
  });

  test('every 10 s for 2 minutes after a save, with an agent', () => {
    expect(pollIntervalMs(delivery(), NOW - NO_ANSWER_AFTER_MS + 1, NOW)).toBe(POLL_FAST_MS);
    expect(pollIntervalMs(delivery(), NOW - NO_ANSWER_AFTER_MS, NOW)).toBe(POLL_SLOW_MS);
    expect(pollIntervalMs(delivery({ agent: null, generation: null, status: null }), NOW, NOW)).toBe(POLL_SLOW_MS);
  });

  test('an agent that is offline, or too old for the part, is not waited for', () => {
    expect(waitingForAgent(delivery({ ...on, generation: 101, agent: agent({ online: false }) }), NOW)).toBe(false);
    expect(waitingForAgent(delivery({ ...on, generation: 101, agent: agent({}, { compression: false }) }), NOW)).toBe(false);
    expect(waitingForAgent(delivery({ ...on, generation: 101 }), NOW)).toBe(true);
    expect(waitingForAgent(delivery({ generation: 101 }), NOW)).toBe(false);
  });

  test('a save puts the part and the generation of the agent into the state', () => {
    const saved = withSaved(delivery({ generation: 100 }), { compression: { enabled: true, min_bytes: 2048 } }, 101);
    expect(saved.compression).toEqual({ enabled: true, min_bytes: 2048 });
    expect(saved.generation).toBe(101);
    expect(waitingForAgent(saved, NOW)).toBe(true);
    // Without an agent the answer has no generation: the state keeps its own.
    expect(withSaved(delivery({ generation: 100 }), {}, null).generation).toBe(100);
  });
});

describe('the texts of the refusals', () => {
  test('too old says which part and what to do', () => {
    expect(tooOldText('edge-1', 'files from a folder')).toBe('edge-1 is too old for files from a folder. Upgrade it to use this.');
    expect(tooOldText('', 'compression')).toBe('The WAF agent is too old for compression. Upgrade it to use this.');
  });

  test('a move to an agent that cannot run the parts lists them', () => {
    expect(unsupportedPartsText('edge-1', ['compression'])).toBe('edge-1 cannot run compression of this application. Turn them off first, or upgrade it.');
    expect(unsupportedPartsText('edge-1', ['compression', 'static_files', 'cache'])).toBe(
      'edge-1 cannot run compression, files from a folder and the cache of this application. Turn them off first, or upgrade it.',
    );
    expect(unsupportedPartsText('edge-1', ['redirects', 'cache'])).toBe('edge-1 cannot run the main host name or path prefix and the cache of this application. Turn them off first, or upgrade it.');
  });

  test('agentRefusalText knows the two codes and nothing else', () => {
    expect(agentRefusalText({ code: 'AGENT_TOO_OLD', agent: 'edge-1', feature: 'static_files' })).toBe('edge-1 is too old for files from a folder. Upgrade it to use this.');
    expect(agentRefusalText({ code: 'AGENT_TOO_OLD', agent: 'edge-1', feature: 'redirects' }, 'the path prefix')).toBe('edge-1 is too old for the path prefix. Upgrade it to use this.');
    expect(agentRefusalText({ code: 'FEATURE_UNSUPPORTED', agent: 'edge-1', parts: ['cache'] })).toBe('edge-1 cannot run the cache of this application. Turn them off first, or upgrade it.');
    expect(agentRefusalText({ code: 'CONFLICT' })).toBeNull();
    expect(agentRefusalText(undefined)).toBeNull();
  });

  test('the Assignment tab and the Routing tab say them in the same words', () => {
    expect(appWriteErrorMessage({ code: 'FEATURE_UNSUPPORTED', error: 'The WAF agent "edge-1" cannot run x', agent: 'edge-1', parts: ['compression', 'cache'] }, 'Could not save the assignment.')).toBe(
      'edge-1 cannot run compression and the cache of this application. Turn them off first, or upgrade it.',
    );
    expect(appWriteErrorMessage({ code: 'AGENT_TOO_OLD', error: 'x', agent: 'edge-1', feature: 'redirects' }, 'Could not save the routing.')).toBe('edge-1 is too old for the path prefix. Upgrade it to use this.');
    expect(appWriteErrorMessage({ code: 'BUNDLE_TOO_LARGE', error: 'The configuration is too large.' }, 'Could not save.')).toBe('The configuration is too large.');
  });

  test('a save of compression: the field under its field, too old as the agent being too old, the rest as the server wrote it', () => {
    const fields = ['min_bytes'] as const;
    const refuse = (error: Partial<ApiError>) => classifySpeedRefusal({ error: 'x', ...error } as ApiError, fields, 'compression', 'Could not save compression.');
    expect(refuse({ code: 'INVALID_DELIVERY_SETTINGS', field: 'min_bytes', error: BYTES_MESSAGE })).toEqual({ kind: 'field', field: 'min_bytes', message: BYTES_MESSAGE });
    expect(refuse({ code: 'INVALID_DELIVERY_SETTINGS', field: 'min_bytes', error: `min_bytes: ${BYTES_MESSAGE}` }).message).toBe(BYTES_MESSAGE);
    expect(refuse({ code: 'INVALID_DELIVERY_SETTINGS', field: 'rules[0].prefix', error: 'Enter a path.' })).toEqual({ kind: 'save', message: 'Enter a path.' });
    expect(refuse({ code: 'AGENT_TOO_OLD', agent: 'edge-1', feature: 'compression' })).toEqual({ kind: 'too-old', message: 'edge-1 is too old for compression. Upgrade it to use this.' });
    expect(refuse({ code: 'BUNDLE_TOO_LARGE', error: 'Too large.' })).toEqual({ kind: 'save', message: 'Too large.' });
    expect(classifySpeedRefusal({ error: '', kind: 'network' } as ApiError, fields, 'compression', 'Could not save compression.')).toEqual({ kind: 'save', message: 'Could not save compression.' });
  });
});

describe('the numbers under Compression', () => {
  test('say how many answers were compressed and how much smaller they are', () => {
    expect(compressionNumbers({ responses: 800, skipped_streamed: 0, bytes_saved: 91234567 })).toEqual(['In the last hour 800 answers were sent compressed, 87 MiB smaller.']);
    expect(compressionNumbers({ responses: 1, skipped_streamed: 0, bytes_saved: 2048 })).toEqual(['In the last hour 1 answer was sent compressed, 2 KiB smaller.']);
  });

  test('say so when nothing was compressed', () => {
    expect(compressionNumbers({ responses: 0, skipped_streamed: 0, bytes_saved: 0 })).toEqual(['No answers were compressed in the last hour.']);
  });

  test('add the answers that could not be, with the reason, only when there are some', () => {
    expect(compressionNumbers({ responses: 10, skipped_streamed: 3, bytes_saved: 4096 })).toEqual([
      'In the last hour 10 answers were sent compressed, 4 KiB smaller.',
      '3 could not be compressed because your application sent them in pieces, without a size.',
    ]);
    expect(compressionNumbers({ responses: 0, skipped_streamed: 1, bytes_saved: 0 })).toEqual([
      'No answers were compressed in the last hour.',
      '1 could not be compressed because your application sent it in pieces, without a size.',
    ]);
  });

  test('show nothing without a report, and never a negative size', () => {
    expect(compressionNumbers(null)).toEqual([]);
    expect(compressionNumbers({ responses: 2, skipped_streamed: 0, bytes_saved: -5 })[0]).toBe('In the last hour 2 answers were sent compressed, 0 B smaller.');
  });
});

describe('the browser cache time', () => {
  test('shows seconds in the largest unit that keeps them whole', () => {
    expect(lifetimeParts(0)).toEqual({ amount: '', unit: 'min' });
    expect(lifetimeParts(90)).toEqual({ amount: '90', unit: 's' });
    expect(lifetimeParts(3600)).toEqual({ amount: '1', unit: 'h' });
    expect(lifetimeParts(86_400 * 30)).toEqual({ amount: '30', unit: 'd' });
    expect(lifetimeParts(300)).toEqual({ amount: '5', unit: 'min' });
  });

  test('reads an empty field as not set and anything else that is not whole seconds as NaN', () => {
    expect(lifetimeFromParts('', 'h')).toBe(0);
    expect(lifetimeFromParts('2', 'h')).toBe(7200);
    expect(lifetimeFromParts('1.5', 'h')).toBe(5400);
    expect(lifetimeFromParts('0.5', 's')).toBeNaN();
    expect(lifetimeFromParts('-1', 'd')).toBeNaN();
    expect(lifetimeFromParts('soon', 'd')).toBeNaN();
    expect(lifetimeFromParts('365', 'd')).toBe(365 * 86400);
  });
});
