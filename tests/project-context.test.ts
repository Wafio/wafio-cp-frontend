import { describe, expect, test } from 'bun:test';
import { deferred } from './support/runes';
import type { ApiResult, Project, ProjectRole } from '../src/lib/api';
import { canDeleteProject, projectRoleLabel, roleLevel } from '../src/lib/project-access';

const { ProjectContext } = await import('../src/lib/project-context.svelte');

const project = (id: string, role: ProjectRole, name = id): Project => ({
  id, name, code: `PRJ-${id}`, description: '', created_at: '2026-09-27T00:00:00Z', effective_role: role,
  permissions: { read: true, configure: role !== 'viewer', manage_members: role === 'owner', delete_project: role === 'owner' },
});

describe('project access helpers', () => {
  test('role levels mirror middleware.go', () => {
    expect(roleLevel('viewer')).toBe(1);
    expect(roleLevel('member')).toBe(2);
    expect(roleLevel('owner')).toBe(3);
    expect(roleLevel('admin')).toBe(0);
    expect(roleLevel(undefined)).toBe(0);
    expect(canDeleteProject(project('p', 'owner'))).toBe(true);
    expect(canDeleteProject(project('p', 'member'))).toBe(false);
    expect(projectRoleLabel('owner')).toBe('Owner');
    expect(projectRoleLabel('root')).toBe('');
  });
});

describe('ProjectContext', () => {
  test('loads once and derives permissions', async () => {
    const calls: string[] = [];
    const ctx = new ProjectContext(async (id) => { calls.push(id); return { data: project(id, 'member') }; });
    expect(ctx.canConfigure).toBe(false);
    const a = ctx.load('p1');
    const b = ctx.load('p1');
    expect(a).toBe(b);
    expect(ctx.loading).toBe(true);
    expect(ctx.projectId).toBe('p1');
    await a;
    expect(calls).toEqual(['p1']);
    expect(ctx.loading).toBe(false);
    expect(ctx.project?.name).toBe('p1');
    expect(ctx.role).toBe('member');
    expect(ctx.canRead).toBe(true);
    expect(ctx.canConfigure).toBe(true);
    expect(ctx.canManage).toBe(false);
    expect(ctx.canDelete).toBe(false);
    expect(ctx.permissions.manage_members).toBe(false);
  });

  test('viewer and missing data never enable mutations', async () => {
    const viewer = new ProjectContext(async (id) => ({ data: project(id, 'viewer') }));
    await viewer.load('p');
    expect(viewer.canConfigure).toBe(false);
    expect(viewer.canManage).toBe(false);
    const failed = new ProjectContext(async () => ({ error: { kind: 'http', status: 404, error: 'project not found' } }));
    await failed.load('p');
    expect(failed.project).toBeNull();
    expect(failed.error?.status).toBe(404);
    expect(failed.canConfigure).toBe(false);
    expect(failed.role).toBeNull();
    expect(failed.permissions).toEqual({ read: false, configure: false, manage_members: false, delete_project: false });
  });

  test('switching project drops the late answer for the previous one', async () => {
    const gates: Record<string, ReturnType<typeof deferred<ApiResult<Project>>>> = { p1: deferred(), p2: deferred() };
    const ctx = new ProjectContext((id) => gates[id].promise);
    const first = ctx.load('p1');
    const second = ctx.load('p2');
    expect(ctx.project).toBeNull();
    gates.p2.resolve({ data: project('p2', 'owner') });
    await second;
    gates.p1.resolve({ data: project('p1', 'viewer') });
    await first;
    expect(ctx.project?.id).toBe('p2');
    expect(ctx.canManage).toBe(true);
  });

  test('refresh() refetches and a failed refresh keeps the project visible', async () => {
    let n = 0;
    const ctx = new ProjectContext(async (id) => {
      n++;
      if (n === 1) return { data: project(id, 'owner', 'Old name') };
      if (n === 2) return { data: project(id, 'owner', 'New name') };
      return { error: { kind: 'network', error: 'offline' } };
    });
    await ctx.load('p1');
    await ctx.refresh();
    expect(ctx.project?.name).toBe('New name');
    await ctx.refresh();
    expect(ctx.project?.name).toBe('New name');
    expect(ctx.error?.error).toBe('offline');
    expect(n).toBe(3);
  });

  test('refresh() during the initial load still refetches afterwards', async () => {
    const gate = deferred<ApiResult<Project>>();
    let n = 0;
    const ctx = new ProjectContext(() => { n++; return n === 1 ? gate.promise : Promise.resolve({ data: project('p1', 'owner', 'fresh') }); });
    const loading = ctx.load('p1');
    const refreshing = ctx.refresh();
    gate.resolve({ data: project('p1', 'owner', 'stale') });
    await loading;
    await refreshing;
    expect(n).toBe(2);
    expect(ctx.project?.name).toBe('fresh');
  });

  test('update() applies a local change', async () => {
    const ctx = new ProjectContext(async (id) => ({ data: project(id, 'owner', 'Before') }));
    ctx.update({ name: 'ignored' });
    expect(ctx.project).toBeNull();
    await ctx.load('p1');
    ctx.update({ name: 'After' });
    expect(ctx.project?.name).toBe('After');
  });

  test('a throwing loader becomes a network error', async () => {
    const ctx = new ProjectContext(async () => { throw new Error('socket'); });
    await ctx.load('p1');
    expect(ctx.error?.kind).toBe('network');
    expect(ctx.loading).toBe(false);
  });
});
