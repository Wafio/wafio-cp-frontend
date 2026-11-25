// Builders for the answer of GET …/delivery: an application with every part off, served by an online agent that
// knows every part and has answered the latest bundle. A test changes only what it is about.
import type { AppDelivery, AppDeliveryAgent, AppDeliveryStatus, AppEdgeFeatureState, EdgePart } from '../../src/lib/api';

export const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
export const MINUTE = 60 * 1000;

export function feature(part: EdgePart, over: Partial<AppEdgeFeatureState> = {}): AppEdgeFeatureState {
  return { feature: part, state: 'applied', code: '', detail: '', running_previous: false, ...over };
}

export function agent(over: Partial<AppDeliveryAgent> = {}, features: Partial<Record<EdgePart, boolean | null>> = {}): AppDeliveryAgent {
  return {
    id: 'agent-1',
    name: 'edge-1',
    online: true,
    ...over,
    features: { redirects: true, compression: true, static_files: true, cache: true, ...features },
  };
}

export function status(over: Partial<AppDeliveryStatus> = {}): AppDeliveryStatus {
  return {
    agent_id: 'agent-1',
    generation: 100,
    received_at: new Date(NOW - MINUTE).toISOString(),
    redirects: null,
    compression: null,
    static_files: null,
    cache: null,
    ...over,
  };
}

export function delivery(over: Partial<AppDelivery> = {}): AppDelivery {
  return {
    compression: { enabled: false, min_bytes: 1024 },
    static_files: { enabled: false, root: '', missing: 'app', max_age_s: 0 },
    cache: {
      enabled: false,
      default_ttl_s: 3600,
      stale_if_error_s: 600,
      disk_bytes: 1 << 30,
      memory_bytes: 32 << 20,
      max_object_bytes: 8 << 20,
      session_cookies: [],
      rules: [],
    },
    agent: agent(),
    generation: 100,
    status: status(),
    cache_stats: null,
    compression_stats: null,
    purges: [],
    ...over,
  };
}
