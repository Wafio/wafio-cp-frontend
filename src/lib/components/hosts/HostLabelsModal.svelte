<!--
  HostLabelsModal: set or remove labels on one or many hosts. One request, all or nothing. Labels are
  selection metadata: editing them never changes what a host enforces,
  so the dialog itself is the confirmation (`edit-host-labels`,
  simple tier): it states the hosts that change before Save.
-->
<script lang="ts">
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Field from '#lib/components/ui/Field.svelte';
  import { updateHostLabels } from '#lib/api.js';
  import { labelEditImpact, labelFacets, MAX_APPLY_HOSTS, parseLabelEdit } from '#lib/host-fleet.js';
  import { toast } from '#lib/stores/toast.js';

  type LabelHost = { id: string; name: string; labels?: Record<string, string> | null };

  let {
    open = false,
    projectId,
    hosts,
    onclose,
    onsaved,
  }: {
    open?: boolean;
    projectId: string;
    /** The hosts to edit (one for the host page). */
    hosts: readonly LabelHost[];
    onclose: () => void;
    onsaved?: (updated: { id: string; name: string; labels: Record<string, string> }[]) => void;
  } = $props();

  let setText = $state('');
  let removeText = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let tried = $state(false);
  let modal = $state<ReturnType<typeof Modal>>();

  let wasOpen = false;
  $effect.pre(() => {
    if (open && !wasOpen) {
      setText = '';
      removeText = '';
      error = null;
      tried = false;
    }
    wasOpen = open;
  });

  const single = $derived(hosts.length === 1 ? hosts[0] : null);
  const facets = $derived(labelFacets(hosts.map((h) => ({ labels: h.labels ?? {} }))));
  const edit = $derived(parseLabelEdit(setText, removeText));
  const impact = $derived(labelEditImpact(hosts, edit));
  const empty = $derived(!Object.keys(edit.set).length && !edit.remove.length);
  const tooMany = $derived(hosts.length > MAX_APPLY_HOSTS);
  const dirty = $derived(Boolean(setText.trim() || removeText.trim()));
  const problem = $derived(
    tooMany ? `Select at most ${MAX_APPLY_HOSTS.toLocaleString('en-US')} hosts per change.`
      : edit.errors.length ? edit.errors.join(' ')
      : impact.overLimit.length ? `A host can carry at most 32 labels; too many on ${impact.overLimit.slice(0, 5).join(', ')}${impact.overLimit.length > 5 ? ` and ${impact.overLimit.length - 5} more` : ''}.`
      : empty ? 'Enter labels to set or keys to remove.'
      : null,
  );

  function addRemoveKey(key: string) {
    const keys = removeText.split(/[,\s]+/).filter(Boolean);
    if (!keys.includes(key)) removeText = [...keys, key].join(', ');
  }

  async function save(event?: Event) {
    event?.preventDefault();
    tried = true;
    if (problem || busy) return;
    busy = true;
    error = null;
    const res = await updateHostLabels(projectId, {
      host_ids: hosts.map((h) => h.id),
      ...(Object.keys(edit.set).length ? { set: edit.set } : {}),
      ...(edit.remove.length ? { remove: edit.remove } : {}),
    });
    busy = false;
    if (res.error || !res.data) {
      const err = res.error;
      if (err?.code === 'TOO_MANY_LABELS' && err.host_ids?.length) {
        const names = err.host_ids.map((id) => hosts.find((h) => h.id === id)?.name ?? id);
        error = `${err.error} Hosts: ${names.slice(0, 10).join(', ')}${names.length > 10 ? '…' : ''}.`;
      } else if (err?.code === 'HOST_NOT_FOUND') {
        error = 'One of the hosts no longer exists in this project; nothing was changed. Refresh the list and try again.';
      } else {
        error = err?.error ?? 'The labels were not saved.';
      }
      return;
    }
    const { updated, unchanged } = res.data;
    toast.success(`Labels updated on ${updated} ${updated === 1 ? 'host' : 'hosts'}${unchanged ? `, ${unchanged} unchanged` : ''}.`, 'Labels saved');
    onsaved?.(res.data.hosts ?? []);
    onclose();
  }
</script>

<Modal
  bind:this={modal}
  {open}
  title={single ? `Edit labels of ${single.name}` : `Edit labels of ${hosts.length} hosts`}
  size="lg"
  placement="top"
  minHeight="28rem"
  {dirty}
  dismissible={!busy}
  {onclose}
>
  <form id="host-labels-form" class="hl" onsubmit={save} novalidate>
    <p class="hl-lead">Labels select hosts for filters and bulk actions. They never change what a host enforces.</p>

    {#if facets.length}
      <div class="hl-current">
        <p class="hl-sub">{single ? 'Current labels' : 'Labels on the selected hosts'} (choose one to remove its key)</p>
        <ul class="hl-chips">
          {#each facets as f (`${f.key}=${f.value}`)}
            <li>
              <button type="button" class="hl-chip" onclick={() => addRemoveKey(f.key)} aria-label={`Remove key ${f.key}`} disabled={busy}>
                {f.key}={f.value}{#if !single}<span class="hl-n"> · {f.count} of {hosts.length}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="hl-sub">{single ? 'This host has no labels yet.' : 'None of the selected hosts has labels yet.'}</p>
    {/if}

    <Field label="Set labels" optional hint="key=value pairs separated by commas, e.g. env=prod, team=edge. An existing key gets the new value.">
      {#snippet children(c)}
        <input {...c} class="hl-input" type="text" bind:value={setText} autocomplete="off" disabled={busy} data-autofocus />
      {/snippet}
    </Field>
    <Field label="Remove keys" optional hint="Keys separated by commas, e.g. old, temp.">
      {#snippet children(c)}
        <input {...c} class="hl-input" type="text" bind:value={removeText} autocomplete="off" disabled={busy} />
      {/snippet}
    </Field>

    {#if problem && (tried || (dirty && !empty))}
      <Alert tone="warning" compact message={problem} />
    {:else if !empty}
      <p class="hl-impact" aria-live="polite">
        Changes {impact.changed} of {hosts.length} {hosts.length === 1 ? 'host' : 'hosts'}{impact.unchanged ? `; ${impact.unchanged} already match` : ''}.
      </p>
    {/if}
    {#if error}<Alert tone="error" compact title="Labels not saved" message={error} />{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" disabled={busy} onclick={() => modal?.requestClose()}>Cancel</Button>
    <Button variant="primary" type="submit" form="host-labels-form" loading={busy} disabled={Boolean(problem)}>Save labels</Button>
  {/snippet}
</Modal>

<style>
  .hl { display: grid; gap: var(--sp-4); }
  .hl-lead { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .hl-sub { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
  .hl-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
  .hl-chip {
    padding: 0 var(--sp-2);
    min-height: 24px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-card);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .hl-chip:hover { color: var(--text-primary); background: var(--bg-hover); }
  .hl-chip:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .hl-n { color: var(--text-muted); font-family: var(--font-sans, inherit); }
  .hl-input {
    box-sizing: border-box;
    width: 100%;
    min-height: 36px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-input);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .hl-input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .hl-impact { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
</style>
