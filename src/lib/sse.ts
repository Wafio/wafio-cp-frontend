// ──────────────────────────────────────────────────────────────────────────────
// SSE Client, real-time streams for the project dashboards
// ──────────────────────────────────────────────────────────────────────────────
//
// Usage (host telemetry):
//   const sse = createSSEConnection({
//     projectId,
//     channels: ['metrics', 'events', 'connections', 'bandwidth', 'status'],
//     onMetrics: (m) => { metrics = m; },
//     onStateChange: (s) => { sseState = s; },
//     onFatal: (e) => { if (e.code === 'NO_AGENTS') showEmptyState(); },
//   });
//   onDestroy(() => sse.close());
//
// Usage (any project stream: 'host' | 'waf' | 'agent-decisions'):
//   const conn = createProjectEventStream({
//     projectId, stream: 'waf',
//     events: { agents: (list) => { … } },
//   });
//
// Authentication: every connection attempt first requests a
// single-use stream ticket (POST /api/projects/:id/stream-ticket) and puts it
// in the URL. The session JWT never travels in a query string.
//
// The stream is read with fetch rather than EventSource so the HTTP status is
// visible: 401/403/404 (session expired, access removed, project or agent
// gone, NO_AGENTS) stop the connection for good, state 'failed' and
// onFatal, instead of retrying forever. Network errors, 429 and 5xx retry
// with exponential backoff (1 s → 30 s), each attempt with a fresh ticket.
// A 429 STREAM_LIMIT (per-project cap on open host/agent streams) is
// reported through onLimit and retried only every 30 s, so a page over the
// cap does not hammer the server; pages keep polling meanwhile.
//
// The server ends an open stream with `event: stream-closed`
// data {"reason": "expired"|"revoked"}: "expired" (the 1 h stream
// lifetime) reconnects at once with a fresh ticket; "revoked" (the token was
// revoked or the project role removed) stops the stream (state 'failed',
// code STREAM_REVOKED) and re-checks the session through the API client, so
// a revoked token ends the session the normal way (401 → login) while a user
// who only lost this project keeps the session.
// ──────────────────────────────────────────────────────────────────────────────

import type {
	ApiError,
	EBPFStatus,
	EBPFMetrics,
	EBPFEvent,
	EBPFConnection,
	EBPFBandwidthEntry,
	ProjectStreamName,
	TraceEvent,
	TraceStatus,
	TraceStats,
	EnforcementLogEntry,
} from '#lib/api.js';
import { createStreamTicket, getMe, projectStreamURL } from '#lib/api.js';

export type SSEChannel =
	| 'metrics'
	| 'events'
	| 'connections'
	| 'bandwidth'
	| 'status'
	| 'trace'
	| 'stats'
	| 'enforcement'
	| 'hostinfo';

/**
 * 'failed' is terminal: the server refused the stream (401/403/404) and no
 * further attempt is made until `reconnect()` is called.
 */
export type SSEConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting' | 'failed';

/** Why a stream stopped for good (state 'failed'). */
export interface SSEFatalError {
	/** HTTP status of the refused ticket request or stream request. */
	status?: number;
	/** Server message, e.g. "No host agent is registered for this project." */
	error: string;
	/** Server code, e.g. NO_AGENTS, PROJECT_NOT_FOUND, AGENT_NOT_FOUND. */
	code?: string;
}

export interface SSECallbacks {
	onMetrics?: (data: EBPFMetrics) => void;
	onEvents?: (data: { events: EBPFEvent[]; count: number }) => void;
	onConnections?: (data: { connections: EBPFConnection[]; count: number }) => void;
	onBandwidth?: (data: { entries: EBPFBandwidthEntry[]; count: number }) => void;
	onStatus?: (data: { ebpf?: EBPFStatus; trace?: TraceStatus }) => void;
	onTrace?: (data: TraceEvent[]) => void;
	onStats?: (data: TraceStats) => void;
	onEnforcement?: (data: EnforcementLogEntry[]) => void;
	/** Live host system info (CPU, memory, load avg, uptime, etc.) */
	onHostInfo?: (data: Record<string, unknown>) => void;
}

interface StreamLifecycle {
	onStateChange?: (state: SSEConnectionState) => void;
	/** A transient failure; the connection retries. */
	onError?: (error: Event) => void;
	/** The server refused the stream (401/403/404); the connection has stopped. */
	onFatal?: (error: SSEFatalError) => void;
	/**
	 * Too many streams are open for the project (429 STREAM_LIMIT). The
	 * connection keeps retrying every STREAM_LIMIT_RETRY_MS; the next 'open'
	 * state means a slot was free again.
	 */
	onLimit?: (error: SSEFatalError) => void;
	/** Base URL override (default: the API client base, VITE_API_BASE_URL, else same origin) */
	baseUrl?: string;
}

export interface SSEOptions extends SSECallbacks, StreamLifecycle {
	channels: SSEChannel[];
	/**
	 * @deprecated Ignored. Streams authenticate with a single-use stream
	 * ticket requested through the session; the JWT is never put in the URL.
	 */
	token?: string;
	/** Agent ID to stream data for (optional, defaults to project's first agent) */
	agentId?: string;
	/** Host ID to stream data for (resolved to the host's agent server-side) */
	hostId?: string;
	/** Project ID (required for project-scoped streaming) */
	projectId: string;
	/** Time range for stats channel: "5m" | "15m" | "1h" | "24h" | "7d" | "30d" | "all" */
	statsRange?: string;
}

export interface ProjectEventStreamOptions extends StreamLifecycle {
	projectId: string;
	stream: ProjectStreamName;
	/** Query parameters of the stream endpoint (the ticket is added). */
	params?: Record<string, string | undefined>;
	/** Handlers per SSE event name; `data` is the parsed JSON payload. */
	events: Record<string, (data: unknown) => void>;
}

export interface SSEConnection {
	/** Close the SSE connection permanently */
	close: () => void;
	/** Current connection state */
	readonly state: SSEConnectionState;
	/** Reconnect manually (also after a 'failed' state) */
	reconnect: () => void;
}

const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const MAX_FRAME_CHARS = 4 * 1024 * 1024;

/** Reason of a server `stream-closed` event. */
export type StreamClosedReason = 'expired' | 'revoked';

/** Reads the reason of a `stream-closed` payload; unknown reasons are treated as 'expired'. */
export function streamClosedReason(data: string): StreamClosedReason {
	try {
		const parsed = JSON.parse(data) as { reason?: unknown } | null;
		return parsed?.reason === 'revoked' ? 'revoked' : 'expired';
	} catch {
		return 'expired';
	}
}

/** Delay before retrying a stream refused with 429 STREAM_LIMIT. */
export const STREAM_LIMIT_RETRY_MS = MAX_RECONNECT_MS;

/** Shown while a stream waits for a free slot (429 STREAM_LIMIT). */
export const STREAM_LIMIT_MESSAGE =
	'Too many live views are open for this project. Close another dashboard tab; this view retries every 30 seconds and refreshes by polling meanwhile.';

/** Shown when the account, not the project, is at its stream ceiling. */
export const STREAM_LIMIT_ACCOUNT_MESSAGE =
	'Too many live views are open for your account across projects. Close another dashboard tab; this view retries every 30 seconds and refreshes by polling meanwhile.';

/** The STREAM_LIMIT message for a refusal; the server names the account or the project ceiling. */
export function streamLimitMessage(serverError: string | undefined): string {
	return serverError && /for this account/i.test(serverError) ? STREAM_LIMIT_ACCOUNT_MESSAGE : STREAM_LIMIT_MESSAGE;
}

/** True for a stream cap refusal (429 STREAM_LIMIT: project or account ceiling). */
export function isStreamLimit(status: number | undefined, code: string | undefined): boolean {
	return status === 429 && code === 'STREAM_LIMIT';
}

/** Statuses after which retrying cannot succeed. */
function isFatalStatus(status: number | undefined): boolean {
	return status === 401 || status === 403 || status === 404;
}

/**
 * Splits a text/event-stream into events. Returns the unconsumed tail.
 * Handles \n and \r\n line ends; ignores comments, id and retry fields.
 */
export function parseSSEChunk(
	buffer: string,
	dispatch: (event: string, data: string) => void,
): string {
	let rest = buffer.replace(/\r\n/g, '\n');
	let boundary: number;
	while ((boundary = rest.indexOf('\n\n')) >= 0) {
		const frame = rest.slice(0, boundary);
		rest = rest.slice(boundary + 2);
		let event = 'message';
		const data: string[] = [];
		for (const line of frame.split('\n')) {
			if (line === '' || line.startsWith(':')) continue;
			const colon = line.indexOf(':');
			const field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) value = value.slice(1);
			if (field === 'event') event = value || 'message';
			else if (field === 'data') data.push(value);
		}
		if (data.length) dispatch(event, data.join('\n'));
	}
	return rest;
}

async function errorFromResponse(res: Response): Promise<SSEFatalError> {
	const body = await res.json().catch(() => null);
	return {
		status: res.status,
		error: typeof body?.error === 'string' ? body.error : `Stream request failed (${res.status})`,
		code: typeof body?.code === 'string' ? body.code : undefined,
	};
}

/**
 * Opens a ticket-authenticated stream of one project and keeps it open until
 * `close()`, reconnecting after transient failures.
 */
export function createProjectEventStream(options: ProjectEventStreamOptions): SSEConnection {
	const { projectId, stream, params = {}, events, onStateChange, onError, onFatal, onLimit, baseUrl } = options;

	let state: SSEConnectionState = 'connecting';
	let closed = false;
	let backoffMs = MIN_RECONNECT_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let controller: AbortController | null = null;
	// Each connect() gets an epoch; a superseded attempt stops touching state.
	let epoch = 0;

	function setState(s: SSEConnectionState) {
		state = s;
		onStateChange?.(s);
	}

	// Set by a `stream-closed` frame of the current connection.
	let closedReason: StreamClosedReason | null = null;

	function dispatch(event: string, data: string) {
		if (event === 'stream-closed') {
			closedReason = streamClosedReason(data);
			return;
		}
		const handler = events[event];
		if (!handler) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return; // skip malformed frames
		}
		handler(parsed);
	}

	function fail(err: SSEFatalError) {
		setState('failed');
		onFatal?.(err);
	}

	/** 429 STREAM_LIMIT: report it and wait the long delay before the next attempt. */
	function limited(attempt: number, err: SSEFatalError) {
		onLimit?.({ ...err, error: streamLimitMessage(err.error) });
		backoffMs = STREAM_LIMIT_RETRY_MS;
		scheduleReconnect(attempt);
	}

	function scheduleReconnect(attempt: number) {
		if (closed || attempt !== epoch) return;
		setState('reconnecting');
		const delay = backoffMs;
		backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_MS);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void connect();
		}, delay);
	}

	async function connect(): Promise<void> {
		if (closed) return;
		const attempt = ++epoch;
		if (state !== 'reconnecting') setState('connecting');

		const ticket = await createStreamTicket(projectId, stream);
		if (closed || attempt !== epoch) return;
		if (ticket.error || !ticket.data) {
			const err: ApiError = ticket.error ?? { kind: 'protocol', error: 'No stream ticket issued' };
			if (isFatalStatus(err.status)) {
				fail({ status: err.status, error: err.error, code: err.code });
			} else if (isStreamLimit(err.status, err.code)) {
				limited(attempt, { status: err.status, error: err.error, code: err.code });
			} else {
				onError?.(new Event('error'));
				scheduleReconnect(attempt);
			}
			return;
		}

		controller = new AbortController();
		const url = projectStreamURL(projectId, stream, ticket.data.ticket, params, baseUrl);
		let res: Response;
		try {
			res = await fetch(url, {
				headers: { Accept: 'text/event-stream' },
				cache: 'no-store',
				signal: controller.signal,
			});
		} catch {
			if (closed || attempt !== epoch) return;
			onError?.(new Event('error'));
			scheduleReconnect(attempt);
			return;
		}
		if (closed || attempt !== epoch) {
			void res.body?.cancel().catch(() => {});
			return;
		}
		if (!res.ok) {
			const err = await errorFromResponse(res);
			if (closed || attempt !== epoch) return;
			if (isFatalStatus(res.status)) {
				fail(err);
			} else if (isStreamLimit(err.status, err.code)) {
				limited(attempt, err);
			} else {
				onError?.(new Event('error'));
				scheduleReconnect(attempt);
			}
			return;
		}
		if (!res.body || !res.headers.get('Content-Type')?.includes('text/event-stream')) {
			onError?.(new Event('error'));
			scheduleReconnect(attempt);
			return;
		}

		backoffMs = MIN_RECONNECT_MS;
		closedReason = null;
		const openedAt = Date.now();
		setState('open');
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let pending = '';
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				pending = parseSSEChunk(pending + decoder.decode(value, { stream: true }), dispatch);
				if (closedReason) break;
				if (pending.length > MAX_FRAME_CHARS) break; // runaway frame: reconnect
			}
		} catch {
			// aborted by close() or the connection dropped
		} finally {
			if (closedReason) void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		if (closed || attempt !== epoch) return;
		if (closedReason === 'expired') {
			// Planned end of the stream lifetime: fresh ticket, no backoff
			// unless the stream closed right after opening (no tight loop).
			closedReason = null;
			if (Date.now() - openedAt >= MIN_RECONNECT_MS) {
				setState('reconnecting');
				void connect();
			} else {
				scheduleReconnect(attempt);
			}
			return;
		}
		if (closedReason === 'revoked') {
			closedReason = null;
			fail({ status: 401, error: 'The stream was closed because your access changed.', code: 'STREAM_REVOKED' });
			// A 401 here (TOKEN_REVOKED) ends the session through the API client.
			void getMe();
			return;
		}
		onError?.(new Event('error'));
		scheduleReconnect(attempt);
	}

	function stop() {
		epoch++;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		controller?.abort();
		controller = null;
	}

	void connect();

	return {
		get state() {
			return state;
		},
		close() {
			closed = true;
			stop();
			setState('closed');
		},
		reconnect() {
			closed = false;
			stop();
			backoffMs = MIN_RECONNECT_MS;
			state = 'connecting';
			void connect();
		},
	};
}

/**
 * Create a Server-Sent Events connection to the host telemetry stream
 * (GET /api/projects/:id/host/stream). See createProjectEventStream for
 * authentication, reconnection and the terminal 'failed' state.
 */
export function createSSEConnection(options: SSEOptions): SSEConnection {
	const { channels, agentId, hostId, projectId, statsRange } = options;
	const typed = <T>(fn?: (data: T) => void) => (fn ? (data: unknown) => fn(data as T) : undefined);
	const handlers: Record<string, ((data: unknown) => void) | undefined> = {
		metrics: typed(options.onMetrics),
		events: typed(options.onEvents),
		connections: typed(options.onConnections),
		bandwidth: typed(options.onBandwidth),
		status: typed(options.onStatus),
		trace: typed(options.onTrace),
		stats: typed(options.onStats),
		enforcement: typed(options.onEnforcement),
		hostinfo: typed(options.onHostInfo),
	};
	const events: Record<string, (data: unknown) => void> = {};
	for (const [name, handler] of Object.entries(handlers)) {
		if (handler) events[name] = handler;
	}
	return createProjectEventStream({
		projectId,
		stream: 'host',
		params: {
			channels: channels.join(','),
			agent_id: agentId,
			host_id: agentId ? undefined : hostId,
			stats_range: statsRange,
		},
		events,
		onStateChange: options.onStateChange,
		onError: options.onError,
		onFatal: options.onFatal,
		onLimit: options.onLimit,
		baseUrl: options.baseUrl,
	});
}
