import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const key = 'web-agents-api-flags';
let stored: Record<string, unknown>;
let changed: (changes: Record<string, unknown>, area: string) => void;

beforeEach(() => {
  vi.resetModules();
  stored = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(stored, values)),
        remove: vi.fn(async (name: string) => { delete stored[name]; }),
      },
      onChanged: { addListener: vi.fn((listener: typeof changed) => { changed = listener; }) },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function flags() { return import('../policy/feature-flags'); }

describe('Agentic Tool Use defaults and saved choices', () => {
  it('enables agent runs on a fresh install without enabling browser control', async () => {
    const api = await flags();
    expect(api.getFeatureFlagsSync().toolCalling).toBe(true);
    expect(await api.getFeatureFlags()).toMatchObject({
      toolCalling: true, toolAccess: true, browserInteraction: false,
      browserControl: false, multiAgent: false,
    });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('keeps a saved opt-out when loading or changing another setting', async () => {
    stored[key] = { toolCalling: false };
    const api = await flags();
    expect((await api.getFeatureFlags()).toolCalling).toBe(false);
    await api.setFeatureFlags({ textGeneration: false });
    expect(stored[key]).toMatchObject({ toolCalling: false, textGeneration: false });
  });

  it('applies the new default when older saved settings omit toolCalling', async () => {
    stored[key] = { textGeneration: false };
    expect(await (await flags()).getFeatureFlags()).toMatchObject({
      textGeneration: false, toolCalling: true,
    });
  });

  it('uses enabled defaults if reading storage fails', async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await (await flags()).getFeatureFlags()).toolCalling).toBe(true);
  });

  it('picks up a saved opt-out from another extension context', async () => {
    const api = await flags();
    await api.getFeatureFlags();
    stored[key] = { toolCalling: false };
    changed({ [key]: { newValue: stored[key] } }, 'local');
    expect((await api.getFeatureFlags()).toolCalling).toBe(false);
  });

  it('returns to enabled defaults only after an explicit reset', async () => {
    stored[key] = { toolCalling: false };
    const api = await flags();
    await api.getFeatureFlags();
    await api.resetFeatureFlags();
    expect((await api.getFeatureFlags()).toolCalling).toBe(true);
  });
});
