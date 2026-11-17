<!--
  ToastContainer: transient notifications.

  One permanent, visually hidden live region announces each new toast; the
  cards themselves carry no live role, so a screen reader hears a toast even
  though its card is created with the text. Timers (ToastTimers) pause while a
  card is hovered or focused and resume with the time left; error toasts have
  no timer and stay until dismissed.
-->
<script lang="ts">
  import { toast } from '#lib/stores/toast.js';
  import { ToastTimers, type PauseReason } from '#lib/toast-timers.js';
  import { onDestroy, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { fly } from 'svelte/transition';

  const MAX_VISIBLE = 5;

  const timers = new ToastTimers((id) => toast.dismiss(id));
  const paused = new SvelteSet<string>();

  // Every queued toast gets its timer (even ones hidden by the visibility
  // cap), so the store never accumulates stale entries. sync() arms only new
  // toasts; it never re-arms a paused one.
  $effect(() => {
    timers.sync($toast);
  });

  const visible = $derived($toast.slice(-MAX_VISIBLE));

  // ── Announcements: one permanent region, new toasts only ──
  let announcement = $state('');
  const announced = new Set<string>();
  $effect(() => {
    const ids = new Set($toast.map((item) => item.id));
    for (const id of announced) if (!ids.has(id)) announced.delete(id);
    const fresh = $toast.filter((item) => !announced.has(item.id));
    if (fresh.length === 0) return;
    for (const item of fresh) announced.add(item.id);
    const text = fresh.map((item) => (item.message ? `${item.title}: ${item.message}` : item.title)).join('. ');
    // Clear first so the same text twice is announced twice.
    announcement = '';
    void tick().then(() => (announcement = text));
  });

  function pause(id: string, reason: PauseReason) {
    timers.pause(id, reason);
    if (timers.isPaused(id)) paused.add(id);
  }

  function resume(id: string, reason: PauseReason) {
    timers.resume(id, reason);
    if (!timers.isPaused(id)) paused.delete(id);
  }

  function onFocusOut(event: FocusEvent, id: string) {
    const card = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
    resume(id, 'focus');
  }

  function handleDismiss(id: string) {
    timers.forget(id);
    paused.delete(id);
    toast.dismiss(id);
  }

  onDestroy(() => timers.dispose());
</script>

<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

<div class="toast-viewport" aria-label="Notifications">
  {#each visible as item (item.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      transition:fly={{ y: -10, duration: 190 }}
      class="toast-card toast-{item.type}"
      class:is-paused={paused.has(item.id)}
      onmouseenter={() => pause(item.id, 'hover')}
      onmouseleave={() => resume(item.id, 'hover')}
      onfocusin={() => pause(item.id, 'focus')}
      onfocusout={(event) => onFocusOut(event, item.id)}
    >
      <div class="toast-badge" aria-hidden="true">
        {#if item.type === 'success'}
          <span>✓</span>
        {:else if item.type === 'error'}
          <span>!</span>
        {:else if item.type === 'warning'}
          <span>⚠</span>
        {:else}
          <span>ℹ</span>
        {/if}
      </div>

      <div class="toast-body">
        <strong class="toast-title">{item.title}</strong>
        {#if item.message}
          <p class="toast-message">{item.message}</p>
        {/if}
      </div>

      <button
        type="button"
        class="toast-close"
        onclick={() => handleDismiss(item.id)}
        aria-label={`Dismiss notification: ${item.title}`}
      >
        ×
      </button>

      {#if item.duration > 0}
        <div
          class="toast-progress"
          style="animation-duration: {item.duration}ms;"
        ></div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toast-viewport {
    position: fixed;
    top: 1.25rem;
    right: 1.25rem;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    pointer-events: none;
    width: min(420px, calc(100vw - 2.5rem));
  }

  .toast-card {
    pointer-events: auto;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    padding: 0.875rem 1rem 1rem 1rem;
    background: var(--bg-elevated);
    border: 1px solid var(--toast-border, var(--border-soft));
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }

  .toast-card.is-paused .toast-progress {
    animation-play-state: paused;
  }

  .toast-success {
    --toast-accent: var(--success);
    --toast-border: color-mix(in srgb, var(--success) 40%, transparent);
    --toast-glow: var(--success-tint);
  }

  .toast-error {
    --toast-accent: var(--danger);
    --toast-border: color-mix(in srgb, var(--danger) 45%, transparent);
    --toast-glow: var(--danger-tint);
  }

  .toast-warning {
    --toast-accent: var(--warning);
    --toast-border: color-mix(in srgb, var(--warning) 40%, transparent);
    --toast-glow: var(--warning-tint);
  }

  .toast-info {
    --toast-accent: var(--info);
    --toast-border: color-mix(in srgb, var(--info) 40%, transparent);
    --toast-glow: var(--info-tint);
  }

  .toast-badge {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9375rem;
    font-weight: 700;
    background: var(--toast-glow);
    color: var(--toast-accent);
    border: 1px solid var(--toast-border);
    margin-top: 2px;
  }

  .toast-body {
    flex: 1;
    min-width: 0;
  }

  .toast-title {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.35;
    margin-bottom: 2px;
  }

  .toast-message {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.45;
    word-break: break-word;
  }

  .toast-close {
    flex-shrink: 0;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 1.25rem;
    line-height: 1;
    padding: 2px 4px;
    margin: -2px -4px 0 0;
    cursor: pointer;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }

  .toast-close:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .toast-progress {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: var(--toast-accent);
    transform-origin: left;
    animation: toast-timer linear forwards;
  }

  @keyframes toast-timer {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }
</style>
