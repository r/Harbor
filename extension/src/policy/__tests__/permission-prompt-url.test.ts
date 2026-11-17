/**
 * The permission prompt opens the page the build ships
 * (dist-<browser>/permission-prompt.html), and its answer reaches the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePermissionPromptResponse, showPermissionPrompt } from '../permissions';

describe('showPermissionPrompt', () => {
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
});
