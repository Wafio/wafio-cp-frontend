/**
 * Runtime enforcement policies (trace policies) and trace configuration:
 * editor defaults, the match preview, confirmation tiers.
 */
import type { CommMatchMode, EnforcementPolicy, TraceConfig, TraceEvent } from '#lib/api.js';
import { strictestTier, tierFor, tierForPolicySave, type ConfirmTier } from '../../confirm-tiers';
import { matchTerms, policyHasNarrowingMatch } from '../../policyTemplates';
import { severityRank } from '../../tone';
import { mitreForEvent } from './mitre';

export type PolicyAction = 'simulate' | 'monitor' | 'alert' | 'kill' | 'block';

export const POLICY_ACTIONS: ReadonlyArray<{ value: PolicyAction; label: string; help: string }> = [
  { value: 'simulate', label: 'Simulate', help: 'Dry run: records what would have been killed; no process is touched. Start here.' },
  { value: 'monitor', label: 'Monitor', help: 'Observe only; no alert and no action.' },
  { value: 'alert', label: 'Alert', help: 'Flag matching events for review; no process is touched.' },
  { value: 'kill', label: 'Kill', help: 'Send SIGKILL to the matching process. PID 1, the agent and verified host daemons (sshd, systemd, containerd, dockerd, kubelet) are exempt.' },
  { value: 'block', label: 'Block', help: 'Deny execution in the kernel (BPF-LSM, -EPERM) before the program starts.' },
];

export const ENFORCING_ACTIONS: readonly string[] = ['kill', 'block'];

export function isEnforcingAction(action: string | null | undefined): boolean {
  return ENFORCING_ACTIONS.includes(action ?? '');
}

export const MIN_SEVERITY_CHOICES = [
  { value: 'info', label: 'Info (all events)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical only' },
] as const;

/** Process-name match modes for the editor. */
export const COMM_MATCH_MODES: ReadonlyArray<{ value: CommMatchMode; label: string; help: string }> = [
  { value: 'word', label: 'Whole word', help: 'Case-insensitive; the term must be delimited by a non-letter, so nc matches nc.openbsd but not runc, and python matches python3.' },
  { value: 'exact', label: 'Exact name', help: 'Case-insensitive; the whole process name must equal the term.' },
  { value: 'substring', label: 'Contains', help: 'Case-insensitive substring, as policies saved before the mode existed: nc also matches runc and rsync.' },
];

export type PolicyDraft = Partial<EnforcementPolicy> & {
  name: string;
  description: string;
  enabled: boolean;
  event_types: string[];
  min_severity: string;
  match_comm: string;
  match_comm_mode: CommMatchMode;
  match_filename: string;
  match_uid: number | null;
  match_dest_port: string;
  action: string;
  kernel_enforce: boolean;
};

/** A new policy: Simulate, so the first save never touches a process. */
export function defaultPolicyDraft(prefill: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    name: '',
    description: '',
    enabled: true,
    event_types: [],
    min_severity: 'info',
    match_comm: '',
    match_comm_mode: 'word',
    match_filename: '',
    match_uid: null,
    match_dest_port: '',
    action: 'simulate',
    kernel_enforce: false,
    mitre_technique_id: '',
    mitre_tactic: '',
    ...prefill,
  };
}

export function draftFromPolicy(policy: EnforcementPolicy): PolicyDraft {
  return {
    ...policy,
    description: policy.description ?? '',
    event_types: [...(policy.event_types ?? [])],
    min_severity: policy.min_severity || 'info',
    match_comm: policy.match_comm ?? '',
    // Saved before the field existed: substring, as the agent applies it.
    match_comm_mode: policy.match_comm_mode ?? 'substring',
    match_filename: policy.match_filename ?? '',
    match_uid: policy.match_uid ?? null,
    match_dest_port: policy.match_dest_port ?? '',
    kernel_enforce: Boolean(policy.kernel_enforce),
    mitre_technique_id: policy.mitre_technique_id ?? '',
    mitre_tactic: policy.mitre_tactic ?? '',
  };
}

/** A policy prefilled from an observed event, in Simulate (MITRE suggested from the event name). */
export function draftFromEvent(event: Pick<TraceEvent, 'event_name' | 'comm'>): PolicyDraft {
  const mitre = mitreForEvent(event.event_name);
  return defaultPolicyDraft({
    name: `${event.comm || 'process'} ${event.event_name}`.trim(),
    event_types: event.event_name ? [event.event_name] : [],
    match_comm: event.comm ?? '',
    mitre_technique_id: mitre?.technique_id ?? '',
    mitre_tactic: mitre?.tactic ?? '',
  });
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** TASK_COMM_LEN - 1: the kernel keeps 15 bytes of a process name. */
const COMM_MAX = 15;

const isLetter = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c);

/** term occurs in name with a non-letter (or the edge) on both sides. */
function containsWord(name: string, term: string): boolean {
  for (let from = name.indexOf(term); from >= 0; from = name.indexOf(term, from + 1)) {
    if (!isLetter(name[from - 1]) && !isLetter(name[from + term.length])) return true;
  }
  return false;
}

/** Mirrors commTermMatches in internal/ebpf/trace_policy_comm.go (term and name lower-cased). */
export function commTermMatches(mode: CommMatchMode, term: string, name: string): boolean {
  if (mode === 'exact') return name === term || (term.length > COMM_MAX && name === term.slice(0, COMM_MAX));
  if (mode === 'word') return containsWord(name, term);
  return name.includes(term);
}

/**
 * Mirrors PolicyEngine.matchPolicy (internal/ebpf/trace_policy.go) for the
 * editor preview: event type (any listed, case-insensitive), minimum
 * severity, comm terms under match_comm_mode (execve also matches the
 * executed file's basename), filename substring terms, exact uid,
 * destination port list. The enabled flag is ignored (the preview answers
 * "would it match").
 */
export function policyMatchesEvent(policy: Pick<PolicyDraft, 'event_types' | 'min_severity' | 'match_comm' | 'match_filename' | 'match_uid' | 'match_dest_port'> & { match_comm_mode?: CommMatchMode }, event: TraceEvent): boolean {
  if (policy.event_types.length > 0 && !policy.event_types.some((t) => t.toLowerCase() === (event.event_name ?? '').toLowerCase())) return false;
  if (policy.min_severity && policy.min_severity !== 'info') {
    if (severityRank(event.severity_name || event.severity) < severityRank(policy.min_severity)) return false;
  }
  const commTerms = matchTerms(policy.match_comm);
  if (commTerms.length > 0) {
    const mode = policy.match_comm_mode ?? 'substring';
    const comm = (event.comm ?? '').toLowerCase();
    const exec = ['execve', 'execveat'].includes((event.event_name ?? '').toLowerCase());
    const file = exec && event.filename ? basename(event.filename).toLowerCase() : '';
    if (!commTerms.some((t) => commTermMatches(mode, t, comm) || (file !== '' && commTermMatches(mode, t, file)))) return false;
  }
  const fileTerms = matchTerms(policy.match_filename);
  if (fileTerms.length > 0) {
    const filename = (event.filename ?? '').toLowerCase();
    if (!fileTerms.some((t) => filename.includes(t))) return false;
  }
  if (policy.match_uid !== null && policy.match_uid !== undefined && event.uid !== policy.match_uid) return false;
  const ports = (policy.match_dest_port ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (ports.length > 0 && !ports.some((p) => /^\d+$/.test(p) && Number(p) <= 65535 && Number(p) === event.port)) return false;
  return true;
}

export interface MatchPreview {
  matched: number;
  sampled: number;
  processes: Array<{ comm: string; count: number }>;
}

/** How many of `events` the draft matches, and by which processes. */
export function previewMatches(policy: PolicyDraft, events: readonly TraceEvent[], top = 5): MatchPreview {
  const byProcess = new Map<string, number>();
  let matched = 0;
  for (const event of events) {
    if (!policyMatchesEvent(policy, event)) continue;
    matched += 1;
    const comm = event.comm || 'unknown';
    byProcess.set(comm, (byProcess.get(comm) ?? 0) + 1);
  }
  const processes = [...byProcess.entries()]
    .map(([comm, count]) => ({ comm, count }))
    .sort((a, b) => b.count - a.count || a.comm.localeCompare(b.comm))
    .slice(0, top);
  return { matched, sampled: events.length, processes };
}

export interface DraftValidation {
  name?: string;
  match_uid?: string;
  match_dest_port?: string;
}

export function validatePolicyDraft(draft: PolicyDraft): DraftValidation {
  const errors: DraftValidation = {};
  if (!draft.name.trim()) errors.name = 'Enter a policy name.';
  if (draft.match_uid !== null && draft.match_uid !== undefined && (!Number.isSafeInteger(draft.match_uid) || draft.match_uid < 0)) {
    errors.match_uid = 'UID must be a whole number of 0 or more.';
  }
  const ports = (draft.match_dest_port ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (ports.some((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535)) {
    errors.match_dest_port = 'Enter ports from 1 to 65535, separated by commas.';
  }
  return errors;
}

/** Kernel enforcement cannot evaluate these matches; the agent runs the rule in userspace. */
export function kernelWillDowngrade(draft: Pick<PolicyDraft, 'kernel_enforce' | 'match_comm' | 'match_filename' | 'match_uid'>): boolean {
  return draft.kernel_enforce && (Boolean(draft.match_comm?.trim()) || Boolean(draft.match_filename?.trim()) || (draft.match_uid !== null && draft.match_uid !== undefined));
}

/** Kill without a narrowing match needs kill_acknowledged (server guard). */
export function needsKillAcknowledgement(draft: Pick<PolicyDraft, 'action' | 'match_comm' | 'match_filename' | 'match_uid' | 'match_dest_port' | 'match_dest_ip'>): boolean {
  return draft.action === 'kill' && !policyHasNarrowingMatch(draft);
}

/** Confirmation tier for saving `draft` (typed for an enabled kill/block policy). */
export function policySaveTier(draft: Pick<PolicyDraft, 'action' | 'enabled'>): ConfirmTier {
  return tierForPolicySave({ action: draft.action, enabled: draft.enabled });
}

/** Where a saved policy is enforced, as reported by the agent. */
export function policyPlacement(policy: Pick<EnforcementPolicy, 'action' | 'auto_downgraded' | 'kernel_enforce'>): { label: string; help: string } {
  if (policy.action === 'block') return { label: 'Kernel BPF-LSM', help: 'Execution is denied (-EPERM) in the kernel before the program starts.' };
  if (policy.auto_downgraded) return { label: 'Userspace (downgraded)', help: 'Kernel enforcement was requested, but the process, file or UID match cannot be evaluated in the kernel. The agent enforces it in userspace, one ring-buffer round trip later.' };
  if (policy.kernel_enforce) return { label: 'Kernel', help: 'Loaded into the kernel enforcement map; the action is applied before the event reaches userspace.' };
  return { label: 'Userspace', help: 'The agent evaluates the rule after reading the event; supports every match but adds a short delay.' };
}

/** Human summary of a policy's match criteria. */
export function policyMatchSummary(policy: Pick<EnforcementPolicy, 'event_types' | 'match_comm' | 'match_comm_mode' | 'match_filename' | 'match_uid' | 'match_dest_port' | 'match_dest_ip'>): string[] {
  const out: string[] = [];
  if (policy.event_types?.length) out.push(policy.event_types.length <= 3 ? `events: ${policy.event_types.join(', ')}` : `${policy.event_types.length} event types`);
  if (policy.match_comm) {
    const mode = policy.match_comm_mode ?? 'substring';
    out.push(mode === 'word' ? `process: ${policy.match_comm}` : `process (${mode}): ${policy.match_comm}`);
  }
  if (policy.match_filename) out.push(`file: ${policy.match_filename}`);
  if (policy.match_uid !== null && policy.match_uid !== undefined) out.push(`uid: ${policy.match_uid}`);
  if (policy.match_dest_port) out.push(`port: ${policy.match_dest_port}`);
  if (policy.match_dest_ip) out.push(`IP: ${policy.match_dest_ip}`);
  return out.length ? out : ['every event'];
}

/** Enabled kill/block policies (disabling tracing removes their enforcement). */
export function hasEnforcingPolicies(policies: ReadonlyArray<Pick<EnforcementPolicy, 'action' | 'enabled'>>): boolean {
  return policies.some((p) => p.enabled && isEnforcingAction(p.action));
}

/** Event types the configuration captures (an empty list means all of `all`). */
export function capturedEventTypes(config: Pick<TraceConfig, 'event_types'>, all: readonly string[]): Set<string> {
  return new Set(config.event_types?.length ? config.event_types : all);
}

/**
 * Confirmation tier for saving the trace configuration:
 * - disabling tracing while kill/block policies are enabled leaves enforce
 *   (typed); otherwise disabling tracing needs a simple confirmation;
 * - capturing less (higher minimum severity, fewer event types, filtering the
 *   agent's own events) lowers protection (simple);
 * - anything else needs none.
 */
export function traceConfigSaveTier(previous: TraceConfig, next: TraceConfig, allEventTypes: readonly string[], enforcing: boolean): ConfirmTier {
  const tiers: ConfirmTier[] = [];
  if (previous.enabled && !next.enabled) tiers.push(enforcing ? tierFor('leave-enforce') : tierFor('disable-tracing'));
  if (next.enabled) {
    if (severityRank(next.min_severity || 'info') < severityRank(previous.min_severity || 'info')) {
      // captures more: no confirmation
    } else if (severityRank(next.min_severity || 'info') > severityRank(previous.min_severity || 'info')) {
      tiers.push(tierFor('lower-protection'));
    }
    const before = capturedEventTypes(previous, allEventTypes);
    const after = capturedEventTypes(next, allEventTypes);
    if ([...before].some((t) => !after.has(t))) tiers.push(tierFor('lower-protection'));
  }
  return strictestTier(...tiers);
}

/** What a trace configuration change stops capturing, for the confirmation text. */
export function traceConfigLosses(previous: TraceConfig, next: TraceConfig, allEventTypes: readonly string[]): string[] {
  const out: string[] = [];
  if (previous.enabled && !next.enabled) return ['all runtime events, incidents and policy enforcement on this host'];
  if (severityRank(next.min_severity || 'info') > severityRank(previous.min_severity || 'info')) out.push(`events below ${next.min_severity} severity`);
  const after = capturedEventTypes(next, allEventTypes);
  const dropped = [...capturedEventTypes(previous, allEventTypes)].filter((t) => !after.has(t));
  if (dropped.length) out.push(dropped.length <= 6 ? `event types ${dropped.join(', ')}` : `${dropped.length} event types`);
  return out;
}
