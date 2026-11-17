<!--
  DryRunPanel: runs the rule being edited against a sample request through
  the server's validate-gui endpoint (nothing is saved). A Match & act result
  names the action the rule would take (verdict tone); a tuning result only
  says whether the "Apply when" scope matches, since tuning never decides.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import check from 'svelte-awesome/icons/check';
  import exclamationTriangle from 'svelte-awesome/icons/exclamationTriangle';
  import chevronDown from 'svelte-awesome/icons/chevronDown';
  import play from 'svelte-awesome/icons/play';
  import plus from 'svelte-awesome/icons/plus';
  import trash from 'svelte-awesome/icons/trash';
  import type { CustomRuleDryRunResult, CustomRuleDryRunSample } from '#lib/api.js';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { actionTone } from '#lib/tone.js';

  interface Props {
    canRun: boolean;
    cannotRunHint?: string;
    runTest: (sample: CustomRuleDryRunSample) => Promise<CustomRuleDryRunResult | { error: string }>;
    resetKey?: string; // when this changes, stale results are cleared
  }

  let { canRun, cannotRunHint = '', runTest, resetKey = '' }: Props = $props();

  const uid = $props.id();

  interface KVRow { k: string; v: string }
  type TestOutcome = { kind: 'match' | 'nomatch' | 'error'; action?: string; message: string; trace?: string[] };

  const ACTION_VERB: Record<string, string> = { block: 'Block', allow: 'Allow', challenge: 'Challenge', log: 'Log' };

  let panelOpen = $state(false);
  let panelEl: HTMLElement | null = $state(null);
  let testing = $state(false);
  let result: TestOutcome | null = $state(null);

  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => ({ value: m, label: m }));
  const CONTENT_TYPES = [
    { value: '', label: 'None' },
    ...['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].map((t) => ({ value: t, label: t })),
  ];

  let sampleMethod = $state('GET');
  let samplePath = $state('/');
  let sampleQuery = $state('');
  let sampleIp = $state('');
  let sampleCountry = $state('');
  let sampleUserAgent = $state('');
  let sampleBody = $state('');
  let contentType = $state('');
  let headerRows = $state<KVRow[]>([]);
  let cookieRows = $state<KVRow[]>([]);

  // Auto-clear stale test result when the rule being tested changes
  $effect(() => {
    void resetKey;
    result = null;
  });

  function kvToRecord(rows: KVRow[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rows) {
      const k = r.k.trim();
      if (k) out[k.toLowerCase()] = r.v;
    }
    return out;
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    if (panelOpen) {
      void tick().then(() => panelEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  }

  async function handleRun() {
    if (!canRun || testing) return;
    testing = true;
    result = null;
    const sample: CustomRuleDryRunSample = {
      method: sampleMethod,
      path: samplePath,
      query: sampleQuery,
      ip: sampleIp,
      country: sampleCountry,
      user_agent: sampleUserAgent,
      body: sampleBody,
      headers: kvToRecord(headerRows),
      cookies: kvToRecord(cookieRows),
      content_type: contentType,
    };
    try {
      const res = await runTest(sample);
      if ('error' in res) {
        result = { kind: 'error', message: res.error };
      } else if (res.matched && res.action) {
        const verb = ACTION_VERB[res.action] ?? res.action;
        result = { kind: 'match', action: res.action, message: `Matches: the rule would ${verb.toLowerCase()} this request.`, trace: res.trace };
      } else if (res.matched) {
        result = { kind: 'match', message: 'Matches: the tuning effect applies to this request.', trace: res.trace };
      } else {
        result = { kind: 'nomatch', message: 'No match: the rule does not apply to this request.', trace: res.trace };
      }
    } catch (err) {
      result = { kind: 'error', message: (err as Error)?.message || 'Test request failed.' };
    } finally {
      testing = false;
    }
  }

  function traceGlyph(line: string): string {
    const l = line.toLowerCase();
    if (/(no match|not match|no hit|miss|fail|error)/.test(l)) return '✗';
    if (/(match|hit|appli|skip|block|allow|log|scan|engine|tuning|rule)/.test(l)) return '✓';
    return '•';
  }
</script>

<div class="drp" class:open={panelOpen} bind:this={panelEl}>
  <button
    type="button"
    class="drp-head"
    aria-expanded={panelOpen}
    aria-controls="{uid}-body"
    onclick={togglePanel}
  >
    <span class="drp-chevron" class:open={panelOpen} aria-hidden="true">
      <Icon data={chevronDown} scale={0.75} />
    </span>
    <span class="drp-title">
      <strong>Test with a sample request</strong>
      <small>Checks the rule as it is now in the editor. Nothing is saved.</small>
    </span>
  </button>

  {#if panelOpen}
    <div id="{uid}-body" class="drp-body">
      <div class="drp-grid">
        <div class="drp-group drp-span-2">
          <label for="{uid}-method">Method</label>
          <Select id="{uid}-method" options={METHODS} bind:value={sampleMethod} />
        </div>
        <div class="drp-group drp-span-6">
          <label for="{uid}-path">Path</label>
          <input id="{uid}-path" type="text" class="drp-input" placeholder="/api/login" bind:value={samplePath} />
        </div>
        <div class="drp-group drp-span-4">
          <label for="{uid}-ip">Client IP</label>
          <input id="{uid}-ip" type="text" class="drp-input" placeholder="203.0.113.10" bind:value={sampleIp} />
        </div>
        <div class="drp-group drp-span-6">
          <label for="{uid}-query">Query string</label>
          <input id="{uid}-query" type="text" class="drp-input" placeholder="debug=1&token=x" bind:value={sampleQuery} />
        </div>
        <div class="drp-group drp-span-2">
          <label for="{uid}-country">Country</label>
          <input id="{uid}-country" type="text" class="drp-input" placeholder="ID" maxlength="2" bind:value={sampleCountry} />
        </div>
        <div class="drp-group drp-span-4">
          <label for="{uid}-ua">User agent</label>
          <input id="{uid}-ua" type="text" class="drp-input" placeholder="Mozilla/5.0 ..." bind:value={sampleUserAgent} />
        </div>

        <!-- Headers / Cookies key-value editors -->
        <div class="drp-group drp-span-6">
          <label for="{uid}-hk0">Headers</label>
          <div class="drp-kv">
            {#each headerRows as row, i (i)}
              <div class="drp-kv-row">
                <input
                  id={i === 0 ? `${uid}-hk0` : undefined}
                  type="text"
                  class="drp-input drp-kv-k"
                  placeholder="name"
                  bind:value={row.k}
                  aria-label="Header name"
                />
                <input
                  type="text"
                  class="drp-input drp-kv-v"
                  placeholder="value"
                  bind:value={row.v}
                  aria-label="Header value"
                />
                <button
                  type="button"
                  class="drp-kv-x"
                  aria-label="Remove header row"
                  onclick={() => (headerRows = headerRows.filter((_, idx) => idx !== i))}
                >
                  <Icon data={trash} scale={0.7} aria-hidden="true" />
                </button>
              </div>
            {/each}
            <button type="button" class="drp-kv-add" onclick={() => (headerRows = [...headerRows, { k: '', v: '' }])}>
              <Icon data={plus} scale={0.6} aria-hidden="true" />
              Add header
            </button>
          </div>
        </div>
        <div class="drp-group drp-span-6">
          <label for="{uid}-ck0">Cookies</label>
          <div class="drp-kv">
            {#each cookieRows as row, i (i)}
              <div class="drp-kv-row">
                <input
                  id={i === 0 ? `${uid}-ck0` : undefined}
                  type="text"
                  class="drp-input drp-kv-k"
                  placeholder="name"
                  bind:value={row.k}
                  aria-label="Cookie name"
                />
                <input
                  type="text"
                  class="drp-input drp-kv-v"
                  placeholder="value"
                  bind:value={row.v}
                  aria-label="Cookie value"
                />
                <button
                  type="button"
                  class="drp-kv-x"
                  aria-label="Remove cookie row"
                  onclick={() => (cookieRows = cookieRows.filter((_, idx) => idx !== i))}
                >
                  <Icon data={trash} scale={0.7} aria-hidden="true" />
                </button>
              </div>
            {/each}
            <button type="button" class="drp-kv-add" onclick={() => (cookieRows = [...cookieRows, { k: '', v: '' }])}>
              <Icon data={plus} scale={0.6} aria-hidden="true" />
              Add cookie
            </button>
          </div>
        </div>

        <div class="drp-group drp-span-4">
          <label for="{uid}-ct">Content-Type</label>
          <Select id="{uid}-ct" options={CONTENT_TYPES} bind:value={contentType} />
        </div>
        <div class="drp-group drp-span-12">
          <label for="{uid}-body">Request body</label>
          <textarea
            id="{uid}-body"
            class="drp-input drp-textarea"
            rows="3"
            placeholder="Optional raw request body"
            bind:value={sampleBody}
          ></textarea>
        </div>
      </div>

      <div class="drp-actions">
        <Button variant="secondary" size="sm" loading={testing} disabled={!canRun} title={!canRun && cannotRunHint ? cannotRunHint : undefined} onclick={handleRun}>
          <Icon data={play} scale={0.7} aria-hidden="true" />
          {testing ? 'Running…' : 'Run test'}
        </Button>
        {#if !canRun && cannotRunHint}<span class="drp-hint">{cannotRunHint}.</span>{/if}

        {#if result}
          <div class="drp-result" class:is-error={result.kind === 'error'} role="status">
            {#if result.kind === 'match'}
              <Icon data={check} scale={0.8} aria-hidden="true" />
              {#if result.action}<Badge tone={actionTone(result.action)}>{ACTION_VERB[result.action] ?? result.action}</Badge>{:else}<Badge tone="info">Applies</Badge>{/if}
            {:else if result.kind === 'nomatch'}
              <Badge tone="neutral">No match</Badge>
            {:else}
              <Icon data={exclamationTriangle} scale={0.8} aria-hidden="true" />
            {/if}
            <span>{result.message}</span>
          </div>
        {/if}
      </div>

      {#if result?.trace && result.trace.length > 0}
        <div class="drp-trace" role="log" aria-label="Evaluation trace">
          {#each result.trace as line, i (i)}
            <div class="drp-trace-line" class:neg={traceGlyph(line) === '✗'}>
              <span class="drp-trace-glyph" aria-hidden="true">{traceGlyph(line)}</span>
              <span class="drp-trace-text">{line}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .drp {
    flex-shrink: 0;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .drp.open { border-color: var(--border-strong); }

  .drp-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    box-sizing: border-box;
    padding: var(--sp-2) var(--sp-3);
    background: transparent;
    border: 0;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
  }
  .drp-head:hover { background: var(--bg-hover); }
  .drp-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    border-radius: var(--radius);
    background: var(--bg-tertiary);
    color: var(--accent);
    transition: transform 0.18s ease;
  }
  .drp-chevron.open { transform: rotate(180deg); }
  .drp-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .drp-title strong { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .drp-title small { font-size: var(--fs-xs); color: var(--text-muted); }

  .drp-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3); border-top: 1px solid var(--border); }

  .drp-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--sp-3); }
  .drp-span-2 { grid-column: span 2; }
  .drp-span-4 { grid-column: span 4; }
  .drp-span-6 { grid-column: span 6; }
  .drp-span-12 { grid-column: 1 / -1; }

  .drp-group { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
  .drp-group label { font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--text-secondary); white-space: nowrap; }

  .drp-input {
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
  .drp-input::placeholder { color: var(--text-muted); }
  .drp-textarea { height: 64px; padding: var(--sp-2); resize: vertical; line-height: 1.4; }

  .drp-kv { display: flex; flex-direction: column; gap: var(--sp-1); }
  .drp-kv-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 30px; gap: var(--sp-1); align-items: center; }
  .drp-kv-k,
  .drp-kv-v { height: 30px; font-size: var(--fs-xs); }
  .drp-kv-x {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .drp-kv-x:hover { color: var(--danger); border-color: var(--danger); }
  .drp-kv-add {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 2px var(--sp-2);
    background: none;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .drp-kv-add:hover { color: var(--text-primary); border-color: var(--accent); }

  .drp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
  .drp-hint { font-size: var(--fs-xs); color: var(--text-muted); }
  .drp-result {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-primary);
  }
  .drp-result.is-error { color: var(--danger); }

  .drp-trace {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    padding: var(--sp-2) var(--sp-3);
    overflow-y: auto;
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .drp-trace-line { display: flex; align-items: baseline; gap: var(--sp-2); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.45; color: var(--text-secondary); }
  .drp-trace-glyph { flex-shrink: 0; width: 1em; text-align: center; font-weight: var(--fw-bold); color: var(--text-primary); }
  .drp-trace-line.neg .drp-trace-glyph,
  .drp-trace-line.neg .drp-trace-text { color: var(--text-muted); }
  .drp-trace-text { min-width: 0; white-space: pre-wrap; word-break: break-word; }

  @media (max-width: 680px) {
    .drp-grid .drp-group { grid-column: 1 / -1; }
  }
</style>
