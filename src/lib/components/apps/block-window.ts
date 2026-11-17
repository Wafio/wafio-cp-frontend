/**
 * Block window grouping: the agent reports one entry per (key, path,
 * reason); the table shows one row per blocked key.
 */
import type { BlockWindowEntry, UnblockOperation } from '../../api';

export interface BlockGroup {
  key: string;
  keyType: string;
  reasons: string[];
  pathCount: number;
  firstPath: string;
  /** Latest block time of the group. */
  blockedAt: string;
  /** Latest expiry of the group. */
  expiresAt: string;
  ids: string[];
  /** Blocked by Login Protection or Block Policy (not a single rule hit). */
  persistent: boolean;
  /** Most relevant unblock status of the group: pending first, then failures. */
  unblock: UnblockOperation['status'] | null;
  /** Distinct unblock commands of the group (id, status, error), for the operator. */
  operations: UnblockOperation[];
}

const PERSISTENT = new Set(['LoginProtection', 'BlockPolicy']);
const UNBLOCK_RANK: Record<UnblockOperation['status'], number> = { pending: 5, failed: 4, timeout: 3, superseded: 2, applied: 1 };

function later(a: string, b: string): string {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

export function groupBlockEntries(entries: readonly BlockWindowEntry[]): BlockGroup[] {
  const groups = new Map<string, BlockGroup>();
  for (const e of entries) {
    const status = e.unblock?.status ?? null;
    const g = groups.get(e.key);
    if (!g) {
      groups.set(e.key, {
        key: e.key,
        keyType: e.key_type,
        reasons: [e.reason],
        pathCount: 1,
        firstPath: e.path,
        blockedAt: e.blocked_at,
        expiresAt: e.expires_at,
        ids: [e.id],
        persistent: PERSISTENT.has(e.reason),
        unblock: status,
        operations: e.unblock ? [e.unblock] : [],
      });
      continue;
    }
    if (!g.reasons.includes(e.reason)) g.reasons.push(e.reason);
    g.pathCount++;
    g.blockedAt = later(g.blockedAt, e.blocked_at);
    g.expiresAt = later(g.expiresAt, e.expires_at);
    g.ids.push(e.id);
    if (PERSISTENT.has(e.reason)) g.persistent = true;
    if (status && (!g.unblock || UNBLOCK_RANK[status] > UNBLOCK_RANK[g.unblock])) g.unblock = status;
    if (e.unblock && !g.operations.some((op) => op.command_id === e.unblock?.command_id)) g.operations.push(e.unblock);
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.blockedAt) - Date.parse(a.blockedAt) || a.key.localeCompare(b.key));
}

/** One line per unblock command: "failed · agent unreachable (command c1)". */
export function unblockOperationText(op: UnblockOperation): string {
  const detail = op.error ? ` · ${op.error}` : '';
  return `${op.status}${detail} (command ${op.command_id})`;
}

export function reasonLabel(reason: string): string {
  if (reason === 'LoginProtection') return 'Login protection';
  if (reason === 'BlockPolicy') return 'Block policy';
  return reason;
}
