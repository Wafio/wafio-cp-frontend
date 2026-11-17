/**
 * Readable names for audit actions. The raw action string stays visible next
 * to the label (it is what exports and filters use); unknown actions fall back
 * to a sentence built from the action itself, so a new server event never
 * shows blank.
 */

const LABELS: Readonly<Record<string, string>> = {
  // Account events (system audit). Administrators log as admin.<event>.
  'user.login': 'Signed in',
  'admin.login': 'Administrator signed in',
  'user.password_changed': 'Changed password',
  'admin.password_changed': 'Administrator changed password',
  'user.registered_by_invite': 'Registered from an invitation',
  'user.2fa_login': 'Two-factor sign-in',
  'user.2fa_enable': 'Two-factor setup attempt',
  'user.2fa_enabled': 'Enabled two-factor authentication',
  'user.2fa_disable': 'Two-factor removal attempt',
  'user.2fa_disabled': 'Disabled two-factor authentication',
  'user.2fa_backup_codes_regenerate': 'Regenerated backup codes',
  'user.logout_all': 'Signed out everywhere',
  // Password recovery by email; failure = throttled, no email sent.
  'auth.password_reset_requested': 'Asked for a password reset email',
  'auth.password_reset_completed': 'Reset the password from an email link',
  'admin.user_created': 'Created a user',
  'admin.user_updated': 'Updated a user',
  'admin.user_deleted': 'Deleted a user',
  'admin.password_reset': 'Reset a password',
  'admin.invite_created': 'Created an invitation',
  'admin.invite_deleted': 'Deleted an invitation',
  'admin.security_data_updated': 'Updated security data',
  'admin.malware_auth_key_saved': 'Saved the malware feed key',
  'admin.malware_auth_key_removed': 'Removed the malware feed key',
  'admin.smtp_settings_updated': 'Updated the email (SMTP) settings',
  'admin.smtp_settings_cleared': 'Cleared the saved email (SMTP) settings',
  'admin.smtp_test_sent': 'Sent a test email',
  // Project and membership events.
  'project.created': 'Created the project',
  'project.updated': 'Updated the project',
  'project.deleted': 'Deleted the project',
  'member.added': 'Added a member',
  'member.role_changed': 'Changed a member role',
  'member.removed': 'Removed a member',
  'member.joined_by_invite': 'Joined from an invitation',
  'correlation.rule_created': 'Created a correlation rule',
  'correlation.rule_updated': 'Updated a correlation rule',
  'correlation.rule_deleted': 'Deleted a correlation rule'
};

/** Readable label of an audit action, e.g. "user.login" → "Signed in". */
export function auditActionLabel(action: string | null | undefined): string {
  const key = (action ?? '').trim();
  if (!key) return 'Unknown action';
  const known = LABELS[key];
  if (known) return known;
  const [scope, ...rest] = key.split('.');
  const verb = rest.join(' ').replace(/_/g, ' ').trim();
  if (!verb) return key;
  const text = `${scope.replace(/_/g, ' ')} ${verb}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Category tabs of the project Audit log: action prefixes per tab
 * (comma-separated OR on the server, GET /projects/:id/audit-log?action=).
 * Correlation rules are part of Runtime security.
 */
export const PROJECT_AUDIT_CATEGORIES = [
  { id: 'all', label: 'All', action: '' },
  { id: 'project', label: 'Project and members', action: 'project.,member.' },
  { id: 'waf', label: 'WAF', action: 'app.,waf.' },
  { id: 'agent', label: 'Agents', action: 'agent.' },
  { id: 'host', label: 'Hosts', action: 'host.' },
  { id: 'firewall', label: 'Firewall', action: 'firewall.' },
  { id: 'runtime', label: 'Runtime security', action: 'trace.,incident.,correlation.' },
  { id: 'credential', label: 'Credentials', action: 'credential.' },
];
