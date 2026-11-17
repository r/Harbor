/**
 * The permission prompt opens the page the build ships
 * (dist-<browser>/permission-prompt.html), and its answer reaches the caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// permissions.ts keeps the open prompt in module state and registers its
// window-closed listener at import, so each test gets a fresh module.
type PermissionsModule = typeof import('../permissions');
let showPermissionPrompt: PermissionsModule['showPermissionPrompt'];
let handlePermissionPromptResponse: PermissionsModule['handlePermissionPromptResponse'];
let windowClosed: ((windowId: number) => void) | undefined;

describe('showPermissionPrompt', () => {
  beforeEach(async () => {
    windowClosed = undefined;
    vi.spyOn(chrome.windows.onRemoved, 'addListener').mockImplementation((listener) => {
      windowClosed = listener as (windowId: number) => void;
    });
    vi.resetModules();
    ({ showPermissionPrompt, handlePermissionPromptResponse } = await import('../permissions'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens permission-prompt.html at the extension root', async () => {
    const create = vi.spyOn(chrome.windows, 'create');

    const result = showPermissionPrompt('https://site.example', ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    const url = new URL((create.mock.calls[0][0] as { url: string }).url);
    expect(url.pathname).toBe('/permission-prompt.html');
    expect(url.searchParams.get('origin')).toBe('https://site.example');
    expect(url.searchParams.get('scopes')).toBe('model:prompt');

    handlePermissionPromptResponse({ granted: true, grantType: 'granted-once' });
    await expect(result).resolves.toEqual({ granted: true, grantType: 'granted-once' });
  });

  it('refuses the call when the user clicks Deny', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const result = showPermissionPrompt('https://site.example', ['mcp:tools.call']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    handlePermissionPromptResponse({ granted: false, explicitDeny: true });
    await expect(result).resolves.toEqual({ granted: false, explicitDeny: true });
  });

  it('refuses the call when the user closes the prompt window', async () => {
    const create = vi
      .spyOn(chrome.windows, 'create')
      .mockImplementation((() => Promise.resolve({ id: 42 })) as never);
    let settled = false;
    const result = showPermissionPrompt('https://site.example', ['mcp:tools.call']);
    void result.then(() => { settled = true; });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await Promise.resolve();

    expect(windowClosed).toBeDefined();
    windowClosed!(7); // some other window closing leaves the prompt pending
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    windowClosed!(42);
    await expect(result).resolves.toEqual({ granted: false });
  });
});
