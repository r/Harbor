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
  runInNewContext(bundled, { window, chrome, document, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, setTimeout, clearTimeout, Promise, crypto: globalThis.crypto });
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

function loadWithPort(origin) {
  const windowListeners = {};
  const pagePosts = [];
  const runtimeListeners = [];
  const ports = [];
  const window = {
    location: { origin },
    addEventListener: vi.fn((type, l) => { (windowListeners[type] ||= []).push(l); }),
    removeEventListener: vi.fn(),
    postMessage: vi.fn((data) => pagePosts.push(data)),
  };
  const chrome = {
    runtime: {
      connect: vi.fn(() => {
        const port = { name: 'harbor-page-api', postMessage: vi.fn(), disconnect: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } };
        ports.push(port);
        return port;
      }),
      sendMessage: vi.fn((m, cb) => cb?.({})),
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
  runInNewContext(bundled, { window, chrome, document, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, setTimeout, clearTimeout, Promise, crypto: globalThis.crypto });
  const fire = (type, event) => (windowListeners[type] || []).forEach((l) => l(event));
  const fromPage = (data) => fire('message', { source: window, data: { channel: 'harbor_page_api', ...data } });
  return { window, fire, fromPage, pagePosts, ports, runtimeListeners };
}

describe('content script and the back/forward cache', () => {
  it("closes the page's port when the page goes into the cache, failing its waiting requests", () => {
    const cs = loadWithPort('https://a.example');
    cs.fromPage({ request: { id: 'r1', type: 'agent.agents.list' } });
    expect(cs.ports).toHaveLength(1);

    cs.fire('pagehide', { persisted: true });
    // Harbor hears why the port closes, so it can keep the page's own-agent sessions.
    expect(cs.ports[0].postMessage).toHaveBeenCalledWith({ type: 'page_hidden', token: expect.any(String) });
    expect(cs.ports[0].disconnect).toHaveBeenCalled();
    expect(cs.pagePosts).toContainEqual(expect.objectContaining({
      response: expect.objectContaining({ id: 'r1', ok: false }),
    }));
  });

  it('tells the page it was restored, and opens a new port for its next call', () => {
    const cs = loadWithPort('https://a.example');
    cs.fromPage({ request: { id: 'r1', type: 'agent.agents.list' } });
    cs.fire('pagehide', { persisted: true });
    cs.fire('pageshow', { persisted: true });
    expect(cs.pagePosts).toContainEqual(expect.objectContaining({ pageRestored: true }));
    // A new port at once, so Harbor counts this page as the tab's own again.
    expect(cs.ports).toHaveLength(2);
    const hidden = cs.ports[0].postMessage.mock.calls.find(([m]) => m.type === 'page_hidden')[0];
    expect(cs.ports[1].postMessage).toHaveBeenCalledWith({ type: 'page_shown', token: hidden.token });

    cs.fromPage({ request: { id: 'r2', type: 'agent.agents.list' } });
    expect(cs.ports).toHaveLength(2);
  });

  it("doesn't tell the page anything on an ordinary first load", () => {
    const cs = loadWithPort('https://a.example');
    cs.fire('pageshow', { persisted: false });
    expect(cs.pagePosts.some((d) => d?.pageRestored)).toBe(false);
  });

  it("refuses a page's own request posing as the content script's page_hidden or page_shown", () => {
    const cs = loadWithPort('https://a.example');
    cs.fromPage({ request: { id: 'f1', type: 'page_hidden', token: 'x' } });
    cs.fromPage({ request: { id: 'f2', type: 'page_shown', token: 'x' } });
    const sent = cs.ports.flatMap((p) => p.postMessage.mock.calls.map(([m]) => m));
    expect(sent.some((m) => m.type === 'page_hidden' || m.type === 'page_shown')).toBe(false);
    expect(cs.pagePosts).toContainEqual(expect.objectContaining({ response: expect.objectContaining({ id: 'f1', ok: false }) }));
  });

  it('passes a cancelled invocation on to the page', () => {
    const cs = loadWithPort('https://a.example');
    cs.runtimeListeners.forEach((l) => l({ type: 'agentInvocationCancel', invocationId: 'inv-9' }, {}, vi.fn()));
    expect(cs.pagePosts).toContainEqual(expect.objectContaining({
      agentEvent: { type: 'invocationCancel', invocationId: 'inv-9' },
    }));
  });
});
