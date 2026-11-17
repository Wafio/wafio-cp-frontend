/**
 * Notice on the Custom rules page: Match & act rules with action `log`
 * or `challenge` no longer stop inspection on updated WAF agents, they
 * record (or challenge) and the request continues through the detection
 * engines; only `allow` and `block` still decide the request on their own.
 *
 * The notice lists the affected rules of the loaded list and can be dismissed
 * per project; the dismissal lives in localStorage and every access is
 * guarded, since storage can be missing or throw (private mode, blocked site
 * data).
 */

export interface ContinueRuleLike {
  id: string;
  name: string;
  mode: string;
  action: string;
  enabled: boolean;
}

/** Actions that stop terminating the request on updated WAF agents. */
export const CONTINUING_ACTIONS: readonly string[] = ['log', 'challenge'];

/** Match & act rules whose action is log or challenge, in list order. */
export function continuingRules<T extends ContinueRuleLike>(rules: readonly T[]): T[] {
  return rules.filter((rule) => rule.mode === 'gui' && CONTINUING_ACTIONS.includes(rule.action));
}

export function continueNoticeKey(projectId: string): string {
  return `wafio:rules:dec5-notice-dismissed:${projectId}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function isContinueNoticeDismissed(projectId: string, storage: StorageLike | null = defaultStorage()): boolean {
  if (!projectId || !storage) return false;
  try {
    return storage.getItem(continueNoticeKey(projectId)) === '1';
  } catch {
    return false;
  }
}

/** Remembers the dismissal; returns false when it could not be stored (the notice still hides for this visit). */
export function dismissContinueNotice(projectId: string, storage: StorageLike | null = defaultStorage()): boolean {
  if (!projectId || !storage) return false;
  try {
    storage.setItem(continueNoticeKey(projectId), '1');
    return true;
  } catch {
    return false;
  }
}
