<script lang="ts">
  // Live path-match preview for the Path Rules editor (Path Rules v2).
  // Replicates the engine's path matching client-side
  // (internal/engine/config.go cleanPathInterpretations / matchesPathException):
  //   servlet path = strip scheme/host → query/fragment → ";params" per segment →
  //                  URL-decode → ";params" again → resolve . and .. → leading /
  //   literal path = strip scheme/host → query/fragment → URL-decode → resolve . and ..
  //                  → leading / → ";params" per segment (a "..;" segment stays literal)
  //   exact  = equality with the pattern
  //   regex  = JS RegExp test (engine uses RE2, subtle note shown in regex mode)
  //   prefix = trailing-slash-trimmed pattern: equality OR startsWith(pattern + '/')
  // The two paths differ only when the request carries ';'. A restrictive rule
  // (block / IP rules) matches when EITHER does; any other rule only when BOTH do.
  // caseInsensitive is the rule's effective setting: exact/prefix compare
  // lower-cased, regex gets the `i` flag (engine: (?i)).
  interface Props {
    path: string;
    match: 'prefix' | 'exact' | 'regex';
    caseInsensitive?: boolean;
    restrictive?: boolean;
  }

  let { path, match, caseInsensitive = false, restrictive = false }: Props = $props();

  const uid = $props.id();

  let testUri = $state('');

  // Path parameters (";jsessionid=…", matrix params): each ';' drops the rest of
  // its segment up to the next '/', as servlet containers route them.
  function stripPathParams(p: string): string {
    return p.replace(/;[^/]*/g, '');
  }

  // Go path.Clean: collapse slashes, drop '.', resolve '..' (never above root).
  function cleanDots(p: string): string {
    const rooted = p.startsWith('/');
    const out: string[] = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
        else if (!rooted) out.push('..');
        continue;
      }
      out.push(seg);
    }
    const joined = out.join('/');
    if (rooted) return `/${joined}`;
    return joined || '.';
  }

  function rawPath(raw: string): string {
    let p = raw.trim();
    const schemeIdx = p.indexOf('://');
    if (schemeIdx >= 0) {
      const rest = p.slice(schemeIdx + 3);
      const slashIdx = rest.indexOf('/');
      p = slashIdx >= 0 ? rest.slice(slashIdx) : '/';
    }
    p = p.split('?')[0].split('#')[0];
    return p || '/';
  }

  function decodePath(p: string): string {
    try {
      return decodeURIComponent(p);
    } catch {
      // malformed escape sequence, keep raw form (engine: url.PathUnescape error)
      return p;
    }
  }

  function rooted(p: string): string {
    return p.startsWith('/') ? p : `/${p}`;
  }

  // Servlet reading (Tomcat / Jetty / Spring): ";params" stripped before . / ..
  // resolution, so "..;" resolves as "..".
  function servletPath(raw: string): string {
    const p = stripPathParams(rawPath(raw));
    return rooted(cleanDots(stripPathParams(decodePath(p))));
  }

  // Literal reading (nginx, Express, PHP): cleaned as-is, then ";params" removed
  // from segment names; a "..;" segment is never resolved.
  function literalPath(raw: string): string {
    return stripPathParams(rooted(cleanDots(decodePath(rawPath(raw)))));
  }

  const MATCH = { state: 'match' as const, label: '✓ Rule applies' };
  const NO_MATCH = { state: 'nomatch' as const, label: '✗ Rule does not apply' };

  const cleanedUri = $derived(testUri.trim() ? servletPath(testUri) : '');
  const literalUri = $derived(testUri.trim() ? literalPath(testUri) : '');

  // matchesPath: one cleaned path against the pattern; an Error for an invalid regex.
  function matchesPath(p: string): boolean | Error {
    const pattern = path.trim();
    if (match === 'regex') {
      try {
        return new RegExp(pattern, caseInsensitive ? 'i' : '').test(p);
      } catch (e: any) {
        return new Error(e.message);
      }
    }
    const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
    const req = fold(p);
    if (match === 'exact') {
      return req === fold(pattern);
    }
    // prefix, "/" (or empty) matches everything
    const prefix = fold(pattern.replace(/\/+$/, ''));
    if (!prefix) return true;
    return req === prefix || req.startsWith(`${prefix}/`);
  }

  const verdict = $derived.by(() => {
    if (!cleanedUri) {
      return { state: 'idle' as const, label: 'Enter a URI to test' };
    }
    const a = matchesPath(cleanedUri);
    if (a instanceof Error) {
      return { state: 'invalid' as const, label: `Invalid regex: ${a.message}` };
    }
    if (literalUri === cleanedUri) return a ? MATCH : NO_MATCH;
    const b = matchesPath(literalUri) === true;
    return (restrictive ? a || b : a && b) ? MATCH : NO_MATCH;
  });

  // Shown when the engine will compare a different path than the one typed.
  const normalizedNote = $derived.by(() => {
    if (!cleanedUri) return '';
    const typed = testUri.trim().split('?')[0].split('#')[0];
    return cleanedUri !== typed ? cleanedUri : '';
  });

  // Patterns the engine can never match as written (exact / prefix only).
  const patternNote = $derived.by(() => {
    const pattern = path.trim();
    if (match === 'regex' || !pattern) return '';
    if (!pattern.startsWith('/')) return 'Requests are matched as absolute paths. Start the pattern with /.';
    if (pattern.includes(';')) return 'Path parameters (;…) are stripped from requests before matching. Drop them from the pattern.';
    return '';
  });
</script>

<div class="pmp">
  <div class="pmp-row">
    <div class="pmp-field">
      <label for="{uid}-uri">Check a request URL</label>
      <input
        id="{uid}-uri"
        type="text"
        class="pmp-input"
        placeholder="/api/editor/42?id=1"
        bind:value={testUri}
        aria-describedby="{uid}-hint"
      />
    </div>
    {#if verdict.state !== 'idle'}
    <div
      class="pmp-verdict"
      class:pmp-match={verdict.state === 'match'}
      class:pmp-nomatch={verdict.state === 'nomatch'}
      class:pmp-invalid={verdict.state === 'invalid'}
      role="status"
    >
      {verdict.label}
    </div>
    {/if}
  </div>
  <p class="pmp-note" id="{uid}-hint">Type a URL your app receives to see whether this rule applies to it. Preview only: nothing is sent or saved.</p>
  {#if normalizedNote}
    <p class="pmp-normalized">Matched as <code>{normalizedNote}</code></p>
  {/if}
  {#if cleanedUri && literalUri !== cleanedUri}
    <p class="pmp-note">
      Backends disagree on this path: servlet containers route <code>{cleanedUri}</code>, others
      <code>{literalUri}</code>. {restrictive ? 'This rule applies if either matches.' : 'This rule applies only if both match.'}
    </p>
  {/if}
  {#if patternNote}
    <p class="pmp-note pmp-warn">{patternNote}</p>
  {/if}
  {#if match === 'regex'}
    <p class="pmp-note">The engine matches with RE2. This preview uses JS regex, so rare patterns may behave differently.</p>
  {/if}
</div>

<style>
  .pmp {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .pmp-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
  .pmp-field { flex: 1; min-width: 220px; display: flex; flex-direction: column; gap: var(--sp-1); }
  .pmp-field label { font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--text-secondary); white-space: nowrap; }
  .pmp-input {
    width: 100%;
    box-sizing: border-box;
    height: 34px;
    padding: 0 var(--sp-2);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .pmp-input::placeholder { color: var(--text-muted); font-family: var(--font-sans); }
  /* A path test result is not a WAF verdict: matched = info, no match = neutral. */
  .pmp-verdict {
    display: inline-flex;
    align-items: center;
    align-self: flex-end;
    height: 34px;
    padding: 0 var(--sp-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    font-weight: var(--fw-semibold);
    white-space: nowrap;
  }
  .pmp-match { background: var(--info-tint); border-color: var(--info); color: var(--text-primary); }
  .pmp-nomatch { color: var(--text-primary); border-color: var(--border-strong); }
  .pmp-invalid { background: var(--danger-tint); border-color: var(--danger); color: var(--danger); }
  .pmp-note { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .pmp-note code { font-family: var(--font-mono); color: var(--text-primary); }
  .pmp-warn { color: var(--warning); }
  .pmp-normalized { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); overflow-wrap: anywhere; }
  .pmp-normalized code { font-family: var(--font-mono); color: var(--text-primary); }
</style>
