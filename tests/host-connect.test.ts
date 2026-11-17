// "Connect this host" helpers (lib/host-connect.ts).
import { describe, expect, test } from 'bun:test';
import { credentialBinding, credentialService } from '../src/lib/credential-service';
import {
  ENROLL_DEFAULTS,
  INSTALLER_COMMAND,
  dashboardUrlError,
  enrollCommand,
  enrollLimits,
  enrollWindowState,
  shellQuote,
  suggestWafAgentName,
  INTERFACE_PLACEHOLDER,
  endpointError,
  endpointHost,
  installerAnswers,
  isIpLiteral,
  looksPublicHost,
  manualEnvFile,
  manualUnit,
  rotatedKeySteps,
  serverNameCommand,
  serverNameNotice,
  suggestEndpoint,
} from '../src/lib/host-connect';

describe('control plane address (demo review)', () => {
  test('public-name heuristic', () => {
    expect(looksPublicHost('cp.example.com')).toBe(true);
    expect(looksPublicHost('203.0.113.7')).toBe(true);
    expect(looksPublicHost('10.0.0.5')).toBe(true);
    expect(looksPublicHost('2001:db8::1')).toBe(true);
    expect(looksPublicHost('WAFioDemo.neo.internal')).toBe(false);
    for (const h of ['localhost', 'wafio', 'box.local', 'nas.lan', 'h.localdomain', 'r.home', 'x.corp', 'y.intranet', '']) expect(looksPublicHost(h)).toBe(false);
    expect(isIpLiteral('999.1.1.1')).toBe(false);
  });

  test('prefill keeps a public grpc_endpoint, else the dashboard host with the gRPC port', () => {
    expect(suggestEndpoint('cp.example.com:9090', 'dash.example.com')).toEqual({ endpoint: 'cp.example.com:9090', reason: 'public' });
    expect(suggestEndpoint('WAFioDemo.neo.internal:9443', 'demo.wafio.cloud')).toEqual({ endpoint: 'demo.wafio.cloud:9443', reason: 'internal' });
    expect(suggestEndpoint(null, 'demo.wafio.cloud')).toEqual({ endpoint: 'demo.wafio.cloud:9090', reason: 'missing' });
    expect(suggestEndpoint('localhost:9090', '::1').endpoint).toBe('[::1]:9090');
    expect(suggestEndpoint('localhost:9090', '[::1]').endpoint).toBe('[::1]:9090');
    expect(suggestEndpoint(null, 'a\nb').endpoint).toBe('ab:9090');
  });

  test('server name only when the dialled host differs; command, env file and unit follow the edited address', () => {
    const demo = { grpc_server_name: 'WAFioDemo.neo.internal', grpc_domain_configured: true };
    expect(serverNameNotice(demo, 'WAFioDemo.neo.internal:9090').needed).toBe(false);
    const n = serverNameNotice(demo, 'demo.wafio.cloud:9090');
    expect(n.needed).toBe(true);
    expect(n.envLine).toBe('WAFIO_GRPC_SERVER_NAME=WAFioDemo.neo.internal');
    expect(serverNameCommand('WAFioDemo.neo.internal')).toBe(
      "echo 'WAFIO_GRPC_SERVER_NAME=WAFioDemo.neo.internal' | sudo tee -a /etc/wafio/host-agent.env >/dev/null && sudo systemctl restart wafio-host-agent",
    );
    expect(serverNameCommand("a'b\r\n\0c")).toContain("WAFIO_GRPC_SERVER_NAME=a'\\''bc'");
    const env = manualEnvFile({ endpoint: 'demo.wafio.cloud:9090', serverName: 'WAFioDemo.neo.internal' });
    expect(env).toContain('WAFIO_GRPC_SERVER=demo.wafio.cloud:9090\nWAFIO_GRPC_SERVER_NAME=WAFioDemo.neo.internal\n');
    expect(manualUnit({ agentName: 'h', endpoint: 'demo.wafio.cloud:9090', serverName: 'WAFioDemo.neo.internal' })).toContain(
      '--grpc-server "demo.wafio.cloud:9090" --grpc-server-name "WAFioDemo.neo.internal"',
    );
    expect(manualUnit({ agentName: 'h', endpoint: 'cp.example.com:9090', serverName: null })).not.toContain('--grpc-server-name');
    expect(installerAnswers({ endpoint: 'demo.wafio.cloud:9090\r\n' })[0].value).toBe('demo.wafio.cloud:9090');
    expect(manualEnvFile({ endpoint: 'x:1\nEVIL=1', serverName: 'n\0\rm' })).toContain('WAFIO_GRPC_SERVER=x:1EVIL=1\nWAFIO_GRPC_SERVER_NAME=nm\n');
  });
});

const info = { grpc_endpoint: 'cp.example.com:9090', grpc_server_name: 'cp.example.com', grpc_domain_configured: true, ca_sha256: 'ab', control_plane_version: 'v1.7.3' };

describe('installer', () => {
  test('command downloads the installer and runs the host-agent mode', () => {
    expect(INSTALLER_COMMAND).toContain('https://wafio.cloud/install.sh');
    expect(INSTALLER_COMMAND).toContain('sudo bash wafio-install.sh host-agent');
  });

  test('answers in installer order: endpoint from connect info, key, three PEM blocks', () => {
    const answers = installerAnswers({ endpoint: info.grpc_endpoint, hostKey: 'wafh_secret', credential: { ca_cert: 'CA', client_cert: 'CERT', client_key: 'KEY' } });
    expect(answers.map((a) => a.value)).toEqual(['cp.example.com:9090', 'wafh_secret', 'CA', 'CERT', 'KEY']);
    expect(answers.every((a) => a.known)).toBe(true);
    const unknown = installerAnswers({ endpoint: '' });
    expect(unknown[0].known).toBe(false);
    expect(unknown[1].known).toBe(false);
    expect(unknown[4].known).toBe(false);
  });

  test('endpoint validation and host part', () => {
    expect(endpointError('cp.example.com:9090')).toBeNull();
    expect(endpointError('cp.example.com')).not.toBeNull();
    expect(endpointError('cp:70000')).not.toBeNull();
    expect(endpointHost('cp.example.com:9090')).toBe('cp.example.com');
    expect(endpointHost('[2001:db8::1]:9090')).toBe('2001:db8::1');
  });
});

describe('server name', () => {
  test('no notice when the certificate names the dialled host', () => {
    expect(serverNameNotice(info, 'cp.example.com:9090').needed).toBe(false);
  });
  test('notice when the endpoint host differs', () => {
    const n = serverNameNotice(info, '10.0.0.5:9090');
    expect(n.needed).toBe(true);
    expect(n.domainMissing).toBe(false);
    expect(n.envLine).toBe('WAFIO_GRPC_SERVER_NAME=cp.example.com');
  });
  test('missing grpc_domain warns and names localhost', () => {
    const n = serverNameNotice({ grpc_server_name: 'localhost', grpc_domain_configured: false }, '');
    expect(n.needed).toBe(true);
    expect(n.domainMissing).toBe(true);
    expect(n.envLine).toBe('WAFIO_GRPC_SERVER_NAME=localhost');
  });
});

describe('manual files', () => {
  test('env file: never eth0, interface placeholder, server name when given', () => {
    const env = manualEnvFile({ endpoint: 'cp.example.com:9090', serverName: 'cp.example.com', hostKey: 'wafh_k\nINJECT=1' });
    expect(env).not.toContain('eth0');
    expect(env).toContain(`WAFIO_INTERFACE=${INTERFACE_PLACEHOLDER}`);
    expect(env).toContain('WAFIO_GRPC_SERVER=cp.example.com:9090');
    expect(env).toContain('WAFIO_GRPC_SERVER_NAME=cp.example.com');
    expect(env).not.toContain('\nINJECT=1');
    expect(manualEnvFile({ endpoint: '' })).not.toContain('WAFIO_GRPC_SERVER_NAME');
  });

  test('unit: eBPF and trace on, installer object paths, geoip, server name, runtime dir', () => {
    const unit = manualUnit({ agentName: 'edge-1', endpoint: 'cp.example.com:9090', serverName: 'cp.example.com' });
    expect(unit).not.toContain('eth0');
    expect(unit).toContain('--ebpf=true --trace=true');
    expect(unit).toContain('--xdp-obj /opt/wafio/ebpf/wafio_xdp.o');
    expect(unit).toContain('--tc-obj /opt/wafio/ebpf/wafio_tc.o');
    expect(unit).toContain('--trace-obj /opt/wafio/ebpf/wafio_trace.o');
    expect(unit).toContain('--geoip-db /opt/wafio/security-data/geoip/country.mmdb');
    expect(unit).toContain('--grpc-server-name "cp.example.com"');
    expect(unit).toContain('--interface ${WAFIO_INTERFACE}');
    expect(unit).toContain('RuntimeDirectory=wafio');
    expect(unit).toContain('RuntimeDirectoryPreserve=yes');
  });

  test('values are escaped through credentialService', () => {
    const unit = manualUnit({ agentName: 'edge "1" %n $USER', endpoint: 'cp:9090', serverName: 'x"y' });
    expect(unit).toContain('"edge \\"1\\" %%n $$USER"');
    expect(unit).toContain('--grpc-server-name "x\\"y"');
    expect(unit).toBe(credentialService('edge "1" %n $USER', 'cp:9090', 'host', { serverName: 'x"y' }));
    expect(credentialService('h', 'cp:9090', 'host')).not.toContain('--grpc-server-name');
  });

  test('rotated key steps carry only the key line', () => {
    const steps = rotatedKeySteps('wafh_new\nX=1');
    expect(steps).toContain('WAFIO_HOST_KEY=wafh_newX=1');
    expect(steps).toContain('systemctl restart wafio-host-agent');
  });
});

describe('one-command enrollment', () => {
  const base = { dashboardUrl: 'https://wafio.example.com/', caSha256: 'ab12' };

  test('host agent: url, pinned CA, key piped on stdin, no --control-plane / --agent-name by default', () => {
    const cmd = enrollCommand({ ...base, kind: 'host', hostKey: 'wafh_secret' });
    expect(
      cmd.startsWith(
        "curl -fsSL https://wafio.cloud/install.sh -o wafio-install.sh && printf '%s\\n' 'wafh_secret' | sudo bash wafio-install.sh host-agent --host-key-stdin \\\n",
      ),
    ).toBe(true);
    expect(cmd).toContain("--url 'https://wafio.example.com'");
    expect(cmd).toContain("--ca-sha256 'ab12'");
    // Never an argument of the installer (ps, sudo's log).
    expect(cmd).not.toContain('--host-key ');
    expect(cmd).not.toContain('--control-plane');
    expect(cmd).not.toContain('--agent-name');
    expect(cmd).not.toContain('--server-name');
  });

  test('no key and no --host-key-stdin when the key is unknown (the installer prompts)', () => {
    for (const hostKey of [undefined, '  ']) {
      const cmd = enrollCommand({ ...base, kind: 'host', hostKey });
      expect(cmd).not.toContain('--host-key');
      expect(cmd).not.toContain('printf');
      expect(cmd.startsWith('curl -fsSL https://wafio.cloud/install.sh -o wafio-install.sh && sudo bash wafio-install.sh host-agent \\\n')).toBe(true);
    }
  });

  test('--control-plane and --server-name only when given', () => {
    const cmd = enrollCommand({ ...base, kind: 'host', endpoint: 'cp.example.com:9090', serverName: 'cp.internal' });
    expect(cmd).toContain("--control-plane 'cp.example.com:9090'");
    expect(cmd).toContain("--server-name 'cp.internal'");
    expect(enrollCommand({ ...base, kind: 'host', endpoint: null, serverName: '' })).not.toMatch(/--control-plane|--server-name/);
  });

  test('waf-agent variant with the suggested name', () => {
    expect(suggestWafAgentName('edge-1')).toBe('edge-1@waf');
    const cmd = enrollCommand({ ...base, kind: 'waf', agentName: suggestWafAgentName('edge-1') });
    expect(cmd).toContain('sudo bash wafio-install.sh waf-agent');
    expect(cmd).not.toContain('host-agent');
    expect(cmd).toContain("--agent-name 'edge-1@waf'");
  });

  test('quoting: single quote escaped, CR/LF/NUL stripped', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('a\r\nb\0c')).toBe("'abc'");
    const cmd = enrollCommand({ ...base, kind: 'waf', agentName: "o'brien\n--evil x", hostKey: 'k\r\n' });
    expect(cmd).toContain("--agent-name 'o'\\''brien--evil x'");
    expect(cmd).toContain("printf '%s\\n' 'k' | sudo bash wafio-install.sh waf-agent --host-key-stdin");
    // Only the line continuations break lines.
    for (const line of cmd.split('\n').slice(0, -1)) expect(line.endsWith(' \\')).toBe(true);
    // Head (with the piped key), --url, --ca-sha256, --agent-name.
    expect(cmd.split('\n')).toHaveLength(4);
  });

  test('dashboardUrlError: https ok, http only for loopback', () => {
    expect(dashboardUrlError('https://wafio.example.com')).toBeNull();
    expect(dashboardUrlError('https://wafio.example.com:8443/')).toBeNull();
    expect(dashboardUrlError('http://127.0.0.1:9087')).toBeNull();
    expect(dashboardUrlError('http://localhost:9087')).toBeNull();
    expect(dashboardUrlError('http://[::1]:9087')).toBeNull();
    expect(dashboardUrlError('http://wafio.example.com')).toContain('https://');
    expect(dashboardUrlError('http://10.0.0.5:9087')).not.toBeNull();
    expect(dashboardUrlError('http://127.0.0.2')).not.toBeNull();
    for (const bad of ['', '   ', 'wafio.example.com', 'not a url', 'ftp://x.example.com', 'https://', 'https://u:p@x.example.com', 'https://x.example.com/?a=1', 'https://x.example.com/#f']) {
      expect(dashboardUrlError(bad)).not.toBeNull();
    }
  });

  test('enrollment window state', () => {
    const now = Date.parse('2026-10-16T10:00:00Z');
    const open = enrollWindowState('2026-10-17T09:00:00Z', now);
    expect(open.open).toBe(true);
    if (open.open) expect(open.remainingMs).toBe(23 * 3600_000);
    expect(enrollWindowState('2026-10-16T10:00:00Z', now).open).toBe(false);
    expect(enrollWindowState('2026-10-15T10:00:00Z', new Date(now)).open).toBe(false);
    expect(enrollWindowState(null, now).open).toBe(false);
    expect(enrollWindowState(undefined, now).open).toBe(false);
    expect(enrollWindowState('garbage', now).open).toBe(false);
  });

  test('limits fall back to the defaults for older servers', () => {
    expect(enrollLimits(null)).toEqual(ENROLL_DEFAULTS);
    expect(ENROLL_DEFAULTS).toEqual({ window_hours: 24, max_credentials_per_host: 4, cert_validity_days: 365 });
    expect(enrollLimits({ enrollment: { window_hours: 12, max_credentials_per_host: 2, cert_validity_days: 90 } })).toEqual({ window_hours: 12, max_credentials_per_host: 2, cert_validity_days: 90 });
  });

  test('credential binding text', () => {
    expect(credentialBinding({})).toBe('Project-wide');
    expect(credentialBinding({ host_id: 'h1', host_name: 'edge-1', agent_kind: 'host', agent_name: 'edge-1@ebpf' })).toBe('Host edge-1 · host agent edge-1@ebpf');
    expect(credentialBinding({ host_id: 'h1', host_name: 'edge-1', agent_kind: 'waf', agent_name: 'edge-1@waf' })).toBe('Host edge-1 · WAF agent edge-1@waf');
  });
});
