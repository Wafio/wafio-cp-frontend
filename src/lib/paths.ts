/**
 * Wrapper for SvelteKit navigation that automatically prepends paths.base.
 * Use `goto` and `base` from this module instead of $app/navigation / $app/paths.
 */
import { goto as svelteGoto } from '$app/navigation';
import { resolve } from '$app/paths';

/** paths.base: '' or '/prefix'. `$app/paths` no longer exports it. */
export const base = resolve('').slice(0, -1);

export function goto(href: string, opts?: Parameters<typeof svelteGoto>[1]): ReturnType<typeof svelteGoto> {
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return svelteGoto(href, opts);
  }
  return svelteGoto(base + href, opts);
}
