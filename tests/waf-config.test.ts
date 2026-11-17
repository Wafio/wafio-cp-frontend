import { expect, test } from 'bun:test';
import { effectLogsOnly, mergeWafRules, serializeSemanticPolicy, validateWebSocketConfig } from '../src/lib/waf-config';

test('unrelated edits preserve advanced policy fields and unknown nested config', () => {
 const rules = { future: { version: 2 }, ssrf_blocklist_path: '/etc/list', semantic_policies: { sql: { method_threshold: { POST: { block: 8 } }, route_threshold: { '/login': { soft: 4 } }, method_risk: { POST: 2 }, future: true }, ldap: { base_score: 33 } }, geo: { future: 7 } };
 const result = mergeWafRules(rules, { geo: { allow_ips: ['127.0.0.1'] }, semantic_policies: { sql: { disabled: true } } });
 expect(result.semantic_policies.sql).toEqual({ ...rules.semantic_policies.sql, disabled: true });
 expect(result.semantic_policies.ldap).toEqual(rules.semantic_policies.ldap);
 expect(result.geo.future).toBe(7);
 expect(result.ssrf_blocklist_path).toBe('/etc/list');
 expect(rules.semantic_policies.sql).not.toHaveProperty('disabled');
});
test('a semantic policy serializes its thresholds and the switch, and keeps unknown keys', () => {
 expect(serializeSemanticPolicy({ method_risk: { POST: 2 } }, 4, 2.5, true)).toEqual({ method_risk: { POST: 2 }, block_threshold: 4, soft_threshold: 2.5, disabled: true });
});

test('WebSocket form rejects unsafe origins and limits before save', () => {
 const base = { enabled: true, origin_check: { enabled: true, allowed_origins: ['https://app.test'] }, limits: { max_text_bytes: 0, max_binary_bytes: 0, max_messages_per_min: 0 }, scan_server_frames: false, scan_binary_hashes: false };
 expect(validateWebSocketConfig(base)).toBeNull();
 expect(validateWebSocketConfig({ ...base, origin_check: { enabled: true, allowed_origins: [] } })).toContain('allowed origin');
 expect(validateWebSocketConfig({ ...base, origin_check: { enabled: true, allowed_origins: ['https://app.test/path'] } })).toContain('origin');
 expect(validateWebSocketConfig({ ...base, origin_check: { enabled: true, allowed_origins: ['https://app.test:'] } })).toContain('origin');
 expect(validateWebSocketConfig({ ...base, limits: { ...base.limits, max_text_bytes: -1 } })).toContain('max_text_bytes');
});

test('a tuning effect holds blocks back as LOG by its action or by a weaken of version 1 that lowered scores', () => {
 expect(effectLogsOnly({ action: 'log' })).toBe(true);
 expect(effectLogsOnly({ weaken: { score_multiplier: 0.5 } })).toBe(true);
 expect(effectLogsOnly({ weaken: { threshold_delta: { block: 20 } } })).toBe(true);
 expect(effectLogsOnly({ weaken: { score_multiplier: 0.5, threshold_delta: { block: 20, log: 5 } } })).toBe(true);
 for (const effect of [undefined, null, {}, { skip_semantic: ['sql'] }, { action: 'block' }, { weaken: {} }, { weaken: 7 },
   { weaken: { score_multiplier: 1 } }, { weaken: { score_multiplier: 2 } }, { weaken: { score_multiplier: 0 } },
   { weaken: { threshold_delta: { log: 30 } } }, { weaken: { threshold_delta: { block: -10 } } }, { weaken: { sensitivity_delta: -1 } }]) {
   expect(effectLogsOnly(effect)).toBe(false);
 }
});
