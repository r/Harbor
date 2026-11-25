/**
 * An invocation reaches a page's `onInvoke` handlers only for an agent that
 * page registered, and is otherwise answered ERR_AGENT_NOT_FOUND.
 *
 * This is the second layer. It runs in the page's own world, after the
 * content script has posted the invocation there, so it can't keep the task
 * from the page. The background is what keeps an old page's invocation out
 * of a replaced tab (handleIncomingInvocation's agentPageStillInTab, tested
 * in multi-agent-invocation.test.ts).
 *
 * Runs the real injected.ts in a VM, as injected-request-timeouts.test.js does.
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
    window, navigator: {}, crypto: webcrypto, console: { debug: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    document: {
      querySelector: () => null,
      getElementById: () => ({ textContent: JSON.stringify({ multiAgent: true }) }),
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.options = options; } },
    setTimeout, clearTimeout, Map, Set, Date, Math, AbortController,
  });
  const deliver = (data) => listeners.forEach((l) => l({ source: window, data: { channel: CHANNEL, ...data } }));
  const requests = (type) => window.postMessage.mock.calls.map(([m]) => m.request).filter((r) => r?.type === type);
  const invocationResponses = () => window.postMessage.mock.calls.map(([m]) => m.agentInvocationResponse).filter(Boolean);
  return { window, deliver, requests, invocationResponses };
}

async function registeredPage(agentId) {
  const p = page();
  const registering = p.window.agent.agents.register({ name: 'Mine', acceptsInvocations: true });
  await vi.waitFor(() => expect(p.requests('agent.agents.register')).toHaveLength(1));
  const [request] = p.requests('agent.agents.register');
  p.deliver({ response: { id: request.id, ok: true, result: { id: agentId, name: 'Mine' } } });
  await registering;
  const handler = vi.fn(async () => 'answered');
  p.window.agent.agents.onInvoke(handler);
  return { ...p, handler };
}

function invocation(agentId, invocationId) {
  return { agentEvent: { type: 'invocation', invocation: { invocationId, agentId, from: 'agent-caller', task: 'secret task', input: { secret: 1 } } } };
}

describe("a page's invocation handlers", () => {
  it('get an invocation for an agent this page registered', async () => {
    const p = await registeredPage('agent-mine');
    p.deliver(invocation('agent-mine', 'inv-1'));

    await vi.waitFor(() => expect(p.invocationResponses()).toHaveLength(1));
    expect(p.handler).toHaveBeenCalledTimes(1);
    expect(p.invocationResponses()[0]).toMatchObject({ invocationId: 'inv-1', success: true, result: 'answered' });
  });

  it("never see an invocation for another page's agent, which is answered ERR_AGENT_NOT_FOUND", async () => {
    const p = await registeredPage('agent-mine');
    p.deliver(invocation('agent-old-page', 'inv-2'));

    await vi.waitFor(() => expect(p.invocationResponses()).toHaveLength(1));
    expect(p.handler).not.toHaveBeenCalled();
    expect(p.invocationResponses()[0]).toMatchObject({
      invocationId: 'inv-2',
      success: false,
      error: { code: 'ERR_AGENT_NOT_FOUND' },
    });
  });

  it('never see an invocation that names no agent', async () => {
    const p = await registeredPage('agent-mine');
    p.deliver(invocation(undefined, 'inv-3'));

    await vi.waitFor(() => expect(p.invocationResponses()).toHaveLength(1));
    expect(p.handler).not.toHaveBeenCalled();
    expect(p.invocationResponses()[0]).toMatchObject({ success: false, error: { code: 'ERR_AGENT_NOT_FOUND' } });
  });
});

/** Answer the page's latest request of `type`. */
function answer(p, type, result, index = -1) {
  const all = p.requests(type);
  const request = all.at(index);
  p.deliver({ response: { id: request.id, ok: true, result } });
}

describe('a page restored from the back/forward cache', () => {
  it('re-registers its agent with the same options, asking for its old id, and re-subscribes', async () => {
    const p = await registeredPage('agent-mine');
    const subscribing = p.window.agent.agents.subscribe('news', vi.fn());
    await vi.waitFor(() => expect(p.requests('agent.agents.subscribe')).toHaveLength(1));
    answer(p, 'agent.agents.subscribe', null);
    await subscribing;

    p.deliver({ pageRestored: true });

    await vi.waitFor(() => expect(p.requests('agent.agents.register')).toHaveLength(2));
    expect(p.requests('agent.agents.register')[1].payload).toEqual({
      name: 'Mine', acceptsInvocations: true, restoreAgentId: 'agent-mine',
    });
    answer(p, 'agent.agents.register', { id: 'agent-mine', name: 'Mine' });
    await vi.waitFor(() => expect(p.requests('agent.agents.subscribe')).toHaveLength(2));
    expect(p.requests('agent.agents.subscribe')[1].payload).toEqual({ eventType: 'news' });
  });

  it('answers for its new id if Harbor gave it a different one', async () => {
    const p = await registeredPage('agent-mine');
    p.deliver({ pageRestored: true });
    await vi.waitFor(() => expect(p.requests('agent.agents.register')).toHaveLength(2));
    answer(p, 'agent.agents.register', { id: 'agent-new', name: 'Mine' });
    // The page takes the new id once the register call resolves.
    await new Promise((r) => setTimeout(r, 0));

    p.deliver(invocation('agent-new', 'inv-new'));
    await vi.waitFor(() => expect(p.invocationResponses()).toHaveLength(1));
    expect(p.invocationResponses()[0]).toMatchObject({ invocationId: 'inv-new', success: true });

    p.deliver(invocation('agent-mine', 'inv-old'));
    await vi.waitFor(() => expect(p.invocationResponses()).toHaveLength(2));
    expect(p.invocationResponses()[1]).toMatchObject({ invocationId: 'inv-old', success: false });
  });
});

describe('a page restored from the back/forward cache, mid-invocation', () => {
  it("aborts the signal of an invocation it was handling when it left, since Harbor already failed it", async () => {
    const p = page();
    const registering = p.window.agent.agents.register({ name: 'Mine', acceptsInvocations: true });
    await vi.waitFor(() => expect(p.requests('agent.agents.register')).toHaveLength(1));
    answer(p, 'agent.agents.register', { id: 'agent-mine', name: 'Mine' });
    await registering;
    let seen;
    p.window.agent.agents.onInvoke((request) => { seen = request; return new Promise(() => {}); });
    p.deliver(invocation('agent-mine', 'inv-frozen'));
    await vi.waitFor(() => expect(seen).toBeDefined());

    p.deliver({ pageRestored: true });
    expect(seen.signal.aborted).toBe(true);
  });
});

describe('a page restored from the back/forward cache, with MCP servers', () => {
  it('registers its MCP servers again with the same options', async () => {
    const p = page();
    const registering = p.window.agent.mcp.register({ url: 'http://localhost:3001/mcp', name: 'Shop', transport: 'sse' });
    await vi.waitFor(() => expect(p.requests('agent.mcp.register')).toHaveLength(1));
    answer(p, 'agent.mcp.register', { success: true, serverId: 'site:localhost:Shop', tools: [] });
    await registering;

    p.deliver({ pageRestored: true });
    await vi.waitFor(() => expect(p.requests('agent.mcp.register')).toHaveLength(2));
    expect(p.requests('agent.mcp.register')[1].payload).toEqual({ url: 'http://localhost:3001/mcp', name: 'Shop', transport: 'sse' });
  });

  it("doesn't register a server again once the page unregistered it", async () => {
    const p = page();
    const registering = p.window.agent.mcp.register({ url: 'http://localhost:3001/mcp', name: 'Shop' });
    await vi.waitFor(() => expect(p.requests('agent.mcp.register')).toHaveLength(1));
    answer(p, 'agent.mcp.register', { success: true, serverId: 'site:localhost:Shop', tools: [] });
    await registering;
    const unregistering = p.window.agent.mcp.unregister('site:localhost:Shop');
    await vi.waitFor(() => expect(p.requests('agent.mcp.unregister')).toHaveLength(1));
    answer(p, 'agent.mcp.unregister', { success: true });
    await unregistering;

    p.deliver({ pageRestored: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(p.requests('agent.mcp.register')).toHaveLength(1);
  });
});

describe("a page's message and event handlers", () => {
  it("never see a message for another page's agent", async () => {
    const p = await registeredPage('agent-mine');
    const onMessage = vi.fn();
    p.window.agent.agents.onMessage(onMessage);
    p.deliver({ agentEvent: { type: 'message', message: { id: 'm1', from: 'x', to: 'agent-old-page', payload: 1 } } });
    p.deliver({ agentEvent: { type: 'message', message: { id: 'm2', from: 'x', to: 'agent-mine', payload: 2 } } });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage.mock.calls[0][0].id).toBe('m2');
  });

  it("never see a broadcast for another page's agent", async () => {
    const p = await registeredPage('agent-mine');
    const onNews = vi.fn();
    const subscribing = p.window.agent.agents.subscribe('news', onNews);
    await vi.waitFor(() => expect(p.requests('agent.agents.subscribe')).toHaveLength(1));
    answer(p, 'agent.agents.subscribe', null);
    await subscribing;

    p.deliver({ agentEvent: { type: 'broadcast', agentId: 'agent-old-page', broadcast: { type: 'news', data: 1, source: 'x' } } });
    p.deliver({ agentEvent: { type: 'broadcast', agentId: 'agent-mine', broadcast: { type: 'news', data: 2, source: 'x' } } });
    await vi.waitFor(() => expect(onNews).toHaveBeenCalledTimes(1));
    expect(onNews.mock.calls[0][0].data).toBe(2);
  });
});

describe('an invocation the caller stops waiting for', () => {
  it("aborts the handler's request.signal, and the page sends no answer", async () => {
    const p = page();
    const registering = p.window.agent.agents.register({ name: 'Mine', acceptsInvocations: true });
    await vi.waitFor(() => expect(p.requests('agent.agents.register')).toHaveLength(1));
    answer(p, 'agent.agents.register', { id: 'agent-mine', name: 'Mine' });
    await registering;

    let seen;
    let finish;
    p.window.agent.agents.onInvoke((request) => { seen = request; return new Promise((r) => { finish = r; }); });
    p.deliver(invocation('agent-mine', 'inv-c'));
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen.signal.aborted).toBe(false);

    p.deliver({ agentEvent: { type: 'invocationCancel', invocationId: 'inv-c' } });
    expect(seen.signal.aborted).toBe(true);
    finish('too late');
    await new Promise((r) => setTimeout(r, 0));
    expect(p.invocationResponses()).toHaveLength(0);
  });
});
