<!--
  PartStatus: the one line under a setting of the Speed tab, the main host name and the path prefix: whether the WAF
  agent applies it. The region is always there and polite, so a change from waiting to in use is announced; the
  alert inside carries no live role of its own. Nothing is drawn without a line.
-->
<script lang="ts">
  import { Alert } from '#lib/components/ui/index.js';
  import type { PartLine } from './speed';

  let { line = null }: { line?: PartLine | null } = $props();
</script>

<div class="part-status" aria-live="polite" aria-atomic="true">
  {#if line}
    <Alert compact tone={line.tone} role="none">
      <p>{line.more ? `${line.text} ${line.more}` : line.text}</p>
    </Alert>
  {/if}
</div>

<style>
  .part-status :global(p) { margin: 0; }
</style>
