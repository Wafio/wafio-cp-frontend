/**
 * MITRE ATT&CK mapping of runtime (trace) event names.
 *
 * SERVER_MITRE_BY_EVENT mirrors `mitreByEvent` in
 * internal/application/mitre_events.go of wafio-cp-backend, which the control plane
 * uses to group high/critical events into incidents (technique × process).
 * Keep the two in sync: the "suppress from incident" prefill reverses this
 * map to find the event names behind an incident's technique.
 *
 * MITRE_BY_EVENT_TYPE adds a few UI-only mappings used for policy MITRE
 * auto-fill and the heuristic tactic facet. They never create incidents.
 *
 * Every mapping here is a heuristic from the syscall name: it is review
 * context, not evidence of a technique.
 */

export interface MitreMapping {
  technique_id: string;
  tactic: string;
}

export const SERVER_MITRE_BY_EVENT: Readonly<Record<string, MitreMapping>> = {
  execve: { technique_id: 'T1059', tactic: 'Execution' },
  execveat: { technique_id: 'T1059', tactic: 'Execution' },
  clone: { technique_id: 'T1543', tactic: 'Persistence' },
  kill: { technique_id: 'T1489', tactic: 'Impact' },
  openat: { technique_id: 'T1083', tactic: 'Discovery' },
  unlink: { technique_id: 'T1485', tactic: 'Impact' },
  rename: { technique_id: 'T1222.002', tactic: 'Defense Evasion' },
  chmod: { technique_id: 'T1222.002', tactic: 'Defense Evasion' },
  chown: { technique_id: 'T1222.002', tactic: 'Defense Evasion' },
  connect: { technique_id: 'T1071', tactic: 'Command and Control' },
  accept: { technique_id: 'T1071', tactic: 'Command and Control' },
  bind: { technique_id: 'T1571', tactic: 'Command and Control' },
  socket: { technique_id: 'T1071', tactic: 'Command and Control' },
  listen: { technique_id: 'T1571', tactic: 'Command and Control' },
  setuid: { technique_id: 'T1548.001', tactic: 'Privilege Escalation' },
  setgid: { technique_id: 'T1548.001', tactic: 'Privilege Escalation' },
  ptrace: { technique_id: 'T1055.008', tactic: 'Defense Evasion' },
  mount: { technique_id: 'T1611', tactic: 'Privilege Escalation' },
  umount: { technique_id: 'T1611', tactic: 'Privilege Escalation' },
  finit_module: { technique_id: 'T1547.006', tactic: 'Persistence' },
  init_module: { technique_id: 'T1547.006', tactic: 'Persistence' },
  // Agent loss/shed reports: a flood that drops or sheds trace events hides activity.
  trace_events_lost: { technique_id: 'T1562.006', tactic: 'Defense Evasion' },
  trace_events_shed: { technique_id: 'T1562.006', tactic: 'Defense Evasion' },
};

const UI_ONLY_MITRE: Readonly<Record<string, MitreMapping>> = {
  mprotect: { technique_id: 'T1620', tactic: 'Defense Evasion' },
  memfd_create: { technique_id: 'T1620', tactic: 'Defense Evasion' },
  dup3: { technique_id: 'T1059', tactic: 'Execution' },
  pipe2: { technique_id: 'T1059', tactic: 'Execution' },
  prctl: { technique_id: 'T1055', tactic: 'Defense Evasion' },
};

export const MITRE_BY_EVENT_TYPE: Readonly<Record<string, MitreMapping>> = { ...SERVER_MITRE_BY_EVENT, ...UI_ONLY_MITRE };

const key = (name: string | null | undefined) => (name ?? '').trim().toLowerCase();

/** Heuristic mapping for one event name, or null. */
export function mitreForEvent(eventName: string | null | undefined): MitreMapping | null {
  return MITRE_BY_EVENT_TYPE[key(eventName)] ?? null;
}

/** Heuristic tactic of an event name, or null when unmapped. */
export function tacticForEvent(eventName: string | null | undefined): string | null {
  return mitreForEvent(eventName)?.tactic ?? null;
}

/** First mapping among `types` (policy MITRE auto-fill). */
export function mitreFromEventTypes(types: readonly string[] | null | undefined): MitreMapping | null {
  for (const type of types ?? []) {
    const mapping = mitreForEvent(type);
    if (mapping) return mapping;
  }
  return null;
}

/**
 * Event names the control plane groups under any of `techniques` when it
 * creates incidents (reverse of SERVER_MITRE_BY_EVENT), sorted.
 */
export function eventNamesForTechniques(techniques: readonly string[]): string[] {
  const wanted = new Set(techniques.map((t) => t.trim()).filter(Boolean));
  if (wanted.size === 0) return [];
  return Object.entries(SERVER_MITRE_BY_EVENT)
    .filter(([, mapping]) => wanted.has(mapping.technique_id))
    .map(([name]) => name)
    .sort();
}

/**
 * Event counts summed per heuristic tactic, largest first. Event names
 * without a mapping are left out.
 */
export function tacticBreakdown(eventCounts: Record<string, number> | null | undefined): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const [name, raw] of Object.entries(eventCounts ?? {})) {
    const tactic = tacticForEvent(name);
    const count = Number(raw);
    if (!tactic || !Number.isFinite(count) || count <= 0) continue;
    totals.set(tactic, (totals.get(tactic) ?? 0) + count);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
