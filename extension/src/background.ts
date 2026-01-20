/**
 * Harbor Extension - Background Script
 *
 * Main entry point for the extension's background service worker.
 * Initializes all modules and sets up message routing.
 */

import { initializePolicyStore } from './policy/store';
import { initializeBridgeClient, getBridgeConnectionState, checkBridgeHealth, bridgeRequest } from './llm/bridge-client';
import { getConnectionState as getNativeConnectionState } from './llm/native-bridge';
import { initializeMcpHost, addServer, startServer, stopServer, validateAndStartServer, removeServer, listServersWithStatus, callTool } from './mcp/host';
import { initializeRouter } from './agents/background-router';
import { cleanupExpiredGrants, listAllPermissions, revokePermissions } from './policy/permissions';
import { initializeAddressBar } from './agents/addressbar';

console.log('[Harbor] WASM MCP extension starting...');

// Initialize modules
initializePolicyStore();

// Connect to native bridge (all communication goes through stdio)
initializeBridgeClient();
initializeMcpHost();
initializeRouter();
initializeAddressBar();

// Cleanup expired permission grants on startup
cleanupExpiredGrants();

// =============================================================================
// Legacy Message Handlers (for sidebar and other internal UIs)
// =============================================================================

// Debug: log all incoming messages
chrome.runtime.onMessage.addListener((message) => {
  console.log('[Harbor] Incoming message:', message?.type, message);
  return false; // Don't handle, let other listeners process
});

// Debug: expose callTool for console testing
(globalThis as Record<string, unknown>).debugCallTool = callTool;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_get_servers') {
    return false;
  }
  (async () => {
    const servers = await listServersWithStatus();
    sendResponse({ ok: true, servers });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_start_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  (async () => {
    const started = await startServer(serverId);
    sendResponse({ ok: started });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_stop_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  try {
    const stopped = stopServer(serverId);
    sendResponse({ ok: stopped });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_install_server') {
    return false;
  }
  const manifest = message.manifest as { id?: string };
  if (!manifest?.id) {
    sendResponse({ ok: false, error: 'Missing manifest id' });
    return true;
  }
  (async () => {
    await addServer(message.manifest);
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_validate_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  (async () => {
    const result = await validateAndStartServer(serverId);
    sendResponse(result);
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_remove_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  (async () => {
    await removeServer(serverId);
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Bridge Status Handlers
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bridge_get_status') {
    return false;
  }
  const state = getBridgeConnectionState();
  sendResponse({ ok: true, ...state });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bridge_check_health') {
    return false;
  }
  (async () => {
    await checkBridgeHealth();
    const state = getBridgeConnectionState();
    sendResponse({ ok: true, ...state });
  })().catch((error) => {
    sendResponse({
      ok: false,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// LLM Configuration Handlers
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_providers') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ providers: unknown[]; default_provider?: string }>('llm.list_providers');
    sendResponse({ ok: true, providers: result.providers, default_provider: result.default_provider });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_provider_types') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ provider_types: unknown[] }>('llm.list_provider_types');
    sendResponse({ ok: true, provider_types: result.provider_types });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_get_config') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ default_model?: string; providers: Record<string, unknown> }>('llm.get_config');
    sendResponse({ ok: true, config: result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_configure_provider') {
    return false;
  }
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
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; id: string }>('llm.configure_provider', {
      id,
      provider,
      name,
      api_key,
      base_url,
      enabled,
    });
    sendResponse({ ok: result.ok, id: result.id });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_set_default_provider') {
    return false;
  }
  const { id } = message as { id?: string };
  if (!id) {
    sendResponse({ ok: false, error: 'Missing id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; default_provider: string }>('llm.set_default_provider', { id });
    sendResponse({ ok: result.ok, default_provider: result.default_provider });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_remove_provider') {
    return false;
  }
  const { id } = message as { id?: string };
  if (!id) {
    sendResponse({ ok: false, error: 'Missing id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean }>('llm.remove_provider', { id });
    sendResponse({ ok: result.ok });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_check_provider') {
    return false;
  }
  const { provider } = message as { provider?: string };
  if (!provider) {
    sendResponse({ ok: false, error: 'Missing provider' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ provider: string; available: boolean; error?: string }>('llm.check_provider', { provider });
    sendResponse({ ok: true, status: result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_models') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_models');
    sendResponse({ ok: true, models: result.models });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_set_default_model') {
    return false;
  }
  const { model } = message as { model?: string };
  if (!model) {
    sendResponse({ ok: false, error: 'Missing model' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; default_model: string }>('llm.set_default_model', { model });
    sendResponse({ ok: result.ok, default_model: result.default_model });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Configured Models Handlers
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_configured_models') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    sendResponse({ ok: true, models: result.models });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_add_configured_model') {
    return false;
  }
  const { model_id, name } = message as { model_id?: string; name?: string };
  if (!model_id) {
    sendResponse({ ok: false, error: 'Missing model_id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; name: string; model_id: string }>('llm.add_configured_model', { model_id, name });
    sendResponse({ ok: result.ok, name: result.name, model_id: result.model_id });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_remove_configured_model') {
    return false;
  }
  const { name } = message as { name?: string };
  if (!name) {
    sendResponse({ ok: false, error: 'Missing name' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean }>('llm.remove_configured_model', { name });
    sendResponse({ ok: result.ok });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_set_configured_model_default') {
    return false;
  }
  const { name } = message as { name?: string };
  if (!name) {
    sendResponse({ ok: false, error: 'Missing name' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; default: string }>('llm.set_configured_model_default', { name });
    sendResponse({ ok: result.ok, default: result.default });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_test_model') {
    return false;
  }
  const { model } = message as { model?: string };
  if (!model) {
    sendResponse({ ok: false, error: 'Missing model' });
    return true;
  }
  (async () => {
    console.log('[Harbor] Testing model:', model);
    const result = await bridgeRequest<{ message?: { content?: string }; content?: string }>('llm.chat', {
      model,
      messages: [{ role: 'user', content: 'Say "hello" in exactly one word.' }],
      max_tokens: 10,
    });
    const response = result.message?.content || result.content || '';
    console.log('[Harbor] Test result:', response);
    sendResponse({ ok: true, response });
  })().catch((error) => {
    console.error('[Harbor] Test failed:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// Generic bridge RPC passthrough (used by demo-bootstrap)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bridge_rpc') {
    return false;
  }
  const { method, params } = message as { method?: string; params?: unknown };
  if (!method) {
    sendResponse({ ok: false, error: 'Missing method' });
    return true;
  }
  (async () => {
    console.log('[Harbor] bridge_rpc:', method);
    const result = await bridgeRequest(method, params);
    sendResponse({ ok: true, result });
  })().catch((error) => {
    console.error('[Harbor] bridge_rpc error:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_call_tool') {
    return false;
  }
  const { serverId, toolName, args } = message as { serverId?: string; toolName?: string; args?: Record<string, unknown> };
  console.log('[Harbor] sidebar_call_tool:', serverId, toolName, args);
  if (!serverId || !toolName) {
    sendResponse({ ok: false, error: 'Missing serverId or toolName' });
    return true;
  }
  (async () => {
    console.log('[Harbor] Calling tool...');
    const result = await callTool(serverId, toolName, args || {});
    console.log('[Harbor] Tool result:', result);
    sendResponse(result);
  })().catch((error) => {
    console.error('[Harbor] Tool error:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_chat') {
    return false;
  }
  const { messages, model } = message as { 
    messages?: Array<{ role: string; content: string }>;
    model?: string;
  };
  if (!messages || messages.length === 0) {
    sendResponse({ ok: false, error: 'Missing messages' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ 
      response: { role: string; content: string };
      model: string;
    }>('llm.chat', { messages, model });
    sendResponse({ ok: true, response: result.response, model: result.model });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Native Bridge Status Handler
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'native_bridge_status') {
    return false;
  }
  const state = getNativeConnectionState();
  sendResponse({ ok: true, ...state });
  return true;
});

// =============================================================================
// Permission Management Handlers
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'list_all_permissions') {
    return false;
  }
  (async () => {
    const permissions = await listAllPermissions();
    sendResponse({ type: 'list_all_permissions_result', permissions });
  })().catch((error) => {
    sendResponse({
      type: 'list_all_permissions_result',
      permissions: [],
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'revoke_origin_permissions') {
    return false;
  }
  const { origin } = message as { origin?: string };
  if (!origin) {
    sendResponse({ ok: false, error: 'Missing origin' });
    return true;
  }
  (async () => {
    await revokePermissions(origin);
    // Notify sidebar to refresh
    chrome.runtime.sendMessage({ type: 'permissions_changed' }).catch(() => {});
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

console.log('[Harbor] WASM MCP extension initialized.');
