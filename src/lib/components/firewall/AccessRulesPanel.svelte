<!--
  AccessRulesPanel: the Firewall "Access rules" tab: blocklist,
  allowlist, egress blocklist, geo-blocking and port rules in one table with a
  type filter and search. Removal is a simple confirmation; removing
  the last management ALLOW rule under ingress Deny all is refused because it
  would lock the host out.
-->
<script lang="ts">
  import './controls.css';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import plus from 'svelte-awesome/icons/plus';
  import refresh from 'svelte-awesome/icons/refresh';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import type { EBPFPortPolicy, EBPFPortPolicyConfig } from '#lib/api.js';
  import { actionTone, allowlistBadgeTone, categoryTone } from '#lib/tone.js';
  import { formatDateTime, formatNumber, toISO } from '#lib/format.js';
  import {
    ACCESS_RULE_TYPES,
    accessRuleType,
    allowPortsLabel,
    countByType,
    filterAccessRules,
    removalLocksOut,
    timeLeft,
    type AccessRule,
    type AccessRuleFilter,
    type AccessRuleType,
    type ListWindow,
  } from './rules';
  import { GEO_ALLOW_CONSEQUENCES } from './geo-policy';

  let {
    rules,
    windows = {},
    loading = false,
    error = null,
    filter = $bindable<AccessRuleFilter>('all'),
    onfilterchange = undefined,
    canConfigure = false,
    portPolicy = null,
    portRules = [],
    geoEnabled = true,
    sshPorts = null,
    onadd,
    onremove,
    onrefresh,
    onloadall = undefined,
    loadAllLimit = 20_000,
    onopensettings,
  }: {
    rules: readonly AccessRule[];
    /** Per list: how many of the host's entries were loaded (lists are capped). */
    windows?: Partial<Record<AccessRuleType, ListWindow>>;
    loading?: boolean;
    error?: string | null;
    filter?: AccessRuleFilter;
    onfilterchange?: (filter: AccessRuleFilter) => void;
    canConfigure?: boolean;
    portPolicy?: EBPFPortPolicyConfig | null;
    portRules?: readonly EBPFPortPolicy[];
    geoEnabled?: boolean;
    /** sshd ports the host agent reported (host_info.ssh_ports); empty = 22. */
    sshPorts?: readonly number[] | null;
    /** Opens the add drawer with a type preselected. */
    onadd: (type: AccessRuleType) => void;
    /** Removes a rule; resolves to an error message or null. */
    onremove: (rule: AccessRule) => Promise<string | null>;
    onrefresh: () => void;
    /** Loads every entry of the capped lists (up to `loadAllLimit` each). */
    onloadall?: () => void;
    loadAllLimit?: number;
    onopensettings: () => void;
  } = $props();

  const uid = $props.id();
  let query = $state('');
  const TYPE_ORDER = ACCESS_RULE_TYPES.map((type) => type.id);
  const counts = $derived(countByType(rules));
  const visible = $derived(filterAccessRules(rules, { type: filter, query }));
  const truncated = $derived(
    Object.entries(windows)
      .filter(([, win]) => win && win.total > win.loaded)
      .map(([type, win]) => ({ type: type as AccessRuleType, ...win! })),
  );

  const DIRECTION_TEXT = { ingress: 'Inbound', egress: 'Outbound', both: 'Both' } as const;
  const ACTION_TEXT = { drop: 'Drop', allow: 'Allow', log: 'Log' } as const;

  const columns: DataTableColumn<AccessRule>[] = [
    { key: 'type', label: 'Type', sortable: true, value: (row) => accessRuleType(row.type).label, nowrap: true },
    { key: 'target', label: 'Rule', sortable: true, rowHeader: true, value: (row) => row.label },
    { key: 'action', label: 'Action', sortable: true, nowrap: true },
    { key: 'direction', label: 'Direction', sortable: true, value: (row) => DIRECTION_TEXT[row.direction], nowrap: true },
    { key: 'expires', label: 'Expires', sortable: true, sortValue: (row) => (row.expiresAt ? Date.parse(row.expiresAt) : Number.MAX_SAFE_INTEGER), nowrap: true },
    { key: 'hits', label: 'Hits', sortable: true, align: 'right', firstSortDir: 'desc', sortValue: (row) => row.hits ?? -1, nowrap: true },
    { key: 'added', label: 'Added', sortable: true, firstSortDir: 'desc', sortValue: (row) => (row.addedAt ? Date.parse(row.addedAt) : 0), nowrap: true },
  ];

  function setFilter(next: AccessRuleFilter) {
    filter = next;
    onfilterchange?.(next);
  }

  // ── Removal ───────────────────────────────────────────────────────────
  let pending = $state<AccessRule | null>(null);
  let removing = $state(false);
  let removeError = $state<string | null>(null);
  const pendingLocksOut = $derived(
    pending?.type === 'port' && pending.port ? removalLocksOut(pending.port, portRules, portPolicy, sshPorts) : false,
  );

  const REMOVE_TEXT: Record<AccessRuleType, (rule: AccessRule) => { title: string; message: string }> = {
    block: (rule) => ({ title: 'Remove blocked address?', message: `Traffic from ${rule.label} is no longer dropped.` }),
    allow: (rule) => ({ title: 'Remove allowed address?', message: `${rule.label} no longer bypasses the firewall; every inbound check applies to it again.` }),
    egress: (rule) => ({ title: 'Remove blocked destination?', message: `Outbound traffic to ${rule.label} is no longer dropped.` }),
    geo: (rule) => rule.action === 'allow'
      ? { title: 'Remove allowed country?', message: `Allow mode is on: new inbound connections from ${rule.label} (${rule.target}) are dropped once it leaves the allowed countries.` }
      : { title: 'Unblock country?', message: `Traffic from ${rule.label} (${rule.target}) is no longer dropped.` },
    port: (rule) => ({ title: 'Remove port rule?', message: `The ${DIRECTION_TEXT[rule.direction].toLowerCase()} ${ACTION_TEXT[rule.action].toUpperCase()} rule for ${rule.label} is removed; the port falls back to the default policy.` }),
  };
  const pendingText = $derived(pending ? REMOVE_TEXT[pending.type](pending) : { title: '', message: '' });

  function askRemove(rule: AccessRule) {
    removeError = null;
    pending = rule;
  }

  async function confirmRemove() {
    if (!pending || removing || pendingLocksOut) return;
    removing = true;
    removeError = await onremove(pending);
    removing = false;
    if (!removeError) pending = null;
  }
</script>

<div class="rules">
  <div class="rules-bar">
    <fieldset class="rules-filter">
      <legend class="sr-only">Show rule type</legend>
      <div class="fw-segmented">
        <label><input type="radio" name={`${uid}-filter`} value="all" checked={filter === 'all'} onchange={() => setFilter('all')} />All <span class="fw-count">{rules.length}</span></label>
        {#each ACCESS_RULE_TYPES as type (type.id)}
          <label><input type="radio" name={`${uid}-filter`} value={type.id} checked={filter === type.id} onchange={() => setFilter(type.id)} />{type.label} <span class="fw-count">{counts[type.id]}</span></label>
        {/each}
      </div>
    </fieldset>
    <div class="rules-actions">
      <label class="sr-only" for={`${uid}-search`}>Search rules</label>
      <input id={`${uid}-search`} class="fw-input rules-search" type="search" bind:value={query} placeholder="Search address, country or port" autocomplete="off" />
      <Button variant="ghost" size="sm" onclick={onrefresh} disabled={loading} aria-label="Reload access rules"><Icon data={refresh} scale={0.8} /> Reload</Button>
      <Button variant="primary" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : 'Your role can view rules but not change them'} onclick={() => onadd(filter === 'all' ? 'block' : filter)}>
        <Icon data={plus} scale={0.8} /> Add rules
      </Button>
    </div>
  </div>

  {#if filter !== 'all'}
    <p class="rules-desc">{accessRuleType(filter).description}</p>
  {/if}

  {#if (filter === 'all' || filter === 'port') && portPolicy}
    <p class="rules-policy">
      Port rules are <strong>{portPolicy.enabled ? 'on' : 'off'}</strong>
      · ingress default <strong>{portPolicy.default_ingress === 'deny' ? 'Deny all' : 'Allow all'}</strong>
      · egress default <strong>{portPolicy.default_egress === 'deny' ? 'Deny all' : 'Allow all'}</strong>.
      <button type="button" class="rules-link" onclick={onopensettings}>Change in settings</button>
    </p>
  {/if}
  {#if (filter === 'all' || filter === 'geo') && !geoEnabled && counts.geo > 0}
    <Alert tone="warning" compact message="Geo-blocking is turned off in Settings; the countries below are stored but not blocked." />
  {/if}
  {#each truncated as win (win.type)}
    <Alert tone="info" compact message={`Showing the first ${formatNumber(win.loaded)} of ${formatNumber(win.total)} ${accessRuleType(win.type).label.toLowerCase()} entries; search and counts cover the loaded entries only.`}>
      {#snippet actions()}
        {#if onloadall && win.loaded < loadAllLimit}
          <Button variant="secondary" size="sm" disabled={loading} onclick={onloadall}>Load {win.total > loadAllLimit ? `up to ${formatNumber(loadAllLimit)}` : 'all'} entries</Button>
        {/if}
      {/snippet}
    </Alert>
  {/each}

  <DataTable
    rows={visible}
    {columns}
    rowKey={(row) => row.key}
    caption="Access rules"
    itemLabel="rules"
    pageSize={25}
    {loading}
    {error}
    onretry={onrefresh}
    emptyTitle={query ? 'No rule matches your search' : filter === 'all' ? 'No access rules on this host' : `No ${accessRuleType(filter).label.toLowerCase()} entries`}
    emptyMessage={query ? 'Clear the search or choose another type.' : 'Use Add rules to block or allow addresses, countries or ports.'}
    actionsLabel="Remove"
  >
    {#snippet cell(row, column)}
      {#if column.key === 'type'}
        <Badge tone={categoryTone(row.type, TYPE_ORDER)}>{accessRuleType(row.type).label}</Badge>
      {:else if column.key === 'target'}
        <span class="rule-target">
          {#if row.type === 'geo'}{row.label} <code class="fw-mono">{row.target}</code>
          {:else}<code class="fw-mono">{row.label}</code>{/if}
          {#if row.subnet}<span class="rule-lpm" title="Matched by the kernel LPM trie">subnet</span>{/if}
          {#if row.type === 'allow'}
            <Badge tone={allowlistBadgeTone('ports')} title={row.ports?.length ? 'Bypasses inbound checks only on these ports; other ports and ICMP meet the normal checks' : 'Bypasses inbound checks on every port, ICMP included'}>{allowPortsLabel(row.ports)}</Badge>
            {#if row.lockoutEscape}<Badge tone={allowlistBadgeTone('lockout-escape')} title="Permanent, on all ports or covering the SSH port over TCP: keeps management access through a 0.0.0.0/0 or ::/0 block">Lockout escape</Badge>{/if}
          {/if}
        </span>
      {:else if column.key === 'action'}
        <Badge tone={actionTone(row.action)}>{ACTION_TEXT[row.action]}</Badge>
      {:else if column.key === 'direction'}
        {DIRECTION_TEXT[row.direction]}{#if row.proto}<span class="fw-muted">&nbsp;· {row.proto.toUpperCase()}</span>{/if}
      {:else if column.key === 'expires'}
        {#if row.permanent}<span class="fw-muted">Permanent</span>{:else}<time datetime={toISO(row.expiresAt)} title={formatDateTime(row.expiresAt, { seconds: true })}>{timeLeft(row.expiresAt)}</time>{/if}
      {:else if column.key === 'hits'}
        {row.hits === null ? 'n/a' : formatNumber(row.hits)}
      {:else if column.key === 'added'}
        <DateTime value={row.addedAt} />
      {/if}
    {/snippet}
    {#snippet actions(row)}
      <Button variant="ghost" size="sm" disabled={!canConfigure} aria-label={`Remove ${row.type === 'geo' && row.action === 'allow' ? 'allowed country' : accessRuleType(row.type).noun.toLowerCase()} ${row.label}`} onclick={() => askRemove(row)}>Remove</Button>
    {/snippet}
  </DataTable>
</div>

<ConfirmModal
  open={pending !== null}
  title={pendingText.title}
  confirmLabel="Remove"
  tone="danger"
  loading={removing}
  confirmDisabled={pendingLocksOut}
  onconfirm={confirmRemove}
  onclose={() => { if (!removing) pending = null; }}
>
  <div class="remove-body">
    <p>{pendingText.message}</p>
    {#if pending?.type === 'geo' && pending.action === 'allow'}
      <ul class="remove-list">
        {#each GEO_ALLOW_CONSEQUENCES as line (line)}<li>{line}</li>{/each}
      </ul>
    {/if}
    {#if pendingLocksOut}
      <Alert tone="error" title="This would lock the host out" message="This rule keeps the SSH port open over TCP while ingress Deny all is on; without it SSH to this host would be dropped and the control plane refuses the change (SSH_ALLOW_REQUIRED). Add another permanent TCP ALLOW for the SSH port first, or set the ingress default to Allow all in Settings." />
    {/if}
    {#if removeError}<Alert tone="error" compact title="Not removed" message={removeError} />{/if}
  </div>
</ConfirmModal>

<style>
  .rules { display: grid; gap: var(--sp-3); min-width: 0; }
  .rules-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .rules-filter { border: 0; margin: 0; padding: 0; min-width: 0; }
  .rules-actions { display: flex; flex-wrap: nowrap; align-items: center; justify-content: flex-end; gap: var(--sp-2); margin-left: auto; min-width: 0; }
  .rules-actions :global(.btn) { min-height: 36px; }
  .rules-search { flex: 1 1 140px; min-width: 96px; max-width: 260px; }
  .rules-desc, .rules-policy { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .rules-policy strong { color: var(--text-primary); font-weight: var(--fw-medium); }
  .rules-link { padding: 0; border: 0; background: none; color: var(--accent); font-size: var(--fs-xs); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .rule-target { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .rule-lpm { padding: 0 var(--sp-1); border: 1px solid var(--border); border-radius: var(--radius); font-size: var(--fs-xs); color: var(--text-muted); }
  .remove-body { display: grid; gap: var(--sp-3); }
  .remove-list { margin: 0; padding-left: var(--sp-5); font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .remove-body p { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
</style>
