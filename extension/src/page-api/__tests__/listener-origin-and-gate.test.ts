/**
 * With the Web Agents API folded in, a page's origin must come from the
 * connecting port's sender — never from the message payload a page (or a
 * compromised content script) could forge — and a page call reaches the
 * real policy gate in-process, the same as a forwarded cross-extension call
 * does today.
 *
 * This drives the captured `runtime.onConnect` listener directly (not the
 * router), per docs/agent-workflow.md's "Test a new cross-extension message
 * through the listener, not the router" pitfall, adapted here for the
 * in-process port that replaces it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import type { grantPermissions as GrantPermissions } from '../../policy/permissions';
import type { Audit as AuditType } from '../../policy/audit';

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
    setMode: vi.fn(),
    recordPrompt: vi.fn(),
    recordToolCall: vi.fn(),
    recordBrowserAccess: vi.fn(),
    touchSession: vi.fn(),
  },
}));

type Listener = (port: unknown) => void;

let onConnect: Listener;
let grantPermissions: typeof GrantPermissions;
let Audit: typeof AuditType;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();

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

  // Import everything (background.ts and the policy modules it transitively
  // reaches) from the SAME fresh module graph after resetModules(), so the
  // Audit singleton this test reads is the one requireAction() just wrote
  // to, not a stale one captured at file-load time.
  const { initializePageApi } = await import('../background');
  ({ grantPermissions } = await import('../../policy/permissions'));
  ({ Audit } = await import('../../policy/audit'));
  Audit.clear();

  initializePageApi();
});

afterEach(() => {
  vi.resetModules();
});

interface TestPort {
  send: (message: unknown) => void;
  posted: Array<{ id?: string; ok: boolean; result?: unknown; error?: { message: string } }>;
}

function connectPort(senderUrl: string, tabId = 9): TestPort {
  const messageListeners: Array<(m: unknown) => void> = [];
  const posted: TestPort['posted'] = [];
  const port = {
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId } },
    onMessage: { addListener: (l: (m: unknown) => void) => messageListeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: TestPort['posted'][number]) => posted.push(m),
  };
  onConnect(port);
  return {
    send: (message: unknown) => messageListeners.forEach((l) => l(message)),
    posted,
  };
}

describe('origin comes from the sender, never the message', () => {
  it("reports a.example's real grants even though the message claims a different origin", async () => {
    await grantPermissions('https://a.example', ['model:prompt'], 'granted-always');

    const { send, posted } = connectPort('https://a.example/page');
    send({ id: 'r1', type: 'agent.permissions.list', payload: {}, origin: 'https://evil.example' });

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const reply = posted[0];
    expect(reply.ok).toBe(true);
    const result = reply.result as { origin: string; scopes: Record<string, string> };
    expect(result.origin).toBe('https://a.example');
    expect(result.scopes['model:prompt']).toBe('granted-always');
  });

  it('never grants evil.example from the message, even unauthenticated', async () => {
    const { send, posted } = connectPort('https://a.example/page');
    send({ id: 'r1', type: 'agent.permissions.list', payload: {}, origin: 'https://evil.example' });

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const result = posted[0].result as { scopes: Record<string, string> };
    // a.example never had model:prompt granted in this test; evil.example's
    // claim must not leak a grant that belongs to a different origin either.
    expect(result.scopes['model:prompt']).not.toBe('granted-always');
  });
});

describe('page calls through harbor-core reach the real policy gate', () => {
  it('an llm.chat without a grant is denied and audited under the real origin', async () => {
    const { harborRequest } = await import('../harbor-core');
    await expect(
      harborRequest('llm.chat', {
        origin: 'https://b.example',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow();

    const records = Audit.query({ origin: 'https://b.example' });
    expect(records.length).toBeGreaterThan(0);
  });
});
