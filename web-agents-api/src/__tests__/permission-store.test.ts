/**
 * The Web Agents API keeps no permission store of its own. Every check and
 * request goes to Harbor, which holds the only store and the only prompt,
 * so a grant revoked in Harbor stops the next page call here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ harborRequest: vi.fn() }));
vi.mock('../harbor-client', () => ({ harborRequest: mocks.harborRequest }));

// A stale grant left in the old Web Agents API store must not count.
const storage: Record<string, unknown> = {
  'permissions:https://page.example': {
    scopes: {
      'model:prompt': { type: 'granted-always', grantedAt: 1 },
      'mcp:tools.call': { type: 'granted-always', grantedAt: 1 },
    },
  },
};
const windowsCreate = vi.fn();
vi.stubGlobal('chrome', {
  runtime: { getURL: (p: string) => `moz-extension://waa/${p}`, lastError: undefined },
  storage: {
    local: {
      get: vi.fn(async (key: string | null) =>
        key === null ? { ...storage } : key in storage ? { [key]: storage[key] } : {}),
      set: vi.fn(async (kv: Record<string, unknown>) => Object.assign(storage, kv)),
      remove: vi.fn(async (key: string | string[]) => {
        for (const k of Array.isArray(key) ? key : [key]) delete storage[k];
      }),
    },
  },
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

  it('fails closed when Harbor cannot answer (Safari, or Harbor missing)', async () => {
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
    // Requesting model:prompt still bundles the multi-agent scopes (tracked separately).
    expect((call![1] as { scopes: string[] }).scopes).toEqual(
      expect.arrayContaining(['model:prompt', 'agents:register', 'agents:invoke']));
    expect(mocks.harborRequest.mock.calls.some(([type]) => type === 'system.syncPermissions')).toBe(false);
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
