/**
 * Speed tab of an application (compression, files from a folder; the cache's own checks are in cache.ts) and the
 * status lines of the main host name and the path prefix: the checks the control plane makes (same numbers and texts,
 * never stricter), the form models, what the agent reported in words, and how often to ask. Pure functions; the
 * panel is AppSpeed.svelte.
 */
import type { ApiError, AppCompression, AppCompressionStats, AppDelivery, AppDeliveryAgent, AppEdgeFeatureState, AppStaticFiles, EdgePart, StaticMissing } from '../../api';
import { formatBytes, formatNumber } from '../../format';
import { bytesFromInput, bytesToInput } from './inputs';
import { keptSegment } from './kept-names';
import { stripFieldPrefix } from './maintenance';

/** The limits of the control plane (domain delivery settings). */
export const SPEED_LIMITS = {
  minBytesDefault: 1024,
  minBytesMax: 1 << 20,
  rootBytes: 1024,
  maxAgeMaxS: 365 * 24 * 60 * 60,
} as const;

export const BYTES_MESSAGE = 'Enter a size from 0 bytes to 1 MiB.';
export const SECONDS_MESSAGE = 'Enter a time from 0 seconds to 365 days.';
export const ROOT_INVALID_MESSAGE = 'Enter a full path that starts with /, such as /var/www/shop/public, without . or .. parts.';
export const ROOT_FORBIDDEN_MESSAGE = "This folder holds system or WAFio files. Choose the folder of your site's files.";
export const MISSING_MESSAGE = 'Choose "Ask the application" or "Answer Not found".';

// The server trims every Unicode space and lower-cases only A to Z; a value with another character goes to it unjudged.
const NON_ASCII = /[^\u0000-\u007f]/;
const ASCII_SPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const trimAscii = (value: string): string => value.replace(ASCII_SPACE, '');

// ── Checks (domain.Compression.Normalize and domain.StaticFiles.Normalize) ─

export interface SpeedFieldError<F extends string> {
  field: F;
  message: string;
}

export interface CompressionInput {
  enabled: boolean;
  /** null: left out, the default applies. */
  min_bytes: number | null;
}

export type CompressionField = 'min_bytes';
export type NormalizedCompression = { settings: AppCompression; error?: undefined } | { settings?: undefined; error: SpeedFieldError<CompressionField> };

/** The stored form of the compression settings, or the first refused field. The size is checked whether the switch is on or off. */
export function normalizeCompression(input: CompressionInput): NormalizedCompression {
  const bytes = input.min_bytes ?? SPEED_LIMITS.minBytesDefault;
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > SPEED_LIMITS.minBytesMax) return { error: { field: 'min_bytes', message: BYTES_MESSAGE } };
  return { settings: { enabled: input.enabled, min_bytes: bytes } };
}

export interface StaticFilesInput {
  enabled: boolean;
  root: string;
  /** '' takes the default, app. */
  missing: string;
  max_age_s: number;
}

export type StaticFilesField = 'root' | 'missing' | 'max_age_s';
export type NormalizedStaticFiles = { settings: AppStaticFiles; error?: undefined } | { settings?: undefined; error: SpeedFieldError<StaticFilesField> };

/** Folders that are never served, with the folders above and below them (the agent runs the same list again on the folder it resolved). */
export const FORBIDDEN_ROOTS: readonly string[] = ['/etc', '/root', '/proc', '/sys', '/dev', '/run', '/boot', '/usr', '/var/lib/wafio-waf-agent', '/var/cache/wafio-waf'];

/** The folder is `/`, is or is below a forbidden folder, or is above one. */
export function systemFolder(root: string): boolean {
  return root === '/' || FORBIDDEN_ROOTS.some((forbidden) => root === forbidden || root.startsWith(`${forbidden}/`) || forbidden.startsWith(`${root}/`));
}

/**
 * A system folder, or a path with a part named like a system file (see kept-names.ts). Under /home the agent refuses
 * the folder first, as unreadable, so the control plane leaves it to the agent and so does this check.
 */
export function staticRootForbidden(root: string): boolean {
  if (systemFolder(root)) return true;
  if (root === '/home' || root.startsWith('/home/')) return false;
  return keptSegment(root) !== null;
}

/** An absolute path of at most 1,024 bytes with no empty, . or .. segment and no control character. */
function validRoot(root: string): boolean {
  if (!root.startsWith('/') || root.length > SPEED_LIMITS.rootBytes || /[\u0000-\u001f\u007f]/.test(root)) return false;
  return root === '/' || root.slice(1).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The stored form of the files settings (the folder without spaces around it and without the slashes that end it)
 * or the first refused field. A folder is required only while the switch is on. A folder with a character that is not
 * ASCII is not judged here: the server decides.
 */
export function normalizeStaticFiles(input: StaticFilesInput): NormalizedStaticFiles {
  const fail = (field: StaticFilesField, message: string): NormalizedStaticFiles => ({ error: { field, message } });
  let root = trimAscii(input.root);
  const stripped = root.replace(/\/+$/, '');
  if (stripped !== '') root = stripped;
  const missing = input.missing === '' ? 'app' : input.missing;
  if ((root !== '' || input.enabled) && !NON_ASCII.test(root)) {
    if (!validRoot(root)) return fail('root', ROOT_INVALID_MESSAGE);
    if (staticRootForbidden(root)) return fail('root', ROOT_FORBIDDEN_MESSAGE);
  }
  if (missing !== 'app' && missing !== 'not_found') return fail('missing', MISSING_MESSAGE);
  if (!Number.isInteger(input.max_age_s) || input.max_age_s < 0 || input.max_age_s > SPEED_LIMITS.maxAgeMaxS) return fail('max_age_s', SECONDS_MESSAGE);
  return { settings: { enabled: input.enabled, root, missing, max_age_s: input.max_age_s } };
}

// ── Forms ──────────────────────────────────────────────────────────────────

/** What the person edits: the size as text, so that an empty field means the default. */
export interface CompressionForm {
  enabled: boolean;
  minBytes: string;
}

export function compressionForm(settings: AppCompression): CompressionForm {
  return { enabled: settings.enabled, minBytes: bytesToInput(settings.min_bytes) };
}

/** The text as typed: empty is the default, a size that cannot be read is NaN and refused by the checks. */
export function compressionInput(form: CompressionForm): CompressionInput {
  const text = form.minBytes.trim();
  return { enabled: form.enabled, min_bytes: text === '' ? null : bytesFromInput(text) };
}

export interface StaticFilesForm {
  enabled: boolean;
  root: string;
  missing: StaticMissing;
  /** Seconds; NaN while the time cannot be read. */
  maxAge: number;
}

export function staticFilesForm(settings: AppStaticFiles): StaticFilesForm {
  return { enabled: settings.enabled, root: settings.root, missing: settings.missing, maxAge: settings.max_age_s };
}

export function staticFilesInput(form: StaticFilesForm): StaticFilesInput {
  return { enabled: form.enabled, root: form.root, missing: form.missing, max_age_s: form.maxAge };
}

/** The same settings once the server's normal form is applied; unreadable settings count as they are typed. */
export function sameCompression(form: CompressionForm, stored: AppCompression): boolean {
  const next = normalizeCompression(compressionInput(form)).settings;
  return next !== undefined && next.enabled === stored.enabled && next.min_bytes === stored.min_bytes;
}

export function sameStaticFiles(form: StaticFilesForm, stored: AppStaticFiles): boolean {
  const next = normalizeStaticFiles(staticFilesInput(form)).settings;
  return next !== undefined && next.enabled === stored.enabled && next.root === stored.root && next.missing === stored.missing && next.max_age_s === stored.max_age_s;
}

// ── Confirm: serving a folder ──────────────────────────────────────────────

/** Switching on, a new folder, or answering Not found makes files public or stops the application's requests: one confirm first. */
export function staticRootNeedsConfirm(stored: AppStaticFiles, next: AppStaticFiles): boolean {
  if (!next.enabled) return false;
  return !stored.enabled || next.root !== stored.root || (next.missing === 'not_found' && stored.missing !== 'not_found');
}

export const staticRootConfirmTitle = (root: string): string => `Serve files from ${root}?`;

export function staticRootConfirmText(missing: StaticMissing): string {
  const base = "Every file in this folder and the folders below it becomes public at the same path on this application's host names. Check that it holds no backups, exports or private uploads.";
  return missing === 'not_found' ? `${base} Your application stops receiving requests.` : base;
}

// ── Texts of the tab ───────────────────────────────────────────────────────

export const LOADING_TEXT = 'Loading speed settings.';
export const loadErrorText = (error: string): string => `Could not load the speed settings. ${error}`;
export const VIEWER_TEXT = 'You can view these settings. Members and owners can change them.';
export const UNASSIGNED_TEXT = 'No WAF agent serves this application yet. Saved settings apply once you assign one on the Assignment tab.';
export const offlineText = (agent: string): string => `${agent} is offline. Saved settings apply when it reconnects.`;
export const SPEED_INTRO = 'Make this application faster for visitors. Each part can be turned on alone and works in both modes. WAFio checks every request before any of them answers it.';

export const COMPRESSION_FIXED =
  'Pages for signed-in visitors are sent uncompressed, so their secrets cannot be guessed from the size. A visitor counts as signed in when the request carries an Authorization header or a common session cookie. If your application names its session cookie differently, add the name under Signed-in visitors below.';
/** Under the folder, while its path passes a name the agent never serves. */
export const keptFolderText = (name: string): string =>
  `The WAF agent will not use this folder: its path has a part named ${name}, and names like that are never served. Choose a folder whose path has no such part.`;

/** The error under the folder when the check refuses it for the name; short, so that it stays on one line beside its icon. */
export const keptFolderError = (name: string): string => `This path has a part named ${name}, which is never served. Choose another folder.`;

/**
 * What is said under the Folder field. A folder refused for a name in its path is told with that name in place of the
 * general sentence (which would send the person looking for system files); a folder with such a name that is not refused
 * yet (not left yet, or under /home, which the check leaves to the agent) gets a warning with the longer explanation. A system folder
 * keeps the general sentence.
 */
export function folderNotes(root: string, error: string | undefined): { error: string | undefined; warning: string | null } {
  const path = root.trim();
  const name = keptSegment(path);
  if (name === null || systemFolder(path)) return { error, warning: null };
  if (error === ROOT_FORBIDDEN_MESSAGE) return { error: keptFolderError(name), warning: null };
  return { error, warning: keptFolderText(name) };
}

export const COMPRESSION_LIMITS_FIXED = 'Answers over 8 MiB, and answers your application streams without a length, are not compressed.';
export const FILES_FIXED =
  'Never served from the folder: folder listings, hidden files (names that start with a dot, except .well-known), PHP files, symbolic links, and any path with a part named like a system file or folder, such as profile, network, group, hosts, security, private, credentials or systemd. Those requests go to your application, or get Not found if you chose that. Visitors can resume large downloads.';

/** How a part is named in a sentence about the agent. */
export const PART_LABEL: Record<EdgePart, string> = {
  redirects: 'the main host name or path prefix',
  compression: 'compression',
  static_files: 'files from a folder',
  cache: 'the cache',
};

const agentName = (agent: string): string => agent || 'The WAF agent';

/**
 * Which WAF agent has the parts of the Speed tab: v2.2.0 brought them, every release up to v2.1.1 lacks them all.
 */
export const AGENT_WITH_PARTS = 'v2.2.0 or newer';

/**
 * The agent said Hello without the part. One that already has another part is a build from between the releases, so
 * the release number would mislead: it is told to take a newer build. `features` is what the agent said, when known.
 */
export function tooOldText(agent: string, part: string, features?: AppDeliveryAgent['features']): string {
  const between = features !== undefined && Object.values(features).includes(true);
  return `${agentName(agent)} is too old for ${part}. Upgrade it to ${between ? 'a newer build of the WAF agent' : `a WAF agent ${AGENT_WITH_PARTS}`} to use this.`;
}

/** The agent is online and has not confirmed the latest configuration after its time; the likeliest cause is a refusal of the whole configuration. */
export const noAnswerText = (agent: string): string => `${agent} is online but has not confirmed the latest configuration. It may have refused it; its log says why.`;

/** "compression, files from a folder and the cache". */
function listParts(parts: readonly string[]): string {
  const labels = parts.map((part) => PART_LABEL[part as EdgePart] ?? part);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels.join('');
}

export const unsupportedPartsText = (agent: string, parts: readonly string[]): string =>
  `${agentName(agent)} cannot run ${listParts(parts)} of this application. Turn them off first, or upgrade it.`;

/** The dashboard's text for the two 409 answers that name the agent; null for any other answer. */
export function agentRefusalText(error: Pick<ApiError, 'code' | 'agent' | 'parts' | 'feature'> | undefined, partLabel?: string): string | null {
  if (error?.code === 'AGENT_TOO_OLD') return tooOldText(error.agent ?? '', partLabel ?? PART_LABEL[error.feature as EdgePart] ?? 'this part');
  if (error?.code === 'FEATURE_UNSUPPORTED') return unsupportedPartsText(error.agent ?? '', error.parts ?? []);
  return null;
}

export type SpeedRefusal<F extends string> = { kind: 'field'; field: F; message: string } | { kind: 'too-old' | 'save'; message: string };

/**
 * A 400 INVALID_DELIVERY_SETTINGS belongs under the field it names, AGENT_TOO_OLD is said as the agent being too
 * old, and BUNDLE_TOO_LARGE and the rest are shown above the buttons as the server wrote them.
 */
export function classifySpeedRefusal<F extends string>(error: ApiError | undefined, fields: readonly F[], part: EdgePart, fallback: string): SpeedRefusal<F> {
  const field = fields.find((name) => name === error?.field);
  if (error?.code === 'INVALID_DELIVERY_SETTINGS' && field) return { kind: 'field', field, message: stripFieldPrefix(error.error, field) };
  const tooOld = agentRefusalText(error, PART_LABEL[part]);
  if (tooOld) return { kind: error?.code === 'AGENT_TOO_OLD' ? 'too-old' : 'save', message: tooOld };
  return { kind: 'save', message: error?.error || fallback };
}

// ── What the agent reported ────────────────────────────────────────────────

/** How long the agent gets to answer a save before the line says so. */
export const NO_ANSWER_AFTER_MS = 2 * 60 * 1000;
export const POLL_FAST_MS = 10_000;
export const POLL_SLOW_MS = 60_000;

/** The agent has had its time to answer something started at `since` (an epoch in ms or an ISO time); a time that cannot be read is not overdue. */
export const answerOverdue = (since: string | number, now: number): boolean => now - (typeof since === 'string' ? Date.parse(since) : since) >= NO_ANSWER_AFTER_MS;

export interface PartLine {
  /** A refusal is a warning, not an error: an error alert takes focus after a failed save, and this line is no failed save. */
  tone: 'success' | 'info' | 'warning';
  text: string;
  /** What the agent keeps doing, after a refusal. */
  more?: string;
}

/** The agent says it cannot apply the part: older than it (null: it never said). */
export function tooOld(delivery: Pick<AppDelivery, 'agent'> | null, part: EdgePart): boolean {
  return delivery?.agent?.features[part] === false;
}

/** The agent has answered the latest bundle and said something about this part. */
function reported(delivery: AppDelivery, part: EdgePart): AppEdgeFeatureState | null {
  const status = delivery.status;
  if (!status || delivery.generation === null || status.generation < delivery.generation) return null;
  return status[part];
}

/** The detail of disk_too_small is two decimal byte counts, "<free> <asked>", and of memory_too_small one, "<total>"; anything else is not read. */
function byteCounts(detail: string, count: number): number[] | null {
  const parts = detail.split(' ');
  return parts.length === count && parts.every((part) => /^\d{1,15}$/.test(part)) ? parts.map(Number) : null;
}

/** What the agent writes after the folder when the disk under it did not answer within its 3 seconds. */
const NO_DISK_ANSWER = ' (no answer from the disk)';

/** The reason of a refusal, in words; `folder` is the folder the person saved. */
export function refusalReason(state: Pick<AppEdgeFeatureState, 'code' | 'detail'>, folder: string): string {
  const stuck = state.code === 'root_unreadable' && state.detail.endsWith(NO_DISK_ANSWER);
  const where = folder || (stuck ? state.detail.slice(0, -NO_DISK_ANSWER.length) : state.detail);
  switch (state.code) {
    case 'root_missing':
      return `${where} does not exist on its host`;
    case 'root_not_directory':
      return `${where} is a file, not a folder`;
    case 'root_unreadable':
      // A stuck disk is no permission problem: a network mount whose server is down answers nothing.
      if (stuck) return `the disk under ${where} did not answer within 3 seconds. If it is a network mount, check that its server is up`;
      return `it cannot read ${where}. It runs as the user wafio, and its service hides /home, /root and /run/user`;
    case 'root_forbidden': {
      // A folder under /etc or the like holds system files; a path that only passes a folder named like one is refused for the name.
      const name = systemFolder(where) ? null : keptSegment(where);
      return name === null ? `${where} holds system or WAFio files` : `${where} has a part named ${name}, a name the agent never serves from a folder`;
    }
    case 'cache_dir_unusable':
      return 'its cache folder /var/cache/wafio-waf was not usable at start; its log says why. Fix or reinstall, then restart it';
    case 'disk_too_small': {
      const fix = 'Lower Disk space or free up space on the host';
      const sizes = byteCounts(state.detail, 2);
      if (sizes) return `the cache disk has ${formatBytes(sizes[0])} free, less than the ${formatBytes(sizes[1])} its applications ask for (5 % of the disk stays free). ${fix}`;
      return `the cache disk has less free space than its applications ask for${state.detail ? ` (${state.detail})` : ''}, and 5 % of the disk stays free. ${fix}`;
    }
    case 'memory_too_small': {
      const fix = 'Lower Memory for hot copies';
      const total = byteCounts(state.detail, 1);
      if (total) return `hot copies would use more than a quarter of the host's ${formatBytes(total[0])} memory. ${fix}`;
      return `hot copies would use more than a quarter of the host's memory${state.detail ? ` (${state.detail})` : ''}. ${fix}`;
    }
    case 'invalid':
      return `the settings failed its own checks${state.detail ? ` (${state.detail})` : ''}. Upgrade the agent`;
    default:
      return state.detail || 'it gave no reason';
  }
}

export interface PartInput {
  delivery: AppDelivery | null;
  part: EdgePart;
  /** The saved setting is on: a part switched on, a main host name or a path prefix set. */
  inUse: boolean;
  now: number;
  /** Epoch ms the wait for an answer counts from. */
  waitingSince: number;
  /** The folder the person saved, for the reasons about a folder. */
  folder?: string;
  /** Lines the panel says elsewhere. */
  quiet?: readonly ('unassigned' | 'offline')[];
  /** How the part is named when the agent is too old for it (default: the name of the part). */
  label?: string;
}

/**
 * The one line under a part: too old, refused, offline, waiting, no answer or in use. Nothing while the part is off
 * (except that the agent is too old for it), and nothing while the settings have not been read.
 */
export function partLine(o: PartInput): PartLine | null {
  const d = o.delivery;
  if (!d) return null;
  const agent = d.agent;
  if (!agent) return o.inUse && !o.quiet?.includes('unassigned') ? { tone: 'info', text: UNASSIGNED_TEXT } : null;
  if (agent.features[o.part] === false) return { tone: 'warning', text: tooOldText(agent.name, o.label ?? PART_LABEL[o.part], agent.features) };
  const state = reported(d, o.part);
  // A cache folder that cannot be used stops the cache for every application, also while its switch is off.
  const noFolder = o.part === 'cache' && state?.state === 'refused' && state.code === 'cache_dir_unusable';
  if (!o.inUse && !noFolder) return null;
  if (state?.state === 'refused') {
    return {
      tone: 'warning',
      text: `${agent.name} did not apply this: ${refusalReason(state, o.folder ?? '')}.`,
      more: state.running_previous ? 'It still runs the previous settings.' : 'This part stays off until you fix it.',
    };
  }
  if (!agent.online) return o.quiet?.includes('offline') ? null : { tone: 'info', text: offlineText(agent.name) };
  if (state?.state === 'applied') return { tone: 'success', text: `In use on ${agent.name}.` };
  if (state) return { tone: 'info', text: `${agent.name} sent a report this dashboard does not know${state.detail ? `: ${state.detail}` : ''}.` };
  return answerOverdue(o.waitingSince, o.now)
    ? { tone: 'warning', text: noAnswerText(agent.name) }
    : { tone: 'info', text: `Saved. Waiting for ${agent.name} to apply it.` };
}

/** A part of the saved settings is on and its agent has not answered the latest bundle, or a removal still waits for its answer (one that waited past its time is no longer waited for). */
export function waitingForAgent(d: AppDelivery | null, now: number): boolean {
  if (!d?.agent?.online) return false;
  const on: [EdgePart, boolean][] = [['compression', d.compression.enabled], ['static_files', d.static_files.enabled], ['cache', d.cache.enabled]];
  return on.some(([part, enabled]) => enabled && d.agent?.features[part] !== false && reported(d, part) === null) || d.purges.some((row) => row.state === 'pending' && !answerOverdue(row.created_at, now));
}

/** 10 s while waiting for the agent and for 2 minutes after a save, else 60 s. */
export function pollIntervalMs(d: AppDelivery | null, lastActionAt: number | null, now: number): number {
  if (!d?.agent) return POLL_SLOW_MS;
  const afterAction = lastActionAt !== null && now - lastActionAt < NO_ANSWER_AFTER_MS;
  return afterAction || waitingForAgent(d, now) ? POLL_FAST_MS : POLL_SLOW_MS;
}

/** The state after a save: the part as stored, and the generation the agent has to answer. */
export function withSaved(d: AppDelivery, saved: Partial<Pick<AppDelivery, 'compression' | 'static_files' | 'cache'>>, generation: number | null): AppDelivery {
  return { ...d, ...saved, generation: generation ?? d.generation };
}

// ── Numbers in words ───────────────────────────────────────────────────────

/** The lines under Compression: what was compressed in the last hour, and what could not be. Empty without a report. */
export function compressionNumbers(stats: AppCompressionStats | null): string[] {
  if (!stats) return [];
  const answers = stats.responses;
  const lines = [
    answers === 0
      ? 'No answers were compressed in the last hour.'
      : `In the last hour ${formatNumber(answers)} ${answers === 1 ? 'answer was' : 'answers were'} sent compressed, ${formatBytes(Math.max(0, stats.bytes_saved))} smaller.`,
  ];
  if (stats.skipped_streamed > 0) {
    const n = stats.skipped_streamed;
    lines.push(`${formatNumber(n)} could not be compressed because your application sent ${n === 1 ? 'it' : 'them'} in pieces, without a size.`);
  }
  return lines;
}
