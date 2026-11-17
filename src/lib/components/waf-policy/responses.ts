/**
 * Custom response pages: which draft fields belong to which page, the
 * tokens each page supports, and the sample preview (tokens replaced with
 * demo values). Pure functions; the editor is ResponseEditor.svelte.
 */
import type { ResponseFormat, ResponsesDraft } from './model';

export type ResponsePage = 'js' | 'click' | 'iprep' | 'block' | 'policy' | 'geo';
type TemplateKey = Exclude<keyof ResponsesDraft, 'formats'>;
type FormatKey = keyof ResponsesDraft['formats'];

export interface ResponsePageMeta {
  id: ResponsePage;
  label: string;
  /** Where the page is shown. */
  purpose: string;
  /** Tokens replaced by the agent. */
  tokens: string[];
  /** Only HTML (browser challenges). */
  htmlOnly: boolean;
  fields: Partial<Record<ResponseFormat, TemplateKey>>;
  format?: FormatKey;
}

export const RESPONSE_PAGES: ResponsePageMeta[] = [
  {
    id: 'js', label: 'JS challenge', htmlOnly: true, tokens: ['{{WAFIO_INJECT}}'],
    purpose: 'Shown while the JS challenge or the adaptive challenge runs. Place {{WAFIO_INJECT}} where the form and script go.',
    fields: { html: 'jsChallengeHtml' }
  },
  {
    id: 'click', label: 'Click puzzle', htmlOnly: true, tokens: ['{{WAFIO_INJECT}}'],
    purpose: 'Shown for the click puzzle. Place {{WAFIO_INJECT}} where the grid goes; style it with --wafio-btn-bg, --wafio-btn-fg, --wafio-btn-hover-bg, --wafio-btn-radius, --wafio-btn-text, --wafio-sel-color, --wafio-cell-bg and --wafio-cell-radius.',
    fields: { html: 'clickPuzzleHtml' }
  },
  {
    id: 'iprep', label: 'IP reputation block', htmlOnly: false, tokens: ['{{WAFIO_IP}}'], format: 'ipRep',
    purpose: 'Returned (403) when the client address is on a threat-intelligence blocklist.',
    fields: { html: 'ipRepHtml', json: 'ipRepJson', xml: 'ipRepXml' }
  },
  {
    id: 'block', label: 'WAF block', htmlOnly: false, format: 'waf',
    tokens: ['{{WAFIO_SCORE}}', '{{WAFIO_CATEGORIES}}', '{{WAFIO_METHOD}}', '{{WAFIO_DETAIL}}', '{{WAFIO_CWE}}', '{{WAFIO_MESSAGE}}'],
    purpose: 'Returned (403) when the decision engine blocks a request.',
    fields: { html: 'wafBlockHtml', json: 'wafBlockJson', xml: 'wafBlockXml' }
  },
  {
    id: 'policy', label: 'Block policy and flood', htmlOnly: false, tokens: ['{{WAFIO_MESSAGE}}'], format: 'policy',
    purpose: 'Returned (403) while a client is in a temporary block window or over the HTTP flood limit.',
    fields: { html: 'policyBlockHtml', json: 'policyBlockJson', xml: 'policyBlockXml' }
  },
  {
    id: 'geo', label: 'Geo block', htmlOnly: false, tokens: ['{{WAFIO_MESSAGE}}'], format: 'geo',
    purpose: 'Returned (403) when access control rejects the client address or country.',
    fields: { html: 'geoBlockHtml', json: 'geoBlockJson', xml: 'geoBlockXml' }
  }
];

export function pageMeta(id: ResponsePage): ResponsePageMeta {
  return RESPONSE_PAGES.find((page) => page.id === id)!;
}

export function pageFormat(responses: ResponsesDraft, id: ResponsePage): ResponseFormat {
  const meta = pageMeta(id);
  return meta.format ? responses.formats[meta.format] : 'html';
}

export function templateKey(id: ResponsePage, format: ResponseFormat): TemplateKey {
  const meta = pageMeta(id);
  return meta.fields[format] ?? meta.fields.html!;
}

/** Has any template for the page (any format). */
export function pageCustomized(responses: ResponsesDraft, id: ResponsePage): boolean {
  return Object.values(pageMeta(id).fields).some((key) => (responses[key as TemplateKey] ?? '').trim() !== '');
}

const DEMO: Record<string, string> = {
  '{{WAFIO_SCORE}}': '185',
  '{{WAFIO_CATEGORIES}}': 'SQLi',
  '{{WAFIO_METHOD}}': 'semantic',
  '{{WAFIO_DETAIL}}': 'sql:stacked',
  '{{WAFIO_CWE}}': 'CWE-89',
  '{{WAFIO_IP}}': '203.0.113.7'
};

const DEMO_MESSAGES: Record<ResponsePage, string> = {
  js: '',
  click: '',
  iprep: 'Request blocked: client address has a bad reputation.',
  block: 'Request blocked: potential SQL injection detected.',
  policy: 'Blocked by policy (temporary block window).',
  geo: 'Request blocked: country not allowed.'
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function demoValue(token: string, page: ResponsePage): string {
  if (token === '{{WAFIO_MESSAGE}}') return DEMO_MESSAGES[page];
  if (token === '{{WAFIO_INJECT}}') return '[challenge widget]';
  return DEMO[token] ?? token;
}

/**
 * Replaces the tokens the page supports with sample values (the agent
 * replaces only those; other tokens stay as written). HTML output marks the
 * values so they stand out.
 */
export function fillTokens(content: string, page: ResponsePage, mark: (value: string) => string = (v) => v): string {
  let out = content;
  for (const token of pageMeta(page).tokens) out = out.split(token).join(mark(demoValue(token, page)));
  return out;
}

export interface PreviewColors { background: string; text: string; muted: string; border: string; accent: string; font: string; mono: string }

/**
 * srcdoc for the preview iframe. HTML templates render as they would for a
 * visitor (sample values highlighted); JSON and XML show as escaped code.
 */
export function previewDocument(content: string, page: ResponsePage, format: ResponseFormat, colors: PreviewColors): string {
  const base = `margin:0;padding:24px;box-sizing:border-box;min-height:100vh;background:${colors.background};color:${colors.text};font-family:${colors.font};font-size:14px;line-height:1.6`;
  if (!content.trim()) {
    return `<!doctype html><html><body style="${base};display:flex;align-items:center;justify-content:center;text-align:center"><div><p style="margin:0 0 4px;color:${colors.text}">No custom content</p><p style="margin:0;color:${colors.muted};font-size:12px">The built-in WAFio ${format === 'html' ? 'page' : format.toUpperCase() + ' response'} is used.</p></div></body></html>`;
  }
  if (format !== 'html') {
    const code = escapeHtml(fillTokens(content, page));
    return `<!doctype html><html><body style="${base}"><p style="margin:0 0 12px;color:${colors.muted};font-size:12px">${format.toUpperCase()} response with sample values</p><pre style="margin:0;padding:16px;border:1px solid ${colors.border};border-radius:7px;white-space:pre-wrap;word-break:break-all;font-family:${colors.mono};font-size:13px">${code}</pre></body></html>`;
  }
  return fillTokens(content, page, (value) => `<mark style="background:none;color:${colors.accent};font-weight:600">${escapeHtml(value)}</mark>`);
}

/** Timer functions; injectable so the debounce in PreviewScheduler is testable without real timers. */
export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * Schedules preview rebuilds for ResponseEditor: immediately when `key`
 * (the page/format pair) differs from the previous call, so switching tabs
 * never shows a stale page; debounced by `delayMs` when only the key repeats
 * (the template content changed), so retyping doesn't rebuild the iframe on
 * every keystroke. A superseded debounce is always cancelled first, so only
 * the most recent edit ever lands. Also tracks, via `markVisible()`, whether
 * the host dialog has been confirmed open yet (see that method).
 */
export class PreviewScheduler {
  readonly #timers: TimerApi;
  readonly #delayMs: number;
  #timer: unknown = null;
  #lastKey: string | undefined;
  #visible = false;

  constructor(delayMs: number, timers: TimerApi = defaultTimers) {
    this.#delayMs = delayMs;
    this.#timers = timers;
  }

  /** Runs `build` now (and returns true) when `key` is new; otherwise schedules it after the debounce delay and returns false. */
  schedule(key: string, build: () => void): boolean {
    const immediate = key !== this.#lastKey;
    this.#lastKey = key;
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (immediate) {
      build();
      return true;
    }
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      build();
    }, this.#delayMs);
    return false;
  }

  /** Cancels a pending debounced build (call on component teardown). */
  dispose(): void {
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * True the first time this is called, then false for the rest of this
   * scheduler's life. The host element (ResponseEditor's preview iframe) may
   * get its first `schedule()`-built value while still hidden inside a
   * closed native <dialog> (`display: none`); some browsers then never
   * paint it even after the dialog opens with that same value still
   * assigned, unless the element itself is recreated. Call this once, a
   * frame after mount (by which point the dialog has definitely opened), and
   * key the element on the result so it remounts exactly once.
   */
  markVisible(): boolean {
    if (this.#visible) return false;
    this.#visible = true;
    return true;
  }
}

export const CONTENT_TYPES: Readonly<Record<ResponseFormat, string>> = {
  html: 'text/html',
  json: 'application/json',
  xml: 'application/xml'
};

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>${title}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** Starting point for an empty template ("Insert example"); uses only the tokens the page supports. */
export function exampleTemplate(page: ResponsePage, format: ResponseFormat): string {
  const [field, token] = page === 'iprep' ? ['ip', '{{WAFIO_IP}}'] : ['message', '{{WAFIO_MESSAGE}}'];
  if (format === 'json') return `{\n  "blocked": true,\n  "${field}": "${token}"\n}\n`;
  if (format === 'xml') return `<response>\n  <blocked>true</blocked>\n  <${field}>${token}</${field}>\n</response>\n`;
  switch (page) {
    case 'js':
      return htmlPage('Security check', '  <h1>Checking your browser…</h1>\n  {{WAFIO_INJECT}}');
    case 'click':
      return htmlPage('Security check', '  <h1>Complete the puzzle to continue</h1>\n  {{WAFIO_INJECT}}');
    case 'iprep':
      return htmlPage('Access denied', '  <h1>Access denied</h1>\n  <p>Requests from {{WAFIO_IP}} are blocked.</p>');
    case 'block':
      return htmlPage('Request blocked', '  <h1>Request blocked</h1>\n  <p>{{WAFIO_MESSAGE}}</p>\n  <p>Score {{WAFIO_SCORE}} · {{WAFIO_CATEGORIES}}</p>');
    default:
      return htmlPage('Access denied', '  <h1>Access denied</h1>\n  <p>{{WAFIO_MESSAGE}}</p>');
  }
}
