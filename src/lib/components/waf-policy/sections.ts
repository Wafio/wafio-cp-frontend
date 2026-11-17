/**
 * Section index of the WAF policy editor: order, titles (the section
 * components use the same titles) and which sections an application
 * override has that the project defaults do not.
 */
import type { SectionId } from './validate';

export interface PolicySectionMeta {
  id: SectionId;
  title: string;
  /** Only on an application's policy (not on the project defaults). */
  appOnly?: boolean;
}

/** Detection first, integrations last. */
export const POLICY_SECTIONS: readonly PolicySectionMeta[] = [
  { id: 'protection', title: 'Detection' },
  { id: 'access', title: 'Access control' },
  { id: 'rate-limits', title: 'Rate limits' },
  { id: 'bots', title: 'Bot protection' },
  { id: 'ip-reputation', title: 'IP reputation' },
  { id: 'challenge', title: 'Bot challenge' },
  { id: 'uploads', title: 'Uploads and body size' },
  { id: 'ssrf', title: 'SSRF destinations' },
  { id: 'websocket', title: 'WebSocket', appOnly: true },
  { id: 'path-rules', title: 'Rule paths' },
  { id: 'custom-rules', title: 'Custom rules', appOnly: true },
  { id: 'responses', title: 'Custom responses' },
  { id: 'integrations', title: 'SIEM delivery' }
];

export function policySections(options: { app: boolean }): PolicySectionMeta[] {
  return POLICY_SECTIONS.filter((section) => options.app || !section.appOnly);
}

/** DOM id of a section element (PolicySection renders it). */
export function sectionDomId(id: SectionId): string {
  return `wp-section-${id}`;
}

/** Changes and issues grouped by section, in index order (empty groups dropped). */
export function groupBySection<T extends { section: SectionId }>(items: readonly T[]): { section: PolicySectionMeta; items: T[] }[] {
  return POLICY_SECTIONS.map((section) => ({ section, items: items.filter((item) => item.section === section.id) })).filter(
    (group) => group.items.length > 0
  );
}
