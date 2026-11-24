/**
 * Example multi-agent test using the Web Agent API mock.
 * Run with: npx vitest run example.multi-agent.test.mjs
 *
 * The flow: this page registers as an agent, finds another agent by
 * capability, invokes it, and messages it. `mock.agents.addAgent()` stands
 * in for an agent registered by another tab on the same site.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installWebAgentsMock } from './mock.js';

describe('multi-agent flow against the mock', () => {
  let mock;
  let summarizer;
  const received = [];

  beforeEach(() => {
    mock = installWebAgentsMock(globalThis);
    // The user allows whatever the page asks for, and has turned on Harbor's
    // multiAgent feature (it's off by default).
    mock.permissions.grantAll();
    mock.agents.featureEnabled = true;
    received.length = 0;
    summarizer = mock.agents.addAgent(
      { name: 'Summarizer', capabilities: ['summarize'], acceptsInvocations: true, acceptsMessages: true },
      {
        onInvoke: async ({ task, input }) => ({ task, summary: `short: ${input.text}` }),
        onMessage: (message) => received.push(message),
      },
    );
  });

  afterEach(() => {
    mock.uninstall();
  });

  it('lists basic same-origin entries without a discovery grant', async () => {
    const entries = await globalThis.agent.agents.list();
    expect(entries).toEqual([{ id: summarizer.id, name: 'Summarizer', status: 'active' }]);
  });

  it('registers, discovers, invokes and messages another agent', async () => {
    const { agent } = globalThis;
    const permission = await agent.requestPermissions({
      scopes: ['agents:register', 'agents:discover', 'agents:invoke', 'agents:message'],
      reason: 'Hand the article to a summarizer',
    });
    expect(permission.granted).toBe(true);

    const me = await agent.agents.register({ name: 'Writer', capabilities: ['write'] });
    expect(me.status).toBe('active');

    const { agents, total } = await agent.agents.discover({ capabilities: ['summarize'] });
    expect(total).toBe(1);
    expect(agents[0]).toMatchObject({ id: summarizer.id, name: 'Summarizer', sameOrigin: true });

    const response = await agent.agents.invoke(agents[0].id, { task: 'summarize', input: { text: 'long article' } });
    expect(response.success).toBe(true);
    expect(response.result).toEqual({ task: 'summarize', summary: 'short: long article' });
    // Harbor says which site's agent answered.
    expect(response.provenance).toEqual({ source: 'agent', origin: 'http://localhost', agentId: summarizer.id });

    const sent = await agent.agents.send(summarizer.id, { hello: 'there' });
    expect(sent.delivered).toBe(true);
    expect(received[0]).toMatchObject({ from: me.id, to: summarizer.id, payload: { hello: 'there' } });
  });

  it('grants only the scopes the page asked for', async () => {
    const { agent } = globalThis;
    const permission = await agent.requestPermissions({ scopes: ['model:prompt'] });
    expect(permission.scopes['model:prompt']).toBe('granted-always');
    expect(permission.scopes['agents:register']).toBe('not-granted');

    await expect(agent.agents.register({ name: 'Writer' })).rejects.toMatchObject({ code: 'ERR_SCOPE_REQUIRED' });
  });

  it('finds the page\'s own agent too, and forgets it after unregister', async () => {
    const { agent } = globalThis;
    await agent.requestPermissions({ scopes: ['agents:register', 'agents:discover'] });
    const me = await agent.agents.register({ name: 'Writer', capabilities: ['write'] });

    expect((await agent.agents.discover({ capabilities: ['write'] })).agents.map((a) => a.id)).toEqual([me.id]);
    expect((await agent.agents.getInfo(me.id))?.name).toBe('Writer');

    await agent.agents.unregister();
    expect((await agent.agents.discover({ capabilities: ['write'] })).total).toBe(0);
    expect(await agent.agents.getInfo(me.id)).toBeNull();
  });

  it('checks the request before the scope, as Harbor does', async () => {
    const { agent } = globalThis;
    await expect(agent.agents.register({})).rejects.toMatchObject({ code: 'ERR_INVALID_REQUEST' });
    await expect(agent.agents.invoke(summarizer.id)).rejects.toMatchObject({ code: 'ERR_INVALID_REQUEST' });
  });

  it('reports an unknown agent in the invoke response', async () => {
    const { agent } = globalThis;
    await agent.requestPermissions({ scopes: ['agents:register', 'agents:invoke'] });
    await agent.agents.register({ name: 'Writer' });
    const response = await agent.agents.invoke('agent-nope', { task: 'summarize' });
    expect(response).toMatchObject({ success: false, error: { code: 'ERR_AGENT_NOT_FOUND' } });
  });

  it('reports an agent whose handler throws as its own failed answer', async () => {
    const { agent } = globalThis;
    await agent.requestPermissions({ scopes: ['agents:register', 'agents:invoke'] });
    await agent.agents.register({ name: 'Writer' });
    const broken = mock.agents.addAgent({ name: 'Broken' }, { onInvoke: () => { throw new Error('nope'); } });
    const response = await agent.agents.invoke(broken.id, { task: 'x' });
    expect(response).toMatchObject({ success: false, error: { code: 'ERR_HANDLER_FAILED', message: 'nope' } });
    expect(response.provenance).toEqual({ source: 'agent', origin: 'http://localhost', agentId: broken.id });
  });

  it('requires registering before invoking another agent', async () => {
    const { agent } = globalThis;
    await agent.requestPermissions({ scopes: ['agents:invoke'] });
    await expect(agent.agents.invoke(summarizer.id, { task: 'summarize' })).rejects.toMatchObject({
      code: 'ERR_NOT_REGISTERED',
    });
  });

  it('answers an invocation from another agent with the page\'s onInvoke handler', async () => {
    const { agent } = globalThis;
    await agent.requestPermissions({ scopes: ['agents:register'] });
    await agent.agents.register({ name: 'Writer', acceptsInvocations: true });
    agent.agents.onInvoke(async ({ task, from }) => `${task} done for ${from}`);

    const response = await mock.agents.invokePage(summarizer.id, { task: 'draft' });
    expect(response).toMatchObject({ success: true, result: `draft done for ${summarizer.id}` });
  });

  it('fails like Harbor when the multiAgent feature is off', async () => {
    mock.agents.featureEnabled = false;
    await expect(globalThis.agent.agents.discover()).rejects.toMatchObject({ code: 'ERR_FEATURE_DISABLED' });
  });
});
