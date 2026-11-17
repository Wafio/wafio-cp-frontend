<!--
  ScriptTab: uddin-lang editor (CodeMirror) plus the script reference for a
  Script rule. The editor lives only while the tab is shown: it is destroyed
  in the effect cleanup (mode switch, dialog close) and an
  editor whose async load finishes after that is never attached. Applying a
  template over a non-empty script asks first.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import check from 'svelte-awesome/icons/check';
  import exclamationTriangle from 'svelte-awesome/icons/exclamationTriangle';
  import { validateCustomScript } from '#lib/api.js';
  import { SCRIPT_MAX_BYTES, forbiddenBuiltinsMessage, scriptBytes, scriptSizeError } from './script-access';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import { PIPELINE_STEPS, RULE_STAGES, SCRIPT_FAST_PATH, SCRIPT_SKIPPED_WHEN } from './rule-stages';

  interface Props {
    open: boolean; // the rule dialog is open
    active: boolean; // script mode is selected
    projectId: string;
    appId: string;
    script: string;
    /** Built-ins the server rejected on the last save (SCRIPT_BUILTIN_FORBIDDEN). */
    forbidden?: string[];
    /** Server message of a 400 SCRIPT_INVALID on the last save (too large, nested too deeply). */
    invalid?: string;
  }

  let { open, active, projectId, appId, script = $bindable(), forbidden = [], invalid = '' }: Props = $props();

  const sizeBytes = $derived(scriptBytes(script));
  const sizeProblem = $derived(scriptSizeError(script));

  // Names from the last "Check syntax"; the save result comes in through `forbidden`.
  let checkedForbidden = $state<string[]>([]);
  const forbiddenNames = $derived(checkedForbidden.length ? checkedForbidden : forbidden);

  const REF_TABS = [
    { id: 'guide', label: 'Guide' },
    { id: 'snippets', label: 'Snippets' },
    { id: 'functions', label: 'Functions' },
    { id: 'variables', label: 'Variables' },
    { id: 'syntax', label: 'Syntax' },
  ];

  let activeRefTab = $state('guide');
  let validatingScript = $state(false);
  let syntaxValidationResult: { ok: boolean; message: string } | null = $state(null);
  let pendingTemplate = $state<{ label: string; code: string } | null>(null);

  // ── Reference data (keep in sync with the uddin-lang module builtins) ──
  // Request context variables injected by the engine (internal/engine/custom_rules.go).
  const VARIABLES: { name: string; type: string; desc: string; example?: string }[] = [
    { name: 'path', type: 'string', desc: 'Normalized request path', example: '/api/login' },
    { name: 'method', type: 'string', desc: 'HTTP method', example: 'POST' },
    { name: 'query', type: 'string', desc: 'Raw query string (without ?)', example: 'a=1&debug=2' },
    { name: 'ip', type: 'string', desc: 'Client IP address', example: '203.0.113.10' },
    { name: 'country', type: 'string', desc: 'ISO 3166 alpha-2 country code from GeoIP (empty without a GeoIP database)', example: 'ID' },
    { name: 'ua', type: 'string', desc: 'User-Agent header' },
    { name: 'body', type: 'string', desc: 'Request body, first 4 KB' },
    { name: 'score', type: 'float', desc: 'Total engine score (0 when the engines find nothing)' },
    { name: 'action', type: 'string', desc: 'Engine verdict before scripts, lowercase', example: '"allow" | "log" | "block"' },
    { name: '_waf_ctx', type: 'map', desc: 'Full context, including the headers map and the detected categories', example: '_waf_ctx.headers["x-api-key"]' },
  ];

  const FUNCTION_GROUPS: { label: string; fns: { sig: string; desc: string; insert?: string }[] }[] = [
    {
      label: 'Decisions',
      fns: [
        { sig: 'waf_block()', desc: 'Return BLOCK: the request is rejected on routes in Block mode. Later scripts do not run.', insert: 'waf_block()' },
        { sig: 'waf_allow()', desc: 'Return ALLOW: replaces the engine verdict, including a Block.', insert: 'waf_allow()' },
        { sig: 'waf_log()', desc: 'Return LOG: pass the request and record the decision.', insert: 'waf_log()' },
        { sig: 'waf_return(action)', desc: 'Return "BLOCK", "ALLOW" or "LOG".', insert: 'waf_return("BLOCK")' },
      ],
    },
    {
      label: 'Request access',
      fns: [
        { sig: 'waf_header(name)', desc: 'Header value (case-insensitive name) or null when absent.', insert: 'waf_header("user-agent")' },
        { sig: 'waf_query(name)', desc: 'URL-decoded query parameter or null.', insert: 'waf_query("token")' },
        { sig: 'waf_body_contains(str)', desc: 'True when the first 4 KB of the body contain str.', insert: 'waf_body_contains("sqlmap")' },
        { sig: 'waf_field(field)', desc: 'Any condition field, as GUI rules read it: param:user.email (query, form, multipart or JSON), json:/items/*/sku, form:tags, multipart:avatar. Values joined; "" when absent.', insert: 'waf_field("param:user.email")' },
        { sig: 'waf_values(field)', desc: 'Like waf_field, as a list with one entry per value.', insert: 'waf_values("json:/items/*/sku")' },
        { sig: 'waf_json()', desc: 'The JSON body parsed (first 64 KB, not the 4 KB body variable) as objects and lists, or null.', insert: 'waf_json()' },
        { sig: 'waf_path_match(glob)', desc: 'True when the path matches a glob such as /admin*.', insert: 'waf_path_match("/admin*")' },
        { sig: 'waf_cidr_match(ip, cidr)', desc: 'True when the IP is inside the CIDR range.', insert: 'waf_cidr_match(ip, "10.0.0.0/8")' },
      ],
    },
    {
      label: 'Detection state',
      fns: [
        { sig: 'waf_score()', desc: 'Engine score as a float (same as score).', insert: 'waf_score()' },
        { sig: 'waf_action()', desc: 'Engine verdict before scripts: "allow", "log" or "block".', insert: 'waf_action()' },
        { sig: 'waf_detected(cat)', desc: 'True when the verdict lists the category (case-insensitive), e.g. "SQLi".', insert: 'waf_detected("SQLi")' },
        { sig: 'waf_detected_any()', desc: 'True when the verdict lists any category.', insert: 'waf_detected_any()' },
        { sig: 'waf_detected_list()', desc: 'List of the category names on the verdict.', insert: 'waf_detected_list()' },
      ],
    },
    {
      label: 'Strings',
      fns: [
        { sig: 'lower(s) / upper(s)', desc: 'Change letter case.', insert: 'lower(ua)' },
        { sig: 'contains(s, sub)', desc: 'True when s contains sub.', insert: 'contains(lower(ua), "sqlmap")' },
        { sig: 'starts_with / ends_with', desc: 'Prefix and suffix tests.', insert: 'starts_with(path, "/api/")' },
        { sig: 'trim(s)', desc: 'Strip surrounding whitespace.', insert: 'trim(s)' },
        { sig: 'replace(s, old, new)', desc: 'Replace all occurrences.', insert: 'replace(s, " ", "")' },
        { sig: 'substr(s, start, len)', desc: 'Substring.', insert: 'substr(s, 0, 8)' },
        { sig: 'len(x)', desc: 'Length of a string or list.', insert: 'len(body)' },
        { sig: 'str(x)', desc: 'Convert a value to a string.', insert: 'str(score)' },
      ],
    },
    {
      label: 'Collections',
      fns: [
        { sig: 'join(arr, sep)', desc: 'Join list elements into a string.', insert: 'join(list, ",")' },
        { sig: 'filter(arr, fun)', desc: 'Keep elements where fun(el) is true.', insert: 'filter(list, fun(x): return x > 1 end)' },
        { sig: 'map(arr, fun)', desc: 'Transform each element.', insert: 'map(list, fun(x): return lower(x) end)' },
        { sig: 'find(arr, fun)', desc: 'First element matching the predicate, else null.', insert: 'find(list, fun(x): return contains(x, "a") end)' },
        { sig: 'slice(arr, start, end)', desc: 'Part of a list or string.', insert: 'slice(arr, 0, 2)' },
      ],
    },
    {
      label: 'Math and types',
      fns: [
        { sig: 'int(x) / float(x)', desc: 'Parse or convert numbers.', insert: 'int("42")' },
        { sig: 'abs / ceil / floor', desc: 'Rounding and absolute value.', insert: 'floor(score)' },
        { sig: 'sqrt(x) / pow(x, y)', desc: 'Square root and power.', insert: 'pow(score, 2)' },
        { sig: 'typeof(x)', desc: 'Type name: "string", "number", "bool", "array", "map", "null".', insert: 'typeof(ua)' },
      ],
    },
    {
      label: 'Regex and time',
      fns: [
        { sig: 'regex_match(pattern, s)', desc: 'RE2 regex test (no backreferences).', insert: 'regex_match("(?i)(sqlmap|nikto)", ua)' },
        { sig: 'time_now()', desc: 'Current Unix time in seconds (float).', insert: 'time_now()' },
        { sig: 'date_now()', desc: 'Current date and time as a string.', insert: 'date_now()' },
      ],
    },
  ];

  const SYNTAX_CARDS: { title: string; code: string; note?: string }[] = [
    { title: 'Comments', code: '// single-line comment only' },
    {
      title: 'if / elif / else',
      code: 'if (waf_path_match("/admin*")) then:\n    waf_block()\nelif (method == "TRACE") then:\n    waf_block()\nelse:\n    waf_log()\nend',
      note: 'Parentheses around the condition; every chain ends with end.',
    },
    {
      title: 'Comparison and logic',
      code: 'a == b   a != b   x > 80   x <= 5\nval == null   val != null\ncond1 and cond2\ncond1 or cond2\nnot cond',
      note: 'Numbers compare with > < >= <=; strings with == and != (case-sensitive).',
    },
    {
      title: 'Variables and null checks',
      code: 'ua_val = waf_header("user-agent")\nif (ua_val != null and contains(lower(ua_val), "curl")) then:\n    waf_log()\nend',
      note: 'Accessors return null when the header or parameter is missing: check before use.',
    },
    {
      title: 'Loops',
      code: 'for cat in waf_detected_list():\n    print("flagged: " + cat)\nend\n\ni = 0\nwhile (i < 3):\n    i = i + 1\nend',
      note: 'break and continue work inside loops.',
    },
    {
      title: 'Functions',
      code: 'fun is_scanner(s):\n    return contains(lower(s), "sqlmap") or contains(lower(s), "nikto")\nend\n\nif (is_scanner(ua)) then:\n    waf_block()\nend',
    },
    {
      title: 'Strings and collections',
      code: 'msg = "score: " + str(score)\nlist = [1, 2, 3]\nm = {"role": "admin", "ok": true}\nrole = m["role"]',
      note: 'Join strings with + (convert numbers with str()); read maps with ["key"].',
    },
  ];

  const SNIPPET_CARDS: { title: string; desc: string; code: string }[] = [
    {
      title: 'Block sensitive paths',
      desc: 'Glob match on the request path.',
      code: 'if (waf_path_match("/admin*") or waf_path_match("/internal*")) then:\n    waf_block()\nend\n',
    },
    {
      title: 'Allow an office network',
      desc: 'Replaces any engine verdict, including a Block, for a trusted network.',
      code: 'if (waf_cidr_match(ip, "192.168.1.0/24")) then:\n    waf_allow()\nend\n',
    },
    {
      title: 'Score escalation gate',
      desc: 'Block requests whose engine score is above 80, even when no engine blocked them.',
      code: 'if (score > 80.0) then:\n    waf_block()\nend\n',
    },
    {
      title: 'Block scanner user agents',
      desc: 'Regex over the User-Agent.',
      code: 'if (ua != "" and regex_match("(?i)(sqlmap|nikto|masscan)", ua)) then:\n    waf_block()\nend\n',
    },
    {
      title: 'Require an API key',
      desc: 'Block API calls without an X-API-Key header.',
      code: 'if (starts_with(path, "/api/") and waf_header("x-api-key") == null) then:\n    waf_block()\nend\n',
    },
    {
      title: 'Escalate a SQL injection verdict',
      desc: 'Combine the verdict categories with the score.',
      code: 'if (waf_detected("SQLi") and waf_score() > 50.0) then:\n    waf_block()\nend\n',
    },
    {
      title: 'Log anything flagged',
      desc: 'Record every request the engines flagged.',
      code: 'cats = waf_detected_list()\nif (len(cats) > 0) then:\n    waf_log()\nend\n',
    },
    {
      title: 'Downgrade a false positive',
      desc: 'Soften the verdict for known-good traffic. The verdict is lowercase.',
      code: 'if (waf_action() == "block" and waf_cidr_match(ip, "10.0.0.0/8")) then:\n    waf_log()\nend\n',
    },
  ];

  const TEMPLATES: { id: string; label: string; code: string }[] = [
    { id: 'block_path', label: 'Block path', code: 'if (waf_path_match("/admin*") or waf_path_match("/internal*")) then:\n    waf_block()\nend\n' },
    { id: 'allow_cidr', label: 'Allow CIDR', code: 'if (waf_cidr_match(ip, "192.168.1.0/24") or waf_cidr_match(ip, "10.0.0.0/8")) then:\n    waf_allow()\nend\n' },
    { id: 'score_gate', label: 'Score gate', code: 'if (score > 80.0) then:\n    waf_block()\nend\n' },
    {
      id: 'block_bad_ua',
      label: 'Block bad user agents',
      code: 'ua_val = waf_header("user-agent")\nif (ua_val != null and (contains(lower(ua_val), "sqlmap") or contains(lower(ua_val), "nikto"))) then:\n    waf_block()\nend\n',
    },
  ];

  // ── CodeMirror ──
  let cmContainer: HTMLElement | null = $state(null);
  let cmEditor: EditorView | null = null;
  let initToken = 0;
  type CMModules = [typeof import('@codemirror/view'), typeof import('@codemirror/state'), typeof import('codemirror'), typeof import('#lib/codemirror-uddin.js')];
  let cmModules: CMModules | null = null;

  async function loadCM(): Promise<CMModules | null> {
    if (cmModules) return cmModules;
    try {
      cmModules = await Promise.all([import('@codemirror/view'), import('@codemirror/state'), import('codemirror'), import('#lib/codemirror-uddin.js')]);
      return cmModules;
    } catch (err) {
      console.error('[ScriptTab] Failed to load CodeMirror:', err);
      return null;
    }
  }

  async function mountEditor(token: number) {
    const mods = await loadCM();
    await tick();
    // Superseded (mode switch, dialog closed) while loading.
    if (!mods || token !== initToken || !cmContainer) return;
    const [view, state, setup, uddin] = mods;
    cmEditor?.destroy();
    const updateListener = view.EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        script = update.state.doc.toString();
        syntaxValidationResult = null;
        checkedForbidden = [];
      }
    });
    cmEditor = new view.EditorView({
      state: state.EditorState.create({
        doc: script,
        extensions: [
          setup.basicSetup,
          ...uddin.uddinExtensions(),
          uddin.uddinEditorTheme(),
          updateListener,
          view.EditorView.lineWrapping,
          view.EditorView.contentAttributes.of({ 'aria-label': 'Script editor (uddin-lang)' }),
        ],
      }),
      parent: cmContainer,
    });
  }

  // The editor exists only while the dialog is open in script mode; the
  // cleanup destroys it on every exit path. Its colours are theme tokens, so a
  // theme change needs no new editor.
  $effect(() => {
    if (!open || !active) return;
    const token = ++initToken;
    void mountEditor(token);
    return () => {
      initToken++;
      cmEditor?.destroy();
      cmEditor = null;
    };
  });

  function insertSnippet(snippet: string) {
    if (cmEditor) {
      const selection = cmEditor.state.selection.main;
      cmEditor.dispatch({
        changes: { from: selection.from, to: selection.to, insert: snippet },
        selection: { anchor: selection.from + snippet.length },
      });
      cmEditor.focus();
    } else {
      script += snippet;
    }
  }

  function replaceScript(code: string) {
    if (cmEditor) {
      cmEditor.dispatch({ changes: { from: 0, to: cmEditor.state.doc.length, insert: code } });
      cmEditor.focus();
    } else {
      script = code;
    }
  }

  function applyTemplate(tpl: { label: string; code: string }) {
    const current = script.trim();
    if (current && current !== tpl.code.trim()) {
      pendingTemplate = tpl;
      return;
    }
    replaceScript(tpl.code);
  }

  async function handleValidateSyntax() {
    if (!projectId || !appId) return;
    if (sizeProblem) {
      syntaxValidationResult = { ok: false, message: sizeProblem };
      return;
    }
    validatingScript = true;
    syntaxValidationResult = null;
    checkedForbidden = [];
    const res = await validateCustomScript(projectId, appId, script);
    validatingScript = false;
    if (res.data?.ok) {
      syntaxValidationResult = { ok: true, message: 'The script compiles.' };
    } else if (res.error?.code === 'SCRIPT_BUILTIN_FORBIDDEN') {
      checkedForbidden = res.error.forbidden?.length ? res.error.forbidden : [];
      syntaxValidationResult = { ok: false, message: 'The script calls functions that scripts may not use.' };
    } else {
      syntaxValidationResult = { ok: false, message: res.error?.error || res.data?.error || 'The script does not compile.' };
    }
  }
</script>

<div class="st-workspace">
  <div class="st-editor-pane">
    <div class="st-editor-toolbar">
      <div class="st-templates" role="group" aria-label="Replace the script with a template">
        <span class="st-toolbar-label" aria-hidden="true">Templates</span>
        {#each TEMPLATES as tpl (tpl.id)}
          <button type="button" class="st-tpl" onclick={() => applyTemplate(tpl)}>{tpl.label}</button>
        {/each}
      </div>
      <Button variant="secondary" size="sm" loading={validatingScript} onclick={handleValidateSyntax}>
        <Icon data={check} scale={0.75} aria-hidden="true" />
        {validatingScript ? 'Checking…' : 'Check syntax'}
      </Button>
    </div>

    <div class="st-cm-host" bind:this={cmContainer}></div>

    {#if syntaxValidationResult}
      <p class="st-syntax" class:is-ok={syntaxValidationResult.ok} role={syntaxValidationResult.ok ? 'status' : 'alert'}>
        <Icon data={syntaxValidationResult.ok ? check : exclamationTriangle} scale={0.8} aria-hidden="true" />
        <span>{syntaxValidationResult.message}</span>
      </p>
    {/if}
    <p class="st-size" class:is-over={sizeProblem !== null} aria-live="polite">
      {sizeProblem ?? `${(sizeBytes / 1024).toFixed(1)} KiB of ${SCRIPT_MAX_BYTES / 1024} KiB`}
    </p>
    {#if invalid && !syntaxValidationResult}
      <p class="st-syntax" role="alert">
        <Icon data={exclamationTriangle} scale={0.8} aria-hidden="true" />
        <span>{invalid}</span>
      </p>
    {/if}
    {#if forbiddenNames.length}
      <div class="st-forbidden" role="alert">
        <p>{forbiddenBuiltinsMessage([])} Remove these calls:</p>
        <ul aria-label="Functions not allowed in scripts">
          {#each forbiddenNames as fn (fn)}<li><code>{fn}</code></li>{/each}
        </ul>
      </div>
    {/if}
  </div>

  <div class="st-ref-pane">
    <Tabs tabs={REF_TABS} bind:value={activeRefTab} label="Script reference" size="sm">
      {#snippet children(tab)}
        <div class="st-ref-content">
          {#if tab === 'guide'}
            <section class="st-block">
              <h4>When scripts run</h4>
              <p><strong>{RULE_STAGES.script.when}.</strong> {RULE_STAGES.script.effect}</p>
              <ol class="st-flow" aria-label="Request pipeline">
                {#each PIPELINE_STEPS as step (step.label)}
                  <li class:is-me={step.mode === 'script'}>{step.label}</li>
                {/each}
              </ol>
              <p>{SCRIPT_FAST_PATH}</p>
              <p>{SCRIPT_SKIPPED_WHEN}</p>
            </section>
            <section class="st-block">
              <h4>Order</h4>
              <p>Rules run by priority, lowest number first; equal priorities run in creation order. Match &amp; act rules run before the engines, and a matching one ends the request before any script sees it.</p>
            </section>
            <section class="st-block">
              <h4>Limits</h4>
              <ul>
                <li>5 ms per script, 15 ms for all scripts of one request. A script that runs out of time is ignored and the engine verdict stands.</li>
                <li>Nothing persists between requests.</li>
                <li>Scripts cannot challenge; use a Match &amp; act rule for a browser challenge.</li>
              </ul>
            </section>
            <section class="st-block">
              <h4>Good practice</h4>
              <ul>
                <li>Check accessor results for null before comparing: <code>ua_val != null and …</code></li>
                <li>String comparisons are case-sensitive: normalise with <code>lower()</code>.</li>
                <li>Run <em>Check syntax</em> before saving; the server compiles the script.</li>
              </ul>
            </section>
          {:else if tab === 'snippets'}
            {#each SNIPPET_CARDS as c (c.title)}
              <div class="st-card">
                <div class="st-card-head">
                  <strong>{c.title}</strong>
                  <button type="button" class="st-insert" aria-label={`Insert snippet: ${c.title}`} onclick={() => insertSnippet(c.code)}>Insert</button>
                </div>
                <pre class="st-code"><code>{c.code}</code></pre>
                <p>{c.desc}</p>
              </div>
            {/each}
          {:else if tab === 'functions'}
            {#each FUNCTION_GROUPS as g (g.label)}
              <section class="st-fn-group">
                <h4>{g.label}</h4>
                <ul class="st-doc-list">
                  {#each g.fns as f (f.sig)}
                    <li>
                      <button type="button" class="st-fn" title="Insert an example" onclick={() => insertSnippet(f.insert ?? f.sig)}>
                        <code>{f.sig}</code>
                      </button>
                      <span>{f.desc}</span>
                    </li>
                  {/each}
                </ul>
              </section>
            {/each}
          {:else if tab === 'variables'}
            <dl class="st-vars">
              {#each VARIABLES as v (v.name)}
                <div class="st-var">
                  <dt><code>{v.name}</code> <span class="st-type">{v.type}</span></dt>
                  <dd>
                    {v.desc}
                    {#if v.example}<code class="st-example">{v.example}</code>{/if}
                  </dd>
                </div>
              {/each}
            </dl>
            <p class="st-note">Every variable is also in the <code>_waf_ctx</code> map, e.g. <code>_waf_ctx.path</code>. Headers are in <code>_waf_ctx.headers</code> with lowercase names.</p>
          {:else}
            {#each SYNTAX_CARDS as c (c.title)}
              <div class="st-card">
                <div class="st-card-head">
                  <strong>{c.title}</strong>
                  <button type="button" class="st-insert" aria-label={`Insert example: ${c.title}`} onclick={() => insertSnippet(c.code + '\n')}>Insert</button>
                </div>
                <pre class="st-code"><code>{c.code}</code></pre>
                {#if c.note}<p>{c.note}</p>{/if}
              </div>
            {/each}
          {/if}
        </div>
      {/snippet}
    </Tabs>
  </div>
</div>

<ConfirmModal
  open={pendingTemplate !== null}
  tone="warning"
  title="Replace the script?"
  message={`The "${pendingTemplate?.label ?? ''}" template replaces everything in the editor. The current script is not kept anywhere else.`}
  confirmLabel="Replace script"
  onconfirm={() => {
    const tpl = pendingTemplate;
    pendingTemplate = null;
    if (tpl) replaceScript(tpl.code);
  }}
  onclose={() => (pendingTemplate = null)}
/>

<style>
  .st-workspace { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--sp-3); min-height: 420px; }

  .st-editor-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  /* The editor hides its own outline; keyboard focus shows on the host. */
  .st-cm-host:has(:global(.cm-focused)) { box-shadow: inset 0 0 0 var(--ring-width) var(--ring-color); }
  .st-editor-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
  }
  .st-templates { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
  .st-toolbar-label { font-size: var(--fs-xs); color: var(--text-muted); margin-right: var(--sp-1); }
  .st-tpl {
    padding: 2px var(--sp-2);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .st-tpl:hover { color: var(--text-primary); }
  .st-cm-host { flex: 1; min-height: 260px; overflow: auto; background: var(--bg-code); }
  .st-syntax {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--border);
    font-size: var(--fs-sm);
    color: var(--danger);
    background: var(--danger-tint);
  }
  .st-size { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); text-align: right; }
  .st-size.is-over { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .st-forbidden { margin: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-left: 3px solid var(--danger); border-radius: var(--radius); background: var(--bg-card); font-size: var(--fs-sm); color: var(--text-primary); }
  .st-forbidden p { margin: 0 0 var(--sp-1); }
  .st-forbidden ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .st-forbidden code { font-family: var(--font-mono); font-size: var(--fs-xs); padding: 0 var(--sp-1); background: var(--bg-tertiary); border-radius: var(--radius); }
  .st-syntax.is-ok { color: var(--success); background: var(--success-tint); }

  .st-ref-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: 560px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .st-ref-pane :global(.ui-tabs) { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .st-ref-pane :global(.ui-tabs-bar) { margin-bottom: 0; padding: 0 var(--sp-2); }
  .st-ref-pane :global(.ui-tabpanel) { flex: 1; min-height: 0; overflow-y: auto; }
  .st-ref-content { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3); }

  .st-block, .st-card { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); background: var(--surface-input); border: 1px solid var(--border); border-radius: var(--radius); }
  .st-block h4, .st-fn-group h4 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  .st-block p, .st-block li, .st-card p { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.55; }
  .st-block ul { margin: 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-1); }
  .st-block code, .st-doc-list code, .st-note code, .st-var code { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-primary); }
  .st-flow { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); counter-reset: step; }
  .st-flow li {
    counter-increment: step;
    padding: 1px var(--sp-2);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .st-flow li::before { content: counter(step) '. '; color: var(--text-muted); }
  .st-flow li.is-me { color: var(--text-on-accent); background: var(--accent); border-color: var(--accent); font-weight: var(--fw-semibold); }
  .st-flow li.is-me::before { color: inherit; }

  .st-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .st-card-head strong { font-size: var(--fs-sm); color: var(--text-primary); }
  .st-insert {
    padding: 2px var(--sp-2);
    background: none;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .st-code { margin: 0; padding: var(--sp-2); background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; }
  .st-code code { font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.55; color: var(--text-primary); white-space: pre; }

  .st-fn-group { display: flex; flex-direction: column; gap: var(--sp-2); }
  .st-doc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .st-doc-list li { display: flex; flex-direction: column; gap: 2px; }
  .st-doc-list span { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
  .st-fn { padding: 0; background: none; border: 0; text-align: left; cursor: pointer; }
  .st-fn:hover code { text-decoration: underline; }

  .st-vars { margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .st-var { padding: var(--sp-2); background: var(--surface-input); border: 1px solid var(--border); border-radius: var(--radius); }
  .st-var dt { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .st-var dd { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; display: flex; flex-direction: column; gap: var(--sp-1); }
  .st-type { font-size: var(--fs-xs); color: var(--text-secondary); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 0 var(--sp-1); }
  .st-example { width: fit-content; padding: 1px var(--sp-1); background: var(--bg-code); border-radius: var(--radius); }
  .st-note { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }

  @media (max-width: 860px) {
    .st-workspace { grid-template-columns: 1fr; }
    .st-ref-pane { max-height: 420px; }
  }
</style>
