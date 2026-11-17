<!--
  ProxyWarningBadge: small list indicator for an app's proxy_warnings
  (TRUSTED_PROXIES_UNSET, TRUSTED_PROXIES_IGNORED). Renders nothing
  without warnings; the messages are in the title and the accessible name.
-->
<script lang="ts">
  import type { ProxyWarning } from '#lib/api.js';
  import { Badge } from '#lib/components/ui/index.js';
  import { configWarningTone } from '#lib/tone.js';

  let { warnings = undefined }: { warnings?: ProxyWarning[] | null } = $props();

  const list = $derived((warnings ?? []).filter((w) => w && typeof w.message === 'string'));
  const text = $derived(list.map((w) => w.message).join(' '));
</script>

{#if list.length}
  <span class="pw"><Badge tone={configWarningTone(list[0].code)} title={text}>Review proxy trust</Badge><span class="sr-only">: {text}</span></span>
{/if}

<style>
  .pw { display: inline-flex; margin-left: var(--sp-2); vertical-align: middle; }
</style>
