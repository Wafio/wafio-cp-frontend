export type SemanticPolicy = {
  block_threshold?: number;
  soft_threshold?: number;
  disabled?: boolean;
  [key: string]: unknown;
};

export function mergeWafRules(original: Record<string, any>, edited: Record<string, any>): Record<string, any> {
  const result = { ...original };
  for (const [key, value] of Object.entries(edited)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeWafRules(original?.[key] && typeof original[key] === 'object' ? original[key] : {}, value)
      : value;
  }
  return result;
}

// ── Path exception detection tuning ─────────────────────────────────────────
// Form-model shape for the per-path `tuning` object on path_exceptions entries.
// Mirrors the backend contract: effect carries the skip list and `action: "log"`
// (logOnly here). The effect always applies to the whole request, so the saved
// target is null.
export type PathTuningForm = {
  effect: {
    skip_semantic: string[];
    /** Saved as `action: "log"`: a detection that would block is recorded as LOG and the request goes on. */
    logOnly: boolean;
  };
};

/**
 * A tuning effect that holds blocks back as LOG: `action: "log"`, or a `weaken` of version 1 that lowered scores or
 * raised the block threshold (a multiplier below 1, or a positive block delta). Any other `weaken` did nothing a
 * detection could show. Mirrors engine.WeakenMeansLog in the control plane.
 */
export function effectLogsOnly(effect: unknown): boolean {
  const e = (effect && typeof effect === 'object' ? effect : {}) as Record<string, any>;
  if (e.action === 'log') return true;
  const weaken = (e.weaken && typeof e.weaken === 'object' ? e.weaken : {}) as Record<string, any>;
  const multiplier = typeof weaken.score_multiplier === 'number' ? weaken.score_multiplier : 0;
  const blockDelta = typeof weaken.threshold_delta?.block === 'number' ? weaken.threshold_delta.block : 0;
  return (multiplier > 0 && multiplier < 1) || blockDelta > 0;
}

export type WebSocketConfig = {
  enabled: boolean;
  origin_check: { enabled: boolean; allowed_origins: string[] };
  limits: { max_text_bytes: number; max_binary_bytes: number; max_messages_per_min: number };
  scan_server_frames: boolean;
  scan_binary_hashes: boolean;
};

export function mergeWebSocketConfig(original: Record<string, any>, edited: WebSocketConfig): Record<string, any> {
  return mergeWafRules(original, { websocket: edited });
}

export function validateWebSocketConfig(config: WebSocketConfig): string | null {
  if (config.origin_check.enabled && config.origin_check.allowed_origins.length === 0) return 'WebSocket origin check requires at least one allowed origin.';
  for (const origin of config.origin_check.allowed_origins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash || origin.trim() !== origin || origin.endsWith('/') || origin.endsWith(':')) {
        return `WebSocket origin is invalid: ${origin}`;
      }
    } catch {
      return `WebSocket origin is invalid: ${origin}`;
    }
  }
  for (const [name, value] of Object.entries(config.limits)) {
    if (!Number.isSafeInteger(value) || value < 0) return `WebSocket ${name} must be a non-negative integer.`;
  }
  return null;
}

export function serializeSemanticPolicy(original: SemanticPolicy, block: number, soft: number, disabled: boolean): SemanticPolicy {
  return { ...original, block_threshold: Number(block), soft_threshold: Number(soft), disabled };
}
