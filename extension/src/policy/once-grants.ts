/**
 * "Allow once" grants, shared by the grant store (`permissions.ts`) and the
 * policy engine's grant lookup (`origin-grants.ts`) so both read them alike.
 *
 * An "Allow once" lasts ten minutes and covers only the tab that answered.
 * When several tabs answer, each keeps its own ten minutes: `tabs` maps each
 * tab id, or `*` for a grant given without a tab, to when it runs out.
 */

export interface OnceGrantShape {
  grant: string;
  grantedAt?: number;
  expiresAt?: number;
  tabId?: number;
  /** Tab id (or `*` for every tab) to the time that tab's grant runs out. */
  tabs?: Record<string, number>;
}

const EVERY_TAB = '*';

/** Each tab's expiry, including the older single-tab form. */
function tabExpiries(grant: OnceGrantShape): Record<string, number> {
  if (grant.tabs) return grant.tabs;
  return { [grant.tabId === undefined ? EVERY_TAB : String(grant.tabId)]: grant.expiresAt ?? Infinity };
}

/** Whether a 'granted-once' grant is live now for this tab (any tab when none is given). */
export function onceGrantLive(grant: OnceGrantShape, now: number, tabId?: number): boolean {
  const expiries = tabExpiries(grant);
  const live = (key: string) => key in expiries && expiries[key]! >= now;
  if (tabId === undefined) return Object.keys(expiries).some(live);
  return live(String(tabId)) || live(EVERY_TAB);
}

/**
 * A new "Allow once" added to one still live from other tabs: every tab keeps
 * its own expiry, and runs out on its own clock.
 */
export function withEarlierTabs<T extends OnceGrantShape>(previous: T | undefined, next: T, now: number): T {
  if (next.grant !== 'granted-once' || previous?.grant !== 'granted-once') return next;
  const tabs: Record<string, number> = {};
  for (const [tab, expiresAt] of Object.entries(tabExpiries(previous))) {
    if (expiresAt >= now) tabs[tab] = expiresAt;
  }
  if (Object.keys(tabs).length === 0) return next;
  Object.assign(tabs, tabExpiries(next));
  return { ...next, tabId: undefined, tabs, expiresAt: Math.max(...Object.values(tabs)) };
}
