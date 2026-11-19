/**
 * A page's own giving-up — its client-side request timeout firing, or its
 * tab/port closing (page-api/background.ts aborts `ctx.signal` either way)
 * — must never still result in a grant landing after the fact
 * item 7). `requestPermissions`/`showPermissionPrompt` take that signal and
 * either close the now-unwatched popup, or just drop this caller's own
 * place in line, without ever calling `grantPermissions` for a call whose
 * own signal already fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

type PermissionsModule = typeof import('../permissions');
let requestPermissions: PermissionsModule['requestPermissions'];
let showPermissionPrompt: PermissionsModule['showPermissionPrompt'];
let handlePermissionPromptResponse: PermissionsModule['handlePermissionPromptResponse'];
let getPermissionStatus: PermissionsModule['getPermissionStatus'];

const ORIGIN = 'https://example.test';

beforeEach(async () => {
  resetMockBrowser();
  vi.resetModules();
  ({ requestPermissions, showPermissionPrompt, handlePermissionPromptResponse, getPermissionStatus } =
    await import('../permissions'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a page giving up while its own prompt is open', () => {
  it('closes the popup when it was the only caller waiting on it', async () => {
    const create = vi.spyOn(chrome.windows, 'create').mockResolvedValue({ id: 42 } as never);
    const remove = vi.spyOn(chrome.windows, 'remove').mockResolvedValue(undefined as never);
    const controller = new AbortController();

    const result = showPermissionPrompt(ORIGIN, ['model:prompt'], undefined, undefined, undefined, controller.signal);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    controller.abort();

    await expect(result).resolves.toEqual({ granted: false });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(42));
  });

  it('never grants, even if a response somehow still arrives after the page gave up', async () => {
    vi.spyOn(chrome.windows, 'create').mockResolvedValue({ id: 42 } as never);
    vi.spyOn(chrome.windows, 'remove').mockResolvedValue(undefined as never);
    const controller = new AbortController();

    const result = requestPermissions(ORIGIN, { scopes: ['model:prompt'] }, undefined, controller.signal);
    controller.abort();
    await expect(result).resolves.toMatchObject({ granted: false });

    // A stray response (a slow click that lands after the popup this
    // module already closed) must not grant anything either — there's
    // nobody left registered to hear it.
    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always' });

    const status = await getPermissionStatus(ORIGIN);
    expect(status.scopes['model:prompt']).toBe('not-granted');
  });

  it("does not disturb a second, still-live caller for the same origin merged into the same prompt", async () => {
    const create = vi.spyOn(chrome.windows, 'create').mockResolvedValue({ id: 42 } as never);
    const remove = vi.spyOn(chrome.windows, 'remove');
    vi.spyOn(chrome.windows, 'get').mockResolvedValue({ id: 42, tabs: [{ id: 9 }] } as never);
    vi.spyOn(chrome.tabs, 'update').mockResolvedValue(undefined as never);

    // The first caller never gives up (no signal) — it's the one still
    // waiting throughout. Registering it is deterministic by the time
    // `create` has been called: `showPermissionPrompt`'s "no existing
    // prompt" branch registers the resolver as the first statement inside
    // the same Promise constructor that calls `windows.create`, so waiting
    // for `create` guarantees this registration already happened.
    const first = showPermissionPrompt(ORIGIN, ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    // A second caller for the same origin merges into the same popup
    // (permissions.ts's own "reuse" behavior) and then gives up.
    const givingUp = new AbortController();
    const second = showPermissionPrompt(ORIGIN, ['model:tools'], undefined, undefined, undefined, givingUp.signal);
    givingUp.abort();

    await expect(second).resolves.toEqual({ granted: false });

    // The shared popup stays open — the first caller never gave up, so
    // there's still someone for its eventual answer to reach.
    expect(remove).not.toHaveBeenCalled();
    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always' });
    await expect(first).resolves.toMatchObject({ granted: true, grantType: 'granted-always' });
  });
});
