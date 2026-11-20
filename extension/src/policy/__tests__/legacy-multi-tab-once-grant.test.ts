// A two-tab "Allow once" for model:prompt stored before per-backend allows
// existed keeps its per-tab limit: tabs 3 and 4 are covered, tab 5 isn't.
import { afterEach, expect, it } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import * as permissions from '../permissions';
import { lookupOriginGrant } from '../origin-grants';
import { withBackendAllow } from '../backend-grant';

const O = 'https://site.example';
afterEach(() => resetMockBrowser());

function storeLegacy(now: number) {
  return chrome.storage.local.set({ harbor_origin_permissions: { [O]: { origin: O, allowedTools: [], scopes: {
    'model:prompt': { grant: 'granted-once', grantedAt: now, expiresAt: now + 600_000, tabs: { '3': now + 600_000, '4': now + 600_000 } },
  } } } });
}

it('covers only the tabs that allowed it', async () => {
  const now = Date.now();
  await storeLegacy(now);
  expect((await permissions.getPermissionStatus(O, 3)).scopes['model:prompt']).toBe('granted-once');
  expect((await permissions.getPermissionStatus(O, 5)).scopes['model:prompt']).toBe('not-granted');
  expect((await lookupOriginGrant(O, 'model.prompt.local', undefined, 5))?.effect).not.toBe('allow');
});

it('keeps its tabs when migrated into the per-backend map', () => {
  const now = Date.now();
  const legacy = { grant: 'granted-once' as const, grantedAt: now, expiresAt: now + 600_000, tabs: { '3': now + 600_000, '4': now + 600_000 } };
  const next = withBackendAllow(legacy, 'model:prompt', 'acp:goose', 'granted-once', now, { expiresAt: now + 600_000, tabId: 7 });
  expect(next.allows?.builtin?.tabs).toEqual(legacy.tabs);
});
