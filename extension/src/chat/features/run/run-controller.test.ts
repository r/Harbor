import { describe, expect, it } from 'vitest';
import type {
  ChatRunEvent,
  ChatRunRequest,
} from '../../contracts';
import { createChatRunService } from './run-controller';

const modelRequest: ChatRunRequest = {
  prompt: 'Hello',
  approval: {
    intent: {
      context: { mode: 'off' },
      tools: { mode: 'off' },
    },
    scopes: ['model:prompt'],
  },
};

const agentRequest: ChatRunRequest = {
  prompt: 'Search twice',
  approval: {
    intent: {
      context: { mode: 'off' },
      tools: {
        mode: 'approved',
        toolNames: ['server/search'],
      },
    },
    scopes: ['model:prompt', 'model:tools', 'mcp:tools.call'],
  },
};

async function* stream(values: unknown[]): AsyncIterable<unknown> {
  yield* values;
}

async function collect(source: AsyncIterable<ChatRunEvent>) {
  const events: ChatRunEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function createIds() {
  let ordinal = 0;
  return () => `id-${++ordinal}`;
}

describe('createChatRunService', () => {
  it('supports canonical text streams and destroys the session', async () => {
    let destroyed = false;
    const service = createChatRunService({
      ai: {
        async createTextSession() {
          return {
            promptStreaming: () => stream([
              { type: 'token', token: 'Hello' },
              { type: 'token', token: ' Harbor' },
              { type: 'done' },
            ]),
            destroy: () => {
              destroyed = true;
            },
          };
        },
      },
      agent: { run: () => stream([]) },
      clock: { now: () => 1_000 },
      createId: createIds(),
    });

    const events = await collect(service.run(modelRequest));
    expect(events).toEqual([
      {
        type: 'started',
        runId: 'id-1',
        mode: 'model',
        at: new Date(1_000).toISOString(),
      },
      { type: 'content-delta', text: 'Hello' },
      { type: 'content-delta', text: ' Harbor' },
      {
        type: 'completed',
        output: 'Hello Harbor',
        receipt: expect.objectContaining({
          id: 'id-2',
          runId: 'id-1',
          mode: 'model',
          status: 'completed',
        }),
      },
    ]);
    expect(destroyed).toBe(true);
  });

  it('treats final agent output as authoritative', async () => {
    const service = createChatRunService({
      ai: {
        createTextSession: async () => {
          throw new Error('not used');
        },
      },
      agent: {
        run: () => stream([
          { type: 'token', token: 'Draft output' },
          { type: 'final', output: 'Authoritative output' },
        ]),
      },
      clock: { now: () => 2_000 },
      createId: createIds(),
    });

    const events = await collect(service.run(agentRequest));
    expect(events).toContainEqual({
      type: 'content-delta',
      text: 'Draft output',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      output: 'Authoritative output',
    });
  });

  it('records repeated calls independently and closes missing results', async () => {
    let now = 3_000;
    const service = createChatRunService({
      ai: {
        createTextSession: async () => {
          throw new Error('not used');
        },
      },
      agent: {
        run: () => stream([
          {
            type: 'tool_call',
            tool: 'server/search',
            args: { query: 'one' },
          },
          {
            type: 'tool_call',
            tool: 'server/search',
            args: { query: 'two' },
          },
          {
            type: 'tool_result',
            tool: 'server/search',
            result: ['one'],
          },
          { type: 'final', output: 'Done' },
        ]),
      },
      clock: { now: () => now++ },
      createId: createIds(),
    });

    const events = await collect(service.run(agentRequest));
    const completed = events.at(-1);
    expect(completed?.type).toBe('completed');
    if (completed?.type !== 'completed') {
      throw new Error('Expected completed event');
    }

    expect(completed.receipt.toolCalls).toHaveLength(2);
    expect(completed.receipt.toolCalls[0]).toMatchObject({
      status: 'completed',
      resultSummary: { kind: 'array', size: 1 },
    });
    expect(completed.receipt.toolCalls[1]).toMatchObject({
      status: 'failed',
      errorCode: 'ERR_TOOL_RESULT_MISSING',
    });
    expect(completed.receipt.toolCalls[0].callId).not.toBe(
      completed.receipt.toolCalls[1].callId,
    );
  });

  it('turns an agent stream without a final event into a protocol failure', async () => {
    const service = createChatRunService({
      ai: {
        createTextSession: async () => {
          throw new Error('not used');
        },
      },
      agent: {
        run: () => stream([{ type: 'thinking', content: 'Working' }]),
      },
      clock: { now: () => 4_000 },
      createId: createIds(),
    });

    const events = await collect(service.run(agentRequest));
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      error: {
        category: 'protocol',
        code: 'ERR_AGENT_FINAL_MISSING',
      },
      receipt: {
        status: 'failed',
        error: {
          category: 'protocol',
          code: 'ERR_AGENT_FINAL_MISSING',
        },
      },
    });
  });

  it('cancels an active stream and calls its iterator return method', async () => {
    let iteratorClosed = false;
    let markIteratorStarted = (): void => {};
    const iteratorStarted = new Promise<void>((resolve) => {
      markIteratorStarted = resolve;
    });
    const pendingNext = new Promise<IteratorResult<unknown>>(() => {});
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            markIteratorStarted();
            return pendingNext;
          },
          return: async () => {
            iteratorClosed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const service = createChatRunService({
      ai: {
        createTextSession: async () => {
          throw new Error('not used');
        },
      },
      agent: { run: () => source },
      clock: { now: () => 5_000 },
      createId: createIds(),
    });
    const iterator = service.run(agentRequest)[Symbol.asyncIterator]();
    const started = await iterator.next();

    expect(started.value).toMatchObject({
      type: 'started',
      runId: 'id-1',
    });
    const terminalPromise = iterator.next();
    await iteratorStarted;
    service.cancel('id-1');

    const terminal = await terminalPromise;
    expect(terminal.value).toMatchObject({
      type: 'cancelled',
      receipt: {
        status: 'cancelled',
      },
    });
    await iterator.next();
    expect(iteratorClosed).toBe(true);
  });
});
