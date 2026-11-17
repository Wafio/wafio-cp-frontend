/**
 * Project context.
 *
 * The project layout loads the project and the caller's permissions once and
 * shares them with every page below it:
 *
 *   // routes/projects/[id]/+layout.svelte
 *   const project = createProjectContext();
 *   $effect(() => { void project.load(page.params.id); });
 *
 *   // any page or component under it
 *   const project = getProjectContext();
 *   <button disabled={!project.canConfigure}>Save</button>
 *   {project.project?.name}
 *
 * Pages stop calling getProject(); after renaming a project they call
 * `project.refresh()` (or `project.update({ name })`).
 */
import { getContext, hasContext, setContext } from 'svelte';
import { getProject, type ApiError, type ApiResult, type Project, type ProjectPermissions, type ProjectRole } from './api';
import {
  canConfigureProject,
  canDeleteProject,
  canManageProject,
  canReadProject,
  isProjectRole,
  NO_PROJECT_PERMISSIONS,
} from './project-access';

const PROJECT_CONTEXT = Symbol('wafio.project-context');

export type ProjectLoader = (projectId: string) => Promise<ApiResult<Project>>;

export class ProjectContext {
  /** Id of the project being shown (set synchronously by load()). */
  projectId = $state('');
  project = $state<Project | null>(null);
  /** A request for the current project is in flight. */
  loading = $state(false);
  /** Error of the last load; the previous project stays visible on a failed refresh. */
  error = $state<ApiError | null>(null);

  readonly permissions: ProjectPermissions = $derived(this.project?.permissions ?? { ...NO_PROJECT_PERMISSIONS });
  readonly role: ProjectRole | null = $derived.by(() => {
    const role = this.project?.effective_role;
    return isProjectRole(role) ? role : null;
  });
  readonly canRead: boolean = $derived(canReadProject(this.project));
  /** Member or owner: may change configuration (most mutations). */
  readonly canConfigure: boolean = $derived(canConfigureProject(this.project));
  /** Owner: may manage members and run owner-only actions. */
  readonly canManage: boolean = $derived(canManageProject(this.project));
  readonly canDelete: boolean = $derived(canDeleteProject(this.project));

  // Plain mirrors: load() must not read $state synchronously, so calling it
  // inside an effect subscribes that effect to nothing but its own inputs.
  #currentId = '';
  #epoch = 0;
  #loader: ProjectLoader;
  #inflight: Promise<void> | null = null;
  #inflightId = '';

  constructor(loader: ProjectLoader = getProject) {
    this.#loader = loader;
  }

  /**
   * Loads `projectId`. Switching to another project clears the previous one
   * first; a response for a project that is no longer current is dropped.
   * Concurrent loads of the same id share one request.
   */
  load(projectId: string): Promise<void> {
    if (this.#inflight && this.#inflightId === projectId) return this.#inflight;
    const epoch = ++this.#epoch;
    if (projectId !== this.#currentId) {
      this.#currentId = projectId;
      this.projectId = projectId;
      this.project = null;
    }
    this.error = null;
    this.loading = true;
    const request = (async () => {
      let result: ApiResult<Project>;
      try {
        result = await this.#loader(projectId);
      } catch {
        result = { error: { kind: 'network', error: 'Unable to reach the server. Please retry.' } };
      }
      if (epoch !== this.#epoch) return;
      this.loading = false;
      if (result.data) {
        this.project = result.data;
        this.error = null;
      } else {
        this.error = result.error ?? { kind: 'protocol', error: 'Project unavailable' };
      }
    })().finally(() => {
      if (this.#inflight === request) {
        this.#inflight = null;
        this.#inflightId = '';
      }
    });
    this.#inflight = request;
    this.#inflightId = projectId;
    return request;
  }

  /** Reloads the current project (after a rename or a role change). */
  refresh(): Promise<void> {
    if (!this.#currentId) return Promise.resolve();
    if (this.#inflight && this.#inflightId === this.#currentId) {
      // A refresh must observe changes made after the in-flight request started.
      return this.#inflight.then(() => this.#reload());
    }
    return this.#reload();
  }

  /** Applies a local change (e.g. the new name after a successful update) without a request. */
  update(patch: Partial<Project>): void {
    if (!this.project) return;
    this.project = { ...this.project, ...patch };
  }

  #reload(): Promise<void> {
    this.#inflight = null;
    this.#inflightId = '';
    return this.load(this.#currentId);
  }
}

/** Creates the context and provides it to the calling component's children. */
export function createProjectContext(loader?: ProjectLoader): ProjectContext {
  return setProjectContext(new ProjectContext(loader));
}

export function setProjectContext(context: ProjectContext): ProjectContext {
  setContext(PROJECT_CONTEXT, context);
  return context;
}

/** The project context of the enclosing project layout; throws outside it. */
export function getProjectContext(): ProjectContext {
  const context = hasContext(PROJECT_CONTEXT) ? getContext<ProjectContext>(PROJECT_CONTEXT) : undefined;
  if (!context) throw new Error('getProjectContext() must be called from a component under routes/projects/[id]/+layout.svelte');
  return context;
}

/** Like getProjectContext() but undefined outside a project (shared components). */
export function tryGetProjectContext(): ProjectContext | undefined {
  return hasContext(PROJECT_CONTEXT) ? getContext<ProjectContext>(PROJECT_CONTEXT) : undefined;
}
