import { describe, expect, it } from 'vitest';
import { normalizeAgentStream } from './normalize-agent-stream';

async function* stream(values: unknown[]): AsyncIterable<unknown> {
  yield* values;
}

async function collect(values: unknown[]) {
  let now = 100;
  const events = [];
  for await (const event of normalizeAgentStream(stream(values), {
    runId: 'run-1',
    clock: { now: () => now++ },
  })) {
    events.push(event);
  }
  return events;
}

describe('normalizeAgentStream', () => {
  it('normalizes canonical and legacy status dialects', async () => {
    await expect(collect([
      { type: 'status', message: 'Starting' },
      { type: 'thinking', content: 'Planning' },
      { type: 'final', output: 'Done' },
    ])).resolves.toEqual([
      { type: 'status', message: 'Starting' },
      { type: 'status', message: 'Planning' },
      { type: 'final', output: 'Done', citations: [] },
    ]);
  });

  it('assigns distinct FIFO call IDs to repeated tools', async () => {
    const events = await collect([
      {
        type: 'tool_call',
        tool: 'server/search',
        args: { query: 'first' },
      },
      {
        type: 'tool_call',
        tool: 'server/search',
        args: { query: 'second' },
      },
      {
        type: 'tool_result',
        tool: 'server/search',
        result: 'one',
      },
      {
        type: 'tool_result',
        tool: 'server/search',
        result: 'two',
      },
      { type: 'final', output: 'Done' },
    ]);

    const started = events.filter((event) => event.type === 'tool-started');
    const completed = events.filter((event) => event.type === 'tool-completed');

    expect(started).toHaveLength(2);
    expect(started[0].callId).not.toBe(started[1].callId);
    expect(completed.map((event) => event.callId)).toEqual(
      started.map((event) => event.callId),
    );
  });

  it('keeps citation excerpts and tool payloads out of normalized metadata', async () => {
    const events = await collect([
      {
        type: 'tool_call',
        tool: 'https://user:secret@tools.example/path?token=secret',
        args: {
          query: 'allowed',
          apiKey: 'secret-value',
        },
      },
      {
        type: 'tool_result',
        tool: 'https://user:secret@tools.example/path?token=secret',
        result: { private: 'raw result' },
      },
      {
        type: 'final',
        output: 'Done',
        citations: [{
          source: 'tool',
          ref: 'https://user:secret@docs.example/path?token=secret',
          excerpt: 'private page text',
        }],
      },
    ]);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('raw result');
    expect(serialized).not.toContain('private page text');
    expect(serialized).not.toContain('user:secret');
    expect(serialized).not.toContain('?token=');
  });

  it('normalizes legacy string errors', async () => {
    const events = await collect([{
      type: 'error',
      error: 'NetworkError while fetching a provider secret',
    }]);

    expect(events).toEqual([{
      type: 'error',
      error: {
        category: 'transport',
        message: 'Harbor lost connection while running this request.',
        recovery: {
          kind: 'retry',
          label: 'Try again',
        },
      },
    }]);
    expect(JSON.stringify(events)).not.toContain('provider secret');
  });
});
