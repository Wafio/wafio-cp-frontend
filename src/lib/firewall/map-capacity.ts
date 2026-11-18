// How full the BPF maps are that the host agent sizes from the host memory
// (map_sizing in the firewall and trace status). Older agents omit the key;
// mapCapacityView then answers null and the page says "Not reported".
import type { MapCapacity, MapSizing } from '../api';
import { formatBytes, formatNumber, formatPercent, parseTimestamp } from '../format';

/** The agent's coverage warning uses the same window. */
export const FULL_WINDOW_MS = 10 * 60 * 1000;

// `bytes`: max_entries of the ring is a size in bytes, not a count of entries.
const MAPS: Record<string, { label: string; bytes?: boolean }> = {
  wafio_conntrack: { label: 'Connection tracking' },
  wafio_syn_state: { label: 'SYN flood sources' },
  wafio_rate_state: { label: 'Rate limit sources' },
  wafio_portscan: { label: 'Port scan sources' },
  wafio_bandwidth: { label: 'Bandwidth accounting' },
  wafio_geoip: { label: 'GeoIP cache' },
  wafio_jail: { label: 'WAF jail' },
  trace_open_pending: { label: 'Pending file opens' },
  trace_events: { label: 'Event ring', bytes: true },
};

/** An unknown map name is shown as the agent sent it. */
export function mapLabel(name: string): string {
  return MAPS[name]?.label ?? name;
}

/** Fill of the map in percent (0 to 100); null while the agent reports no live count, as for the ring. */
export function mapPercent(m: MapCapacity): number | null {
  if (typeof m.entries !== 'number' || !(m.max_entries > 0)) return null;
  return Math.min(100, Math.max(0, (m.entries / m.max_entries) * 100));
}

export type MapState = 'full' | 'was_full' | 'ok';

/** Full when the map was full within the last 10 minutes, was_full when earlier, else ok. */
export function mapState(m: MapCapacity, now: number): MapState {
  const at = parseTimestamp(m.last_full_at);
  if (!at) return 'ok';
  return now - at.getTime() < FULL_WINDOW_MS ? 'full' : 'was_full';
}

export interface MapRow {
  name: string;
  label: string;
  /** "4,210 of 119,750", "4 MiB" for the ring, "119,750 entries" before the first count. */
  usage: string;
  percent: number | null;
  percentText: string;
  /** Default size when this one is smaller: "500,000" or "16 MiB". */
  reducedFrom: string | null;
  state: MapState;
  lastFullAt: string | null;
}

export interface MapCapacityView {
  /** "Map scale 0.24, automatic, from 1.9 GiB memory". */
  header: string;
  /** What to do, only while a map is full; otherwise null. */
  advice: string | null;
  rows: MapRow[];
}

function row(m: MapCapacity, now: number): MapRow {
  const size = (n: number) => (MAPS[m.name]?.bytes ? formatBytes(n) : formatNumber(n));
  const percent = mapPercent(m);
  const hasCount = typeof m.entries === 'number';
  const usage = hasCount ? `${formatNumber(m.entries)} of ${size(m.max_entries)}`
    : MAPS[m.name]?.bytes ? size(m.max_entries)
    : `${size(m.max_entries)} entries`;
  const smaller = typeof m.default_max_entries === 'number' && m.default_max_entries > m.max_entries;
  return {
    name: m.name,
    label: mapLabel(m.name),
    usage,
    percent,
    percentText: percent === null ? '' : formatPercent(percent, { input: 'percent', digits: 1 }),
    reducedFrom: smaller ? size(m.default_max_entries as number) : null,
    state: mapState(m, now),
    lastFullAt: parseTimestamp(m.last_full_at) ? m.last_full_at : null,
  };
}

function header(s: MapSizing): string {
  // Two significant digits: 0.2395 reads 0.24, a forced 0.001 stays 0.001.
  let text = `Map scale ${Number.isFinite(s.scale) ? Number(s.scale.toPrecision(2)) : 'unknown'}`;
  if (s.source === 'auto') {
    text += ', automatic';
    // A cgroup memory.max lowered the basis below the host memory: say so, or the figure looks wrong.
    const basis = s.memory_source === 'cgroup' ? 'cgroup memory limit' : 'memory';
    if (s.memory_bytes && s.memory_bytes > 0) text += `, from ${formatBytes(s.memory_bytes)} ${basis}`;
  } else if (s.source) {
    text += ', set by WAFIO_EBPF_MAP_SCALE';
  }
  return text;
}

// The agent's rows that have a name and a size, first of each name only: the
// status passes through unchecked, and a repeated name would make the keyed
// {#each} throw and take the page down.
function usableMaps(s: MapSizing | null | undefined): MapCapacity[] {
  const seen = new Set<string>();
  const out: MapCapacity[] = [];
  for (const m of Array.isArray(s?.maps) ? s.maps : []) {
    if (typeof m?.name !== 'string' || !Number.isFinite(m.max_entries) || seen.has(m.name)) continue;
    seen.add(m.name);
    out.push(m);
  }
  return out;
}

/** Number of maps that were full within the last 10 minutes. */
export function fullMapCount(s: MapSizing | null | undefined, now: number): number {
  return usableMaps(s).filter((m) => mapState(m, now) === 'full').length;
}

/** Null when the agent reports no usable map sizes. */
export function mapCapacityView(s: MapSizing | null | undefined, now: number): MapCapacityView | null {
  const maps = usableMaps(s);
  if (!s || maps.length === 0) return null;
  const rows = maps.map((m) => row(m, now));
  return {
    header: header(s),
    // At scale 1 the maps already have their largest size, so raising it cannot help.
    advice: !rows.some((r) => r.state === 'full') ? null
      : s.scale >= 1 ? 'A map was full in the last 10 minutes. The maps are at full size: look for a flood.'
      : 'A map was full in the last 10 minutes. Raise WAFIO_EBPF_MAP_SCALE (at most 1) or look for a flood.',
    rows,
  };
}
