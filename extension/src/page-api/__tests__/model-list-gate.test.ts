/**
 * A page's model-listing calls (window.ai.providers.*) go through Harbor's
 * policy engine as `model.list`, like its other model and tool calls: they
 * need the site's model:list grant, are audited under its origin, and a deny
 * rule refuses them. Router message types no page handler sends are refused
 * as unknown.
 *
 * This drives the real page port, harbor-core's dispatch and the real
 * policy gate. Only the bridge, the MCP host and the prompt window are
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

const host = vi.hoisted(() => ({ callTool: vi.fn() }));

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: false, bridgeReady: false, error: undefined })),
  checkBridgeHealth: vi.fn(async () => false),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: host.callTool,
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => false), rpcRequest: vi.fn() }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []),
  getRuntimeCapabilities: vi.fn(async () => ({})),
}));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(),
}));

type Listener = (port: unknown) => void;
type Reply = { id?: string; ok: boolean; result?: unknown; error?: { code?: string; message: string } };

const ORIGIN = 'https://a.example';
let onConnect: Listener;
let bridgeRequest: ReturnType<typeof vi.fn>;

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

  const { initializePageApi } = await import('../background');
  bridgeRequest = vi.mocked((await import('../../llm/bridge-client')).bridgeRequest);
  bridgeRequest.mockImplementation(async (method: string) => ({
    'llm.list_providers': { providers: [{ id: 'ollama' }] },
    'llm.get_config': { default_model: 'ollama:llama3', providers: {} },
    'llm.list_configured_models': { models: [{ name: 'llama', model_id: 'ollama:llama3' }] },
    'llm.get_configured_models_metadata': { metadata: [{ model_id: 'ollama:llama3', is_local: true }] },
  } as Record<string, unknown>)[method] ?? {});
  initializePageApi();
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  vi.resetModules();
});

async function grant(scopes: string[]) {
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, scopes as never, 'granted-always');
}

async function loadRules(rules: Array<Record<string, unknown>>) {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map(r => compileRule({ source: 'user', ...r } as never)));
}

async function auditedActions() {
  const { Audit } = await import('../../policy/audit');
  return Audit.query({ origin: ORIGIN }).map((r) => r.action);
}

function connectPort(senderUrl: string) {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Reply[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: 9 } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Reply) => posted.push(m),
  });
  let n = 0;
  return async (type: string, payload: unknown = {}): Promise<Reply> => {
    const id = `r${++n}`;
    listeners.forEach(l => l({ id, type, payload }));
    await vi.waitFor(() => expect(posted.some(p => p.id === id)).toBe(true));
    return posted.find(p => p.id === id)!;
  };
}

const MODEL_LISTING = [
  'ai.providers.list',
  'ai.providers.getActive',
  'ai.providers.listConfiguredModels',
  'ai.providers.getConfiguredModelsMetadata',
];

describe("a page's model-listing calls go through the policy engine", () => {
  it.each(MODEL_LISTING)('%s is audited as model.list under the page origin', async (type) => {
    await grant(['model:list']);
    const request = connectPort(`${ORIGIN}/page`);
    const reply = await request(type);
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(await auditedActions()).toEqual(['model.list']);
  });

  it.each(MODEL_LISTING)('%s is refused by a deny rule, without asking the bridge', async (type) => {
    await grant(['model:list']);
    await loadRules([{ id: 'no-listing', effect: 'deny', principal: { origin: '*' }, action: 'model.list' }]);
    const request = connectPort(`${ORIGIN}/page`);
    const reply = await request(type);
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_BLOCKED_BY_POLICY');
    expect(bridgeRequest).not.toHaveBeenCalled();
  });

  it.each(MODEL_LISTING)('%s needs the model:list grant', async (type) => {
    const request = connectPort(`${ORIGIN}/page`);
    const reply = await request(type);
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(bridgeRequest).not.toHaveBeenCalled();
  });
});

describe('router message types no page handler sends', () => {
  it.each([
    'llm.configureProvider',
    'llm.listModels',
    'mcp.listServers',
    'mcp.startServer',
    'mcp.stopServer',
    'session.createImplicit',
    'system.health',
    'system.getVersion',
  ])('%s is refused as an unknown message type', async (type) => {
    const { harborRequest } = await import('../harbor-core');
    await expect(harborRequest(type, { origin: ORIGIN })).rejects.toThrow(/Unknown message type/);
  });
});
