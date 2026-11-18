/**
 * routeAgentMessage() is the in-process entry point page-api/harbor-core.ts
 * calls for every `agent.*`/`agents.*` page call. A call with no
 * `payload.origin` must be rejected outright — never attributed to a
 * sender id or URL, because there is no trusted sender identity to fall
 * back to once Harbor accepts no cross-extension messages.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: false, bridgeReady: false, error: undefined })),
  checkBridgeHealth: vi.fn(async () => false),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => false), rpcRequest: vi.fn() }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []),
  getRuntimeCapabilities: vi.fn(async () => ({})),
}));
vi.mock('../../sessions', () => ({
  SessionRegistry: { subscribe: vi.fn() },
}));

describe('routeAgentMessage', () => {
  it('rejects a call with no payload.origin, without routing it anywhere', async () => {
    const { routeAgentMessage } = await import('../background-router');
    const sendResponse = vi.fn();
    routeAgentMessage({ type: 'agents.list', payload: { tabId: 7 } }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('rejects a call with an empty-string origin', async () => {
    const { routeAgentMessage } = await import('../background-router');
    const sendResponse = vi.fn();
    routeAgentMessage({ type: 'agents.list', payload: { origin: '' } }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('rejects a call with no payload at all', async () => {
    const { routeAgentMessage } = await import('../background-router');
    const sendResponse = vi.fn();
    routeAgentMessage({ type: 'agents.list' }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('routes a call that does carry payload.origin', async () => {
    const { routeAgentMessage } = await import('../background-router');
    const sendResponse = vi.fn();
    routeAgentMessage({ type: 'agents.list', payload: { origin: 'https://page.example' } }, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});
