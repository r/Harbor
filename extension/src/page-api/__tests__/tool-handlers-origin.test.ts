import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ harborRequest: vi.fn() }));
vi.mock('../harbor-core', () => ({ harborRequest: mocks.harborRequest }));
vi.mock('../handlers/permission-handlers', () => ({
  hasPermission: async () => true,
  getPermissions: async () => ({ scopes: {}, allowedTools: ['now'] }),
}));

import { handleToolsCall, handleToolsList } from '../handlers/tool-handlers';

const ctx = (type: string, payload: unknown) =>
  ({ id: 'x', type, origin: 'https://page.example', tabId: 4, payload }) as never;

beforeEach(() => vi.clearAllMocks());

describe('agent.tools.* forward the page origin to Harbor', () => {
  it('agent.tools.list', async () => {
    mocks.harborRequest.mockResolvedValue({ tools: [] });
    await handleToolsList(ctx('agent.tools.list', {}));
    expect(mocks.harborRequest).toHaveBeenCalledWith('mcp.listTools', { origin: 'https://page.example', tabId: 4 }, expect.anything());
  });

  it('agent.tools.call, including the lookup for an unqualified tool name', async () => {
    mocks.harborRequest.mockImplementation(async (method: string) =>
      method === 'mcp.listTools' ? { tools: [{ serverId: 'clock', name: 'now' }] } : { result: 'noon' });
    await handleToolsCall(ctx('agent.tools.call', { tool: 'now', args: {} }));
    for (const [, payload] of mocks.harborRequest.mock.calls) {
      expect(payload).toMatchObject({ origin: 'https://page.example', tabId: 4 });
    }
    expect(mocks.harborRequest).toHaveBeenCalledWith('mcp.callTool', expect.objectContaining({ serverId: 'clock', toolName: 'now' }), expect.anything());
  });
});
