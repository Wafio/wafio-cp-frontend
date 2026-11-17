// sse.ts: frame parsing, ticket per connection attempt, and the terminal
// 'failed' state for 401/403/404.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import './support/runes';
import { flushMicrotasks } from './support/runes';

const { parseSSEChunk, createProjectEventStream } = await import('../src/lib/sse');

type Call = { url: string; method: string; body?: unknown };

const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let respond: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function eventStream(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

let ticketSeq = 0;
function ticketResponse(): Response {
  ticketSeq += 1;
  return json(201, { ticket: `t${ticketSeq}`, stream: 'waf', expires_at: '2026-09-27T00:01:00Z', expires_in: 60 });
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  calls = [];
  ticketSeq = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ticketCalls = () => calls.filter((c) => c.url.endsWith('/stream-ticket'));
const streamCalls = () => calls.filter((c) => c.url.includes('/stream?'));

describe('parseSSEChunk', () => {
  test('splits frames, joins multi-line data, ignores comments and returns the tail', () => {
    const seen: [string, string][] = [];
    const rest = parseSSEChunk(': keep-alive\n\nevent: agents\ndata: [1,\ndata: 2]\n\ndata: {"a":1}\r\n\r\nevent: partial\ndata: x', (e, d) => seen.push([e, d]));
    expect(seen).toEqual([
      ['agents', '[1,\n2]'],
      ['message', '{"a":1}'],
    ]);
    expect(rest).toBe('event: partial\ndata: x');
  });

  test('a frame without data dispatches nothing', () => {
    const seen: string[] = [];
    expect(parseSSEChunk('event: ping\n\n', (e) => seen.push(e))).toBe('');
    expect(seen).toEqual([]);
  });
});

describe('createProjectEventStream', () => {
  test('requests a ticket, puts it in the stream URL and dispatches parsed events', async () => {
    const agents: unknown[] = [];
    const states: string[] = [];
    respond = (call) => (call.url.endsWith('/stream-ticket') ? ticketResponse() : eventStream('event: agents\ndata: [{"id":"a1","is_online":true}]\n\n'));
    const conn = createProjectEventStream({
      projectId: 'p1',
      stream: 'waf',
      events: { agents: (d) => agents.push(d) },
      onStateChange: (s) => states.push(s),
    });
    await settle();
    conn.close();
    expect(ticketCalls()[0]).toMatchObject({ method: 'POST', body: { stream: 'waf' } });
    expect(streamCalls()[0].url).toContain('/api/projects/p1/waf/stream?ticket=t1');
    expect(streamCalls()[0].url).not.toContain('token=');
    expect(agents).toEqual([[{ id: 'a1', is_online: true }]]);
    expect(states.slice(0, 2)).toEqual(['connecting', 'open']);
    expect(states.at(-1)).toBe('closed');
  });

  for (const status of [401, 403, 404]) {
    test(`a ${status} on the stream stops for good with state 'failed' and onFatal`, async () => {
      const fatal: unknown[] = [];
      respond = (call) => (call.url.endsWith('/stream-ticket') ? ticketResponse() : json(status, { error: 'refused', code: 'STREAM_TICKET_INVALID' }));
      const conn = createProjectEventStream({ projectId: 'p1', stream: 'host', events: {}, onFatal: (e) => fatal.push(e) });
      await settle();
      expect(conn.state).toBe('failed');
      expect(fatal).toEqual([{ status, error: 'refused', code: 'STREAM_TICKET_INVALID' }]);
      expect(streamCalls()).toHaveLength(1);
      conn.close();
    });
  }

  test('a refused ticket request (404 NO_AGENTS) is fatal and opens no stream', async () => {
    const fatal: unknown[] = [];
    respond = () => json(404, { error: 'No host agent is registered for this project.', code: 'NO_AGENTS' });
    const conn = createProjectEventStream({ projectId: 'p1', stream: 'host', events: {}, onFatal: (e) => fatal.push(e) });
    await settle();
    expect(conn.state).toBe('failed');
    expect(fatal).toEqual([{ status: 404, error: 'No host agent is registered for this project.', code: 'NO_AGENTS' }]);
    expect(streamCalls()).toHaveLength(0);
    conn.close();
  });

  test('a 5xx is transient: state reconnecting, not failed', async () => {
    const errors: unknown[] = [];
    respond = (call) => (call.url.endsWith('/stream-ticket') ? ticketResponse() : json(503, { error: 'unavailable' }));
    const conn = createProjectEventStream({ projectId: 'p1', stream: 'waf', events: {}, onError: (e) => errors.push(e) });
    await settle();
    expect(conn.state).toBe('reconnecting');
    expect(errors).toHaveLength(1);
    conn.close();
    expect(conn.state).toBe('closed');
  });

  test('every connection attempt uses a fresh single-use ticket', async () => {
    respond = (call) => (call.url.endsWith('/stream-ticket') ? ticketResponse() : json(401, { error: 'invalid ticket', code: 'STREAM_TICKET_INVALID' }));
    const conn = createProjectEventStream({ projectId: 'p1', stream: 'agent-decisions', events: {} });
    await settle();
    expect(conn.state).toBe('failed');
    conn.reconnect();
    await settle();
    conn.close();
    expect(ticketCalls()).toHaveLength(2);
    expect(streamCalls().map((c) => new URL(c.url).searchParams.get('ticket'))).toEqual(['t1', 't2']);
  });

  test('stream-closed "expired" reconnects with a fresh ticket', async () => {
    const seen: unknown[] = [];
    let streams = 0;
    respond = (call) => {
      if (call.url.endsWith('/stream-ticket')) return ticketResponse();
      streams += 1;
      return streams === 1
        ? eventStream('event: agents\ndata: [1]\n\nevent: stream-closed\ndata: {"reason":"expired"}\n\n')
        : eventStream('event: agents\ndata: [2]\n\n');
    };
    const conn = createProjectEventStream({ projectId: 'p1', stream: 'waf', events: { agents: (d) => seen.push(d) } });
    await settle();
    // Closed right after opening: the reconnect waits for the minimum backoff.
    await new Promise((r) => setTimeout(r, 1100));
    await settle();
    conn.close();
    expect(ticketCalls().length).toBeGreaterThanOrEqual(2);
    expect(streamCalls()[1].url).toContain('ticket=t2');
    expect(seen).toContainEqual([2]);
  });

  test('stream-closed "revoked" stops the stream and re-checks the session', async () => {
    const fatal: { code?: string }[] = [];
    respond = (call) => {
      if (call.url.endsWith('/stream-ticket')) return ticketResponse();
      if (call.url.endsWith('/api/me')) return json(200, { id: 'u1', email: 'a@example.test', name: 'A', role: 'user' });
      return eventStream('event: stream-closed\ndata: {"reason":"revoked"}\n\n');
    };
    const conn = createProjectEventStream({ projectId: 'p1', stream: 'waf', events: {}, onFatal: (e) => fatal.push(e) });
    await settle();
    expect(conn.state).toBe('failed');
    expect(fatal[0]?.code).toBe('STREAM_REVOKED');
    expect(calls.some((c) => c.url.endsWith('/api/me'))).toBe(true);
    expect(streamCalls()).toHaveLength(1);
    conn.close();
  });
});
