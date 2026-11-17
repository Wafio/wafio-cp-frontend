/**
 * Request-geography helpers for the application map.
 *
 * Leaflet's bindPopup and divIcon render HTML strings, so every value that
 * comes from telemetry (IP, city, ISP, country name/code) is escaped here.
 * Marker colours are classes styled with tokens, never interpolated values.
 */
import type { GeoLocation } from '../../api';
import { formatCountryName } from '../../geo';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

/** Map points with usable coordinates (0,0 is "unknown", not the Gulf of Guinea). */
export function mappableLocations(locations: readonly GeoLocation[]): GeoLocation[] {
  return locations.filter(
    (l) =>
      typeof l.lat === 'number' &&
      typeof l.lon === 'number' &&
      Number.isFinite(l.lat) &&
      Number.isFinite(l.lon) &&
      !(l.lat === 0 && l.lon === 0) &&
      Math.abs(l.lat) <= 90 &&
      Math.abs(l.lon) <= 180,
  );
}

/** Verdict class of a location: its strictest recorded decision. */
export function locationTone(l: Pick<GeoLocation, 'block' | 'log'>): 'block' | 'log' | 'allow' {
  if (l.block > 0) return 'block';
  if (l.log > 0) return 'log';
  return 'allow';
}

function whole(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Popup markup for one location; every telemetry value is escaped. */
export function geoPopupHtml(l: GeoLocation): string {
  const code = (l.country_code ?? '').trim();
  const city = l.city ? `<b>${escapeHtml(l.city)}</b>, ` : '';
  const country = escapeHtml(formatCountryName(l.country_name, l.country_code));
  const isp = l.isp ? `<br><span class="geo-isp">${escapeHtml(l.isp)}</span>` : '';
  const hits = whole(l.count);
  const blocked = whole(l.block);
  const logged = whole(l.log);
  const verdicts = [
    blocked ? `<span class="geo-verdict geo-verdict-block">${blocked.toLocaleString('en-US')} blocked</span>` : '',
    logged ? `<span class="geo-verdict geo-verdict-log">${logged.toLocaleString('en-US')} logged</span>` : '',
  ].join('');
  return (
    `<div class="geo-popup">` +
    `<div class="geo-ip"><code>${escapeHtml(l.remote_addr)}</code></div>` +
    `<div class="geo-loc">${city}${country}${isp}</div>` +
    `<div class="geo-stats"><span class="geo-total">${hits.toLocaleString('en-US')} ${hits === 1 ? 'request' : 'requests'}</span>${verdicts}</div>` +
    `</div>`
  );
}

/** Marker size in px, growing with the log of the request count (room for a --fs-xs count). */
export function markerSize(count: number): number {
  return Math.round(Math.min(36, Math.max(18, 12 + Math.log2(whole(count) + 1) * 3.5)));
}

/** Marker markup: numbers and a fixed class only. */
export function geoMarkerHtml(l: Pick<GeoLocation, 'count' | 'block' | 'log'>): { html: string; size: number } {
  const size = markerSize(l.count);
  const count = whole(l.count);
  const label = count > 1 ? `<span class="geo-dot-count">${count > 999 ? '999+' : count}</span>` : '';
  return {
    html: `<div class="geo-dot geo-dot-${locationTone(l)}" style="width:${size}px;height:${size}px">${label}</div>`,
    size,
  };
}

export interface CountryRow {
  code: string;
  name: string;
  count: number;
  block: number;
  /** Share of the busiest country, 0–100. */
  pct: number;
}

/** Top countries by requests. */
export function topCountries(locations: readonly GeoLocation[], limit = 10): CountryRow[] {
  const byCountry = new Map<string, { name: string; count: number; block: number }>();
  for (const l of locations) {
    const code = (l.country_code || 'n/a').trim().toUpperCase() || 'n/a';
    const entry = byCountry.get(code);
    if (entry) {
      entry.count += whole(l.count);
      entry.block += whole(l.block);
    } else {
      byCountry.set(code, { name: formatCountryName(l.country_name, code), count: whole(l.count), block: whole(l.block) });
    }
  }
  const rows = [...byCountry.entries()]
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
  const max = rows[0]?.count || 1;
  return rows.map((r) => ({ ...r, pct: Math.round((r.count / max) * 100) }));
}

/** IP → country code, for the feed's country column. */
export function countryByIp(locations: readonly GeoLocation[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of locations) {
    const code = (l.country_code ?? '').trim();
    if (l.remote_addr && code && code !== '—') map.set(l.remote_addr, code.toUpperCase());
  }
  return map;
}
