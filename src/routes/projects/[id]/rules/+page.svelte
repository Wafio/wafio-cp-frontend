<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { base } from '#lib/paths.js';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import plus from 'svelte-awesome/icons/plus';
  import pencil from 'svelte-awesome/icons/pencil';
  import copy from 'svelte-awesome/icons/copy';
  import trash from 'svelte-awesome/icons/trash';
  import refresh from 'svelte-awesome/icons/refresh';
  import download from 'svelte-awesome/icons/download';
  import upload from 'svelte-awesome/icons/upload';
  import {
    listApps,
    listCustomRules,
    createCustomRule,
    updateCustomRule,
    deleteCustomRule,
    getAppWAFAgent,
    type App,
    type AppWAFAssignment,
    type CustomRule,
    type CustomRuleCondition,
    type CreateCustomRuleBody,
  } from '#lib/api.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import CustomRuleModal, { type CustomRuleModalMode } from '#lib/components/CustomRuleModal.svelte';
  import { regexNotAppliedMessage, ruleRegexError } from '#lib/components/rules/regex-error.js';
  import UddinCodeViewer from '#lib/components/UddinCodeViewer.svelte';
  import RuleImportDialog from '#lib/components/rules/RuleImportDialog.svelte';
  import RuleStagesExplainer from '#lib/components/rules/RuleStagesExplainer.svelte';
  import { RULE_STAGES } from '#lib/components/rules/rule-stages.js';
  import { effectLogsOnly } from '#lib/waf-config.js';
  import { disableRisk, enableRisk, tuningScopeMatchesEverything, tuningTurnsInspectionOff, type RuleRisk } from '#lib/components/rules/rule-risk.js';
  import { scriptRulesWarning } from '#lib/inspection.js';
  import { scanModeFromStored, semanticEngineLabel } from '#lib/components/rules/registry.js';
  import { TUNING_PREFILL_KEYS, tuningPrefillRule, wantsTuningPrefill } from '#lib/components/rules/tuning-prefill.js';
  import {
    MAX_IMPORT_FILE_BYTES,
    MAX_RULES_PER_APP,
    buildRulesExport,
    exportFileName,
    parseRulesFile,
    remainingImportRows,
    type ImportItem,
    type ImportRow,
  } from '#lib/custom-rules-io.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { continuingRules, dismissContinueNotice, isContinueNoticeDismissed } from '#lib/components/rules/continue-notice.js';
  import { SCRIPT_OWNER_MESSAGE, canEditScriptRules, ruleSaveError } from '#lib/components/rules/script-access.js';
  import { actionTone, categoryTone } from '#lib/tone.js';
  import { formatDateTime, formatNumber, formatRelative } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { readChoiceParam, readTextParam } from '#lib/url-state.js';

  /** List rows carry 30-day hit stats when the server has them. */
  type RuleRow = CustomRule & { hit_count?: number; last_hit_at?: string };
  type TypeFilter = 'all' | 'enabled' | 'disabled' | 'gui' | 'tuning' | 'script';
  type ActionFilter = 'all' | 'block' | 'allow' | 'challenge' | 'log';
  type SortKey = 'priority' | 'name' | 'newest';

  const project = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const canConfigure = $derived(project.canConfigure);
  // Script rules need project owner; members still read them.
  const canEditScripts = $derived(canConfigure && canEditScriptRules(project.role));

  const MODE_VOCAB = ['gui', 'tuning', 'script'];
  const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
    { value: 'gui', label: RULE_STAGES.gui.label },
    { value: 'tuning', label: RULE_STAGES.tuning.label },
    { value: 'script', label: RULE_STAGES.script.label },
  ];
  const ACTION_LABEL: Record<string, string> = { block: 'Block', allow: 'Allow', challenge: 'Challenge', log: 'Log' };

  // ── Applications ──
  let apps: App[] = $state([]);
  let appsLoading = $state(true);
  let appsError = $state('');
  let appsReload = $state(0);

  // ── The application's WAF agent: what it can run decides some warnings below ──
  let appAgent = $state<AppWAFAssignment | null>(null);
  // Only an explicit false changes anything; no agent assigned or an older control plane is unknown.
  const scriptWarning = $derived(scriptRulesWarning(appAgent?.script_rules, 'app'));

  // ── Rules ──
  let rules: RuleRow[] = $state([]);
  let rulesLoading = $state(false);
  let rulesError = $state('');
  let loadEpoch = 0;

  // ── Filters (app, type, action, sort and search live in the URL) ──
  const ACTION_FILTERS: readonly ActionFilter[] = ['all', 'block', 'allow', 'challenge', 'log'];
  const SORT_KEYS: readonly SortKey[] = ['priority', 'name', 'newest'];
  const ACTION_FILTER_OPTIONS: { value: ActionFilter; label: string }[] = [
    { value: 'all', label: 'Any' },
    { value: 'block', label: 'Block' },
    { value: 'allow', label: 'Allow' },
    { value: 'challenge', label: 'Challenge' },
    { value: 'log', label: 'Log' },
  ];
  const SORT_OPTIONS: { value: SortKey; label: string }[] = [
    { value: 'priority', label: 'Priority (run order)' },
    { value: 'name', label: 'Name A–Z' },
    { value: 'newest', label: 'Newest first' },
  ];
  const actionFilter = $derived(readChoiceParam(page.url.searchParams, 'action', ACTION_FILTERS, 'all'));
  const sortBy = $derived(readChoiceParam(page.url.searchParams, 'sort', SORT_KEYS, 'priority'));
  // The box is local while typing; the URL (?q=) follows after a pause.
  let searchQuery = $state(readTextParam(page.url.searchParams, 'q'));
  $effect(() => {
    const q = searchQuery.trim();
    if (q === untrack(() => readTextParam(page.url.searchParams, 'q'))) return;
    const timer = setTimeout(() => setQuery({ q: q || null }), 300);
    return () => clearTimeout(timer);
  });
  let expandedKeys = $state<Array<string | number>>([]);

  const typeFilter = $derived.by<TypeFilter>(() => {
    const t = page.url.searchParams.get('type');
    return TYPE_FILTERS.some((f) => f.value === t) ? (t as TypeFilter) : 'all';
  });
  const selectedAppId = $derived.by(() => {
    const fromUrl = page.url.searchParams.get('app');
    if (fromUrl && apps.some((a) => a.id === fromUrl)) return fromUrl;
    return apps[0]?.id ?? '';
  });
  const selectedApp = $derived(apps.find((a) => a.id === selectedAppId));

  // ── Dialogs ──
  let modalOpen = $state(false);
  let modalMode = $state<CustomRuleModalMode>('create');
  let modalRule = $state<CustomRule | null>(null);
  let deleteTarget = $state<RuleRow | null>(null);
  let deleting = $state(false);
  let togglingId = $state<string | null>(null);
  let pendingConfirm = $state<{ risk: RuleRisk; resolve: (ok: boolean) => void } | null>(null);

  // ── Import ──
  let importInput: HTMLInputElement | null = $state(null);
  let importOpen = $state(false);
  let importRows = $state<ImportRow[]>([]);
  let importFileName = $state('');
  let importing = $state(false);
  /** Errors of the last import attempt by file row; the dialog stays open while any are left. */
  let importErrors = $state<Record<number, string>>({});

  function setQuery(changes: Record<string, string | null>) {
    const params = new URLSearchParams(page.url.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    void goto(`${page.url.pathname}${qs ? `?${qs}` : ''}`, { replace: true, reset: false });
  }

  function selectApp(id: string) {
    setQuery({ app: id === apps[0]?.id ? null : id });
  }

  function setTypeFilter(value: TypeFilter) {
    setQuery({ type: value === 'all' ? null : value });
  }

  // Every application of the project (the list endpoint pages at 100).
  async function loadAllApps(id: string): Promise<{ apps: App[]; error?: string }> {
    const out: App[] = [];
    for (let offset = 0, guard = 0; guard < 20; guard++) {
      const res = await listApps(id, { limit: 100, offset });
      if (res.error || !res.data) return { apps: out, error: res.error?.error ?? 'Applications could not be loaded.' };
      out.push(...(res.data.apps ?? []));
      offset += res.data.apps?.length ?? 0;
      if (!res.data.apps?.length || offset >= (res.data.total ?? 0)) break;
    }
    return { apps: out };
  }

  $effect(() => {
    const id = projectId;
    void appsReload;
    let active = true;
    appsLoading = true;
    appsError = '';
    void loadAllApps(id).then((res) => {
      if (!active) return;
      apps = res.apps;
      appsError = res.error ?? '';
      appsLoading = false;
    });
    return () => {
      active = false;
    };
  });

  $effect(() => {
    const id = projectId;
    const appId = selectedAppId;
    appAgent = null;
    if (!id || !appId) return;
    let active = true;
    void getAppWAFAgent(id, appId).then((res) => {
      if (active) appAgent = res.data ?? null;
    });
    return () => {
      active = false;
    };
  });

  async function loadRules() {
    const id = projectId;
    const appId = selectedAppId;
    const epoch = ++loadEpoch;
    if (!id || !appId) {
      rules = [];
      return;
    }
    rulesLoading = true;
    rulesError = '';
    const res = await listCustomRules(id, appId);
    if (epoch !== loadEpoch) return;
    rulesLoading = false;
    if (res.data) {
      rules = (res.data.rules ?? []) as RuleRow[];
    } else {
      rulesError = res.error?.error ?? 'Custom rules could not be loaded.';
    }
  }

  $effect(() => {
    void projectId;
    void selectedAppId;
    expandedKeys = [];
    void loadRules();
  });

  // ── Notice: log/challenge rules no longer stop inspection ──
  let continueNoticeDismissed = $state(false);
  $effect(() => {
    const id = projectId;
    continueNoticeDismissed = isContinueNoticeDismissed(id);
  });
  const continuing = $derived(continuingRules(rules));
  const regexBroken = $derived(rules.filter((r) => ruleRegexError(r) !== ''));
  function hideContinueNotice() {
    dismissContinueNotice(projectId);
    continueNoticeDismissed = true;
  }

  // ── Derived list ──
  function matchesType(r: RuleRow): boolean {
    switch (typeFilter) {
      case 'enabled':
        return r.enabled;
      case 'disabled':
        return !r.enabled;
      case 'gui':
      case 'tuning':
      case 'script':
        return r.mode === typeFilter;
      default:
        return true;
    }
  }

  // Search covers name, description, action, type, condition fields and
  // values, script source and tuning targets/skip lists, so "942100" or
  // "header:x-api-key" finds the rules that mention them.
  function ruleSearchText(r: RuleRow): string {
    const parts: string[] = [r.name, r.description ?? '', r.action, r.mode, RULE_STAGES[r.mode]?.label ?? ''];
    for (const c of r.conditions ?? []) parts.push(c.field ?? '', c.operator ?? '', c.value ?? '');
    if (r.script) parts.push(r.script);
    if (r.tuning) {
      parts.push(...(r.tuning.target?.components ?? []));
      parts.push(...(r.tuning.effect?.skip_semantic ?? []));
      for (const c of r.tuning.scope?.conditions ?? []) parts.push(c.field ?? '', c.value ?? '');
    }
    return parts.join(' ').toLowerCase();
  }

  const filteredRules = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    const out = rules.filter((r) => {
      if (!matchesType(r)) return false;
      // Only Match & act rules act on their stored action.
      if (actionFilter !== 'all' && (r.mode !== 'gui' || r.action !== actionFilter)) return false;
      return !q || ruleSearchText(r).includes(q);
    });
    switch (sortBy) {
      case 'name':
        return out.sort((a, b) => a.name.localeCompare(b.name));
      case 'newest':
        return out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      default:
        return out.sort((a, b) => a.priority - b.priority || (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    }
  });

  const stats = $derived({
    total: rules.length,
    enabled: rules.filter((r) => r.enabled).length,
    gui: rules.filter((r) => r.mode === 'gui').length,
    tuning: rules.filter((r) => r.mode === 'tuning').length,
    script: rules.filter((r) => r.mode === 'script').length,
  });
  const filtersActive = $derived(Boolean(searchQuery.trim()) || typeFilter !== 'all' || actionFilter !== 'all');

  // ── Summaries ──
  function conditionText(c: CustomRuleCondition): string {
    const op = c.operator === 'matches' || c.operator === 'regex' ? 'matches regex' : c.operator.replace(/_/g, ' ');
    const value = c.operator === 'exists' ? '' : ` "${c.value}"`;
    const fx = c.transforms?.length ? ` after ${c.transforms.join(' → ')}` : '';
    return `${c.negate ? 'NOT ' : ''}${c.field} ${op}${value}${fx}`;
  }

  function tuningEffectSummary(rule: RuleRow): string {
    const t = rule.tuning;
    if (!t) return 'No effect configured';
    const parts: string[] = [];
    const sem = t.effect?.skip_semantic ?? [];
    if (tuningTurnsInspectionOff(t)) parts.push('inspection off for matched requests');
    else if (sem.length) parts.push(`skip ${sem.map(semanticEngineLabel).join(', ')}`);
    if (scanModeFromStored(t.effect?.scan_mode) === 'both') parts.push('inspect fully');
    if (effectLogsOnly(t.effect)) parts.push('log only');
    return parts.join(' · ') || 'No effect configured';
  }

  function scriptPreview(script: string): string {
    const lines = (script ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    return lines.slice(0, 2).join(' ') || 'Empty script';
  }

  // ── Confirmation (tiers from rule-risk) ──
  function askConfirm(risk: RuleRisk): Promise<boolean> {
    return new Promise((resolve) => {
      pendingConfirm = { risk, resolve };
    });
  }

  function settleConfirm(ok: boolean) {
    const pending = pendingConfirm;
    pendingConfirm = null;
    pending?.resolve(ok);
  }

  // ── Actions ──
  function openEditor(mode: CustomRuleModalMode, rule: CustomRule | null = null) {
    if (!canConfigure || !selectedAppId) return;
    modalMode = mode;
    modalRule = rule;
    modalOpen = true;
  }

  // "Tune false positive" in an application's decision drawer links here with
  // ?create=tuning&app=…: open a new tuning rule prefilled from the query once
  // the applications and the project role are known, then drop the hand-off
  // keys from the URL so a reload does not open it again.
  $effect(() => {
    const params = page.url.searchParams;
    if (!wantsTuningPrefill(params) || appsLoading || !project.project || !selectedAppId) return;
    untrack(() => {
      const wanted = params.get('app');
      const rule = wanted && wanted !== selectedAppId ? null : tuningPrefillRule(params, selectedAppId);
      setQuery(Object.fromEntries(TUNING_PREFILL_KEYS.map((key) => [key, null])));
      if (!rule) {
        toast.error('The application of that decision was not found in this project.', 'Tuning rule not started');
        return;
      }
      if (!canConfigure) {
        toast.info('Members and owners can add tuning rules.', 'Read-only access');
        return;
      }
      openEditor('create', rule);
    });
  });

  // The editor asks before a save that weakens protection (saveRisk).
  async function handleSaveRule(body: CreateCustomRuleBody): Promise<boolean> {
    if (!projectId || !selectedAppId) return false;
    const res =
      modalMode === 'edit' && modalRule
        ? await updateCustomRule(projectId, selectedAppId, modalRule.id, body)
        : await createCustomRule(projectId, selectedAppId, body);
    if (res.error) throw ruleSaveError(res.error);
    const state = body.enabled === false ? ' (disabled)' : '';
    toast.success(modalMode === 'edit' ? `Rule "${body.name}" saved.` : `Rule "${body.name}" created${state}.`);
    const regexNotice = regexNotAppliedMessage(res.data);
    if (regexNotice) toast.warning(regexNotice, `Rule "${body.name}" saved but not applied`);
    await loadRules();
    return true;
  }

  async function toggleEnabled(rule: RuleRow) {
    if (!canConfigure || !projectId || !selectedAppId || togglingId) return;
    if (rule.mode === 'script' && !canEditScripts) {
      toast.error(SCRIPT_OWNER_MESSAGE);
      return;
    }
    const next = !rule.enabled;
    const risk = next ? enableRisk(rule) : disableRisk(rule);
    if (risk && !(await askConfirm(risk))) return;
    togglingId = rule.id;
    const res = await updateCustomRule(projectId, selectedAppId, rule.id, { enabled: next });
    togglingId = null;
    if (res.error) {
      const failure = ruleSaveError(res.error, 'The rule could not be updated.');
      toast.error(failure.message, failure.title);
      return;
    }
    rules = rules.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r));
    toast.success(`Rule "${rule.name}" ${next ? 'enabled' : 'disabled'}.`);
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || !projectId || !selectedAppId) return;
    deleting = true;
    const res = await deleteCustomRule(projectId, selectedAppId, target.id);
    deleting = false;
    if (res.error) {
      toast.error(res.error.error ?? 'The rule could not be deleted.');
      return;
    }
    toast.success(`Rule "${target.name}" deleted.`);
    deleteTarget = null;
    await loadRules();
  }

  function handleExport() {
    if (rules.length === 0) return;
    const payload = buildRulesExport(rules, selectedApp ? { id: selectedApp.id, name: selectedApp.name } : undefined);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(selectedApp?.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}.`);
  }

  async function handleImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !selectedAppId) return;
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      toast.error('The file is larger than 5 MiB.');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      toast.error('The file could not be read.');
      return;
    }
    const parsed = parseRulesFile(text, rules.map((r) => r.name));
    if (!parsed.ok) {
      toast.error('error' in parsed ? parsed.error : 'The file could not be read.');
      return;
    }
    importRows = parsed.rows;
    importErrors = {};
    importFileName = file.name;
    importOpen = true;
  }

  async function runImport(items: ImportItem[]) {
    if (!projectId || !selectedAppId || items.length === 0) return;
    importing = true;
    const created = new Set<number>();
    const errors: Record<number, string> = {};
    const notApplied: string[] = [];
    for (const { index, body } of items) {
      const res = await createCustomRule(projectId, selectedAppId, body);
      if (res.error) errors[index] = ruleSaveError(res.error, 'error').message;
      else {
        created.add(index);
        if (ruleRegexError(res.data)) notApplied.push(body.name);
      }
    }
    importing = false;
    const failedCount = Object.keys(errors).length;
    if (created.size > 0) toast.success(`Imported ${created.size} of ${items.length} ${items.length === 1 ? 'rule' : 'rules'}.`);
    if (failedCount > 0) {
      // Keep the dialog open: the refused rows stay listed with their error,
      // the created ones leave the list so a retry cannot create them twice.
      importRows = remainingImportRows(importRows, created);
      importErrors = errors;
    } else {
      importOpen = false;
      importRows = [];
      importErrors = {};
    }
    if (notApplied.length > 0) {
      toast.warning(
        `Imported but not applied by agents (invalid or too complex regex): ${notApplied.slice(0, 3).join(', ')}${notApplied.length > 3 ? ` and ${notApplied.length - 3} more` : ''}`,
      );
    }
    await loadRules();
  }

  const columns: DataTableColumn<RuleRow>[] = [
    { key: 'priority', label: 'Priority', align: 'right', width: '5rem' },
    { key: 'name', label: 'Rule', rowHeader: true },
    { key: 'type', label: 'Type and action', nowrap: true },
    { key: 'match', label: 'Match or effect' },
    { key: 'hits', label: 'Hits (30 days)', align: 'right', nowrap: true },
    { key: 'enabled', label: 'Enabled', nowrap: true },
  ];
</script>

<div class="custom-rules-page">
  <PageHeader
    title="Custom rules"
    subtitle="Match & act, Engine tuning and Script rules for one application. Each type runs at a different point of the request; see “When custom rules run”."
    backHref="{base}/projects/{projectId}"
  >
    {#snippet actions()}
      <Button variant="secondary" onclick={loadRules} disabled={rulesLoading || !selectedAppId} aria-label="Reload rules" title="Reload rules">
        <Icon data={refresh} scale={0.8} aria-hidden="true" />
      </Button>
      <Button variant="primary" onclick={() => openEditor('create')} disabled={!canConfigure || !selectedAppId} title={canConfigure ? undefined : 'Members and owners can add rules'}>
        <Icon data={plus} scale={0.8} aria-hidden="true" />
        New rule
      </Button>
    {/snippet}
  </PageHeader>

  <RuleStagesExplainer />

  {#if appsLoading}
    <Spinner layout="block" tone="accent" label="Loading applications…" />
  {:else if appsError && apps.length === 0}
    <InlineError message={appsError} onretry={() => appsReload++} />
  {:else if apps.length === 0}
    <EmptyState
      title="No applications yet"
      message="Custom rules belong to an application. Create an application first, then add rules to it."
      level={2}
    >
      {#snippet action()}
        <Button variant="primary" href="{base}/projects/{projectId}/apps">Go to applications</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="toolbar">
      <div class="toolbar-context">
        <div class="field-inline">
          <label for="rules-app">Application</label>
          <Select
            id="rules-app"
            class="rules-app-select"
            options={apps.map((app) => ({ value: app.id, label: `${app.name}${app.upstream_url ? ` (${app.upstream_url})` : ''}` }))}
            value={selectedAppId}
            onchange={(id) => selectApp(id)}
          />
        </div>
        <p class="counters" aria-live="polite">
          <strong>{stats.total}</strong> of {MAX_RULES_PER_APP} rules · <strong>{stats.enabled}</strong> enabled ·
          {stats.gui} Match &amp; act · {stats.tuning} Engine tuning · {stats.script} Script
        </p>
      </div>

      <div class="toolbar-filters">
        <div class="filter-group" role="group" aria-label="Show rules">
          {#each TYPE_FILTERS as f (f.value)}
            <button type="button" class="filter-btn" aria-pressed={typeFilter === f.value} onclick={() => setTypeFilter(f.value)}>{f.label}</button>
          {/each}
        </div>
        <div class="field-inline">
          <label for="rules-action">Action</label>
          <Select
            id="rules-action"
            size="sm"
            options={ACTION_FILTER_OPTIONS}
            value={actionFilter}
            onchange={(action) => setQuery({ action: action === 'all' ? null : action })}
            title="Filters Match & act rules by their action"
          />
        </div>
        <div class="field-inline">
          <label for="rules-sort">Sort</label>
          <Select id="rules-sort" size="sm" options={SORT_OPTIONS} value={sortBy} onchange={(sort) => setQuery({ sort: sort === 'priority' ? null : sort })} />
        </div>
        <div class="search">
          <label for="rules-search" class="sr-only">Search rules</label>
          <input id="rules-search" type="search" class="control" placeholder="Search rules" bind:value={searchQuery} />
        </div>
        <div class="data-actions">
          <Button variant="secondary" size="sm" onclick={handleExport} disabled={rules.length === 0 || rulesLoading}>
            <Icon data={download} scale={0.75} aria-hidden="true" /> Export
          </Button>
          <Button variant="secondary" size="sm" onclick={() => importInput?.click()} disabled={!canConfigure || !selectedAppId || importing}>
            <Icon data={upload} scale={0.75} aria-hidden="true" /> Import
          </Button>
          <input type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept=".json,application/json" bind:this={importInput} onchange={handleImportFile} />
        </div>
      </div>
    </div>

    {#if continuing.length > 0 && !continueNoticeDismissed}
      <Alert tone="info" title="Log and Challenge rules no longer end inspection" ondismiss={hideContinueNotice} dismissLabel="Dismiss this notice">
        <p class="continue-text">On updated WAF agents, a matching Log or Challenge rule records the request (or challenges it) and the request then continues through the detection engines, which can still block it. Only Allow and Block rules decide the request on their own.</p>
        <p class="continue-text">Rules in {selectedApp?.name ?? 'this application'} affected:</p>
        <ul class="continue-list">
          {#each continuing as rule (rule.id)}
            <li>{rule.name} <span class="continue-meta">({ACTION_LABEL[rule.action] ?? rule.action}{rule.enabled ? '' : ', disabled'})</span></li>
          {/each}
        </ul>
      </Alert>
    {/if}

    {#if scriptWarning}
      <Alert tone="warning" title="Script rules do not run on this agent" message={scriptWarning} />
    {/if}

    {#if regexBroken.length > 0}
      <Alert
        tone="warning"
        title={`${regexBroken.length} ${regexBroken.length === 1 ? 'rule is' : 'rules are'} not applied by agents`}
        message="A regex in these rules is invalid or too complex, so WAF agents drop the rule when they load the configuration. Edit the pattern to apply the rule; the reason is shown under each rule name."
      />
    {/if}

    {#if !rulesLoading && !rulesError && rules.length === 0}
      <EmptyState
        title="No custom rules yet"
        message="Add a Match & act rule to block or allow specific requests before the detection engines, an Engine tuning rule to quiet a false positive, or a script for decisions the builder cannot express."
        level={2}
      >
        {#snippet action()}
          <Button variant="primary" onclick={() => openEditor('create')} disabled={!canConfigure}>Create the first rule</Button>
          <Button variant="secondary" onclick={() => importInput?.click()} disabled={!canConfigure}>Import from a file</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <DataTable
        rows={filteredRules}
        {columns}
        rowKey={(r) => r.id}
        caption={`Custom rules for ${selectedApp?.name ?? 'the application'}`}
        manualSort
        loading={rulesLoading}
        loadingLabel="Loading rules…"
        error={rulesError || null}
        onretry={loadRules}
        emptyTitle="No rules match"
        emptyMessage="Change the search or the filters."
        bind:expandedKeys
        expandLabel={(r) => `Details of ${r.name}`}
        expandOnRowClick={false}
        rowClass={(r) => (r.enabled ? undefined : 'row-disabled')}
      >
        {#snippet cell(rule, column)}
          {#if column.key === 'priority'}
            <span class="mono">{rule.priority}</span>
          {:else if column.key === 'name'}
            <span class="rule-name">{rule.name}</span>
            {#if rule.description}<span class="rule-desc">{rule.description}</span>{/if}
            {#if ruleRegexError(rule)}
              <span class="regex-error">
                <Badge tone="warning">Not applied</Badge>
                <span class="regex-error-text">{regexNotAppliedMessage(rule)}</span>
              </span>
            {/if}
          {:else if column.key === 'type'}
            <span class="type-cell">
              <Badge tone={categoryTone(rule.mode, MODE_VOCAB)}>{RULE_STAGES[rule.mode]?.label ?? rule.mode}</Badge>
              {#if rule.mode === 'gui'}
                <Badge tone={actionTone(rule.action)}>{ACTION_LABEL[rule.action] ?? rule.action}</Badge>
              {:else if rule.mode === 'script'}
                <span class="muted">Script decides</span>
              {/if}
            </span>
          {:else if column.key === 'match'}
            {#if rule.mode === 'tuning'}
              <span class="summary mono" title={tuningEffectSummary(rule)}>
                {#if rule.tuning && tuningScopeMatchesEverything(rule.tuning)}<span class="logic">EVERY REQUEST</span>{/if}
                {tuningEffectSummary(rule)}
              </span>
            {:else if rule.mode === 'script'}
              <code class="summary">{scriptPreview(rule.script)}</code>
            {:else if rule.conditions?.length}
              <span class="summary" title={rule.conditions.map(conditionText).join(rule.condition_logic === 'or' ? ' OR ' : ' AND ')}>
                <span class="logic">{rule.condition_logic === 'or' ? 'ANY' : 'ALL'}</span>
                {conditionText(rule.conditions[0])}{rule.conditions.length > 1 ? ` +${rule.conditions.length - 1} more` : ''}
              </span>
            {:else}
              <span class="muted">No conditions: never matches</span>
            {/if}
          {:else if column.key === 'hits'}
            {#if rule.hit_count}
              <span class="hits" title={rule.last_hit_at ? `Last hit ${formatDateTime(rule.last_hit_at, { seconds: true })}` : undefined}>
                {formatNumber(rule.hit_count)}
                {#if rule.last_hit_at}<span class="muted">last {formatRelative(rule.last_hit_at)}</span>{/if}
              </span>
            {:else}
              <span class="muted">0</span>
            {/if}
          {:else if column.key === 'enabled'}
            <button
              type="button"
              class="switch"
              role="switch"
              aria-checked={rule.enabled}
              aria-label={`Enabled: ${rule.name}`}
              disabled={!canConfigure || togglingId !== null || (rule.mode === 'script' && !canEditScripts)}
              title={rule.mode === 'script' && canConfigure && !canEditScripts ? SCRIPT_OWNER_MESSAGE : undefined}
              onclick={() => toggleEnabled(rule)}
            >
              <span class="switch-track" aria-hidden="true"></span>
              <span class="switch-text">{togglingId === rule.id ? 'Saving…' : rule.enabled ? 'On' : 'Off'}</span>
            </button>
          {/if}
        {/snippet}

        {#snippet actions(rule)}
          <Button variant="ghost" size="sm" disabled={!canConfigure} aria-label={`Edit ${rule.name}`} title="Edit" onclick={() => openEditor('edit', rule)}>
            <Icon data={pencil} scale={0.8} aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" disabled={!canConfigure} aria-label={`Copy ${rule.name}`} title="Copy (opens the editor; the copy starts disabled)" onclick={() => openEditor('clone', rule)}>
            <Icon data={copy} scale={0.8} aria-hidden="true" />
          </Button>
        {/snippet}

        {#snippet expanded(rule)}
          <div class="detail">
            <dl class="detail-grid">
              <div><dt>Type</dt><dd>{RULE_STAGES[rule.mode]?.label ?? rule.mode}: {RULE_STAGES[rule.mode]?.when}</dd></div>
              <div><dt>Created</dt><dd><DateTime value={rule.created_at} /></dd></div>
              <div><dt>Updated</dt><dd><DateTime value={rule.updated_at} relative /></dd></div>
            </dl>
            {#if rule.mode === 'gui'}
              <p class="detail-label">{rule.condition_logic === 'or' ? 'Matches when any condition is true' : 'Matches when every condition is true'}</p>
              <ol class="detail-list">
                {#each rule.conditions ?? [] as c, i (i)}
                  <li><code>{conditionText(c)}</code></li>
                {/each}
              </ol>
            {:else if rule.mode === 'tuning'}
              {#if rule.tuning?.scope?.conditions?.length}
                <p class="detail-label">Applies when {rule.tuning.scope.logic === 'or' ? 'any' : 'every'} condition is true</p>
                <ol class="detail-list">
                  {#each rule.tuning.scope.conditions as c, i (i)}
                    <li><code>{conditionText(c)}</code></li>
                  {/each}
                </ol>
              {:else}
                <p class="detail-label">Applies to every request</p>
                <p class="detail-text">This rule has no "Apply when" conditions, so its effect covers the whole application.</p>
              {/if}
              <p class="detail-label">Effect</p>
              <p class="mono detail-text">{tuningEffectSummary(rule)}</p>
            {:else}
              <p class="detail-label">{rule.name}.din (uddin-lang)</p>
              <UddinCodeViewer code={rule.script || ''} maxHeight="260px" />
            {/if}
            {#if canConfigure}
              <div class="detail-actions">
                <Button variant="secondary" size="sm" onclick={() => openEditor('edit', rule)}>
                  <Icon data={pencil} scale={0.75} aria-hidden="true" /> Edit
                </Button>
                <Button variant="secondary" size="sm" onclick={() => openEditor('clone', rule)}>
                  <Icon data={copy} scale={0.75} aria-hidden="true" /> Copy
                </Button>
                <Button variant="outline" size="sm" class="detail-delete" onclick={() => (deleteTarget = rule)} aria-label={`Delete ${rule.name}`}>
                  <Icon data={trash} scale={0.75} aria-hidden="true" /> Delete rule
                </Button>
              </div>
            {/if}
          </div>
        {/snippet}
      </DataTable>
    {/if}
  {/if}
</div>

<CustomRuleModal
  open={modalOpen}
  {projectId}
  appId={selectedAppId}
  editingRule={modalRule}
  mode={modalMode}
  {canEditScripts}
  scriptRules={appAgent?.script_rules}
  onSave={handleSaveRule}
  onClose={() => {
    modalOpen = false;
    modalRule = null;
  }}
/>

<RuleImportDialog
  open={importOpen}
  rows={importRows}
  fileName={importFileName}
  appName={selectedApp?.name}
  existingCount={rules.length}
  {importing}
  {canEditScripts}
  rowErrors={importErrors}
  onimport={runImport}
  onclose={() => {
    if (importing) return;
    importOpen = false;
    importRows = [];
    importErrors = {};
  }}
/>

<ConfirmModal
  open={deleteTarget !== null}
  title="Delete custom rule"
  message={`Delete "${deleteTarget?.name ?? ''}"? It stops running on the next configuration push. Export the rules first if you may need it again.`}
  confirmLabel="Delete rule"
  loading={deleting}
  onconfirm={confirmDelete}
  onclose={() => (deleteTarget = null)}
/>

<ConfirmModal
  open={pendingConfirm !== null}
  tone="warning"
  title={pendingConfirm?.risk.title ?? ''}
  message={pendingConfirm?.risk.message ?? ''}
  confirmLabel={pendingConfirm?.risk.confirmLabel ?? 'Confirm'}
  onconfirm={() => settleConfirm(true)}
  onclose={() => settleConfirm(false)}
/>

<style>
  .custom-rules-page {
    padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .custom-rules-page :global(.page-header) { margin-bottom: 0; }

  .toolbar { display: flex; flex-direction: column; gap: var(--sp-3); }
  .toolbar-context,
  .toolbar-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); }
  .toolbar-filters { padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border); }
  .field-inline { display: inline-flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .field-inline label { font-size: var(--fs-sm); color: var(--text-secondary); white-space: nowrap; }
  .control {
    height: 34px;
    min-width: 0;
    max-width: 100%;
    padding: 0 var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .field-inline :global(.rules-app-select) { max-width: min(420px, 70vw); }
  .counters { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .counters strong { color: var(--text-primary); font-weight: var(--fw-semibold); }

  .filter-group { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; background: var(--surface-input); border: 1px solid var(--border-strong); border-radius: var(--radius); }
  .filter-btn {
    padding: var(--sp-1) var(--sp-2);
    background: none;
    border: 0;
    border-radius: calc(var(--radius) - 1px);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .filter-btn:hover { color: var(--text-primary); }
  .filter-btn[aria-pressed='true'] { background: var(--accent-soft); color: var(--text-primary); font-weight: var(--fw-semibold); box-shadow: inset 0 0 0 1px var(--accent); }
  /* Fills the rest of its row, so a wrapped toolbar still ends at the content edge. */
  .search { flex: 1 1 200px; min-width: 160px; }
  .search .control { width: 100%; box-sizing: border-box; }
  .data-actions { display: inline-flex; gap: var(--sp-2); margin-left: auto; }

  .mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
  .rule-name { display: block; font-weight: var(--fw-medium); color: var(--text-primary); overflow-wrap: anywhere; }
  .regex-error { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); margin-top: var(--sp-1); }
  .regex-error-text { font-size: var(--fs-xs); color: var(--text-secondary); overflow-wrap: anywhere; }
  .rule-desc { display: block; font-size: var(--fs-xs); font-weight: normal; color: var(--text-muted); overflow-wrap: anywhere; }
  .type-cell { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
  .muted { font-size: var(--fs-xs); color: var(--text-muted); }
  .summary {
    display: block;
    max-width: 44ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    color: var(--text-secondary);
  }
  code.summary { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .logic { margin-right: var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--text-muted); }
  .hits { display: inline-flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }

  .switch { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 44px; padding: 0; background: none; border: 0; color: var(--text-secondary); font-size: var(--fs-sm); cursor: pointer; }
  .switch:disabled { cursor: not-allowed; opacity: 0.6; }
  .switch-track { position: relative; width: 32px; height: 18px; flex-shrink: 0; border-radius: var(--radius); background: var(--bg-tertiary); border: 1px solid var(--border-strong); transition: background 0.15s; }
  .switch-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: calc(var(--radius) - 2px); background: var(--text-secondary); transition: transform 0.15s; }
  .switch[aria-checked='true'] .switch-track { background: var(--accent); border-color: var(--accent); }
  .switch[aria-checked='true'] .switch-track::after { transform: translateX(14px); background: var(--text-on-accent); }
  .switch-text { min-width: 3.5em; text-align: left; }

  :global(.row-disabled) :global(td),
  :global(.row-disabled) :global(th) { color: var(--text-muted); }

  .detail { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) 0; min-width: 0; }
  .detail-grid { margin: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); }
  .detail-grid dt { font-size: var(--fs-xs); color: var(--text-muted); }
  .detail-grid dd { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .detail-label { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  .detail-list { margin: 0; padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); }
  .detail-list code, .detail-text { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-primary); overflow-wrap: anywhere; }
  .detail-text { margin: 0; }
  .detail-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--border); }
  .detail-actions :global(.detail-delete) { margin-left: auto; }
  .detail-actions :global(.detail-delete:hover:not(:disabled)) { color: var(--danger); border-color: var(--danger); }

  @media (max-width: 760px) {
    .data-actions { margin-left: 0; }
    .summary { max-width: 28ch; }
  }
  .continue-text { margin: 0 0 var(--sp-1); }
  .continue-list { margin: 0; padding-left: var(--sp-5); }
  .continue-meta { color: var(--text-muted); }
</style>
