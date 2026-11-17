/**
 * WafPolicyForm, reactive state of the WAF policy editor.
 *
 *   const form = WafPolicyForm.fromRules(rules, { includeWebSocket: true });
 *   <input bind:value={form.draft.bot.scoreThreshold} />
 *   form.isDirty, form.changes, form.issues          // reactive
 *   await onSave({ rules_json: form.toRules() });
 *   form.markSaved();
 *
 * `toRules()` writes the draft on top of the rules it was loaded from, so
 * keys the form does not manage survive; `fromRules(form.toRules())` gives
 * the same draft back (web/tests/waf-policy-form.test.ts).
 */
import { createDirtyTracker, type ConfirmFn, type DirtyTracker } from '../../dirty.svelte';
import {
  draftFromRules,
  rulesFromDraft,
  toJsonValue,
  type Json,
  type PolicyDraft,
  type PolicyOptions
} from './model';
import { validatePolicy, fieldId, type PolicyIssue, type SectionId, type ValidationContext } from './validate';
import { diffPolicy, type PolicyChange } from './review';
import type { ConfigSecretFlags } from '../../api';
import type { InspectionScope } from '../../inspection';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Draft path lookup ("bot.scoreThreshold"). */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export class WafPolicyForm {
  /** Editable draft; bind inputs directly to its fields. */
  draft = $state<PolicyDraft>(draftFromRules({}));
  /** Set after a save attempt: every issue is shown, not only those of edited fields. */
  submitted = $state(false);
  /** Country codes known to the server (upper case), for validation. */
  countryCodes = $state.raw<ReadonlySet<string>>(new Set());
  /** Credential flags of the loaded config; secrets_redacted = viewer read, never save. */
  secrets = $state.raw<ConfigSecretFlags | null>(null);
  /** Application or project defaults: whom the inspection texts talk about. */
  engineScope = $state<InspectionScope>('project');
  /** A section/group the error summary asks to reveal (e.g. open "Advanced scoring"). */
  reveal = $state<{ section: SectionId; group?: string; seq: number } | null>(null);

  readonly options: Readonly<PolicyOptions>;
  #original: Json;
  #tracker: DirtyTracker<PolicyDraft>;
  #confirm: ConfirmFn | undefined;

  readonly isDirty: boolean = $derived.by(() => this.#tracker.isDirty);
  readonly issues: PolicyIssue[] = $derived.by(() =>
    validatePolicy(this.draft, { countryCodes: this.countryCodes, includeWebSocket: this.options.includeWebSocket })
  );
  readonly changes: PolicyChange[] = $derived.by(() =>
    this.#tracker.isDirty ? diffPolicy(this.#tracker.baseline, $state.snapshot(this.draft) as PolicyDraft, { includeWebSocket: this.options.includeWebSocket }) : []
  );
  readonly changeCount: number = $derived(this.changes.length);

  constructor(rules: Json | null | undefined, options: PolicyOptions = {}) {
    this.options = { ...options };
    this.#original = clone(rules ?? {});
    this.draft = draftFromRules(this.#original);
    this.#tracker = createDirtyTracker(() => this.draft, {
      confirm: (message) => (this.#confirm ? this.#confirm(message) : typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : true)
    });
  }

  /** Prompt used by confirmDiscard() and the navigation guard (default window.confirm). */
  setConfirm(confirm: ConfirmFn | undefined): void {
    this.#confirm = confirm;
  }

  static fromRules(rules: Json | null | undefined, options: PolicyOptions = {}): WafPolicyForm {
    return new WafPolicyForm(rules, options);
  }

  /** The rules the form was loaded from (read-only copy). */
  get original(): Json {
    return this.#original;
  }

  get baseline(): PolicyDraft {
    return this.#tracker.baseline;
  }

  /** rules_json to save: the draft written on top of the loaded rules (no `undefined` members). */
  toRules(): Json {
    return toJsonValue(rulesFromDraft($state.snapshot(this.draft) as PolicyDraft, this.#original, this.options));
  }

  /** Validation with an explicit context (tests); the reactive list is `issues`. */
  validate(ctx: ValidationContext = {}): PolicyIssue[] {
    return validatePolicy(this.draft, { countryCodes: this.countryCodes, includeWebSocket: this.options.includeWebSocket, ...ctx });
  }

  /** Field changed since load/save (its errors show before the first save attempt). */
  isChanged(path: string): boolean {
    return JSON.stringify(readPath(this.draft, path)) !== JSON.stringify(readPath(this.#tracker.baseline, path));
  }

  /** Visible error for a draft path, or undefined. */
  error(path: string): string | undefined {
    const issue = this.issues.find((item) => item.path === path);
    if (!issue) return undefined;
    return this.submitted || this.isChanged(path) ? issue.message : undefined;
  }

  /** Visible issues (all after a save attempt, otherwise those of edited fields). */
  get visibleIssues(): PolicyIssue[] {
    return this.submitted ? this.issues : this.issues.filter((issue) => this.isChanged(issue.path));
  }

  issueCount(section: SectionId): number {
    return this.visibleIssues.filter((issue) => issue.section === section).length;
  }

  changedSection(section: SectionId): boolean {
    return this.changes.some((change) => change.section === section);
  }

  /** Plain copy of the current draft (e.g. the state being saved). */
  snapshot(): PolicyDraft {
    return clone($state.snapshot(this.draft) as PolicyDraft);
  }

  /**
   * Makes the saved state the baseline after a successful save: `draft` is
   * the snapshot taken when the save started (edits typed while it was in
   * flight stay unsaved); without it the current draft is used.
   */
  markSaved(rules?: Json, draft?: PolicyDraft): void {
    if (rules) this.#original = clone(rules);
    if (draft) this.#tracker.reset(draft);
    else this.#tracker.reset();
    this.submitted = false;
  }

  /**
   * Replaces the loaded rules in place (reload after a conflict, a restore
   * or a new revision from the page). Unsaved edits are dropped; the same
   * instance keeps its navigation guard.
   */
  load(rules: Json | null | undefined): void {
    this.#original = clone(rules ?? {});
    this.draft = draftFromRules(this.#original);
    this.#tracker.reset();
    this.submitted = false;
    this.reveal = null;
  }

  /** Restores the last saved draft. */
  discard(): void {
    this.draft = clone(this.#tracker.baseline);
    this.submitted = false;
  }

  /** Asks the error summary target's section to show the control (opens a collapsed group). */
  revealIssue(issue: Pick<PolicyIssue, 'section' | 'group'>): void {
    this.reveal = { section: issue.section, group: issue.group, seq: (this.reveal?.seq ?? 0) + 1 };
  }

  /** True when not dirty or the operator agrees to discard. */
  confirmDiscard(message?: string): Promise<boolean> {
    return this.#tracker.confirmDiscard(message);
  }

  /** Navigation guard; call during component initialisation. */
  guardNavigation(): void {
    this.#tracker.guardNavigation();
  }
}

export { fieldId };
