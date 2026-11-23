import { beforeEach, describe, expect, it, vi } from 'vitest';

// The page's chat and agent.mcp handlers report Harbor's policy refusal codes
// as they are, and keep their own codes for any other failure.

const mocks = vi.hoisted(() => ({ harborRequest: vi.fn() }));
vi.mock('../harbor-core', () => ({
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null), harborRequest: mocks.harborRequest }));

import { handleChatCanOpen, handleChatClose, handleChatOpen } from '../handlers/chat-handlers';
import { handleMcpDiscover, handleMcpRegister, handleMcpUnregister } from '../handlers/mcp-handlers';

const ctx = (type: string, payload: unknown) =>
  ({ id: 'r1', type, origin: 'https://page.example', tabId: 3, payload }) as never;

const refused = (code: string) => Object.assign(new Error(`refused: ${code}`), { code });
const failed = () => Object.assign(new Error('something broke'), { code: 'ERR_INTERNAL' });

const calls = [
  { name: 'agent.chat.canOpen', run: () => handleChatCanOpen(ctx('agent.chat.canOpen', {})), own: 'ERR_CHAT' },
  { name: 'agent.chat.open', run: () => handleChatOpen(ctx('agent.chat.open', {})), own: 'ERR_CHAT_OPEN' },
  { name: 'agent.chat.close', run: () => handleChatClose(ctx('agent.chat.close', { chatId: 'c1' })), own: 'ERR_CHAT_CLOSE' },
  { name: 'agent.mcp.discover', run: () => handleMcpDiscover(ctx('agent.mcp.discover', {})), own: 'ERR_MCP_DISCOVER' },
  { name: 'agent.mcp.register', run: () => handleMcpRegister(ctx('agent.mcp.register', { url: 'https://page.example/mcp', name: 'n' })), own: 'ERR_MCP_REGISTER' },
  { name: 'agent.mcp.unregister', run: () => handleMcpUnregister(ctx('agent.mcp.unregister', { serverId: 's1' })), own: 'ERR_MCP_UNREGISTER' },
];

beforeEach(() => vi.clearAllMocks());

describe.each(calls)('$name', ({ run, own }) => {
  it.each(['ERR_BLOCKED_BY_POLICY', 'ERR_PERMISSION_DENIED', 'ERR_QUARANTINED'])('reports Harbor\'s %s as is', async (code) => {
    mocks.harborRequest.mockRejectedValue(refused(code));
    const res = await run();
    expect(res).toMatchObject({ ok: false, error: { code } });
  });

  it('keeps its own code for any other failure', async () => {
    mocks.harborRequest.mockRejectedValue(failed());
    const res = await run();
    expect(res).toMatchObject({ ok: false, error: { code: own, message: 'something broke' } });
  });
});
