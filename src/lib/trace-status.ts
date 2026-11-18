// Runtime-security trace status fields for protected processes and the
// kill-candidate priority ring, as GET /host/trace/status
// passes them through from the host agent. Older agents omit them.
import type { TraceStatus } from './api';
import { formatNumber } from './format';

export type PriorityRingState = 'not-reported' | 'inactive' | 'active';

export function priorityRingState(s: TraceStatus | null | undefined): PriorityRingState {
  if (!s || typeof s.priority_ring !== 'boolean') return 'not-reported';
  return s.priority_ring ? 'active' : 'inactive';
}

/** "Active · 12 routed · 0 overflowed · 0 lost", or a state label. */
export function priorityRingSummary(s: TraceStatus | null | undefined): string {
  const state = priorityRingState(s);
  if (state === 'not-reported') return 'Not reported';
  if (state === 'inactive') return 'Unavailable (eBPF object predates the priority ring)';
  return `Active · ${formatNumber(s?.priority_events_routed ?? 0)} routed · ${formatNumber(s?.priority_events_full ?? 0)} overflowed · ${formatNumber(s?.priority_events_lost ?? 0)} lost`;
}

/** Kill candidates lost with both rings full: a userspace kill policy may not have fired. */
export function killCandidatesLost(s: TraceStatus | null | undefined): number {
  const n = s?.priority_events_lost;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Protected-process summary; "Not reported" for agents without the fields. */
export function protectedSummary(s: TraceStatus | null | undefined): string {
  if (!s || typeof s.protected_kernel_set !== 'boolean') return 'Not reported';
  if (!s.protected_kernel_set) return 'Userspace only (kernel set unavailable)';
  const refused = s.protected_fork_refused ?? 0;
  const base = `Kernel set · ${formatNumber(s.protected_tgids ?? 0)} processes`;
  return refused > 0 ? `${base} · ${formatNumber(refused)} forks not inserted` : base;
}

function count(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** "the last hour", "the last 2 hours", "the last 30 minutes". */
function windowLabel(sec: number): string {
  if (sec % 3600 === 0) return sec === 3600 ? 'the last hour' : `the last ${sec / 3600} hours`;
  const min = Math.max(1, Math.round(sec / 60));
  return min === 1 ? 'the last minute' : `the last ${min} minutes`;
}

export interface TraceLossNotice {
  tone: 'warning' | 'info';
  title: string;
  detail: string;
}

/**
 * The Runtime security loss notice. Agents that report recent loss: a warning when
 * process, security, MEDIUM+ or enforced events, or accesses of sensitive files, were lost in the
 * window, a note when only noise (other file/network events below MEDIUM) was dropped, nothing once the window is clean, a one-off
 * burst no longer marks the host incomplete until the agent restarts. Older agents: every loss
 * since the agent started, as before.
 */
export function traceLossNotice(s: TraceStatus | null | undefined): TraceLossNotice | null {
  if (!s) return null;
  if (typeof s.loss_window_sec === 'number' && s.loss_window_sec > 0) {
    const window = windowLabel(s.loss_window_sec);
    const significant = count(s.recent_lost_significant);
    const watched = count(s.recent_lost_watched);
    const noise = count(s.recent_lost_noise);
    if (significant > 0 || watched > 0) {
      const parts = [
        significant > 0 ? `${formatNumber(significant)} process, security, medium or higher, or enforced` : '',
        watched > 0 ? `${formatNumber(watched)} accesses of sensitive files below medium` : '',
      ].filter(Boolean);
      return {
        tone: 'warning',
        title: 'Incomplete runtime visibility',
        detail: `${formatNumber(significant + watched + noise)} events lost in ${window}, including ${parts.join(' and ')}. Missing activity is not shown.`,
      };
    }
    if (noise > 0) {
      return {
        tone: 'info',
        title: 'Low-severity events dropped',
        detail: `${formatNumber(noise)} file or network events below medium were dropped in ${window} while the agent caught up. Process, security, medium and higher, enforced events and accesses of sensitive files were kept.`,
      };
    }
    return null;
  }
  if (s.kernel_events_dropped == null || s.queue_dropped == null) return null;
  const total = s.kernel_events_dropped + s.queue_dropped;
  return total > 0
    ? { tone: 'warning', title: 'Incomplete runtime visibility', detail: `${formatNumber(total)} events lost since the agent started. Missing activity is not shown.` }
    : null;
}

function classes(significant: number | undefined, watched: number | undefined): string {
  return `${formatNumber(count(significant))} significant, ${formatNumber(count(watched))} sensitive-file`;
}

/**
 * Loss since the agent started, by place: "kernel 0 · send queue 4,594 (0 significant, 0 sensitive-file) ·
 * unconfirmed batches 0 (0 significant, 0 sensitive-file)"; older agents: the total; null when not reported.
 */
export function traceLossBreakdown(s: TraceStatus | null | undefined): string | null {
  if (!s || s.kernel_events_dropped == null || s.queue_dropped == null) return null;
  if (typeof s.loss_window_sec !== 'number') return formatNumber(s.kernel_events_dropped + s.queue_dropped);
  const delivery = count(s.delivery_lost_noise) + count(s.delivery_lost_watched) + count(s.delivery_lost_significant);
  return [
    `kernel ${formatNumber(s.kernel_events_dropped)}`,
    `send queue ${formatNumber(s.queue_dropped)} (${classes(s.queue_dropped_significant, s.queue_dropped_watched)})`,
    `unconfirmed batches ${formatNumber(delivery)} (${classes(s.delivery_lost_significant, s.delivery_lost_watched)})`,
  ].join(' · ');
}
