/**
 * Prompting a text session needs a live `model:prompt` grant, not just the
 * one the site held when it created the session. Revoking the site's
 * permissions, or letting a one-time grant expire, must stop the next prompt
 * on a session the site already has open.
 *
 * Drives the page port listener with Harbor's real permission store, so the
 * grant, the revocation and the expiry are the ones a user would cause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import type {
  grantPermissions as GrantPermissions,
  revokePermissions as RevokePermissions,
} from '../../policy/permissions';

const bridge = vi.hoisted(() => ({
  bridgeChat: vi.fn(),
  bridgeStreamRequest: vi.fn(),
}));

vi.mock('../../llm/chat', () => ({ bridgeChat: bridge.bridgeChat }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: bridge.bridgeStreamRequest,
  getBridgeConnectionState: vi.fn(() => ({ connected: true, bridgeReady: true, error: undefined })),
  checkBridgeHealth: vi.fn(async () => true),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => true), rpcRequest: vi.fn() }));
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
    setMode: vi.fn(),
    recordPrompt: vi.fn(),
    // As the real registry does for a session without maxToolCalls.
    reserveToolCall: vi.fn(() => true),
    releaseToolCall: vi.fn(),
    commitToolCall: vi.fn(),
    getRemainingToolBudget: vi.fn(() => undefined),
    touchSession: vi.fn(),
  },
}));

type Listener = (port: unknown) => void;
interface Posted {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message: string };
  event?: { type: string; token?: string; error?: { code?: string; message: string } };
  done?: boolean;
}

const ORIGIN = 'https://site.example';
const TAB = 9;
/** Matches ONCE_GRANT_DURATION_MS in policy/permissions.ts. */
const ONCE_GRANT_MS = 10 * 60 * 1000;

let onConnect: Listener;
let grantPermissions: typeof GrantPermissions;
let revokePermissions: typeof RevokePermissions;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();

  bridge.bridgeChat.mockResolvedValue({ content: 'Hello', model: 'test-model' });
  bridge.bridgeStreamRequest.mockImplementation(async function* () {
    yield { type: 'token', token: 'Hel' };
    yield { type: 'token', token: 'lo' };
    yield { type: 'done' };
  });

  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: Listener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async () => { throw new Error('no tab'); }),
  };

  const { initializePageApi } = await import('../background');
  ({ grantPermissions, revokePermissions } = await import('../../policy/permissions'));
  initializePageApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function connectPort(tab = TAB) {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Posted[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: `${ORIGIN}/app`, tab: { id: tab } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Posted) => posted.push(m),
  });

  /** Send a request and wait for its single reply. */
  async function request(id: string, type: string, payload: unknown): Promise<Posted> {
    listeners.forEach((l) => l({ id, type, payload }));
    await vi.waitFor(() => expect(posted.find((m) => m.id === id)).toBeDefined());
    return posted.find((m) => m.id === id)!;
  }

  /** Send a streaming request and wait for its final event. */
  async function stream(id: string, type: string, payload: unknown): Promise<Posted[]> {
    listeners.forEach((l) => l({ id, type, payload }));
    await vi.waitFor(() => expect(posted.find((m) => m.id === id && m.done)).toBeDefined());
    return posted.filter((m) => m.id === id);
  }

  return { request, stream };
}

async function openSession(port: ReturnType<typeof connectPort>): Promise<string> {
  const created = await port.request('c1', 'ai.createTextSession', {});
  expect(created).toMatchObject({ ok: true });
  return created.result as string;
}

describe('a revoked model:prompt grant stops prompts on an open session', () => {
  it('session.prompt is refused after the site is revoked', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    const port = connectPort();
    const sessionId = await openSession(port);

    expect(await port.request('p1', 'session.prompt', { sessionId, input: 'Hi' }))
      .toMatchObject({ ok: true, result: 'Hello' });
    expect(bridge.bridgeChat).toHaveBeenCalledTimes(1);

    await revokePermissions(ORIGIN);

    const denied = await port.request('p2', 'session.prompt', { sessionId, input: 'Again' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(bridge.bridgeChat).toHaveBeenCalledTimes(1);
  });

  it('session.promptStreaming is refused after the site is revoked', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    const port = connectPort();
    const sessionId = await openSession(port);

    const first = await port.stream('s1', 'session.promptStreaming', { sessionId, input: 'Hi' });
    expect(first.filter((m) => m.event?.type === 'token').map((m) => m.event?.token).join('')).toBe('Hello');
    expect(first.at(-1)?.event?.type).toBe('done');
    expect(bridge.bridgeStreamRequest).toHaveBeenCalledTimes(1);

    await revokePermissions(ORIGIN);

    const denied = await port.stream('s2', 'session.promptStreaming', { sessionId, input: 'Again' });
    expect(denied).toHaveLength(1);
    expect(denied[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(bridge.bridgeStreamRequest).toHaveBeenCalledTimes(1);
  });

  it('session.prompt is refused once a one-time grant expires', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-once', TAB);
    const port = connectPort();
    const sessionId = await openSession(port);

    expect(await port.request('p1', 'session.prompt', { sessionId, input: 'Hi' }))
      .toMatchObject({ ok: true });

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + ONCE_GRANT_MS + 1000);

    const denied = await port.request('p2', 'session.prompt', { sessionId, input: 'Later' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(bridge.bridgeChat).toHaveBeenCalledTimes(1);
  });

  it('a one-time grant for one tab does not cover prompts from another tab', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-once', TAB);
    const sessionId = await openSession(connectPort(TAB));

    const otherTab = connectPort(TAB + 1);
    const denied = await otherTab.request('p1', 'session.prompt', { sessionId, input: 'Hi' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(bridge.bridgeChat).not.toHaveBeenCalled();
  });
});
