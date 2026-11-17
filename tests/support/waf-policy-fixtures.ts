/** Fixtures for the WAF policy form tests. */
import { readFileSync } from 'node:fs';
import type { Json } from '../../src/lib/components/waf-policy/model';

/** What the control plane reports of its engine package (tests/fixtures/backend/defaults.json). */
function backendDefaults() {
  const file = new URL('../fixtures/backend/defaults.json', import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as { default_rules: Json };
}

/** The defaults new projects start with (engine.DefaultRulesJSON). */
export function goDefaultRules(): Json {
  return backendDefaults().default_rules;
}

/**
 * The default document of version 1 (what a project created then still holds): the default document of today plus the
 * thresholds, the base score of every engine and category, the switch of the removed rule engine, the seven categories no
 * engine reads, and a confidence and a sensitivity on every category. Values are those of the version 1 default. It has no
 * challenge template_version: the control plane stamps that on a save.
 */
export function v1DefaultRules(): Json {
  const categoryScores: Record<string, [number, number, number]> = {
    LFI: [180, 0.9, 1], PHP: [190, 0.85, 1], RCE: [200, 0.9, 1], RFI: [180, 0.85, 1], SSRF: [180, 0.9, 1], XSS: [150, 0.85, 1],
    Java: [190, 0.85, 1], SQLi: [180, 0.9, 1], Method: [60, 0.95, 1], Generic: [160, 0.8, 2], Python: [190, 0.85, 1],
    Scanner: [70, 0.8, 2], Protocol: [80, 0.7, 2], Multipart: [120, 0.8, 1], ProtocolAttack: [100, 0.75, 2], SessionFixation: [140, 0.85, 2]
  };
  const categories: Json = {};
  for (const [name, [base, confidence, sensitivity]] of Object.entries(categoryScores)) {
    categories[name] = { base_score: base, confidence, sensitivity };
  }
  const today = goDefaultRules();
  const sp = today.semantic_policies as Record<string, Json>;
  const engineScores: Record<string, number> = { nosql: 180, ssti: 190, xxe: 180, deser: 190 };
  const semantic: Json = {};
  for (const [key, value] of Object.entries(sp)) semantic[key] = key in engineScores ? { ...value, base_score: engineScores[key] } : value;
  semantic.ldap = { base_score: 180 };
  semantic.proto_pollution = { base_score: 185 };
  const { template_version: _stamped, ...challenge } = today.challenge as Json;
  return { ...today, challenge, thresholds: { log: 80, block: 150 }, semantic_policies: { skip_coraza_when_clean: true, ...semantic }, categories };
}

/** A config that sets every field the form manages to a non-default value (the shape the form saves). */
export function fullRules(): Json {
  return {
    future_top_level: { kept: true },
    geo: { allow_ips: ['10.0.0.0/8', '2001:db8::1'], block_ips: ['203.0.113.7'], allow_countries: ['ID', 'SG'], block_countries: ['RU'], future: 7 },
    siem: { enabled: true, webhook_url: 'https://siem.example.test/hook?token=abc' },
    block_policy: { enabled: false, block_after_n_blocks: 7, block_duration_sec: 900, key_fields: ['remote_addr', 'header:X-Api-Key'] },
    request_body_limit: '512K',
    content_scan: { enabled: true, mode: 'log', on_incomplete: 'block', max_scan_size_bytes: 2097152, scan_multipart: false, scan_raw_body: true, custom_blocklist_hashes: ['a'.repeat(64)], custom_allowlist_hashes: ['b'.repeat(64)] },
    l7_flood: { enabled: true, max_requests: 250, window_sec: 30, key_fields: ['remote_addr', 'user_agent'], allow_ips: ['198.51.100.10', '10.0.0.0/8'] },
    ssrf: { ssrf_blocklist: ['.internal', '169.254.169.254'], ssrf_blocklist_path: '/etc/wafio/ssrf.txt', future: 'x' },
    bot_protection: {
      enabled: true, mode: 'score', base_score: 120, score_threshold: 200, empty_ua_block: true, ua_blocklist: ['curl', 'python-requests/\\d+'], ua_allowlist: ['Googlebot'],
      ja4_blocklist: ['t13d1516h2_8daaf6152771_e562703ab859'], ja4_allowlist: ['t13d1516h2_8daaf6152771_b92d69e0f5f8'],
      ja3_blocklist: ['e7d705a3286e19ea42f587b344ee6865'], ja3_allowlist: ['0123456789abcdef0123456789abcdef'],
      header_checks: false, client_hints_check: false, browser_impersonation_check: false, block_ai_crawlers: true, future: 1
    },
    challenge: {
      enabled: true, type: 'turnstile', site_key: 'site-key', secret_key: 'super-secret', cookie_ttl_sec: 7200, trigger: 'on_bot_detect', simulation: true,
      ip_rep_enabled: true, ip_rep_block_level1: false, ip_rep_block_level2: true, allow_local_ips: false, good_bot_allowlist: ['Googlebot', 'bingbot'],
      custom_js_challenge_html: '<p>js</p>', custom_click_puzzle_html: '<p>click</p>', custom_ip_rep_block_html: '<p>rep</p>', custom_block_html: '<p>block</p>',
      custom_policy_block_html: '<p>policy</p>', custom_geo_block_html: '<p>geo</p>', waf_block_format: 'json', policy_block_format: 'xml', geo_block_format: 'json', ip_rep_block_format: 'xml',
      custom_waf_block_json: '{"b":1}', custom_policy_block_json: '{"p":1}', custom_geo_block_json: '{"g":1}', custom_ip_rep_block_json: '{"r":1}',
      custom_waf_block_xml: '<b/>', custom_policy_block_xml: '<p/>', custom_geo_block_xml: '<g/>', custom_ip_rep_block_xml: '<r/>', template_version: 3
    },
    semantic_policies: {
      inspection_off: true, scan_all_headers: false, record_weak_detections: false,
      sql: { block_threshold: 5, soft_threshold: 3, disabled: true, method_threshold: { POST: { block: 8 } }, route_threshold: { '/login': { soft: 4 } } },
      xss: { block_threshold: 4.2, soft_threshold: 2.4 },
      nosql: { block_threshold: 3.5, soft_threshold: 1.25 },
      ssti: { block_threshold: 3, soft_threshold: 1.8, disabled: true },
      ldap: { disabled: true },
      proto_pollution: { disabled: true }
    },
    websocket: { enabled: false, origin_check: { enabled: true, allowed_origins: ['https://app.example.test'] }, limits: { max_text_bytes: 4096, max_binary_bytes: 65536, max_messages_per_min: 30, future_limit: 1 }, scan_server_frames: true, scan_binary_hashes: true },
    path_exceptions: [
      {
        path: '/api/editor', match: 'prefix', case_insensitive: false, disabled: true, comment: 'rich text',
        future_rule_key: { kept: 1 },
        semantic_override: { xss: { block_threshold: 6, soft_threshold: 3, disabled: false, method_risk: { POST: 2 } }, ldap: { disabled: true }, future_engine: { x: 1 } },
        ip_rules: { mode: 'blocklist', ips: ['198.51.100.0/24'] },
        block: { status: 451, message: 'legal' },
        rate_limit: { max_requests: 5, window_sec: 10 },
        body_size_limit: 1048576,
        login_protection: { enabled: true, max_attempts: 4, window_sec: 120, lockout_sec: 600, by_ip: false, by_user_agent: true, identifier_field: 'username', methods: ['POST'], future: 'lp' },
        field_rules: [{ field: 'password', source: 'body.json', action: 'encrypt_aes', aes_key: 'c'.repeat(64), methods: ['POST', 'PUT'] }, { field: 'token', source: 'header', action: 'mask' }],
        response_decrypt_aes: 'd'.repeat(64),
        response_field_rules: [{ field: 'data.secret', action: 'decrypt_aes', aes_key: 'e'.repeat(64) }],
        tuning: { target: null, effect: { skip_semantic: ['xss'], action: 'log' } }
      },
      { path: '^/v[0-9]+/upload$', match: 'regex', inspection_off: true }
    ]
  };
}

/**
 * A v1 document: the keys the version 1 agent read and the form no longer has, and the old inspection pair. The rest
 * of it is what the form manages. Saving it must drop those keys without an error and keep everything else.
 */
export function v1Rules(): Json {
  const names = ['Method', 'Scanner', 'Protocol', 'Multipart', 'RFI', 'Generic', 'SessionFixation', 'ProtocolAttack', 'LFI', 'RCE', 'PHP', 'SSRF', 'Python', 'XSS', 'SQLi', 'Java'];
  const categories = Object.fromEntries(names.map((name, i) => [name, { base_score: 100 + i, sensitivity: (i % 3) + 1, confidence: 0.5 }]));
  // A category switched off in v1 used the default score for its engine.
  categories.SQLi = { base_score: 7, sensitivity: 2, confidence: 0.9, disabled: true };
  return {
    future_top_level: { kept: true },
    thresholds: { log: 70, block: 170 },
    categories: { ...categories, FutureCategory: { base_score: 10 } },
    // A lone disable_rule_based has no effect: inspection is on.
    semantic_policies: {
      skip_coraza_when_clean: true, disable_rule_based: true, on_uninspected: 'log',
      sql: { block_threshold: 5, soft_threshold: 3 },
      nosql: { block_threshold: 3, soft_threshold: 1.5, base_score: 250 },
      ldap: { base_score: 210 },
      jwt: { base_score: 0 }
    },
    path_exceptions: [
      {
        path: '/api/editor',
        match: 'prefix',
        // A lone disable_semantic is inspection off.
        disable_semantic: true,
        semantic_override: { sql: { block_threshold: 6, soft_threshold: 3, base_score: 90 }, graphql: { base_score: 0 } },
        rule_override: { block_threshold: 300, log_threshold: 200, categories: { XSS: { base_score: 50, sensitivity: 3, confidence: 0.4 } } },
        tuning: { target: { components: ['query:q'], match: 'exact' }, effect: { skip_crs: ['941100', 'tag:attack-xss'], skip_semantic: ['xss'], weaken: { score_multiplier: 0.5 } } }
      },
      { path: '/legacy', match: 'exact', disable_rule_based: true, tuning: { effect: { weaken: { score_multiplier: 2, threshold_delta: { log: 30 } } } } },
      // The version 1 pair: both keys, inspection off.
      { path: '/pair', match: 'prefix', disable_semantic: true, disable_rule_based: true }
    ]
  };
}
