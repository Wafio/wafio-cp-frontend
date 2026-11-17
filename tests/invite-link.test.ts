import { describe, expect, test } from 'bun:test';
import { completeInviteLink, inviteLoadMessage } from '../src/lib/invite-flow';

// Without a dashboard base URL the server returns a path; the dashboard
// completes it with its own address so the copied link opens anywhere.
describe('completeInviteLink', () => {
  const origin = 'https://demo-cp.wafio.cloud';

  test('project invitation path gets the dashboard address', () => {
    expect(completeInviteLink('/invite/ebf773c7', origin)).toBe('https://demo-cp.wafio.cloud/invite/ebf773c7');
  });

  test('sign-up invitation path keeps its query', () => {
    expect(completeInviteLink('/register?token=abc', origin)).toBe('https://demo-cp.wafio.cloud/register?token=abc');
  });

  test('base path and trailing slashes', () => {
    expect(completeInviteLink('/invite/x', 'http://10.0.0.5:9087/', '/wafio')).toBe('http://10.0.0.5:9087/wafio/invite/x');
  });

  test('absolute links pass unchanged', () => {
    expect(completeInviteLink('https://cp.example.com/invite/x', origin)).toBe('https://cp.example.com/invite/x');
  });

  test('protocol-relative, empty and other values pass unchanged', () => {
    expect(completeInviteLink('//evil.example/invite/x', origin)).toBe('//evil.example/invite/x');
    expect(completeInviteLink('', origin)).toBe('');
    expect(completeInviteLink(undefined, origin)).toBeUndefined();
    expect(completeInviteLink('cp.example.com/invite/x', origin)).toBe('cp.example.com/invite/x');
  });
});

describe('inviteLoadMessage', () => {
  test('a link the server does not know is said in plain words, any other answer keeps the server text', () => {
    expect(inviteLoadMessage({ status: 404, error: 'invite not found' })).toBe('This invitation link does not work. It may have expired or been used already.');
    expect(inviteLoadMessage({ status: 410, error: 'This invitation has expired.' })).toBe('This invitation has expired.');
    expect(inviteLoadMessage({ status: 500, error: '' })).toBe('This invitation link is invalid or has expired.');
  });
});
