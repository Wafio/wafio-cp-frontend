/**
 * Confirmation tiers.
 *
 * typed , the operator types the resource name (or the given phrase) before
 *          the action runs: irreversible, disconnects protection, or can lock
 *          operators out of a host.
 * simple, one confirm dialog: the action changes enforcement but is easy to
 *          undo.
 * none  , no dialog: the action creates a draft or a copy.
 *
 * Pages ask `tierFor(action)` instead of deciding per button, so the same
 * action is guarded the same way on every screen. Unknown actions fall back
 * to 'simple', never to 'none'.
 */

export type ConfirmTier = 'typed' | 'simple' | 'none';

export const CONFIRM_TIERS = {
  // Typed: delete host/app/route, revoke host or credential,
  // Deny-All, disabling the firewall or leaving enforce, kill/block policies.
  'delete-host': 'typed',
  'delete-app': 'typed',
  'delete-route': 'typed',
  'revoke-host': 'typed',
  'revoke-credential': 'typed',
  'deny-all': 'typed',
  'disable-firewall': 'typed',
  'leave-enforce': 'typed',
  'enable-kill-policy': 'typed',
  'enable-block-policy': 'typed',
  'save-kill-policy': 'typed',
  'save-block-policy': 'typed',
  // Same impact class as the other typed actions: the project and every
  // resource in it disappear; a rotated key disconnects the running agent
  // until it is reinstalled; a deleted agent loses its history.
  'delete-project': 'typed',
  'rotate-host-key': 'typed',
  'delete-agent': 'typed',
  // One write fans out to many hosts: the operator types
  // the host count ("12 hosts") they are about to change.
  'apply-to-hosts': 'typed',
  'copy-runtime-to-hosts': 'typed',

  // Simple: enabling Allow/Block rules, lowering protection.
  'enable-allow-rule': 'simple',
  'enable-block-rule': 'simple',
  'lower-protection': 'simple',
  'enable-firewall': 'simple',
  'enter-enforce': 'simple',
  // Reversible removals and changes: re-adding restores the previous state.
  'delete-custom-rule': 'simple',
  'delete-detection-rule': 'simple',
  'delete-correlation-rule': 'simple',
  'delete-policy': 'simple',
  'remove-ip-rule': 'simple',
  'remove-port-rule': 'simple',
  'remove-member': 'simple',
  'change-member-role': 'simple',
  'revoke-invite': 'simple',
  'unassign-agent': 'simple',
  'unblock-client': 'simple',
  'clear-enforcement-log': 'simple',
  'rollback-config': 'simple',
  'reset-config': 'simple',
  'discard-changes': 'simple',
  'resolve-incident': 'simple',
  // Ends every session of the user, this one too; signing in again restores access.
  'logout-all': 'simple',
  // Creates a live invitation link: one confirm so Enter in the form
  // never creates it by accident; revoking it undoes it.
  'create-invitation': 'simple',
  // Labels are selection metadata: editing them never changes enforcement.
  'edit-host-labels': 'simple',

  // None: clone, drafts.
  clone: 'none',
  'create-draft': 'none',
  'save-draft': 'none',
  'import-as-draft': 'none',
  'acknowledge-incident': 'none',
} as const satisfies Record<string, ConfirmTier>;

export type ConfirmAction = keyof typeof CONFIRM_TIERS;

/** The confirmation tier for an action; unknown actions need a simple confirm. */
export function tierFor(action: ConfirmAction | (string & {})): ConfirmTier {
  return (CONFIRM_TIERS as Record<string, ConfirmTier>)[action] ?? 'simple';
}

export function needsConfirmation(action: ConfirmAction | (string & {})): boolean {
  return tierFor(action) !== 'none';
}

/**
 * Typed confirmation matches when the input equals the expected phrase after
 * trimming surrounding whitespace. Case and inner whitespace must match: the
 * point is that the operator reads the name of what they are destroying.
 */
export function typedConfirmationMatches(input: string | null | undefined, expected: string): boolean {
  const phrase = expected.trim();
  return phrase.length > 0 && (input ?? '').trim() === phrase;
}

// ── Change-based tiers ─────────────────────────────────────────────────────
// Some saves are only dangerous for particular transitions. These helpers
// map a before/after pair to the strictest tier the change requires.

const RANK: Record<ConfirmTier, number> = { none: 0, simple: 1, typed: 2 };

/** The stricter of two tiers. */
export function strictestTier(...tiers: ConfirmTier[]): ConfirmTier {
  return tiers.reduce<ConfirmTier>((a, b) => (RANK[b] > RANK[a] ? b : a), 'none');
}

/** Runtime enforcement policy actions that can stop or block processes. */
export const ENFORCING_POLICY_ACTIONS = ['kill', 'block'] as const;

/**
 * Tier for saving or enabling a runtime (trace) enforcement policy: every
 * save or enable of a kill or block policy that ends up enabled
 * needs the typed confirmation, including the status toggle and re-saving an
 * already enabled policy, since either changes live enforcement. Disabling a
 * policy or saving a non-enforcing one needs none.
 */
export function tierForPolicySave(next: { action: string; enabled: boolean }): ConfirmTier {
  const enforcing = (ENFORCING_POLICY_ACTIONS as readonly string[]).includes(next.action);
  if (!enforcing || !next.enabled) return 'none';
  return tierFor(next.action === 'kill' ? 'save-kill-policy' : 'save-block-policy');
}

/** Firewall global switches (EBPFGlobalConfig subset). */
export interface FirewallModeState {
  enabled: boolean;
  monitor_only: boolean;
}

/**
 * Tier for a firewall Enabled / Monitor Only change:
 * disabling the firewall or leaving enforce (enforce → monitor only) is
 * typed; enabling it or entering enforce is simple; no change is none.
 */
export function tierForFirewallMode(previous: FirewallModeState, next: FirewallModeState): ConfirmTier {
  const tiers: ConfirmTier[] = [];
  if (previous.enabled && !next.enabled) tiers.push(tierFor('disable-firewall'));
  if (!previous.enabled && next.enabled) tiers.push(tierFor('enable-firewall'));
  const wasEnforcing = previous.enabled && !previous.monitor_only;
  const isEnforcing = next.enabled && !next.monitor_only;
  if (wasEnforcing && next.enabled && next.monitor_only) tiers.push(tierFor('leave-enforce'));
  if (!wasEnforcing && isEnforcing) tiers.push(tierFor('enter-enforce'));
  return strictestTier(...tiers);
}

/** Port-policy defaults (EBPFPortPolicyConfig subset). */
export interface PortPolicyDefaults {
  enabled: boolean;
  default_ingress: string;
  default_egress: string;
}

/**
 * Tier for a port-policy configuration change: switching a default to
 * "deny" while the policy is enabled (Deny-All) is typed; enabling the
 * policy with a deny default is typed too; other changes are simple.
 */
export function tierForPortPolicyConfig(previous: PortPolicyDefaults, next: PortPolicyDefaults): ConfirmTier {
  const denies = (cfg: PortPolicyDefaults, direction: 'default_ingress' | 'default_egress') => cfg.enabled && cfg[direction] === 'deny';
  const newDeny = (['default_ingress', 'default_egress'] as const).some((direction) => denies(next, direction) && !denies(previous, direction));
  if (newDeny) return tierFor('deny-all');
  const changed = previous.enabled !== next.enabled || previous.default_ingress !== next.default_ingress || previous.default_egress !== next.default_egress;
  return changed ? 'simple' : 'none';
}

/** WAF protection mode of an application route. */
export type ProtectionMode = 'block' | 'monitor';

/** Switching an application from block to monitor lowers protection. */
export function tierForProtectionMode(previous: ProtectionMode | string, next: ProtectionMode | string): ConfirmTier {
  if (previous === 'block' && next !== 'block') return tierFor('lower-protection');
  return 'none';
}
