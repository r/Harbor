import { describe, expect, it } from 'vitest';
import {
  createMissingApiReadiness,
  deriveChatReadiness,
  type BridgeHealth,
  type ConfiguredModelMetadata,
  type ConfiguredModelSummary,
  type ProviderSummary,
  type ReadinessProbeResults,
  type ToolInventory,
} from './readiness-model';

const readyBridge: BridgeHealth = {
  connected: true,
  ready: true,
};

const localProvider: ProviderSummary = {
  id: 'ollama-home',
  type: 'ollama',
  name: 'Ollama Home',
  configured: true,
  available: true,
  isLocal: true,
  isDefault: true,
};

const localModel: ConfiguredModelSummary = {
  name: 'Local assistant',
  modelId: 'ollama:llama3.2:latest',
  isDefault: true,
};

function fulfilled<T>(value: T): PromiseFulfilledResult<T> {
  return {
    status: 'fulfilled',
    value,
  };
}

function rejected(reason = new Error('probe failed')): PromiseRejectedResult {
  return {
    status: 'rejected',
    reason,
  };
}

function createResults(
  overrides: Partial<ReadinessProbeResults> = {},
): ReadinessProbeResults {
  return {
    bridge: fulfilled(readyBridge),
    providers: fulfilled([localProvider]),
    models: fulfilled([localModel]),
    modelMetadata: fulfilled([
      {
        modelId: localModel.modelId,
        isLocal: true,
      },
    ]),
    tools: fulfilled({ count: 3 }),
    ...overrides,
  };
}

describe('deriveChatReadiness', () => {
  it('returns a reload blocker without an API', () => {
    expect(createMissingApiReadiness()).toEqual({
      api: 'missing',
      bridge: 'offline',
      model: {
        state: 'unavailable',
      },
      tools: {
        state: 'unavailable',
        count: 0,
      },
      blockers: [
        {
          kind: 'reload',
          label: 'Reload Chat',
        },
      ],
    });
  });

  it('keeps an offline bridge distinct from an unconfigured model', () => {
    const readiness = deriveChatReadiness(createResults({
      bridge: fulfilled({
        connected: false,
        ready: false,
      }),
      providers: fulfilled([]),
      models: fulfilled([]),
    }));

    expect(readiness.bridge).toBe('offline');
    expect(readiness.model.state).toBe('unavailable');
    expect(readiness.blockers.map(action => action.kind)).toEqual([
      'open-connections',
      'retry',
    ]);
  });

  it('reports an unconfigured model only after discovery succeeds', () => {
    const readiness = deriveChatReadiness(createResults({
      models: fulfilled([]),
    }));

    expect(readiness.bridge).toBe('ready');
    expect(readiness.model.state).toBe('unconfigured');
    expect(readiness.blockers).toEqual([
      {
        kind: 'open-connections',
        label: 'Open Connections',
      },
    ]);
  });

  it('returns the default configured model and its locality', () => {
    const readiness = deriveChatReadiness(createResults());

    expect(readiness.model).toEqual({
      state: 'ready',
      provider: 'Ollama Home',
      model: 'Local assistant',
      locality: 'local',
    });
    expect(readiness.blockers).toEqual([]);
  });

  it('selects the first configured model when no default exists', () => {
    const models: ConfiguredModelSummary[] = [
      {
        name: 'First model',
        modelId: 'ollama:first',
        isDefault: false,
      },
      {
        name: 'Second model',
        modelId: 'ollama:second',
        isDefault: false,
      },
    ];

    const readiness = deriveChatReadiness(createResults({
      models: fulfilled(models),
      modelMetadata: fulfilled([
        {
          modelId: 'ollama:first',
          isLocal: true,
        },
      ]),
    }));

    expect(readiness.model.model).toBe('First model');
  });

  it('reports a configured model whose provider is unavailable', () => {
    const readiness = deriveChatReadiness(createResults({
      providers: fulfilled([
        {
          ...localProvider,
          available: false,
        },
      ]),
    }));

    expect(readiness.model).toEqual({
      state: 'unavailable',
      provider: 'Ollama Home',
      model: 'Local assistant',
      locality: 'local',
    });
    expect(readiness.blockers.map(action => action.kind)).toEqual([
      'open-connections',
      'retry',
    ]);
  });

  it('uses metadata to identify a cloud model', () => {
    const cloudProvider: ProviderSummary = {
      id: 'openai-work',
      type: 'openai',
      name: 'OpenAI Work',
      configured: true,
      available: true,
      isLocal: false,
      isDefault: true,
    };
    const cloudModel: ConfiguredModelSummary = {
      name: 'Work model',
      modelId: 'openai:gpt-4o',
      isDefault: true,
    };
    const metadata: ConfiguredModelMetadata[] = [{
      modelId: cloudModel.modelId,
      isLocal: false,
    }];

    const readiness = deriveChatReadiness(createResults({
      providers: fulfilled([cloudProvider]),
      models: fulfilled([cloudModel]),
      modelMetadata: fulfilled(metadata),
    }));

    expect(readiness.model.locality).toBe('cloud');
  });

  it('keeps empty and failed tool inventories nonblocking', () => {
    const emptyTools = deriveChatReadiness(createResults({
      tools: fulfilled<ToolInventory>({ count: 0 }),
    }));
    const failedTools = deriveChatReadiness(createResults({
      tools: rejected(),
    }));

    expect(emptyTools.tools).toEqual({
      state: 'empty',
      count: 0,
    });
    expect(emptyTools.blockers).toEqual([]);
    expect(failedTools.tools).toEqual({
      state: 'unavailable',
      count: 0,
    });
    expect(failedTools.blockers).toEqual([]);
  });

  it('does not collapse failed discovery into an empty configuration', () => {
    const readiness = deriveChatReadiness(createResults({
      providers: rejected(),
      models: rejected(),
    }));

    expect(readiness.model.state).toBe('unavailable');
    expect(readiness.blockers.map(action => action.kind)).toEqual([
      'retry',
      'open-connections',
    ]);
  });
});
