import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ harborRequest: vi.fn() }));
vi.mock('../harbor-core', () => ({
  describedBySite: (_origin: string, d?: string) => d,
  siteToolsForAgent: vi.fn(async () => []),
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null), harborRequest: mocks.harborRequest }));
vi.mock('../handlers/permission-handlers', () => ({
  hasPermission: async () => true,
  getPermissions: async () => ({ scopes: {}, allowedTools: ['now'] }),
}));

import { handleToolsCall, handleToolsList } from '../handlers/tool-handlers';

const signal = new AbortController().signal;
const ctx = (type: string, payload: unknown) =>
  ({ id: 'x', type, origin: 'https://page.example', tabId: 4, payload, signal }) as never;
const withSignal = { signal };

beforeEach(() => vi.clearAllMocks());

describe('agent.tools.* forward the page origin to Harbor', () => {
  it('agent.tools.list', async () => {
    mocks.harborRequest.mockResolvedValue({ tools: [] });
    await handleToolsList(ctx('agent.tools.list', {}));
    expect(mocks.harborRequest).toHaveBeenCalledWith('mcp.listTools', { origin: 'https://page.example', tabId: 4 }, withSignal);
  });

  it('agent.tools.call, including the lookup for an unqualified tool name', async () => {
    mocks.harborRequest.mockImplementation(async (method: string) =>
      method === 'mcp.listTools' ? { tools: [{ serverId: 'clock', name: 'now' }] } : { result: 'noon' });
    await handleToolsCall(ctx('agent.tools.call', { tool: 'now', args: {} }));
    // Both the lookup and the call carry the page request's signal, so
    // Harbor drops either one the page has given up on.
    for (const [, payload, options] of mocks.harborRequest.mock.calls) {
      expect(payload).toMatchObject({ origin: 'https://page.example', tabId: 4 });
      expect(options).toEqual(withSignal);
    }
    expect(mocks.harborRequest).toHaveBeenCalledWith('mcp.callTool', expect.objectContaining({ serverId: 'clock', toolName: 'now' }), withSignal);
  });
});
