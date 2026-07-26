import type {
  ChatReadiness,
  RecoveryAction,
} from '../../contracts';

export type BridgeHealth = {
  connected: boolean;
  ready: boolean;
  error?: string;
};

export type ProviderSummary = {
  id: string;
  type: string;
  name: string;
  configured: boolean;
  available: boolean;
  isLocal: boolean;
  isDefault: boolean;
};

export type ConfiguredModelSummary = {
  name: string;
  modelId: string;
  isDefault: boolean;
};

export type ConfiguredModelMetadata = {
  modelId: string;
  isLocal: boolean;
};

export type ToolInventory = {
  count: number;
};

export type ReadinessProbeResults = {
  bridge: PromiseSettledResult<BridgeHealth>;
  providers: PromiseSettledResult<readonly ProviderSummary[]>;
  models: PromiseSettledResult<readonly ConfiguredModelSummary[]>;
  modelMetadata: PromiseSettledResult<readonly ConfiguredModelMetadata[]>;
  tools: PromiseSettledResult<ToolInventory>;
};

const OPEN_CONNECTIONS_ACTION: RecoveryAction = {
  kind: 'open-connections',
  label: 'Open Connections',
};

const RETRY_ACTION: RecoveryAction = {
  kind: 'retry',
  label: 'Check Again',
};

const RELOAD_ACTION: RecoveryAction = {
  kind: 'reload',
  label: 'Reload Chat',
};

export const CHECKING_CHAT_READINESS: ChatReadiness = {
  api: 'available',
  bridge: 'checking',
  model: {
    state: 'checking',
  },
  tools: {
    state: 'checking',
    count: 0,
  },
  blockers: [],
};

export function createMissingApiReadiness(): ChatReadiness {
  return {
    api: 'missing',
    bridge: 'offline',
    model: {
      state: 'unavailable',
    },
    tools: {
      state: 'unavailable',
      count: 0,
    },
    blockers: [RELOAD_ACTION],
  };
}

export function createFailedReadiness(): ChatReadiness {
  return {
    api: 'available',
    bridge: 'offline',
    model: {
      state: 'unavailable',
    },
    tools: {
      state: 'unavailable',
      count: 0,
    },
    blockers: [RETRY_ACTION, OPEN_CONNECTIONS_ACTION],
  };
}

export function deriveChatReadiness(
  results: ReadinessProbeResults,
): ChatReadiness {
  const tools = deriveToolReadiness(results.tools);
  const bridgeReady = results.bridge.status === 'fulfilled'
    && results.bridge.value.connected
    && results.bridge.value.ready;

  if (!bridgeReady) {
    return {
      api: 'available',
      bridge: 'offline',
      model: {
        state: 'unavailable',
      },
      tools,
      blockers: [OPEN_CONNECTIONS_ACTION, RETRY_ACTION],
    };
  }

  if (
    results.providers.status === 'rejected'
    || results.models.status === 'rejected'
  ) {
    return {
      api: 'available',
      bridge: 'ready',
      model: {
        state: 'unavailable',
      },
      tools,
      blockers: [RETRY_ACTION, OPEN_CONNECTIONS_ACTION],
    };
  }

  const selectedModel = selectConfiguredModel(results.models.value);
  if (!selectedModel) {
    return {
      api: 'available',
      bridge: 'ready',
      model: {
        state: 'unconfigured',
      },
      tools,
      blockers: [OPEN_CONNECTIONS_ACTION],
    };
  }

  const selectedProvider = selectProviderForModel(
    selectedModel,
    results.providers.value,
  );
  const locality = deriveModelLocality(
    selectedModel,
    selectedProvider,
    results.modelMetadata,
  );

  if (!selectedProvider?.available) {
    return {
      api: 'available',
      bridge: 'ready',
      model: {
        state: 'unavailable',
        provider: selectedProvider?.name,
        model: selectedModel.name,
        locality,
      },
      tools,
      blockers: [OPEN_CONNECTIONS_ACTION, RETRY_ACTION],
    };
  }

  return {
    api: 'available',
    bridge: 'ready',
    model: {
      state: 'ready',
      provider: selectedProvider.name,
      model: selectedModel.name,
      locality,
    },
    tools,
    blockers: [],
  };
}

function deriveToolReadiness(
  tools: PromiseSettledResult<ToolInventory>,
): ChatReadiness['tools'] {
  if (tools.status === 'rejected') {
    return {
      state: 'unavailable',
      count: 0,
    };
  }

  return tools.value.count > 0
    ? { state: 'ready', count: tools.value.count }
    : { state: 'empty', count: 0 };
}

function selectConfiguredModel(
  models: readonly ConfiguredModelSummary[],
): ConfiguredModelSummary | undefined {
  return models.find(model => model.isDefault) ?? models[0];
}

function selectProviderForModel(
  model: ConfiguredModelSummary,
  providers: readonly ProviderSummary[],
): ProviderSummary | undefined {
  const modelProviderType = getModelProviderType(model.modelId);
  const eligibleProviders = providers.filter(provider =>
    provider.configured || provider.available
  );

  if (modelProviderType) {
    const matchingProviders = eligibleProviders.filter(provider =>
      provider.id === modelProviderType || provider.type === modelProviderType
    );

    return matchingProviders.find(provider => provider.isDefault)
      ?? matchingProviders.find(provider => provider.available)
      ?? matchingProviders[0];
  }

  return eligibleProviders.find(provider => provider.isDefault)
    ?? eligibleProviders.find(provider => provider.available)
    ?? eligibleProviders[0];
}

function getModelProviderType(modelId: string): string | undefined {
  const separatorIndex = modelId.indexOf(':');
  if (separatorIndex <= 0) {
    return undefined;
  }

  return modelId.slice(0, separatorIndex).toLowerCase();
}

function deriveModelLocality(
  model: ConfiguredModelSummary,
  provider: ProviderSummary | undefined,
  metadata: PromiseSettledResult<readonly ConfiguredModelMetadata[]>,
): 'local' | 'cloud' | undefined {
  if (metadata.status === 'fulfilled') {
    const modelMetadata = metadata.value.find(
      candidate => candidate.modelId === model.modelId,
    );
    if (modelMetadata) {
      return modelMetadata.isLocal ? 'local' : 'cloud';
    }
  }

  if (provider) {
    return provider.isLocal ? 'local' : 'cloud';
  }

  return undefined;
}
