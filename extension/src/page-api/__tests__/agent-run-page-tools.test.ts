import { beforeEach, describe, expect, it, vi } from 'vitest';

// Harbor's built-in agent.run loop calls the page's own tools
// (document.modelContext) as `page:<host>/<tool>`. They need no MCP grant:
// the person's grant to start the run covers them. Each call still goes
// through the policy check (callPageToolForAgent) and the run's budget, and
// the result reaches the model only as a tool message.

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(),
  hasPermission: vi.fn(),
  callPageToolForAgent: vi.fn(),
}));
vi.mock('../harbor-core', () => ({
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null),
  harborRequest: mocks.harborRequest,
  callPageToolForAgent: mocks.callPageToolForAgent,
}));
vi.mock('../handlers', () => ({ hasPermission: mocks.hasPermission }));

import { builtinAgentBackend } from '../agent-backend';
import type { StreamToken } from '../types';

const PAGE_TOOL = { serverId: 'page:tale.example', name: 'go_to', description: 'Scroll to an anchor', inputSchema: { type: 'object' }, generation: 4 };
const MCP_TOOL = { serverId: 'clock', name: 'time' };

function toolTurn(...calls: Array<[string, string]>) {
  return {
    content: '',
    choices: [{ message: { role: 'assistant', content: '', tool_calls: calls.map(([id, name]) => (
      { id, function: { name, arguments: '{"anchor":"p3"}' } }
    )) } }],
  };
}

type ChatPayload = { messages: Array<{ role: string; content: string; tool_call_id?: string }>; tools?: Array<{ name: string }> };

async function run(tools: unknown[], modelTurn: (call: number) => unknown, maxToolCalls = 5) {
  let chatCalls = 0;
  const chats: ChatPayload[] = [];
  const mcpCalls: unknown[] = [];
  mocks.harborRequest.mockImplementation(async (method: string, payload: ChatPayload) => {
    if (method === 'llm.chat') {
      chats.push(structuredClone(payload));
      return modelTurn(++chatCalls);
    }
    if (method === 'mcp.callTool') {
      mcpCalls.push(payload);
      return { result: 'noon' };
    }
    throw new Error(`unexpected ${method}`);
  });
  const events: StreamToken[] = [];
  await builtinAgentBackend.run(
    { origin: 'https://tale.example', tabId: 9, task: 'Take me to p3', maxToolCalls, tools: tools as never },
    e => events.push(e),
    new AbortController().signal,
  );
  return { chats, mcpCalls, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.callPageToolForAgent.mockResolvedValue({ at: 'p3' });
});

describe('page tools in the built-in agent.run loop', () => {
  it('offers the page tool to the model and calls it through callPageToolForAgent', async () => {
    const { chats, mcpCalls, events } = await run([PAGE_TOOL], call =>
      call === 1 ? toolTurn(['a', 'page_tale_example_go_to']) : { content: 'Done.' });

    expect(chats[0].tools?.map(t => t.name)).toEqual(['page_tale_example_go_to']);
    expect(mocks.callPageToolForAgent).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://tale.example', tabId: 9, generation: 4, name: 'go_to', input: { anchor: 'p3' },
    }));
    expect(mcpCalls).toEqual([]);
    const toolMessage = chats[1].messages.find(m => m.role === 'tool');
    expect(toolMessage?.content).toContain('p3');
    // The result never becomes system text.
    expect(chats[1].messages.filter(m => m.role === 'system')).toHaveLength(1);
    const toolCallEvent = events.find(e => e.type === 'token' && (e.token ?? '').includes('"tool_call"'));
    expect(JSON.parse(toolCallEvent?.token ?? '{}').tool).toBe('page:tale.example/go_to');
  });

  it('runs a page tool without mcp:tools.call', async () => {
    mocks.hasPermission.mockImplementation(async (_o: string, scope: string) => scope !== 'mcp:tools.call');
    await run([PAGE_TOOL], call =>
      call === 1 ? toolTurn(['a', 'page_tale_example_go_to']) : { content: 'Done.' });
    expect(mocks.callPageToolForAgent).toHaveBeenCalledTimes(1);
  });

  it('still refuses an MCP tool without mcp:tools.call', async () => {
    mocks.hasPermission.mockImplementation(async (_o: string, scope: string) => scope !== 'mcp:tools.call');
    const { mcpCalls } = await run([PAGE_TOOL, MCP_TOOL], call =>
      call === 1 ? toolTurn(['a', 'clock_time']) : { content: 'Done.' });
    expect(mcpCalls).toEqual([]);
  });

  it('a refused or failed page tool call reaches the model as an error, and the run goes on', async () => {
    mocks.callPageToolForAgent.mockRejectedValue(Object.assign(new Error('The page that offered this tool has gone away'), { code: 'ERR_TOOL_FAILED' }));
    const { chats, events } = await run([PAGE_TOOL], call =>
      call === 1 ? toolTurn(['a', 'page_tale_example_go_to']) : { content: 'Done.' });
    expect(chats[1].messages.find(m => m.role === 'tool')?.content).toMatch(/gone away/);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('counts page tool calls against the run budget', async () => {
    await run([PAGE_TOOL], call =>
      call === 1 ? toolTurn(['a', 'page_tale_example_go_to'], ['b', 'page_tale_example_go_to']) : { content: 'Done.' }, 1);
    expect(mocks.callPageToolForAgent).toHaveBeenCalledTimes(1);
  });
});
