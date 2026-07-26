import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserReadinessProbes,
  createReadinessService,
  type ReadinessProbeService,
  type RuntimeMessagePort,
} from './readiness-service';
import type {
  BridgeHealth,
  ConfiguredModelMetadata,
  ConfiguredModelSummary,
  ProviderSummary,
  ToolInventory,
} from './readiness-model';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

function createReadyProbeService(): ReadinessProbeService {
  return {
    isApiAvailable: () => true,
    getBridgeHealth: async () => ({
      connected: true,
      ready: true,
    }),
    listProviders: async () => [{
      id: 'ollama-home',
      type: 'ollama',
      name: 'Ollama Home',
      configured: true,
      available: true,
      isLocal: true,
      isDefault: true,
    }],
    listConfiguredModels: async () => [{
      name: 'Local assistant',
      modelId: 'ollama:llama3.2',
      isDefault: true,
    }],
    getConfiguredModelMetadata: async () => [{
      modelId: 'ollama:llama3.2',
      isLocal: true,
    }],
    getToolInventory: async () => ({ count: 2 }),
  };
}

describe('createReadinessService', () => {
  it('does not run probes when the runtime API is missing', async () => {
    const probes = createReadyProbeService();
    probes.isApiAvailable = () => false;
    const bridgeSpy = vi.spyOn(probes, 'getBridgeHealth');
    const providersSpy = vi.spyOn(probes, 'listProviders');
    const modelsSpy = vi.spyOn(probes, 'listConfiguredModels');
    const metadataSpy = vi.spyOn(probes, 'getConfiguredModelMetadata');
    const toolsSpy = vi.spyOn(probes, 'getToolInventory');

    const readiness = await createReadinessService(probes).check();

    expect(readiness.api).toBe('missing');
    expect(bridgeSpy).not.toHaveBeenCalled();
    expect(providersSpy).not.toHaveBeenCalled();
    expect(modelsSpy).not.toHaveBeenCalled();
    expect(metadataSpy).not.toHaveBeenCalled();
    expect(toolsSpy).not.toHaveBeenCalled();
  });

  it('starts independent probes without an initialization waterfall', async () => {
    const bridge = deferred<BridgeHealth>();
    const providers = deferred<readonly ProviderSummary[]>();
    const models = deferred<readonly ConfiguredModelSummary[]>();
    const metadata = deferred<readonly ConfiguredModelMetadata[]>();
    const tools = deferred<ToolInventory>();
    const probes: ReadinessProbeService = {
      isApiAvailable: () => true,
      getBridgeHealth: vi.fn(() => bridge.promise),
      listProviders: vi.fn(() => providers.promise),
      listConfiguredModels: vi.fn(() => models.promise),
      getConfiguredModelMetadata: vi.fn(() => metadata.promise),
      getToolInventory: vi.fn(() => tools.promise),
    };

    const readinessPromise = createReadinessService(probes).check();

    expect(probes.getBridgeHealth).toHaveBeenCalledOnce();
    expect(probes.listProviders).toHaveBeenCalledOnce();
    expect(probes.listConfiguredModels).toHaveBeenCalledOnce();
    expect(probes.getConfiguredModelMetadata).toHaveBeenCalledOnce();
    expect(probes.getToolInventory).toHaveBeenCalledOnce();

    bridge.resolve({ connected: true, ready: true });
    providers.resolve([{
      id: 'ollama',
      type: 'ollama',
      name: 'Ollama',
      configured: true,
      available: true,
      isLocal: true,
      isDefault: true,
    }]);
    models.resolve([{
      name: 'Local',
      modelId: 'ollama:local',
      isDefault: true,
    }]);
    metadata.resolve([{
      modelId: 'ollama:local',
      isLocal: true,
    }]);
    tools.resolve({ count: 0 });

    await expect(readinessPromise).resolves.toMatchObject({
      bridge: 'ready',
      model: {
        state: 'ready',
      },
    });
  });

  it('has no permission or execution methods in its probe boundary', () => {
    const probes = createReadyProbeService() as ReadinessProbeService
      & Record<string, unknown>;

    expect(probes.requestPermissions).toBeUndefined();
    expect(probes.createTextSession).toBeUndefined();
    expect(probes.prompt).toBeUndefined();
    expect(probes.run).toBeUndefined();
  });
});

describe('createBrowserReadinessProbes', () => {
  it('normalizes runtime response shapes without confusing configuration and availability', async () => {
    const port: RuntimeMessagePort = {
      sendMessage: vi.fn(async (message) => {
        switch (message.type) {
          case 'bridge_check_health':
            return {
              ok: true,
              connected: true,
              bridgeReady: true,
            };
          case 'llm_list_providers':
            return {
              ok: true,
              providers: [{
                id: 'ollama-home',
                type: 'ollama',
                name: 'Ollama Home',
                configured: true,
                available: false,
                is_local: true,
                is_default: true,
              }],
            };
          case 'llm_list_configured_models':
            return {
              ok: true,
              models: [{
                name: 'Local assistant',
                model_id: 'ollama:llama3.2',
                is_default: true,
              }],
            };
          case 'bridge_rpc':
            return {
              ok: true,
              result: {
                metadata: [{
                  model_id: 'ollama:llama3.2',
                  is_local: true,
                }],
              },
            };
          case 'sidebar_get_servers':
            return {
              ok: true,
              servers: [
                {
                  running: true,
                  tools: [{ name: 'one' }, { name: 'two' }],
                },
                {
                  running: false,
                  tools: [{ name: 'not-counted' }],
                },
              ],
            };
          default:
            throw new Error(`Unexpected message: ${String(message.type)}`);
        }
      }),
    };
    const probes = createBrowserReadinessProbes(port);

    await expect(probes.getBridgeHealth()).resolves.toEqual({
      connected: true,
      ready: true,
      error: undefined,
    });
    await expect(probes.listProviders()).resolves.toEqual([{
      id: 'ollama-home',
      type: 'ollama',
      name: 'Ollama Home',
      configured: true,
      available: false,
      isLocal: true,
      isDefault: true,
    }]);
    await expect(probes.listConfiguredModels()).resolves.toEqual([{
      name: 'Local assistant',
      modelId: 'ollama:llama3.2',
      isDefault: true,
    }]);
    await expect(probes.getConfiguredModelMetadata()).resolves.toEqual([{
      modelId: 'ollama:llama3.2',
      isLocal: true,
    }]);
    await expect(probes.getToolInventory()).resolves.toEqual({
      count: 2,
    });
  });

  it('rejects failed inventory responses instead of returning an empty list', async () => {
    const probes = createBrowserReadinessProbes({
      sendMessage: async () => ({
        ok: false,
        error: 'Bridge unavailable',
      }),
    });

    await expect(probes.listProviders()).rejects.toThrow(
      'provider discovery failed: Bridge unavailable',
    );
  });
});
