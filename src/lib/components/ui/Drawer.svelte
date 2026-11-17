<!--
  Drawer: side sheet on the native Modal: same focus containment, Escape,
  focus return and dirty guard; full height at the right (or left) edge.
  Use for detail views (a decision, an event) and editors that keep the list
  visible in context. `requestClose()` is forwarded for custom Cancel buttons.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Modal from './Modal.svelte';
  import type { CloseSource } from './dialog';

  interface Props {
    open?: boolean;
    title?: string;
    onclose?: () => void;
    side?: 'right' | 'left';
    /** Width preset: sm 420px, md 560px, lg 760px, xl 960px. */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** Explicit CSS width; overrides `size`. */
    width?: string;
    labelledby?: string;
    describedby?: string;
    'aria-label'?: string;
    dirty?: boolean;
    guardDirty?: boolean;
    ondiscard?: () => void;
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
    initialFocus?: string;
    class?: string;
    children?: Snippet;
    footer?: Snippet;
  }

  let {
    open = false,
    title = undefined,
    onclose = undefined,
    side = 'right',
    size = 'md',
    width = undefined,
    labelledby = undefined,
    describedby = undefined,
    'aria-label': ariaLabel = undefined,
    dirty = false,
    guardDirty = true,
    ondiscard = undefined,
    dismissible = true,
    closeOnBackdrop = true,
    initialFocus = undefined,
    class: className = undefined,
    children = undefined,
    footer = undefined
  }: Props = $props();

  const widths = { sm: '420px', md: '560px', lg: '760px', xl: '960px' };

  let modal = $state<ReturnType<typeof Modal>>();

  export function requestClose(source: CloseSource = 'close-button') {
    modal?.requestClose(source);
  }
</script>

<Modal
  bind:this={modal}
  {open}
  {title}
  {onclose}
  placement={side}
  maxWidth={width ?? widths[size]}
  {labelledby}
  {describedby}
  aria-label={ariaLabel}
  {dirty}
  {guardDirty}
  {ondiscard}
  {dismissible}
  {closeOnBackdrop}
  {initialFocus}
  class={['ui-drawer', className].filter(Boolean).join(' ')}
  {children}
  {footer}
/>
