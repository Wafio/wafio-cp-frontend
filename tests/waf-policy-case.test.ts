import { describe, expect, test } from 'bun:test';
import { effectiveCaseInsensitive, newPathRule, restrictsAccess, type PathRuleDraft } from '../src/lib/components/waf-policy/model';

// Mirrors TestPathExceptionCaseInsensitiveMatchMethod (engine): the automatic
// "Ignore case" value the path rule editor shows must be what the agent applies.
function rule(patch: Partial<PathRuleDraft>): PathRuleDraft {
  return { ...newPathRule(), ...patch };
}

describe('path rule case folding (mirrors engine CaseInsensitiveMatch)', () => {
  const limit = { maxRequests: 1, windowSec: 1 };
  const login = { enabled: true, maxAttempts: 3, windowSec: 60, lockoutSec: 300, byIp: true, byUserAgent: false, identifierField: '', methods: [] };
  test.each([
    ['inspection off', rule({ inspectionOff: true }), false],
    ['rate limit', rule({ rateLimit: limit }), true],
    ['body size limit', rule({ bodySizeLimit: 1024 }), true],
    ['login protection', rule({ loginProtection: login }), true],
    ['rate limit with inspection off', rule({ rateLimit: limit, inspectionOff: true }), false],
    ['block', rule({ block: { status: 403, message: '' } }), true],
    ['explicit false beats block', rule({ block: { status: 403, message: '' }, caseInsensitive: false }), false],
    ['explicit true', rule({ caseInsensitive: true }), true]
  ] as const)('%s', (_name, r, want) => {
    expect(effectiveCaseInsensitive(r)).toBe(want);
  });

  test('a limit-only rule applies on either path reading', () => {
    expect(restrictsAccess(rule({ bodySizeLimit: 1024 }))).toBe(true);
    expect(restrictsAccess(rule({ bodySizeLimit: 1024, inspectionOff: true }))).toBe(false);
    expect(restrictsAccess(rule({}))).toBe(false);
  });
});
