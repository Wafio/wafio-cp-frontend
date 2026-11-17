<script lang="ts">
  import { auth } from '#lib/stores/auth.js';

  // The root layout's sign-in gate sends signed-out visitors to /login?next=…
  // before this renders.
  let { children } = $props();
</script>

{#if !$auth.inited}
  <p class="loading">Loading workspace…</p>
{:else if $auth.user}
  {@render children()}
{/if}

<style>
  .loading {
    text-align: center;
    color: var(--text-muted);
    padding: 2rem;
  }
</style>
