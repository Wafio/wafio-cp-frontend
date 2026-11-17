<!--
  OverviewEvidence: the Overview "Needs attention" queue.
  One row per problem, not per record: incidents grouped by host × detection
  rule, heartbeat gaps, unconfirmed configuration, expiring certificates.
  Each row has a count, its worst severity (always with text) and one action
  that opens the item, or the list filtered to the group. The records behind
  a row and the raw source evidence sit in disclosures.
-->
<script lang="ts">
  import type { OverviewEvidence } from '#lib/api.js';
  import type { AttentionGroup } from '#lib/overview.js';
  import { formatDateTime, formatRelative } from '#lib/format.js';
  import { severityTone, normalizeSeverity } from '#lib/tone.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';

  let {
    groups,
    evidence = null,
    loading = false,
    error = '',
    notices = [],
    scopeLabel = 'All hosts',
    onrefresh,
  }: {
    groups: AttentionGroup[];
    /** Evidence snapshot for the provenance disclosure (sources, agents). */
    evidence?: Pick<OverviewEvidence, 'sources' | 'agents' | 'snapshot_at' | 'connection_observed_at'> | null;
    loading?: boolean;
    error?: string;
    /** Partial-data notes, e.g. "Incident details unavailable; grouped by host only". */
    notices?: string[];
    scopeLabel?: string;
    onrefresh: () => void;
  } = $props();

  const totalItems = $derived(groups.reduce((sum, group) => sum + group.count, 0));
  const degradedSources = $derived(
    Object.entries(evidence?.sources ?? {}).filter(([, source]) => ['unavailable', 'partial', 'error', 'failed', 'stale'].includes(source.state)),
  );

  function severityText(severity: string): string {
    const s = normalizeSeverity(severity);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
  }

  function sourceName(name: string): string {
    return name.replaceAll('_', ' ');
  }
</script>

<section class="attention" aria-labelledby="attention-title" aria-busy={loading}>
  <div class="head">
    <div>
      <h2 id="attention-title">Needs attention
        {#if !loading || groups.length}<span class="count">{groups.length === 0 ? 'none' : `${groups.length} ${groups.length === 1 ? 'group' : 'groups'} · ${totalItems} ${totalItems === 1 ? 'item' : 'items'}`}</span>{/if}
      </h2>
      <p>Current state, not limited to the time range · {scopeLabel}</p>
    </div>
    <Button variant="secondary" size="sm" onclick={onrefresh} loading={loading} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
  </div>

  {#if error}
    <div class="notice-wrap"><Alert tone="error" compact message={`The attention queue failed to load: ${error}. Rows shown may be out of date.`} /></div>
  {/if}
  {#each notices as notice (notice)}
    <div class="notice-wrap"><Alert tone="warning" compact message={notice} /></div>
  {/each}
  {#each degradedSources as [name, source] (name)}
    <div class="notice-wrap"><Alert tone="warning" compact message={`Source "${sourceName(name)}" is ${source.state}${source.message ? `: ${source.message}` : ''}. Missing rows are not proof of absence.`} /></div>
  {/each}

  {#if loading && groups.length === 0}
    <p class="empty" role="status">Loading items that need attention…</p>
  {:else if groups.length === 0 && !error}
    <div class="empty">
      {#if evidence && evidence.agents.length === 0}
        <!-- No agent reports yet: an empty queue here is not a clean bill of health. -->
        <p class="empty-title">No agent reports to this project yet.</p>
        <p>There is nothing to check until a WAF or host agent connects. Incidents, heartbeat gaps, pending configuration and expiring certificates appear here once one does.</p>
      {:else}
        <p class="empty-title">Nothing needs attention in the observed sources.</p>
        <p>Incidents, heartbeats, configuration acknowledgements and certificate expiry were checked. Source details are below.</p>
      {/if}
    </div>
  {:else}
    <ul class="groups">
      {#each groups as group (group.key)}
        <li class="group">
          <div class="sev"><Badge tone={severityTone(group.severity)}>{severityText(group.severity)}</Badge></div>
          <div class="body">
            <p class="title">{group.title}</p>
            <p class="summary">{group.summary}</p>
            {#if group.lastObserved}
              <p class="seen"><time datetime={group.lastObserved} title={formatDateTime(group.lastObserved, { seconds: true })}>Last observed {formatRelative(group.lastObserved)}</time></p>
            {/if}
            {#if group.count > 1}
              <details class="items">
                <summary>Show the {group.count} {group.kind === 'incident' ? 'incidents' : 'items'}</summary>
                <ul>
                  {#each group.items as item (item.id)}
                    <li>
                      <Badge tone={severityTone(item.severity)}>{severityText(item.severity)}</Badge>
                      <a href={item.href}>{item.label}</a>
                      <span class="item-detail">{item.detail}</span>
                      {#if item.dueAt}<span class="item-detail">Expires <DateTime value={item.dueAt} /></span>{/if}
                      {#if item.observedAt}<time class="item-detail" datetime={item.observedAt} title={formatDateTime(item.observedAt, { seconds: true })}>{formatRelative(item.observedAt)}</time>{/if}
                    </li>
                  {/each}
                </ul>
              </details>
            {:else if group.items[0]?.dueAt}
              <p class="seen">Expires <DateTime value={group.items[0].dueAt} relative /></p>
            {/if}
          </div>
          <div class="act"><Button variant="secondary" size="sm" href={group.action.href}>{group.action.label}</Button></div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if evidence}
    <details class="provenance">
      <summary>Sources and agent evidence <span class="count">{evidence.agents.length} {evidence.agents.length === 1 ? 'agent' : 'agents'}</span></summary>
      <div class="provenance-body">
        <p>Database snapshot <DateTime value={evidence.snapshot_at} seconds relative />. Connection evidence <DateTime value={evidence.connection_observed_at} seconds fallback="unavailable" />.</p>
        <p>A fresh heartbeat means the agent was heard from recently, not that protection is verified. Capability reports can be older than heartbeats; missing fields stay unknown.</p>
        <dl class="sources">
          {#each Object.entries(evidence.sources) as [name, source] (name)}
            <dt>{sourceName(name)}</dt>
            <dd>{source.state}{source.message ? `: ${source.message}` : ''}</dd>
          {/each}
        </dl>
        {#each evidence.agents as agent (agent.id)}
          <article>
            <h3>{agent.name} <span class="kind">{agent.kind === 'waf' ? 'WAF agent' : 'Host agent'}</span></h3>
            <p>Heartbeat {agent.freshness}, <DateTime value={agent.last_seen} seconds fallback="never" />. Capability report <DateTime value={agent.state_at} fallback="none" />.</p>
            {#if agent.kind === 'waf'}
              <p>Desired configuration generation {agent.desired_generation ?? 'unknown'}; acknowledged {agent.applied_generation ?? 'unknown'} ({agent.apply_state}).</p>
            {:else}
              <p>{Object.entries(agent.capabilities).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value === null ? 'unknown' : value ? 'reported active' : 'reported inactive'}`).join(' · ')}</p>
            {/if}
          </article>
        {/each}
      </div>
    </details>
  {/if}
</section>

<style>
  .attention { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); margin: 0 0 var(--sp-5); overflow: hidden; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-4) var(--sp-5); }
  h2 { font-size: var(--fs-md); font-weight: var(--fw-semibold); margin: 0 0 var(--sp-1); display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
  .head p { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .count { font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
  .notice-wrap { padding: 0 var(--sp-5) var(--sp-3); }
  .empty { padding: var(--sp-5); text-align: center; color: var(--text-secondary); font-size: var(--fs-sm); border-top: 1px solid var(--border); margin: 0; }
  .empty p { margin: 0; }
  .empty .empty-title { font-weight: var(--fw-medium); color: var(--text-primary); margin-bottom: var(--sp-1); }
  .groups { list-style: none; margin: 0; padding: 0; }
  .group { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr) auto; gap: var(--sp-3) var(--sp-4); align-items: start; padding: var(--sp-4) var(--sp-5); border-top: 1px solid var(--border); }
  .body { min-width: 0; }
  .title { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-medium); color: var(--text-primary); overflow-wrap: anywhere; }
  .summary { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); overflow-wrap: anywhere; }
  .seen { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .items { margin-top: var(--sp-2); font-size: var(--fs-sm); }
  .items summary { cursor: pointer; color: var(--text-secondary); font-size: var(--fs-xs); }
  .items ul { list-style: none; margin: var(--sp-2) 0 0; padding: 0; max-height: 18rem; overflow: auto; }
  .items li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); padding: var(--sp-2) 0; border-top: 1px solid var(--border); }
  .items a { color: var(--accent-dim); overflow-wrap: anywhere; }
  .item-detail { font-size: var(--fs-xs); color: var(--text-muted); overflow-wrap: anywhere; }
  .act { align-self: center; }
  .provenance { border-top: 1px solid var(--border); }
  .provenance summary { padding: var(--sp-3) var(--sp-5); font-size: var(--fs-sm); color: var(--text-secondary); cursor: pointer; }
  .provenance-body { padding: 0 var(--sp-5) var(--sp-4); font-size: var(--fs-xs); color: var(--text-muted); }
  .provenance-body p { margin: 0 0 var(--sp-2); line-height: 1.6; overflow-wrap: anywhere; }
  .sources { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 3fr); gap: var(--sp-1) var(--sp-3); margin: var(--sp-3) 0; color: var(--text-secondary); }
  .sources dt, .sources dd { min-width: 0; overflow-wrap: anywhere; margin: 0; }
  article { border-top: 1px solid var(--border); padding-top: var(--sp-3); margin-top: var(--sp-3); }
  h3 { font-size: var(--fs-sm); margin: 0 0 var(--sp-1); color: var(--text-primary); }
  .kind { font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); margin-left: var(--sp-1); }
  @media (max-width: 760px) {
    .head { padding: var(--sp-4); flex-wrap: wrap; }
    .group { grid-template-columns: minmax(0, 1fr); padding: var(--sp-4); }
    .act { align-self: start; }
    .sources { grid-template-columns: minmax(0, 1fr); }
    .notice-wrap { padding: 0 var(--sp-4) var(--sp-3); }
  }
</style>
