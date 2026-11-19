import { beforeEach, describe, expect, it, vi } from 'vitest';

// agent.run's maxToolCalls caps the tool calls a run makes. The cap has to
// hold when one model turn asks for several tools at once, and a model that
// keeps asking for tools the site may not call must still reach an end.

const mocks = vi.hoisted(() => ({ harborRequest: vi.fn(), hasPermission: vi.fn() }));
vi.mock('../harbor-core', () => ({ harborRequest: mocks.harborRequest }));
vi.mock('../handlers', () => ({ hasPermission: mocks.hasPermission }));

import { builtinAgentBackend } from '../agent-backend';
import type { StreamToken } from '../types';

const TOOLS = [{ serverId: 'clock', name: 'time' }];

function toolTurn(...ids: string[]) {
  return {
    content: '',
    choices: [{ message: { role: 'assistant', content: '', tool_calls: ids.map(id => (
      { id, function: { name: 'clock_time', arguments: '{}' } }
    )) } }],
  };
}

type ChatPayload = { messages: Array<{ role: string; content: string; tool_call_id?: string }>; tools?: unknown };

async function run(maxToolCalls: number, modelTurn: (call: number, payload: ChatPayload) => unknown) {
  let chatCalls = 0;
  const toolCalls: unknown[] = [];
  const chats: ChatPayload[] = [];
  mocks.harborRequest.mockImplementation(async (method: string, payload: ChatPayload) => {
    if (method === 'llm.chat') {
      chats.push(structuredClone(payload));
      return modelTurn(++chatCalls, payload);
    }
    if (method === 'mcp.callTool') {
      toolCalls.push(payload);
      return { result: { content: [{ type: 'text', text: 'noon' }] } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const events: StreamToken[] = [];
  await builtinAgentBackend.run(
    { origin: 'https://example.test', task: 'What time is it?', maxToolCalls, tools: TOOLS },
    e => events.push(e),
    new AbortController().signal,
  );
  return { chats, toolCalls, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
});

describe('agent.run tool budget', () => {
  it('runs no more than maxToolCalls tools when one turn asks for more', async () => {
    const { toolCalls, chats, events } = await run(1, call =>
      call === 1 ? toolTurn('a', 'b', 'c') : { content: 'It is noon.' });

    expect(toolCalls).toHaveLength(1);
    // Every tool call the model made gets an answer, and the ones past the
    // budget tell the model why they didn't run.
    const toolMessages = chats[1].messages.filter(m => m.role === 'tool');
    expect(toolMessages.map(m => m.tool_call_id)).toEqual(['a', 'b', 'c']);
    expect(toolMessages[1].content).toMatch(/budget/i);
    expect(toolMessages[2].content).toMatch(/budget/i);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('counts tool calls across turns against one budget', async () => {
    const { toolCalls } = await run(3, call =>
      call <= 2 ? toolTurn(`${call}a`, `${call}b`) : { content: 'It is noon.' });
    expect(toolCalls).toHaveLength(3);
  });

  it('ends a run whose model keeps asking for tools the site may not call', async () => {
    mocks.hasPermission.mockImplementation(async (_origin: string, scope: string) => scope !== 'mcp:tools.call');
    let calls = 0;
    const { toolCalls, events } = await run(3, () => {
      calls++;
      if (calls > 50) throw new Error('run did not end');
      return toolTurn(`t${calls}`);
    });

    expect(toolCalls).toHaveLength(0);
    // Three denied turns use up the budget, then one last answer without tools.
    expect(calls).toBe(4);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
