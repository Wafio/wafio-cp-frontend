/**
 * Host firewall geo policy: block mode (drop the listed countries) or allow
 * mode (drop every new inbound connection from outside the listed countries).
 * Pure helpers shared by the Firewall page, GeoPolicyPanel and the access
 * rules table.
 */
import type { EBPFEvent, EBPFGeoMode, EBPFGeoPolicy } from '#lib/api.js';

export type GeoMode = EBPFGeoMode;

export const GEO_MODE_LABEL: Record<GeoMode, string> = {
  block: 'Block these countries',
  allow: 'Only allow these countries',
};

export const GEO_ALLOW_UNSUPPORTED_HINT =
  'The host agent has not reported allow-mode support: update the host agent and its eBPF objects, and install the GeoIP country database.';

/** What allow mode does, shown before any change that narrows access in it. */
export const GEO_ALLOW_CONSEQUENCES: readonly string[] = [
  'Allow mode drops every new inbound connection from outside the listed countries, including addresses missing from the GeoIP data.',
  'Replies to connections this host opens, allowlisted addresses, the control-plane connection and private TCP sources stay open; private UDP sources only from the subnets of the network interface the firewall runs on.',
  'A TCP session open before the switch (your SSH session) survives, but a new one from outside the listed countries is dropped, and an open one is cut when the host agent restarts. UDP flows from outside (VPN peers) are cut at once.',
  'Switch the firewall to Monitor mode first to dry-run it: drops are then logged as would-drop. Add the IP you administer from to the allowlist before enforcing.',
];

/**
 * What a host enforces when its desired geo policy is not (status
 * geo_degraded_state); every other firewall rule is applied in all cases.
 */
export function geoDegradedStateText(state: string | undefined): string {
  switch (state) {
    case 'ranges_cleared':
      return 'Every other firewall rule is applied. Block mode runs without the country address ranges: only addresses the agent has already looked up are blocked.';
    case 'mixed':
      return 'Every other firewall rule is applied, but restoring the previous geo state failed: the geo tables may hold parts of the old and the new policy. Save the geo policy again or restart the host agent.';
    default:
      return 'Every other firewall rule is applied; the host keeps its previous geo state.';
  }
}

/** Normalised view of the GET response; older control planes have no mode fields. */
export interface GeoPolicyView {
  mode: GeoMode;
  blocked: string[];
  allowed: string[];
  allowSupported: boolean;
}

export function geoPolicyView(data: EBPFGeoPolicy | null | undefined): GeoPolicyView {
  const blocked = (data?.countries ?? []).filter((entry) => entry.blocked).map((entry) => entry.code.toUpperCase());
  const allowed = [...new Set((data?.allowed_countries ?? []).map((code) => code.toUpperCase()))].sort();
  return {
    mode: data?.mode === 'allow' ? 'allow' : 'block',
    blocked,
    allowed,
    allowSupported: data?.allow_supported === true,
  };
}

/**
 * A save needs the allow-mode confirmation (and `allow_acknowledged: true`)
 * when the result is allow mode and it switches to allow or removes an
 * allowed country. Adding countries in allow mode only widens access.
 */
export function geoAllowNeedsAck(change: { current: GeoMode; next: GeoMode; removesAllowed?: boolean }): boolean {
  if (change.next !== 'allow') return false;
  return change.current !== 'allow' || Boolean(change.removesAllowed);
}

/** Allowed list after a switch that adds `added`: the kept list plus the new codes. */
export function allowListAfter(kept: readonly string[], added: readonly string[]): string[] {
  return [...new Set([...kept, ...added].map((code) => code.toUpperCase()))].sort();
}

/** Reason text of a live firewall event; geo drops in allow mode are labelled as such. */
export function eventReasonLabel(event: Pick<EBPFEvent, 'reason' | 'geo_mode' | 'rule_id'>): string {
  if (event.reason === 'geoblock' && (event.geo_mode === 'allow' || event.rule_id === 2)) return 'Geo (allow mode)';
  return event.reason || 'n/a';
}
