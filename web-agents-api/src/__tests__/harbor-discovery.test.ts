import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Discovery decides which extension receives every prompt and tool call, so it
// must only ever settle on a known Harbor ID, whatever a content script or
// storage says.

let sendMessage: ReturnType<typeof vi.fn>;
let stored: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  stored = {};
  sendMessage = vi.fn((id: string, _msg: unknown, cb: (r: unknown) => void) => {
    cb(id === 'someone-else@example.com' || id === 'harbor@krikorian.co'
      ? { ok: true, result: { version: '1' } } : undefined);
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage, lastError: undefined },
    storage: { local: {
      get: async (k: string) => (k in stored ? { [k]: stored[k] } : {}),
      set: async (kv: Record<string, unknown>) => { Object.assign(stored, kv); },
    } },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Harbor discovery only uses known Harbor IDs', () => {
  it('ignores an unknown ID reported by the content script', async () => {
    const { setHarborExtensionId, getHarborState } = await import('../harbor-client');
    setHarborExtensionId('someone-else@example.com');
    expect(getHarborState()).toEqual({ connected: false, extensionId: null });
    expect(stored.harbor_extension_id).toBeUndefined();
  });

  it('accepts a known Harbor ID reported by the content script', async () => {
    const { setHarborExtensionId, getHarborState } = await import('../harbor-client');
    setHarborExtensionId('ljnciidcajlichemnbohopnlaonhkpgm');
    expect(getHarborState()).toEqual({ connected: true, extensionId: 'ljnciidcajlichemnbohopnlaonhkpgm' });
  });

  it('never contacts an unknown ID found in storage', async () => {
    sendMessage.mockImplementation((_id: string, _msg: unknown, cb: (r: unknown) => void) => cb(undefined));
    stored.harbor_extension_id = 'someone-else@example.com';
    const { discoverHarbor } = await import('../harbor-client');
    expect(await discoverHarbor()).toBeNull();
    const contacted = sendMessage.mock.calls.map(c => c[0]);
    expect(contacted).not.toContain('someone-else@example.com');
  });
});
