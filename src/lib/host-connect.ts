/**
 * "Connect this host".
 *
 * Primary path (host-key enrollment): one installer command per agent
 * (`host-agent`, optional `waf-agent`) that generates the private key on the
 * host, enrolls it with the host key at `<url>/api/internal/host-enroll` and
 * writes nothing unless the returned CA matches `--ca-sha256`.
 *
 * Fallback (manual): the interactive installer with a project-wide
 * credential: its answers (from GET /agent-connect-info, the host key and an
 * optional fresh credential), the gRPC server-name notice, and the manual
 * env file + systemd unit.
 *
 * The network interface is never guessed: manual setups get the
 * placeholder `<interface>` and the command that names it.
 *
 * Pure functions: no Svelte, no API client.
 */

import type { AgentConnectInfo, AgentEnrollmentLimits } from './api';
import { credentialService, HOST_AGENT_PATHS } from './credential-service';

export const INSTALLER_URL = 'https://wafio.cloud/install.sh';

/** Downloads the installer, then runs it for the host agent (it prompts on the terminal). */
export const INSTALLER_COMMAND = `curl -fsSL ${INSTALLER_URL} -o wafio-install.sh && sudo bash wafio-install.sh host-agent`;

export const INTERFACE_PLACEHOLDER = '<interface>';
/** Prints the default route; its `dev` field is the interface to protect. */
export const INTERFACE_HINT_COMMAND = 'ip route show default';

/** Placeholders shown until the operator has a value. */
export const ENDPOINT_PLACEHOLDER = '<control-plane-host>:9090';
export const HOST_KEY_PLACEHOLDER = '<host key>';

/** Host part of `host:port` or `[v6]:port`; the whole value when it has no port. */
export function endpointHost(endpoint: string): string {
  const value = endpoint.trim();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (v6) return v6[1];
  const colon = value.lastIndexOf(':');
  if (colon > 0 && value.indexOf(':') === colon) return value.slice(0, colon);
  return value;
}

/** The installer accepts `host:port` only (`^[^[:space:]]+:[0-9]+$`). */
export function endpointError(endpoint: string): string | null {
  const value = endpoint.trim();
  if (!value) return 'Enter the control plane’s gRPC address, e.g. cp.example.com:9090.';
  if (!/^[^\s]+:[0-9]+$/.test(value)) return 'Use host:port, e.g. cp.example.com:9090.';
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'The port must be between 1 and 65535.';
  return null;
}

/** Removes characters that would start a new line or end a C string in a file or command. */
export function stripControl(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

export const DEFAULT_GRPC_PORT = '9090';

/** Name suffixes that only resolve inside one network. */
export const INTERNAL_SUFFIXES = ['.internal', '.local', '.lan', '.localdomain', '.home', '.corp', '.intranet'] as const;

/** IPv4 dotted quad or an IPv6 literal (with or without brackets). */
export function isIpLiteral(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.split('.').every((p) => Number(p) <= 255);
  return h.includes(':') && /^[0-9a-f:.]+$/i.test(h);
}

/**
 * Whether other hosts can probably reach this name: an IP literal, or a
 * dotted name outside the internal-only suffixes. `localhost`, single-label
 * names and `*.internal` / `*.local` / … are not.
 */
export function looksPublicHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (isIpLiteral(h)) return true;
  if (!h.includes('.')) return false;
  return !INTERNAL_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/** Port of `host:port` / `[v6]:port`, or null. */
export function endpointPort(endpoint: string): string | null {
  const value = endpoint.trim();
  const v6 = /^\[[^\]]+\]:(\d+)$/.exec(value);
  if (v6) return v6[1];
  const colon = value.lastIndexOf(':');
  if (colon > 0 && value.indexOf(':') === colon && /^\d+$/.test(value.slice(colon + 1))) return value.slice(colon + 1);
  return null;
}

export interface EndpointSuggestion {
  /** Prefill of "Address agents use to reach the control plane". */
  endpoint: string;
  /** `public`: the control plane's own `grpc_endpoint`; otherwise why it was replaced by the dashboard's host name. */
  reason: 'public' | 'missing' | 'internal';
}

/**
 * The address to prefill: `grpc_endpoint` when its host looks reachable
 * from other machines, else the host name this dashboard is opened on with
 * the gRPC port (of `grpc_endpoint`, else 9090).
 */
export function suggestEndpoint(grpcEndpoint: string | null | undefined, pageHostname: string): EndpointSuggestion {
  const given = stripControl((grpcEndpoint ?? '').trim());
  if (given && looksPublicHost(endpointHost(given))) return { endpoint: given, reason: 'public' };
  let host = stripControl(pageHostname.trim());
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const port = (given && endpointPort(given)) || DEFAULT_GRPC_PORT;
  return { endpoint: host ? `${host}:${port}` : '', reason: given ? 'internal' : 'missing' };
}

/**
 * Manual path: appends the server name to the env file and restarts the
 * agent. The enrollment installer writes WAFIO_GRPC_SERVER_NAME itself (from
 * `--server-name` or the name the control plane returns); this is for a
 * manual install or an agent set up by an older installer.
 */
export function serverNameCommand(serverName: string): string {
  const line = `WAFIO_GRPC_SERVER_NAME=${stripControl(serverName)}`.replace(/'/g, `'\\''`);
  return `echo '${line}' | sudo tee -a ${HOST_AGENT_PATHS.envFile} >/dev/null && sudo systemctl restart wafio-host-agent`;
}

export interface ServerNameNotice {
  /** The agent must be told the certificate name (`WAFIO_GRPC_SERVER_NAME`). */
  needed: boolean;
  /** `server.grpc_domain` is not set on the control plane. */
  domainMissing: boolean;
  /** Line for /etc/wafio/host-agent.env. */
  envLine: string;
}

/**
 * Whether the agent needs `WAFIO_GRPC_SERVER_NAME`: when the gRPC
 * certificate's name differs from the host the agent dials, or the control
 * plane has no `server.grpc_domain` (its certificate then names localhost).
 */
export function serverNameNotice(info: Pick<AgentConnectInfo, 'grpc_server_name' | 'grpc_domain_configured'>, endpoint: string): ServerNameNotice {
  const host = endpointHost(endpoint).toLowerCase();
  const name = (info.grpc_server_name ?? '').trim();
  const differs = Boolean(name) && host !== name.toLowerCase();
  return {
    needed: differs || !info.grpc_domain_configured,
    domainMissing: !info.grpc_domain_configured,
    envLine: `WAFIO_GRPC_SERVER_NAME=${stripControl(name) || 'localhost'}`,
  };
}

export interface InstallerAnswer {
  /** The installer's question, as it prints it. */
  prompt: string;
  value: string;
  /** A real value (copyable) or only a placeholder that tells what to paste. */
  known: boolean;
  secret?: boolean;
  multiline?: boolean;
}

export interface CredentialPem {
  ca_cert: string;
  client_cert: string;
  client_key: string;
}

/**
 * The installer's questions in order (scripts/install.sh host-agent): gRPC
 * address, host key, then three pasted PEM blocks (a blank line ends each).
 */
export function installerAnswers(opts: { endpoint: string; hostKey?: string | null; credential?: CredentialPem | null }): InstallerAnswer[] {
  const endpoint = stripControl(opts.endpoint.trim());
  const cred = opts.credential ?? null;
  return [
    { prompt: 'Control plane gRPC address (host:9090)', value: endpoint || ENDPOINT_PLACEHOLDER, known: Boolean(endpoint) && !endpointError(endpoint) },
    { prompt: 'Host key (shown on the Hosts page)', value: opts.hostKey || HOST_KEY_PLACEHOLDER, known: Boolean(opts.hostKey), secret: true },
    { prompt: 'CA certificate', value: cred?.ca_cert ?? '<CA certificate of the credential (ca.crt)>', known: Boolean(cred), multiline: true },
    { prompt: 'client certificate', value: cred?.client_cert ?? '<client certificate of the credential (client.crt)>', known: Boolean(cred), multiline: true },
    { prompt: 'client private key', value: cred?.client_key ?? '<client private key of the credential (client.key)>', known: Boolean(cred), secret: true, multiline: true },
  ];
}

/**
 * /etc/wafio/host-agent.env for a manual install. Values are written as
 * given; newlines are removed so one value cannot add a variable.
 */
export function manualEnvFile(opts: { endpoint: string; serverName?: string | null; hostKey?: string | null }): string {
  const clean = (v: string) => v.replace(/[\r\n\0]/g, '');
  const certs = HOST_AGENT_PATHS.certsDir;
  const lines = [
    `WAFIO_GRPC_SERVER=${clean(opts.endpoint.trim() || ENDPOINT_PLACEHOLDER)}`,
    ...(opts.serverName ? [`WAFIO_GRPC_SERVER_NAME=${clean(opts.serverName)}`] : []),
    `WAFIO_GRPC_CA_CERT=${certs}/ca.crt`,
    `WAFIO_GRPC_CLIENT_CERT=${certs}/client.crt`,
    `WAFIO_GRPC_CLIENT_KEY=${certs}/client.key`,
    `WAFIO_HOST_KEY=${clean(opts.hostKey || HOST_KEY_PLACEHOLDER)}`,
    `# The interface to protect: the "dev" of \`${INTERFACE_HINT_COMMAND}\`.`,
    `WAFIO_INTERFACE=${INTERFACE_PLACEHOLDER}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** The manual systemd unit (same flags and paths as the installer's). */
export function manualUnit(opts: { agentName: string; endpoint: string; serverName?: string | null }): string {
  return credentialService(opts.agentName, opts.endpoint.trim(), 'host', { serverName: opts.serverName ?? undefined });
}

/** Shell steps that place the manual files (run as root on the host). */
export function manualSteps(): string {
  const certs = HOST_AGENT_PATHS.certsDir;
  return [
    `install -d -m 0700 ${certs}`,
    `# Put ca.crt, client.crt and client.key of the credential in ${certs}/ (client.key mode 0600).`,
    `install -m 0600 host-agent.env ${HOST_AGENT_PATHS.envFile}`,
    'install -m 0644 wafio-host-agent.service /etc/systemd/system/wafio-host-agent.service',
    'systemctl daemon-reload && systemctl enable --now wafio-host-agent',
  ].join('\n');
}

/** After a key rotation: what to change on the host. */
export function rotatedKeySteps(hostKey: string): string {
  const key = hostKey.replace(/[\r\n\0]/g, '');
  return [
    `# In ${HOST_AGENT_PATHS.envFile}, replace the WAFIO_HOST_KEY line with:`,
    `WAFIO_HOST_KEY=${key}`,
    '# then restart every agent on the host, e.g.:',
    'sudo systemctl restart wafio-host-agent',
  ].join('\n');
}

/** Credential name for "Create a credential for this host". */
export function hostCredentialName(hostName: string): string {
  return `host-${hostName}`.slice(0, 64);
}

// ─── One-command enrollment ─────────────────────────────────────────────────

/** Used when GET /agent-connect-info has no `enrollment` (older control plane). */
export const ENROLL_DEFAULTS: AgentEnrollmentLimits = { window_hours: 24, max_credentials_per_host: 4, cert_validity_days: 365 };

/** The server's enrollment limits, each falling back to ENROLL_DEFAULTS. */
export function enrollLimits(info: Pick<AgentConnectInfo, 'enrollment'> | null | undefined): AgentEnrollmentLimits {
  const e = info?.enrollment;
  const pick = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    window_hours: pick(e?.window_hours, ENROLL_DEFAULTS.window_hours),
    max_credentials_per_host: pick(e?.max_credentials_per_host, ENROLL_DEFAULTS.max_credentials_per_host),
    cert_validity_days: pick(e?.cert_validity_days, ENROLL_DEFAULTS.cert_validity_days),
  };
}

export const DASHBOARD_URL_PLACEHOLDER = '<dashboard URL>';

/** Single-quotes a value for sh/bash (`'` becomes `'\''`); CR, LF and NUL are removed. */
export function shellQuote(value: string): string {
  return `'${stripControl(value).replace(/'/g, `'\\''`)}'`;
}

/** The installer allows plain http:// only for these hosts. */
export const LOOPBACK_URL_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/** Trimmed URL without trailing slashes (the installer appends /api/internal/host-enroll). */
export function normalizeDashboardUrl(url: string): string {
  return stripControl(url.trim()).replace(/\/+$/, '');
}

/**
 * `--url` check, as strict as the installer: https://, or http:// only for
 * 127.0.0.1, localhost or [::1]; no credentials, query or fragment.
 */
export function dashboardUrlError(url: string): string | null {
  const value = normalizeDashboardUrl(url);
  const example = 'Enter a full address, e.g. https://wafio.example.com.';
  if (!value) return 'Enter the address hosts use to reach this dashboard, e.g. https://wafio.example.com.';
  if (/\s/.test(value)) return 'The address cannot contain spaces.';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return example;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return example;
  }
  if (!parsed.hostname) return example;
  if (parsed.username || parsed.password) return 'Remove the user name and password from the address.';
  if (value.includes('?') || value.includes('#')) return 'Remove the query (?…) and fragment (#…) from the address.';
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:') {
    return LOOPBACK_URL_HOSTS.includes(parsed.hostname.toLowerCase())
      ? null
      : 'Use https://. The installer accepts http:// only for 127.0.0.1, localhost or [::1].';
  }
  return 'The address must start with https://.';
}

/** Suggested `--agent-name` of the WAF agent on a host. */
export function suggestWafAgentName(hostName: string): string {
  return `${stripControl(hostName.trim())}@waf`;
}

export type EnrollAgentKind = 'host' | 'waf';

export interface EnrollCommandOptions {
  kind: EnrollAgentKind;
  /** HTTP base the host reaches the control plane on (`--url`). */
  dashboardUrl: string;
  /** SHA-256 of the agent CA (`--ca-sha256`), mandatory. */
  caSha256: string;
  /** Only when known; without it the installer prompts for the key without echo. */
  hostKey?: string | null;
  /** Omit for the host agent unless set (the installer defaults to `<hostname>@ebpf`). */
  agentName?: string | null;
  /** `--control-plane host:port`: only when the server has no `grpc_endpoint` or the operator overrode it. */
  endpoint?: string | null;
  /** `--server-name`: only when the operator sets one. */
  serverName?: string | null;
}

/**
 * The enrollment install command. Every value is single-quoted; arguments
 * go on their own lines with `\` continuations. A known host key is piped to
 * the installer on stdin (`printf … | sudo bash … --host-key-stdin`), never
 * passed as an argument: an argument shows in `ps` and in sudo's log, where
 * anyone who reads it could enroll with the key during its window.
 * `printf` is a shell builtin, so the key never becomes a process argument.
 */
export function enrollCommand(opts: EnrollCommandOptions): string {
  const mode = opts.kind === 'waf' ? 'waf-agent' : 'host-agent';
  const url = normalizeDashboardUrl(opts.dashboardUrl) || DASHBOARD_URL_PLACEHOLDER;
  const key = stripControl((opts.hostKey ?? '').trim());
  const args: string[] = [`--url ${shellQuote(url)}`, `--ca-sha256 ${shellQuote(opts.caSha256.trim())}`];
  const add = (flag: string, value: string | null | undefined) => {
    const v = stripControl((value ?? '').trim());
    if (v) args.push(`${flag} ${shellQuote(v)}`);
  };
  add('--agent-name', opts.agentName);
  add('--control-plane', opts.endpoint);
  add('--server-name', opts.serverName);
  const run = key
    ? `printf '%s\\n' ${shellQuote(key)} | sudo bash wafio-install.sh ${mode} --host-key-stdin`
    : `sudo bash wafio-install.sh ${mode}`;
  return [`curl -fsSL ${INSTALLER_URL} -o wafio-install.sh && ${run}`, ...args].join(' \\\n  ');
}

export type EnrollWindow = { open: true; expiresAt: Date; remainingMs: number } | { open: false };

/** Whether the host key can still enroll at `now` (null, invalid or past = closed). */
export function enrollWindowState(expiresAt: string | null | undefined, now: number | Date = Date.now()): EnrollWindow {
  if (!expiresAt) return { open: false };
  const end = Date.parse(expiresAt);
  const at = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(end) || end <= at) return { open: false };
  return { open: true, expiresAt: new Date(end), remainingMs: end - at };
}
