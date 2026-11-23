/**
 * The page API keeps no permission store of its own. Every check and
 * request goes to Harbor, which holds the only store and the only prompt,
 * so a grant revoked in Harbor stops the next page call here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ harborRequest: vi.fn() }));
vi.mock('../harbor-core', () => ({
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null), harborRequest: mocks.harborRequest }));

const windowsCreate = vi.fn();
vi.stubGlobal('chrome', {
  runtime: { getURL: (p: string) => `moz-extension://harbor/${p}`, lastError: undefined },
  windows: { create: windowsCreate, get: vi.fn(), remove: vi.fn() },
  tabs: { update: vi.fn() },
});

import { hasPermission, handleRequestPermissions, handlePermissionsList } from '../handlers/permission-handlers';
import { handleToolsCall, handleToolsList } from '../handlers/tool-handlers';

const ORIGIN = 'https://page.example';
const ctx = (type: string, payload: unknown) =>
  ({ id: 'r1', type, origin: ORIGIN, tabId: 4, payload }) as never;

/** Harbor's answer to permissions.check: nothing granted. */
const revoked = { origin: ORIGIN, scopes: { 'model:prompt': 'not-granted', 'mcp:tools.call': 'not-granted' }, allowedTools: [] };

beforeEach(() => vi.clearAllMocks());

describe("checks use Harbor's store", () => {
  it('a grant revoked in Harbor is not honoured from the old local copy', async () => {
    mocks.harborRequest.mockResolvedValue(revoked);
    expect(await hasPermission(ORIGIN, 'model:prompt')).toBe(false);
    expect(mocks.harborRequest).toHaveBeenCalledWith('permissions.check', expect.objectContaining({ origin: ORIGIN }));
  });

  it('a grant held in Harbor is honoured', async () => {
    mocks.harborRequest.mockResolvedValue({ ...revoked, scopes: { 'model:prompt': 'granted-once' } });
    expect(await hasPermission(ORIGIN, 'model:prompt')).toBe(true);
  });

  it('fails closed when Harbor gives a malformed answer or none', async () => {
    mocks.harborRequest.mockResolvedValueOnce({ supported: false });
    expect(await hasPermission(ORIGIN, 'model:prompt')).toBe(false);
    mocks.harborRequest.mockRejectedValueOnce(new Error('Harbor extension not found'));
    expect(await hasPermission(ORIGIN, 'model:prompt')).toBe(false);
  });

  it('agent.permissions.list reports what Harbor holds', async () => {
    mocks.harborRequest.mockResolvedValue({ ...revoked, allowedTools: ['clock/now'] });
    const res = await handlePermissionsList(ctx('agent.permissions.list', {})) as { result: { scopes: Record<string, string>; allowedTools: string[] } };
    expect(res.result.scopes['model:prompt']).toBe('not-granted');
    expect(res.result.allowedTools).toEqual(['clock/now']);
  });
});

describe('checks carry the calling tab', () => {
  it("so a once-grant for one tab doesn't cover another", async () => {
    mocks.harborRequest.mockImplementation(async (type: string) =>
      type === 'permissions.check' ? { origin: ORIGIN, scopes: {}, allowedTools: [] } : { tools: [] });
    await handleToolsList(ctx('agent.tools.list', {}));
    expect(mocks.harborRequest).toHaveBeenCalledWith('permissions.check', { origin: ORIGIN, tabId: 4 });
  });
});

describe("requests go through Harbor's prompt", () => {
  it('forwards the request to Harbor and opens no prompt window of its own', async () => {
    mocks.harborRequest.mockResolvedValue({ granted: true, scopes: { 'model:prompt': 'granted-once' }, allowedTools: [] });
    await handleRequestPermissions(ctx('agent.requestPermissions', { scopes: ['model:prompt'], reason: 'Summarize' }));
    expect(windowsCreate).not.toHaveBeenCalled();
    const call = mocks.harborRequest.mock.calls.find(([type]) => type === 'permissions.request');
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ origin: ORIGIN, tabId: 4, reason: 'Summarize' });
    expect(mocks.harborRequest.mock.calls.some(([type]) => type === 'system.syncPermissions')).toBe(false);
  });

  it('refuses agents:crossOrigin without target sites as an invalid request', async () => {
    const response = await handleRequestPermissions(ctx('agent.requestPermissions', { scopes: ['agents:crossOrigin'] }));
    expect(response).toMatchObject({ ok: false, error: { code: 'ERR_INVALID_REQUEST' } });
    expect(mocks.harborRequest.mock.calls.some(([type]) => type === 'permissions.request')).toBe(false);
  });

  it('forwards the target sites of an agents:crossOrigin request', async () => {
    mocks.harborRequest.mockResolvedValue({
      granted: true,
      scopes: { 'agents:crossOrigin': 'granted-once' },
      allowedTools: [],
      agentOrigins: ['https://b.example'],
    });
    const response = await handleRequestPermissions(
      ctx('agent.requestPermissions', { scopes: ['agents:crossOrigin'], agentOrigins: ['https://b.example'] }),
    );
    const call = mocks.harborRequest.mock.calls.find(([type]) => type === 'permissions.request');
    expect(call![1]).toMatchObject({ agentOrigins: ['https://b.example'] });
    expect(response).toMatchObject({ ok: true, result: { agentOrigins: ['https://b.example'] } });
  });
});

describe('a request asks only for the scopes the page named', () => {
  const forwardedScopes = () => {
    const call = mocks.harborRequest.mock.calls.find(([type]) => type === 'permissions.request');
    return (call![1] as { scopes: string[] }).scopes;
  };

  it.each(['model:prompt', 'mcp:tools.call', 'browser:tabs.create'])(
    'asking for %s adds no agent scopes',
    async (scope) => {
      mocks.harborRequest.mockResolvedValue({ granted: true, scopes: { [scope]: 'granted-once' }, allowedTools: [] });
      await handleRequestPermissions(ctx('agent.requestPermissions', { scopes: [scope] }));
      expect(forwardedScopes()).toEqual([scope]);
    },
  );

  it('a page that names the agent scopes still gets asked for them', async () => {
    const scopes = ['model:prompt', 'agents:register', 'agents:invoke'];
    mocks.harborRequest.mockResolvedValue({ granted: true, scopes: {}, allowedTools: [] });
    await handleRequestPermissions(ctx('agent.requestPermissions', { scopes }));
    expect(forwardedScopes()).toEqual(scopes);
  });

  it('a scope named twice is asked for once', async () => {
    mocks.harborRequest.mockResolvedValue({ granted: true, scopes: {}, allowedTools: [] });
    await handleRequestPermissions(ctx('agent.requestPermissions', { scopes: ['model:prompt', 'web:fetch', 'model:prompt'] }));
    expect(forwardedScopes()).toEqual(['model:prompt', 'web:fetch']);
  });
});

describe('a missing tool allowlist denies every tool', () => {
  it('tools.call is refused when Harbor reports no allowed tools', async () => {
    mocks.harborRequest.mockImplementation(async (type: string) =>
      type === 'permissions.check'
        ? { origin: ORIGIN, scopes: { 'mcp:tools.call': 'granted-always' } }
        : { result: 'noon' });
    const res = await handleToolsCall(ctx('agent.tools.call', { tool: 'clock/now', args: {} })) as { ok: boolean; error?: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('ERR_TOOL_NOT_ALLOWED');
    expect(mocks.harborRequest.mock.calls.some(([type]) => type === 'mcp.callTool')).toBe(false);
  });
});
