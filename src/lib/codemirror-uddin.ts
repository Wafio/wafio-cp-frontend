import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { StringStream } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// uddin-lang keywords (Python-like, plus WAFio built-ins)
const KEYWORDS = new Set([
	'fun', 'end', 'if', 'then', 'else', 'elif', 'return', 'and', 'or', 'not',
	'true', 'false', 'none', 'null', 'nil', 'for', 'in', 'while', 'break',
	'continue', 'print', 'len',
]);

const WAF_BUILTINS = new Set([
	'waf_header', 'waf_query', 'waf_body_contains', 'waf_field', 'waf_values', 'waf_json', 'waf_cidr_match',
	'waf_path_match', 'waf_score', 'waf_action', 'waf_detected',
	'waf_detected_any', 'waf_detected_list', 'waf_return',
	'waf_block', 'waf_allow', 'waf_log',
	'regex_match', 'regex_find', 'regex_replace',
	'contains', 'lower', 'upper', 'len',
]);

// Request-context variables injected by the WAF engine before execution.
const CTX_VARS = new Set([
	'path', 'method', 'query', 'ip', 'country', 'ua', 'body', 'score', 'action',
]);

interface State {
	inString: string | null; // delimiter if inside string, else null
	inBlock: boolean; // inside /* */ comment
}

// NOTE: token names must be legacy CM5 names, StreamLanguage maps them
// ("variable-2" → variableName.special, "def" → variableName.definition).
// Dotted modern names are silently ignored and render unstyled.
const uddinLang = StreamLanguage.define<State>({
	name: 'uddin',

	startState(): State {
		return { inString: null, inBlock: false };
	},

	token(stream: StringStream, state: State): string | null {
		// Multi-line block comment continuation
		if (state.inBlock) {
			while (!stream.eol()) {
				if (stream.match('*/')) {
					state.inBlock = false;
					return 'comment';
				}
				stream.next();
			}
			return 'comment';
		}

		// Line comment
		if (stream.match('//')) {
			stream.skipToEnd();
			return 'comment';
		}

		// Block comment start
		if (stream.match('/*')) {
			state.inBlock = true;
			while (!stream.eol()) {
				if (stream.match('*/')) {
					state.inBlock = false;
					break;
				}
				stream.next();
			}
			return 'comment';
		}

		// Strings: single or double quoted (no multi-line)
		if (!state.inString) {
			if (stream.match('"') || stream.match("'")) {
				const delim = stream.string[stream.pos - 1];
				state.inString = delim;
			}
		}
		if (state.inString) {
			let escaped = false;
			while (!stream.eol()) {
				const ch = stream.next()!;
				if (escaped) { escaped = false; continue; }
				if (ch === '\\') { escaped = true; continue; }
				if (ch === state.inString) { state.inString = null; break; }
			}
			return 'string';
		}

		// Numbers (ints, floats, exponents)
		if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) {
			return 'number';
		}

		// Identifiers and keywords
		if (stream.match(/^[a-zA-Z_]\w*/)) {
			const word = stream.current();
			if (KEYWORDS.has(word)) return 'keyword';
			if (WAF_BUILTINS.has(word)) return 'variable-2';
			if (CTX_VARS.has(word)) return 'def';
			return null;
		}

		// Operators
		if (stream.match(/^(==|!=|<=|>=|<|>|\+|-|\*|\/|%|=)/)) {
			return 'operator';
		}

		// Punctuation
		if (stream.match(/^[():,\[\]{}.]/)) {
			return 'punctuation';
		}

		// Skip whitespace + other chars one at a time
		stream.next();
		return null;
	},

	copyState(state: State): State {
		return { inString: state.inString, inBlock: state.inBlock };
	},
});

/** uddin-lang StreamLanguage extension for CodeMirror 6. */
export function uddin() {
	return uddinLang;
}

// Syntax colours (teal keywords, violet builtins, amber context variables)
// are app.css tokens (--code-*), so they follow the light and dark themes by
// themselves and are gated by contrast.test.ts.
const uddinHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--accent)', fontWeight: '600' },
  { tag: t.special(t.variableName), color: 'var(--code-builtin)' },
  { tag: t.definition(t.variableName), color: 'var(--code-context)' },
  { tag: t.string, color: 'var(--code-string)' },
  { tag: t.number, color: 'var(--code-number)' },
  { tag: t.operator, color: 'var(--code-operator)' },
  { tag: t.punctuation, color: 'var(--code-punctuation)' },
]);

/** Full uddin code-editor extension set: language + WAFio-styled syntax colors. */
export function uddinExtensions() {
  // Colours are theme tokens, so one set serves the light and dark themes.
  return [
    uddinLang,
    syntaxHighlighting(uddinHighlight),
  ];
}

/**
 * Editor chrome (background, gutters, font). Colours come from the app tokens
 * (app.css), so the chrome follows the light and dark themes by itself, as
 * do the syntax colours above.
 */
export function uddinEditorTheme(opts: { fontSize?: string } = {}) {
  const { fontSize } = opts;
  return EditorView.theme({
    '&': { height: '100%', fontSize: fontSize ?? 'var(--fs-sm)', backgroundColor: 'var(--bg-code)', color: 'var(--text-primary)' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
    '.cm-content': { padding: 'var(--sp-3)' },
    '.cm-gutters': { background: 'var(--bg-code)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
    '.cm-activeLine': { background: 'var(--bg-hover)' },
    '.cm-activeLineGutter': { background: 'var(--bg-hover)' },
    // Focus is shown on the editor frame by the host (ScriptTab), not removed.
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
  });
}
