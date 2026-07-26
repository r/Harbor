import { describe, expect, it } from 'vitest';
import { normalizeTextStream } from './normalize-text-stream';

async function* stream(values: unknown[]): AsyncIterable<unknown> {
  yield* values;
}

async function collect(source: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of normalizeTextStream(source)) {
    events.push(event);
  }
  return events;
}

describe('normalizeTextStream', () => {
  it('normalizes raw-string legacy streams', async () => {
    await expect(collect(stream(['Hello', ' ', 'there']))).resolves.toEqual([
      { type: 'content-delta', text: 'Hello' },
      { type: 'content-delta', text: ' ' },
      { type: 'content-delta', text: 'there' },
    ]);
  });

  it('normalizes canonical token and done events', async () => {
    await expect(collect(stream([
      { type: 'token', token: 'Harbor' },
      { type: 'done' },
      { type: 'token', token: 'ignored' },
    ]))).resolves.toEqual([
      { type: 'content-delta', text: 'Harbor' },
      { type: 'done' },
    ]);
  });

  it('maps streamed errors without exposing external messages', async () => {
    const [event] = await collect(stream([{
      type: 'error',
      error: {
        code: 'ERR_NO_MODEL',
        message: 'api_key=should-not-appear',
      },
    }]));

    expect(event).toEqual({
      type: 'error',
      error: {
        category: 'configuration',
        code: 'ERR_NO_MODEL',
        message: 'A model needs to be configured before chatting.',
        recovery: {
          kind: 'open-connections',
          label: 'Configure a model',
        },
      },
    });
    expect(JSON.stringify(event)).not.toContain('should-not-appear');
  });
});
