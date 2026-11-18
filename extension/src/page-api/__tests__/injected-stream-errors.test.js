/**
 * A refused stream must reach the page as a rejection with Harbor's error
 * code. If the error arrives while the page is already awaiting the next
 * token, the waiting promise has to settle, or the page hangs forever.
 *
 * Runs the real injected.ts in a VM, the way injected-flags.test.js does,
 * and plays Harbor's side of the page message channel.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../injected.ts', import.meta.url), 'utf8');
const script = transformSync(source, { loader: 'ts', format: 'iife' }).code;
const CHANNEL = 'harbor_page_api';

function page() {
  const listeners = [];
  const window = {
    addEventListener: vi.fn((type, l) => { if (type === 'message') listeners.push(l); }),
    dispatchEvent: vi.fn(),
    postMessage: vi.fn(),
  };
  runInNewContext(script, {
    window, navigator: {}, crypto: webcrypto, console: { debug: vi.fn(), warn: vi.fn(), log: vi.fn() },
    document: { querySelector: () => null, getElementById: () => null },
    CustomEvent: class { constructor(type, options) { this.type = type; this.options = options; } },
    setTimeout, clearTimeout, Map, Set, Date, Math,
  });
  /** Deliver a message from Harbor's side of the channel. */
  const deliver = (data) => listeners.forEach((l) => l({ source: window, data: { channel: CHANNEL, ...data } }));
  /** The id of the most recent request of `type` the page sent. */
  const lastRequestId = (type) =>
    window.postMessage.mock.calls.map(([m]) => m.request).filter((r) => r?.type === type).at(-1)?.id;
  return { window, deliver, lastRequestId };
}

const denied = { type: 'error', error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission model:prompt required' } };

/** Resolve to the outcome of `promise`, or 'pending' if it hasn't settled. */
async function settled(promise) {
  const pending = Symbol('pending');
  const result = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((r) => setTimeout(() => r(pending), 50)),
  ]);
  return result === pending ? 'pending' : result;
}

describe('a stream refused while the page awaits the next token', () => {
  it('rejects session.promptStreaming with the permission error', async () => {
    const { window, deliver, lastRequestId } = page();
    const creating = window.ai.createTextSession();
    deliver({ response: { id: lastRequestId('ai.createTextSession'), ok: true, result: 'session-1' } });
    const session = await creating;

    const iterator = session.promptStreaming('Hi')[Symbol.asyncIterator]();
    const next = iterator.next();
    deliver({ streamEvent: { id: lastRequestId('session.promptStreaming'), event: denied, done: true } });

    const outcome = await settled(next);
    expect(outcome).not.toBe('pending');
    expect(outcome.error).toMatchObject({ code: 'ERR_PERMISSION_DENIED', message: 'Permission model:prompt required' });
  });

  it('rejects agent.run with the permission error', async () => {
    const { window, deliver, lastRequestId } = page();
    const iterator = window.agent.run({ task: 'What time is it?' })[Symbol.asyncIterator]();
    const next = iterator.next();
    deliver({ streamEvent: { id: lastRequestId('agent.run'), event: denied, done: true } });

    const outcome = await settled(next);
    expect(outcome).not.toBe('pending');
    expect(outcome.error).toMatchObject({ code: 'ERR_PERMISSION_DENIED' });
  });

  it('still delivers tokens that arrive while the page waits', async () => {
    const { window, deliver, lastRequestId } = page();
    const creating = window.ai.createTextSession();
    deliver({ response: { id: lastRequestId('ai.createTextSession'), ok: true, result: 'session-1' } });
    const session = await creating;

    const iterator = session.promptStreaming('Hi')[Symbol.asyncIterator]();
    const next = iterator.next();
    const id = lastRequestId('session.promptStreaming');
    deliver({ streamEvent: { id, event: { type: 'token', token: 'Hel' } } });
    expect(await next).toEqual({ done: false, value: 'Hel' });
    deliver({ streamEvent: { id, event: { type: 'done' }, done: true } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});
