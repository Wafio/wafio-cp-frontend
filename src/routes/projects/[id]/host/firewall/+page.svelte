<!--
  Firewall: kernel packet filtering (XDP/TC) for one host.

  Four URL tabs (?tab=overview|rules|live|settings). Every per-host field lives
  behind a HostScope: changing ?host resets all of it, and a response that
  arrives after the change is dropped (scope epoch), so host A's settings can
  never be saved onto host B. Streams and pollers stop with the page, pause
  while the browser tab is hidden, and never start after the page is gone.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { beforeNavigate, goto } from '$app/navigation';
  import { base } from '#lib/paths.js';
  import { untrack } from 'svelte';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import type { TabItem } from '#lib/components/ui/types.js';
  import { parseTimeRange, timeRangeLabel, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import HostPicker from '#lib/components/HostPicker.svelte';
  import HostSwitcher from '#lib/components/HostSwitcher.svelte';
  import FirewallStatusBanner from '#lib/components/firewall/FirewallStatusBanner.svelte';
  import FirewallOverview from '#lib/components/firewall/FirewallOverview.svelte';
  import AccessRulesPanel from '#lib/components/firewall/AccessRulesPanel.svelte';
  import JailedIPs from '#lib/components/firewall/JailedIPs.svelte';
  import LivePanel from '#lib/components/firewall/LivePanel.svelte';
  import FirewallSettings from '#lib/components/firewall/FirewallSettings.svelte';
  import AddRulesDrawer from '#lib/components/firewall/AddRulesDrawer.svelte';
  import GuardedConfirm from '#lib/components/firewall/GuardedConfirm.svelte';
  import ApplyToHostsFlow from '#lib/components/hosts/ApplyToHostsFlow.svelte';
  import GeoPolicyPanel from '#lib/components/firewall/GeoPolicyPanel.svelte';
  import { GEO_ALLOW_CONSEQUENCES, allowListAfter, geoAllowNeedsAck, geoDegradedStateText, geoPolicyView, type GeoMode, type GeoPolicyView } from '#lib/components/firewall/geo-policy.js';
  import { firewallErrorMessage, firewallWarningText, firewallWarningsOf, mergeWarnings, type FirewallWarning } from '#lib/components/firewall/guard-codes.js';
  import {
    getHost,
    getEBPFStatus,
    getEBPFMetrics,
    getEBPFConfig,
    updateEBPFConfig,
    getEBPFBlocklist,
    addEBPFBlocklist,
    deleteEBPFBlocklist,
    getEBPFAllowlist,
    addEBPFAllowlist,
    deleteEBPFAllowlist,
    getEBPFEgressBlocklist,
    addEBPFEgressBlocklist,
    deleteEBPFEgressBlocklist,
    getEBPFGeoBlocked,
    updateEBPFGeoBlocked,
    updateEBPFGeoPolicy,
    getEBPFPortPolicies,
    addEBPFPortPolicy,
    deleteEBPFPortPolicy,
    updateEBPFPortPolicyConfig,
    getEBPFConnections,
    getEBPFEvents,
    getEBPFBandwidth,
    getFirewallAnalytics,
    getFirewallDropsSummary,
    getFirewallTopIPs,
    type ApiError,
    type EBPFBandwidthEntry,
    type EBPFConnection,
    type EBPFEvent,
    type EBPFFullConfig,
    type EBPFGeoPolicyUpdate,
    type EBPFAllowlistEntry,
    type EBPFIPListEntry,
    type EBPFMetrics,
    type EBPFPortPolicy,
    type EBPFPortPolicyConfig,
    type EBPFStatus,
    type FirewallAnalytics,
    type FirewallDropsSummary,
    type FirewallTopIPRow,
    type Host,
  } from '#lib/api.js';
  import { createSSEConnection, type SSEConnectionState } from '#lib/sse.js';
  import { createHostScope } from '#lib/host-scope.svelte.js';
  import { writeLastHost } from '#lib/host-nav.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { createDirtyTracker, UNSAVED_CHANGES_MESSAGE } from '#lib/dirty.svelte.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import type { ConfirmTier } from '#lib/confirm-tiers.js';
  import { toast } from '#lib/stores/toast.js';
  import { usePageTitle } from '#lib/page-meta.svelte.js';
  import {
    buildAccessRules,
    describeAdd,
    portRuleLabel,
    type AccessRule,
    type AccessRuleAdd,
    type AccessRuleFilter,
    type AccessRuleType,
    type ListWindow,
  } from '#lib/components/firewall/rules.js';
  import {
    describeChange,
    firewallChanges,
    firewallChangeTier,
    firewallState,
    lockoutChecks,
    type CheckFix,
    type FirewallState,
    type LockoutCheck,
    type LockoutContext,
  } from '#lib/components/firewall/lockout.js';
  import {
    changedParts,
    countChanges,
    draftState,
    normalizeConfig,
    normalizePortPolicy,
    saveOrder,
    validateSettings,
    type SettingsDraft,
  } from '#lib/components/firewall/settings.js';
  import { FIREWALL_TABS, firewallSearch, readFirewallUrl, type FirewallTab, type LiveView } from '#lib/components/firewall/tabs.js';

  const project = getProjectContext();
  const scope = createHostScope();

  // ── URL state ────────────────────────────────────────────────────────
  const projectId = $derived(page.params.id ?? '');
  const hostId = $derived(page.url.searchParams.get('host') ?? '');
  const urlState = $derived(readFirewallUrl(page.url.searchParams));
  const tab = $derived(urlState.tab);
  const ruleFilter = $derived(urlState.type);
  const liveView = $derived(urlState.view);
  // The shared range set (5m/1h/24h/7d/30d/All); firewall history defaults to 24h.
  const range = $derived(parseTimeRange(page.url.searchParams.get('range'), { includeAll: true, fallback: '24h' }));
  const canConfigure = $derived(project.canConfigure);

  function replaceSearch(search: string) {
    void goto(`${page.url.pathname}${search}`, { replace: true, reset: false });
  }
  function selectTab(next: FirewallTab) {
    replaceSearch(firewallSearch(page.url.searchParams, { tab: next }));
  }
  function setRuleFilter(next: AccessRuleFilter) {
    replaceSearch(firewallSearch(page.url.searchParams, { type: next }));
  }
  function setLiveView(next: LiveView) {
    replaceSearch(firewallSearch(page.url.searchParams, { view: next }));
  }
  function setRange(next: TimeRangeKey) {
    const params = new URLSearchParams(page.url.search);
    if (next === '24h') params.delete('range');
    else params.set('range', next);
    const text = params.toString();
    replaceSearch(text ? `?${text}` : '');
  }

  // ── Per-host state (cleared by resetHostState on every host change) ──
  let host = $state<Host | null>(null);
  let hostError = $state<ApiError | null>(null);
  let initializing = $state(false);
  let status = $state<EBPFStatus | null>(null);
  let statusError = $state<string | null>(null);
  let metrics = $state<EBPFMetrics | null>(null);
  let metricsHistory = $state<EBPFMetrics[]>([]);
  let serverConfig = $state<EBPFFullConfig | null>(null);
  let configLoaded = $state(false);
  /** A failed config or port-policy read: an error with Retry, never "not reported yet". */
  let configError = $state<string | null>(null);
  let portPolicyError = $state<string | null>(null);
  let serverPortPolicy = $state<EBPFPortPolicyConfig | null>(null);
  let portRules = $state<EBPFPortPolicy[]>([]);
  let blocklist = $state<EBPFIPListEntry[]>([]);
  let allowlist = $state<EBPFAllowlistEntry[]>([]);
  /** The allowlist answer said the host enforces port-scoped entries (allowlist_ports_supported). */
  let allowlistPortsReported = $state(false);
  let egressList = $state<EBPFIPListEntry[]>([]);
  /** Warnings of the last accepted firewall save (SSH_PORT_ASSUMED, EGRESS_*). */
  let saveWarnings = $state<FirewallWarning[]>([]);
  /** sshd ports the host agent reported; empty = 22 assumed by the guard. */
  const sshPorts = $derived.by(() => {
    const raw = (host?.host_info as { ssh_ports?: unknown } | null | undefined)?.ssh_ports;
    return Array.isArray(raw) ? raw.filter((p): p is number => typeof p === 'number') : [];
  });
  /** Port-scoped allowlist entries are enforced: the allowlist answer, or `allowlist_ports` in host_info.firewall_features. */
  const allowlistPortsSupported = $derived.by(() => {
    if (allowlistPortsReported) return true;
    const raw = (host?.host_info as { firewall_features?: unknown } | null | undefined)?.firewall_features;
    return Array.isArray(raw) && raw.includes('allowlist_ports');
  });
  let geo = $state<{ code: string; blocked: boolean }[]>([]);
  /** Geo policy mode and allowed countries (allow mode). */
  let geoPolicy = $state<GeoPolicyView>(geoPolicyView(null));
  let geoBusy = $state(false);
  let geoError = $state<string | null>(null);
  /** Geo change waiting for the allow-mode confirmation. */
  let geoPending: EBPFGeoPolicyUpdate | null = null;
  let windows = $state<Partial<Record<AccessRuleType, ListWindow>>>({});
  let rulesLoaded = $state(false);
  let rulesLoading = $state(false);
  let rulesError = $state<string | null>(null);
  /** Entries per IP list to load; raised by "Load all" (reset per host). */
  let listWant = $state(1000);
  let analytics = $state<FirewallAnalytics | null>(null);
  let analyticsLoading = $state(false);
  let analyticsError = $state<string | null>(null);
  let rangeNotice = $state<string | null>(null);
  let dropsSummary = $state<FirewallDropsSummary | null>(null);
  let topIPs = $state<FirewallTopIPRow[]>([]);
  let topIPsLoading = $state(false);
  let topIPsError = $state<string | null>(null);
  let dropsError = $state<string | null>(null);
  let overviewRange: TimeRangeKey | null = null; // range the overview figures belong to
  let events = $state<EBPFEvent[]>([]);
  let connections = $state<EBPFConnection[]>([]);
  let bandwidth = $state<EBPFBandwidthEntry[]>([]);
  let liveLoading = $state<Record<LiveView, boolean>>({ events: false, connections: false, bandwidth: false });
  let liveErrors = $state<Record<LiveView, string | null>>({ events: null, connections: null, bandwidth: null });
  let live = $state(true);
  let sseState = $state<SSEConnectionState>('closed');
  let streamError = $state<string | null>(null);

  // Settings draft: the configuration and the port-rule defaults, saved together.
  let draft = $state<SettingsDraft | null>(null);
  const settingsDirty = createDirtyTracker(() => draft);
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // Add drawer and the guarded confirmation.
  let addOpen = $state(false);
  /** The last rule added on this host, offered for "Apply to other hosts…" (geo stays per host). */
  let lastAdd = $state<AccessRuleAdd | null>(null);
  let applyOpen = $state(false);
  let addType = $state<AccessRuleType>('block');
  let addText = $state('');
  type GuardKind = 'settings' | 'enforce' | 'geo';
  let guard = $state<{ kind: GuardKind; title: string; changes: string[]; checks: LockoutCheck[]; tier: ConfirmTier; confirmLabel: string; tone: 'danger' | 'warning' } | null>(null);
  let guardBusy = $state(false);
  let guardError = $state<string | null>(null);
  let enforceBusy = $state(false);

  function resetHostState() {
    lastAdd = null;
    applyOpen = false;
    host = null;
    hostError = null;
    initializing = false;
    status = null;
    statusError = null;
    metrics = null;
    metricsHistory = [];
    serverConfig = null;
    configLoaded = false;
    configError = null;
    portPolicyError = null;
    serverPortPolicy = null;
    portRules = [];
    blocklist = [];
    allowlist = [];
    allowlistPortsReported = false;
    egressList = [];
    geo = [];
    geoPolicy = geoPolicyView(null);
    geoBusy = false;
    geoError = null;
    geoPending = null;
    windows = {};
    rulesLoaded = false;
    rulesLoading = false;
    rulesError = null;
    listWant = LIST_PAGE;
    analytics = null;
    analyticsLoading = false;
    analyticsError = null;
    rangeNotice = null;
    dropsSummary = null;
    topIPs = [];
    topIPsLoading = false;
    topIPsError = null;
    dropsError = null;
    overviewRange = null;
    events = [];
    connections = [];
    bandwidth = [];
    liveLoading = { events: false, connections: false, bandwidth: false };
    liveErrors = { events: null, connections: null, bandwidth: null };
    sseState = 'closed';
    streamError = null;
    draft = null;
    settingsDirty.reset();
    saving = false;
    saveError = null;
    addOpen = false;
    guard = null;
    guardBusy = false;
    guardError = null;
    enforceBusy = false;
  }
  scope.onReset(resetHostState);

  $effect(() => {
    const p = projectId;
    const h = hostId;
    untrack(() => {
      if (scope.setScope(p, h) && h) void initHost();
    });
  });

  // ── Loaders: capture the epoch before the await, drop stale answers ──
  const ids = () => [scope.projectId, scope.agentId, scope.hostId] as const;

  function isValidMetrics(value: unknown): value is EBPFMetrics {
    return value !== null && typeof value === 'object' && typeof (value as EBPFMetrics).pps === 'number';
  }

  function pushMetrics(next: EBPFMetrics) {
    metrics = next;
    metricsHistory = [...metricsHistory.slice(-59), next];
  }

  async function initHost() {
    const epoch = scope.epoch;
    const [pid, , hid] = ids();
    initializing = true;
    const [hostRes] = await Promise.all([getHost(pid, hid), scope.resolveAgent()]);
    if (scope.isStale(epoch)) return;
    if (hostRes.error) hostError = hostRes.error;
    else host = hostRes.data?.host ?? null;
    if (host && host.status !== 'revoked') writeLastHost(pid, hid);
    if (!scope.agentId) {
      initializing = false;
      return;
    }
    await Promise.all([loadStatus(epoch), loadConfig(epoch), loadPortPolicies(epoch), loadMetrics(epoch)]);
    if (scope.isStale(epoch)) return;
    initializing = false;
  }

  async function loadStatus(epoch: number) {
    const [pid, aid, hid] = ids();
    const res = await getEBPFStatus(pid, aid, hid);
    if (scope.isStale(epoch)) return;
    if (res.error) {
      statusError = res.error.error;
      return;
    }
    statusError = null;
    status = res.data ?? null;
  }

  async function loadMetrics(epoch: number) {
    const [pid, aid, hid] = ids();
    const res = await getEBPFMetrics(pid, aid, hid);
    if (scope.isStale(epoch) || res.error) return;
    if (isValidMetrics(res.data)) pushMetrics(res.data);
  }

  /** Rebuilds the Settings draft from the server unless the operator has unsaved edits. */
  function syncSettings(force = false) {
    if (!serverConfig || !serverPortPolicy) return;
    const fresh: SettingsDraft = { config: structuredClone($state.snapshot(serverConfig)), portPolicy: { ...serverPortPolicy } };
    if (force || !draft || !settingsDirty.isDirty) {
      draft = fresh;
      settingsDirty.reset();
    } else {
      // Keep the edits; compare them against what the host has now.
      settingsDirty.reset(fresh);
    }
  }

  async function loadConfig(epoch: number) {
    const [pid, aid, hid] = ids();
    const res = await getEBPFConfig(pid, aid, hid);
    if (scope.isStale(epoch)) return;
    configLoaded = true;
    if (res.error) {
      configError = res.error.error || 'Could not load the firewall configuration.';
      return;
    }
    configError = null;
    serverConfig = normalizeConfig(res.data);
    syncSettings();
  }

  async function loadPortPolicies(epoch: number, signal?: AbortSignal) {
    const [pid, aid, hid] = ids();
    const res = await getEBPFPortPolicies(pid, aid, hid, signal);
    if (scope.isStale(epoch) || signal?.aborted) return;
    if (res.error) {
      portPolicyError = res.error.error || 'Could not load the port policy.';
      return;
    }
    portPolicyError = null;
    portRules = res.data?.policies ?? [];
    const next = normalizePortPolicy(res.data?.config);
    const changed = !serverPortPolicy || countChanges(serverPortPolicy, next) > 0;
    serverPortPolicy = next;
    if (changed) syncSettings();
  }

  /** Entries per request (the control plane's maximum for these lists). */
  const LIST_PAGE = 1000;
  /** Most entries per list the page loads on request ("Load all"). */
  const LIST_MAX = 20_000;

  /** One IP list, following `total` in pages of LIST_PAGE up to `want` entries. */
  async function loadIpList(epoch: number, kind: 'block' | 'allow' | 'egress', want: number, signal?: AbortSignal): Promise<{ data?: { entries: EBPFAllowlistEntry[]; total: number; portsSupported?: boolean }; error?: ApiError }> {
    const [pid, aid, hid] = ids();
    const fetchPage = kind === 'block' ? getEBPFBlocklist : kind === 'allow' ? getEBPFAllowlist : getEBPFEgressBlocklist;
    const entries: EBPFAllowlistEntry[] = [];
    let total = 0;
    let portsSupported: boolean | undefined;
    for (;;) {
      const res = await fetchPage(pid, LIST_PAGE, aid, hid, entries.length, signal);
      if (scope.isStale(epoch) || signal?.aborted) return {};
      if (res.error) return { error: res.error };
      const batch = res.data?.entries ?? [];
      entries.push(...batch);
      total = res.data?.total ?? entries.length;
      const flag = (res.data as { allowlist_ports_supported?: unknown } | undefined)?.allowlist_ports_supported;
      if (typeof flag === 'boolean') portsSupported = flag;
      if (!batch.length || entries.length >= Math.min(total, want)) break;
    }
    return { data: { entries, total, portsSupported } };
  }

  async function loadRules(epoch: number, signal?: AbortSignal) {
    const [pid, aid, hid] = ids();
    rulesLoading = true;
    const want = listWant;
    const [blockRes, allowRes, egressRes, geoRes, portRes] = await Promise.all([
      loadIpList(epoch, 'block', want, signal),
      loadIpList(epoch, 'allow', want, signal),
      loadIpList(epoch, 'egress', want, signal),
      getEBPFGeoBlocked(pid, aid, hid, signal),
      getEBPFPortPolicies(pid, aid, hid, signal),
    ]);
    if (scope.isStale(epoch)) return;
    if (signal?.aborted) {
      // Poller stopped (tab changed): the next load fills these in.
      rulesLoading = false;
      return;
    }
    rulesLoading = false;
    const failed = [blockRes, allowRes, egressRes, geoRes, portRes].find((res) => res.error);
    rulesError = failed?.error?.error ?? null;
    const windowOf = (data: { entries: EBPFIPListEntry[]; total?: number } | undefined): ListWindow => ({ loaded: data?.entries?.length ?? 0, total: data?.total ?? data?.entries?.length ?? 0 });
    if (blockRes.data) blocklist = blockRes.data.entries ?? [];
    if (allowRes.data) {
      allowlist = allowRes.data.entries ?? [];
      allowlistPortsReported = allowRes.data.portsSupported === true;
    }
    if (egressRes.data) egressList = egressRes.data.entries ?? [];
    if (geoRes.data) {
      geo = geoRes.data.countries ?? [];
      geoPolicy = geoPolicyView(geoRes.data);
    }
    windows = { block: windowOf(blockRes.data), allow: windowOf(allowRes.data), egress: windowOf(egressRes.data) };
    if (portRes.data) {
      portPolicyError = null;
      portRules = portRes.data.policies ?? [];
      const next = normalizePortPolicy(portRes.data.config);
      const changed = !serverPortPolicy || countChanges(serverPortPolicy, next) > 0;
      serverPortPolicy = next;
      if (changed) syncSettings();
    }
    if (!failed) rulesLoaded = true;
  }

  // Newest Overview load: an older range's (or poll's) answer arriving later
  // is dropped instead of landing under the new range label.
  let overviewSeq = 0;

  async function loadOverview(epoch: number, forRange: TimeRangeKey, signal?: AbortSignal) {
    const seq = ++overviewSeq;
    const [pid, aid, hid] = ids();
    if (overviewRange !== forRange) {
      // Figures of the previous range must not sit under the new range label.
      overviewRange = forRange;
      analytics = null;
      analyticsError = null;
      rangeNotice = null;
      dropsSummary = null;
      dropsError = null;
      topIPs = [];
      topIPsError = null;
    }
    analyticsLoading = true;
    topIPsLoading = true;
    const [analyticsRes, dropsRes, topRes] = await Promise.all([
      getFirewallAnalytics(pid, forRange, aid, hid, signal),
      getFirewallDropsSummary(pid, forRange, aid, hid, signal),
      getFirewallTopIPs(pid, 50, aid, hid, forRange, signal),
      loadPortPolicies(epoch, signal),
    ]);
    if (scope.isStale(epoch) || seq !== overviewSeq) return;
    if (signal?.aborted) {
      // Poller stopped (range, host or tab changed): the next load fills these in.
      analyticsLoading = false;
      topIPsLoading = false;
      return;
    }
    analyticsLoading = false;
    topIPsLoading = false;
    if (analyticsRes.error) {
      analyticsError = analyticsRes.error.error;
    } else {
      analyticsError = null;
      analytics = analyticsRes.data ?? null;
      // The control plane answers unknown windows with all time; say so.
      rangeNotice = analytics?.range && analytics.range !== forRange
        ? `Firewall analytics do not support “${timeRangeLabel(forRange)}” on this control plane yet; the figures cover ${analytics.range === 'all' ? 'all retained events' : timeRangeLabel(analytics.range as TimeRangeKey).toLowerCase()}.`
        : null;
    }
    dropsError = dropsRes.error ? dropsRes.error.error || 'Could not load the drop summary.' : null;
    if (!dropsRes.error) dropsSummary = dropsRes.data?.drops ?? null;
    topIPsError = topRes.error ? topRes.error.error || 'Could not load the top sources.' : null;
    if (topRes.data) topIPs = topRes.data.ips ?? [];
  }

  async function reloadTopIPs() {
    const epoch = scope.epoch;
    const [pid, aid, hid] = ids();
    const forRange = range;
    const seq = overviewSeq;
    topIPsLoading = true;
    const res = await getFirewallTopIPs(pid, 50, aid, hid, forRange);
    if (scope.isStale(epoch) || seq !== overviewSeq || overviewRange !== forRange) return;
    topIPsLoading = false;
    topIPsError = res.error ? res.error.error || 'Could not load the top sources.' : null;
    if (res.data) topIPs = res.data.ips ?? [];
  }

  async function loadLive(epoch: number, signal?: AbortSignal) {
    const [pid, aid, hid] = ids();
    liveLoading = { events: true, connections: true, bandwidth: true };
    const [eventsRes, connRes, bwRes] = await Promise.all([
      getEBPFEvents(pid, 100, aid, hid, signal),
      getEBPFConnections(pid, 100, aid, hid, signal),
      getEBPFBandwidth(pid, 100, aid, hid, signal),
    ]);
    if (scope.isStale(epoch)) return;
    if (signal?.aborted) {
      // Poller stopped (stream opened, tab or host changed): no stuck spinners.
      liveLoading = { events: false, connections: false, bandwidth: false };
      return;
    }
    liveLoading = { events: false, connections: false, bandwidth: false };
    const failure = (res: { error?: ApiError }, what: string) => (res.error ? res.error.error || `Could not load ${what}.` : null);
    liveErrors = { events: failure(eventsRes, 'packet events'), connections: failure(connRes, 'connections'), bandwidth: failure(bwRes, 'bandwidth') };
    if (eventsRes.data) events = eventsRes.data.events ?? [];
    if (connRes.data) connections = connRes.data.connections ?? [];
    if (bwRes.data) bandwidth = bwRes.data.entries ?? [];
  }

  // ── Streams and pollers (bound to effects: they stop with the page) ──
  const agentReady = $derived(scope.agentStatus === 'ready' && !initializing);
  const streamWanted = $derived(agentReady && live && !scope.hidden && status?.running === true && status?.agent_online === true);

  $effect(() => {
    if (!streamWanted) {
      sseState = 'closed';
      return;
    }
    const epoch = untrack(() => scope.epoch);
    const [pid, aid, hid] = untrack(ids);
    streamError = null;
    const conn = createSSEConnection({
      projectId: pid,
      agentId: aid,
      hostId: hid,
      channels: ['metrics', 'events', 'connections', 'bandwidth', 'status'],
      onStateChange: (state) => {
        if (scope.isStale(epoch)) return;
        sseState = state;
        if (state === 'open') streamError = null; // a STREAM_LIMIT wait is over
      },
      onFatal: (error) => { if (!scope.isStale(epoch)) streamError = error.error; },
      onLimit: (error) => { if (!scope.isStale(epoch)) streamError = error.error; },
      onMetrics: (m) => { if (!scope.isStale(epoch) && isValidMetrics(m)) pushMetrics(m); },
      onEvents: (d) => { if (!scope.isStale(epoch)) { events = d.events ?? []; liveErrors.events = null; } },
      onConnections: (d) => { if (!scope.isStale(epoch)) { connections = d.connections ?? []; liveErrors.connections = null; } },
      onBandwidth: (d) => { if (!scope.isStale(epoch)) { bandwidth = d.entries ?? []; liveErrors.bandwidth = null; } },
      onStatus: (d) => {
        if (scope.isStale(epoch) || !status) return;
        // The stream carries the agent's own status plus liveness; keep the
        // fields only the REST answer has (delivery, ingestion, coverage).
        const payload = d as { ebpf?: Partial<EBPFStatus>; agent_online?: boolean };
        if (payload.ebpf) status = { ...status, ...payload.ebpf };
        else if (typeof payload.agent_online === 'boolean') status = { ...status, agent_online: payload.agent_online };
      },
    });
    return () => conn.close();
  });

  // Status (and metrics while no stream is open) every 15 s.
  $effect(() => {
    if (!agentReady) return;
    const epoch = untrack(() => scope.epoch);
    createPoller(async () => {
      await loadStatus(epoch);
      if (sseState !== 'open') await loadMetrics(epoch);
    }, 15_000, { immediate: false });
  });

  // Overview figures for the selected range, refreshed every minute.
  $effect(() => {
    if (!agentReady || tab !== 'overview') return;
    const forRange = range;
    const epoch = untrack(() => scope.epoch);
    createPoller((signal) => loadOverview(epoch, forRange, signal), 60_000);
  });

  // Access rules: hit counts refresh every 30 s while the tab is open.
  $effect(() => {
    if (!agentReady || tab !== 'rules') return;
    const epoch = untrack(() => scope.epoch);
    createPoller((signal) => loadRules(epoch, signal), 30_000);
  });

  // Live: REST snapshot on open; polling only while no stream is open.
  const streamOpen = $derived(sseState === 'open');
  $effect(() => {
    if (!agentReady || tab !== 'live') return;
    const epoch = untrack(() => scope.epoch);
    if (streamOpen) {
      untrack(() => { if (!events.length && !connections.length && !bandwidth.length) void loadLive(epoch); });
      return;
    }
    createPoller((signal) => loadLive(epoch, signal), 15_000);
  });

  // ── Unsaved settings: ask before leaving the page or switching host ──
  beforeNavigate((navigation) => {
    if (!settingsDirty.isDirty || navigation.type === 'leave') return;
    const to = navigation.to?.url;
    // Tab, range and filter changes keep the draft (it lives on the page).
    if (to && to.pathname === page.url.pathname && (to.searchParams.get('host') ?? '') === hostId) return;
    if (!window.confirm(UNSAVED_CHANGES_MESSAGE)) navigation.cancel();
  });
  $effect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!settingsDirty.isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  });

  // ── Derived views ─────────────────────────────────────────────────────
  const accessRules = $derived<AccessRule[]>(buildAccessRules({ blocklist, allowlist, sshPorts, egress: egressList, geo, geoMode: geoPolicy.mode, geoAllowed: geoPolicy.allowed, ports: portRules }));
  const portAllowHits = $derived(portRules.filter((rule) => rule.action === 'allow').reduce((sum, rule) => sum + (rule.hit_count ?? 0), 0));
  const settingsErrors = $derived(draft ? validateSettings(draft) : {});
  const changeCount = $derived(draft && settingsDirty.isDirty ? countChanges(settingsDirty.baseline, $state.snapshot(draft)) : 0);
  const hostName = $derived(host?.name ?? status?.agent_name ?? 'this host');
  const tabItems = $derived<TabItem[]>(
    FIREWALL_TABS.map((item) => ({
      id: item.id,
      label: item.id === 'settings' && changeCount ? 'Settings (unsaved)' : item.label,
      count: item.id === 'rules' && rulesLoaded ? accessRules.length : undefined,
    })),
  );
  usePageTitle(() => (host?.name ? `${host.name} | Firewall` : null));
  const hostHref = $derived(`${base}/projects/${projectId}/hosts/${hostId}`);

  function lockoutContext(): LockoutContext {
    return {
      portRules,
      allowlist,
      blocklist,
      egressList,
      sshPorts,
      counts: {
        blocklist: windows.block?.total ?? blocklist.length,
        egress: windows.egress?.total ?? egressList.length,
        geo: geo.filter((entry) => entry.blocked).length,
        ports: portRules.length,
      },
      agentOnline: status?.agent_online ?? null,
      wouldDropPackets: metrics?.would_drop_packets ?? null,
    };
  }

  function changeLines(previous: FirewallState, next: FirewallState, others: number): string[] {
    const lines = firewallChanges(previous, next).map(describeChange);
    if (others > 0) lines.push(`${others} other ${others === 1 ? 'setting' : 'settings'} (limits, logging, detection)`);
    return lines;
  }

  // ── Settings save ─────────────────────────────────────────────────────
  async function requestSave() {
    if (!draft || !canConfigure || saving) return;
    if (Object.keys(settingsErrors).length) return;
    const epoch = scope.epoch;
    if (!rulesLoaded) {
      // Busy from the first click: a second one must not start a second save.
      saving = true;
      try {
        await loadRules(epoch);
      } finally {
        saving = false;
      }
    }
    if (scope.isStale(epoch) || !draft) return;
    const baseline = settingsDirty.baseline as SettingsDraft;
    const snapshot = $state.snapshot(draft) as SettingsDraft;
    const previous = draftState(baseline);
    const next = draftState(snapshot);
    const modeFields = countChanges(previous, next);
    const others = Math.max(0, countChanges(baseline, snapshot) - modeFields);
    const checks = lockoutChecks(previous, next, lockoutContext());
    const tier = firewallChangeTier(previous, next);
    saveError = null;
    if (tier === 'none' && checks.length === 0) {
      await saveSettings();
      return;
    }
    guardError = null;
    guard = {
      kind: 'settings',
      title: `Apply firewall settings to ${hostName}?`,
      changes: changeLines(previous, next, others),
      checks,
      tier,
      confirmLabel: 'Save and apply',
      tone: tier === 'typed' ? 'danger' : 'warning',
    };
  }

  async function saveSettings(): Promise<boolean> {
    if (!draft) return false;
    const epoch = scope.epoch;
    const [pid, aid, hid] = ids();
    const snapshot = $state.snapshot(draft) as SettingsDraft;
    const parts = changedParts(settingsDirty.baseline as SettingsDraft, snapshot);
    saving = true;
    saveError = null;
    saveWarnings = [];
    let failure: string | null = null;
    let warnings: FirewallWarning[] = [];
    for (const part of saveOrder(snapshot)) {
      if (!parts[part]) continue;
      const res = part === 'config'
        ? await updateEBPFConfig(pid, snapshot.config, aid, hid)
        : await updateEBPFPortPolicyConfig(pid, snapshot.portPolicy, aid, hid);
      if (scope.isStale(epoch)) return false;
      if (res.error) {
        failure = firewallErrorMessage(res.error);
        break;
      }
      warnings = mergeWarnings(warnings, firewallWarningsOf(res.data));
    }
    saveWarnings = warnings;
    // Reload what the host has now; a partial save must not look complete.
    await Promise.all([loadConfig(epoch), loadPortPolicies(epoch), loadStatus(epoch)]);
    if (scope.isStale(epoch)) return false;
    saving = false;
    if (failure) {
      saveError = failure;
      return false;
    }
    syncSettings(true);
    toast.success(`Firewall settings saved for ${hostName}. The agent applies them on its next update.`, 'Settings saved');
    return true;
  }

  function discardSettings() {
    syncSettings(true);
    saveError = null;
  }

  // ── Monitor-only → enforce from the status banner ─────────────────────
  async function requestEnforce() {
    if (!canConfigure || enforceBusy) return;
    if (settingsDirty.isDirty) {
      toast.warning('Save or discard your unsaved Settings first; the switch uses the saved configuration.', 'Unsaved settings');
      selectTab('settings');
      return;
    }
    const epoch = scope.epoch;
    enforceBusy = true;
    if (!serverConfig) await loadConfig(epoch);
    if (!rulesLoaded) await loadRules(epoch);
    if (scope.isStale(epoch)) return;
    enforceBusy = false;
    if (!serverConfig) {
      toast.error('The host has not reported its firewall configuration yet.', 'Cannot switch');
      return;
    }
    const previous = firewallState(serverConfig.global, serverPortPolicy);
    const next = { ...previous, monitor_only: false };
    const tier = firewallChangeTier(previous, next);
    guardError = null;
    guard = {
      kind: 'enforce',
      title: `Switch ${hostName} to Enforce?`,
      changes: changeLines(previous, next, 0),
      checks: lockoutChecks(previous, next, lockoutContext()),
      tier,
      confirmLabel: 'Enforce',
      tone: tier === 'typed' ? 'danger' : 'warning',
    };
  }

  async function applyEnforce(): Promise<boolean> {
    if (!serverConfig) return false;
    const epoch = scope.epoch;
    const [pid, aid, hid] = ids();
    const config = structuredClone($state.snapshot(serverConfig)) as EBPFFullConfig;
    config.global.monitor_only = false;
    const res = await updateEBPFConfig(pid, config, aid, hid);
    if (scope.isStale(epoch)) return false;
    if (res.error) {
      guardError = firewallErrorMessage(res.error);
      return false;
    }
    saveWarnings = firewallWarningsOf(res.data);
    await Promise.all([loadConfig(epoch), loadStatus(epoch)]);
    if (scope.isStale(epoch)) return false;
    syncSettings(true);
    toast.success(`${hostName} now drops matching packets.`, 'Enforce mode');
    return true;
  }

  async function confirmGuard() {
    if (!guard || guardBusy) return;
    guardBusy = true;
    guardError = null;
    const ok = guard.kind === 'settings' ? await saveSettings()
      : guard.kind === 'geo' ? geoPending !== null && (await applyGeo(geoPending))
      : await applyEnforce();
    guardBusy = false;
    if (ok) {
      guard = null;
      geoPending = null;
    } else if (guard?.kind === 'settings') guardError = saveError;
    else if (guard?.kind === 'geo') guardError = geoError;
  }

  function onFix(fix: CheckFix) {
    if (fix === 'rules') selectTab('rules');
    else if (fix === 'settings') selectTab('settings');
    else if (fix === 'live') selectTab('live');
    else selectTab('overview');
  }

  // ── Geo policy (block / allow mode) ───────────────────────────────────
  /** Sends a geo policy change; errors land in geoError, warnings in saveWarnings. */
  async function applyGeo(body: EBPFGeoPolicyUpdate): Promise<boolean> {
    if (!canConfigure) return false;
    const epoch = scope.epoch;
    const [pid, aid, hid] = ids();
    geoBusy = true;
    geoError = null;
    saveWarnings = [];
    const res = await updateEBPFGeoPolicy(pid, body, aid, hid);
    if (scope.isStale(epoch)) return false;
    geoBusy = false;
    if (res.error) {
      geoError = firewallErrorMessage(res.error);
      return false;
    }
    saveWarnings = firewallWarningsOf(res.data);
    await Promise.all([loadRules(epoch), loadConfig(epoch)]);
    return true;
  }

  async function switchGeoMode(next: GeoMode, codes: string[]) {
    const body: EBPFGeoPolicyUpdate = { mode: next };
    if (next === 'allow' && codes.length) body.allowed_countries = codes.map((code) => ({ code, allowed: true }));
    geoError = null;
    if (!geoAllowNeedsAck({ current: geoPolicy.mode, next })) {
      if (await applyGeo(body)) toast.success(`${hostName} now blocks only the listed countries.`, 'Geo policy saved');
      return;
    }
    const list = allowListAfter(geoPolicy.allowed, codes);
    geoPending = { ...body, allow_acknowledged: true };
    guardError = null;
    guard = {
      kind: 'geo',
      title: `Switch ${hostName} to geo allow mode?`,
      changes: [`Only allow new inbound connections from ${list.join(', ')}; geo filtering is turned on.`, ...GEO_ALLOW_CONSEQUENCES],
      checks: [],
      tier: 'simple',
      confirmLabel: 'Switch to allow mode',
      tone: 'danger',
    };
  }

  // ── Access rules ──────────────────────────────────────────────────────
  function openAdd(type: AccessRuleType, text = '') {
    addType = type;
    addText = text;
    addOpen = true;
  }

  // "Block this IP on the host firewall" (Overview decision panel) links here
  // with ?tab=blocklist&ip=<ip>: open the add drawer with the address filled
  // in once the host agent is ready, never submit it, and drop `ip` from the
  // URL so a reload does not open it again.
  $effect(() => {
    const ip = page.url.searchParams.get('ip')?.trim() ?? '';
    if (!ip || !agentReady || !project.project) return;
    untrack(() => {
      const params = new URLSearchParams(page.url.search);
      params.delete('ip');
      const search = params.toString();
      replaceSearch(search ? `?${search}` : '');
      if (!canConfigure) return;
      const type: AccessRuleType = ruleFilter === 'allow' || ruleFilter === 'egress' ? ruleFilter : 'block';
      openAdd(type, ip.slice(0, 64));
    });
  });

  async function submitAdd(request: AccessRuleAdd): Promise<string | null> {
    if (!canConfigure) return 'Your role cannot change access rules.';
    const epoch = scope.epoch;
    const [pid, aid, hid] = ids();
    let error: string | null = null;
    let warnings: FirewallWarning[] = [];
    saveWarnings = [];
    if (request.type === 'port') {
      const failed: string[] = [];
      for (const port of request.ports) {
        const res = await addEBPFPortPolicy(pid, { port, proto: request.proto, direction: request.direction, action: request.action, ttl_ms: request.ttlMs }, aid, hid);
        if (scope.isStale(epoch)) return null;
        if (res.error) failed.push(`${portRuleLabel({ port, proto: request.proto })}: ${firewallErrorMessage(res.error)}`);
        else warnings = mergeWarnings(warnings, firewallWarningsOf(res.data));
      }
      if (failed.length) error = `${failed.length} of ${request.ports.length} port rules were not added: ${failed.join('; ')}`;
    } else if (request.type === 'geo' && request.allow) {
      // Adding allowed countries only widens access: no confirmation needed.
      const res = await updateEBPFGeoPolicy(pid, { allowed_countries: request.codes.map((code) => ({ code, allowed: true })) }, aid, hid);
      if (scope.isStale(epoch)) return null;
      if (res.error) error = firewallErrorMessage(res.error);
      else warnings = firewallWarningsOf(res.data);
    } else if (request.type === 'geo') {
      const res = await updateEBPFGeoBlocked(pid, request.codes.map((code) => ({ code, blocked: true })), aid, hid);
      if (scope.isStale(epoch)) return null;
      if (res.error) error = firewallErrorMessage(res.error);
      else warnings = firewallWarningsOf(res.data);
    } else {
      const ports = request.type === 'allow' && request.ports?.length ? request.ports : undefined;
      const entries = request.addresses.map((ip) => ({ ip, ttl_ms: request.ttlMs, ...(ports ? { ports } : {}) }));
      const res = request.type === 'block' ? await addEBPFBlocklist(pid, entries, aid, hid)
        : request.type === 'allow' ? await addEBPFAllowlist(pid, entries, aid, hid)
        : await addEBPFEgressBlocklist(pid, entries, aid, hid);
      if (scope.isStale(epoch)) return null;
      if (res.error) error = firewallErrorMessage(res.error);
      else warnings = firewallWarningsOf(res.data);
    }
    saveWarnings = warnings;
    await loadRules(epoch);
    if (scope.isStale(epoch)) return null;
    if (error) return error;
    lastAdd = request.type === 'geo' ? null : request;
    toast.success(`${describeAdd(request)}.`, 'Access rules added');
    return null;
  }

  async function removeRule(rule: AccessRule): Promise<string | null> {
    if (!canConfigure) return 'Your role cannot change access rules.';
    const epoch = scope.epoch;
    const [pid, aid, hid] = ids();
    const res = rule.type === 'block' ? await deleteEBPFBlocklist(pid, [{ ip: rule.target }], aid, hid)
      : rule.type === 'allow' ? await deleteEBPFAllowlist(pid, [{ ip: rule.target }], aid, hid)
      : rule.type === 'egress' ? await deleteEBPFEgressBlocklist(pid, [{ ip: rule.target }], aid, hid)
      // An allowed country (allow mode): the panel's confirmation showed the allow-mode warning.
      : rule.type === 'geo' && rule.action === 'allow' ? await updateEBPFGeoPolicy(pid, { allowed_countries: [{ code: rule.target, allowed: false }], allow_acknowledged: true }, aid, hid)
      : rule.type === 'geo' ? await updateEBPFGeoBlocked(pid, [{ code: rule.target, blocked: false }], aid, hid)
      : await deleteEBPFPortPolicy(pid, { port: rule.port?.port ?? 0, proto: rule.port?.proto ?? 'any', direction: rule.port?.direction ?? 'ingress' }, aid, hid);
    if (scope.isStale(epoch)) return null;
    if (res.error) return firewallErrorMessage(res.error);
    saveWarnings = firewallWarningsOf(res.data);
    await loadRules(epoch);
    toast.success(`${rule.label} removed.`, 'Access rule removed');
    return null;
  }

  function loadAllRules() {
    listWant = LIST_MAX;
    void loadRules(scope.epoch);
  }

  function retryHost() {
    scope.reset();
    void initHost();
  }
</script>

<div class="page">
  <PageHeader
    title="Firewall"
    subtitle="Kernel packet filtering (XDP/TC) on one host: what it drops, which rules apply, and how it is configured."
    backHref={`${base}/projects/${projectId}`}
  />

  {#if !hostId}
    <HostPicker {projectId} title="Choose a host" description="Pick the host whose kernel firewall you want to review or change." />
  {:else}
    <div class="hostbar">
      <div class="hostbar-name">
        <span>Host</span>
        <HostSwitcher {projectId} {hostId} hostName={host?.name ?? (hostError ? 'unknown host' : '')} />
        {#if status}<StatusDot status={status.agent_online ? 'online' : 'offline'} label={status.agent_online ? 'Agent online' : 'Agent offline'} />{/if}
      </div>
      <nav class="hostbar-links" aria-label="Host navigation">
        <a href={hostHref}>Host details</a>
        <a href={`${base}/projects/${projectId}/host/trace?host=${encodeURIComponent(hostId)}`}>Runtime security</a>
      </nav>
    </div>

    {#if project.project && !canConfigure}
      <Alert tone="info" compact message="Read-only access: your role can view this host's firewall but not change it." />
    {/if}

    {#if hostError && !host && scope.agentStatus !== 'ready'}
      <Alert tone="error" title="Host not found" message="This host does not exist in the project or you no longer have access to it.">
        {#snippet actions()}<a href={`${page.url.pathname}?pick=1`}>Choose another host</a>{/snippet}
      </Alert>
    {:else if scope.agentStatus === 'resolving' || scope.agentStatus === 'idle' || (initializing && !status)}
      <Spinner label="Loading the host's firewall…" layout="block" />
    {:else if scope.agentStatus === 'error'}
      <Alert tone="error" title="Could not look up the host agent" message="The agent list for this host did not load.">
        {#snippet actions()}<Button variant="secondary" size="sm" onclick={retryHost}>Retry</Button>{/snippet}
      </Alert>
    {:else if scope.agentStatus === 'missing'}
      <EmptyState title="No host agent on this host" message={`${host?.name ?? 'This host'} has no host agent (kind “host”) registered, so it has no kernel firewall to manage. Install wafio-host-agent on it with its host key; WAF agents do not run the firewall.`} level={2}>
        {#snippet action()}<Button variant="primary" href={hostHref}>Open the host page</Button>{/snippet}
      </EmptyState>
    {:else if status}
      <FirewallStatusBanner {status} {metrics} setupHref={hostHref} {canConfigure} busy={enforceBusy} onenforce={requestEnforce} />

      {#if lastAdd && canConfigure}
        <Alert tone="info" compact title="Rule added on this host" message={`${describeAdd(lastAdd)}.`} ondismiss={() => (lastAdd = null)}>
          {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => (applyOpen = true)}>Apply to other hosts…</Button>{/snippet}
        </Alert>
      {/if}
      {#if saveWarnings.length}
        <Alert tone="warning" title="Saved. Review these warnings" ondismiss={() => (saveWarnings = [])}>
          <ul class="save-warnings">
            {#each saveWarnings as warning (warning.code + warning.message)}<li>{firewallWarningText(warning)}</li>{/each}
          </ul>
        </Alert>
      {/if}

      <Tabs tabs={tabItems} value={tab} label="Firewall sections" onchange={(id) => selectTab(id as FirewallTab)}>
        {#snippet children(active)}
          {#if active === 'overview'}
            <FirewallOverview
              {range}
              onrangechange={setRange}
              {rangeNotice}
              {analytics}
              {analyticsLoading}
              {analyticsError}
              onretryanalytics={() => void loadOverview(scope.epoch, range)}
              {dropsSummary}
              {dropsError}
              {topIPs}
              {topIPsLoading}
              {topIPsError}
              onreloadtopips={reloadTopIPs}
              {metrics}
              {metricsHistory}
              {status}
              {portAllowHits}
              {canConfigure}
              onblockip={(ip) => openAdd('block', ip)}
            />
          {:else if active === 'rules'}
            <div class="rules-tab">
            <GeoPolicyPanel
              mode={geoPolicy.mode}
              allowed={geoPolicy.allowed}
              blockedCount={geoPolicy.blocked.length}
              allowSupported={geoPolicy.allowSupported}
              {canConfigure}
              busy={geoBusy}
              onswitch={(next, codes) => void switchGeoMode(next, codes)}
            />
            {#if geoError && guard?.kind !== 'geo'}
              <Alert tone="error" compact title="Geo policy not saved" message={geoError} ondismiss={() => (geoError = null)} />
            {/if}
            {#if status?.geo_degraded_code}
              <Alert tone={status.geo_degraded_state === 'mixed' ? 'error' : 'warning'} compact
                title={`Geo policy not enforced on this host (${status.geo_degraded_code})`}
                message={`${status.geo_degraded_message ?? ''} ${geoDegradedStateText(status.geo_degraded_state)}`} />
            {/if}
            <AccessRulesPanel
              rules={accessRules}
              {windows}
              loading={rulesLoading && !rulesLoaded}
              error={rulesError}
              filter={ruleFilter}
              onfilterchange={setRuleFilter}
              {canConfigure}
              portPolicy={serverPortPolicy}
              {portRules}
              geoEnabled={serverConfig?.global.enable_geoblock ?? true}
              {sshPorts}
              onadd={(type) => openAdd(type)}
              onremove={removeRule}
              onrefresh={() => void loadRules(scope.epoch)}
              onloadall={listWant < LIST_MAX ? loadAllRules : undefined}
              loadAllLimit={LIST_MAX}
              onopensettings={() => selectTab('settings')}
            />
            <JailedIPs entries={status?.jail ?? []} total={status?.jail_count ?? 0} />
            </div>
          {:else if active === 'live'}
            <LivePanel
              {events}
              {connections}
              {bandwidth}
              view={liveView}
              onviewchange={setLiveView}
              bind:live
              streamState={sseState}
              {streamError}
              canStream={status?.running === true && status?.agent_online === true}
              loading={liveLoading}
              errors={liveErrors}
              onrefresh={() => void loadLive(scope.epoch)}
            />
          {:else if draft}
            <FirewallSettings
              bind:draft
              errors={settingsErrors}
              {changeCount}
              {saving}
              {saveError}
              {canConfigure}
              {portRules}
              {sshPorts}
              onsave={requestSave}
              ondiscard={discardSettings}
              onaddrule={() => openAdd('port')}
            />
          {:else if configError || portPolicyError}
            <Alert tone="error" title="Firewall settings did not load" message={configError ?? portPolicyError ?? ''}>
              {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => { const epoch = scope.epoch; void loadConfig(epoch); void loadPortPolicies(epoch); }}>Retry</Button>{/snippet}
            </Alert>
          {:else if configLoaded}
            <EmptyState title="No configuration reported yet" message="The host agent has not pushed its firewall configuration. It appears here once the agent runs with --ebpf." level={2} />
          {:else}
            <Spinner label="Loading settings…" layout="block" />
          {/if}
        {/snippet}
      </Tabs>
    {:else if statusError}
      <Alert tone="error" title="Firewall status did not load" message={statusError}>
        {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => void loadStatus(scope.epoch)}>Retry</Button>{/snippet}
      </Alert>
    {/if}
  {/if}
</div>

<AddRulesDrawer
  open={addOpen}
  initialType={addType}
  initialText={addText}
  context={{ geoEnabled: serverConfig?.global.enable_geoblock, portPolicy: serverPortPolicy, conntrack: serverConfig?.global.enable_conntrack, allowlist, sshPorts }}
  blockedCountries={geo.filter((entry) => entry.blocked).map((entry) => entry.code)}
  geoMode={geoPolicy.mode}
  allowedCountries={geoPolicy.allowed}
  disabled={!canConfigure}
  {sshPorts}
  {allowlistPortsSupported}
  onsubmit={submitAdd}
  onclose={() => (addOpen = false)}
/>

<ApplyToHostsFlow
  open={applyOpen}
  {projectId}
  mode="add"
  initialRequest={lastAdd}
  excludeHostIds={hostId ? [hostId] : []}
  onclose={() => (applyOpen = false)}
/>
<GuardedConfirm
  open={guard !== null}
  title={guard?.title ?? ''}
  changes={guard?.changes ?? []}
  checks={guard?.checks ?? []}
  tier={guard?.tier ?? 'simple'}
  confirmText={host?.name ?? ''}
  confirmLabel={guard?.confirmLabel ?? 'Apply'}
  tone={guard?.tone ?? 'warning'}
  loading={guardBusy}
  error={guardError}
  onconfirm={confirmGuard}
  onclose={() => { if (!guardBusy) { guard = null; geoPending = null; } }}
  onfix={onFix}
/>

<style>
  .rules-tab { display: grid; gap: var(--sp-4); min-width: 0; }
  .save-warnings { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); font-size: var(--fs-sm); }
  .page { display: grid; gap: var(--sp-4); width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); align-content: start; }
  .hostbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2) var(--sp-4); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .hostbar-name { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .hostbar-links { display: flex; flex-wrap: wrap; gap: var(--sp-4); font-size: var(--fs-sm); }
  .hostbar-links a { color: var(--accent); }
</style>
