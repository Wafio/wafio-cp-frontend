export function configChanges(before: unknown, after: unknown, path = ''): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => configChanges(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [{ path: path || '(root)', before, after }];
}

// Pre-save previews must not echo credentials, templates, or request values.
export function previewConfigChanges(before: unknown, after: unknown) {
  const display = (value: unknown): string => value === undefined ? '(absent)' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '(value hidden)';
  return configChanges(before, after).map(change => ({ path: change.path, before: display(change.before), after: display(change.after) }));
}
