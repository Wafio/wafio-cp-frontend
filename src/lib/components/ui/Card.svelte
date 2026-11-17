<script lang="ts">
  let {
    title = undefined,
    header = undefined,
    children = undefined,
    footer = undefined
  }: {
    title?: string;
    header?: import('svelte').Snippet;
    children?: import('svelte').Snippet;
    footer?: import('svelte').Snippet;
  } = $props();
</script>

<section class="card">
  {#if header}
    <div class="card-header">{@render header()}</div>
  {:else if title}
    <div class="card-header"><h3>{title}</h3></div>
  {/if}
  <div class="card-body">{@render children?.()}</div>
  {#if footer}<div class="card-footer">{@render footer()}</div>{/if}
</section>

<style>
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: none; padding: 0; overflow: hidden; }
  .card-header { padding: var(--sp-4); border-bottom: 1px solid var(--border); }
  .card-header h3 { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .card-body { padding: var(--sp-4); }
  .card-footer { padding: var(--sp-4); border-top: 1px solid var(--border); }
</style>
