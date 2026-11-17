/*
 * Runtime security, Policy Templates Library
 *
 * Review templates for runtime observations. MITRE mappings are investigation
 * context, not proof of a technique. Imports are disabled until explicitly enabled.
 *
 * These are UI-side constants: when a user imports a template the web app
 * POSTs a normal CreatePolicy request. No server round-trip is needed to
 * fetch this list; templates ship with the frontend.
 */

export interface PolicyTemplate {
  id: string;              // stable key (used for "already imported?" checks)
  category: string;        // UI grouping
  name: string;
  description: string;
  mitre_tactic: string;
  mitre_technique_id: string;
  mitre_technique_name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  // Example lab command. Review side effects and active policies before use.
  pentest?: string;
  // Policy body (same shape as EnforcementPolicy create payload)
  policy: {
    event_types?: string[];
    min_severity?: string;
    match_comm?: string;
    match_filename?: string;
    match_uid?: number | null;
    match_dest_port?: string;
    action: 'monitor' | 'simulate' | 'alert' | 'kill';
    kernel_enforce?: boolean;
  };
}

export const POLICY_TEMPLATE_CATEGORIES = [
  'Execution',
  'Privilege Escalation',
  'Defense Evasion',
  'Persistence',
  'Credential Access',
  'Discovery',
  'Lateral Movement',
  'Exfiltration',
  'Impact',
  'Command & Control',
] as const;

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  // ── Execution (TA0002) ──────────────────────────────────────────────────
  {
    id: 'exec-shell-from-web',
    category: 'Execution',
    name: 'Shell-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: sh, bash, zsh, dash, ash, ksh. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Execution',
    mitre_technique_id: 'T1059.004',
    mitre_technique_name: 'Unix Shell',
    severity: 'critical',
    tags: ['webshell', 'rce'],
    pentest: '# Spawn shell as if from web server (rename binary):\ncp /bin/sh /tmp/_nginxsh && /tmp/_nginxsh -c true; rm /tmp/_nginxsh',
    policy: { event_types: ['execve'], match_comm: 'sh, bash, zsh, dash, ash, ksh', action: 'alert' },
  },
  {
    id: 'exec-memfd-create',
    category: 'Execution',
    name: 'Anonymous memory file creation',
    description: 'Matches memfd_create events. Memory file creation alone does not establish execution or malware; legitimate applications use it.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1620',
    mitre_technique_name: 'Reflective Code Loading',
    severity: 'critical',
    tags: ['fileless', 'dropper'],
    pentest: 'python3 -c \'import ctypes; ctypes.CDLL("libc.so.6").syscall(319, b"pen", 0)\'',
    policy: { event_types: ['memfd_create'], action: 'kill', kernel_enforce: true },
  },
  {
    id: 'exec-interpreter-curl-bash',
    category: 'Execution',
    name: 'curl / wget execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: curl, wget. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Execution',
    mitre_technique_id: 'T1059',
    mitre_technique_name: 'Command and Scripting Interpreter',
    severity: 'high',
    tags: ['supply-chain'],
    pentest: 'curl -s http://127.0.0.1/ -o /dev/null || true',
    policy: { event_types: ['execve'], match_comm: 'curl, wget', action: 'alert' },
  },
  {
    id: 'exec-python-reverse-shell',
    category: 'Execution',
    name: 'Python connection attempts',
    description: 'Matches connect events where the process name contains any of: python, python3, python2. Destination address, protocol, connection success and shell activity are not checked.',
    mitre_tactic: 'Execution',
    mitre_technique_id: 'T1059.006',
    mitre_technique_name: 'Python',
    severity: 'high',
    tags: ['reverse-shell'],
    pentest: 'python3 -c \'import socket; s=socket.socket(); s.settimeout(0.3); s.connect_ex(("127.0.0.1",9)); s.close()\'',
    policy: { event_types: ['connect'], match_comm: 'python, python3, python2', action: 'alert' },
  },

  // ── Privilege Escalation (TA0004) ───────────────────────────────────────
  {
    id: 'priv-setuid-root',
    category: 'Privilege Escalation',
    name: 'User ID change attempts',
    description: 'Matches setuid events. Does not establish a successful transition to root; routine credential changes can match.',
    mitre_tactic: 'Privilege Escalation',
    mitre_technique_id: 'T1548.001',
    mitre_technique_name: 'Setuid and Setgid',
    severity: 'critical',
    tags: ['privesc'],
    pentest: 'python3 -c \'import os\\ntry: os.setuid(0)\\nexcept: pass\'',
    policy: { event_types: ['setuid'], action: 'alert' },
  },
  {
    id: 'priv-sudo-exec',
    category: 'Privilege Escalation',
    name: 'sudo-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: sudo. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Privilege Escalation',
    mitre_technique_id: 'T1548.003',
    mitre_technique_name: 'Sudo and Sudo Caching',
    severity: 'low',
    tags: ['audit', 'sudo'],
    pentest: 'sudo -n true 2>/dev/null; true',
    policy: { event_types: ['execve'], match_comm: 'sudo', action: 'alert' },
  },
  {
    id: 'priv-kernel-module-load',
    category: 'Privilege Escalation',
    name: 'Kernel module load attempts',
    description: 'Matches init_module, finit_module events. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1547.006',
    mitre_technique_name: 'Kernel Modules and Extensions',
    severity: 'critical',
    tags: ['rootkit', 'kernel'],
    pentest: 'echo PASS_SUDO | sudo -S python3 -c \'import ctypes; ctypes.CDLL("libc.so.6").syscall(313,0,b"",0)\' 2>/dev/null; true',
    policy: { event_types: ['init_module', 'finit_module'], action: 'kill', kernel_enforce: true },
  },
  {
    id: 'priv-ptrace-other',
    category: 'Privilege Escalation',
    name: 'ptrace requests',
    description: 'Matches ptrace events. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Privilege Escalation',
    mitre_technique_id: 'T1055.008',
    mitre_technique_name: 'Ptrace System Calls',
    severity: 'high',
    tags: ['injection'],
    pentest: 'python3 -c \'import ctypes; ctypes.CDLL("libc.so.6").ptrace(16,1,0,0)\'',
    policy: { event_types: ['ptrace'], action: 'alert' },
  },

  // ── Defense Evasion (TA0005) ────────────────────────────────────────────
  {
    id: 'evasion-clear-history',
    category: 'Defense Evasion',
    name: 'Shell history unlink / rename attempts',
    description: 'Matches unlink, rename events with a filename containing any of: .bash_history. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1070.003',
    mitre_technique_name: 'Clear Command History',
    severity: 'high',
    tags: ['anti-forensics'],
    pentest: 'touch /tmp/.bash_history && rm /tmp/.bash_history',
    policy: { event_types: ['unlink', 'rename'], match_filename: '.bash_history', action: 'alert' },
  },
  {
    id: 'evasion-log-tamper',
    category: 'Defense Evasion',
    name: 'Log path unlink / rename attempts',
    description: 'Matches unlink, rename events with a filename containing any of: /var/log. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1070.002',
    mitre_technique_name: 'Clear Linux or Mac System Logs',
    severity: 'critical',
    tags: ['anti-forensics', 'logs'],
    pentest: 'sudo -n touch /var/log/_pentest.log 2>/dev/null && sudo -n rm /var/log/_pentest.log 2>/dev/null; true',
    policy: { event_types: ['unlink', 'rename'], match_filename: '/var/log', action: 'alert' },
  },
  {
    id: 'evasion-chmod-suid',
    category: 'Defense Evasion',
    name: 'File mode change attempts',
    description: 'Matches chmod events. Requested mode, SUID bits and syscall success are not checked.',
    mitre_tactic: 'Privilege Escalation',
    mitre_technique_id: 'T1548.001',
    mitre_technique_name: 'Setuid and Setgid',
    severity: 'high',
    tags: ['suid-backdoor'],
    pentest: 'touch /tmp/_suid && chmod u+s /tmp/_suid; rm /tmp/_suid',
    policy: { event_types: ['chmod'], action: 'alert' },
  },
  {
    id: 'evasion-prctl-hide',
    category: 'Defense Evasion',
    name: 'Process control requests',
    description: 'Matches prctl events. The prctl operation, new process name and syscall success are not checked.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1036.005',
    mitre_technique_name: 'Match Legitimate Name or Location',
    severity: 'medium',
    tags: ['masquerade'],
    pentest: 'python3 -c \'import ctypes; ctypes.CDLL("libc.so.6").prctl(15,b"kthreadd",0,0,0)\'',
    policy: { event_types: ['prctl'], action: 'alert' },
  },

  // ── Persistence (TA0003) ────────────────────────────────────────────────
  {
    id: 'persist-cron-write',
    category: 'Persistence',
    name: 'Cron path access',
    description: 'Matches openat, rename events with a filename containing any of: /etc/cron, /var/spool/cron. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1053.003',
    mitre_technique_name: 'Cron',
    severity: 'high',
    tags: ['persistence', 'cron'],
    pentest: 'ls /etc/cron.d/ >/dev/null; cat /etc/crontab >/dev/null 2>&1; true',
    policy: { event_types: ['openat', 'rename'], match_filename: '/etc/cron, /var/spool/cron', action: 'alert' },
  },
  {
    id: 'persist-systemd-unit',
    category: 'Persistence',
    name: 'Systemd unit path access',
    description: 'Matches openat, rename events with a filename containing any of: /etc/systemd/system, /lib/systemd, /usr/lib/systemd. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1543.002',
    mitre_technique_name: 'Systemd Service',
    severity: 'high',
    tags: ['persistence', 'systemd'],
    pentest: 'ls /etc/systemd/system/ >/dev/null 2>&1; true',
    policy: { event_types: ['openat', 'rename'], match_filename: '/etc/systemd/system, /lib/systemd, /usr/lib/systemd', action: 'alert' },
  },
  {
    id: 'persist-ssh-authkeys',
    category: 'Persistence',
    name: 'SSH authorized_keys access',
    description: 'Matches openat events with a filename containing any of: authorized_keys. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1098.004',
    mitre_technique_name: 'SSH Authorized Keys',
    severity: 'critical',
    tags: ['persistence', 'ssh'],
    pentest: 'mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys; true',
    policy: { event_types: ['openat'], match_filename: 'authorized_keys', action: 'alert' },
  },
  {
    id: 'persist-ld-preload',
    category: 'Persistence',
    name: 'ld.so.preload path access',
    description: 'Matches openat, rename events with a filename containing any of: ld.so.preload. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1574.006',
    mitre_technique_name: 'Dynamic Linker Hijacking',
    severity: 'critical',
    tags: ['persistence', 'rootkit'],
    pentest: 'cat /etc/ld.so.preload 2>/dev/null; true',
    policy: { event_types: ['openat', 'rename'], match_filename: 'ld.so.preload', action: 'kill' },
  },
  {
    id: 'persist-bashrc-mod',
    category: 'Persistence',
    name: 'Shell profile access',
    description: 'Matches openat events with a filename containing any of: bashrc, /etc/profile, bash.bashrc, .zshrc, .profile. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1546.004',
    mitre_technique_name: 'Unix Shell Configuration Modification',
    severity: 'high',
    tags: ['persistence', 'shell'],
    pentest: 'cat ~/.bashrc >/dev/null; true',
    policy: { event_types: ['openat'], match_filename: 'bashrc, /etc/profile, bash.bashrc, .zshrc, .profile', action: 'alert' },
  },

  // ── Credential Access (TA0006) ──────────────────────────────────────────
  {
    id: 'cred-shadow-read',
    category: 'Credential Access',
    name: 'Shadow file access',
    description: 'Matches openat events with a filename containing any of: /etc/shadow. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Credential Access',
    mitre_technique_id: 'T1003.008',
    mitre_technique_name: '/etc/passwd and /etc/shadow',
    severity: 'critical',
    tags: ['cred-theft'],
    pentest: 'cat /etc/shadow >/dev/null 2>&1; true',
    policy: { event_types: ['openat'], match_filename: '/etc/shadow', action: 'alert' },
  },
  {
    id: 'cred-gshadow-read',
    category: 'Credential Access',
    name: 'Group shadow file access',
    description: 'Matches openat events with a filename containing any of: /etc/gshadow. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Credential Access',
    mitre_technique_id: 'T1003.008',
    mitre_technique_name: '/etc/passwd and /etc/shadow',
    severity: 'high',
    tags: ['cred-theft'],
    pentest: 'cat /etc/gshadow >/dev/null 2>&1; true',
    policy: { event_types: ['openat'], match_filename: '/etc/gshadow', action: 'alert' },
  },
  {
    id: 'cred-ssh-privkey',
    category: 'Credential Access',
    name: 'SSH key filename access',
    description: 'Matches openat events with a filename containing any of: id_rsa, id_ed25519, id_ecdsa, id_dsa. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Credential Access',
    mitre_technique_id: 'T1552.004',
    mitre_technique_name: 'Private Keys',
    severity: 'critical',
    tags: ['cred-theft', 'ssh'],
    pentest: 'test -f ~/.ssh/id_rsa && cat ~/.ssh/id_rsa >/dev/null; touch /tmp/id_rsa && cat /tmp/id_rsa >/dev/null; rm /tmp/id_rsa',
    policy: { event_types: ['openat'], match_filename: 'id_rsa, id_ed25519, id_ecdsa, id_dsa', action: 'alert' },
  },
  {
    id: 'cred-aws-credentials',
    category: 'Credential Access',
    name: 'AWS credentials path access',
    description: 'Matches openat events with a filename containing any of: .aws/credentials. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Credential Access',
    mitre_technique_id: 'T1552.001',
    mitre_technique_name: 'Credentials In Files',
    severity: 'critical',
    tags: ['cred-theft', 'cloud'],
    pentest: 'mkdir -p ~/.aws && touch ~/.aws/credentials && cat ~/.aws/credentials >/dev/null',
    policy: { event_types: ['openat'], match_filename: '.aws/credentials', action: 'alert' },
  },
  {
    id: 'cred-docker-config',
    category: 'Credential Access',
    name: 'Docker config path access',
    description: 'Matches openat events with a filename containing any of: .docker/config. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Credential Access',
    mitre_technique_id: 'T1552.001',
    mitre_technique_name: 'Credentials In Files',
    severity: 'high',
    tags: ['cred-theft', 'docker'],
    pentest: 'mkdir -p ~/.docker && touch ~/.docker/config.json && cat ~/.docker/config.json >/dev/null',
    policy: { event_types: ['openat'], match_filename: '.docker/config', action: 'alert' },
  },

  // ── Discovery (TA0007) ──────────────────────────────────────────────────
  {
    id: 'disc-proc-enum',
    category: 'Discovery',
    name: 'Proc filesystem access',
    description: 'Matches openat events with a filename containing any of: /proc. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Discovery',
    mitre_technique_id: 'T1057',
    mitre_technique_name: 'Process Discovery',
    severity: 'medium',
    tags: ['recon'],
    pentest: 'for p in /proc/[0-9]*/cmdline; do cat "$p" >/dev/null 2>&1; done | head -1',
    policy: { event_types: ['openat'], match_filename: '/proc', action: 'alert' },
  },
  {
    id: 'disc-netstat',
    category: 'Discovery',
    name: 'Proc network path access',
    description: 'Matches openat events with a filename containing any of: /proc/net. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Discovery',
    mitre_technique_id: 'T1049',
    mitre_technique_name: 'System Network Connections Discovery',
    severity: 'low',
    tags: ['recon'],
    pentest: 'cat /proc/net/tcp >/dev/null; cat /proc/net/udp >/dev/null',
    policy: { event_types: ['openat'], match_filename: '/proc/net', action: 'alert' },
  },
  {
    id: 'disc-nmap',
    category: 'Discovery',
    name: 'Scanner-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: nmap, masscan, zmap, rustscan. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Discovery',
    mitre_technique_id: 'T1046',
    mitre_technique_name: 'Network Service Scanning',
    severity: 'high',
    tags: ['recon', 'scanner'],
    pentest: '# Requires nmap installed:\ncp /bin/true /tmp/nmap && /tmp/nmap; rm /tmp/nmap',
    policy: { event_types: ['execve'], match_comm: 'nmap, masscan, zmap, rustscan', action: 'alert' },
  },

  // ── Lateral Movement (TA0008) ───────────────────────────────────────────
  {
    id: 'lateral-ssh-outbound',
    category: 'Lateral Movement',
    name: 'SSH-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: ssh. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Lateral Movement',
    mitre_technique_id: 'T1021.004',
    mitre_technique_name: 'SSH',
    severity: 'medium',
    tags: ['lateral'],
    pentest: 'cp /bin/true /tmp/ssh && /tmp/ssh; rm /tmp/ssh',
    policy: { event_types: ['execve'], match_comm: 'ssh', action: 'alert' },
  },
  {
    id: 'lateral-scp',
    category: 'Lateral Movement',
    name: 'File transfer tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: scp, rsync, sftp. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Lateral Movement',
    mitre_technique_id: 'T1021.004',
    mitre_technique_name: 'SSH',
    severity: 'medium',
    tags: ['lateral', 'exfil'],
    pentest: 'cp /bin/true /tmp/scp && /tmp/scp; rm /tmp/scp',
    policy: { event_types: ['execve'], match_comm: 'scp, rsync, sftp', action: 'alert' },
  },

  // ── Exfiltration (TA0010) ───────────────────────────────────────────────
  {
    id: 'exfil-large-upload',
    category: 'Exfiltration',
    name: 'Transfer tool connection attempts',
    description: 'Matches connect events where the process name contains any of: curl, wget, nc, ncat. Destination address, protocol, connection success and shell activity are not checked.',
    mitre_tactic: 'Exfiltration',
    mitre_technique_id: 'T1048',
    mitre_technique_name: 'Exfiltration Over Alternative Protocol',
    severity: 'high',
    tags: ['exfil'],
    pentest: 'curl -s --max-time 1 http://127.0.0.1:1/ >/dev/null 2>&1; true',
    policy: { event_types: ['connect'], match_comm: 'curl, wget, nc, ncat', action: 'alert' },
  },
  {
    id: 'exfil-ncat',
    category: 'Exfiltration',
    name: 'Netcat-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: nc, ncat, socat. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Command and Control',
    mitre_technique_id: 'T1071',
    mitre_technique_name: 'Application Layer Protocol',
    severity: 'high',
    tags: ['reverse-shell', 'tunnel'],
    pentest: 'cp /bin/true /tmp/nc && /tmp/nc; rm /tmp/nc',
    policy: { event_types: ['execve'], match_comm: 'nc, ncat, socat', action: 'alert' },
  },

  // ── Impact (TA0040) ─────────────────────────────────────────────────────
  {
    id: 'impact-cryptominer',
    category: 'Impact',
    name: 'Miner-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: xmrig, minerd, ethminer, cpuminer, t-rex, phoenixminer. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Impact',
    mitre_technique_id: 'T1496',
    mitre_technique_name: 'Resource Hijacking',
    severity: 'critical',
    tags: ['cryptomining'],
    pentest: 'cp /bin/true /tmp/xmrig && /tmp/xmrig; rm /tmp/xmrig',
    policy: { event_types: ['execve'], match_comm: 'xmrig, minerd, ethminer, cpuminer, t-rex, phoenixminer', action: 'kill' },
  },
  {
    id: 'impact-ransomware-shadow',
    category: 'Impact',
    name: 'Storage tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: zfs, btrfs. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Impact',
    mitre_technique_id: 'T1490',
    mitre_technique_name: 'Inhibit System Recovery',
    severity: 'critical',
    tags: ['ransomware'],
    pentest: 'cp /bin/true /tmp/zfs && /tmp/zfs; rm /tmp/zfs',
    policy: { event_types: ['execve'], match_comm: 'zfs, btrfs', action: 'alert' },
  },
  {
    id: 'impact-mass-unlink',
    category: 'Impact',
    name: 'Home path unlink attempts',
    description: 'Matches unlink events with a filename containing any of: /home. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Impact',
    mitre_technique_id: 'T1485',
    mitre_technique_name: 'Data Destruction',
    severity: 'high',
    tags: ['ransomware', 'destruction'],
    pentest: 'touch /tmp/_pentest_home && rm /tmp/_pentest_home  # NOTE: real rule monitors /home',
    policy: { event_types: ['unlink'], match_filename: '/home', action: 'alert' },
  },

  // ── Command & Control (TA0011) ──────────────────────────────────────────
  {
    id: 'c2-tor-binary',
    category: 'Command & Control',
    name: 'Tor-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: tor, obfs4proxy. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Command and Control',
    mitre_technique_id: 'T1090.003',
    mitre_technique_name: 'Multi-hop Proxy',
    severity: 'high',
    tags: ['c2', 'tor'],
    pentest: 'cp /bin/true /tmp/tor && /tmp/tor; rm /tmp/tor',
    policy: { event_types: ['execve'], match_comm: 'tor, obfs4proxy', action: 'alert' },
  },
  {
    id: 'c2-dns-tunnel',
    category: 'Command & Control',
    name: 'DNS tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: dig, nslookup, host. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Command and Control',
    mitre_technique_id: 'T1071.004',
    mitre_technique_name: 'DNS',
    severity: 'medium',
    tags: ['c2', 'dns'],
    pentest: 'cp /bin/true /tmp/dig && /tmp/dig; rm /tmp/dig',
    policy: { event_types: ['execve'], match_comm: 'dig, nslookup, host', action: 'alert' },
  },

  // ── Kernel-mode templates (proven via penetration tests) ────────────────
  // These templates use ONLY event_types + min_severity so they actually run
  // in the BPF map (no auto-downgrade). Action 'kill' invokes bpf_send_signal()
  // for real-time SIGKILL with µs latency. Verified: 5/5 PASS, mode=kernel.
  {
    id: 'kernel-setuid-root',
    category: 'Privilege Escalation',
    name: '[KERNEL] Elevated credential change events',
    description: 'Matches setuid, setgid events classified high or higher by the agent. Does not establish a successful transition to root; routine credential changes can match.',
    mitre_tactic: 'Privilege Escalation',
    mitre_technique_id: 'T1548',
    mitre_technique_name: 'Abuse Elevation Control Mechanism',
    severity: 'critical',
    tags: ['kernel-enforce', 'setuid', 'priv-esc'],
    pentest: 'python3 -c \'import os\\ntry: os.setuid(0)\\nexcept: pass\'',
    policy: { event_types: ['setuid', 'setgid'], min_severity: 'high', action: 'alert', kernel_enforce: true },
  },
  {
    id: 'kernel-init-module',
    category: 'Persistence',
    name: '[KERNEL] Module load attempts',
    description: 'Matches init_module, finit_module events classified info or higher by the agent. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1547.006',
    mitre_technique_name: 'Boot or Logon Autostart Execution: Kernel Modules',
    severity: 'critical',
    tags: ['kernel-enforce', 'rootkit', 'lkm'],
    pentest: 'echo PASS_SUDO | sudo -S python3 -c \'import ctypes; ctypes.CDLL("libc.so.6").syscall(313,0,b"",0)\' 2>/dev/null; true',
    policy: { event_types: ['init_module', 'finit_module'], min_severity: 'info', action: 'alert', kernel_enforce: true },
  },
  {
    id: 'kernel-ptrace-attach',
    category: 'Defense Evasion',
    name: '[KERNEL] Elevated ptrace events',
    description: 'Matches ptrace events classified high or higher by the agent. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1055.008',
    mitre_technique_name: 'Process Injection: Ptrace',
    severity: 'high',
    tags: ['kernel-enforce', 'injection', 'ptrace'],
    pentest: 'python3 -c \'import ctypes; ctypes.CDLL("libc.so.6").ptrace(16,1,0,0)\'',
    policy: { event_types: ['ptrace'], min_severity: 'high', action: 'alert', kernel_enforce: true },
  },
  {
    id: 'kernel-memfd-create',
    category: 'Defense Evasion',
    name: '[KERNEL] Memory file creation events',
    description: 'Matches memfd_create events classified medium or higher by the agent. Memory file creation alone does not establish execution or malware; legitimate applications use it.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1620',
    mitre_technique_name: 'Reflective Code Loading',
    severity: 'high',
    tags: ['kernel-enforce', 'fileless'],
    pentest: 'python3 -c \'import ctypes; ctypes.CDLL("libc.so.6").syscall(319, b"pen", 0)\'',
    policy: { event_types: ['memfd_create'], min_severity: 'medium', action: 'alert', kernel_enforce: true },
  },
  {
    id: 'kernel-mprotect-wx',
    category: 'Defense Evasion',
    name: '[KERNEL] Elevated memory protection events',
    description: 'Matches mprotect events classified high or higher by the agent. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1055',
    mitre_technique_name: 'Process Injection',
    severity: 'high',
    tags: ['kernel-enforce', 'shellcode', 'wx'],
    pentest: 'python3 -c \'import ctypes,mmap\\nlibc=ctypes.CDLL("libc.so.6")\\nb=mmap.mmap(-1,4096,prot=mmap.PROT_READ|mmap.PROT_WRITE)\\na=ctypes.addressof(ctypes.c_char.from_buffer(b))\\nlibc.mprotect(ctypes.c_void_p(a & ~0xfff),4096,7)\'',
    policy: { event_types: ['mprotect'], min_severity: 'high', action: 'alert', kernel_enforce: true },
  },

  // ── Additional Execution templates ───────────────────────────────────────
  {
    id: 'exec-perl-reverse-shell',
    category: 'Execution',
    name: 'Perl connection attempts',
    description: 'Matches connect events where the process name contains any of: perl. Destination address, protocol, connection success and shell activity are not checked.',
    mitre_tactic: 'Execution',
    mitre_technique_id: 'T1059.006',
    mitre_technique_name: 'Command and Scripting Interpreter: Perl',
    severity: 'critical',
    tags: ['reverse-shell', 'perl'],
    pentest: 'perl -e \'use Socket; socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp")); connect(S, sockaddr_in(9,inet_aton("127.0.0.1"))) or 1;\' 2>/dev/null; true',
    policy: { event_types: ['connect'], match_comm: 'perl', action: 'alert' },
  },
  {
    id: 'exec-ruby-reverse-shell',
    category: 'Execution',
    name: 'Ruby connection attempts',
    description: 'Matches connect events where the process name contains any of: ruby. Destination address, protocol, connection success and shell activity are not checked.',
    mitre_tactic: 'Execution',
    mitre_technique_id: 'T1059',
    mitre_technique_name: 'Command and Scripting Interpreter',
    severity: 'critical',
    tags: ['reverse-shell', 'ruby'],
    pentest: '# Ruby reverse-shell pattern (works even if ruby not installed by renaming binary):\ncp /usr/bin/perl /tmp/ruby && /tmp/ruby -e \'use Socket; socket(S,PF_INET,SOCK_STREAM,6); connect(S,sockaddr_in(9,inet_aton("127.0.0.1"))) or 1;\' 2>/dev/null; rm -f /tmp/ruby',
    policy: { event_types: ['connect'], match_comm: 'ruby', action: 'alert' },
  },
  {
    id: 'exec-php-reverse-shell',
    category: 'Execution',
    name: 'PHP connection attempts',
    description: 'Matches connect events where the process name contains any of: php, php7, php8, php-cgi. Destination address, protocol, connection success and shell activity are not checked.',
    mitre_tactic: 'Execution',
    mitre_technique_id: 'T1059',
    mitre_technique_name: 'Command and Scripting Interpreter',
    severity: 'critical',
    tags: ['reverse-shell', 'php', 'webshell'],
    pentest: 'php -r \'@fsockopen("127.0.0.1",9,$e,$es,0.3);\' 2>/dev/null; true',
    policy: { event_types: ['connect'], match_comm: 'php, php7, php8, php-cgi', action: 'alert' },
  },
  {
    id: 'exec-node-shell',
    category: 'Execution',
    name: 'Node-name execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: node, nodejs. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Execution',
    mitre_technique_id: 'T1059.004',
    mitre_technique_name: 'Unix Shell',
    severity: 'high',
    tags: ['reverse-shell', 'node'],
    pentest: 'cp /bin/true /tmp/node && /tmp/node; rm /tmp/node',
    policy: { event_types: ['execve'], match_comm: 'node, nodejs', action: 'alert' },
  },

  // ── Container escape / mount abuse ──────────────────────────────────────
  {
    id: 'priv-mount-bind',
    category: 'Privilege Escalation',
    name: 'Mount attempts',
    description: 'Matches mount events. Container identity, mount flags, target and success are not checked.',
    mitre_tactic: 'Privilege Escalation',
    mitre_technique_id: 'T1611',
    mitre_technique_name: 'Escape to Host',
    severity: 'critical',
    tags: ['container-escape', 'mount'],
    pentest: 'echo PASS_SUDO | sudo -S sh -c \'mkdir -p /tmp/_mnt && mount --bind /tmp /tmp/_mnt; umount /tmp/_mnt; rmdir /tmp/_mnt\' 2>/dev/null; true',
    policy: { event_types: ['mount'], action: 'alert' },
  },
  {
    id: 'priv-umount-detection',
    category: 'Defense Evasion',
    name: 'Unmount attempts',
    description: 'Matches umount events. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1562',
    mitre_technique_name: 'Impair Defenses',
    severity: 'medium',
    tags: ['evasion', 'umount'],
    pentest: 'echo PASS_SUDO | sudo -S sh -c \'mkdir -p /tmp/_mnt2 && mount --bind /tmp /tmp/_mnt2; umount /tmp/_mnt2; rmdir /tmp/_mnt2\' 2>/dev/null; true',
    policy: { event_types: ['umount'], action: 'alert' },
  },

  // ── Network: rogue listener / outbound-to-internal ──────────────────────
  {
    id: 'net-rogue-listener',
    category: 'Command & Control',
    name: 'Selected local port events',
    description: 'Matches bind, listen events on any of these ports: 4444, 1337, 31337, 6667, 6666, 8888. A matching syscall does not establish success or malicious intent; review legitimate activity before enabling.',
    mitre_tactic: 'Command and Control',
    mitre_technique_id: 'T1571',
    mitre_technique_name: 'Non-Standard Port',
    severity: 'high',
    tags: ['c2', 'listen', 'backdoor'],
    pentest: 'python3 -c \'import socket; s=socket.socket(); s.bind(("127.0.0.1",4444)); s.listen(1); s.close()\'',
    policy: { event_types: ['bind', 'listen'], match_dest_port: '4444, 1337, 31337, 6667, 6666, 8888', action: 'alert' },
  },
  {
    id: 'net-irc-port',
    category: 'Command & Control',
    name: 'IRC port connection attempts',
    description: 'Matches connect events on any of these ports: 6667, 6697. Destination address, protocol, connection success and shell activity are not checked.',
    mitre_tactic: 'Command and Control',
    mitre_technique_id: 'T1071.001',
    mitre_technique_name: 'Application Layer Protocol: Web Protocols',
    severity: 'high',
    tags: ['c2', 'irc', 'botnet'],
    pentest: 'python3 -c \'import socket; s=socket.socket(); s.settimeout(0.3); s.connect_ex(("127.0.0.1",6667)); s.close()\'',
    policy: { event_types: ['connect'], match_dest_port: '6667, 6697', action: 'alert' },
  },
  {
    id: 'net-smb-outbound',
    category: 'Lateral Movement',
    name: 'SMB port connection attempts',
    description: 'Matches connect events on any of these ports: 445, 139. Destination address, protocol, connection success and shell activity are not checked.',
    mitre_tactic: 'Lateral Movement',
    mitre_technique_id: 'T1021.002',
    mitre_technique_name: 'Remote Services: SMB/Windows Admin Shares',
    severity: 'high',
    tags: ['lateral', 'smb'],
    pentest: 'python3 -c \'import socket; s=socket.socket(); s.settimeout(0.3); s.connect_ex(("127.0.0.1",445)); s.close()\'',
    policy: { event_types: ['connect'], match_dest_port: '445, 139', action: 'alert' },
  },

  // ── Credential access (more) ────────────────────────────────────────────
  {
    id: 'cred-passwd-write',
    category: 'Credential Access',
    name: 'Account file path access',
    description: 'Matches openat, rename, chmod events with a filename containing any of: /etc/passwd, /etc/shadow, /etc/gshadow. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1136.001',
    mitre_technique_name: 'Create Account: Local Account',
    severity: 'critical',
    tags: ['backdoor-account', 'passwd'],
    pentest: 'cat /etc/passwd >/dev/null',
    policy: { event_types: ['openat', 'rename', 'chmod'], match_filename: '/etc/passwd, /etc/shadow, /etc/gshadow', action: 'alert' },
  },
  {
    id: 'cred-sudoers-write',
    category: 'Privilege Escalation',
    name: 'Sudoers path access',
    description: 'Matches openat, rename events with a filename containing any of: /etc/sudoers, /etc/sudoers.d. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Privilege Escalation',
    mitre_technique_id: 'T1548.003',
    mitre_technique_name: 'Abuse Elevation Control Mechanism: Sudo and Sudo Caching',
    severity: 'critical',
    tags: ['sudo', 'priv-esc'],
    pentest: 'sudo -n cat /etc/sudoers >/dev/null 2>&1; true',
    policy: { event_types: ['openat', 'rename'], match_filename: '/etc/sudoers, /etc/sudoers.d', action: 'alert' },
  },
  {
    id: 'cred-pam-config',
    category: 'Persistence',
    name: 'PAM configuration path access',
    description: 'Matches openat, rename events with a filename containing any of: /etc/pam.d, /lib/security/pam_, /lib64/security/pam_. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Credential Access',
    mitre_technique_id: 'T1556.003',
    mitre_technique_name: 'Modify Authentication Process: Pluggable Authentication Modules',
    severity: 'critical',
    tags: ['pam', 'backdoor'],
    pentest: 'cat /etc/pam.d/login >/dev/null 2>&1; true',
    policy: { event_types: ['openat', 'rename'], match_filename: '/etc/pam.d, /lib/security/pam_, /lib64/security/pam_', action: 'alert' },
  },

  // ── Persistence (more) ──────────────────────────────────────────────────
  {
    id: 'persist-rc-local',
    category: 'Persistence',
    name: 'Startup script path access',
    description: 'Matches openat, rename events with a filename containing any of: /etc/rc.local, /etc/init.d, /etc/rc.d. Includes read-only opens; write intent, successful access and trusted callers are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1037.004',
    mitre_technique_name: 'Boot or Logon Initialization Scripts: RC Scripts',
    severity: 'high',
    tags: ['persistence', 'rc-local'],
    pentest: 'ls /etc/init.d/ >/dev/null 2>&1; true',
    policy: { event_types: ['openat', 'rename'], match_filename: '/etc/rc.local, /etc/init.d, /etc/rc.d', action: 'alert' },
  },
  {
    id: 'persist-at-jobs',
    category: 'Persistence',
    name: 'Scheduling tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: at, batch, atd. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Persistence',
    mitre_technique_id: 'T1053.001',
    mitre_technique_name: 'Scheduled Task/Job: At',
    severity: 'medium',
    tags: ['persistence', 'at'],
    pentest: 'cp /bin/true /tmp/at && /tmp/at; rm -f /tmp/at',
    policy: { event_types: ['execve'], match_comm: 'at, batch, atd', action: 'alert' },
  },

  // ── Defense evasion (more) ──────────────────────────────────────────────
  {
    id: 'evasion-auditd-stop',
    category: 'Defense Evasion',
    name: 'Service and audit tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: systemctl, service, auditctl. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1562.001',
    mitre_technique_name: 'Impair Defenses: Disable or Modify Tools',
    severity: 'critical',
    tags: ['evasion', 'auditd'],
    pentest: 'systemctl --version >/dev/null; service --status-all >/dev/null 2>&1; true',
    policy: { event_types: ['execve'], match_comm: 'systemctl, service, auditctl', action: 'alert' },
  },
  {
    id: 'evasion-iptables-flush',
    category: 'Defense Evasion',
    name: 'Firewall tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: iptables, ip6tables, nft, ufw. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Defense Evasion',
    mitre_technique_id: 'T1562.004',
    mitre_technique_name: 'Impair Defenses: Disable or Modify System Firewall',
    severity: 'high',
    tags: ['evasion', 'firewall'],
    pentest: 'iptables -V >/dev/null 2>&1 || cp /bin/true /tmp/iptables && /tmp/iptables; rm -f /tmp/iptables',
    policy: { event_types: ['execve'], match_comm: 'iptables, ip6tables, nft, ufw', action: 'alert' },
  },

  // ── Discovery (more) ────────────────────────────────────────────────────
  {
    id: 'disc-who-w',
    category: 'Discovery',
    name: 'Session tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: who, w, last, lastlog, finger. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Discovery',
    mitre_technique_id: 'T1033',
    mitre_technique_name: 'System Owner/User Discovery',
    severity: 'low',
    tags: ['discovery', 'session'],
    pentest: 'who; w; last -n 1 >/dev/null',
    policy: { event_types: ['execve'], match_comm: 'who, w, last, lastlog, finger', action: 'alert' },
  },
  {
    id: 'disc-id-whoami',
    category: 'Discovery',
    name: 'System identity tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: whoami, id, hostname, uname. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Discovery',
    mitre_technique_id: 'T1082',
    mitre_technique_name: 'System Information Discovery',
    severity: 'low',
    tags: ['discovery', 'recon'],
    pentest: 'whoami; id; hostname; uname -a >/dev/null',
    policy: { event_types: ['execve'], match_comm: 'whoami, id, hostname, uname', action: 'alert' },
  },

  // ── Impact (more) ───────────────────────────────────────────────────────
  {
    id: 'impact-kill-pid1',
    category: 'Impact',
    name: 'Signal syscall attempts',
    description: 'Matches kill events. Target PID, signal number and success are not checked, including signal 0 probes.',
    mitre_tactic: 'Impact',
    mitre_technique_id: 'T1529',
    mitre_technique_name: 'System Shutdown/Reboot',
    severity: 'critical',
    tags: ['impact', 'dos'],
    pentest: 'kill -0 $$ 2>/dev/null; true  # NOTE: real rule monitors any kill: sending signal 0 to self is safe',
    policy: { event_types: ['kill'], action: 'alert' },
  },
  {
    id: 'impact-disk-fill',
    category: 'Impact',
    name: 'Disk tool execution events',
    description: 'Matches execve events where the calling process name or executed filename contains any of: dd, fallocate, truncate. Substring matching also includes unrelated names; command arguments, parent identity and execution success are not checked.',
    mitre_tactic: 'Impact',
    mitre_technique_id: 'T1499.001',
    mitre_technique_name: 'Endpoint Denial of Service: OS Exhaustion Flood',
    severity: 'high',
    tags: ['impact', 'dos', 'disk'],
    pentest: 'dd if=/dev/zero of=/tmp/_pad bs=1k count=1 2>/dev/null; rm -f /tmp/_pad',
    policy: { event_types: ['execve'], match_comm: 'dd, fallocate, truncate', action: 'alert' },
  },
];

export function templatesByCategory(): Record<string, PolicyTemplate[]> {
  const out: Record<string, PolicyTemplate[]> = {};
  for (const t of POLICY_TEMPLATES) {
    (out[t.category] ||= []).push(t);
  }
  return out;
}

/** A match_comm or match_filename term shorter than this narrows nothing. */
export const MIN_NARROWING_TERM_LENGTH = 3;

/** Comma-separated criterion → trimmed, lower-cased, non-empty terms. */
export function matchTerms(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Directory names nearly every process path runs through (mirrors commonSystemDirs in Go). */
const COMMON_SYSTEM_DIRS = new Set(['usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32', 'libexec', 'etc', 'var', 'tmp', 'opt', 'home', 'local', 'share']);

/**
 * Mirrors filenameTermNarrows (shared/hostpolicy/trace_policy_comm.go): broad when
 * only slashes, a top-level directory prefix ("/usr/", "/bin", "tmp/") or made
 * only of common system directory names ("lib", "/usr/bin/").
 */
function pathTermNarrows(term: string): boolean {
  const segments = term.split('/').filter(Boolean);
  if (segments.length === 0 || (term.includes('/') && segments.length <= 1)) return false;
  return segments.some((s) => !COMMON_SYSTEM_DIRS.has(s));
}

/** Every term long enough (and, for paths, not a system directory prefix); one weak term broadens the list. */
function termsNarrow(list: string | undefined, path: boolean): boolean {
  const terms = matchTerms(list);
  return terms.length > 0 && terms.every((t) => [...t].length >= MIN_NARROWING_TERM_LENGTH && (!path || pathTermNarrows(t)));
}

/**
 * True when the policy restricts which process it hits beyond event type.
 * Mirrors policyHasNarrowingMatch in shared/hostpolicy/trace_policy_validation.go:
 * UID 0, a path of slashes and any process or path term shorter than
 * MIN_NARROWING_TERM_LENGTH characters still match most of the host.
 */
export function policyHasNarrowingMatch(p: {
  match_comm?: string;
  match_filename?: string;
  match_uid?: number | null;
  match_dest_port?: string;
  match_dest_ip?: string;
}): boolean {
  return (
    termsNarrow(p.match_comm, false) ||
    termsNarrow(p.match_filename, true) ||
    (p.match_uid !== null && p.match_uid !== undefined && p.match_uid !== 0) ||
    !!p.match_dest_port?.trim() ||
    !!p.match_dest_ip?.trim()
  );
}

/**
 * Import a disabled draft; enabling a broad kill policy must be deliberate.
 * A kill template with no narrowing match is imported as an `alert` draft:
 * the server only accepts a broad kill with `kill_acknowledged`, which the
 * operator gives through the kill confirmation when switching it back.
 * The `name`, `description`, MITRE fields, severity and tags are included
 * so the server stores them for SIEM correlation.
 */
export function templateToPolicyBody(t: PolicyTemplate) {
  const broadKill = t.policy.action === 'kill' && !policyHasNarrowingMatch(t.policy);
  return {
    name: t.name,
    description:
      t.description +
      `\n[MITRE ${t.mitre_technique_id}, ${t.mitre_tactic}]` +
      (broadKill ? '\n[Template action: kill. Imported as alert; switch to Kill after review.]' : ''),
    enabled: false,
    event_types: t.policy.event_types ?? [],
    min_severity: t.policy.min_severity ?? '',
    match_comm: t.policy.match_comm ?? '',
    match_comm_mode: 'word' as const,
    match_filename: t.policy.match_filename ?? '',
    match_uid: t.policy.match_uid ?? null,
    match_dest_port: t.policy.match_dest_port ?? '',
    action: broadKill ? 'alert' : t.policy.action,
    kernel_enforce: t.policy.kernel_enforce ?? false,
    mitre_technique_id: t.mitre_technique_id,
    mitre_technique_name: t.mitre_technique_name,
    mitre_tactic: t.mitre_tactic,
    severity: t.severity,
    tags: t.tags,
  };
}
