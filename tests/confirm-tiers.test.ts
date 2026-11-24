import { describe, expect, test } from 'bun:test';
import {
  CONFIRM_TIERS,
  needsConfirmation,
  strictestTier,
  tierFor,
  tierForFirewallMode,
  tierForPolicySave,
  tierForPortPolicyConfig,
  tierForProtectionMode,
  typedConfirmationMatches,
} from '../src/lib/confirm-tiers';

describe('confirmation tier table', () => {
  test('typed: destructive, disconnecting or lockout-prone actions', () => {
    for (const action of ['delete-host', 'delete-app', 'delete-route', 'revoke-host', 'revoke-credential', 'deny-all', 'disable-firewall', 'leave-enforce', 'enable-kill-policy', 'save-kill-policy'] as const) {
      expect(tierFor(action)).toBe('typed');
    }
  });

  test('simple: enabling allow/block rules and lowering protection', () => {
    for (const action of ['enable-allow-rule', 'enable-block-rule', 'lower-protection', 'enable-maintenance', 'switch-https-mode'] as const) {
      expect(tierFor(action)).toBe('simple');
    }
  });

  test('none: clones and drafts', () => {
    for (const action of ['clone', 'create-draft', 'save-draft', 'import-as-draft'] as const) {
      expect(tierFor(action)).toBe('none');
      expect(needsConfirmation(action)).toBe(false);
    }
  });

  test('unknown actions still ask', () => {
    expect(tierFor('something-new')).toBe('simple');
    expect(needsConfirmation('something-new')).toBe(true);
  });

  test('every table entry is a valid tier', () => {
    for (const tier of Object.values(CONFIRM_TIERS)) expect(['typed', 'simple', 'none']).toContain(tier);
  });
});

describe('typed confirmation', () => {
  test('exact phrase after trimming the ends', () => {
    expect(typedConfirmationMatches(' web-01 ', 'web-01')).toBe(true);
    expect(typedConfirmationMatches('WEB-01', 'web-01')).toBe(false);
    expect(typedConfirmationMatches('web 01', 'web-01')).toBe(false);
    expect(typedConfirmationMatches('', '')).toBe(false);
    expect(typedConfirmationMatches(undefined, 'web-01')).toBe(false);
  });

  test('strictest tier wins', () => {
    expect(strictestTier()).toBe('none');
    expect(strictestTier('none', 'simple')).toBe('simple');
    expect(strictestTier('simple', 'typed', 'none')).toBe('typed');
  });
});

describe('runtime policy saves', () => {
  test('kill policies need typed confirmation whenever they end up enabled', () => {
    expect(tierForPolicySave({ action: 'kill', enabled: true })).toBe('typed');
  });
  test('disabled or non-enforcing policies need none', () => {
    expect(tierForPolicySave({ action: 'kill', enabled: false })).toBe('none');
    expect(tierForPolicySave({ action: 'alert', enabled: true })).toBe('none');
    expect(tierForPolicySave({ action: 'simulate', enabled: true })).toBe('none');
    // A policy still stored as block by an older control plane enforces nothing.
    expect(tierForPolicySave({ action: 'block', enabled: true })).toBe('none');
  });
});

describe('firewall mode', () => {
  const enforce = { enabled: true, monitor_only: false };
  const monitor = { enabled: true, monitor_only: true };
  const off = { enabled: false, monitor_only: false };

  test('disabling or leaving enforce is typed', () => {
    expect(tierForFirewallMode(enforce, off)).toBe('typed');
    expect(tierForFirewallMode(monitor, off)).toBe('typed');
    expect(tierForFirewallMode(enforce, monitor)).toBe('typed');
  });
  test('enabling or entering enforce is simple', () => {
    expect(tierForFirewallMode(off, monitor)).toBe('simple');
    expect(tierForFirewallMode(off, enforce)).toBe('simple');
    expect(tierForFirewallMode(monitor, enforce)).toBe('simple');
  });
  test('no change needs none', () => {
    expect(tierForFirewallMode(enforce, enforce)).toBe('none');
    expect(tierForFirewallMode(off, { enabled: false, monitor_only: true })).toBe('none');
  });
});

describe('port policy (Deny-All)', () => {
  const allow = { enabled: true, default_ingress: 'allow', default_egress: 'allow' };
  test('a new deny default is typed', () => {
    expect(tierForPortPolicyConfig(allow, { ...allow, default_ingress: 'deny' })).toBe('typed');
    expect(tierForPortPolicyConfig({ ...allow, enabled: false, default_egress: 'deny' }, { ...allow, default_egress: 'deny' })).toBe('typed');
  });
  test('other changes are simple, none when unchanged', () => {
    expect(tierForPortPolicyConfig({ ...allow, default_ingress: 'deny' }, allow)).toBe('simple');
    expect(tierForPortPolicyConfig(allow, { ...allow, enabled: false })).toBe('simple');
    expect(tierForPortPolicyConfig(allow, allow)).toBe('none');
  });
});

describe('protection and rules', () => {
  test('block → monitor lowers protection', () => {
    expect(tierForProtectionMode('block', 'monitor')).toBe('simple');
    expect(tierForProtectionMode('monitor', 'block')).toBe('none');
  });
});
