import { describe, expect, test } from 'bun:test';
import { auditActionTone, auditOutcomeTone, VERDICT_TONES } from '../src/lib/tone';

describe('auditActionTone', () => {
  test('creations are info, changes neutral, removals danger', () => {
    expect(auditActionTone('app.created')).toBe('info');
    expect(auditActionTone('credential.provisioned')).toBe('info');
    expect(auditActionTone('waf_config.updated')).toBe('neutral');
    expect(auditActionTone('credential.rotated')).toBe('neutral');
    expect(auditActionTone('app.deleted')).toBe('danger');
    expect(auditActionTone('credential.revoked')).toBe('danger');
    expect(auditActionTone('login')).toBe('neutral');
    expect(auditActionTone(undefined)).toBe('neutral');
  });

  test('never a verdict or the ALLOW/LOG generic colours', () => {
    const actions = ['app.created', 'member.added', 'incident.resolved', 'project.updated', 'policy.toggled', 'block.removed', 'x'];
    for (const action of actions) {
      const tone = auditActionTone(action) as string;
      expect((VERDICT_TONES as readonly string[]).includes(tone)).toBe(false);
      expect(['success', 'warning']).not.toContain(tone);
    }
  });
});

describe('auditOutcomeTone', () => {
  test('success is neutral, anything else danger; never success/warning or a verdict', () => {
    expect(auditOutcomeTone('success')).toBe('neutral');
    expect(auditOutcomeTone('Success')).toBe('neutral');
    expect(auditOutcomeTone('failure')).toBe('danger');
    expect(auditOutcomeTone(undefined)).toBe('danger');
    for (const outcome of ['success', 'failure', '']) {
      const tone = auditOutcomeTone(outcome) as string;
      expect((VERDICT_TONES as readonly string[]).includes(tone)).toBe(false);
      expect(['success', 'warning']).not.toContain(tone);
    }
  });
});
