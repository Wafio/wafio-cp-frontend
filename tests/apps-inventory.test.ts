// Application and WAF agent inventory helpers.
import { describe, expect, test } from 'bun:test';
import type { AgentRoute } from '../src/lib/api';
import {
  APP_STATE_TEXT,
  agentDeleteError,
  appState,
  bindingIndex,
  isAgentOnlineRefusal,
  routeSummary,
  validateAgentName,
  wafAgentInstall,
} from '../src/lib/components/apps/inventory';

function route(over: Partial<AgentRoute> = {}): AgentRoute {
  return {
    app_id: 'app-1',
    name: 'shop',
    listen_host: '0.0.0.0',
    listen_port: 8080,
    upstream: 'http://127.0.0.1:3000',
    mode: 'block',
    ...over,
  };
}

describe('bindings', () => {
  test('index every route by application id with its agent', () => {
    const index = bindingIndex([
      { agent: { id: 'a1', name: 'edge-1', is_online: true }, routes: [route(), route({ app_id: 'app-2', mode: 'monitor' })] },
      { agent: { id: 'a2', name: 'edge-2', is_online: false }, routes: [route({ app_id: 'app-3' })] },
    ]);
    expect(index.size).toBe(3);
    expect(index.get('app-1')).toMatchObject({ agentId: 'a1', agentName: 'edge-1', online: true, mode: 'block' });
    expect(index.get('app-2')?.mode).toBe('monitor');
    expect(index.get('app-3')).toMatchObject({ agentId: 'a2', online: false });
  });

  test('the first agent wins when two report the same application', () => {
    const index = bindingIndex([
      { agent: { id: 'a1', name: 'edge-1', is_online: true }, routes: [route()] },
      { agent: { id: 'a2', name: 'edge-2', is_online: true }, routes: [route()] },
    ]);
    expect(index.get('app-1')?.agentId).toBe('a1');
  });
});

describe('application state', () => {
  test('assigned apps show their mode; Block mode never uses the ALLOW tone', () => {
    expect(appState({ upstream_url: null, listen_port: null }, { mode: 'block' })).toBe('block');
    expect(appState({ upstream_url: 'http://x', listen_port: 80 }, { mode: 'monitor' })).toBe('monitor');
    expect(APP_STATE_TEXT.block.tone).toBe('mode-block');
    expect(APP_STATE_TEXT.monitor.tone).toBe('mode-monitor');
    for (const state of Object.values(APP_STATE_TEXT)) expect(['allow', 'log', 'block']).not.toContain(state.tone);
  });

  test('unassigned apps are routed or drafts', () => {
    expect(appState({ upstream_url: 'http://127.0.0.1:3000', listen_port: 8080 })).toBe('unassigned');
    expect(appState({ upstream_url: 'http://127.0.0.1:3000', listen_port: null })).toBe('draft');
    expect(appState({ upstream_url: '  ', listen_port: 8080 })).toBe('draft');
  });

  test('route summary', () => {
    expect(routeSummary('0.0.0.0', 8080, 'http://127.0.0.1:3000')).toBe('0.0.0.0:8080 → http://127.0.0.1:3000');
    expect(routeSummary('', 9000, 'fcgi:unix:/run/php.sock')).toBe('0.0.0.0:9000 → FastCGI unix:/run/php.sock');
    expect(routeSummary('::1', 8443, 'https://api')).toBe('[::1]:8443 → https://api');
    expect(routeSummary(null, null, 'http://x')).toBe('no listen port → http://x');
    expect(routeSummary(null, null, null)).toBeNull();
  });
});

describe('agent delete', () => {
  test('only a 409 AGENT_ONLINE offers the forced retry', () => {
    expect(isAgentOnlineRefusal({ status: 409, code: 'AGENT_ONLINE', error: 'online', hint: 'stop it' })).toBe(true);
    expect(isAgentOnlineRefusal({ status: 409, code: 'CONFLICT', error: 'x' })).toBe(false);
    expect(isAgentOnlineRefusal({ status: 403, error: 'x' })).toBe(false);
    expect(isAgentOnlineRefusal(undefined)).toBe(false);
  });

  test('messages name the role and the missing agent', () => {
    expect(agentDeleteError({ status: 403, error: 'forbidden' })).toContain('member or owner');
    expect(agentDeleteError({ status: 404, error: 'not found' })).toContain('no longer exists');
    expect(agentDeleteError({ status: 500, error: 'Internal error' })).toBe('Internal error');
  });
});

describe('registration', () => {
  test('the install steps use the installer and name what it asks for', () => {
    const cmd = wafAgentInstall('waf-edge-1', 'cp.example.com');
    expect(cmd).toContain('sudo bash install.sh');
    expect(cmd).toContain('#   control plane address  cp.example.com:9090');
    expect(cmd).toContain('#   agent name             waf-edge-1');
    expect(cmd).toContain('/etc/wafio/certs/waf/');
    expect(wafAgentInstall('a', '').split('\n').some((line) => line.includes('wafio.example.com:9090'))).toBe(true);
  });

  test('no flag an agent does not have is shown, and the agent is not started by hand', () => {
    const cmd = wafAgentInstall('waf-edge-1', 'cp.example.com');
    for (const flag of ['--security-data-dir', '--geo-country-db', '--host-key', 'wafio-waf-agent']) expect(cmd).not.toContain(flag);
  });

  test('a name with control characters cannot end the comment line', () => {
    const cmd = wafAgentInstall('edge\nrm -rf /', 'cp');
    expect(cmd.split('\n').filter((line) => !line.startsWith('#') && !line.startsWith('sudo bash install.sh'))).toEqual([]);
  });

  test('agent names', () => {
    expect(validateAgentName('  ')).toBeTruthy();
    expect(validateAgentName('x'.repeat(65))).toBeTruthy();
    expect(validateAgentName('waf-edge-1')).toBeNull();
  });
});
