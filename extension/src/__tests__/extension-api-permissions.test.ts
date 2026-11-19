/**
 * Harbor holds the only origin permission store. The Web Agents API reads
 * and requests grants through these cross-extension routes instead of
 * keeping its own copy, so a revocation in Harbor takes effect everywhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeExtensionApiMessage } from '../extension-api';
import { grantPermissions, requestPermissions, revokePermissions } from '../policy/permissions';
import { resetMockBrowser } from './test-setup';

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({ callTool: vi.fn(), listTools: vi.fn(), listServersWithStatus: vi.fn() }));
vi.mock('../llm/native-bridge', () => ({}));
vi.mock('../llm/provider-registry', () => ({}));
vi.mock('../sessions', () => ({ SessionRegistry: { subscribe: vi.fn() } }));
vi.mock('../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/permissions')>()),
  requestPermissions: vi.fn(),
}));

const ORIGIN = 'https://page.example';
const route = (type: string, payload: unknown) => routeExtensionApiMessage({ type, payload }, {});

beforeEach(() => {
  vi.clearAllMocks();
  resetMockBrowser();
});

describe('permissions.check', () => {
  it("reports Harbor's grants for the origin", async () => {
    await grantPermissions(ORIGIN, ['model:prompt', 'mcp:tools.call'], 'granted-always', undefined, ['clock/now']);
    const res = await route('permissions.check', { origin: ORIGIN });
    expect(res.ok).toBe(true);
    const result = res.result as { scopes: Record<string, string>; allowedTools: string[] };
    expect(result.scopes['model:prompt']).toBe('granted-always');
    expect(result.scopes['mcp:tools.call']).toBe('granted-always');
    expect(result.scopes['browser:tabs.create']).toBe('not-granted');
    expect(result.allowedTools).toEqual(['clock/now']);
  });

  it('reflects a revocation made in Harbor', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await revokePermissions(ORIGIN);
    const res = await route('permissions.check', { origin: ORIGIN });
    const result = res.result as { scopes: Record<string, string>; allowedTools: string[] };
    expect(result.scopes['model:prompt']).toBe('not-granted');
    expect(result.allowedTools).toEqual([]);
  });

  it('rejects a call without an origin', async () => {
    const res = await route('permissions.check', {});
    expect(res.ok).toBe(false);
  });
});

describe('permissions.request', () => {
  it("asks through Harbor's prompt and store", async () => {
    vi.mocked(requestPermissions).mockResolvedValue({
      granted: true,
      scopes: { 'model:prompt': 'granted-once' } as never,
      allowedTools: [],
    });
    const res = await route('permissions.request', {
      origin: ORIGIN,
      tabId: 3,
      scopes: ['model:prompt'],
      reason: 'Summarize',
      tools: ['clock/now'],
    });
    expect(res.ok).toBe(true);
    expect(requestPermissions).toHaveBeenCalledWith(
      ORIGIN,
      { scopes: ['model:prompt'], reason: 'Summarize', tools: ['clock/now'] },
      3,
      undefined,
    );
    expect(res.result).toMatchObject({ granted: true });
  });

  it('rejects unknown scopes and malformed payloads without prompting', async () => {
    for (const payload of [
      {},
      { origin: ORIGIN },
      { origin: ORIGIN, scopes: 'model:prompt' },
      { origin: ORIGIN, scopes: ['model:prompt', 'root:everything'] },
      { origin: ORIGIN, scopes: ['model:prompt'], tools: 'clock/now' },
      { origin: 42, scopes: ['model:prompt'] },
    ]) {
      const res = await route('permissions.request', payload);
      expect(res.ok, JSON.stringify(payload)).toBe(false);
    }
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('rejects the retired address-bar scopes without prompting', async () => {
    // Harbor has no address-bar feature, so these scopes would grant nothing.
    for (const scope of ['addressBar:suggest', 'addressBar:context', 'addressBar:history', 'addressBar:execute']) {
      const res = await route('permissions.request', { origin: ORIGIN, scopes: [scope] });
      expect(res.ok, scope).toBe(false);
    }
    expect(requestPermissions).not.toHaveBeenCalled();
  });
});

describe('the one-way grant sync is gone', () => {
  it('system.syncPermissions is no longer accepted', async () => {
    const res = await route('system.syncPermissions', {
      origin: ORIGIN,
      scopes: ['model:prompt'],
      grantType: 'granted-always',
    });
    expect(res.ok).toBe(false);
    const check = await route('permissions.check', { origin: ORIGIN });
    expect((check.result as { scopes: Record<string, string> }).scopes['model:prompt']).toBe('not-granted');
  });
});
