<!--
  HostConfigEvidence: desired vs applied generation of each policy bundle the
  control plane pushed to a host agent. Delivery states are shown in words;
  the tone only repeats them (applied → success, pending → status-pending,
  failed/refused → danger). The firewall bundle also shows "running saved
  policy" and "DNS relaxed until control plane pinned".
-->
<script lang="ts">
  import Badge from '#lib/components/ui/Badge.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import type { BadgeTone } from '#lib/tone.js';
  import type { EBPFStatus } from '#lib/api.js';

  interface Props {
    bundles: EBPFStatus['bundle_status'];
    /** Heading level of the summary title (default 2; use 3 or 4 inside a section). */
    headingLevel?: 2 | 3 | 4;
  }

  let { bundles, headingLevel = 2 }: Props = $props();

  const entries = $derived(Object.entries(bundles ?? {}));
  const open = $derived(entries.filter(([, bundle]) => bundle.status !== 'applied').length);

  function stateTone(status: string): BadgeTone {
    if (status === 'applied') return 'success';
    if (status === 'failed' || status === 'refused') return 'danger';
    if (status === 'pending') return 'status-pending';
    return 'neutral';
  }
</script>

<details class="hce">
  <summary>
    <span class="hce-head">
      <svelte:element this={`h${headingLevel}`} class="hce-title">Configuration delivery</svelte:element>
      <span class="hce-sub">{entries.length ? 'Desired and applied policy generations reported by the agent' : 'Applied acknowledgement unknown'}</span>
    </span>
    <span class="hce-count">{open} pending or failed</span>
  </summary>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="hce-scroll" role="region" aria-label="Configuration delivery by policy" tabindex="0">
    <table>
      <thead>
        <tr>
          <th scope="col">Policy</th>
          <th scope="col">Delivery state</th>
          <th scope="col">Desired generation</th>
          <th scope="col">Applied generation</th>
          <th scope="col">Reported</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as [kind, bundle] (kind)}
          <tr>
            <th scope="row">{kind}</th>
            <td>
              <Badge tone={stateTone(bundle.status)}>{bundle.status === 'refused' ? `apply refused (${bundle.code || 'unknown'})` : bundle.status}</Badge>
              {#if bundle.source === 'saved'}<Badge tone="info" title={bundle.saved_generation ? `Saved generation ${bundle.saved_generation}` : undefined}>running saved policy</Badge>{/if}
              {#if bundle.dns_relaxed}<Badge tone="warning">DNS relaxed until control plane pinned</Badge>{/if}
            </td>
            <td><code>{bundle.desired_generation || 'Unknown'}</code></td>
            <td><code>{bundle.applied_generation || 'Unknown'}</code></td>
            <td><DateTime value={bundle.updated_at} fallback="Unknown" /></td>
          </tr>
          {#if bundle.error}
            <tr><td colspan="5" class="hce-error">{kind}: {bundle.error}</td></tr>
          {/if}
        {:else}
          <tr><td colspan="5" class="hce-unknown">The agent has not acknowledged any configuration. Current protection cannot be verified from delivery state.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="hce-note">Delivery alone does not prove the policy is enforced; supported hooks and telemetry coverage are reported separately.</p>
</details>

<style>
  .hce { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); overflow: hidden; }
  summary { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-2) var(--sp-4); padding: var(--sp-3) var(--sp-4); cursor: pointer; }
  summary:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; }
  .hce-head { display: grid; gap: var(--sp-1); min-width: 0; }
  .hce-title { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .hce-sub, .hce-count { font-size: var(--fs-xs); color: var(--text-muted); }
  .hce-scroll { position: relative; overflow-x: auto; }
  .hce-scroll:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; }
  table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); white-space: nowrap; }
  th, td { padding: var(--sp-2) var(--sp-4); border-top: 1px solid var(--border); text-align: left; font-weight: var(--fw-medium); }
  thead th { background: var(--bg-secondary); color: var(--text-muted); }
  tbody th { color: var(--text-primary); }
  td { color: var(--text-secondary); font-weight: normal; font-variant-numeric: tabular-nums; }
  code { font-family: var(--font-mono); }
  .hce-error { color: var(--danger); white-space: normal; }
  .hce-unknown { white-space: normal; }
  .hce-note { margin: 0; padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
</style>
