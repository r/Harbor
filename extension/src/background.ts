import browser from 'webextension-polyfill';
import { setupProviderRouter, handlePermissionPromptResponse } from './provider/background-router';

const NATIVE_HOST_NAME = 'harbor_bridge_host';

interface HarborMessage {
  type: string;
  request_id: string;
  [key: string]: unknown;
}

interface PongMessage extends HarborMessage {
  type: 'pong';
  bridge_version: string;
}

interface ErrorResponse {
  type: 'error';
  request_id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface MCPServer {
  server_id: string;
  label: string;
  base_url: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error_message?: string | null;
}

interface AddServerResult extends HarborMessage {
  type: 'add_server_result';
  server: MCPServer;
}

interface ListServersResult extends HarborMessage {
  type: 'list_servers_result';
  servers: MCPServer[];
}

interface ConnectServerResult extends HarborMessage {
  type: 'connect_server_result';
  server: MCPServer;
  connection_info?: unknown;
}

interface DisconnectServerResult extends HarborMessage {
  type: 'disconnect_server_result';
  server: MCPServer;
}

interface ListToolsResult extends HarborMessage {
  type: 'list_tools_result';
  tools: unknown[];
  _todo?: string;
}

type BridgeResponse =
  | PongMessage
  | ErrorResponse
  | AddServerResult
  | ListServersResult
  | ConnectServerResult
  | DisconnectServerResult
  | ListToolsResult;

interface ConnectionState {
  connected: boolean;
  lastMessage: BridgeResponse | null;
  error: string | null;
}

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let port: browser.Runtime.Port | null = null;
let connectionState: ConnectionState = {
  connected: false,
  lastMessage: null,
  error: null,
};

const pendingRequests = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT_MS = 30000; // Default timeout for most requests
const DOCKER_TIMEOUT_MS = 300000; // 5 minutes for Docker (building images can be slow)
const CHAT_TIMEOUT_MS = 180000; // 3 minutes for chat (LLM + tools can be slow)

// Message log for debugging
interface LogEntry {
  id: number;
  timestamp: number;
  direction: 'send' | 'recv';
  type: string;
  summary: string;
  data: unknown;
}

const MAX_LOG_ENTRIES = 100;
let logIdCounter = 0;
const messageLog: LogEntry[] = [];

function addLogEntry(direction: 'send' | 'recv', type: string, data: unknown): void {
  const summary = getMessageSummary(direction, type, data);
  
  const entry: LogEntry = {
    id: ++logIdCounter,
    timestamp: Date.now(),
    direction,
    type,
    summary,
    data,
  };
  
  messageLog.push(entry);
  
  // Keep only the last MAX_LOG_ENTRIES
  while (messageLog.length > MAX_LOG_ENTRIES) {
    messageLog.shift();
  }
  
  // Broadcast the new log entry to any listeners
  browser.runtime
    .sendMessage({ type: 'log_entry', entry })
    .catch(() => {});
}

function getMessageSummary(direction: 'send' | 'recv', type: string, data: unknown): string {
  const arrow = direction === 'send' ? '→' : '←';
  const d = data as Record<string, unknown>;
  
  switch (type) {
    case 'catalog_get':
    case 'catalog_refresh':
      return `${arrow} Fetching catalog...`;
    case 'catalog_get_result':
    case 'catalog_refresh_result':
      const servers = (d.servers as unknown[])?.length || 0;
      return `${arrow} Received ${servers} servers`;
    case 'catalog_enrich':
      return `${arrow} Starting popularity enrichment...`;
    case 'catalog_enrich_result':
      return `${arrow} Enriched ${d.enriched || 0} servers`;
    case 'install_server':
      const name = (d.catalog_entry as Record<string, unknown>)?.name || 'server';
      return `${arrow} Installing ${name}...`;
    case 'install_server_result':
      return `${arrow} Installation complete`;
    case 'add_remote_server':
      return `${arrow} Adding remote server: ${d.name}...`;
    case 'add_remote_server_result':
      return `${arrow} Remote server added`;
    case 'import_config':
      return `${arrow} Importing MCP configuration...`;
    case 'import_config_result':
      return `${arrow} Imported ${d.imported?.length || 0} servers`;
    case 'mcp_connect':
      return `${arrow} Connecting to ${d.server_id}...`;
    case 'mcp_connect_result':
      return d.connected ? `${arrow} Connected!` : `${arrow} Connection failed`;
    case 'error':
      const errMsg = (d.error as Record<string, unknown>)?.message || 'Unknown error';
      return `${arrow} Error: ${errMsg}`;
    case 'hello':
      return `${arrow} Handshake`;
    case 'pong':
      return `${arrow} Bridge v${d.bridge_version}`;
    default:
      return `${arrow} ${type}`;
  }
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Broadcast a message to all extension pages (sidebar, chat, directory).
 * Uses runtime.sendMessage which reaches all extension contexts.
 */
function broadcastToExtension(message: Record<string, unknown>): void {
  browser.runtime
    .sendMessage(message)
    .catch(() => {
      // Ignore errors - no listeners is fine
    });
}

function updateState(updates: Partial<ConnectionState>): void {
  connectionState = { ...connectionState, ...updates };
  browser.storage.local.set({ connectionState });
  // Broadcast to any listening sidebars
  browser.runtime
    .sendMessage({ type: 'state_update', state: connectionState })
    .catch(() => {
      // No listeners, that's fine
    });
}

function handleNativeMessage(message: unknown): void {
  console.log('Received from native:', message);
  const response = message as BridgeResponse;
  
  // Log the received message
  addLogEntry('recv', response.type, response);

  updateState({
    connected: true,
    lastMessage: response,
    error: null,
  });

  // Handle status updates (pushed from bridge, not in response to a request)
  if (response.type === 'status_update') {
    console.log('[Background] Status update:', response);
    // Broadcast status updates to all extension pages
    browser.runtime
      .sendMessage({ 
        type: 'catalog_status', 
        category: (response as { category?: string }).category,
        status: (response as { status?: string }).status,
        message: (response as { message?: string }).message,
        ...response,
      })
      .catch(() => {});
    return;
  }
  
  // Handle server progress updates (Docker startup, etc.)
  if (response.type === 'server_progress') {
    console.log('[Background] Server progress:', response);
    // Broadcast progress to all extension pages
    browser.runtime
      .sendMessage({ 
        type: 'server_progress', 
        server_id: (response as { server_id?: string }).server_id,
        message: (response as { message?: string }).message,
        timestamp: (response as { timestamp?: number }).timestamp,
      })
      .catch(() => {});
    return;
  }

  // Resolve pending request if this is a response
  const requestId = response.request_id;
  if (requestId && pendingRequests.has(requestId)) {
    const pending = pendingRequests.get(requestId)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    pending.resolve(response);
  }

  // Broadcast the response to sidebars
  browser.runtime
    .sendMessage({ type: 'bridge_response', response })
    .catch(() => {});
  
  // Broadcast specific events for UI updates
  if (response.type === 'install_server_result' || 
      response.type === 'uninstall_server_result') {
    // Notify sidebar to refresh installed servers list
    browser.runtime
      .sendMessage({ type: 'installed_servers_changed' })
      .catch(() => {});
  }
}

function handleNativeDisconnect(): void {
  const error = browser.runtime.lastError?.message ?? 'Connection closed';
  console.error('Native port disconnected:', error);
  port = null;

  // Reject all pending requests
  for (const [requestId, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`Connection lost: ${error}`));
    pendingRequests.delete(requestId);
  }

  updateState({
    connected: false,
    error,
  });
}

function connectToNative(): boolean {
  if (port) {
    return true;
  }

  try {
    port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(handleNativeDisconnect);
    updateState({ connected: true, error: null });
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to connect';
    console.error('Failed to connect to native host:', error);
    updateState({
      connected: false,
      error,
    });
    return false;
  }
}

async function sendToBridge(message: HarborMessage, timeoutMs?: number): Promise<BridgeResponse> {
  if (!port && !connectToNative()) {
    throw new Error('Not connected to native bridge');
  }

  const effectiveTimeout = timeoutMs || REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(message.request_id);
      reject(new Error(`Request timed out after ${effectiveTimeout / 1000}s`));
    }, effectiveTimeout);

    pendingRequests.set(message.request_id, { resolve, reject, timeout });

    // Log the sent message
    addLogEntry('send', message.type, message);
    
    console.log('Sending to native:', message);
    port!.postMessage(message);
  });
}

function sendHello(): void {
  const message: HarborMessage = {
    type: 'hello',
    request_id: generateRequestId(),
  };
  sendToBridge(message).catch((err) => {
    console.error('Failed to send hello:', err);
  });
}

// Handle messages from sidebar
browser.runtime.onMessage.addListener(
  (message: unknown, _sender: browser.Runtime.MessageSender) => {
    const msg = message as { type: string; [key: string]: unknown };

    if (msg.type === 'get_state') {
      return Promise.resolve(connectionState);
    }
    
    if (msg.type === 'get_message_log') {
      return Promise.resolve({ log: messageLog });
    }

    if (msg.type === 'send_hello') {
      if (!port) {
        connectToNative();
      }
      sendHello();
      return Promise.resolve({ sent: true });
    }

    // Diagnostic ping - tests the full pipeline including push status updates
    if (msg.type === 'send_ping') {
      if (!port) {
        connectToNative();
      }
      return sendToBridge({
        type: 'ping',
        request_id: generateRequestId(),
        echo: msg.echo || 'test',
      });
    }

    if (msg.type === 'reconnect') {
      if (port) {
        port.disconnect();
        port = null;
      }
      connectToNative();
      sendHello();
      return Promise.resolve({ reconnecting: true });
    }

    // Server management messages
    if (msg.type === 'add_server') {
      return sendToBridge({
        type: 'add_server',
        request_id: generateRequestId(),
        label: msg.label as string,
        base_url: msg.base_url as string,
      });
    }

    if (msg.type === 'remove_server') {
      return sendToBridge({
        type: 'remove_server',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    if (msg.type === 'list_servers') {
      return sendToBridge({
        type: 'list_servers',
        request_id: generateRequestId(),
      });
    }

    if (msg.type === 'connect_server') {
      return sendToBridge({
        type: 'connect_server',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    if (msg.type === 'disconnect_server') {
      return sendToBridge({
        type: 'disconnect_server',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    if (msg.type === 'list_tools') {
      return sendToBridge({
        type: 'list_tools',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    // Catalog messages - forward to native bridge
    if (msg.type === 'catalog_get') {
      const force = msg.force === true;
      console.log('[catalog] Getting catalog via bridge, force:', force);
      return sendToBridge({
        type: 'catalog_get',
        request_id: generateRequestId(),
        force,
      }).then(response => {
        // Bridge returns catalog_get_result, extract the data
        if (response && 'servers' in response) {
          return response;
        }
        throw new Error(response?.error?.message || 'Failed to get catalog');
      });
    }

    if (msg.type === 'catalog_refresh') {
      console.log('[catalog] Forcing refresh via bridge');
      return sendToBridge({
        type: 'catalog_refresh',
        request_id: generateRequestId(),
      }).then(response => {
        if (response && 'servers' in response) {
          return response;
        }
        throw new Error(response?.error?.message || 'Failed to refresh catalog');
      });
    }

    if (msg.type === 'catalog_search') {
      const query = (msg.query as string) || '';
      console.log('[catalog] Searching via bridge:', query);
      return sendToBridge({
        type: 'catalog_search',
        request_id: generateRequestId(),
        query,
      }).then(response => {
        if (response && 'servers' in response) {
          return response;
        }
        throw new Error(response?.error?.message || 'Failed to search catalog');
      });
    }

    if (msg.type === 'catalog_enrich') {
      console.log('[catalog] Starting enrichment via bridge');
      return sendToBridge({
        type: 'catalog_enrich',
        request_id: generateRequestId(),
      }, 120000); // 2 minute timeout for enrichment
    }

    // Installer messages - forward to native bridge
    if (msg.type === 'check_runtimes') {
      return sendToBridge({
        type: 'check_runtimes',
        request_id: generateRequestId(),
      });
    }

    if (msg.type === 'install_server') {
      return sendToBridge({
        type: 'install_server',
        request_id: generateRequestId(),
        catalog_entry: msg.catalog_entry,
        package_index: msg.package_index || 0,
      });
    }

    if (msg.type === 'uninstall_server') {
      return sendToBridge({
        type: 'uninstall_server',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      });
    }

    if (msg.type === 'add_remote_server') {
      return sendToBridge({
        type: 'add_remote_server',
        request_id: generateRequestId(),
        name: msg.name,
        url: msg.url,
        transport_type: msg.transport_type || 'http',
        headers: msg.headers,
      }).then(result => {
        // Notify sidebar to refresh installed servers list
        browser.runtime
          .sendMessage({ type: 'installed_servers_changed' })
          .catch(() => {});
        return result;
      });
    }

    if (msg.type === 'import_config') {
      return sendToBridge({
        type: 'import_config',
        request_id: generateRequestId(),
        config_json: msg.config_json,
        install_url: msg.install_url,
      }).then(result => {
        // Notify sidebar to refresh installed servers list
        browser.runtime
          .sendMessage({ type: 'installed_servers_changed' })
          .catch(() => {});
        return result;
      });
    }

    if (msg.type === 'list_installed') {
      return sendToBridge({
        type: 'list_installed',
        request_id: generateRequestId(),
      });
    }

    // Curated servers messages
    if (msg.type === 'get_curated_servers') {
      return sendToBridge({
        type: 'get_curated_servers',
        request_id: generateRequestId(),
      });
    }

    if (msg.type === 'install_curated_server') {
      return sendToBridge({
        type: 'install_curated_server',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      }).then(result => {
        // Notify sidebar to refresh installed servers list
        if (result && result.type === 'install_curated_server_result' && result.success) {
          browser.runtime
            .sendMessage({ type: 'installed_servers_changed' })
            .catch(() => {});
        }
        return result;
      });
    }

    if (msg.type === 'install_github_repo') {
      return sendToBridge({
        type: 'install_github_repo',
        request_id: generateRequestId(),
        github_url: msg.github_url,
      }).then(result => {
        // Notify sidebar to refresh installed servers list
        if (result && result.type === 'install_github_repo_result' && result.success) {
          browser.runtime
            .sendMessage({ type: 'installed_servers_changed' })
            .catch(() => {});
        }
        return result;
      });
    }

    // Install from VS Code button (detected on web pages)
    if (msg.type === 'install_from_vscode_button') {
      const params = msg.params as { 
        name: string; 
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        npmPackage?: string;
        pypiPackage?: string;
      };
      
      // Determine what to install
      let installType = 'install_server';
      let installPayload: Record<string, unknown> = {
        request_id: generateRequestId(),
      };
      
      if (params.npmPackage) {
        // Install npm package
        installPayload.type = 'install_server';
        installPayload.catalog_entry = {
          id: `vscode-${params.name}-${Date.now()}`,
          name: params.name,
          description: `Installed from VS Code button on ${msg.pageUrl}`,
          endpointUrl: '',
          installableOnly: true,
          tags: ['vscode'],
          source: 'vscode-button',
          fetchedAt: Date.now(),
          homepageUrl: msg.pageUrl,
          repositoryUrl: '',
          packages: [{
            registryType: 'npm',
            identifier: params.npmPackage,
            environmentVariables: [],
          }],
        };
      } else if (params.pypiPackage) {
        // Install pypi package
        installPayload.type = 'install_server';
        installPayload.catalog_entry = {
          id: `vscode-${params.name}-${Date.now()}`,
          name: params.name,
          description: `Installed from VS Code button on ${msg.pageUrl}`,
          endpointUrl: '',
          installableOnly: true,
          tags: ['vscode'],
          source: 'vscode-button',
          fetchedAt: Date.now(),
          homepageUrl: msg.pageUrl,
          repositoryUrl: '',
          packages: [{
            registryType: 'pypi',
            identifier: params.pypiPackage,
            environmentVariables: [],
          }],
        };
      } else {
        // Unknown install type - return error
        return Promise.resolve({
          success: false,
          error: { message: 'Unknown install type. Expected npm or pypi package.' },
        });
      }
      
      return sendToBridge(installPayload as HarborMessage).then(result => {
        if (result && result.type === 'install_server_result') {
          browser.runtime
            .sendMessage({ type: 'installed_servers_changed' })
            .catch(() => {});
          return { success: true, server: result.server };
        }
        return {
          success: false,
          error: result?.error || { message: 'Installation failed' },
        };
      });
    }

    if (msg.type === 'start_installed') {
      return sendToBridge({
        type: 'start_installed',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      });
    }

    if (msg.type === 'stop_installed') {
      return sendToBridge({
        type: 'stop_installed',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      });
    }

    if (msg.type === 'set_server_secrets') {
      return sendToBridge({
        type: 'set_server_secrets',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        secrets: msg.secrets,
      });
    }

    if (msg.type === 'get_server_status') {
      return sendToBridge({
        type: 'get_server_status',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      });
    }

    // MCP stdio messages (for locally installed servers)
    if (msg.type === 'mcp_connect') {
      const useDocker = msg.use_docker || false;
      console.log('[Background] mcp_connect request for:', msg.server_id, 'skip_security_check:', msg.skip_security_check, 'use_docker:', useDocker);
      
      // Use longer timeout for Docker (building images takes time)
      const timeout = useDocker ? DOCKER_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      
      return sendToBridge({
        type: 'mcp_connect',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        skip_security_check: msg.skip_security_check || false,
        use_docker: useDocker,
      }, timeout).then(result => {
        console.log('[Background] mcp_connect result:', result);
        // Broadcast to all extension pages that a server connected
        if (result && result.type === 'mcp_connect_result' && result.connected) {
          broadcastToExtension({
            type: 'mcp_server_connected',
            server_id: msg.server_id,
            tools: result.tools,
            running_in_docker: result.running_in_docker,
          });
        }
        return result;
      });
    }
    
    // Docker-related messages
    if (msg.type === 'check_docker') {
      return sendToBridge({
        type: 'check_docker',
        request_id: generateRequestId(),
      });
    }
    
    if (msg.type === 'build_docker_images') {
      return sendToBridge({
        type: 'build_docker_images',
        request_id: generateRequestId(),
        image_type: msg.image_type,
      });
    }
    
    if (msg.type === 'set_docker_mode') {
      return sendToBridge({
        type: 'set_docker_mode',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        use_docker: msg.use_docker,
        volumes: msg.volumes,
      });
    }
    
    if (msg.type === 'should_prefer_docker') {
      return sendToBridge({
        type: 'should_prefer_docker',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      });
    }

    if (msg.type === 'mcp_disconnect') {
      return sendToBridge({
        type: 'mcp_disconnect',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      }).then(result => {
        // Broadcast to all extension pages that a server disconnected
        broadcastToExtension({
          type: 'mcp_server_disconnected',
          server_id: msg.server_id,
        });
        return result;
      });
    }

    if (msg.type === 'mcp_list_tools') {
      return sendToBridge({
        type: 'mcp_list_tools',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      });
    }

    // Credential messages
    if (msg.type === 'set_credential') {
      return sendToBridge({
        type: 'set_credential',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        key: msg.key,
        value: msg.value,
        credential_type: msg.credential_type || 'api_key',
      });
    }

    if (msg.type === 'list_credentials') {
      return sendToBridge({
        type: 'list_credentials',
        request_id: generateRequestId(),
        server_id: msg.server_id,
      });
    }

    if (msg.type === 'delete_credential') {
      return sendToBridge({
        type: 'delete_credential',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        key: msg.key,
      });
    }

    // OAuth messages
    if (msg.type === 'oauth_start') {
      return sendToBridge({
        type: 'oauth_start',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        credential_key: msg.credential_key,
        provider_id: msg.provider_id,
      }).then(async (result) => {
        if (result?.type === 'oauth_start_result' && result.auth_url) {
          // Open the OAuth URL in a new window
          try {
            await browser.windows.create({
              url: result.auth_url as string,
              type: 'popup',
              width: 600,
              height: 700,
            });
          } catch (err) {
            // Fallback to opening in a tab if popup fails
            await browser.tabs.create({ url: result.auth_url as string });
          }
        }
        return result;
      });
    }

    if (msg.type === 'oauth_cancel') {
      return sendToBridge({
        type: 'oauth_cancel',
        request_id: generateRequestId(),
        state: msg.state,
      });
    }

    if (msg.type === 'oauth_revoke') {
      return sendToBridge({
        type: 'oauth_revoke',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        credential_key: msg.credential_key,
      });
    }

    if (msg.type === 'oauth_status') {
      return sendToBridge({
        type: 'oauth_status',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        credential_key: msg.credential_key,
      });
    }

    if (msg.type === 'list_oauth_providers') {
      return sendToBridge({
        type: 'list_oauth_providers',
        request_id: generateRequestId(),
      });
    }

    // LLM messages
    if (msg.type === 'llm_detect') {
      return sendToBridge({
        type: 'llm_detect',
        request_id: generateRequestId(),
      });
    }

    if (msg.type === 'llm_setup_status') {
      return sendToBridge({
        type: 'llm_setup_status',
        request_id: generateRequestId(),
      });
    }

    if (msg.type === 'llm_download_model') {
      return sendToBridge({
        type: 'llm_download_model',
        request_id: generateRequestId(),
        model_id: msg.model_id,
      });
    }

    if (msg.type === 'llm_delete_model') {
      return sendToBridge({
        type: 'llm_delete_model',
        request_id: generateRequestId(),
        model_id: msg.model_id,
      });
    }

    if (msg.type === 'llm_start_local') {
      return sendToBridge({
        type: 'llm_start_local',
        request_id: generateRequestId(),
        model_id: msg.model_id,
        port: msg.port,
      });
    }

    if (msg.type === 'llm_stop_local') {
      return sendToBridge({
        type: 'llm_stop_local',
        request_id: generateRequestId(),
      });
    }

    if (msg.type === 'llm_chat') {
      // Use longer timeout for LLM chat
      return sendToBridge({
        type: 'llm_chat',
        request_id: generateRequestId(),
        messages: msg.messages,
        tools: msg.tools,
        model: msg.model,
        max_tokens: msg.max_tokens,
        temperature: msg.temperature,
        system_prompt: msg.system_prompt,
      }, CHAT_TIMEOUT_MS);
    }

    // MCP connections list
    if (msg.type === 'mcp_list_connections') {
      return sendToBridge({
        type: 'mcp_list_connections',
        request_id: generateRequestId(),
      });
    }

    // Chat session messages
    if (msg.type === 'chat_create_session') {
      return sendToBridge({
        type: 'chat_create_session',
        request_id: generateRequestId(),
        enabled_servers: msg.enabled_servers,
        name: msg.name,
        system_prompt: msg.system_prompt,
        max_iterations: msg.max_iterations,
      });
    }

    if (msg.type === 'chat_send_message') {
      // Use longer timeout for chat (LLM + tools can be slow)
      return sendToBridge({
        type: 'chat_send_message',
        request_id: generateRequestId(),
        session_id: msg.session_id,
        message: msg.message,
        use_tool_router: msg.use_tool_router,
      }, CHAT_TIMEOUT_MS);
    }

    if (msg.type === 'chat_get_session') {
      return sendToBridge({
        type: 'chat_get_session',
        request_id: generateRequestId(),
        session_id: msg.session_id,
      });
    }

    if (msg.type === 'chat_list_sessions') {
      return sendToBridge({
        type: 'chat_list_sessions',
        request_id: generateRequestId(),
        limit: msg.limit,
      });
    }

    if (msg.type === 'chat_delete_session') {
      return sendToBridge({
        type: 'chat_delete_session',
        request_id: generateRequestId(),
        session_id: msg.session_id,
      });
    }

    if (msg.type === 'chat_update_session') {
      return sendToBridge({
        type: 'chat_update_session',
        request_id: generateRequestId(),
        session_id: msg.session_id,
        updates: msg.updates,
      });
    }

    if (msg.type === 'chat_clear_messages') {
      return sendToBridge({
        type: 'chat_clear_messages',
        request_id: generateRequestId(),
        session_id: msg.session_id,
      });
    }

    // MCP tool call (used by JS AI Provider)
    if (msg.type === 'mcp_call_tool') {
      return sendToBridge({
        type: 'mcp_call_tool',
        request_id: generateRequestId(),
        server_id: msg.server_id,
        tool_name: msg.tool_name,
        arguments: msg.arguments,
      });
    }

    // Permission prompt response (from permission-prompt.html)
    if (msg.type === 'provider_permission_response') {
      handlePermissionPromptResponse(msg.promptId, msg.decision);
      return Promise.resolve({ received: true });
    }

    // Proxy fetch requests from sidebar (for CORS)
    if (msg.type === 'proxy_fetch') {
      console.log('[proxy_fetch] Received request for:', msg.url);
      return (async () => {
        try {
          console.log('[proxy_fetch] Starting fetch...');
          const response = await fetch(msg.url as string, {
            method: (msg.method as string) || 'GET',
            headers: (msg.headers as Record<string, string>) || {},
          });
          
          console.log('[proxy_fetch] Response status:', response.status);
          
          if (!response.ok) {
            console.log('[proxy_fetch] Response not ok:', response.statusText);
            return { 
              ok: false, 
              status: response.status, 
              error: response.statusText 
            };
          }
          
          const contentType = response.headers.get('content-type') || '';
          let data: string | object;
          
          if (contentType.includes('application/json')) {
            data = await response.json();
            console.log('[proxy_fetch] Parsed JSON, keys:', Object.keys(data as object));
          } else {
            data = await response.text();
            console.log('[proxy_fetch] Got text, length:', (data as string).length);
          }
          
          return { ok: true, status: response.status, data };
        } catch (err) {
          console.error('[proxy_fetch] Error:', err);
          return { 
            ok: false, 
            status: 0, 
            error: err instanceof Error ? err.message : 'Fetch failed' 
          };
        }
      })();
    }

    return Promise.resolve(undefined);
  }
);

// Connect on startup
connectToNative();
sendHello();

// Auto-detect LLM on startup so provider API can use it immediately
async function autoDetectLLM(): Promise<void> {
  try {
    // Give the bridge a moment to initialize
    await new Promise(r => setTimeout(r, 500));
    
    const response = await sendToBridge({
      type: 'llm_detect',
      request_id: generateRequestId(),
    });
    
    if (response.type === 'llm_detect_result') {
      console.log('[Background] Auto-detected LLM providers:', response);
    }
  } catch (err) {
    console.warn('[Background] LLM auto-detection failed:', err);
  }
}

autoDetectLLM();

// Initialize the JS AI Provider router
setupProviderRouter();

console.log('Harbor background script initialized');
