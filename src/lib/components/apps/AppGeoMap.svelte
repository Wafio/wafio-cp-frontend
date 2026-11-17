<!--
  AppGeoMap: Leaflet map of request origins with clustering. Rendered only
  when there are mappable points (the parent decides). Popup and marker HTML
  come from geo.ts, which escapes every telemetry value. Tiles
  follow the theme (Esri gray canvas, no API key).
-->
<script lang="ts">
  import type { GeoLocation } from '#lib/api.js';
  import { theme } from '#lib/stores/theme.js';
  import { geoMarkerHtml, geoPopupHtml, mappableLocations } from './geo';

  let { locations, label = 'Map of request origins' }: { locations: GeoLocation[]; label?: string } = $props();

  let container = $state<HTMLDivElement>();
  let map: import('leaflet').Map | null = null;
  let cluster: import('leaflet').Layer | null = null;
  let leaflet: typeof import('leaflet') | null = null;
  let ready = $state(false);

  // Create the map once per theme (the tile variant differs); tear down on change/unmount.
  $effect(() => {
    const node = container;
    const variant = $theme === 'light' ? 'Light' : 'Dark';
    if (!node) return;
    let cancelled = false;
    let created: import('leaflet').Map | null = null;
    void (async () => {
      const L = (await import('leaflet')).default;
      // @ts-ignore: plugin augments L at import time.
      await import('leaflet.markercluster');
      if (cancelled) return;
      leaflet = L;
      created = L.map(node, {
        center: [20, 10],
        zoom: 2,
        minZoom: 2,
        maxZoom: 10,
        zoomControl: false,
        attributionControl: true,
        maxBounds: [[-85, -210], [85, 210]],
        maxBoundsViscosity: 0.85,
        worldCopyJump: false,
      });
      L.control.zoom({ position: 'topright' }).addTo(created);
      L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${variant}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
        attribution:
          'Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community. IP geolocation by <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">DB-IP</a>',
        maxZoom: 16,
      }).addTo(created);
      L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${variant}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
        maxZoom: 16,
        pane: 'shadowPane',
      }).addTo(created);
      map = created;
      ready = true;
      setTimeout(() => created?.invalidateSize(), 100);
    })();
    return () => {
      cancelled = true;
      created?.remove();
      if (map === created) {
        map = null;
        cluster = null;
      }
      ready = false;
    };
  });

  // Redraw the markers when the data (or the map) changes.
  $effect(() => {
    const points = mappableLocations(locations);
    if (!ready || !map || !leaflet) return;
    const L = leaflet;
    if (cluster) {
      map.removeLayer(cluster);
      cluster = null;
    }
    const group = (L as unknown as { markerClusterGroup: (opts: object) => import('leaflet').LayerGroup }).markerClusterGroup({
      maxClusterRadius: 60,
      iconCreateFunction: (c: { getChildCount: () => number }) => {
        const count = c.getChildCount();
        const size = count > 500 ? 52 : count > 100 ? 44 : count > 20 ? 36 : 30;
        return L.divIcon({
          html: `<div class="geo-cluster" style="width:${size}px;height:${size}px"><span>${Number(count)}</span></div>`,
          className: '',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
      },
    });
    for (const point of points) {
      const marker = geoMarkerHtml(point);
      L.marker([point.lat as number, point.lon as number], {
        icon: L.divIcon({ html: marker.html, className: '', iconSize: [marker.size, marker.size], iconAnchor: [marker.size / 2, marker.size / 2] }),
        keyboard: true,
        title: `${point.remote_addr}: ${point.count} requests`,
        alt: `${point.remote_addr}: ${point.count} requests`,
      })
        .bindPopup(geoPopupHtml(point), { maxWidth: 260 })
        .addTo(group);
    }
    map.addLayer(group);
    cluster = group;
  });
</script>

<div class="geo-map" bind:this={container} role="region" aria-label={label}></div>

<style>
  .geo-map {
    width: 100%;
    height: 340px;
    border-radius: var(--radius);
    overflow: hidden;
    position: relative;
    /* Leaflet panes stack with z-index; isolate them from the page. */
    isolation: isolate;
    border: 1px solid var(--border);
  }
  :global(.leaflet-container) { background: var(--bg-tertiary); font-family: var(--font-sans); }
  :global(.leaflet-popup-content-wrapper) { background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); }
  :global(.leaflet-popup-tip) { background: var(--bg-elevated); }
  :global(.leaflet-popup-close-button) { color: var(--text-muted) !important; }
  :global(.leaflet-control-zoom) { border: 1px solid var(--border) !important; border-radius: var(--radius) !important; overflow: hidden; box-shadow: var(--shadow-md) !important; }
  :global(.leaflet-control-zoom a) { background: var(--bg-elevated) !important; color: var(--text-secondary) !important; border-bottom: 1px solid var(--border) !important; }
  :global(.leaflet-control-zoom a:hover) { background: var(--bg-tertiary) !important; color: var(--accent) !important; }
  :global(.leaflet-control-zoom-out) { border-bottom: none !important; }
  :global(.leaflet-control-attribution) { background: color-mix(in srgb, var(--bg-card) 80%, transparent) !important; color: var(--text-muted) !important; font-size: var(--fs-xs); }

  :global(.geo-cluster) {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: color-mix(in srgb, var(--cat-1) 70%, transparent);
    border: 2px solid var(--cat-1);
    color: var(--text-primary);
    font-size: var(--fs-xs);
    font-weight: var(--fw-bold);
  }
  :global(.geo-dot) {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 2px solid var(--bg-card);
    cursor: pointer;
  }
  :global(.geo-dot-allow) { background: var(--allow); }
  :global(.geo-dot-log) { background: var(--log); }
  :global(.geo-dot-block) { background: var(--block); }
  :global(.geo-dot-count) { font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--bg-card); pointer-events: none; }
  :global(.geo-popup) { font-size: var(--fs-sm); line-height: 1.5; min-width: 11rem; }
  :global(.geo-ip) { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-1); }
  :global(.geo-ip code) { font-family: var(--font-mono); }
  :global(.geo-loc) { color: var(--text-secondary); margin-bottom: var(--sp-1); }
  :global(.geo-isp) { font-size: var(--fs-xs); color: var(--text-muted); }
  :global(.geo-stats) { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
  :global(.geo-total) { font-weight: var(--fw-semibold); }
  :global(.geo-verdict) { font-size: var(--fs-xs); font-weight: var(--fw-medium); }
  :global(.geo-verdict-block) { color: var(--block); }
  :global(.geo-verdict-log) { color: var(--log); }
</style>
