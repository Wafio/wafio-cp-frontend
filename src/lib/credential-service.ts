// systemd expands percent specifiers and shell-style variable references even
// in quoted ExecStart arguments. Escape both before interpolating user data.
const argument = (value: string) => '"' + value.replace(/[\r\n\0]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$') + '"';
/** Paths the installer (scripts/install.sh host-agent) writes; the manual unit uses the same. */
export const HOST_AGENT_PATHS = {
  ebpfDir: '/opt/wafio/ebpf',
  geoipDb: '/opt/wafio/security-data/geoip/country.mmdb',
  certsDir: '/etc/wafio/certs/host',
  envFile: '/etc/wafio/host-agent.env',
} as const;

/**
 * Who a credential may serve: "Project-wide", or for one enrolled by the
 * one-command install "Host edge-1 · host agent edge-1@ebpf".
 */
export function credentialBinding(c: { host_id?: string; host_name?: string; agent_kind?: string; agent_name?: string }): string {
  if (!c.host_id) return 'Project-wide';
  const kind = c.agent_kind === 'host' ? 'host agent' : c.agent_kind === 'waf' ? 'WAF agent' : 'agent';
  const agent = c.agent_name ? `${kind} ${c.agent_name}` : kind;
  return `Host ${c.host_name || c.host_id} · ${agent}`;
}

/**
 * systemd unit for an agent. Host units match install.sh: eBPF objects under
 * /opt/wafio/ebpf, the GeoIP country database, --ebpf and --trace on, and
 * /run/wafio kept for the local API token. WAF units are the unit the agent
 * bundle ships, plus this credential's name and address in ExecStart. `serverName` adds
 * --grpc-server-name (the name on the control plane's gRPC certificate).
 */
export function credentialService(name: string, server: string, kind: 'waf'|'host' = 'waf', opts: { serverName?: string } = {}): string {
  const serverName = opts.serverName ? ` --grpc-server-name ${argument(opts.serverName)}` : '';
  const P = HOST_AGENT_PATHS;
  if (kind === 'host') return `[Unit]
Description=WAFio host firewall and runtime agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=${P.envFile}
ExecStart=/usr/local/bin/wafio-host-agent --agent-name ${argument(name)} --grpc-server ${argument(server || 'YOUR_CONTROL_PLANE:9090')}${serverName} --grpc-client-cert ${P.certsDir}/client.crt --grpc-client-key ${P.certsDir}/client.key --grpc-ca-cert ${P.certsDir}/ca.crt --interface \${WAFIO_INTERFACE} --geoip-db ${P.geoipDb} --ebpf=true --trace=true --xdp-obj ${P.ebpfDir}/wafio_xdp.o --tc-obj ${P.ebpfDir}/wafio_tc.o --trace-obj ${P.ebpfDir}/wafio_trace.o
Restart=on-failure
RestartSec=5
LimitMEMLOCK=infinity
# /run/wafio holds the per-boot local API token; kept across stops for other wafio units.
RuntimeDirectory=wafio
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes

[Install]
WantedBy=multi-user.target
`;
  return `# Sample unit for a manual install of wafio-waf-agent: the unit the WAF agent bundle ships (systemd/wafio-waf-agent.service),
# with this credential's agent name and control plane address on the command line. Everything else, the certificate paths
# and the security data paths, comes from /etc/wafio/waf-agent.env; the installer writes that file. The system user wafio
# must exist and own /etc/wafio/certs/waf and /etc/wafio/security-data.
[Unit]
Description=WAFio WAF Agent
After=network.target

[Service]
Type=notify
# tableflip's successor sends READY=1/MAINPID itself, not the main PID.
NotifyAccess=all
User=wafio
Group=wafio
# mimalloc returns freed memory to the system after 10 ms, the delay resident memory was measured with.
Environment=MIMALLOC_PURGE_DELAY=10
EnvironmentFile=/etc/wafio/waf-agent.env
ExecStart=/usr/local/bin/wafio-waf-agent --agent-name ${argument(name)} --grpc-server ${argument(server || 'YOUR_CONTROL_PLANE:9090')}${serverName}
ExecReload=/bin/kill -SIGUSR2 $MAINPID
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wafio-waf-agent
LimitNOFILE=65536
# Bundle cache: the last applied bundle is kept in
# /var/lib/wafio-waf-agent/last-bundle.json (0600) and applied at start before
# the agent connects, so a restart while the control plane is unreachable still
# serves the protected apps. systemd creates the directory for User= and passes
# it as $STATE_DIRECTORY; it stays writable under ProtectSystem=strict.
StateDirectory=wafio-waf-agent
StateDirectoryMode=0700

# Containment. A flaw in HTTP parsing should not have the whole filesystem and
# every capability to work with.
NoNewPrivileges=yes
# Listen ports below 1024 are the only privilege kept; ambient capabilities survive
# the exec of the successor process that a reload starts.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @obsolete
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# ProtectSystem=strict makes everything read-only; name the exceptions. Only
# the security-data sync target and the state directory are writable: the
# certificates and env file in /etc/wafio, and the binary in /usr/local/bin,
# stay read-only, so nothing running inside the agent can replace them for the
# next reload to pick up. Self-update was removed; deploy new
# versions as root.
ReadWritePaths=-/etc/wafio/security-data

[Install]
WantedBy=multi-user.target
`;
}
