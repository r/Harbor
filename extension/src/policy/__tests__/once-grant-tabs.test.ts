/**
 * "Allow once" from several tabs of one site, for a site-wide scope such as
 * agents:invoke. Each tab keeps its own grant and its own ten minutes, and
 * the grant store (checkPermissions) and the policy engine's lookup
 * (lookupOriginGrant) give the same answer for every tab.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

type PermissionsModule = typeof import('../permissions');
type OriginGrantsModule = typeof import('../origin-grants');
let permissions: PermissionsModule;
let lookupOriginGrant: OriginGrantsModule['lookupOriginGrant'];

const SITE = 'https://site.example';
const START = 1_000_000;
const MINUTE = 60 * 1000;

/** [the grant store's answer, the policy engine's answer] for this tab. */
async function allowedIn(tabId: number): Promise<[boolean, boolean]> {
  const store = (await permissions.checkPermissions(SITE, ['agents:invoke'], tabId)).granted;
  const engine = (await lookupOriginGrant(SITE, 'agent.invoke', undefined, tabId))?.effect === 'allow';
  return [store, engine];
}

beforeEach(async () => {
  resetMockBrowser();
  vi.resetModules();
  vi.useFakeTimers({ now: START });
  permissions = await import('../permissions');
  ({ lookupOriginGrant } = await import('../origin-grants'));
});

afterEach(() => {
  vi.useRealTimers();
});

it("a second tab's Allow once leaves the first tab's in place", async () => {
  await permissions.grantPermissions(SITE, ['agents:invoke'], 'granted-once', 3);
  vi.setSystemTime(START + 5 * MINUTE);
  await permissions.grantPermissions(SITE, ['agents:invoke'], 'granted-once', 4);

  expect(await allowedIn(3)).toEqual([true, true]);
  expect(await allowedIn(4)).toEqual([true, true]);
  expect(await allowedIn(5)).toEqual([false, false]);
});

it("each tab's Allow once runs out on its own clock", async () => {
  await permissions.grantPermissions(SITE, ['agents:invoke'], 'granted-once', 3);
  vi.setSystemTime(START + 5 * MINUTE);
  await permissions.grantPermissions(SITE, ['agents:invoke'], 'granted-once', 4);
  vi.setSystemTime(START + 11 * MINUTE);

  expect(await allowedIn(3)).toEqual([false, false]);
  expect(await allowedIn(4)).toEqual([true, true]);
});

it("revoking the site clears every tab's Allow once", async () => {
  await permissions.grantPermissions(SITE, ['agents:invoke'], 'granted-once', 3);
  await permissions.grantPermissions(SITE, ['agents:invoke'], 'granted-once', 4);
  await permissions.revokePermissions(SITE);

  expect(await allowedIn(3)).toEqual([false, false]);
  expect(await allowedIn(4)).toEqual([false, false]);
});
