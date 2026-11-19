import { beforeEach, describe, expect, it, vi } from 'vitest';

// Whether a page's prompt is local or remote comes from the bridge, which
// knows each provider's type, including named instances such as
// "my-ollama:llama3". Harbor's own in-browser providers are local without
// asking. If the bridge can't say, the prompt counts as remote; an older
// bridge without llm.model_locality falls back to the model-name check.

const bridge = vi.hoisted(() => ({ bridgeRequest: vi.fn() }));
vi.mock('../bridge-client', () => ({ bridgeRequest: bridge.bridgeRequest }));

import { promptActionForPrompt } from '../prompt-model';

const LOCAL = 'model.prompt.local';
const REMOTE = 'model.prompt.remote.firstParty';

function bridgeSays(locality: Record<string, boolean>, defaultModel?: string) {
  bridge.bridgeRequest.mockImplementation(async (method: string, params?: { model?: string }) => {
    if (method === 'llm.get_config') return { default_model: defaultModel ?? null };
    if (method === 'llm.model_locality') return { is_local: locality[params?.model ?? ''] ?? false };
    throw new Error(`unexpected ${method}`);
  });
}

const askedLocality = () => bridge.bridgeRequest.mock.calls.filter(([m]) => m === 'llm.model_locality').map(([, p]) => p);

beforeEach(() => vi.clearAllMocks());

describe('a prompt is local when the bridge says its provider runs here', () => {
  it.each(['lmstudio:qwen', 'llamafile:mistral', 'my-ollama:llama3', 'ollama:llama3'])('%s', async (model) => {
    bridgeSays({ [model]: true });
    expect(await promptActionForPrompt(model)).toBe(LOCAL);
    expect(askedLocality()).toEqual([{ model }]);
  });

  it('and remote when the bridge says it is not', async () => {
    bridgeSays({});
    expect(await promptActionForPrompt('openai:gpt-4o')).toBe(REMOTE);
  });

  it("classifies a prompt that names no model by the bridge's default model", async () => {
    bridgeSays({ 'lmstudio:qwen': true }, 'lmstudio:qwen');
    expect(await promptActionForPrompt(undefined)).toBe(LOCAL);
    expect(askedLocality()).toEqual([{ model: 'lmstudio:qwen' }]);
  });
});

describe("Harbor's own in-browser providers", () => {
  it.each(['local:x', 'firefox-ml:x', 'chrome-ai:x'])('%s is local without asking the bridge', async (model) => {
    bridgeSays({});
    expect(await promptActionForPrompt(model)).toBe(LOCAL);
    expect(askedLocality()).toEqual([]);
  });
});

describe('when the bridge cannot say', () => {
  it('a bridge error counts as remote', async () => {
    bridge.bridgeRequest.mockRejectedValue(new Error('Bridge not connected'));
    expect(await promptActionForPrompt('ollama:llama3')).toBe(REMOTE);
  });

  it("an older bridge without llm.model_locality falls back to the model's name", async () => {
    bridge.bridgeRequest.mockRejectedValue(new Error('Unknown method: llm.model_locality'));
    expect(await promptActionForPrompt('ollama:llama3')).toBe(LOCAL);
    expect(await promptActionForPrompt('openai:gpt-4o')).toBe(REMOTE);
  });

  it('an unknown default model counts as remote', async () => {
    bridgeSays({});
    expect(await promptActionForPrompt(undefined)).toBe(REMOTE);
    expect(askedLocality()).toEqual([]);
  });
});
