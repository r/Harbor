/**
 * The content script, in the isolated world, posts an invocation into the
 * page only when the page is on the agent's site. Harbor checks the tab
 * before sending (agent-handlers.ts's agentPageStillInTab), but a
 * navigation can commit between that check and the send; this check can't
 * race, since it reads the document the invocation actually reached.
 */
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const bundled = buildSync({
  entryPoints: [new URL('../content-script.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'iife', platform: 'browser',
}).outputFiles[0].text;

function load(origin) {
  const pagePosts = [];
  const runtimeListeners = [];
  const sentToBackground = [];
  const window = {
    location: { origin },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    postMessage: vi.fn((data) => pagePosts.push(data)),
  };
  const chrome = {
    runtime: {
      connect: vi.fn(() => ({ name: 'harbor-page-api', postMessage: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } })),
      sendMessage: vi.fn((m, cb) => { sentToBackground.push(m); cb?.({}); }),
      onMessage: { addListener: (l) => runtimeListeners.push(l) },
      getURL: (p) => `moz-extension://x/${p}`,
      lastError: undefined,
    },
    storage: { onChanged: { addListener: vi.fn() } },
  };
  const document = {
    documentElement: { setAttribute: vi.fn() },
    head: null,
    createElement: () => ({}),
    getElementById: () => null,
    addEventListener: vi.fn(),
  };
  runInNewContext(bundled, { window, chrome, document, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, setTimeout, clearTimeout, Promise });
  const invoke = (agentOrigin, invocationId) => {
    const sendResponse = vi.fn();
    const message = { type: 'agentInvocation', invocationId, agentId: 'agent-1', agentOrigin, from: 'agent-caller', task: 'secret task', input: { secret: 1 } };
    runtimeListeners.forEach((l) => l(message, {}, sendResponse));
    return sendResponse;
  };
  const postedInvocations = () => pagePosts.filter((d) => d?.agentEvent?.type === 'invocation');
  return { invoke, postedInvocations, sentToBackground };
}

describe('content script agent invocation relay', () => {
  it("posts an invocation into a page on the agent's site", () => {
    const cs = load('https://a.example');
    cs.invoke('https://a.example', 'inv-1');
    expect(cs.postedInvocations()).toHaveLength(1);
    expect(cs.postedInvocations()[0].agentEvent.invocation).toMatchObject({ invocationId: 'inv-1', agentId: 'agent-1', task: 'secret task' });
  });

  it('posts nothing into a page on another site, and answers ERR_AGENT_NOT_FOUND', () => {
    const cs = load('https://evil.example');
    cs.invoke('https://a.example', 'inv-2');
    expect(cs.postedInvocations()).toHaveLength(0);
    expect(cs.sentToBackground).toContainEqual({
      type: 'agentInvocationResponse',
      response: expect.objectContaining({ invocationId: 'inv-2', success: false, error: expect.objectContaining({ code: 'ERR_AGENT_NOT_FOUND' }) }),
    });
  });

  it("posts nothing when the invocation doesn't name the agent's site", () => {
    const cs = load('https://a.example');
    cs.invoke(undefined, 'inv-3');
    expect(cs.postedInvocations()).toHaveLength(0);
  });
});
