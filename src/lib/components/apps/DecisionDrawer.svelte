<!--
  DecisionDrawer: one WAF decision in a side sheet (native dialog: focus
  containment, Escape, focus return) with the actions an operator
  needs next:
  - Tune false positive → Custom rules with a tuning rule prefilled;
  - Block IP → an app custom rule (simple confirmation);
  - Copy as cURL;
  - Show decisions from this IP (feed filter).
  Every value is rendered as text (no {@html}).
-->
<script lang="ts">
  import { countryFlag } from '#lib/geo.js';
  import { base } from '#lib/paths.js';
  import { createCustomRule, type WAFDecisionRow } from '#lib/api.js';
  import { Alert, Badge, Button, ConfirmModal, DateTime, Drawer } from '#lib/components/ui/index.js';
  import WAFDecisionFeedback from '#lib/components/WAFDecisionFeedback.svelte';
  import { actionTone, strengthTone } from '#lib/tone.js';
  import { formatBytes, formatDuration } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { isWSDecision } from '#lib/waf-live.js';
  import {
    blockIpRuleBody,
    canTuneDecision,
    curlBodyTruncated,
    curlCommand,
    curlUnavailableReason,
    isInspectionGap,
    isScriptIncomplete,
    tuningDraftFromDecision,
    tuningRuleHref,
  } from './decision-actions';
  import { actionLabel, analyzeMethodLabel, coverageGapNote, coverageLabel, engineLabel, enginesLogOnlyOf, enginesOffOf, gapFlags, inspectionGapNote, logOnlyNote, SCRIPT_COVERAGE_FLAGS, scriptIncompleteNote, statusLabel, strengthLabel } from './decision-format';

  let {
    decision,
    projectId,
    appId,
    country = '',
    canConfigure = false,
    onclose,
    onfilterip = undefined,
  }: {
    /** The decision to show; null closes the drawer. */
    decision: WAFDecisionRow | null;
    projectId: string;
    appId: string;
    /** Country code of the client, when the geo lookup has one. */
    country?: string;
    canConfigure?: boolean;
    onclose: () => void;
    /** Filters the feed to this client IP. */
    onfilterip?: (ip: string) => void;
  } = $props();

  const d = $derived(decision);
  const live = $derived(Boolean(d && d.id === 0));
  const tunable = $derived(d ? canTuneDecision(d) : false);
  const tuneHref = $derived(d && tunable ? tuningRuleHref(base, projectId, tuningDraftFromDecision(d, appId)) : '');
  const curlReason = $derived(d ? curlUnavailableReason(d) : null);
  // Gap flags only. Switched-off engines have their own line.
  const flags = $derived(gapFlags(d?.coverage));
  const enginesOff = $derived(d ? enginesOffOf(d) : []);
  const enginesLogOnly = $derived(d ? enginesLogOnlyOf(d) : []);
  // Marker the agent and control plane put in place of a credential.
  const REDACTED = '[redacted]';
  const headers = $derived(Object.entries(d?.request_headers ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const countryCode = $derived((d?.country_code || country || '').toUpperCase());

  const gap = $derived(d ? isInspectionGap(d) : false);
  const scriptIncomplete = $derived(d ? isScriptIncomplete(d) : false);
  // Flags that mean part of the request was not scanned; a script flag says the script did not finish.
  const scanGapFlags = $derived(flags.filter((flag) => !SCRIPT_COVERAGE_FLAGS.includes(flag)));

  let blockOpen = $state(false);
  let blocking = $state(false);
  let curlText = $state('');

  $effect(() => {
    // A different decision starts without the cURL fallback text.
    void decision;
    curlText = '';
  });

  async function copyCurl() {
    if (!d || curlReason) return;
    const text = curlCommand(d);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(curlBodyTruncated(d) ? 'The recorded body is truncated, so the command may differ from the original request.' : 'Paste it into a terminal to reproduce the request shape.', 'cURL copied');
    } catch {
      curlText = text;
      toast.info('Copy the command from the box in the drawer.', 'Clipboard unavailable');
    }
  }

  async function blockIp() {
    if (!d || !canConfigure || blocking || !d.remote_addr) return;
    blocking = true;
    const result = await createCustomRule(projectId, appId, blockIpRuleBody(d.remote_addr, d));
    blocking = false;
    blockOpen = false;
    if (result.error) {
      toast.error(result.error.error || 'Could not create the block rule.', 'Block rule not created');
      return;
    }
    toast.success(`It applies once the agent receives the updated rules. Manage it on Custom rules.`, `Blocking ${d.remote_addr}`);
  }
</script>

<Drawer open={Boolean(d)} title={d ? `${actionLabel(d.action)} · ${d.method} ${d.host || ''}` : 'Decision'} size="lg" onclose={onclose}>
  {#if d}
    <div class="dd">
      <div class="dd-summary">
        <Badge tone={actionTone(d.action)}>{actionLabel(d.action)}</Badge>
        {#if isWSDecision(d)}<Badge tone="cat3" title={`WebSocket decision (${d.match_source || 'ws'})`}>WebSocket</Badge>{/if}
        {#if live}<Badge tone="info" title="Received on the live stream; not stored yet">Live</Badge>{/if}
        <code class="dd-uri">{d.uri}</code>
      </div>

      <div class="dd-actions" role="group" aria-label="Decision actions">
        {#if tunable}
          <Button variant="secondary" size="sm" href={tuneHref} disabled={!canConfigure} title={canConfigure ? 'Open Custom rules with a tuning rule for this path and parameter' : 'Member access required'}>Tune false positive</Button>
        {/if}
        {#if scriptIncomplete}
          <Button variant="secondary" size="sm" href="{base}/projects/{encodeURIComponent(projectId)}/rules" title="Open the Custom rules of this project; script rules are listed there">Script rules</Button>
        {/if}
        {#if d.remote_addr}
          <Button variant="secondary" size="sm" disabled={!canConfigure} title={canConfigure ? `Add a custom rule that blocks ${d.remote_addr}` : 'Member access required'} onclick={() => (blockOpen = true)}>Block IP</Button>
        {/if}
        <Button variant="ghost" size="sm" disabled={Boolean(curlReason)} title={curlReason ?? 'Copy the recorded request as a cURL command'} onclick={() => void copyCurl()}>Copy as cURL</Button>
        {#if onfilterip && d.remote_addr}
          <Button variant="ghost" size="sm" onclick={() => onfilterip?.(d.remote_addr)}>Decisions from this IP</Button>
        {/if}
      </div>
      {#if curlText}
        <label class="dd-curl">
          <span>cURL command</span>
          <textarea readonly rows="6" value={curlText}></textarea>
        </label>
      {/if}
      {#if !canConfigure}
        <p class="dd-note">Viewers can inspect decisions; tuning and blocking need member access.</p>
      {/if}

      <dl class="dd-grid">
        <div><dt>Event time</dt><dd><DateTime value={d.event_time} seconds relative /></dd></div>
        <div><dt>Recorded at</dt><dd><DateTime value={d.recorded_at} seconds fallback="Not stored yet" /></dd></div>
        <div><dt>Response status</dt><dd class:mono={statusLabel(d.status) !== 'Not recorded'} title="The HTTP status the client received. Older rows and logged WebSocket handshakes have none.">{statusLabel(d.status)}</dd></div>
        <div><dt>Latency</dt><dd class="mono">{formatDuration(d.latency_us, 'us')}</dd></div>
        <div><dt>Body size</dt><dd class="mono">{formatBytes(d.body_size)}</dd></div>
      </dl>

      <section class="dd-section" aria-labelledby="dd-client">
        <h3 id="dd-client">Client</h3>
        <dl class="dd-grid">
          <div><dt>IP address</dt><dd class="mono">{d.remote_addr || 'n/a'}</dd></div>
          <div><dt>Country</dt><dd>{#if countryCode}<span aria-hidden="true">{countryFlag(countryCode)}</span> {countryCode}{:else}n/a{/if}</dd></div>
          <div class="span-2"><dt>User agent</dt><dd class="mono wrap">{d.user_agent || 'n/a'}</dd></div>
        </dl>
      </section>

      <section class="dd-section" aria-labelledby="dd-detection">
        <h3 id="dd-detection">Detection</h3>
        {#if gap}<Alert tone="info" compact message={inspectionGapNote()} />{/if}
        {#if scriptIncomplete}<Alert tone="info" compact message={scriptIncompleteNote()} />{/if}
        <dl class="dd-grid">
          <div><dt>Detection method</dt><dd>{analyzeMethodLabel(d.analyze_method)}</dd></div>
          <div><dt>Strength</dt><dd>{#if d.strength}<Badge tone={strengthTone(d.strength)}>{strengthLabel(d.strength)}</Badge>{:else}n/a{/if}</dd></div>
          <div class="span-2"><dt>Categories</dt><dd>{#if d.categories?.length}<span class="dd-tags">{#each d.categories as category (category)}<Badge tone="neutral">{category}</Badge>{/each}</span>{:else}n/a{/if}</dd></div>
          {#if d.cwe}<div><dt>CWE</dt><dd class="mono">{d.cwe}</dd></div>{/if}
          {#if d.match_source}<div><dt>Matched in</dt><dd class="mono wrap">{d.match_source}</dd></div>{/if}
          {#if d.match_detail}<div class="span-2"><dt>Match detail</dt><dd class="mono wrap">{d.match_detail}</dd></div>{/if}
          {#if enginesOff.length > 0}
            <div class="span-2">
              <dt>Engines off</dt>
              <dd>{enginesOff.map(engineLabel).join(', ')}</dd>
            </div>
          {/if}
          {#if enginesLogOnly.length > 0}
            <div class="span-2">
              <dt>Log only</dt>
              <dd>{enginesLogOnly.map(engineLabel).join(', ')}<span class="dd-muted dd-block">{logOnlyNote(enginesLogOnly)}</span></dd>
            </div>
          {/if}
          <div class="span-2">
            <dt>Scan coverage</dt>
            <dd>
              {#if flags.length > 0}
                <span class="dd-tags">{#each flags as flag (flag)}<Badge tone="warning" title={flag}>{coverageLabel(flag)}</Badge>{/each}</span>
                {#if scanGapFlags.length > 0}<span class="dd-muted dd-block">{coverageGapNote()}</span>{/if}
              {:else}
                <span title="Agents that predate coverage reporting also show Complete">Complete</span>
              {/if}
            </dd>
          </div>
        </dl>
      </section>

      <section class="dd-section" aria-labelledby="dd-request">
        <h3 id="dd-request">Request</h3>
        <dl class="dd-grid">
          <div><dt>Method</dt><dd class="mono">{d.method}</dd></div>
          <div><dt>Payload type</dt><dd>{d.payload_type || d.content_type || 'n/a'}</dd></div>
          <div class="span-2"><dt>Host</dt><dd class="mono wrap">{d.host || 'n/a'}</dd></div>
        </dl>
        {#if d.query_params}
          <h4>Query parameters</h4>
          <pre class="dd-pre">{d.query_params}</pre>
        {/if}
        {#if headers.length > 0}
          <h4>Request headers</h4>
          <table class="dd-headers">
            <caption class="sr-only">Recorded request headers</caption>
            <tbody>
              {#each headers as [name, value] (name)}
                <tr><th scope="row">{name}</th><td class:dd-redacted={value === REDACTED}>{value}</td></tr>
              {/each}
            </tbody>
          </table>
          <p class="dd-muted">Credentials (API keys, tokens, session and signature values) are shown as {REDACTED}; the input that triggered the detection keeps its value. Authorization and cookies are not recorded unless they triggered it.</p>
        {/if}
        <h4>Request body</h4>
        {#if d.request_body}
          <pre class="dd-pre">{d.request_body}</pre>
          {#if d.body_size > d.request_body.length}<p class="dd-muted">Showing the recorded part · full size {formatBytes(d.body_size)}</p>{/if}
        {:else if d.body_preview}
          <pre class="dd-pre">{d.body_preview}</pre>
          {#if d.body_size > d.body_preview.length}<p class="dd-muted">Showing a preview · full size {formatBytes(d.body_size)}</p>{/if}
        {:else}
          <p class="dd-muted">{d.body_size > 0 ? `Body present (${formatBytes(d.body_size)}); no preview was recorded.` : 'No body.'}</p>
        {/if}
      </section>

      <section class="dd-section">
        {#key `${d.id}/${d.recorded_at}`}
          <WAFDecisionFeedback {projectId} {appId} decisionId={d.id} recordedAt={d.recorded_at} />
        {/key}
      </section>

      <section class="dd-section" aria-labelledby="dd-ids">
        <h3 id="dd-ids">Identifiers</h3>
        <dl class="dd-grid">
          <div><dt>Decision</dt><dd class="mono">{d.id ? `#${d.id}` : 'Live (not stored)'}</dd></div>
          <div><dt>Agent</dt><dd class="mono wrap">{d.agent_id || 'n/a'}</dd></div>
          <div class="span-2"><dt>Application</dt><dd class="mono wrap">{d.app_id || appId}</dd></div>
        </dl>
      </section>
    </div>
  {/if}
</Drawer>

<ConfirmModal
  open={blockOpen}
  tone="warning"
  title={`Block ${d?.remote_addr ?? ''}?`}
  confirmLabel="Create block rule"
  loading={blocking}
  onconfirm={() => void blockIp()}
  onclose={() => (blockOpen = false)}
>
  <p class="dd-confirm">Adds an enabled custom rule to this application that blocks every request from <code>{d?.remote_addr}</code>. Remove or disable it on Custom rules. Clients behind a shared address (NAT, proxy) are blocked too.</p>
</ConfirmModal>

<style>
  .dd { display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; }
  .dd-summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .dd-uri { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-primary); overflow-wrap: anywhere; flex-basis: 100%; }
  .dd-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .dd-curl { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-secondary); }
  .dd-curl textarea { width: 100%; font-family: var(--font-mono); font-size: var(--fs-xs); background: var(--bg-code); color: var(--text-primary); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: var(--sp-2); }
  .dd-note, .dd-muted { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .dd-block { display: block; margin-top: var(--sp-1); }
  .dd-section { display: flex; flex-direction: column; gap: var(--sp-2); border-top: 1px solid var(--border); padding-top: var(--sp-4); min-width: 0; }
  .dd-section h3 { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .dd-section h4 { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .dd-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3) var(--sp-4); margin: 0; }
  .dd-grid > div { min-width: 0; }
  .dd-grid .span-2 { grid-column: 1 / -1; }
  .dd-grid dt { font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--sp-1); }
  .dd-grid dd { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .mono { font-family: var(--font-mono); }
  .wrap { overflow-wrap: anywhere; }
  .dd-tags { display: inline-flex; flex-wrap: wrap; gap: var(--sp-1); }
  .dd-pre { margin: 0; max-height: 18rem; overflow: auto; padding: var(--sp-3); background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
  .dd-headers { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); font-family: var(--font-mono); }
  .dd-headers th, .dd-headers td { text-align: left; vertical-align: top; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
  .dd-headers td.dd-redacted { color: var(--text-muted); font-style: italic; }
  .dd-headers th { color: var(--text-muted); font-weight: var(--fw-medium); width: 35%; }
  .dd-confirm { margin: 0; color: var(--text-secondary); line-height: 1.5; }
  .dd-confirm code { font-family: var(--font-mono); color: var(--text-primary); }
  @media (max-width: 640px) { .dd-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
