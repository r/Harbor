/**
 * Cross-origin agent grants are kept per target site. Each site's grant has
 * its own duration, and the prompt grants only the sites it showed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockStorage, resetMockBrowser } from '../../__tests__/test-setup';

type PermissionsModule = typeof import('../permissions');
type OriginGrantsModule = typeof import('../origin-grants');
let permissions: PermissionsModule;
let lookupOriginGrant: OriginGrantsModule['lookupOriginGrant'];

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';

async function allowed(target: string, tabId = 3): Promise<boolean> {
  const outcome = await lookupOriginGrant(A, 'agent.delegate.crossOrigin', { agentOrigin: target }, tabId);
  return outcome?.effect === 'allow';
}

beforeEach(async () => {
  resetMockBrowser();
  vi.resetModules();
  permissions = await import('../permissions');
  ({ lookupOriginGrant } = await import('../origin-grants'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('per-site grants', () => {
  it('allows only the granted site', async () => {
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-always', 3, undefined, [B]);

    expect(await allowed(B)).toBe(true);
    expect(await allowed(C)).toBe(false);
  });

  it('ignores an old site-wide agents:crossOrigin grant', async () => {
    // The shape older Harbor builds stored: one grant for every other site.
    getMockStorage().local.data['harbor_origin_permissions'] = {
      [A]: {
        origin: A,
        scopes: { 'agents:crossOrigin': { grant: 'granted-always', grantedAt: 1 } },
        allowedTools: [],
      },
    };

    expect(await allowed(B)).toBe(false);
    expect((await permissions.getPermissionStatus(A, 3)).scopes['agents:crossOrigin']).toBe('not-granted');
  });

  it('keeps a denied site refused and out of the reachable sites', async () => {
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-always', 3, undefined, [C]);
    await permissions.denyPermissions(A, ['agents:crossOrigin'], [B]);

    const outcome = await lookupOriginGrant(A, 'agent.delegate.crossOrigin', { agentOrigin: B }, 3);
    expect(outcome?.effect).toBe('deny');
    expect((await permissions.getPermissionStatus(A, 3)).agentOrigins).toEqual([C]);
    expect(await permissions.isAgentOriginAllowed(A, B, 3)).toBe(false);
  });

  it('keeps "allow once" for every tab that answered, not only the last', async () => {
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 3, undefined, [B]);
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 4, undefined, [B]);

    expect(await allowed(B, 3)).toBe(true);
    expect(await allowed(B, 4)).toBe(true);
    expect(await allowed(B, 5)).toBe(false);
  });

  it('keeps "allow once" for every tab that answered, for other scopes too', async () => {
    await permissions.grantPermissions(A, ['model:prompt'], 'granted-once', 3);
    await permissions.grantPermissions(A, ['model:prompt'], 'granted-once', 4);

    expect((await permissions.getPermissionStatus(A, 3)).scopes['model:prompt']).toBe('granted-once');
    expect((await permissions.getPermissionStatus(A, 4)).scopes['model:prompt']).toBe('granted-once');
    expect((await permissions.getPermissionStatus(A, 5)).scopes['model:prompt']).toBe('not-granted');
  });

  it('keeps "allow once" for both tabs when they are granted at the same moment', async () => {
    // One prompt answered for two waiting tabs resolves both callers together.
    await Promise.all([
      permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 3, undefined, [B]),
      permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 4, undefined, [B]),
    ]);

    expect(await allowed(B, 3)).toBe(true);
    expect(await allowed(B, 4)).toBe(true);
  });

  it('lets each tab\'s "allow once" run out on its own clock', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 3, undefined, [B]);
    vi.setSystemTime(1_000_000 + 5 * 60 * 1000);
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 4, undefined, [B]);
    vi.setSystemTime(1_000_000 + 11 * 60 * 1000);

    expect(await allowed(B, 3)).toBe(false);
    expect(await allowed(B, 4)).toBe(true);
  });

  it('does not renew an earlier "allow once" for every tab when one tab asks again', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    // A grant with no tab covers every tab.
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', undefined, undefined, [B]);
    vi.setSystemTime(1_000_000 + 5 * 60 * 1000);
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 4, undefined, [B]);
    vi.setSystemTime(1_000_000 + 11 * 60 * 1000);

    expect(await allowed(B, 4)).toBe(true);
    expect(await allowed(B, 7)).toBe(false);
  });

  it('lists a site whose only entry is a denied site', async () => {
    await permissions.denyPermissions(A, ['agents:crossOrigin'], [B]);

    const listed = (await permissions.listAllPermissions()).find((p) => p.origin === A);
    expect(listed?.deniedAgentOrigins).toEqual([B]);
  });

  it('lists denied sites for the sidebar', async () => {
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-always', 3, undefined, [C]);
    await permissions.denyPermissions(A, ['agents:crossOrigin'], [B]);

    const listed = (await permissions.listAllPermissions()).find((p) => p.origin === A);
    expect(listed?.agentOrigins).toEqual([C]);
    expect(listed?.deniedAgentOrigins).toEqual([B]);
  });

  it('allows nothing without a target site', async () => {
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-always', 3, undefined, [B]);

    const outcome = await lookupOriginGrant(A, 'agent.delegate.crossOrigin', undefined, 3);
    expect(outcome?.effect).not.toBe('allow');
  });

  it('lets an expired "allow once" lapse even when another site is allowed later', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 3, undefined, [B]);
    vi.setSystemTime(1_000_000 + 11 * 60 * 1000);
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 3, undefined, [C]);

    expect(await allowed(C)).toBe(true);
    expect(await allowed(B)).toBe(false);
  });

  it('keeps "allow once" to the tab that granted it', async () => {
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-once', 3, undefined, [B]);

    expect(await allowed(B, 3)).toBe(true);
    expect(await allowed(B, 4)).toBe(false);
  });

  it('reports the allowed sites in the status, and shows the scope as granted', async () => {
    await permissions.grantPermissions(A, ['agents:crossOrigin'], 'granted-always', 3, undefined, [B]);

    const status = await permissions.getPermissionStatus(A, 3);
    expect(status.agentOrigins).toEqual([B]);
    expect(status.scopes['agents:crossOrigin']).toBe('granted-always');
    const listed = (await permissions.listAllPermissions()).find((p) => p.origin === A);
    expect(listed?.agentOrigins).toEqual([B]);
  });
});

describe('the prompt grants only the sites it showed', () => {
  it('merges a second site into an open prompt and lists both', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const update = vi.spyOn(chrome.tabs, 'update');
    vi.spyOn(chrome.windows, 'get').mockResolvedValue({ id: 1, tabs: [{ id: 9 }] } as never);

    const first = permissions.showPermissionPrompt(A, ['agents:crossOrigin'], undefined, undefined, undefined, [B]);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(new URL((create.mock.calls[0]![0] as { url: string }).url).searchParams.get('agentOrigins')).toBe(B);

    const second = permissions.showPermissionPrompt(A, ['agents:crossOrigin'], undefined, undefined, undefined, [C]);
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(new URL((update.mock.calls[0]![1] as { url: string }).url).searchParams.get('agentOrigins')).toBe(`${B},${C}`);

    permissions.handlePermissionPromptResponse({ granted: true, grantType: 'granted-once', agentOrigins: [B, C] });
    expect((await first).agentOrigins).toEqual([B, C]);
    expect((await second).agentOrigins).toEqual([B, C]);
  });

  it('drops a site the prompt page did not show', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const result = permissions.showPermissionPrompt(A, ['agents:crossOrigin'], undefined, undefined, undefined, [B]);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    // The page answers for B and for a site it was never asked about.
    permissions.handlePermissionPromptResponse({ granted: true, grantType: 'granted-once', agentOrigins: [B, C] });
    expect((await result).agentOrigins).toEqual([B]);
  });

  it('grants no site when the page answers without listing any', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const result = permissions.showPermissionPrompt(A, ['agents:crossOrigin'], undefined, undefined, undefined, [B]);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    permissions.handlePermissionPromptResponse({ granted: true, grantType: 'granted-once' });
    expect((await result).agentOrigins ?? []).toEqual([]);
  });
});

describe('requestPermissions', () => {
  it('reports granted when sites come without agents:crossOrigin and the scopes are allowed', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const pending = permissions.requestPermissions(A, { scopes: ['model:prompt'], agentOrigins: [B] }, 3);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    permissions.handlePermissionPromptResponse({ granted: true, grantType: 'granted-once' });

    const result = await pending;
    expect(result.granted).toBe(true);
    expect(result.agentOrigins).toEqual([]);
  });

  it('grants each request only the sites it asked about, even from a merged prompt', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const first = permissions.requestPermissions(A, { scopes: ['agents:crossOrigin'], agentOrigins: [B] }, 3);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const second = permissions.requestPermissions(A, { scopes: ['agents:crossOrigin'], agentOrigins: [C] }, 4);
    await new Promise((r) => setTimeout(r, 0));
    permissions.handlePermissionPromptResponse({ granted: true, grantType: 'granted-once', agentOrigins: [B, C] });
    await Promise.all([first, second]);

    expect(await allowed(B, 3)).toBe(true);
    expect(await allowed(C, 3)).toBe(false);
    expect(await allowed(C, 4)).toBe(true);
    expect(await allowed(B, 4)).toBe(false);
  });
});
