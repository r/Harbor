/**
 * An invocation reaches a page's `onInvoke` handlers only for an agent that
 * page registered. Just after a tab's page is replaced, Harbor can still
 * deliver an invocation meant for the old page's agent to the tab; the new
 * page, which may be another site, must not see the caller's task or input,
 * and answers ERR_AGENT_NOT_FOUND so the caller hears at once.
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
    setTimeout, clearTimeout, Map, Set, Date, Math,
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
