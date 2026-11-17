// One mapping from domain values to Badge tones and colour tokens. Pages never
// pick a tone inline: they call one of these
// helpers, so a WAF "Block" mode can never render as the ALLOW green again and
// severity "low" has exactly one colour everywhere.
//
// Families (tokens in src/app.css):
//   verdict      allow / log / block         , WAF, firewall and runtime decision actions only
//   status       status-online/pending/offline, agents and hosts
//   mode         mode-block / mode-monitor    , protection mode of a WAF route or app
//   severity     sev-critical … sev-info      , runtime events, incidents, attention items
//   categorical  cat1 … cat7                  , identity (protocol, direction, agent kind)
//   generic      neutral / info / success / warning / danger, anything else

export const VERDICT_TONES = ['allow', 'log', 'block'] as const;
export const STATUS_TONES = ['status-online', 'status-pending', 'status-offline'] as const;
export const MODE_TONES = ['mode-block', 'mode-monitor'] as const;
export const SEVERITY_TONES = ['sev-critical', 'sev-high', 'sev-medium', 'sev-low', 'sev-info'] as const;
export const CATEGORICAL_TONES = ['cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6', 'cat7'] as const;
export const GENERIC_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;

/** Every tone `Badge` renders; Badge.svelte defines a `.tone-<name>` rule for each. */
export const BADGE_TONES = [
  ...GENERIC_TONES,
  ...VERDICT_TONES,
  ...STATUS_TONES,
  ...MODE_TONES,
  ...SEVERITY_TONES,
  ...CATEGORICAL_TONES
] as const;

export type VerdictTone = (typeof VERDICT_TONES)[number];
export type StatusTone = (typeof STATUS_TONES)[number];
export type ModeTone = (typeof MODE_TONES)[number];
export type SeverityTone = (typeof SEVERITY_TONES)[number];
export type CategoricalTone = (typeof CATEGORICAL_TONES)[number];
export type BadgeTone = (typeof BADGE_TONES)[number];

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Severity levels from most to least severe. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// ── Severity ────────────────────────────────────────────────────────────────

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: 'critical',
  crit: 'critical',
  high: 'high',
  medium: 'medium',
  med: 'medium',
  moderate: 'medium',
  warning: 'medium',
  warn: 'medium',
  low: 'low',
  info: 'info',
  informational: 'info',
  notice: 'info',
  none: 'info'
};

/**
 * Normalises a severity name or the runtime numeric level
 * (internal/ebpf: 0 info, 1 low, 2 medium, 3 high, 4 critical). Unknown → null.
 */
export function normalizeSeverity(sev: unknown): Severity | null {
  if (typeof sev === 'number') {
    if (!Number.isInteger(sev) || sev < 0 || sev > 4) return null;
    return (['info', 'low', 'medium', 'high', 'critical'] as const)[sev];
  }
  return SEVERITY_ALIASES[norm(sev)] ?? null;
}

/** Badge tone for a severity. Unknown or missing severity is neutral, never a colour. */
export function severityTone(sev: unknown): SeverityTone | 'neutral' {
  const s = normalizeSeverity(sev);
  return s ? (`sev-${s}` as SeverityTone) : 'neutral';
}

/** CSS colour for a severity mark (dot, bar, row accent): `var(--sev-high)`. Unknown → muted text. */
export function severityColor(sev: unknown): string {
  const s = normalizeSeverity(sev);
  return s ? `var(--sev-${s})` : 'var(--text-muted)';
}

/** Sort key: critical 4 … info 0, unknown -1. */
export function severityRank(sev: unknown): number {
  const s = normalizeSeverity(sev);
  return s ? 4 - SEVERITIES.indexOf(s) : -1;
}

// ── Decision actions (verdicts) ────────────────────────────────────────────

const ACTION_VERDICTS: Record<string, VerdictTone> = {
  // WAF decisions (WAFDecision.action) and custom-rule actions
  block: 'block',
  deny: 'block',
  challenge: 'log', // interrupts the request without a hard block: intermediate like LOG
  log: 'log',
  monitor: 'log', // WAF monitor mode: the request would have been blocked and was logged
  allow: 'allow',
  clean: 'allow',
  pass: 'allow',
  // Host firewall decisions (port policies, firewall events)
  drop: 'block',
  reject: 'block'
};

/**
 * Tone for a WAF or host-firewall decision action (allow / log / monitor / block /
 * deny / drop …). `upstream_error` and unknown values are not verdicts → neutral.
 * For runtime-security policy actions use `enforcementTone`.
 */
export function actionTone(action: unknown): VerdictTone | 'neutral' {
  return ACTION_VERDICTS[norm(action)] ?? 'neutral';
}

/** Tone for the strength of a detection: a strong one blocks, a weak one logs. Anything else is not a verdict. */
export function strengthTone(strength: unknown): VerdictTone | 'neutral' {
  return strength === 'block' ? 'block' : strength === 'weak' ? 'log' : 'neutral';
}

/**
 * Tone for a runtime-security enforcement action (trace policy / enforcement log):
 * kill and block enforce → block; alert → log; simulate is a dry run → info;
 * monitor (no action) → neutral.
 */
export function enforcementTone(action: unknown): 'block' | 'log' | 'info' | 'neutral' {
  switch (norm(action)) {
    case 'kill':
    case 'block':
      return 'block';
    case 'alert':
      return 'log';
    case 'simulate':
      return 'info';
    default:
      return 'neutral';
  }
}

// ── Audit log ───────────────────────────────────────────────────────────────

/**
 * Tone for an audit-log action (`app.created`, `credential.revoked` …). Audit
 * verbs are not decisions, so they never use the verdict colours or the
 * green/amber that read as ALLOW/LOG: removals are destructive (danger, like a
 * destructive button), creations info, every other change neutral.
 */
export function auditActionTone(action: unknown): 'danger' | 'info' | 'neutral' {
  const a = norm(action);
  if (/delete|revok|remov|reject/.test(a)) return 'danger';
  if (/rotat|update|saved|changed|toggl|rolled_back|cleared/.test(a)) return 'neutral';
  if (/create|provision|enroll|register|added|assigned|acknowledg|resolved/.test(a)) return 'info';
  return 'neutral';
}

/**
 * Tone for an audit entry's HTTP outcome (admin audit log). A succeeded call is
 * neutral, never the ALLOW green; a failed one takes the generic error
 * tone, like a destructive audit verb. The badge text always names the outcome.
 */
export function auditOutcomeTone(outcome: unknown): 'danger' | 'neutral' {
  return norm(outcome) === 'success' ? 'neutral' : 'danger';
}

// ── Status ──────────────────────────────────────────────────────────────────

const STATUS_ALIASES: Record<string, StatusTone> = {
  online: 'status-online',
  connected: 'status-online',
  pending: 'status-pending',
  connecting: 'status-pending',
  reconnecting: 'status-pending',
  offline: 'status-offline',
  disconnected: 'status-offline'
};

/**
 * Tone for an agent/host/stream connection status. Accepts the status string or
 * an `is_online` boolean (true → online, false → offline). `revoked`,
 * `disabled`, `unknown` and missing values are neutral. Not for outcomes such as
 * a failed bundle apply (use the generic `danger` tone) or credential expiry.
 */
export function statusTone(status: string | boolean | null | undefined): StatusTone | 'neutral' {
  if (status === true) return 'status-online';
  if (status === false) return 'status-offline';
  return STATUS_ALIASES[norm(status)] ?? 'neutral';
}

// ── Configuration warnings ──────────────────────────────────────────────────

/**
 * Tone for a derived configuration warning such as an app's proxy_warnings
 * (TRUSTED_PROXIES_UNSET, TRUSTED_PROXIES_IGNORED): the generic
 * `warning` tone, a setting to review, not a WAF decision. Unknown codes are
 * neutral.
 */
export function configWarningTone(code: string | null | undefined): 'warning' | 'neutral' {
  return code ? 'warning' : 'neutral';
}

// ── Protection mode ─────────────────────────────────────────────────────────

/**
 * Tone for a WAF route/app protection mode. Block mode is its own tone
 * (`mode-block`, blue), never the ALLOW green and never the BLOCK verdict red,
 * because a mode is configuration, not a decision. Monitor mode is amber: it lets
 * attacks through and logs them.
 */
export function modeTone(mode: 'block' | 'monitor' | 'enforce' | (string & {}) | null | undefined): ModeTone | 'neutral' {
  switch (norm(mode)) {
    case 'block':
    case 'enforce': // host firewall enforce vs monitor-only
      return 'mode-block';
    case 'monitor':
      return 'mode-monitor';
    default:
      return 'neutral';
  }
}

// ── Categorical ─────────────────────────────────────────────────────────────

/** Categorical tone by slot (0-based), in fixed order; slots past 7 fold to neutral, never cycle. */
export function categoricalTone(index: number): CategoricalTone | 'neutral' {
  return Number.isInteger(index) && index >= 0 && index < CATEGORICAL_TONES.length ? CATEGORICAL_TONES[index] : 'neutral';
}

/** CSS colour of a categorical slot (0-based) for chart marks: `var(--cat-1)` …; past 7 → `var(--chart-neutral)`. */
export function categoricalColor(index: number): string {
  const t = categoricalTone(index);
  return t === 'neutral' ? 'var(--chart-neutral)' : `var(--cat-${t.slice(3)})`;
}

/** Categorical tone from a fixed vocabulary: `categoryTone('udp', PROTOCOLS)` → cat2. Unknown → neutral. */
export function categoryTone(value: unknown, vocabulary: readonly string[]): CategoricalTone | 'neutral' {
  return categoricalTone(vocabulary.indexOf(norm(value)));
}

/** Fixed vocabularies so the same value keeps the same colour on every page. */
export const PROTOCOLS = ['tcp', 'udp', 'icmp'] as const;
export const DIRECTIONS = ['ingress', 'egress'] as const;
export const AGENT_KINDS = ['host', 'waf'] as const;

export const protocolTone = (proto: unknown) => categoryTone(proto, PROTOCOLS);
export const directionTone = (direction: unknown) => categoryTone(direction, DIRECTIONS);
export const agentKindTone = (kind: unknown) => categoryTone(kind, AGENT_KINDS);

/**
 * Host firewall allowlist row badges: the port scope ("All ports",
 * "22/tcp, 5432/tcp") is plain identity data → neutral; "Lockout escape"
 * marks the management escape hatch → info. Never a verdict tone: an
 * allowlist entry describes reachability, not a decision.
 */
export function allowlistBadgeTone(badge: 'ports' | 'lockout-escape'): 'neutral' | 'info' {
  return badge === 'lockout-escape' ? 'info' : 'neutral';
}

// ── Host fleet protection states ────────────────────────────────────────────

/**
 * Tone for a host's firewall protection state (host fleet): enforce/monitor are
 * modes (`modeTone`), `not_running` is a warning, anything else neutral.
 */
export function firewallStateTone(state: string | null | undefined): ModeTone | 'warning' | 'neutral' {
  const s = norm(state);
  if (s === 'enforce' || s === 'monitor') return modeTone(s);
  return s === 'not_running' ? 'warning' : 'neutral';
}

/** Tone for a host's runtime-security state: on → info, off → warning, else neutral. */
export function runtimeStateTone(state: string | null | undefined): 'info' | 'warning' | 'neutral' {
  const s = norm(state);
  return s === 'on' ? 'info' : s === 'off' ? 'warning' : 'neutral';
}

/**
 * Tone for a host capability that is on or off (BPF LSM …): info when active,
 * neutral otherwise, never the ALLOW green, which is reserved for verdicts.
 */
export function capabilityTone(active: boolean): 'info' | 'neutral' {
  return active ? 'info' : 'neutral';
}

/**
 * Tone for the BPF-LSM state a host agent reports: active → info, a kernel
 * without bpf or an unverified state → warning (blocking may not work),
 * disabled by the operator → neutral, load or attach failure → danger.
 * Never the ALLOW green.
 */
export function lsmStateTone(state: string | null | undefined): 'info' | 'warning' | 'danger' | 'neutral' {
  switch (norm(state)) {
    case 'active':
      return capabilityTone(true);
    case 'kernel_lacks_bpf':
    case 'unverified':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

/**
 * Tone for a resource-pressure level (database size against its budget, the
 * disk holding the database: Administration › Data retention): critical →
 * danger, warning → warning, anything else neutral. Not a WAF verdict.
 */
export function pressureTone(level: string | null | undefined): 'danger' | 'warning' | 'neutral' {
  const s = norm(level);
  return s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'neutral';
}

/**
 * Tone for a background job that should be running (a table's retention
 * job): active → info, not active → warning. Never the ALLOW green.
 */
export function jobStateTone(active: boolean): 'info' | 'warning' {
  return active ? 'info' : 'warning';
}
