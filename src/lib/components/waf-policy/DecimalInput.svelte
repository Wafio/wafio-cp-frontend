<!--
  DecimalInput: a number field that always shows a decimal point. A number input shows the decimal separator of the
  browser's language ("2,5"), so this is a text field with a decimal keypad on phones. `value` is a number, null when
  the field is empty, and NaN while the text is not a number (validation then reports it next to the field). A typed
  comma is read as a decimal point and shown as one when the field loses focus.

    <DecimalInput bind:value={s.block} id="wp-sql-block" placeholder="4" aria-label="SQL injection block threshold" />
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { formatDecimal, parseDecimal } from './decimal';

  let {
    value = $bindable(null),
    id,
    placeholder = undefined,
    disabled = false,
    'aria-label': ariaLabel = undefined,
    'aria-describedby': describedby = undefined,
    'aria-invalid': invalid = undefined
  }: {
    value?: number | null;
    id: string;
    placeholder?: string;
    disabled?: boolean;
    'aria-label'?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: 'true' | undefined;
  } = $props();

  let text = $state(untrack(() => formatDecimal(value)));

  // Follow outside changes (reset, discard) without rewriting what the person is typing.
  $effect.pre(() => {
    const next = value;
    untrack(() => {
      const typed = parseDecimal(text);
      const same = typed === undefined ? Number.isNaN(next) : typed === next;
      if (!same) text = formatDecimal(next);
    });
  });

  function oninput(event: Event) {
    text = (event.currentTarget as HTMLInputElement).value;
    const typed = parseDecimal(text);
    value = typed === undefined ? Number.NaN : typed;
  }

  function onblur() {
    const typed = parseDecimal(text);
    if (typeof typed === 'number') text = formatDecimal(typed);
  }
</script>

<input
  {id}
  type="text"
  inputmode="decimal"
  autocomplete="off"
  spellcheck="false"
  value={text}
  {oninput}
  {onblur}
  {placeholder}
  {disabled}
  aria-label={ariaLabel}
  aria-describedby={describedby}
  aria-invalid={invalid}
/>
