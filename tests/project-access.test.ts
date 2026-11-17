import { describe, expect, test } from 'bun:test';
import { canConfigureProject, canManageProject } from '../src/lib/project-access';
import type { Project } from '../src/lib/api';

const project = (role: Project['effective_role']): Project => ({
  id: 'project-1', name: 'Project', code: 'PRJ', description: '',
  created_at: '', updated_at: '', effective_role: role,
  permissions: {
    read: true,
    configure: role === 'member' || role === 'owner',
    manage_members: role === 'owner',
    delete_project: role === 'owner',
  },
});

describe('project UI actions', () => {
  test('viewers cannot change an application or correlation chain', () => {
    expect(canConfigureProject(project('viewer'))).toBe(false);
    expect(canManageProject(project('viewer'))).toBe(false);
  });

  test('members can configure an application but cannot delete it or manage correlation chains', () => {
    expect(canConfigureProject(project('member'))).toBe(true);
    expect(canManageProject(project('member'))).toBe(false);
  });

  test('owners can do both', () => {
    expect(canConfigureProject(project('owner'))).toBe(true);
    expect(canManageProject(project('owner'))).toBe(true);
  });

  test('missing access data never enables mutations', () => {
    expect(canConfigureProject(undefined)).toBe(false);
    expect(canManageProject(undefined)).toBe(false);
  });
});
