<!--
  BrandLogo: the WAFio mark (the portal's logo-only.png) and the wordmark as text. The mark is decorative (empty alt)
  because the wordmark names it, and it has a width and height so the header does not move while it loads. The file
  has its own dark outline and light rim, so it reads on the light and the dark surface; the wordmark takes the text
  colour of the theme.
-->
<script lang="ts">
  import { base } from '#lib/paths.js';

  let { size = 34 }: { size?: number } = $props();

  // logo-only.png is 228 x 240.
  const width = $derived(Math.round((size * 228) / 240));
</script>

<span class="brand" style:--brand-size={`${size}px`}>
  <img class="mark" src="{base}/logo-only.png" alt="" {width} height={size} />
  <span class="word">WAFio</span>
</span>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--brand-size) * 0.26);
    line-height: 1;
  }
  .mark {
    display: block;
    flex-shrink: 0;
    height: var(--brand-size);
    width: auto;
  }
  .word {
    font-size: calc(var(--brand-size) * 0.62);
    font-weight: var(--fw-bold);
    letter-spacing: -0.01em;
    white-space: nowrap;
    color: var(--text-primary);
  }
</style>
