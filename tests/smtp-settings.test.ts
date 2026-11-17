import { describe, expect, test } from 'bun:test';
import type { SmtpSettings } from '../src/lib/api';
import {
  SECURITY_OPTIONS,
  buildSmtpUpdate,
  defaultPort,
  formFromSettings,
  hasErrors,
  hasSavedSettings,
  isBaseUrl,
  isManaged,
  passwordClearedBy,
  smtpStatus,
  sourceNote,
  testRecipientError,
  validateSmtpForm,
} from '../src/lib/smtp-settings';
import { documentTitle } from '../src/lib/shell-nav';

function settings(over: Partial<SmtpSettings> = {}): SmtpSettings {
  return {
    host: 'smtp.example.test',
    port: 587,
    security: 'starttls',
    username: 'mailer',
    password_set: true,
    from_address: 'noreply@example.test',
    from_name: 'WAFio',
    base_url: 'https://dash.example.test',
    sources: { host: 'saved', port: 'saved', security: 'saved', username: 'saved', password: 'saved', from_address: 'saved', from_name: 'saved', base_url: 'saved' },
    smtp_managed_by_config: false,
    base_url_managed_by_config: false,
    editable: true,
    mail_configured: true,
    recovery_available: true,
    ...over,
  };
}

describe('form from settings', () => {
  test('never carries a password; a defaulted port stays empty', () => {
    const form = formFromSettings(settings());
    expect(form.password).toBe('');
    expect(form.clearPassword).toBe(false);
    expect(form.port).toBe('587');
    const defaulted = formFromSettings(settings({ port: 465, security: 'tls', sources: { port: 'default', security: 'saved' } }));
    expect(defaulted.port).toBe('');
    expect(defaultPort(defaulted.security)).toBe(465);
    expect(defaultPort('starttls')).toBe(587);
    expect(formFromSettings(settings({ security: 'weird' })).security).toBe('auto');
  });

  test('security options match the server', () => {
    expect(SECURITY_OPTIONS.map((o) => o.value)).toEqual(['auto', 'starttls', 'tls', 'none']);
  });
});

describe('update body', () => {
  test('only changed editable fields; empty password keeps; clear removes', () => {
    const s = settings();
    const base = formFromSettings(s);
    expect(buildSmtpUpdate({ ...base }, base, s)).toEqual({});
    expect(buildSmtpUpdate({ ...base, fromName: ' Ops ', port: '2525' }, base, s)).toEqual({ from_name: 'Ops', port: 2525 });
    expect(buildSmtpUpdate({ ...base, password: 'new-secret' }, base, s)).toEqual({ password: 'new-secret' });
    expect(buildSmtpUpdate({ ...base, password: 'typed', clearPassword: true }, base, s)).toEqual({ clear_password: true });
    expect(buildSmtpUpdate({ ...base, port: '' }, base, s)).toEqual({ port: 0 });
    expect(buildSmtpUpdate({ ...base, security: 'tls' }, base, s)).toEqual({ security: 'tls' });
  });

  test('fields from the server configuration are never sent', () => {
    const s = settings({
      smtp_managed_by_config: true,
      sources: { host: 'config', port: 'config', security: 'config', username: 'config', password: 'config', from_address: 'config', from_name: 'config', base_url: 'saved' },
    });
    const base = formFromSettings(s);
    const update = buildSmtpUpdate({ ...base, host: 'other.example.test', password: 'x', clearPassword: true, baseUrl: 'https://new.example.test' }, base, s);
    expect(update).toEqual({ base_url: 'https://new.example.test' });
    expect(isManaged(s, 'host')).toBe(true);
    expect(isManaged(s, 'base_url')).toBe(false);
    expect(sourceNote('config')).toContain('server configuration');
    expect(sourceNote('saved')).toBe('');
  });
});

describe('password cleared by a host or username change', () => {
  const s = settings();
  const base = formFromSettings(s);
  test('a changed host or username without a new password clears it', () => {
    expect(passwordClearedBy({ ...base, host: 'evil.example.test' }, base, s)).toBe('host');
    expect(passwordClearedBy({ ...base, username: 'other' }, base, s)).toBe('username');
    expect(passwordClearedBy({ ...base, host: 'evil.example.test', username: 'other' }, base, s)).toBe('host and username');
  });
  test('same value, a new password, an explicit clear or no saved password: no note', () => {
    expect(passwordClearedBy({ ...base, host: ' SMTP.Example.TEST ', username: ' mailer ' }, base, s)).toBeNull();
    expect(passwordClearedBy({ ...base, host: 'evil.example.test', password: 'p' }, base, s)).toBeNull();
    expect(passwordClearedBy({ ...base, host: 'evil.example.test', clearPassword: true }, base, s)).toBeNull();
    expect(passwordClearedBy({ ...base, host: 'evil.example.test' }, base, settings({ password_set: false }))).toBeNull();
  });
});

describe('validation', () => {
  const s = settings();
  const ok = formFromSettings(s);

  test('a complete form passes', () => {
    expect(hasErrors(validateSmtpForm(ok, s))).toBe(false);
    expect(hasErrors(validateSmtpForm({ ...ok, host: '192.0.2.25' }, s))).toBe(false);
    expect(hasErrors(validateSmtpForm({ ...ok, host: '2001:db8::25' }, s))).toBe(false);
    expect(hasErrors(validateSmtpForm({ ...ok, port: '' }, s))).toBe(false);
  });

  test('bad values name their field', () => {
    expect(validateSmtpForm({ ...ok, host: 'smtp example.test' }, s).host).toBeDefined();
    for (const port of ['0', '65536', '25.5', 'abc']) expect(validateSmtpForm({ ...ok, port }, s).port).toBeDefined();
    expect(validateSmtpForm({ ...ok, username: 'a\r\nRCPT TO:<x@example.test>' }, s).username).toBeDefined();
    expect(validateSmtpForm({ ...ok, password: 'pw\nnext' }, s).password).toBeDefined();
    expect(validateSmtpForm({ ...ok, fromAddress: 'WAFio <noreply@example.test>' }, s).from_address).toBeDefined();
    expect(validateSmtpForm({ ...ok, fromAddress: '' }, s).from_address).toBe('A sender address is required with a mail server.');
    expect(validateSmtpForm({ ...ok, fromName: 'x\r\nBcc: y' }, s).from_name).toBeDefined();
    expect(validateSmtpForm({ ...ok, baseUrl: 'dash.example.test' }, s).base_url).toBeDefined();
  });

  test('read-only fields are not judged', () => {
    const managed = settings({ sources: { host: 'config', from_address: 'config' } });
    expect(validateSmtpForm({ ...ok, host: 'bad host', fromAddress: '' }, managed)).toEqual({});
  });

  test('base URL: absolute http(s) only, no query or fragment', () => {
    for (const good of ['https://waf.example.test', 'http://localhost:5173', 'https://example.test/wafio/']) expect(isBaseUrl(good)).toBe(true);
    for (const bad of ['waf.example.test', '/dashboard', 'ftp://example.test', 'https://u:p@example.test', 'https://example.test/?a=1', 'https://example.test/#x', 'javascript:alert(1)']) {
      expect(isBaseUrl(bad)).toBe(false);
    }
  });

  test('test recipient', () => {
    expect(testRecipientError('')).toBeNull();
    expect(testRecipientError('admin@example.test')).toBeNull();
    expect(testRecipientError('not an address')).toBe('Enter one email address to send the test to.');
  });
});

describe('status and shell', () => {
  test('status line', () => {
    expect(smtpStatus(settings()).tone).toBe('success');
    expect(smtpStatus(settings({ recovery_available: false, base_url: '' })).tone).toBe('warning');
    expect(smtpStatus(settings({ recovery_available: false, base_url_problem: 'the dashboard base URL is not an absolute http(s) URL' })).message).toContain('not usable');
    expect(smtpStatus(settings({ recovery_available: false, mail_configured: false })).tone).toBe('info');
  });

  test('clear is offered only when something is saved', () => {
    expect(hasSavedSettings(settings())).toBe(true);
    expect(hasSavedSettings(settings({ sources: { host: 'config', base_url: 'none', port: 'default' } }))).toBe(false);
    expect(hasSavedSettings(null)).toBe(false);
  });

  test('page title', () => {
    expect(documentTitle({ path: '/admin/email' })).toBe('Email (SMTP) | Administration | WAFio');
  });
});
