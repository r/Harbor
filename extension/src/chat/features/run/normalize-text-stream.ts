import { normalizeRunError, protocolRunError } from './run-error';
import type { NormalizedTextStreamEvent } from './run-types';

type TextStreamEventShape = {
  type?: unknown;
  token?: unknown;
  error?: unknown;
};

export async function* normalizeTextStream(
  source: AsyncIterable<unknown>,
): AsyncIterable<NormalizedTextStreamEvent> {
  for await (const rawEvent of source) {
    if (typeof rawEvent === 'string') {
      if (rawEvent) {
        yield { type: 'content-delta', text: rawEvent };
      }
      continue;
    }

    if (!rawEvent || typeof rawEvent !== 'object') {
      yield { type: 'error', error: protocolRunError('ERR_INVALID_TEXT_EVENT') };
      return;
    }

    const event = rawEvent as TextStreamEventShape;
    if (event.type === 'token') {
      if (typeof event.token === 'string' && event.token) {
        yield { type: 'content-delta', text: event.token };
      }
      continue;
    }
    if (event.type === 'done') {
      yield { type: 'done' };
      return;
    }
    if (event.type === 'error') {
      yield { type: 'error', error: normalizeRunError(event.error) };
      return;
    }

    yield { type: 'error', error: protocolRunError('ERR_INVALID_TEXT_EVENT') };
    return;
  }
}
