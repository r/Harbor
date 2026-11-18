/// <reference types="node" />
/**
 * A stream that fails must end the page's `for await`, whether the error
 * arrives before or while the page is waiting for the next chunk.
 *
 * Runs the real injected.ts in a `vm` sandbox (as support/api-shape.ts does)
 * and plays the content script's side of the window.postMessage transport.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { resolveFromModule, ALL_FLAGS_TRUE } from './support/api-shape';

const CHANNEL = 'harbor_page_api';
const FLAGS_ELEMENT_ID = 'harbor-page-api-flags';

type Message = { channel: string; request?: { id: string; type: string; payload?: unknown } };
type PageApi = {
  ai: {
    createTextSession(): Promise<{ promptStreaming(input: string): AsyncIterable<{ type: string; token?: string }> }>;
  };
};

function loadPage() {
  const source = readFileSync(resolveFromModule(import.meta.url, '../injected.ts'), 'utf-8');
  const { code } = transformSync(source, { loader: 'ts', format: 'iife', target: 'es2022' });

  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const requests: NonNullable<Message['request']>[] = [];
  let n = 0;
  const win: Record<string, unknown> = {
    addEventListener(type: string, fn: (e: { source: unknown; data: unknown }) => void) {
      if (type === 'message') listeners.push(fn);
    },
    removeEventListener() {},
    dispatchEvent: () => true,
    postMessage(data: Message) {
      if (data?.channel === CHANNEL && data.request) requests.push(data.request);
    },
  };
  const deliver = (data: unknown) => listeners.forEach((fn) => fn({ source: win, data }));
  const sandbox = {
    window: win,
    document: {
      getElementById: (id: string) => (id === FLAGS_ELEMENT_ID ? { textContent: JSON.stringify(ALL_FLAGS_TRUE) } : null),
      querySelector: () => null,
    },
    navigator: {},
    crypto: { randomUUID: () => `id-${++n}` },
    CustomEvent: class { constructor(public type: string, public init?: unknown) {} },
    localStorage: undefined,
    console: { ...console, log() {}, debug() {} },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const respond = (type: string, result: unknown) => {
    const req = requests.find((r) => r.type === type)!;
    deliver({ channel: CHANNEL, response: { id: req.id, ok: true, result } });
  };
  const streamEvent = (type: string, event: unknown, done = false) => {
    const req = requests.find((r) => r.type === type)!;
    deliver({ channel: CHANNEL, streamEvent: { id: req.id, event, done } });
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { api: win as unknown as PageApi, requests, respond, streamEvent, tick };
}

async function streamingSession() {
  const page = loadPage();
  const pending = page.api.ai.createTextSession();
  await page.tick();
  page.respond('ai.createTextSession', 'session-1');
  const session = await pending;
  const iterator = session.promptStreaming('hi')[Symbol.asyncIterator]();
  return { ...page, iterator };
}

const modelError = { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: 'Provider unavailable' } };

describe('page stream errors', () => {
  it('rejects a next() that is already waiting when the error arrives', async () => {
    const { iterator, streamEvent, tick } = await streamingSession();
    const next = iterator.next();
    await tick();
    streamEvent('session.promptStreaming', modelError, true);

    const outcome = await Promise.race([
      next.then(() => 'resolved', (e: Error & { code?: string }) => `${e.code}: ${e.message}`),
      new Promise((r) => setTimeout(() => r('still waiting'), 50)),
    ]);
    expect(outcome).toBe('ERR_MODEL_FAILED: Provider unavailable');
  });

  it('rejects the next next() when the error arrived first', async () => {
    const { iterator, streamEvent } = await streamingSession();
    streamEvent('session.promptStreaming', modelError, true);
    await expect(iterator.next()).rejects.toThrow('Provider unavailable');
  });
});
