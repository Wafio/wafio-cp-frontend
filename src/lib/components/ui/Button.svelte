<!--
  Button: a <button>, or an <a> when `href` is set. Every other attribute
  (class, id, aria-expanded, aria-controls, aria-pressed, data-*, form, …)
  is passed through to the element.
  A disabled or loading link is not executable: no tab stop, click prevented.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import Spinner from './Spinner.svelte';

  type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'warning';

  interface OwnProps {
    variant?: Variant;
    size?: 'sm' | 'md';
    type?: 'button' | 'submit' | 'reset';
    href?: string;
    loading?: boolean;
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    title?: string;
    'aria-label'?: string;
    'aria-expanded'?: boolean | 'true' | 'false';
    'aria-controls'?: string;
    'aria-pressed'?: boolean | 'true' | 'false' | 'mixed';
    class?: string;
    children?: Snippet;
  }

  type PassThrough = Omit<HTMLButtonAttributes & HTMLAnchorAttributes, keyof OwnProps>;

  let {
    variant = 'primary',
    size = 'md',
    type = 'button',
    href = undefined,
    loading = false,
    disabled = false,
    onclick = undefined,
    class: className = undefined,
    children = undefined,
    ...rest
  }: OwnProps & PassThrough = $props();

  const inactive = $derived(disabled || loading);
  const classes = $derived(['btn', `btn-${variant}`, `size-${size}`, loading && 'is-loading', className]);
</script>

{#if href}
  <a
    {...rest as HTMLAnchorAttributes}
    href={inactive ? undefined : href}
    role={inactive ? 'link' : undefined}
    class={classes}
    aria-disabled={inactive ? 'true' : undefined}
    aria-busy={loading || undefined}
    tabindex={inactive ? -1 : rest.tabindex}
    onclick={(event) => {
      if (inactive) event.preventDefault();
      else onclick?.(event);
    }}
  >
    {#if loading}<Spinner size="sm" />{/if}
    {@render children?.()}
  </a>
{:else}
  <button
    {...rest as HTMLButtonAttributes}
    {type}
    class={classes}
    disabled={inactive}
    aria-busy={loading || undefined}
    {onclick}
  >
    {#if loading}<Spinner size="sm" />{/if}
    {@render children?.()}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    border-radius: var(--radius);
    font-size: var(--fs-base);
    font-weight: var(--fw-medium);
    line-height: 1.4;
    cursor: pointer;
    border: 1px solid transparent;
    padding: var(--sp-2) var(--sp-4);
    text-decoration: none;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .btn:hover { text-decoration: none; }
  .btn:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn.is-loading { pointer-events: none; }
  .btn[aria-disabled='true'] { opacity: 0.55; pointer-events: none; cursor: not-allowed; }

  .btn-primary { background: var(--accent); color: var(--text-on-accent); }
  .btn-primary:hover:not(:disabled) { background: var(--accent-dim); color: var(--text-on-accent); }

  .btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); border-color: var(--border-strong); }
  .btn-secondary:hover:not(:disabled) { background: var(--surface-2); color: var(--text-primary); }

  .btn-outline { background: transparent; color: var(--text-primary); border-color: var(--border-strong); }
  .btn-outline:hover:not(:disabled) { background: var(--accent-soft); color: var(--text-primary); }

  .btn-ghost { background: transparent; color: var(--text-secondary); }
  .btn-ghost:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }

  /* Danger: destructive buttons fill with --danger-solid, not --danger (the
     dark-theme --danger is a light text red). --text-on-danger is >= 4.5:1 on
     the fill and on --danger-solid-hover in both themes (contrast tests). */
  .btn-danger { background: var(--danger-solid); border-color: var(--danger-solid); color: var(--text-on-danger); }
  .btn-danger:hover:not(:disabled) {
    background: var(--danger-solid-hover);
    border-color: var(--danger-solid-hover);
    color: var(--text-on-danger);
  }

  /* Warning: neutral text on a tinted surface; the amber border and the
     button's own label carry the meaning, so contrast never depends on the
     amber fill. */
  .btn-warning {
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    border-color: var(--warning);
    color: var(--text-primary);
  }
  .btn-warning:hover:not(:disabled) { background: color-mix(in srgb, var(--warning) 24%, transparent); color: var(--text-primary); }

  .btn.size-sm { padding: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); }
</style>
