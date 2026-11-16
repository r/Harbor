/**
 * Page-facing llm / mcp / session calls forwarded by the Web Agents API go
 * through the PolicyEngine (HBR-7): every call is audited, denies are
 * enforced, ask/preview proceed on the Web Agents API's consent without a
 * second Harbor prompt, and calls without an origin are rejected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequest, bridgeStreamRequest } from '../llm/bridge-client';
import { callTool } from '../mcp/host';
import { initializeExtensionApi, routeExtensionApiMessage } from '../extension-api';
import { browserAPI } from '../browser-compat';
import { Audit } from '../policy/audit';
import { setOriginGrantResolver } from '../policy/engine';
import { showPermissionPrompt } from '../policy/permissions';
import { SessionRegistry } from '../sessions';

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({ callTool: vi.fn(), listTools: vi.fn(), listServersWithStatus: vi.fn() }));
vi.mock('../agents/background-router', () => ({ routeExternalMessage: vi.fn() }));
vi.mock('../llm/native-bridge', () => ({}));
vi.mock('../llm/provider-registry', () => ({}));
vi.mock('../sessions', () => ({
  SessionRegistry: {
    subscribe: vi.fn(),
    createExplicitSession: vi.fn(() => ({ success: true, sessionId: 's1', capabilities: {} })),
  },
}));
vi.mock('../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/permissions')>()),
  showPermissionPrompt: vi.fn(),
}));

const ORIGIN = 'https://page.example';
const messages = [{ role: 'user', content: 'Hi' }];

beforeEach(() => {
  vi.clearAllMocks();
  Audit.clear();
  setOriginGrantResolver(() => null);
  vi.mocked(bridgeRequest).mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], model: 'ollama:test' });
  vi.mocked(callTool).mockResolvedValue({ ok: true, result: 'tick' } as never);
});
afterEach(() => setOriginGrantResolver(() => null));

describe('page-facing calls go through the PolicyEngine', () => {
  it('audits a page llm.chat under the forwarded origin', async () => {
    const res = await routeExtensionApiMessage(
      { type: 'llm.chat', payload: { origin: ORIGIN, tabId: 7, messages, model: 'ollama:test' } },
      {},
    );
    expect(res.ok).toBe(true);
    const records = Audit.query({ origin: ORIGIN });
    expect(records.map(r => r.action)).toEqual(['model.prompt.local']);
  });

  it('rejects llm.chat and mcp.callTool without an origin, before doing any work', async () => {
    const chat = await routeExtensionApiMessage({ type: 'llm.chat', payload: { messages } }, {});
    const tool = await routeExtensionApiMessage(
      { type: 'mcp.callTool', payload: { serverId: 'clock', toolName: 'now', args: {} } },
      {},
    );
    expect(chat.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(bridgeRequest).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('enforces an origin deny on mcp.callTool and records it', async () => {
    setOriginGrantResolver((origin, action) =>
      origin === ORIGIN && action === 'tool.call' ? { effect: 'deny' } : null,
    );
    const res = await routeExtensionApiMessage(
      { type: 'mcp.callTool', payload: { origin: ORIGIN, serverId: 'clock', toolName: 'now', args: {} } },
      {},
    );
    expect(res.ok).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    const [record] = Audit.query({ origin: ORIGIN });
    expect(record).toMatchObject({ action: 'tool.call', effect: 'deny', resource: { server: 'clock', tool: 'now' } });
  });

  it('proceeds on ask/preview without a Harbor prompt, recording the upstream consent', async () => {
    const res = await routeExtensionApiMessage(
      { type: 'mcp.callTool', payload: { origin: ORIGIN, serverId: 'clock', toolName: 'now', args: {} } },
      {},
    );
    expect(res.ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith('clock', 'now', {});
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    const [record] = Audit.query({ origin: ORIGIN });
    expect(record.effect).toBe('preview');
    expect(record.consent).toBe('web-agents-api');
  });

  it('records an agent.run-shaped sequence in order: prompt, tool, prompt', async () => {
    const send = (type: string, payload: Record<string, unknown>) =>
      routeExtensionApiMessage({ type: type as never, payload: { origin: ORIGIN, ...payload } }, {});
    await send('mcp.listTools', {});
    await send('llm.chat', { messages, model: 'ollama:test' });
    await send('mcp.callTool', { serverId: 'clock', toolName: 'now', args: {} });
    await send('llm.chat', { messages, model: 'ollama:test' });
    expect(Audit.query({ origin: ORIGIN }).map(r => r.action)).toEqual([
      'tool.list',
      'model.prompt.local',
      'tool.call',
      'model.prompt.local',
    ]);
  });

  it('treats a non-local provider as a first-party remote prompt', async () => {
    await routeExtensionApiMessage(
      { type: 'llm.chat', payload: { origin: ORIGIN, messages, model: 'openai:gpt-x' } },
      {},
    );
    expect(Audit.query({ origin: ORIGIN })[0].action).toBe('model.prompt.remote.firstParty');
  });

  it('gates session.create by the capabilities it requests', async () => {
    setOriginGrantResolver((_o, action) => (action === 'tool.call' ? { effect: 'deny' } : null));
    const res = await routeExtensionApiMessage(
      {
        type: 'session.create',
        payload: {
          origin: ORIGIN,
          options: { capabilities: { llm: { model: 'openai:gpt-x' }, tools: ['clock/now'], browser: ['read'] } },
        },
      },
      {},
    );
    expect(res.ok).toBe(false);
    expect(SessionRegistry.createExplicitSession).not.toHaveBeenCalled();
    expect(Audit.query({ origin: ORIGIN }).map(r => [r.action, r.effect])).toEqual([
      ['model.prompt.remote.firstParty', 'ask'],
      ['tool.call', 'deny'],
    ]);
  });
});

describe('page-facing streaming chat goes through the PolicyEngine', () => {
  async function stream(payload: Record<string, unknown>) {
    let connect: ((port: unknown) => void) | undefined;
    const runtime = browserAPI.runtime as unknown as Record<string, unknown>;
    runtime.onMessageExternal = { addListener: vi.fn() };
    runtime.onConnectExternal = { addListener: (l: typeof connect) => { connect = l; } };
    initializeExtensionApi();
    let onMessage: ((message: unknown) => void) | undefined;
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const postMessage = vi.fn(() => complete());
    connect!({
      sender: { id: 'web-agents@krikorian.co' },
      onMessage: { addListener: (l: typeof onMessage) => { onMessage = l; } },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
    });
    vi.mocked(bridgeStreamRequest).mockImplementation(async function* () {
      yield { id: 's1', type: 'done', finish_reason: 'stop' };
    });
    onMessage!({ type: 'llm.chatStream', requestId: 'r1', payload: { messages, model: 'ollama:test', ...payload } });
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 200))]);
    return postMessage;
  }

  it('rejects a stream without an origin', async () => {
    const posted = await stream({});
    expect(bridgeStreamRequest).not.toHaveBeenCalled();
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1', event: expect.objectContaining({ type: 'error' }) }));
  });

  it('enforces an origin deny on a stream', async () => {
    setOriginGrantResolver(() => ({ effect: 'deny' }));
    const posted = await stream({ origin: ORIGIN });
    expect(bridgeStreamRequest).not.toHaveBeenCalled();
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1', event: expect.objectContaining({ type: 'error' }) }));
    expect(Audit.query({ origin: ORIGIN })[0]).toMatchObject({ action: 'model.prompt.local', effect: 'deny' });
  });

  it('answers the port with an error, not silence, when the gate itself fails', async () => {
    setOriginGrantResolver(() => { throw new Error('resolver boom'); });
    const posted = await stream({ origin: ORIGIN });
    expect(bridgeStreamRequest).not.toHaveBeenCalled();
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1', event: expect.objectContaining({ type: 'error' }) }));
  });
});
