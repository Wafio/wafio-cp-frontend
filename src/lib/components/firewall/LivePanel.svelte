<!--
  LivePanel: the Firewall "Live" tab: packet events, tracked
  connections and per-address bandwidth. Streamed over SSE while the page is
  visible and Live is on; the stream pauses when the tab is hidden.
-->
<script lang="ts">
  import { eventReasonLabel } from './geo-policy';
  import './controls.css';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import refresh from 'svelte-awesome/icons/refresh';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import type { DataTableColumn, StatusKind, TabItem } from '#lib/components/ui/types.js';
  import type { EBPFBandwidthEntry, EBPFConnection, EBPFEvent } from '#lib/api.js';
  import type { SSEConnectionState } from '#lib/sse.js';
  import { actionTone, protocolTone } from '#lib/tone.js';
  import { formatBytes, formatNumber } from '#lib/format.js';
  import type { LiveView } from './tabs';

  let {
    events = [],
    connections = [],
    bandwidth = [],
    view = $bindable<LiveView>('events'),
    onviewchange = undefined,
    live = $bindable(true),
    streamState = 'closed',
    streamError = null,
    canStream = false,
    loading = { events: false, connections: false, bandwidth: false },
    errors = { events: null, connections: null, bandwidth: null },
    onrefresh,
  }: {
    events?: readonly EBPFEvent[];
    connections?: readonly EBPFConnection[];
    bandwidth?: readonly EBPFBandwidthEntry[];
    view?: LiveView;
    onviewchange?: (view: LiveView) => void;
    /** Operator wants live updates (bindable). */
    live?: boolean;
    streamState?: SSEConnectionState;
    streamError?: string | null;
    /** The agent is online and the firewall is running. */
    canStream?: boolean;
    loading?: Record<LiveView, boolean>;
    /** Per-view load failure; shown instead of the "no data yet" empty state. */
    errors?: Record<LiveView, string | null>;
    onrefresh: (view: LiveView) => void;
  } = $props();

  const tabs = $derived<TabItem[]>([
    { id: 'events', label: 'Packet events', count: events.length },
    { id: 'connections', label: 'Connections', count: connections.length },
    { id: 'bandwidth', label: 'Bandwidth', count: bandwidth.length },
  ]);

  const stream = $derived.by((): { status: StatusKind; label: string } => {
    if (!canStream) return { status: 'unknown', label: 'Live updates unavailable: agent offline or firewall stopped' };
    if (!live) return { status: 'disabled', label: 'Live updates paused' };
    switch (streamState) {
      case 'open': return { status: 'online', label: 'Live' };
      case 'connecting': return { status: 'pending', label: 'Connecting…' };
      case 'reconnecting': return { status: 'degraded', label: 'Reconnecting…' };
      case 'failed': return { status: 'offline', label: 'Live stream stopped' };
      default: return { status: 'disabled', label: 'Paused while this tab is hidden' };
    }
  });

  // ── Events ────────────────────────────────────────────────────────────
  let eventQuery = $state('');
  const ACTION_FILTERS = [
    { value: '', label: 'All actions' },
    { value: 'drop', label: 'Drop' },
    { value: 'allow', label: 'Allow' },
    { value: 'log', label: 'Log' },
  ];
  let eventAction = $state('');
  type EventRow = EBPFEvent & { key: string };
  const eventRows = $derived.by((): EventRow[] => {
    const seen = new Map<string, number>();
    const query = eventQuery.trim().toLowerCase();
    return events
      .filter((ev) => (!eventAction || ev.action === eventAction) && (!query || [ev.src_ip, ev.dst_ip, ev.reason, String(ev.dst_port)].some((text) => String(text).toLowerCase().includes(query))))
      .map((ev) => {
        const base = `${ev.timestamp}|${ev.src_ip}:${ev.src_port}|${ev.dst_ip}:${ev.dst_port}|${ev.proto}|${ev.action}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return { ...ev, key: `${base}#${n}` };
      });
  });
  const eventColumns: DataTableColumn<EventRow>[] = [
    { key: 'timestamp', label: 'Time', sortable: true, firstSortDir: 'desc', sortValue: (row) => Date.parse(row.timestamp), nowrap: true },
    { key: 'action', label: 'Action', sortable: true },
    { key: 'reason', label: 'Reason', sortable: true },
    { key: 'src', label: 'Source', value: (row) => `${row.src_ip}:${row.src_port}` },
    { key: 'dst', label: 'Destination', value: (row) => `${row.dst_ip}:${row.dst_port}` },
    { key: 'proto', label: 'Protocol', sortable: true },
    { key: 'pkt_len', label: 'Size', align: 'right', sortable: true },
    { key: 'tcp_flags', label: 'TCP flags' },
  ];

  // ── Connections ───────────────────────────────────────────────────────
  let connQuery = $state('');
  const connRows = $derived(
    connections.filter((conn) => {
      const query = connQuery.trim().toLowerCase();
      return !query || [conn.src_ip, conn.dst_ip, String(conn.dst_port), String(conn.src_port), conn.state].some((text) => String(text).toLowerCase().includes(query));
    }),
  );
  const connKey = (conn: EBPFConnection) => `${conn.src_ip}:${conn.src_port}|${conn.dst_ip}:${conn.dst_port}|${conn.proto}`;
  const connColumns: DataTableColumn<EBPFConnection>[] = [
    { key: 'src', label: 'Source', value: (row) => `${row.src_ip}:${row.src_port}`, rowHeader: true },
    { key: 'dst', label: 'Destination', value: (row) => `${row.dst_ip}:${row.dst_port}` },
    { key: 'proto', label: 'Protocol', sortable: true },
    { key: 'state', label: 'State', sortable: true },
    { key: 'packets', label: 'Packets', align: 'right', sortable: true, firstSortDir: 'desc' },
    { key: 'bytes', label: 'Bytes', align: 'right', sortable: true, firstSortDir: 'desc' },
    { key: 'last_seen', label: 'Last seen', sortable: true, firstSortDir: 'desc', sortValue: (row) => Date.parse(row.last_seen), nowrap: true },
  ];

  // ── Bandwidth ─────────────────────────────────────────────────────────
  let bwQuery = $state('');
  const bwRows = $derived(bandwidth.filter((row) => !bwQuery.trim() || row.ip.includes(bwQuery.trim())));
  const bwColumns: DataTableColumn<EBPFBandwidthEntry>[] = [
    { key: 'ip', label: 'Address', rowHeader: true, sortable: true },
    { key: 'ingress_bytes', label: 'Received', align: 'right', sortable: true, firstSortDir: 'desc' },
    { key: 'egress_bytes', label: 'Sent', align: 'right', sortable: true, firstSortDir: 'desc' },
    { key: 'ingress_packets', label: 'Packets received', align: 'right', sortable: true, firstSortDir: 'desc' },
    { key: 'egress_packets', label: 'Packets sent', align: 'right', sortable: true, firstSortDir: 'desc' },
  ];
</script>

<div class="live">
  <div class="live-bar">
    <StatusDot status={stream.status} label={stream.label} pulse={stream.status === 'online'} />
    <div class="fw-row">
      <label class="live-toggle">
        <input type="checkbox" bind:checked={live} disabled={!canStream} />
        Live updates
      </label>
      <Button variant="ghost" size="sm" onclick={() => onrefresh(view)} disabled={loading[view]} aria-label="Reload this view"><Icon data={refresh} scale={0.8} /> Reload</Button>
    </div>
  </div>
  {#if streamError}<Alert tone="warning" compact title="Live stream stopped" message={streamError} />{/if}

  <Tabs {tabs} bind:value={view} label="Live view" size="sm" onchange={(id) => onviewchange?.(id as LiveView)}>
    {#snippet children(active)}
      {#if active === 'events'}
        <div class="live-filters">
          <label class="sr-only" for="fw-live-event-search">Search events</label>
          <input id="fw-live-event-search" class="fw-input" type="search" bind:value={eventQuery} placeholder="Search address, port or reason" autocomplete="off" />
          <label class="sr-only" for="fw-live-event-action">Action</label>
          <Select id="fw-live-event-action" class="live-action" options={ACTION_FILTERS} bind:value={eventAction} />
        </div>
        <DataTable rows={eventRows} columns={eventColumns} rowKey={(row) => row.key} caption="Packet events" itemLabel="events" pageSize={50} density="compact" loading={loading.events && events.length === 0} error={errors.events} onretry={() => onrefresh('events')} emptyTitle={eventQuery || eventAction ? 'No event matches the filter' : 'No packet events yet'} emptyMessage="Events appear when the firewall logs allowed or dropped packets (Settings: Log allowed / Log blocked).">
          {#snippet cell(row, column)}
            {#if column.key === 'timestamp'}<DateTime value={row.timestamp} seconds />
            {:else if column.key === 'action'}<Badge tone={actionTone(row.action)}>{row.action}</Badge>
            {:else if column.key === 'reason'}{eventReasonLabel(row)}
            {:else if column.key === 'src'}<code class="fw-mono">{row.src_ip}:{row.src_port}</code>
            {:else if column.key === 'dst'}<code class="fw-mono">{row.dst_ip}:{row.dst_port}</code>
            {:else if column.key === 'proto'}<Badge tone={protocolTone(row.proto)}>{row.proto}</Badge>
            {:else if column.key === 'pkt_len'}{formatBytes(row.pkt_len)}
            {:else if column.key === 'tcp_flags'}<span class="fw-mono">{row.tcp_flags || 'n/a'}</span>{/if}
          {/snippet}
        </DataTable>
      {:else if active === 'connections'}
        <div class="live-filters">
          <label class="sr-only" for="fw-live-conn-search">Search connections</label>
          <input id="fw-live-conn-search" class="fw-input" type="search" bind:value={connQuery} placeholder="Search address, port or state" autocomplete="off" />
        </div>
        <DataTable rows={connRows} columns={connColumns} rowKey={connKey} caption="Tracked connections" itemLabel="connections" pageSize={50} density="compact" loading={loading.connections && connections.length === 0} error={errors.connections} onretry={() => onrefresh('connections')} emptyTitle={connQuery ? 'No connection matches the search' : 'No tracked connections'} emptyMessage="Connection tracking must be on in Settings for flows to appear.">
          {#snippet cell(row, column)}
            {#if column.key === 'src'}<code class="fw-mono">{row.src_ip}:{row.src_port}</code>
            {:else if column.key === 'dst'}<code class="fw-mono">{row.dst_ip}:{row.dst_port}</code>
            {:else if column.key === 'proto'}<Badge tone={protocolTone(row.proto)}>{row.proto}</Badge>
            {:else if column.key === 'state'}{row.state}
            {:else if column.key === 'packets'}{formatNumber(row.packets)}
            {:else if column.key === 'bytes'}{formatBytes(row.bytes)}
            {:else if column.key === 'last_seen'}<DateTime value={row.last_seen} seconds />{/if}
          {/snippet}
        </DataTable>
      {:else}
        <div class="live-filters">
          <label class="sr-only" for="fw-live-bw-search">Search addresses</label>
          <input id="fw-live-bw-search" class="fw-input" type="search" bind:value={bwQuery} placeholder="Search address" autocomplete="off" />
        </div>
        <DataTable rows={bwRows} columns={bwColumns} rowKey={(row) => row.ip} caption="Bandwidth by address" itemLabel="addresses" pageSize={50} density="compact" loading={loading.bandwidth && bandwidth.length === 0} error={errors.bandwidth} onretry={() => onrefresh('bandwidth')} emptyTitle={bwQuery ? 'No address matches the search' : 'No bandwidth data yet'} emptyMessage="Per-address byte and packet counts appear once traffic passes the firewall.">
          {#snippet cell(row, column)}
            {#if column.key === 'ip'}<code class="fw-mono">{row.ip}</code>
            {:else if column.key === 'ingress_bytes'}{formatBytes(row.ingress_bytes)}
            {:else if column.key === 'egress_bytes'}{formatBytes(row.egress_bytes)}
            {:else if column.key === 'ingress_packets'}{formatNumber(row.ingress_packets)}
            {:else}{formatNumber(row.egress_packets)}{/if}
          {/snippet}
        </DataTable>
      {/if}
    {/snippet}
  </Tabs>
</div>

<style>
  .live { display: grid; gap: var(--sp-3); min-width: 0; }
  .live-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .live-toggle { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }
  .live-filters { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-3) 0; }
  .live-filters .fw-input { width: min(100%, 280px); }
  .live-filters :global(.live-action) { min-width: 9rem; }
</style>
