/**
 * Harbor no longer accepts any message or connection from another
 * extension: it registers no `onMessageExternal` or `onConnectExternal`
 * listener at all. A still-installed, separate extension (such as the old
 * Web Agents API) that tries to reach Harbor this way gets nothing —
 * `browser.runtime.sendMessage(HARBOR_ID, ...)` simply has no listener to
 * answer it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeExtensionApi } from '../extension-api';
import { browserAPI } from '../browser-compat';

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({}));
vi.mock('../llm/native-bridge', () => ({}));
vi.mock('../llm/provider-registry', () => ({}));
vi.mock('../sessions', () => ({ SessionRegistry: { subscribe: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  const runtime = browserAPI.runtime as unknown as Record<string, unknown>;
  // Reset to a state where we can detect whether initializeExtensionApi()
  // ever calls addListener on either external surface.
  runtime.onMessageExternal = { addListener: vi.fn() };
  runtime.onConnectExternal = { addListener: vi.fn() };
});

describe('Harbor registers no cross-extension listener', () => {
  it('does not call onMessageExternal.addListener', () => {
    initializeExtensionApi();
    const runtime = browserAPI.runtime as unknown as {
      onMessageExternal: { addListener: ReturnType<typeof vi.fn> };
    };
    expect(runtime.onMessageExternal.addListener).not.toHaveBeenCalled();
  });

  it('does not call onConnectExternal.addListener', () => {
    initializeExtensionApi();
    const runtime = browserAPI.runtime as unknown as {
      onConnectExternal: { addListener: ReturnType<typeof vi.fn> };
    };
    expect(runtime.onConnectExternal.addListener).not.toHaveBeenCalled();
  });

  it('initializes cleanly even when the browser has no external-messaging surface at all', () => {
    const runtime = browserAPI.runtime as unknown as Record<string, unknown>;
    delete runtime.onMessageExternal;
    delete runtime.onConnectExternal;
    expect(() => initializeExtensionApi()).not.toThrow();
  });
});
