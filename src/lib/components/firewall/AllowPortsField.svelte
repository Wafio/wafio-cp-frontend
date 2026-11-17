<!--
  AllowPortsField: Ports of an allowlist add.
  "All ports" (default) keeps today's full bypass; "Specific ports" scopes the
  entry to TCP/UDP ports typed as "22/tcp, 5432/tcp, 8000-8100/udp, 53/any"
  or picked from presets (the host's SSH ports first). Validation mirrors the
  server (parsePortScopes). Hosts that do not enforce scoped entries keep the
  field on "All ports".
-->
<script lang="ts">
  import './controls.css';
  import Field from '#lib/components/ui/Field.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import { allowPortPresets, allowPortsLabel, hasPortToken, parsePortScopes, togglePortToken } from './rules';

  let {
    mode = $bindable<'all' | 'ports'>('all'),
    text = $bindable(''),
    sshPorts = null,
    supported = true,
    disabled = false,
  }: {
    mode?: 'all' | 'ports';
    text?: string;
    /** sshd ports the host reported (host_info.ssh_ports); empty = 22. */
    sshPorts?: readonly number[] | null;
    /** The host enforces port-scoped allowlist entries (allowlist_ports_supported). */
    supported?: boolean;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  const presets = $derived(allowPortPresets(sshPorts));
  const parsed = $derived(parsePortScopes(text));
  /** Shown once something was typed, so an empty field is not red on open. */
  const error = $derived(mode === 'ports' && supported && text.trim() ? parsed.error : null);

  /* Support can disappear while the drawer is open (a status poll). The
   * chosen ports are kept and the drawer refuses to submit them; switching
   * to all ports silently would widen the entry. */
</script>

<div class="apf">
  <Field label="Ports" group>
    {#snippet children()}
      <div class="fw-segmented">
        <label>
          <input type="radio" name={`${uid}-mode`} value="all" bind:group={mode} {disabled} />
          All ports
        </label>
        <label>
          <input type="radio" name={`${uid}-mode`} value="ports" bind:group={mode} disabled={disabled || !supported} />
          Specific ports
        </label>
      </div>
    {/snippet}
  </Field>

  {#if !supported && mode === 'ports'}
    <Alert tone="error" compact message="This host no longer reports port-scoped allowlist entries, so these ports cannot be sent. Choose All ports to allow every port, or update the host agent together with its eBPF objects." />
  {:else if !supported}
    <Alert tone="info" compact message="This host cannot scope allowlist entries to ports yet: update the host agent together with its eBPF objects. Until then entries apply to all ports." />
  {/if}

  {#if mode === 'all'}
    <Alert tone="warning" compact title="All ports" message="Bypasses geo, blocklist, port rules and rate limits on every port (ICMP included)." />
  {:else}
    <div class="apf-presets" role="group" aria-label="Port presets">
      {#each presets as preset (preset.token)}
        {@const on = hasPortToken(text, preset.token)}
        <button type="button" class="apf-chip" aria-pressed={on} {disabled} onclick={() => (text = togglePortToken(text, preset.token))}>
          {preset.label}
        </button>
      {/each}
    </div>
    <Field label="Port scopes" hint="Comma-separated, each with a protocol: 22/tcp, 5432/tcp, 8000-8100/udp, 53/any (any = TCP and UDP). At most 8 after merging." {error}>
      {#snippet children(control)}
        <input {...control} class="fw-input fw-mono" type="text" bind:value={text} {disabled} spellcheck="false" autocomplete="off" placeholder="22/tcp, 5432/tcp" />
      {/snippet}
    </Field>
    {#if !parsed.error}
      <p class="apf-preview" aria-live="polite">Applies to <strong>{allowPortsLabel(parsed.scopes)}</strong>; other ports and ICMP meet the normal checks.</p>
    {/if}
  {/if}

  <p class="apf-hint">To restrict a port to listed sources, deny the port (port DROP rule or Deny all), then add scoped entries.</p>
</div>

<style>
  .apf { display: grid; gap: var(--sp-3); min-width: 0; }
  .apf-presets { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .apf-chip {
    min-height: 32px;
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-card);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .apf-chip[aria-pressed='true'] { background: var(--accent-soft); color: var(--text-primary); font-weight: var(--fw-medium); }
  .apf-chip:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .apf-chip:disabled { cursor: not-allowed; opacity: 0.6; }
  .apf-preview, .apf-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .apf-preview strong { color: var(--text-primary); font-family: var(--font-mono); font-weight: var(--fw-medium); overflow-wrap: anywhere; }
</style>
