/**
 * Firewall Settings draft.
 *
 * The Settings tab edits two desired-state documents as one draft, the
 * kernel firewall configuration and the port-policy defaults, and saves them
 * together after one confirmation. Validation mirrors the control plane
 * (shared/hostpolicy/firewall_validation.go) so errors show next to the field
 * instead of as a toast after the request.
 */
import type { EBPFFullConfig, EBPFPortPolicyConfig } from '#lib/api.js';
import { firewallState, type FirewallState } from './lockout';

export interface SettingsDraft {
  config: EBPFFullConfig;
  portPolicy: EBPFPortPolicyConfig;
}

export const DEFAULT_PORT_SCAN = { enabled: false, window_ms: 10_000, max_unique_ports: 20, drop_on_detect: true } as const;
/** Highest port-scan threshold the XDP program can reach (MAX_SCAN_PORTS, ebpf.MaxPortScanUniquePorts). */
export const MAX_PORT_SCAN_UNIQUE_PORTS = 32;
export const DEFAULT_PORT_POLICY: EBPFPortPolicyConfig = { enabled: false, default_ingress: 'allow', default_egress: 'allow' };

/**
 * A complete configuration, or null when the agent has not reported one
 * (the endpoint answers {} until it does). Older agents omit port_scan.
 */
export function normalizeConfig(value: unknown): EBPFFullConfig | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Partial<EBPFFullConfig>;
  if (!config.global || !config.rate || !config.anomaly) return null;
  return {
    global: { ...config.global },
    rate: { ...config.rate },
    anomaly: { ...config.anomaly },
    port_scan: { ...DEFAULT_PORT_SCAN, ...(config.port_scan ?? {}) },
  };
}

export function normalizePortPolicy(value: Partial<EBPFPortPolicyConfig> | null | undefined): EBPFPortPolicyConfig {
  return {
    enabled: value?.enabled ?? false,
    default_ingress: value?.default_ingress === 'deny' ? 'deny' : 'allow',
    default_egress: value?.default_egress === 'deny' ? 'deny' : 'allow',
  };
}

export function draftState(draft: SettingsDraft): FirewallState {
  return firewallState(draft.config.global, draft.portPolicy);
}

const UINT32_MAX = 4_294_967_295;

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Field errors keyed by path ("rate.window_ms"); empty when the draft is valid. */
export function validateSettings(draft: SettingsDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const { global, rate, port_scan: portScan } = draft.config;

  if (!isWholeNumber(global.max_payload_bytes)) errors['global.max_payload_bytes'] = 'Enter a whole number of bytes (0 or more).';

  for (const key of ['window_ms', 'max_pps', 'max_bps', 'max_syn_pps', 'burst_pps', 'burst_syn'] as const) {
    if (!isWholeNumber(rate[key])) errors[`rate.${key}`] = 'Enter a whole number (0 or more).';
  }
  if (!errors['rate.window_ms'] && rate.window_ms !== 0 && (rate.window_ms < 10 || rate.window_ms > 60_000)) {
    errors['rate.window_ms'] = 'Use 0 for the agent default, or 10 to 60,000 ms.';
  }
  if (!errors['rate.max_pps'] && !errors['rate.burst_pps'] && rate.max_pps + rate.burst_pps > UINT32_MAX) {
    errors['rate.burst_pps'] = 'Max PPS plus burst exceeds the supported limit.';
  }
  if (!errors['rate.max_syn_pps'] && !errors['rate.burst_syn'] && rate.max_syn_pps + rate.burst_syn > UINT32_MAX) {
    errors['rate.burst_syn'] = 'Max SYN PPS plus burst exceeds the supported limit.';
  }

  if (portScan.enabled) {
    if (!isWholeNumber(portScan.window_ms) || portScan.window_ms < 10 || portScan.window_ms > 60_000) {
      errors['port_scan.window_ms'] = 'Use 10 to 60,000 ms.';
    }
    if (!isWholeNumber(portScan.max_unique_ports) || portScan.max_unique_ports < 1 || portScan.max_unique_ports > MAX_PORT_SCAN_UNIQUE_PORTS) {
      errors['port_scan.max_unique_ports'] = `Use 1 to ${MAX_PORT_SCAN_UNIQUE_PORTS} ports.`;
    }
  }
  return errors;
}

/** Number of leaf values that differ between two drafts. */
export function countChanges(a: unknown, b: unknown): number {
  if (Object.is(a, b)) return 0;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    let total = 0;
    for (const key of keys) total += countChanges((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
    return total;
  }
  return 1;
}

/** Which of the two documents differ from the baseline. */
export function changedParts(baseline: SettingsDraft, draft: SettingsDraft): { config: boolean; portPolicy: boolean } {
  return {
    config: countChanges(baseline.config, draft.config) > 0,
    portPolicy: countChanges(baseline.portPolicy, draft.portPolicy) > 0,
  };
}

/**
 * Save order that keeps every intermediate state valid for the control
 * plane: with ingress Deny all in the result, the configuration (connection
 * tracking) goes first; otherwise the port policy goes first so Deny all is
 * lifted before connection tracking is turned off.
 */
export function saveOrder(draft: SettingsDraft): Array<'config' | 'portPolicy'> {
  const denyIngress = draft.portPolicy.enabled && draft.portPolicy.default_ingress === 'deny';
  return denyIngress ? ['config', 'portPolicy'] : ['portPolicy', 'config'];
}
