/**
 * The path names the WAF agent never serves from a folder: a request with a part of that name is not answered from
 * the folder, and a folder with such a part in its path is refused. They are the names the host agent always reports
 * when a file of that name is opened (system files and folders such as shadow, private, profile or network).
 * A copy of tests/fixtures/backend/trace-keep-names.json, which a test compares; lower case, matched in any case.
 */
export const KEPT_NAMES: readonly string[] = [
  '.aws', '.azure', '.bash_login', '.bash_profile', '.bashrc', '.docker', '.profile', '.zprofile', '.zshenv',
  '.zshrc', 'authorized_keys', 'autostart', 'bash.bashrc', 'credentials', 'cron', 'cron.d', 'cron.daily',
  'cron.hourly', 'cron.monthly', 'cron.weekly', 'crontab', 'crontabs', 'environ', 'environment', 'group', 'gshadow',
  'hostname', 'hosts', 'id_dsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_rsa', 'init.d',
  'iptables', 'ld.so.conf', 'ld.so.conf.d', 'login.defs', 'master.passwd', 'mem', 'netplan', 'network',
  'networkmanager', 'nftables.conf', 'nsswitch.conf', 'pam.d', 'passwd', 'private', 'privkey.pem', 'profile',
  'profile.d', 'rc.d', 'rc.local', 'resolv.conf', 'secring.gpg', 'security', 'shadow', 'ssh_host_dsa_key',
  'ssh_host_ecdsa_key', 'ssh_host_ed25519_key', 'ssh_host_rsa_key', 'sudoers', 'sudoers.d', 'systemd',
  'wafio-waf-agent',
];

const KEPT = new Set(KEPT_NAMES);

/** The first part of the folder path that is one of these names, as written, or null. */
export function keptSegment(root: string): string | null {
  return root.split('/').find((segment) => KEPT.has(segment.toLowerCase())) ?? null;
}
