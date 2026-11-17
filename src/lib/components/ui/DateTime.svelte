<!--
  DateTime: one timestamp, rendered the same way everywhere. The API sends
  UTC; this shows the browser's local date/time in its locale ("27 Sep 2026,
  21:49"), optionally followed by a muted relative hint ("5 min ago"). The
  exact UTC instant is the <time datetime> value and the tooltip. Small by
  design (--fs-sm): a date is supporting detail, never the headline.

    <DateTime value={row.created_at} />
    <DateTime value={agent.last_seen} relative fallback="Never" />
    <DateTime value={event.ts} format="time" seconds epochUnit="s" />
-->
<script lang="ts">
  import { EMPTY, formatDateTime, formatRelative, toISO, type DateTimeFormat, type ParseTimestampOptions, type TimestampInput } from '#lib/format.js';

  let {
    value,
    relative = false,
    format = 'datetime',
    seconds = false,
    epochUnit = undefined,
    now = undefined,
    fallback = EMPTY,
    class: className = undefined
  }: {
    /** RFC 3339 string, epoch seconds/milliseconds or a Date. */
    value: TimestampInput;
    /** Append a muted relative hint ("5 min ago", "in 3 d"). */
    relative?: boolean;
    /** 'datetime' (default), 'date' or 'time'. */
    format?: DateTimeFormat;
    /** Include seconds in the time of day. */
    seconds?: boolean;
    epochUnit?: ParseTimestampOptions['epochUnit'];
    /** Reference time for the relative hint; pass a ticking value to keep it live. */
    now?: TimestampInput;
    /** Text for an empty, zero or invalid value. */
    fallback?: string;
    class?: string;
  } = $props();

  const iso = $derived(toISO(value, { epochUnit }));
  const text = $derived(formatDateTime(value, { format, seconds, epochUnit }));
  const hint = $derived(relative && iso ? formatRelative(value, now ?? Date.now(), { epochUnit }) : '');
</script>

{#if iso}
  <time class={['dt', className]} datetime={iso} title={iso}>{text}{#if hint}<span class="dt-rel">{` (${hint})`}</span>{/if}</time>
{:else}
  <span class={['dt', 'dt-empty', className]}>{fallback}</span>
{/if}

<style>
  .dt {
    /* Never larger than the surrounding text, never above --fs-sm. */
    font-size: min(1em, var(--fs-sm, 0.8125rem));
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .dt-rel,
  .dt-empty {
    color: var(--text-muted);
  }
</style>
