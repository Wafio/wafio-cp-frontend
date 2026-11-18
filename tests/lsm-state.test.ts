// The BPF-LSM state the host agent reports in its trace status (lib/trace-status.ts),
// its tone (lib/tone.ts) and the BPF LSM line of the host page (hosts/host-info.ts).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TraceStatus } from '../src/lib/api';
import { lsmStateTone } from '../src/lib/tone';
import { lsmReport } from '../src/lib/trace-status';
import { bpfLsmDisplay } from '../src/routes/projects/[id]/hosts/host-info';

const st = (extra: Partial<TraceStatus>): TraceStatus => ({ running: true, ...extra }) as TraceStatus;
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('lsmStateTone', () => {
  test('every reported state has a tone, none is a verdict colour', () => {
    expect(lsmStateTone('active')).toBe('info');
    expect(lsmStateTone('kernel_lacks_bpf')).toBe('warning');
    expect(lsmStateTone('unverified')).toBe('warning');
    expect(lsmStateTone('disabled')).toBe('neutral');
    expect(lsmStateTone('failed')).toBe('danger');
  });

  test('an unknown or missing state is neutral', () => {
    for (const v of ['', 'something_new', null, undefined]) expect(lsmStateTone(v)).toBe('neutral');
  });
});

describe('lsmReport', () => {
  test('an agent without the field reports nothing', () => {
    expect(lsmReport(null)).toBeNull();
    expect(lsmReport(undefined)).toBeNull();
    expect(lsmReport(st({}))).toBeNull();
    expect(lsmReport(st({ lsm_state: '' }))).toBeNull();
    expect(lsmReport(st({ lsm_state: '  ' }))).toBeNull();
  });

  test('lsm_active alone says nothing: it is false while tracing is stopped', () => {
    expect(lsmReport(st({ lsm_active: false }))).toBeNull();
    expect(lsmReport(st({ lsm_active: true }))).toBeNull();
  });

  test('active: no alert text to act on', () => {
    const r = lsmReport(st({ lsm_active: true, lsm_state: 'active' }));
    expect(r?.state).toBe('active');
    expect(r?.label).toBe('Active');
    expect(r?.tone).toBe('info');
    expect(r?.alert).toBe('info');
    expect(r?.meaning).toContain('denies connections to that address');
    expect(r?.action).toBeNull();
  });

  test('kernel_lacks_bpf: block policies cannot deny, and the boot parameter', () => {
    const r = lsmReport(st({ lsm_active: false, lsm_state: 'kernel_lacks_bpf' }));
    expect(r?.label).toBe('Kernel lacks BPF-LSM');
    expect(r?.tone).toBe('warning');
    expect(r?.alert).toBe('warning');
    expect(r?.meaning).toContain('does not run BPF-LSM programs');
    expect(r?.meaning).toContain('Block policies cannot deny');
    expect(r?.action).toContain('lsm=...,bpf');
  });

  test('unverified: the kernel list could not be read', () => {
    const r = lsmReport(st({ lsm_active: true, lsm_state: 'unverified' }));
    expect(r?.label).toBe('Unverified');
    expect(r?.tone).toBe('warning');
    expect(r?.meaning).toContain('could not read');
    expect(r?.meaning).toContain('attached its BPF-LSM programs');
    expect(r?.action).toContain('/sys/kernel/security/lsm');
  });

  test('disabled: started with LSM off', () => {
    const r = lsmReport(st({ lsm_active: false, lsm_state: 'disabled' }));
    expect(r?.label).toBe('Disabled');
    expect(r?.tone).toBe('neutral');
    expect(r?.alert).toBe('info');
    expect(r?.meaning).toContain('--lsm=false');
    expect(r?.action).toContain('without --lsm=false');
  });

  test('failed: the agent log has the error', () => {
    const r = lsmReport(st({ lsm_active: false, lsm_state: 'failed' }));
    expect(r?.label).toBe('Failed');
    expect(r?.tone).toBe('danger');
    expect(r?.alert).toBe('error');
    expect(r?.meaning).toContain('could not load or attach');
    expect(r?.action).toContain('agent log');
  });

  test('the state is matched without case or surrounding space', () => {
    expect(lsmReport(st({ lsm_state: ' Kernel_Lacks_BPF ' }))?.state).toBe('kernel_lacks_bpf');
  });

  test('a state this dashboard does not know is shown as sent, neutral', () => {
    const r = lsmReport(st({ lsm_state: 'quarantined' }));
    expect(r?.state).toBe('quarantined');
    expect(r?.label).toBe('quarantined');
    expect(r?.tone).toBe('neutral');
    expect(r?.meaning).toContain('"quarantined"');
    expect(r?.action).toContain('agent log');
  });

  test('object property names are not states', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const r = lsmReport(st({ lsm_state: name }));
      expect(r?.tone).toBe('neutral');
      expect(r?.meaning).toContain('does not know');
    }
  });

  test('every state names itself in text, so colour is never the only signal', () => {
    for (const state of ['active', 'kernel_lacks_bpf', 'unverified', 'disabled', 'failed']) {
      const r = lsmReport(st({ lsm_state: state }));
      expect(r?.label.length).toBeGreaterThan(0);
      expect(r?.meaning.length).toBeGreaterThan(0);
      expect(`${r?.label}${r?.meaning}${r?.action ?? ''}`).not.toContain('—');
    }
  });
});

describe('bpfLsmDisplay', () => {
  test('an agent that does not report the state keeps the inventory display', () => {
    expect(bpfLsmDisplay(st({}), { bpf_lsm: true })).toEqual({ source: 'inventory', tone: 'info', label: 'Active', hint: null, meaning: null, action: null });
    expect(bpfLsmDisplay(null, { bpf_lsm_enabled: 'disabled' })).toEqual({
      source: 'inventory',
      tone: 'neutral',
      label: 'Inactive',
      hint: 'kprobe fallback; block policies cannot deny',
      meaning: null,
      action: null,
    });
    expect(bpfLsmDisplay(undefined, {})).toEqual({ source: 'inventory', tone: null, label: 'n/a', hint: null, meaning: null, action: null });
    expect(bpfLsmDisplay(undefined, { bpf_lsm: 'maybe' }).label).toBe('maybe');
  });

  test('lsm_active without lsm_state does not override the inventory', () => {
    const d = bpfLsmDisplay(st({ lsm_active: false }), { bpf_lsm: true });
    expect(d.source).toBe('inventory');
    expect(d.label).toBe('Active');
  });

  test('the agent state beats a host inventory that disagrees', () => {
    const d = bpfLsmDisplay(st({ lsm_active: false, lsm_state: 'kernel_lacks_bpf' }), { bpf_lsm: true });
    expect(d.source).toBe('agent');
    expect(d.label).toBe('Kernel lacks BPF-LSM');
    expect(d.tone).toBe('warning');
    expect(d.hint).toBeNull();
    expect(d.meaning).toContain('Block policies cannot deny');
    expect(d.action).toContain('lsm=...,bpf');
    const active = bpfLsmDisplay(st({ lsm_active: true, lsm_state: 'active' }), { bpf_lsm: false });
    expect(active.source).toBe('agent');
    expect(active.label).toBe('Active');
  });
});

describe('where the state is shown', () => {
  test('the Agent tab of Runtime security reads the trace status', () => {
    const src = read('../src/lib/components/runtime/AgentView.svelte');
    expect(src).toContain('lsmReport(status)');
    expect(src).toContain('<dt>BPF-LSM</dt>');
  });

  test('the BPF LSM card of the host page prefers the agent report', () => {
    const src = read('../src/routes/projects/[id]/hosts/[hostId]/+page.svelte');
    expect(src).toContain('bpfLsmDisplay(rtStatus, info)');
    expect(src).not.toContain('bpfLsmState(info)');
  });
});
