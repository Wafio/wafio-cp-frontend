<!--
  TraceEventDetail: body of the Explore detail drawer for one runtime event
  (and, with `entry`, the enforcement record that acted on it). Grouped
  definition lists; every time is absolute, in the browser's local time zone,
  with the exact UTC instant in the tooltip. Follow-up actions filter the
  explorer or open an editor prefilled from the event.
-->
<script lang="ts">
  import type { EnforcementLogEntry, TraceEvent } from '#lib/api.js';
  import { enforcementTone, severityTone } from '#lib/tone.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import { eventActionName, enforcementModeLabel, uidLabel } from './explore';
  import { tacticForEvent, mitreForEvent } from './mitre';

  let {
    event,
    entry = undefined,
    canConfigure = false,
    onfilterprocess = undefined,
    onsuppress = undefined,
    onnewpolicy = undefined
  }: {
    event: TraceEvent;
    /** The enforcement record, when the drawer was opened from the enforcement log. */
    entry?: EnforcementLogEntry;
    canConfigure?: boolean;
    onfilterprocess?: (comm: string) => void;
    onsuppress?: (event: TraceEvent) => void;
    onnewpolicy?: (event: TraceEvent) => void;
  } = $props();

  const mitre = $derived(mitreForEvent(event.event_name));
  const action = $derived(eventActionName(event));
  const noPermission = 'Requires the member or owner role';
</script>

<div class="detail">
  <div class="detail-head">
    <Badge tone={severityTone(event.severity_name || event.severity)}>{event.severity_name || 'unknown'} severity</Badge>
    <Badge tone={enforcementTone(entry?.action ?? action)}>{entry?.action ?? action}</Badge>
    <code class="event-name">{event.event_name}</code>
    <span class="muted"><DateTime value={event.timestamp} seconds relative /></span>
  </div>
  {#if event.description}<p class="description">{event.description}</p>{/if}

  <div class="detail-actions">
    {#if onfilterprocess && event.comm}
      <Button variant="secondary" size="sm" onclick={() => onfilterprocess?.(event.comm)}>Show only {event.comm}</Button>
    {/if}
    {#if onsuppress}
      <Button variant="secondary" size="sm" disabled={!canConfigure} title={canConfigure ? 'Open a detection rule prefilled to suppress events like this one' : noPermission} onclick={() => onsuppress?.(event)}>Suppress similar events…</Button>
    {/if}
    {#if onnewpolicy}
      <Button variant="secondary" size="sm" disabled={!canConfigure} title={canConfigure ? 'Open a new policy in Simulate, prefilled from this event' : noPermission} onclick={() => onnewpolicy?.(event)}>New policy from event…</Button>
    {/if}
  </div>

  {#if entry}
    <section class="group">
      <h3>Enforcement</h3>
      <dl>
        <dt>Policy</dt><dd>{entry.policy_name || 'Unnamed policy'} <span class="muted">#{entry.policy_id}</span></dd>
        <dt>Action</dt><dd>{entry.action}</dd>
        <dt>Where enforced</dt><dd>{enforcementModeLabel(entry.mode)}</dd>
        <dt>Result</dt>
        <dd>
          {entry.event?.signal_outcome || (entry.success ? 'Operation accepted' : 'Failed')}
          {#if !entry.success && entry.failure_reason}<span class="muted"> · {entry.failure_reason}</span>{/if}
        </dd>
        <dt>Recorded</dt><dd><DateTime value={entry.recorded_at || entry.timestamp} seconds /></dd>
      </dl>
      {#if entry.mode === 'kernel'}<p class="note">A kernel signal request was accepted; that alone does not confirm the process exited.</p>{/if}
      {#if entry.mode === 'deferred_outcome'}<p class="note">Deferred request: it fires at the process's next traced system call before it expires; an idle process can survive.</p>{/if}
    </section>
  {/if}

  <section class="group">
    <h3>Process</h3>
    <dl>
      <dt>Process</dt><dd><code>{event.comm || 'n/a'}</code></dd>
      <dt>PID</dt><dd>{event.pid}</dd>
      <dt>Thread ID</dt><dd>{event.tid ?? 'n/a'}</dd>
      <dt>Parent PID</dt><dd>{event.ppid ?? 'n/a'}</dd>
      <dt>UID</dt><dd>{uidLabel(event.uid)}</dd>
      <dt>GID</dt><dd>{event.gid ?? 'n/a'}</dd>
      {#if event.cgroup_id}<dt>Cgroup ID</dt><dd><code>{event.cgroup_id}</code></dd>{/if}
      {#if event.parent_comm}<dt>Parent</dt><dd><code>{event.parent_comm}</code></dd>{/if}
      {#if event.grandparent_comm}<dt>Grandparent</dt><dd><code>{event.grandparent_comm}</code></dd>{/if}
      {#if event.filename}<dt>File</dt><dd><code class="wrap">{event.filename}</code></dd>{/if}
      {#if event.args}<dt>Arguments</dt><dd><code class="wrap">{event.args}</code></dd>{/if}
    </dl>
  </section>

  {#if event.is_container}
    <section class="group">
      <h3>Container</h3>
      <dl>
        {#if event.container_name}<dt>Name</dt><dd><code>{event.container_name}</code></dd>{/if}
        {#if event.container_image}<dt>Image</dt><dd><code class="wrap">{event.container_image}</code></dd>{/if}
        {#if event.container_id}<dt>Container ID</dt><dd><code class="wrap">{event.container_id}</code></dd>{/if}
        <dt>Privileged</dt><dd>{event.is_privileged ? 'Yes' : 'No'}</dd>
        {#if event.k8s_pod}<dt>Pod</dt><dd><code>{event.k8s_pod}</code></dd>{/if}
        {#if event.k8s_namespace}<dt>Namespace</dt><dd><code>{event.k8s_namespace}</code></dd>{/if}
      </dl>
    </section>
  {/if}

  <section class="group">
    <h3>Event</h3>
    <dl>
      <dt>Event</dt><dd><code>{event.event_name}</code></dd>
      <dt>Category</dt><dd>{event.category || 'n/a'}</dd>
      <dt>ATT&amp;CK mapping</dt>
      <dd>{#if mitre}{mitre.technique_id} · {tacticForEvent(event.event_name)} <span class="muted">(heuristic from the event name)</span>{:else}Unmapped{/if}</dd>
      {#if event.ret_val !== undefined && event.ret_val !== null}<dt>Return value</dt><dd>{event.ret_val}</dd>{/if}
      {#if event.flags}<dt>Flags</dt><dd><code>{event.flags}</code></dd>{/if}
      {#if event.detail}<dt>Detail</dt><dd><code>{event.detail}</code></dd>{/if}
      {#if event.activity_outcome}<dt>Outcome</dt><dd>{event.activity_outcome}</dd>{/if}
      {#if event.event_id}<dt>Event ID</dt><dd><code class="wrap">{event.event_id}</code></dd>{/if}
    </dl>
  </section>

  {#if event.addr || event.port}
    <section class="group">
      <h3>Network</h3>
      <dl>
        {#if event.addr}<dt>Address</dt><dd><code>{event.addr}</code></dd>{/if}
        {#if event.port}<dt>Port</dt><dd>{event.port}</dd>{/if}
        {#if event.addr_family}<dt>Address family</dt><dd>{event.addr_family}</dd>{/if}
      </dl>
    </section>
  {/if}

  <section class="group">
    <h3>Policy</h3>
    <dl>
      <dt>Action</dt><dd>{action}</dd>
      {#if event.policy_id}<dt>Policy ID</dt><dd><code>{event.policy_id}</code></dd>{/if}
      {#if event.signal_outcome}<dt>Signal outcome</dt><dd>{event.signal_outcome}</dd>{/if}
      <dt>Time</dt><dd><DateTime value={event.timestamp} seconds /></dd>
    </dl>
  </section>
</div>

<style>
  .detail { display: grid; gap: var(--sp-4); min-width: 0; }
  .detail-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .event-name { font-size: var(--fs-sm); }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .description { margin: 0; color: var(--text-secondary); font-size: var(--fs-sm); line-height: 1.5; }
  .detail-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .group { border-top: 1px solid var(--border); padding-top: var(--sp-3); min-width: 0; }
  .group h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-muted); }
  dl { display: grid; grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr); gap: var(--sp-1) var(--sp-4); margin: 0; font-size: var(--fs-sm); }
  dt { color: var(--text-muted); }
  dd { margin: 0; color: var(--text-primary); min-width: 0; }
  code { font-size: var(--fs-xs); }
  .wrap { word-break: break-all; white-space: pre-wrap; }
  .note { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
</style>
