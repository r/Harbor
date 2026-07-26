import { browserAPI } from '../../../browser-compat';
import type { ReadinessService } from '../../services';
import {
  createMissingApiReadiness,
  deriveChatReadiness,
  type BridgeHealth,
  type ConfiguredModelMetadata,
  type ConfiguredModelSummary,
  type ProviderSummary,
  type ToolInventory,
} from './readiness-model';

export type ReadinessProbeService = {
  isApiAvailable(): boolean;
  getBridgeHealth(): Promise<BridgeHealth>;
  listProviders(): Promise<readonly ProviderSummary[]>;
  listConfiguredModels(): Promise<readonly ConfiguredModelSummary[]>;
  getConfiguredModelMetadata(): Promise<readonly ConfiguredModelMetadata[]>;
  getToolInventory(): Promise<ToolInventory>;
};

export type RuntimeMessagePort = {
  sendMessage(message: Record<string, unknown>): Promise<unknown>;
};

export function createReadinessService(
  probes: ReadinessProbeService,
): ReadinessService {
  return {
    async check() {
      if (!probes.isApiAvailable()) {
        return createMissingApiReadiness();
      }

      const [
        bridge,
        providers,
        models,
        modelMetadata,
        tools,
      ] = await Promise.allSettled([
        probes.getBridgeHealth(),
        probes.listProviders(),
        probes.listConfiguredModels(),
        probes.getConfiguredModelMetadata(),
        probes.getToolInventory(),
      ]);

      return deriveChatReadiness({
        bridge,
        providers,
        models,
        modelMetadata,
        tools,
      });
    },
  };
}

export function createBrowserReadinessService(
  port: RuntimeMessagePort = createBrowserRuntimeMessagePort(),
): ReadinessService {
  return createReadinessService(createBrowserReadinessProbes(port));
}

export function createBrowserReadinessProbes(
  port: RuntimeMessagePort,
): ReadinessProbeService {
  return {
    isApiAvailable() {
      return typeof port.sendMessage === 'function';
    },

    async getBridgeHealth() {
      const response = asRecord(
        await port.sendMessage({ type: 'bridge_check_health' }),
        'bridge health',
      );

      return {
        connected: response.connected === true,
        ready: response.bridgeReady === true,
        error: typeof response.error === 'string' ? response.error : undefined,
      };
    },

    async listProviders() {
      const response = await sendCheckedMessage(
        port,
        { type: 'llm_list_providers' },
        'provider discovery',
      );
      const providers = asArray(response.providers, 'providers');

      return providers.map((candidate, index) => {
        const provider = asRecord(candidate, `provider ${index + 1}`);
        return {
          id: readRequiredString(provider, 'id', `provider ${index + 1}`),
          type: readRequiredString(provider, 'type', `provider ${index + 1}`),
          name: readRequiredString(provider, 'name', `provider ${index + 1}`),
          configured: provider.configured === true,
          available: provider.available === true,
          isLocal: provider.is_local === true,
          isDefault: provider.is_default === true,
        };
      });
    },

    async listConfiguredModels() {
      const response = await sendCheckedMessage(
        port,
        { type: 'llm_list_configured_models' },
        'model discovery',
      );
      const models = asArray(response.models, 'configured models');

      return models.map((candidate, index) => {
        const model = asRecord(candidate, `configured model ${index + 1}`);
        return {
          name: readRequiredString(
            model,
            'name',
            `configured model ${index + 1}`,
          ),
          modelId: readRequiredString(
            model,
            'model_id',
            `configured model ${index + 1}`,
          ),
          isDefault: model.is_default === true,
        };
      });
    },

    async getConfiguredModelMetadata() {
      const response = await sendCheckedMessage(
        port,
        {
          type: 'bridge_rpc',
          method: 'llm.get_configured_models_metadata',
        },
        'model metadata discovery',
      );
      const result = asRecord(response.result, 'model metadata result');
      const metadata = asArray(result.metadata, 'model metadata');

      return metadata.map((candidate, index) => {
        const model = asRecord(candidate, `model metadata ${index + 1}`);
        return {
          modelId: readRequiredString(
            model,
            'model_id',
            `model metadata ${index + 1}`,
          ),
          isLocal: model.is_local === true,
        };
      });
    },

    async getToolInventory() {
      const response = await sendCheckedMessage(
        port,
        { type: 'sidebar_get_servers' },
        'tool discovery',
      );
      const servers = asArray(response.servers, 'servers');
      let count = 0;

      for (const [index, candidate] of servers.entries()) {
        const server = asRecord(candidate, `server ${index + 1}`);
        if (server.running !== true) {
          continue;
        }

        count += asArray(server.tools ?? [], `server ${index + 1} tools`).length;
      }

      return { count };
    },
  };
}

function createBrowserRuntimeMessagePort(): RuntimeMessagePort {
  return {
    sendMessage(message) {
      return browserAPI.runtime.sendMessage(message);
    },
  };
}

async function sendCheckedMessage(
  port: RuntimeMessagePort,
  message: Record<string, unknown>,
  operation: string,
): Promise<Record<string, unknown>> {
  const response = asRecord(await port.sendMessage(message), operation);
  if (response.ok !== true) {
    const detail = typeof response.error === 'string'
      ? `: ${response.error}`
      : '';
    throw new Error(`${operation} failed${detail}`);
  }

  return response;
}

function asRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${description} response`);
  }

  return value as Record<string, unknown>;
}

function asArray(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${description} response`);
  }

  return value;
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  description: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${description} ${field}`);
  }

  return value;
}
