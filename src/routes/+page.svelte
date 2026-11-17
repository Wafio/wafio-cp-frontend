<script lang="ts">
  import { goto } from '#lib/paths.js';
  import { auth } from '#lib/stores/auth.js';

  $effect(() => {
    if (!$auth.inited) return;
    void goto($auth.user ? '/projects' : '/login', { replace: true });
  });
</script>

<p class="redirect" role="status">Loading…</p>

<style>
  .redirect { text-align: center; color: var(--text-muted); padding: var(--sp-6); font-size: var(--fs-sm); }
</style>
