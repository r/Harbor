/**
 * The permission prompt opens the page the build ships
 * (dist-<browser>/permission-prompt.html), and its answer reaches the caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

const mocks = vi.hoisted(() => ({ bridgeRequest: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({ bridgeRequest: mocks.bridgeRequest }));

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
    // backendTag is always stamped now (item 5, round 4): the background's
    // own record of the backend this prompt was shown for, 'builtin' by
    // default — never the (here, absent) response's own field.
    await expect(result).resolves.toEqual({ granted: true, grantType: 'granted-once', backendTag: 'builtin' });
  });

  it('refuses the call when the user clicks Deny', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const result = showPermissionPrompt('https://site.example', ['mcp:tools.call']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    handlePermissionPromptResponse({ granted: false, explicitDeny: true });
    await expect(result).resolves.toEqual({ granted: false, explicitDeny: true, backendTag: 'builtin' });
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

describe('showPermissionPrompt names the selected ACP agent in the URL', () => {
  beforeEach(async () => {
    resetMockBrowser();
    mocks.bridgeRequest.mockReset();
    vi.resetModules();
    ({ showPermissionPrompt, handlePermissionPromptResponse } = await import('../permissions'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries an "agent" param naming the selected agent', async () => {
    const { writeAgentBackendSetting } = await import('../../page-api/agent-backend-setting');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    mocks.bridgeRequest.mockResolvedValue({ agents: [{ id: 'goose', name: 'goose' }] });

    const create = vi.spyOn(chrome.windows, 'create');
    const result = showPermissionPrompt('https://site.example', ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    const url = new URL((create.mock.calls[0][0] as { url: string }).url);
    expect(url.searchParams.get('agent')).toBe('goose');

    handlePermissionPromptResponse({ granted: true, grantType: 'granted-once' });
    await result;
  });

  it('carries no "agent" param when no ACP agent is selected', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const result = showPermissionPrompt('https://site.example', ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    const url = new URL((create.mock.calls[0][0] as { url: string }).url);
    expect(url.searchParams.has('agent')).toBe(false);

    handlePermissionPromptResponse({ granted: true, grantType: 'granted-once' });
    await result;
  });
});

describe('handlePermissionPromptResponse never trusts the popup\'s own echoed backendTag', () => {
  beforeEach(async () => {
    resetMockBrowser();
    mocks.bridgeRequest.mockReset();
    vi.resetModules();
    ({ showPermissionPrompt, handlePermissionPromptResponse } = await import('../permissions'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grants against the backend recorded when the prompt opened, not a mismatched one the response claims', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const result = showPermissionPrompt('https://site.example', ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    const url = new URL((create.mock.calls[0][0] as { url: string }).url);
    expect(url.searchParams.get('backendTag')).toBe('builtin');

    // A response claiming a backend the prompt never named — whether from
    // a bug in the popup script or something else entirely sending this
    // message — must not be trusted.
    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always', backendTag: 'acp:goose' });
    await expect(result).resolves.toEqual({ granted: true, grantType: 'granted-always', backendTag: 'builtin' });
  });

  it('still stamps the recorded backend even when the response carries no backendTag at all', async () => {
    const { writeAgentBackendSetting } = await import('../../page-api/agent-backend-setting');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    mocks.bridgeRequest.mockResolvedValue({ agents: [{ id: 'goose', name: 'goose' }] });

    const create = vi.spyOn(chrome.windows, 'create');
    const result = showPermissionPrompt('https://site.example', ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always' });
    await expect(result).resolves.toEqual({ granted: true, grantType: 'granted-always', backendTag: 'acp:goose' });
  });

  it('uses the latest recorded backend when a second request for the same origin updates the live prompt before it\'s answered', async () => {
    const create = vi.spyOn(chrome.windows, 'create').mockImplementation((() => Promise.resolve({ id: 1 })) as never);
    vi.spyOn(chrome.windows, 'get').mockResolvedValue({ id: 1, tabs: [{ id: 9 }] } as never);
    const tabsUpdate = vi.spyOn(chrome.tabs, 'update').mockResolvedValue(undefined as never);

    const first = showPermissionPrompt('https://site.example', ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    const { writeAgentBackendSetting } = await import('../../page-api/agent-backend-setting');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    mocks.bridgeRequest.mockResolvedValue({ agents: [{ id: 'goose', name: 'goose' }] });

    const second = showPermissionPrompt('https://site.example', ['model:tools']);
    await vi.waitFor(() => expect(tabsUpdate).toHaveBeenCalled());

    const updatedUrl = new URL((tabsUpdate.mock.calls[0][1] as { url: string }).url);
    expect(updatedUrl.searchParams.get('backendTag')).toBe('acp:goose');

    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always', backendTag: 'builtin' });
    await expect(first).resolves.toMatchObject({ backendTag: 'acp:goose' });
    await expect(second).resolves.toMatchObject({ backendTag: 'acp:goose' });
  });
});
