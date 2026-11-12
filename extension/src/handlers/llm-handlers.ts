/**
 * LLM Configuration Handlers
 * 
 * Handlers for LLM provider and model management.
 */

import { bridgeChat } from '../llm/chat';
import { registerHandler, errorResponse } from './types';
import { bridgeRequest } from '../llm/bridge-client';

export function registerLlmHandlers(): void {
  // List providers
  registerHandler('llm_list_providers', (_message, _sender, sendResponse) => {
    bridgeRequest<{ providers: unknown[]; default_provider?: string }>('llm.list_providers')
      .then((result) => sendResponse({ ok: true, providers: result.providers, default_provider: result.default_provider }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // List provider types
  registerHandler('llm_list_provider_types', (_message, _sender, sendResponse) => {
    bridgeRequest<{ provider_types: unknown[] }>('llm.list_provider_types')
      .then((result) => sendResponse({ ok: true, provider_types: result.provider_types }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Get config
  registerHandler('llm_get_config', (_message, _sender, sendResponse) => {
    bridgeRequest<{ default_model?: string; providers: Record<string, unknown> }>('llm.get_config')
      .then((result) => sendResponse({ ok: true, config: result }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Configure provider
  registerHandler('llm_configure_provider', (message, _sender, sendResponse) => {
    const { id, provider, name, api_key, base_url, enabled } = message as {
      id?: string;
      provider?: string;
      name?: string;
      api_key?: string;
      base_url?: string;
      enabled?: boolean;
    };
    if (!provider && !id) {
      sendResponse({ ok: false, error: 'Missing provider or id' });
      return true;
    }
    bridgeRequest<{ ok: boolean; id: string }>('llm.configure_provider', {
      id, provider, name, api_key, base_url, enabled,
    })
      .then((result) => sendResponse({ ok: result.ok, id: result.id }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Set default provider
  registerHandler('llm_set_default_provider', (message, _sender, sendResponse) => {
    const { id } = message as { id?: string };
    if (!id) {
      sendResponse({ ok: false, error: 'Missing id' });
      return true;
    }
    bridgeRequest<{ ok: boolean; default_provider: string }>('llm.set_default_provider', { id })
      .then((result) => sendResponse({ ok: result.ok, default_provider: result.default_provider }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Remove provider
  registerHandler('llm_remove_provider', (message, _sender, sendResponse) => {
    const { id } = message as { id?: string };
    if (!id) {
      sendResponse({ ok: false, error: 'Missing id' });
      return true;
    }
    bridgeRequest<{ ok: boolean }>('llm.remove_provider', { id })
      .then((result) => sendResponse({ ok: result.ok }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Check provider
  registerHandler('llm_check_provider', (message, _sender, sendResponse) => {
    const { provider } = message as { provider?: string };
    if (!provider) {
      sendResponse({ ok: false, error: 'Missing provider' });
      return true;
    }
    bridgeRequest<{ provider: string; available: boolean; error?: string }>('llm.check_provider', { provider })
      .then((result) => sendResponse({ ok: true, status: result }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // List models
  registerHandler('llm_list_models', (_message, _sender, sendResponse) => {
    bridgeRequest<{ models: unknown[] }>('llm.list_models')
      .then((result) => sendResponse({ ok: true, models: result.models }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Set default model
  registerHandler('llm_set_default_model', (message, _sender, sendResponse) => {
    const { model } = message as { model?: string };
    if (!model) {
      sendResponse({ ok: false, error: 'Missing model' });
      return true;
    }
    bridgeRequest<{ ok: boolean; default_model: string }>('llm.set_default_model', { model })
      .then((result) => sendResponse({ ok: result.ok, default_model: result.default_model }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // List configured models
  registerHandler('llm_list_configured_models', (_message, _sender, sendResponse) => {
    console.log('[Background] llm_list_configured_models request');
    bridgeRequest<{ models: unknown[] }>('llm.list_configured_models')
      .then((result) => {
        console.log('[Background] llm_list_configured_models result:', JSON.stringify(result));
        sendResponse({ ok: true, models: result.models });
      })
      .catch((error) => {
        console.error('[Background] llm_list_configured_models error:', error);
        sendResponse(errorResponse(error));
      });
    return true;
  });

  // Add configured model
  registerHandler('llm_add_configured_model', (message, _sender, sendResponse) => {
    const { model_id, name } = message as { model_id?: string; name?: string };
    if (!model_id) {
      sendResponse({ ok: false, error: 'Missing model_id' });
      return true;
    }
    bridgeRequest<{ ok: boolean; name: string; model_id: string }>('llm.add_configured_model', { model_id, name })
      .then((result) => sendResponse({ ok: result.ok, name: result.name, model_id: result.model_id }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Remove configured model
  registerHandler('llm_remove_configured_model', (message, _sender, sendResponse) => {
    const { name } = message as { name?: string };
    if (!name) {
      sendResponse({ ok: false, error: 'Missing name' });
      return true;
    }
    bridgeRequest<{ ok: boolean }>('llm.remove_configured_model', { name })
      .then((result) => sendResponse({ ok: result.ok }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Set configured model default
  registerHandler('llm_set_configured_model_default', (message, _sender, sendResponse) => {
    const { name } = message as { name?: string };
    if (!name) {
      sendResponse({ ok: false, error: 'Missing name' });
      return true;
    }
    bridgeRequest<{ ok: boolean; default: string }>('llm.set_configured_model_default', { name })
      .then((result) => sendResponse({ ok: result.ok, default: result.default }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Test model
  registerHandler('llm_test_model', (message, _sender, sendResponse) => {
    const { model } = message as { model?: string };
    if (!model) {
      sendResponse({ ok: false, error: 'Missing model' });
      return true;
    }
    console.log('[Harbor] Testing model:', model);
    bridgeChat({
      model,
      messages: [{ role: 'user', content: 'Say "hello" in exactly one word.' }],
      max_tokens: 10,
    })
      .then((result) => {
        const response = result.content;
        console.log('[Harbor] Test result:', response);
        sendResponse({ ok: true, response });
      })
      .catch((error) => {
        console.error('[Harbor] Test failed:', error);
        sendResponse(errorResponse(error));
      });
    return true;
  });

  // LLM chat
  registerHandler('llm_chat', (message, _sender, sendResponse) => {
    const { messages, model } = message as { 
      messages?: Array<{ role: string; content: string }>;
      model?: string;
    };
    if (!messages || messages.length === 0) {
      sendResponse({ ok: false, error: 'Missing messages' });
      return true;
    }
    bridgeChat({ messages, model })
      .then((result) => sendResponse({ ok: true, response: result.message, model: result.model }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });
}
