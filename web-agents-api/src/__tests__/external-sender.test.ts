import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAllPermissions: vi.fn(), revokeOriginPermissions: vi.fn(),
  handleIncomingInvocation: vi.fn(), handleHostRun: vi.fn(),
}));
vi.mock('../harbor-client', () => ({
  harborRequest: vi.fn(), harborStreamRequest: vi.fn(),
  discoverHarbor: async () => null, setHarborExtensionId: vi.fn(), getHarborState: vi.fn(),
}));
vi.mock('../policy/feature-flags', () => ({ getFeatureFlags: vi.fn() }));
vi.mock('../handlers/host-run-handlers', () => ({ handleHostRun: mocks.handleHostRun }));
vi.mock('../handlers', () => ({
  routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: vi.fn(),
  getPermissions: async () => ({ scopes: {} }),
  listAllPermissions: mocks.listAllPermissions, revokeOriginPermissions: mocks.revokeOriginPermissions,
  resolvePromptClosed: vi.fn(), handlePermissionPromptResponse: vi.fn(), getTextSession: vi.fn(),
  restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(),
  isSpawnedTab: vi.fn(), handleIncomingInvocation: mocks.handleIncomingInvocation,
  resolveInvocationResponse: vi.fn(), cleanupAgentsForTab: vi.fn(),
  agentInvocationTabs: new Map([['agent-1', 7]]),
}));

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

const HARBOR_FIREFOX = 'harbor@krikorian.co';
const HARBOR_CHROME = 'ljnciidcajlichemnbohopnlaonhkpgm';
const STRANGER = { id: 'someone-else@example.com' };

let external: Listener[];
let internal: Listener[];

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.listAllPermissions.mockResolvedValue([]);
  mocks.revokeOriginPermissions.mockResolvedValue(undefined);
  mocks.handleIncomingInvocation.mockResolvedValue({ success: true });
  mocks.handleHostRun.mockResolvedValue({ ok: true });
  external = []; internal = [];
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: event() }, windows: { onRemoved: event() },
    runtime: {
      id: 'web-agents@krikorian.co',
      onConnect: event(),
      onMessage: { addListener: (l: Listener) => internal.push(l) },
      onMessageExternal: { addListener: (l: Listener) => external.push(l) },
    },
  });
  await import('../background');
});
afterEach(() => vi.unstubAllGlobals());

/** Deliver a message to every listener, as the browser does. */
function deliver(listeners: Listener[], message: unknown, sender: unknown) {
  const sendResponse = vi.fn();
  for (const listener of listeners) listener(message, sender, sendResponse);
  return sendResponse;
}

const forward = (n: number) => ({
  type: 'harbor.forwardInvocation', agentId: 'agent-1',
  request: { from: 'other', task: `task-${n}` }, handlerInfo: { origin: 'https://a.example', tabId: 7 },
});

describe('Web Agents API accepts cross-extension messages only from Harbor', () => {
  it('rejects permission listing from an unknown extension', async () => {
    deliver(external, { type: 'web_agents_permissions.list_all' }, STRANGER);
    deliver(external, { type: 'web_agents_permissions.list_all' }, {});
    await Promise.resolve();
    expect(mocks.listAllPermissions).not.toHaveBeenCalled();
  });

  it('rejects permission revocation from an unknown extension', async () => {
    deliver(external, { type: 'web_agents_permissions.revoke_origin', origin: 'https://a.example' }, STRANGER);
    await Promise.resolve();
    expect(mocks.revokeOriginPermissions).not.toHaveBeenCalled();
  });

  it('rejects forwarded invocations and host runs from an unknown extension', async () => {
    deliver(external, forward(1), STRANGER);
    deliver(internal, forward(2), STRANGER);
    deliver(external, { type: 'agent.host.run', payload: { method: 'x', params: {}, context: {} } }, STRANGER);
    await new Promise(r => setTimeout(r, 0));
    expect(mocks.handleIncomingInvocation).not.toHaveBeenCalled();
    expect(mocks.handleHostRun).not.toHaveBeenCalled();
  });

  it.each([HARBOR_FIREFOX, HARBOR_CHROME])('accepts permission sync and invocations from %s', async (id) => {
    deliver(external, { type: 'web_agents_permissions.list_all' }, { id });
    deliver(external, forward(3), { id });
    deliver(external, { type: 'agent.host.run', payload: { method: 'x', params: {}, context: {} } }, { id });
    await vi.waitFor(() => {
      expect(mocks.listAllPermissions).toHaveBeenCalledOnce();
      expect(mocks.handleIncomingInvocation).toHaveBeenCalledOnce();
      expect(mocks.handleHostRun).toHaveBeenCalledOnce();
    });
  });

  it('accepts a forwarded invocation from Harbor on the internal listener too', async () => {
    deliver(internal, forward(4), { id: HARBOR_FIREFOX });
    await vi.waitFor(() => expect(mocks.handleIncomingInvocation).toHaveBeenCalledOnce());
  });

  it('rejects the retired Harbor ID', async () => {
    deliver(external, { type: 'web_agents_permissions.list_all' }, { id: 'raffi.krikorian.harbor@gmail.com' });
    await Promise.resolve();
    expect(mocks.listAllPermissions).not.toHaveBeenCalled();
  });
});
