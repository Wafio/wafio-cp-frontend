<!--
  PathRuleEditor: native modal that edits one rule path on a copy. "Apply"
  writes the copy into the policy draft (it is saved with the policy);
  closing with changes asks "Discard unsaved changes?".
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import chevronRight from 'svelte-awesome/icons/chevronRight';
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Field from '#lib/components/ui/Field.svelte';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import PathTuningSection from '../rules/PathTuningSection.svelte';
  import PathMatchPreview from '../rules/PathMatchPreview.svelte';
  import PathEngineSwitches from './PathEngineSwitches.svelte';
    import Switch from '#lib/components/ui/Switch.svelte';
  import SegmentedRadio from '../rules/SegmentedRadio.svelte';
  import DecimalInput from './DecimalInput.svelte';
  import ChoiceGroup from './ChoiceGroup.svelte';
  import SecretInput from './SecretInput.svelte';
  import { isHiddenSecret } from '#lib/secret-redaction.js';
  import type { ConfigSecretFlags } from '#lib/api.js';
  import { PATH_INSPECTION_OFF, PATH_INSPECTION_OFF_ALERT } from '#lib/inspection.js';
  import ByteSizeInput from './ByteSizeInput.svelte';
  import {
    SENSITIVITY_ENGINES,
    SENSITIVITY_LEVELS,
    pathSensitivityOf,
    setOwnValues,
    setPathSensitivity,
    sensitivityLevelOf,
    type PathSensitivity,
    HTTP_METHODS,
    ENGINE_ACTIONS,
    effectiveCaseInsensitive,
    restrictsAccess,
    tuningSkipsAll,
    type FieldAction,
    type FieldSource,
    type PathMatch,
    type PathRuleDraft,
    type PolicyDraft
  } from './model';
  import { validatePathRule, type PathRuleIssue } from './validate';

  let {
    open = false,
    rule,
    isNew = false,
    policy,
    readonly = false,
    secrets = null,
    onapply,
    onclose
  }: {
    open?: boolean;
    /** Rule to edit (copied on open); a fresh rule for "Add". */
    rule: PathRuleDraft;
    isNew?: boolean;
    /** Current policy draft, for the global values the overrides start from. */
    policy: PolicyDraft;
    readonly?: boolean;
    /** Credential flags of the loaded config: redacted AES keys show as hidden. */
    secrets?: ConfigSecretFlags | null;
    onapply: (rule: PathRuleDraft) => void;
    onclose: () => void;
  } = $props();

  type Tab = PathRuleIssue['tab'];
  const MATCH_OPTIONS: { value: PathMatch; label: string }[] = [
    { value: 'prefix', label: 'Prefix' },
    { value: 'exact', label: 'Exact' },
    { value: 'regex', label: 'Regular expression (RE2)' },
  ];
  const FIELD_SOURCES: { value: FieldSource; label: string }[] = [
    { value: 'any', label: 'Any body (all three types)' },
    { value: 'body.json', label: 'application/json' },
    { value: 'urlencoded', label: 'application/x-www-form-urlencoded' },
    { value: 'multipart', label: 'multipart/form-data' },
  ];
  const FIELD_ACTION_OPTIONS: { value: FieldAction; label: string }[] = [
    { value: 'mask', label: 'Mask in logs' },
    { value: 'decrypt_aes', label: 'Decrypt before inspection' },
    { value: 'encrypt_aes', label: 'Encrypt before forwarding' },
  ];
  // Older source values are listed only so a stored rule keeps showing what it is.
  function sourceOptions(source: FieldSource): { value: FieldSource; label: string }[] {
    if (source === 'form') return [...FIELD_SOURCES, { value: 'form', label: 'urlencoded or multipart/form-data' }];
    if (source === 'query' || source === 'header') {
      return [...FIELD_SOURCES, { value: source, label: `${source === 'query' ? 'Query string' : 'Header'} (not applied)` }];
    }
    return FIELD_SOURCES;
  }
  const aesHidden = (value: string) => isHiddenSecret(secrets?.secrets_redacted, secrets?.aes_keys_set, value);
  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  let edit = $state<PathRuleDraft>(untrack(() => clone(rule)));
  let initial = untrack(() => JSON.stringify(rule));
  let tab = $state<string>('path');
  let attempted = $state(false);
  let modal = $state<ReturnType<typeof Modal>>();

  // A new rule was handed in while open (Edit on another row): start over.
  $effect.pre(() => {
    const source = rule;
    untrack(() => {
      edit = clone(source);
      initial = JSON.stringify(source);
      tab = 'path';
      attempted = false;
    });
  });

  const dirty = $derived(JSON.stringify(edit) !== initial);
  const issues = $derived(validatePathRule(edit));
  const visible = $derived(attempted ? issues : []);
  const err = (path: string) => visible.find((issue) => issue.path === path)?.message;
  const tabProblems = (id: Tab) => visible.filter((issue) => issue.tab === id).length;
  const caseInsensitive = $derived(effectiveCaseInsensitive(edit));

  const TAB_LABELS: Record<Tab, string> = { path: 'Path', inspection: 'Inspection', access: 'Access', limits: 'Limits', login: 'Login', fields: 'Fields & encryption', sensitivity: 'Engine sensitivity' };
  const tabs = $derived((Object.keys(TAB_LABELS) as Tab[]).map((id) => {
    const n = tabProblems(id);
    return { id, label: TAB_LABELS[id], count: n > 0 ? `${n} ${n === 1 ? 'problem' : 'problems'}` : undefined };
  }));

  const FIELD_ACTION_HINTS = {
    mask: 'Shown as [MASKED] in logs; the app still receives the real value.',
    decrypt_aes: 'The client sends this field AES-256-GCM encrypted (base64). The WAF decrypts it, inspects it and forwards the plain value.',
    encrypt_aes: 'The WAF inspects the plain value, then forwards it encrypted, so the app stores only ciphertext. To show it again, add Response decryption with the same key on the path that returns it.'
  } as const;

  const actionLabel = (value: string | undefined) => ENGINE_ACTIONS.find((action) => action.value === value)?.label;
  // Sensitivity on this path: the policy's values or one of the levels. 'custom' is a state no option carries.
  const PATH_LEVELS: { value: PathSensitivity; label: string }[] = [{ value: 'policy', label: 'Policy' }, ...SENSITIVITY_LEVELS.map((l) => ({ value: l.value as PathSensitivity, label: l.label }))];
  let valuesOpen = $state(false);
  // A number typed for an engine that follows the policy gives it its own values first.
  function setOwnNumber(key: (typeof SENSITIVITY_ENGINES)[number]['key'], prop: 'block' | 'soft', value: number | null) {
    setOwnValues(edit, policy, key, true);
    edit.semanticOverride[key]![prop] = value;
  }
  const valueErrors = $derived(visible.some((issue) => issue.tab === 'sensitivity'));

  function toggleMethod(list: string[], method: string, on: boolean): string[] {
    return on ? [...list.filter((m) => m !== method), method] : list.filter((m) => m !== method);
  }

  async function apply() {
    attempted = true;
    const first = issues[0];
    if (first) {
      tab = first.tab;
      await tick();
      document.getElementById(`wp-pr-${first.path.replace(/[^A-Za-z0-9_-]+/g, '-')}`)?.focus();
      return;
    }
    onapply(clone(edit));
  }

  const id = (path: string) => `wp-pr-${path.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
</script>

<Modal
  bind:this={modal}
  {open}
  title={isNew ? 'Add rule path' : `Edit rule path ${rule.path}`}
  size="2xl"
  dirty={dirty && !readonly}
  discardTitle="Discard changes to this rule path?"
  discardMessage="Your edits to this rule path have not been applied to the policy."
  {onclose}
>
  <div class="wp-pr">
    <Tabs {tabs} bind:value={tab} label="Rule path settings" size="sm">
      {#snippet children(active)}
        {#if active === 'path'}
          <div class="wp-pr-panel">
            <div class="wp-pr-path">
              <Field label="Path" hint="Prefix /api/editor matches every sub-path; exact matches only that path; regex uses RE2 syntax." error={err('path')} id={id('path')} required>
                {#snippet children(c)}<input {...c} type="text" class="wp-mono" spellcheck="false" placeholder="/api/editor" bind:value={edit.path} disabled={readonly} data-autofocus />{/snippet}
              </Field>
              <Field label="Match" id={id('match')}>
                {#snippet children(c)}
                  <Select {...c} options={MATCH_OPTIONS} bind:value={edit.match} disabled={readonly} />
                {/snippet}
              </Field>
            </div>
            <PathMatchPreview path={edit.path} match={edit.match} {caseInsensitive} restrictive={restrictsAccess(edit)} />
            <div class="wp-grid">
              <Switch checked={caseInsensitive} id={id('caseInsensitive')} disabled={readonly} label="Ignore case"
                hint={edit.caseInsensitive === null
                  ? caseInsensitive
                    ? 'Automatic (on): this rule only restricts access, so /Admin is treated like /admin and cannot get around it.'
                    : 'Automatic (off): /Admin and /admin are different paths for this rule. Rate, body size and login limits always ignore case.'
                  : 'Set by hand for this rule.'}
                onchange={(value) => (edit.caseInsensitive = value)}>
                {#if edit.caseInsensitive !== null && !readonly}
                  <button type="button" class="wp-link-button" onclick={() => (edit.caseInsensitive = null)}>Use automatic setting</button>
                {/if}
              </Switch>
              <Switch checked={edit.active} id={id('active')} disabled={readonly} label="Rule is active" hint="An inactive rule is kept but ignored; normal inspection applies." onchange={(value) => (edit.active = value)} />
            </div>
            <Field label="Comment" hint="Why this rule exists (up to 200 characters)." error={err('comment')} id={id('comment')} optional>
              {#snippet children(c)}<input {...c} type="text" maxlength="200" placeholder="Rich-text editor posts HTML" bind:value={edit.comment} disabled={readonly} />{/snippet}
            </Field>
          </div>
        {:else if active === 'inspection'}
          <div class="wp-pr-panel">
            <Switch bind:checked={edit.inspectionOff} id={id('inspectionOff')} disabled={readonly}
              label={PATH_INSPECTION_OFF.label} hint={PATH_INSPECTION_OFF.description} />
            {#if edit.inspectionOff}
              <Alert tone="warning" compact>{PATH_INSPECTION_OFF_ALERT} Detection tuning has no effect while inspection is off.</Alert>
            {/if}
            <PathEngineSwitches rule={edit} {policy} {readonly} />
            <h4 class="wp-subhead">Detection tuning</h4>
            <p class="wp-note">Log only for this path, or skip engines for every request on it. The choices above are the clearer way to turn one engine off. Skipping every engine turns inspection off for this path.</p>
            {#if err('tuning')}<Alert tone="error" compact>{err('tuning')}</Alert>{/if}
            {#if !edit.inspectionOff && tuningSkipsAll(edit.tuning)}<Alert tone="warning" compact>{PATH_INSPECTION_OFF_ALERT}</Alert>{/if}
            <PathTuningSection bind:tuning={edit.tuning} disabled={edit.inspectionOff || readonly} />
          </div>
        {:else if active === 'sensitivity'}
          <div class="wp-pr-panel">
            <p class="wp-note">Most paths do not need this. Policy keeps the level the policy sets; Relaxed, Balanced or Strict gives the engine its own level on this path, and it stays on. To turn an engine off, or to set it to Block or Log only for this path, use the choices on the Inspection tab. The numbers behind the levels are under Evidence values (advanced), below the table.</p>
            {#if edit.inspectionOff}<Alert tone="info" compact>Inspection is off for this path, so these levels have no effect.</Alert>{/if}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div class="wp-table-wrap" role="region" aria-label="Engine sensitivity on this path" tabindex="0">
              <table class="wp-table">
                <thead><tr><th scope="col">Engine</th><th scope="col">Sensitivity on this path</th></tr></thead>
                <tbody>
                  {#each SENSITIVITY_ENGINES as meta (meta.key)}
                    {@const ov = edit.semanticOverride[meta.key]}
                    {@const choice = pathSensitivityOf(edit, meta)}
                    {@const g = policy.semantic[meta.key]}
                    {@const policyLevel = sensitivityLevelOf(meta, g.block, g.soft)}
                    <tr class:is-off={choice === 'policy'}>
                      <th scope="row">
                        {meta.label}
                        {#if ov?.action}<span class="wp-pr-held">This path sets {actionLabel(ov.action)}, so it keeps its own level.</span>{/if}
                      </th>
                      <td>
                        {#if ov?.disabled}
                          <span class="wp-muted">Off on this path.</span>
                        {:else}
                          <SegmentedRadio
                            equal
                            label="{meta.label} sensitivity on this path"
                            options={PATH_LEVELS.map((o) => (o.value === 'policy' && ov?.action ? { ...o, disabled: true, title: 'This path sets what the engine does, so it keeps its own level.' } : o))}
                            bind:value={() => choice, (chosen) => setPathSensitivity(edit, policy, meta, chosen)}
                            disabled={readonly || edit.inspectionOff}
                          />
                          {#if choice === 'policy'}<span class="wp-pr-held">Policy: {policyLevel === 'custom' ? `block ${g.block ?? meta.defaultBlock}, soft ${g.soft ?? meta.defaultSoft}` : SENSITIVITY_LEVELS.find((l) => l.value === policyLevel)?.label}{g.enabled ? '' : ' (engine off)'}</span>
                          {:else if choice === 'custom' && ov}<span class="wp-pr-held">Custom: block {ov.block ?? meta.defaultBlock}, soft {ov.soft ?? meta.defaultSoft}</span>{/if}
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <button type="button" class="wp-disclosure" aria-expanded={valuesOpen || valueErrors} aria-controls={id('evidence')} onclick={() => (valuesOpen = !valuesOpen)}>
              <span class="wp-chevron" aria-hidden="true"><Icon data={chevronRight} scale={0.75} /></span>
              Evidence values (advanced)
            </button>
            <div id={id('evidence')} class="wp-pr-evidence" hidden={!(valuesOpen || valueErrors)}>
              <p class="wp-note">The numbers behind each level. An engine on Policy shows the policy's numbers; changing one gives the engine its own values on this path. A pair that is none of the three levels shows as Custom.</p>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div class="wp-table-wrap" role="region" aria-label="Evidence values on this path" tabindex="0">
                <table class="wp-table">
                  <thead><tr><th scope="col">Engine</th><th scope="col">Evidence to block</th><th scope="col">Evidence to log</th></tr></thead>
                  <tbody>
                    {#each SENSITIVITY_ENGINES as meta (meta.key)}
                      {@const ov = edit.semanticOverride[meta.key]}
                      {@const g = policy.semantic[meta.key]}
                      <tr class:is-off={ov?.disabled}>
                        <th scope="row">{meta.label}{#if !ov}<span class="wp-pr-held">Policy values</span>{/if}</th>
                        {#if ov?.disabled}
                          <td colspan="2" class="wp-muted">Off on this path.</td>
                        {:else}
                          {#each ['block', 'soft'] as const as prop (prop)}
                            <td>
                              <DecimalInput id={id(`semanticOverride.${meta.key}.${prop}`)} disabled={readonly || edit.inspectionOff}
                                bind:value={() => (ov ? ov[prop] : (g[prop] ?? (prop === 'block' ? meta.defaultBlock : meta.defaultSoft))), (value) => setOwnNumber(meta.key, prop, value)}
                                placeholder={String(prop === 'block' ? meta.defaultBlock : meta.defaultSoft)}
                                aria-label="{meta.label} {prop} value" aria-invalid={err(`semanticOverride.${meta.key}.${prop}`) ? 'true' : undefined} />
                              {#if err(`semanticOverride.${meta.key}.${prop}`)}<span class="wp-cell-error">{err(`semanticOverride.${meta.key}.${prop}`)}</span>{/if}
                            </td>
                          {/each}
                        {/if}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        {:else if active === 'access'}
          <div class="wp-pr-panel">
            <Switch checked={edit.ipRules !== null} id={id('ipRulesEnabled')} disabled={readonly} label="Restrict this path by IP address"
              onchange={(on) => (edit.ipRules = on ? { mode: 'allowlist', ips: '' } : null)} />
            {#if edit.ipRules}
              {@const ip = edit.ipRules}
              <ChoiceGroup legend="Mode" name="wp-pr-ip-mode" bind:value={ip.mode} disabled={readonly} compact
                options={[{ value: 'allowlist', label: 'Only these IPs may access' }, { value: 'blocklist', label: 'These IPs are blocked' }]} />
              <Field label="IP addresses and CIDR ranges" hint="One per line, e.g. 203.0.113.7 or 10.0.0.0/24." error={err('ipRules.ips')} id={id('ipRules.ips')} required>
                {#snippet children(c)}<textarea {...c} class="wp-textarea" rows="4" spellcheck="false" bind:value={ip.ips} disabled={readonly}></textarea>{/snippet}
              </Field>
            {/if}
            <h4 class="wp-subhead">Hard block</h4>
            <Switch checked={edit.block !== null} id={id('blockEnabled')} disabled={readonly} label="Block every request to this path"
              hint="Answered before any engine or the upstream runs."
              onchange={(on) => (edit.block = on ? { status: 403, message: '' } : null)} />
            {#if edit.block}
              {@const hb = edit.block}
              <div class="wp-grid">
                <Field label="Status code" hint="400–599." error={err('block.status')} id={id('block.status')} required>
                  {#snippet children(c)}<input {...c} type="number" min="400" max="599" step="1" bind:value={hb.status} disabled={readonly} />{/snippet}
                </Field>
                <Field label="Reason" hint="Recorded in the logs (up to 200 characters)." error={err('block.message')} id={id('block.message')} optional>
                  {#snippet children(c)}<input {...c} type="text" maxlength="200" bind:value={hb.message} disabled={readonly} />{/snippet}
                </Field>
              </div>
            {/if}
          </div>
        {:else if active === 'limits'}
          <div class="wp-pr-panel">
            <Field label="Body size limit for this path" hint="Overrides the global request body limit, e.g. larger for an upload endpoint. Empty or 0 = use the global limit." error={err('bodySizeLimit')} id={id('bodySizeLimit')} optional>
              {#snippet children(c)}<ByteSizeInput {...c} bind:value={edit.bodySizeLimit} emptyLabel="Global limit" disabled={readonly} />{/snippet}
            </Field>
            <h4 class="wp-subhead">Rate limit</h4>
            <Switch checked={edit.rateLimit !== null} id={id('rateLimitEnabled')} disabled={readonly} label="Rate limit this path per client IP"
              hint="A fixed window for this path only; exceeding it returns 429."
              onchange={(on) => (edit.rateLimit = on ? { maxRequests: 10, windowSec: 60 } : null)} />
            {#if edit.rateLimit}
              {@const rl = edit.rateLimit}
              <div class="wp-grid">
                <Field label="Maximum requests" hint="1–1,000,000." error={err('rateLimit.maxRequests')} id={id('rateLimit.maxRequests')} required>
                  {#snippet children(c)}<input {...c} type="number" min="1" max="1000000" step="1" bind:value={rl.maxRequests} disabled={readonly} />{/snippet}
                </Field>
                <Field label="Window (seconds)" hint="1–86,400." error={err('rateLimit.windowSec')} id={id('rateLimit.windowSec')} required>
                  {#snippet children(c)}<input {...c} type="number" min="1" max="86400" step="1" bind:value={rl.windowSec} disabled={readonly} />{/snippet}
                </Field>
              </div>
            {/if}
          </div>
        {:else if active === 'login'}
          <div class="wp-pr-panel">
            <!-- One switch: on re-enables saved settings (enabled: false from older edits), off drops them. -->
            <Switch checked={!!edit.loginProtection?.enabled} id={id('loginEnabled')} disabled={readonly} label="Protect this path against brute force"
              hint="Counts login attempts per client and locks the client out after too many."
              onchange={(on) => {
                if (!on) edit.loginProtection = null;
                else if (edit.loginProtection) edit.loginProtection.enabled = true;
                else edit.loginProtection = { enabled: true, maxAttempts: 3, windowSec: 60, lockoutSec: 300, byIp: true, byUserAgent: false, identifierField: '', methods: ['POST'] };
              }} />
            {#if edit.loginProtection?.enabled}
              {@const lp = edit.loginProtection}
              <div class="wp-grid-3">
                <Field label="Maximum attempts" error={err('loginProtection.maxAttempts')} id={id('loginProtection.maxAttempts')} required>
                  {#snippet children(c)}<input {...c} type="number" min="1" step="1" bind:value={lp.maxAttempts} disabled={readonly} />{/snippet}
                </Field>
                <Field label="Window (seconds)" error={err('loginProtection.windowSec')} id={id('loginProtection.windowSec')} required>
                  {#snippet children(c)}<input {...c} type="number" min="1" step="1" bind:value={lp.windowSec} disabled={readonly} />{/snippet}
                </Field>
                <Field label="Lockout (seconds)" error={err('loginProtection.lockoutSec')} id={id('loginProtection.lockoutSec')} required>
                  {#snippet children(c)}<input {...c} type="number" min="0" step="1" bind:value={lp.lockoutSec} disabled={readonly} />{/snippet}
                </Field>
              </div>
              <fieldset class="wp-pr-fieldset">
                <legend>Count attempts by</legend>
                <Switch bind:checked={lp.byIp} id={id('loginProtection.byIp')} disabled={readonly} label="Client IP" hint="X-Forwarded-For / X-Real-IP aware; falls back to the connection address." />
                <Switch bind:checked={lp.byUserAgent} id={id('loginProtection.byUserAgent')} disabled={readonly} label="User-Agent" />
                {#if err('loginProtection.byIp')}<Alert tone="error" compact>{err('loginProtection.byIp')}</Alert>{/if}
              </fieldset>
              <Field label="Identifier field" hint="Also count by this field, read from the query string and form, JSON or multipart body, e.g. username or user.email. Attempts without it count against the client IP; page loads (GET without a body or the field) are not counted." id={id('loginProtection.identifierField')} optional>
                {#snippet children(c)}<input {...c} type="text" spellcheck="false" placeholder="username" bind:value={lp.identifierField} disabled={readonly} />{/snippet}
              </Field>
              <fieldset class="wp-pr-fieldset wp-pr-methods">
                <legend>Only for these methods <small>none = all methods</small></legend>
                {#each HTTP_METHODS as method (method)}
                  <label><input type="checkbox" checked={lp.methods.includes(method)} disabled={readonly} onchange={(event) => (lp.methods = toggleMethod(lp.methods, method, (event.currentTarget as HTMLInputElement).checked))} /> {method}</label>
                {/each}
              </fieldset>
            {/if}
          </div>
        {:else if active === 'fields'}
          <div class="wp-pr-panel">
            <h4 class="wp-subhead">Request fields</h4>
            <p class="wp-note">Hide a field in logs, or decrypt or encrypt it on its way to the app (AES-256-GCM).</p>
            <p class="wp-note">Field name: a JSON dot path such as user.email or employees.photo (arrays are covered element by element, at any level). For form and multipart bodies, the name as sent (photos[]) or the same dot path (employees.photo matches employees[0][photo], employees[1][photo] …). Source is matched on the request's Content-Type; bodies of any other type (application/vnd.api+json, text/plain …) are not changed.</p>
            {#each edit.fieldRules as fr, index (index)}
              <div class="wp-pr-card">
                <div class="wp-grid-3">
                  <Field label="Field name" error={err(`fieldRules.${index}.field`)} id={id(`fieldRules.${index}.field`)} required>
                    {#snippet children(c)}<input {...c} type="text" class="wp-mono" spellcheck="false" placeholder="user.password" bind:value={fr.field} disabled={readonly} />{/snippet}
                  </Field>
                  <Field label="Source" id={id(`fieldRules.${index}.source`)}>
                    {#snippet children(c)}
                      <Select {...c} options={sourceOptions(fr.source)} bind:value={fr.source} disabled={readonly} />
                    {/snippet}
                  </Field>
                  <Field label="Action" id={id(`fieldRules.${index}.action`)}>
                    {#snippet children(c)}
                      <Select {...c} options={FIELD_ACTION_OPTIONS} bind:value={fr.action} disabled={readonly} />
                    {/snippet}
                  </Field>
                </div>
                <p class="wp-note">{FIELD_ACTION_HINTS[fr.action]}</p>
                {#if fr.action !== 'mask'}
                  <Field label="AES-256 key" hint="64 hexadecimal characters. Stored in the policy; keep it secret." error={err(`fieldRules.${index}.aesKey`)} id={id(`fieldRules.${index}.aesKey`)} required>
                    {#snippet children(c)}<SecretInput {...c} label="AES key" generate maxlength={64} bind:value={fr.aesKey} disabled={readonly} hidden={aesHidden(fr.aesKey)} />{/snippet}
                  </Field>
                {/if}
                <div class="wp-row-between">
                  <fieldset class="wp-pr-fieldset wp-pr-methods">
                    <legend>Methods <small>none = all</small></legend>
                    {#each HTTP_METHODS as method (method)}
                      <label><input type="checkbox" checked={fr.methods.includes(method)} disabled={readonly} onchange={(event) => (fr.methods = toggleMethod(fr.methods, method, (event.currentTarget as HTMLInputElement).checked))} /> {method}</label>
                    {/each}
                  </fieldset>
                  <Button variant="ghost" size="sm" disabled={readonly} onclick={() => edit.fieldRules.splice(index, 1)}>Remove field rule</Button>
                </div>
              </div>
            {/each}
            <div><Button variant="secondary" size="sm" disabled={readonly} onclick={() => edit.fieldRules.push({ field: '', source: 'any', action: 'mask', aesKey: '', methods: [] })}>Add field rule</Button></div>

            <h4 class="wp-subhead">Response decryption</h4>
            <p class="wp-note">For data an “Encrypt before forwarding” field rule stored encrypted: the WAF decrypts it in the response so the client sees plain text. Paste that rule's key; a new key cannot decrypt anything.</p>
            <Field label="Whole response body (one encrypted value)" hint="For a response that is nothing but one stored encrypted value, e.g. an image endpoint such as /photo. The WAF decrypts the whole body and sets Content-Type from the result (image/jpeg …). Any other response, such as normal JSON, is sent unchanged. 64 hex characters; empty = off." error={err('responseDecryptAes')} id={id('responseDecryptAes')} optional>
              {#snippet children(c)}<SecretInput {...c} label="response decryption key" maxlength={64} bind:value={edit.responseDecryptAes} disabled={readonly} hidden={aesHidden(edit.responseDecryptAes)} />{/snippet}
            </Field>
            <h5 class="wp-pr-minorhead">Fields of a JSON response</h5>
            <p class="wp-note">Only for responses with Content-Type application/json. Each listed field that holds an encrypted value is replaced by its plain text; other fields stay as they are. Dot paths such as data.user.secret also cover every element of arrays.</p>
            {#each edit.responseFieldRules as rfr, index (index)}
              <div class="wp-pr-card wp-grid">
                <Field label="Field path" error={err(`responseFieldRules.${index}.field`)} id={id(`responseFieldRules.${index}.field`)} required>
                  {#snippet children(c)}<input {...c} type="text" class="wp-mono" spellcheck="false" placeholder="data.user.secret" bind:value={rfr.field} disabled={readonly} />{/snippet}
                </Field>
                <Field label="AES-256 key" error={err(`responseFieldRules.${index}.aesKey`)} id={id(`responseFieldRules.${index}.aesKey`)} required>
                  {#snippet children(c)}<SecretInput {...c} label="AES key" maxlength={64} bind:value={rfr.aesKey} disabled={readonly} hidden={aesHidden(rfr.aesKey)} />{/snippet}
                </Field>
                <div class="wp-span-2"><Button variant="ghost" size="sm" disabled={readonly} onclick={() => edit.responseFieldRules.splice(index, 1)}>Remove response field</Button></div>
              </div>
            {/each}
            <div><Button variant="secondary" size="sm" disabled={readonly} onclick={() => edit.responseFieldRules.push({ field: '', aesKey: '' })}>Add response field</Button></div>
          </div>
        {/if}
      {/snippet}
    </Tabs>
  </div>

  {#snippet footer()}
    {#if attempted && issues.length}<p class="wp-pr-footnote" role="alert">{issues.length} {issues.length === 1 ? 'problem' : 'problems'} to fix before applying.</p>{/if}
    <Button variant="secondary" onclick={() => modal?.requestClose('close-button')}>Cancel</Button>
    {#if !readonly}<Button onclick={apply}>{isNew ? 'Add rule path' : 'Apply changes'}</Button>{/if}
  {/snippet}
</Modal>

<style>
  .wp-pr { min-width: 0; }
  .wp-pr-panel { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
  .wp-pr-panel :global(.wp-subhead) { margin: var(--sp-2) 0 0; }
  .wp-pr-evidence { display: flex; flex-direction: column; gap: var(--sp-3); }
  .wp-pr-evidence[hidden] { display: none; }
  .wp-pr-held { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
  .wp-pr-path { display: grid; grid-template-columns: minmax(0, 2fr) minmax(10rem, 1fr); gap: var(--sp-4); }
  @media (max-width: 720px) { .wp-pr-path { grid-template-columns: minmax(0, 1fr); } }
  .wp-pr-card { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
  .wp-pr-card.wp-grid { display: grid; }
  .wp-pr-fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .wp-pr-fieldset legend { padding: 0; margin-bottom: var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .wp-pr-fieldset legend small { font-weight: 400; color: var(--text-muted); margin-left: var(--sp-1); }
  .wp-pr-methods { flex-direction: row; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
  .wp-pr-methods legend { width: 100%; }
  .wp-pr-methods label { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-primary); }
  .wp-pr-methods input { accent-color: var(--accent); }
  .wp-pr-minorhead { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-primary); }
  .wp-pr-footnote { margin: 0 auto 0 0; align-self: center; font-size: var(--fs-sm); color: var(--danger); }
</style>
