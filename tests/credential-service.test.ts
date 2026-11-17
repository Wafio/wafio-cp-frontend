import { expect, test } from 'bun:test';
import { credentialService } from '../src/lib/credential-service';
test('service uses current CLI and quotes user-controlled arguments', () => {
 const service = credentialService('team "A" %n $USER\nInjected=bad', 'host:9090');
 expect(service).not.toContain('--proxy-listen');
 expect(service).toContain('%%n $$USER');
 expect(service).not.toContain('\nInjected=');
});
test('waf unit is the one the bundle ships, with the credential on the command line', () => {
 const service = credentialService('edge-1', 'cp.example.com:9090', 'waf', { serverName: 'cp.example.com' });
 const lines = service.split('\n');
 const execStart = lines.find((line) => line.startsWith('ExecStart='));
 expect(execStart).toBe('ExecStart=/usr/local/bin/wafio-waf-agent --agent-name "edge-1" --grpc-server "cp.example.com:9090" --grpc-server-name "cp.example.com"');
 // Directives of deploy/systemd/wafio-waf-agent.service in the control plane repo, everything but ExecStart.
 for (const directive of [
  'Type=notify', 'NotifyAccess=all', 'User=wafio', 'Group=wafio', 'Environment=MIMALLOC_PURGE_DELAY=10', 'EnvironmentFile=/etc/wafio/waf-agent.env',
  'ExecReload=/bin/kill -SIGUSR2 $MAINPID', 'Restart=on-failure', 'RestartSec=5', 'LimitNOFILE=65536',
  'StateDirectory=wafio-waf-agent', 'StateDirectoryMode=0700', 'NoNewPrivileges=yes',
  'AmbientCapabilities=CAP_NET_BIND_SERVICE', 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
  'ProtectSystem=strict', 'MemoryDenyWriteExecute=yes', 'SystemCallFilter=@system-service', 'SystemCallFilter=~@privileged @resources @obsolete',
  'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX', 'ReadWritePaths=-/etc/wafio/security-data', 'WantedBy=multi-user.target',
 ]) expect(lines).toContain(directive);
 // Same order as the shipped unit: the default first, the env file after it.
 expect(lines.indexOf('Environment=MIMALLOC_PURGE_DELAY=10')).toBeLessThan(lines.indexOf('EnvironmentFile=/etc/wafio/waf-agent.env'));
 // Nothing from the old flag list: the data paths come from the environment file.
 for (const flag of ['--security-data-dir', '--geo-country-db', '--client-cert', 'WorkingDirectory=', 'Restart=always']) expect(service).not.toContain(flag);
});
test('host artifact uses host CLI flags and required environment',()=>{
 const unit=credentialService('host','cp:9090','host');
 expect(unit).toContain('--grpc-client-cert');expect(unit).not.toContain('--host-key');
 expect(unit).toContain('EnvironmentFile=/etc/wafio/host-agent.env');expect(unit).not.toContain('--client-cert');
});
