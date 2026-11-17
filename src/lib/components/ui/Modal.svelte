<!--
  Modal: native <dialog> opened with showModal(): the page behind is inert,
  focus stays inside, Escape asks to close, and focus returns to the element
  that opened it. The parent owns `open`; close requests call `onclose`.

  Dirty guard: with `dirty` set, Escape and the × button ask "Discard unsaved
  changes?" first (unless `guardDirty` is false) and a backdrop click never
  closes. `ondiscard` runs before `onclose` when the user discards.
  Parents can route their own Cancel button through the same guard with
  `bind:this={modal}` and `modal.requestClose()`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { untrack } from 'svelte';
  import Button from './Button.svelte';
  import { decideClose, focusInitial, isOutsideRect, type CloseSource } from './dialog';

  interface Props {
    open?: boolean;
    title?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
    maxWidth?: string;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
    /** Id of the element that names the dialog when `title` is not used.
     *  Without either, the first heading in the body names it. */
    labelledby?: string;
    describedby?: string;
    'aria-label'?: string;
    /** `alertdialog` for confirmations that interrupt the user. */
    role?: 'dialog' | 'alertdialog';
    /** The dialog holds unsaved input. */
    dirty?: boolean;
    /** Ask before discarding dirty input (Escape, ×, requestClose). */
    guardDirty?: boolean;
    ondiscard?: () => void;
    discardTitle?: string;
    discardMessage?: string;
    discardLabel?: string;
    keepLabel?: string;
    /** false keeps the dialog open on Escape, ×, and backdrop (e.g. while saving). */
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
    /** Show the × button in the title row (default true). */
    showClose?: boolean;
    /** CSS selector of the element to focus first (default: [data-autofocus],
     *  then the first focusable element of the body). */
    initialFocus?: string;
    /** Header/footer divider lines (default true). */
    divided?: boolean;
    /** Side sheet placement (used by Drawer). `top` anchors the dialog near
     *  the top of the viewport, so step flows whose content grows do not move
     *  their title or buttons. */
    placement?: 'center' | 'top' | 'right' | 'left';
    /** Minimum dialog height (CSS length; capped at the viewport) so the
     *  footer of a growing dialog stays where it is. */
    minHeight?: string;
    class?: string;
  }

  let {
    open = false,
    title = undefined,
    size = 'md',
    maxWidth = undefined,
    onclose = undefined,
    children = undefined,
    footer = undefined,
    labelledby = undefined,
    describedby = undefined,
    'aria-label': ariaLabel = undefined,
    role = 'dialog',
    dirty = false,
    guardDirty = true,
    ondiscard = undefined,
    discardTitle = 'Discard unsaved changes?',
    discardMessage = 'The changes in this dialog have not been saved and will be lost.',
    discardLabel = 'Discard changes',
    keepLabel = 'Keep editing',
    dismissible = true,
    closeOnBackdrop = true,
    showClose = true,
    initialFocus = undefined,
    divided = true,
    placement = 'center',
    minHeight = undefined,
    class: className = undefined
  }: Props = $props();

  const uid = $props.id();
  const titleId = `${uid}-title`;
  const discardTitleId = `${uid}-discard-title`;
  const discardMessageId = `${uid}-discard-message`;

  let dialogEl = $state<HTMLDialogElement>();
  let bodyEl = $state<HTMLElement>();
  let discardEl = $state<HTMLDialogElement>();
  let headingLabel = $state<string | undefined>();
  let returnFocusEl: HTMLElement | null = null;
  let pointerDownOnBackdrop = false;

  const sizeWidthMap: Record<string, string> = {
    sm: '420px',
    md: '520px',
    lg: '700px',
    xl: '860px',
    '2xl': '1024px'
  };

  const resolvedMaxWidth = $derived(maxWidth ?? sizeWidthMap[size] ?? '520px');
  const resolvedLabelledby = $derived(title ? titleId : (labelledby ?? (ariaLabel ? undefined : headingLabel)));

  /** First heading of the body, used as the accessible name when none is given. */
  function labelFromHeading(): string | undefined {
    const heading = bodyEl?.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
    if (!heading) return undefined;
    if (!heading.id) heading.id = `${uid}-heading`;
    return heading.id;
  }

  function restoreFocus() {
    const target = returnFocusEl;
    returnFocusEl = null;
    if (!target || !target.isConnected) return;
    const active = document.activeElement;
    if (!active || active === document.body || dialogEl?.contains(active)) target.focus({ preventScroll: true });
  }

  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open) {
      if (el.open) return;
      untrack(() => {
        const active = document.activeElement;
        returnFocusEl = active instanceof HTMLElement && active !== document.body ? active : null;
        el.showModal();
        if (!title && !labelledby && !ariaLabel) headingLabel = labelFromHeading();
        focusInitial(el, bodyEl, initialFocus);
      });
    } else if (el.open) {
      untrack(() => {
        if (discardEl?.open) discardEl.close();
        el.close();
        restoreFocus();
      });
    }
  });

  // Unmounted while open (parent {#if} removed it): still hand focus back.
  $effect(() => () => {
    const el = dialogEl;
    if (el?.open) {
      if (el.isConnected) el.close();
      restoreFocus();
    }
  });

  /** Ask to close, applying the dismissible/dirty policy. */
  export function requestClose(source: CloseSource = 'close-button') {
    const decision = decideClose(source, { dismissible, dirty, guardDirty, closeOnBackdrop });
    if (decision === 'close') onclose?.();
    else if (decision === 'confirm-discard' && discardEl && !discardEl.open) discardEl.showModal();
  }

  function onCancel(event: Event) {
    event.preventDefault();
    requestClose('escape');
  }

  // Escape is handled here rather than through the browser's close request:
  // Chromium makes a repeated `cancel` non-cancelable without user activation
  // and groups dialogs opened without activation, which would close a dirty
  // dialog (or the dialog under the discard prompt) without asking. Stopping
  // propagation also keeps Escape away from window-level handlers of an
  // overlay underneath. A control that consumed Escape itself (preventDefault)
  // is respected.
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (discardEl?.open) keepEditing();
    else requestClose('escape');
  }

  // The browser may close a modal without a cancelable `cancel` event (repeated
  // Escape without user activation, or a <form method="dialog">). Keep the
  // parent's `open` authoritative: reopen, then treat it as a close request.
  function onNativeClose() {
    const el = dialogEl;
    if (!el || el.open || !open || !el.isConnected) return;
    el.showModal();
    requestClose('native');
  }

  function onPointerDown(event: PointerEvent) {
    pointerDownOnBackdrop =
      event.target === dialogEl && !!dialogEl && isOutsideRect(event.clientX, event.clientY, dialogEl.getBoundingClientRect());
  }

  function onClick(event: MouseEvent) {
    const el = dialogEl;
    const startedOnBackdrop = pointerDownOnBackdrop;
    pointerDownOnBackdrop = false;
    // A drag that starts inside (text selection) and ends outside is not a backdrop click.
    if (!el || event.target !== el || !startedOnBackdrop) return;
    if (isOutsideRect(event.clientX, event.clientY, el.getBoundingClientRect())) requestClose('backdrop');
  }

  function keepEditing() {
    discardEl?.close();
  }

  function discard() {
    discardEl?.close();
    ondiscard?.();
    onclose?.();
  }
</script>

<dialog
  bind:this={dialogEl}
  class={['ui-modal', `placement-${placement}`, !divided && 'is-plain', className]}
  style:--modal-max-width={resolvedMaxWidth}
  style:--modal-min-height={minHeight}
  {role}
  aria-labelledby={resolvedLabelledby}
  aria-label={resolvedLabelledby ? undefined : ariaLabel}
  aria-describedby={describedby}
  tabindex="-1"
  oncancel={onCancel}
  onclose={onNativeClose}
  onkeydown={onKeydown}
  onpointerdown={onPointerDown}
  onclick={onClick}
>
  {#if open}
    {#if title}
      <div class="modal-header">
        <h2 id={titleId}>{title}</h2>
        {#if showClose}
          <button type="button" class="modal-x" onclick={() => requestClose('close-button')} aria-label="Close" disabled={!dismissible}>
            <span aria-hidden="true">×</span>
          </button>
        {/if}
      </div>
    {/if}
    <div class="modal-body" bind:this={bodyEl}>{@render children?.()}</div>
    {#if footer}<div class="modal-footer">{@render footer()}</div>{/if}
  {/if}

  {#if guardDirty && dirty}
    <dialog
      bind:this={discardEl}
      class="modal-discard"
      role="alertdialog"
      aria-labelledby={discardTitleId}
      aria-describedby={discardMessageId}
      oncancel={(event) => { event.preventDefault(); keepEditing(); }}
    >
      <h2 id={discardTitleId} class="discard-title">{discardTitle}</h2>
      <p id={discardMessageId} class="discard-message">{discardMessage}</p>
      <div class="discard-actions">
        <Button variant="secondary" data-autofocus="" onclick={keepEditing}>{keepLabel}</Button>
        <Button variant="danger" onclick={discard}>{discardLabel}</Button>
      </div>
    </dialog>
  {/if}
</dialog>

<style>
  :global(html:has(dialog.ui-modal[open])) { overflow: hidden; }

  .ui-modal::backdrop { background: var(--overlay); }
  .ui-modal {
    padding: 0;
    color: var(--text-primary);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    width: min(var(--modal-max-width, 520px), calc(100vw - 2 * var(--sp-4)));
    max-width: var(--modal-max-width, 520px);
    max-height: 90vh;
    max-height: 90dvh;
  }
  .ui-modal:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .ui-modal[open] {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: ui-modal-in 0.16s ease-out;
  }
  @keyframes ui-modal-in {
    from { opacity: 0; transform: translateY(6px); }
  }

  /* Anchored near the top: growing content extends downwards only. */
  .ui-modal.placement-top {
    --modal-top: min(8vh, 4rem);
    margin: var(--modal-top) auto auto;
    max-height: calc(100vh - 2 * var(--modal-top));
    max-height: calc(100dvh - 2 * var(--modal-top));
    min-height: min(var(--modal-min-height, 0px), calc(100dvh - 2 * var(--modal-top)));
  }

  /* Side sheet (Drawer). */
  .ui-modal.placement-right,
  .ui-modal.placement-left {
    margin: 0;
    top: 0;
    bottom: 0;
    height: 100vh;
    height: 100dvh;
    max-height: none;
    width: min(var(--modal-max-width, 560px), 100vw);
    border-radius: 0;
  }
  .ui-modal.placement-right { left: auto; right: 0; border-width: 0 0 0 1px; }
  .ui-modal.placement-left { left: 0; right: auto; border-width: 0 1px 0 0; }
  .ui-modal.placement-right[open],
  .ui-modal.placement-left[open] { animation: none; }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-4);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg-card);
  }
  .modal-header h2 {
    margin: 0;
    font-size: var(--fs-md);
    font-weight: var(--fw-semibold);
    line-height: 1.35;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .modal-x {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: var(--fs-lg);
    line-height: 1;
    cursor: pointer;
    border-radius: var(--radius);
    transition: color 0.15s, background 0.15s;
  }
  .modal-x:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
  .modal-x:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .modal-x:disabled { opacity: 0.45; cursor: not-allowed; }

  .modal-body {
    padding: var(--sp-4);
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .modal-body::-webkit-scrollbar { width: 6px; }
  .modal-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: var(--radius); }

  .modal-footer {
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--sp-2);
    flex-shrink: 0;
    background: var(--bg-card);
  }

  .is-plain .modal-header,
  .is-plain .modal-footer { border: 0; }
  .is-plain .modal-footer { padding-top: 0; padding-bottom: var(--sp-4); }

  .modal-discard {
    padding: var(--sp-5);
    width: min(400px, calc(100vw - 2 * var(--sp-4)));
    color: var(--text-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .modal-discard::backdrop { background: var(--overlay); }
  .discard-title { margin: 0 0 var(--sp-2); font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .discard-message { margin: 0; color: var(--text-secondary); font-size: var(--fs-base); line-height: 1.55; }
  .discard-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-5); }

  @media (max-width: 520px) {
    .modal-footer { flex-direction: column-reverse; align-items: stretch; }
    .discard-actions { flex-direction: column-reverse; align-items: stretch; }
  }
</style>
