/**
 * Page tools through the real page port: a page's `page_tools.sync` lands in
 * the background registry, a call goes out on the same port and its
 * `page_tools.result` comes back on it, and the tools last exactly as long
 * as the page's document (the port), not as long as its URL stays put.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import type { grantPermissions as GrantPermissions } from '../../policy/permissions';

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: false, bridgeReady: false, error: undefined })),
  checkBridgeHealth: vi.fn(async () => false),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => false), rpcRequest: vi.fn() }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []),
  getRuntimeCapabilities: vi.fn(async () => ({})),
}));
vi.mock('../../sessions', () => ({
  SessionRegistry: {
    subscribe: vi.fn(),
    createExplicitSession: vi.fn(),
    createImplicitSession: vi.fn(),
    getSession: vi.fn(),
    getValidatedSession: vi.fn(),
    listSessions: vi.fn(() => []),
    terminateSession: vi.fn(),
    recordPrompt: vi.fn(),
    // As the real registry does for a session without maxToolCalls.
    recordToolCall: vi.fn(() => true),
    touchSession: vi.fn(),
  },
}));

type ConnectListener = (port: unknown) => void;
type UpdatedListener = (tabId: number, changeInfo: { url?: string }) => void;
type RemovedListener = (tabId: number) => void;

let onConnect: ConnectListener;
let onUpdated: UpdatedListener[];
let onRemoved: RemovedListener[];
let registry: typeof import('../../mcp/page-tools');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();
  onUpdated = [];
  onRemoved = [];
  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: ConnectListener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: (l: RemovedListener) => onRemoved.push(l) },
    onUpdated: { addListener: (l: UpdatedListener) => onUpdated.push(l) },
    get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://tale.example/book' })),
    sendMessage: vi.fn(() => Promise.resolve()),
  };
  const { initializePageApi } = await import('../background');
  registry = await import('../../mcp/page-tools');
  initializePageApi();
});

afterEach(() => {
  vi.resetModules();
});

interface TestPort {
  send: (message: unknown) => void;
  disconnect: () => void;
  posted: Array<Record<string, unknown>>;
}

function connectPort(senderUrl: string, tabId: number, frameId = 0): TestPort {
  const messageListeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: TestPort['posted'] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId }, frameId },
    onMessage: { addListener: (l: (m: unknown) => void) => messageListeners.push(l) },
    onDisconnect: { addListener: (l: () => void) => disconnectListeners.push(l) },
    postMessage: (m: Record<string, unknown>) => posted.push(m),
  });
  return {
    send: (message: unknown) => messageListeners.forEach((l) => l(message)),
    disconnect: () => disconnectListeners.forEach((l) => l()),
    posted,
  };
}

let nextId = 0;
async function sync(tab: TestPort, tools: unknown[]): Promise<Record<string, unknown>> {
  const id = `req-${++nextId}`;
  tab.send({ id, type: 'page_tools.sync', payload: { tools } });
  await vi.waitFor(() => expect(tab.posted.some((p) => p.id === id)).toBe(true));
  return tab.posted.find((p) => p.id === id)!;
}

const ORIGIN = 'https://tale.example';
const goTo = { name: 'go_to', description: 'Scroll to an anchor', inputSchema: { type: 'object' } };

describe('page_tools.sync over the page port', () => {
  it('registers the tools for the tab, with the origin from the port', async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    const reply = await sync(tab, [goTo]);
    expect(reply.ok).toBe(true);
    expect(registry.listPageTools(3, ORIGIN)?.tools.map(t => t.name)).toEqual(['go_to']);
  });

  it('answers an invalid list with ok: false and keeps nothing', async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    const reply = await sync(tab, [{ name: 'bad name', description: 'x' }]);
    expect(reply.ok).toBe(false);
    expect(registry.listPageTools(3, ORIGIN)).toBeNull();
  });

  it('ignores a sync from a subframe', async () => {
    const tab = connectPort(`${ORIGIN}/frame`, 3, 2);
    await sync(tab, [goTo]);
    expect(registry.listPageTools(3, ORIGIN)).toBeNull();
  });

  it("a page that never registers a tool leaves the registry empty", () => {
    connectPort(`${ORIGIN}/book`, 3);
    expect(registry.listPageTools(3, ORIGIN)).toBeNull();
  });
});

describe('lifetime', () => {
  it('a same-document hash, pushState or replaceState URL change keeps the tools', async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    await sync(tab, [goTo]);
    for (const url of [`${ORIGIN}/book#p3`, `${ORIGIN}/book/ch2`, `${ORIGIN}/book?plan=abc`]) {
      onUpdated.forEach((l) => l(3, { url }));
    }
    expect(registry.listPageTools(3, ORIGIN)?.tools.map(t => t.name)).toEqual(['go_to']);
  });

  it('the page port disconnecting (reload or navigation) drops them', async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    await sync(tab, [goTo]);
    tab.disconnect();
    expect(registry.listPageTools(3, ORIGIN)).toBeNull();
  });

  it("a reloaded page's old port closing late spares the new page's tools", async () => {
    const oldTab = connectPort(`${ORIGIN}/book`, 3);
    await sync(oldTab, [goTo]);
    const newTab = connectPort(`${ORIGIN}/book`, 3);
    await sync(newTab, [{ ...goTo, name: 'reading_position' }]);
    oldTab.disconnect();
    expect(registry.listPageTools(3, ORIGIN)?.tools.map(t => t.name)).toEqual(['reading_position']);
  });

  it('the tab closing drops them', async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    await sync(tab, [goTo]);
    for (const l of onRemoved) await l(3);
    expect(registry.listPageTools(3, ORIGIN)).toBeNull();
  });
});

describe('calls go out and come back on the page port', () => {
  it('resolves with the result the page sends back', async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    await sync(tab, [goTo]);
    const { generation } = registry.listPageTools(3, ORIGIN)!;
    const result = registry.callPageTool({ tabId: 3, origin: ORIGIN, generation, name: 'go_to', input: { anchor: 'p3' } });
    const call = tab.posted.find((p) => p.type === 'page_tools.call') as { callId: string };
    expect(call).toMatchObject({ name: 'go_to', input: { anchor: 'p3' } });
    tab.send({ type: 'page_tools.result', callId: call.callId, ok: true, result: { at: 'p3' } });
    await expect(result).resolves.toEqual({ at: 'p3' });
  });

  it("another tab's port can't answer the call", async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    const other = connectPort(`${ORIGIN}/book`, 4);
    await sync(tab, [goTo]);
    const { generation } = registry.listPageTools(3, ORIGIN)!;
    const result = registry.callPageTool({ tabId: 3, origin: ORIGIN, generation, name: 'go_to', input: {} });
    const call = tab.posted.find((p) => p.type === 'page_tools.call') as { callId: string };
    other.send({ type: 'page_tools.result', callId: call.callId, ok: true, result: 'forged' });
    tab.send({ type: 'page_tools.result', callId: call.callId, ok: true, result: 'real' });
    await expect(result).resolves.toBe('real');
  });

  it('a call in flight when the page goes away fails with ERR_TOOL_FAILED', async () => {
    const tab = connectPort(`${ORIGIN}/book`, 3);
    await sync(tab, [goTo]);
    const { generation } = registry.listPageTools(3, ORIGIN)!;
    const result = registry.callPageTool({ tabId: 3, origin: ORIGIN, generation, name: 'go_to', input: {} });
    tab.disconnect();
    await expect(result).rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
  });
});
