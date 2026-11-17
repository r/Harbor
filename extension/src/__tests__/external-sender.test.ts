import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequest } from '../llm/bridge-client';
import { routeExternalMessage } from '../agents/background-router';
import { initializeExtensionApi } from '../extension-api';
import { browserAPI } from '../browser-compat';

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({}));
vi.mock('../agents/background-router', () => ({ routeExternalMessage: vi.fn() }));
vi.mock('../llm/native-bridge', () => ({}));
vi.mock('../llm/provider-registry', () => ({}));
vi.mock('../sessions', () => ({ SessionRegistry: { subscribe: vi.fn() } }));

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
type ConnectListener = (port: unknown) => void;

const WEB_AGENTS_FIREFOX = 'web-agents@krikorian.co';
const WEB_AGENTS_CHROME = 'ogmmelahbpdfnmgemkcbpoaekdnfdapn';

let onMessageExternal: Listener;
let onConnectExternal: ConnectListener;

beforeEach(() => {
  vi.clearAllMocks();
  const runtime = browserAPI.runtime as unknown as Record<string, unknown>;
  runtime.onMessageExternal = { addListener: (l: Listener) => { onMessageExternal = l; } };
  runtime.onConnectExternal = { addListener: (l: ConnectListener) => { onConnectExternal = l; } };
  initializeExtensionApi();
});

function send(message: unknown, sender: unknown) {
  const sendResponse = vi.fn();
  onMessageExternal(message, sender, sendResponse);
  return sendResponse;
}

function connect(sender: unknown) {
  const port = {
    name: 'harbor-stream', sender,
    onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() },
    postMessage: vi.fn(), disconnect: vi.fn(),
  };
  onConnectExternal(port);
  return port;
}

describe('Harbor accepts cross-extension messages only from the Web Agents API', () => {
  it.each([
    ['an unknown extension', { id: 'someone-else@example.com' }],
    ['a sender with no id', { url: 'https://example.com/' }],
    ['a sender that was retired', { id: 'raffi.krikorian.harbor@gmail.com' }],
  ])('rejects llm.* from %s without reaching the bridge', async (_label, sender) => {
    const sendResponse = send({ type: 'llm.chat', payload: { messages: [{ role: 'user', content: 'Hi' }], model: 'ollama:test' } }, sender);
    await Promise.resolve();
    expect(bridgeRequest).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('rejects agent.* from an unknown extension before reading its claimed origin', () => {
    const sendResponse = send(
      { type: 'agent.run', payload: { origin: 'https://bank.example', task: 'x' } },
      { id: 'someone-else@example.com' },
    );
    expect(routeExternalMessage).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it.each([WEB_AGENTS_FIREFOX, WEB_AGENTS_CHROME])('routes agent.* from %s', (id) => {
    send({ type: 'agent.run', payload: { task: 'x' } }, { id });
    expect(routeExternalMessage).toHaveBeenCalledOnce();
  });

  it.each([WEB_AGENTS_FIREFOX, WEB_AGENTS_CHROME])('routes llm.* from %s to the bridge', async (id) => {
    vi.mocked(bridgeRequest).mockResolvedValue({ choices: [] });
    send({ type: 'llm.chat', payload: { origin: 'https://page.example', messages: [{ role: 'user', content: 'Hi' }], model: 'ollama:test' } }, { id });
    await vi.waitFor(() => expect(bridgeRequest).toHaveBeenCalledOnce());
  });

  it('disconnects a port from an unknown extension without listening to it', () => {
    const port = connect({ id: 'someone-else@example.com' });
    expect(port.disconnect).toHaveBeenCalled();
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('disconnects a port with no sender id', () => {
    const port = connect(undefined);
    expect(port.disconnect).toHaveBeenCalled();
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });

  it.each([WEB_AGENTS_FIREFOX, WEB_AGENTS_CHROME])('accepts a port from %s', (id) => {
    const port = connect({ id });
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(port.onMessage.addListener).toHaveBeenCalledOnce();
  });
});
