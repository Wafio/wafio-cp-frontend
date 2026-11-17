import type { Project, ProjectPermissions, ProjectRole } from './api';

/**
 * Project access rules as the backend enforces them (fiber.go
 * RequireProjectAccess + handlers/projects.go projectPermissions):
 * viewers read; members read and configure (most mutations); owners also
 * delete, manage members and run owner-only actions (app delete, correlation
 * chains). Missing access data never enables a mutation.
 */

export const NO_PROJECT_PERMISSIONS: Readonly<ProjectPermissions> = Object.freeze({
  read: false,
  configure: false,
  manage_members: false,
  delete_project: false,
});

const ROLE_LEVEL: Record<ProjectRole, number> = { viewer: 1, member: 2, owner: 3 };

/** Mirrors roleLevel() in internal/adapter/http/middleware.go; unknown roles are 0. */
export function roleLevel(role: string | null | undefined): number {
  return role && role in ROLE_LEVEL ? ROLE_LEVEL[role as ProjectRole] : 0;
}

export function isProjectRole(role: unknown): role is ProjectRole {
  return typeof role === 'string' && role in ROLE_LEVEL;
}

export function projectPermissions(project: Project | null | undefined): ProjectPermissions {
  return project?.permissions ?? { ...NO_PROJECT_PERMISSIONS };
}

export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  viewer: 'Viewer',
  member: 'Member',
  owner: 'Owner',
};

/** Display label for a role ("Owner"), or '' when unknown. */
export function projectRoleLabel(role: string | null | undefined): string {
  return isProjectRole(role) ? PROJECT_ROLE_LABELS[role] : '';
}

export function canReadProject(project: Project | null | undefined): boolean {
  return project?.permissions?.read === true;
}

export function canConfigureProject(project: Project | null | undefined): boolean {
  return project?.permissions?.configure === true;
}

export function canManageProject(project: Project | null | undefined): boolean {
  return project?.effective_role === 'owner' && project.permissions?.manage_members === true;
}

export function canDeleteProject(project: Project | null | undefined): boolean {
  return project?.effective_role === 'owner' && project.permissions?.delete_project === true;
}
