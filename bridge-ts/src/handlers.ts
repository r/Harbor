/**
 * Message handlers for the native messaging bridge.
 */

import { log } from './native-messaging.js';
import { getServerStore, ServerStore } from './server-store.js';
import { getMcpClient, McpClient } from './mcp-client.js';
import { getCatalogManager, CatalogManager } from './catalog/index.js';
import { getInstalledServerManager, InstalledServerManager } from './installer/index.js';
import { getSecretStore } from './installer/secrets.js';
import { getMcpClientManager, McpClientManager } from './mcp/index.js';
import { 
  Message, 
  ErrorResponse, 
  ResultResponse, 
  ServerStatus,
  CatalogServer,
  CredentialType,
  CredentialRequirement,
  StoredCredential,
} from './types.js';
import { getLLMManager, LLMManager, ChatMessage, ToolDefinition, getLLMSetupManager, DownloadProgress } from './llm/index.js';
import { 
  getChatOrchestrator, 
  getChatSessionStore, 
  createSession,
  ChatSession,
  OrchestrationResult,
  OrchestrationStep,
} from './chat/index.js';

const VERSION = '0.1.0';

type MessageHandler = (
  message: Message,
  store: ServerStore,
  client: McpClient,
  catalog: CatalogManager,
  installer: InstalledServerManager,
  mcpManager: McpClientManager,
  llmManager: LLMManager
) => Promise<ResultResponse | ErrorResponse>;

function makeError(
  requestId: string,
  code: string,
  message: string,
  details?: unknown
): ErrorResponse {
  return {
    type: 'error',
    request_id: requestId,
    error: { code, message, details },
  };
}

function makeResult(
  type: string,
  requestId: string,
  data: object
): ResultResponse {
  return {
    type: `${type}_result`,
    request_id: requestId,
    ...data,
  } as ResultResponse;
}

// =============================================================================
// Core Handlers
// =============================================================================

const handleHello: MessageHandler = async (message) => {
  return {
    type: 'pong',
    request_id: message.request_id || '',
    bridge_version: VERSION,
  };
};

const handleAddServer: MessageHandler = async (message, store) => {
  const requestId = message.request_id || '';
  const label = message.label as string;
  const baseUrl = message.base_url as string;

  if (!label || typeof label !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'label' parameter");
  }
  if (!baseUrl || typeof baseUrl !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'base_url' parameter");
  }

  try {
    const server = await store.addServer(label, baseUrl);
    return makeResult('add_server', requestId, { server });
  } catch (e) {
    log(`Failed to add server: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to add server: ${e}`);
  }
};

const handleRemoveServer: MessageHandler = async (message, store) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string;

  if (!serverId || typeof serverId !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'server_id' parameter");
  }

  try {
    const removed = await store.removeServer(serverId);
    if (!removed) {
      return makeError(requestId, 'not_found', `Server not found: ${serverId}`);
    }
    return makeResult('remove_server', requestId, { removed: true });
  } catch (e) {
    log(`Failed to remove server: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to remove server: ${e}`);
  }
};

const handleListServers: MessageHandler = async (message, store) => {
  const requestId = message.request_id || '';

  try {
    const servers = await store.listServers();
    return makeResult('list_servers', requestId, { servers });
  } catch (e) {
    log(`Failed to list servers: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to list servers: ${e}`);
  }
};

const handleConnectServer: MessageHandler = async (message, store, client) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string;

  if (!serverId || typeof serverId !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'server_id' parameter");
  }

  const server = await store.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not found: ${serverId}`);
  }

  await store.updateStatus(serverId, ServerStatus.CONNECTING);

  try {
    const result = await client.connect(server.baseUrl);

    if (result.success) {
      await store.updateStatus(serverId, ServerStatus.CONNECTED);
      const updatedServer = await store.getServer(serverId);
      return makeResult('connect_server', requestId, {
        server: updatedServer,
        connection_info: result.serverInfo,
      });
    } else {
      await store.updateStatus(serverId, ServerStatus.ERROR, result.message);
      return makeError(requestId, 'connection_failed', result.message);
    }
  } catch (e) {
    log(`Failed to connect to server: ${e}`);
    await store.updateStatus(serverId, ServerStatus.ERROR, String(e));
    return makeError(requestId, 'connection_error', `Connection error: ${e}`);
  }
};

const handleDisconnectServer: MessageHandler = async (message, store, client) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string;

  if (!serverId || typeof serverId !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'server_id' parameter");
  }

  const server = await store.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not found: ${serverId}`);
  }

  try {
    await client.disconnect(server.baseUrl);
    await store.updateStatus(serverId, ServerStatus.DISCONNECTED);
    const updatedServer = await store.getServer(serverId);
    return makeResult('disconnect_server', requestId, { server: updatedServer });
  } catch (e) {
    log(`Failed to disconnect from server: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to disconnect: ${e}`);
  }
};

const handleListTools: MessageHandler = async (message, store, client) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string;

  if (!serverId || typeof serverId !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'server_id' parameter");
  }

  const server = await store.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not found: ${serverId}`);
  }

  if (server.status !== ServerStatus.CONNECTED) {
    return makeError(requestId, 'not_connected', `Server is not connected (status: ${server.status})`);
  }

  try {
    const tools = await client.listTools(server.baseUrl);
    return makeResult('list_tools', requestId, { tools });
  } catch (e) {
    log(`Failed to list tools: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to list tools: ${e}`);
  }
};

const handleListResources: MessageHandler = async (message, store, client) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string;

  if (!serverId || typeof serverId !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'server_id' parameter");
  }

  const server = await store.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not found: ${serverId}`);
  }

  if (server.status !== ServerStatus.CONNECTED) {
    return makeError(requestId, 'not_connected', `Server is not connected (status: ${server.status})`);
  }

  try {
    const resources = await client.listResources(server.baseUrl);
    return makeResult('list_resources', requestId, { resources });
  } catch (e) {
    log(`Failed to list resources: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to list resources: ${e}`);
  }
};

const handleListPrompts: MessageHandler = async (message, store, client) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string;

  if (!serverId || typeof serverId !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'server_id' parameter");
  }

  const server = await store.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not found: ${serverId}`);
  }

  if (server.status !== ServerStatus.CONNECTED) {
    return makeError(requestId, 'not_connected', `Server is not connected (status: ${server.status})`);
  }

  try {
    const prompts = await client.listPrompts(server.baseUrl);
    return makeResult('list_prompts', requestId, { prompts });
  } catch (e) {
    log(`Failed to list prompts: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to list prompts: ${e}`);
  }
};

const handleCallTool: MessageHandler = async (message, store, client) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string;
  const toolName = message.tool_name as string;
  const args = (message.arguments || {}) as Record<string, unknown>;

  if (!serverId || typeof serverId !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'server_id' parameter");
  }
  if (!toolName || typeof toolName !== 'string') {
    return makeError(requestId, 'invalid_params', "Missing or invalid 'tool_name' parameter");
  }

  const server = await store.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not found: ${serverId}`);
  }

  if (server.status !== ServerStatus.CONNECTED) {
    return makeError(requestId, 'not_connected', `Server is not connected (status: ${server.status})`);
  }

  try {
    const result = await client.callTool(server.baseUrl, toolName, args);
    if (result.success) {
      return makeResult('call_tool', requestId, { content: result.content });
    } else {
      return makeError(requestId, 'tool_error', result.error || 'Tool invocation failed');
    }
  } catch (e) {
    log(`Failed to call tool: ${e}`);
    return makeError(requestId, 'internal_error', `Failed to call tool: ${e}`);
  }
};

// =============================================================================
// Catalog Handlers
// =============================================================================

const handleCatalogGet: MessageHandler = async (message, _store, _client, catalog) => {
  const requestId = message.request_id || '';
  const force = message.force as boolean || false;
  const query = message.query as string | undefined;

  try {
    const result = await catalog.fetchAll({ forceRefresh: force, query });
    return makeResult('catalog_get', requestId, result);
  } catch (e) {
    log(`Failed to fetch catalog: ${e}`);
    return makeError(requestId, 'catalog_error', `Failed to fetch catalog: ${e}`);
  }
};

const handleCatalogRefresh: MessageHandler = async (message, _store, _client, catalog) => {
  const requestId = message.request_id || '';
  const query = message.query as string | undefined;

  try {
    const result = await catalog.fetchAll({ forceRefresh: true, query });
    return makeResult('catalog_refresh', requestId, result);
  } catch (e) {
    log(`Failed to refresh catalog: ${e}`);
    return makeError(requestId, 'catalog_error', `Failed to refresh catalog: ${e}`);
  }
};

const handleCatalogSearch: MessageHandler = async (message, _store, _client, catalog) => {
  const requestId = message.request_id || '';
  const query = message.query as string || '';

  if (!query) {
    return makeError(requestId, 'invalid_request', "Missing 'query' field for catalog search");
  }

  try {
    const result = await catalog.search(query);
    return makeResult('catalog_search', requestId, result);
  } catch (e) {
    log(`Failed to search catalog: ${e}`);
    return makeError(requestId, 'catalog_error', `Failed to search catalog: ${e}`);
  }
};

// =============================================================================
// Installer Handlers
// =============================================================================

const handleCheckRuntimes: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';

  try {
    const result = await installer.checkRuntimes();
    return makeResult('check_runtimes', requestId, result);
  } catch (e) {
    log(`Failed to check runtimes: ${e}`);
    return makeError(requestId, 'runtime_error', String(e));
  }
};

const handleInstallServer: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const catalogEntry = message.catalog_entry as CatalogServer | undefined;
  const packageIndex = (message.package_index as number) || 0;

  if (!catalogEntry) {
    return makeError(requestId, 'invalid_request', 'Missing catalog_entry');
  }

  try {
    const server = await installer.install(catalogEntry, packageIndex);
    return makeResult('install_server', requestId, { server });
  } catch (e) {
    log(`Failed to install server: ${e}`);
    return makeError(requestId, 'install_error', String(e));
  }
};

const handleUninstallServer: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const success = installer.uninstall(serverId);
    return makeResult('uninstall_server', requestId, { success });
  } catch (e) {
    log(`Failed to uninstall server: ${e}`);
    return makeError(requestId, 'uninstall_error', String(e));
  }
};

const handleListInstalled: MessageHandler = async (message, _store, _client, _catalog, installer, mcpManager) => {
  const requestId = message.request_id || '';

  try {
    const statuses = installer.getAllStatus();
    
    // Enhance statuses with MCP connection info
    const enhancedStatuses = statuses.map(status => {
      if (status.server && mcpManager.isConnected(status.server.id)) {
        return {
          ...status,
          process: {
            state: 'running',
            pid: mcpManager.getPid(status.server.id) || undefined,
          },
        };
      }
      return status;
    });
    
    return makeResult('list_installed', requestId, { servers: enhancedStatuses });
  } catch (e) {
    log(`Failed to list installed servers: ${e}`);
    return makeError(requestId, 'list_error', String(e));
  }
};

const handleStartInstalled: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const proc = await installer.start(serverId);
    return makeResult('start_installed', requestId, { process: proc });
  } catch (e) {
    log(`Failed to start server: ${e}`);
    return makeError(requestId, 'start_error', String(e));
  }
};

const handleStopInstalled: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const success = await installer.stop(serverId);
    return makeResult('stop_installed', requestId, { success });
  } catch (e) {
    log(`Failed to stop server: ${e}`);
    return makeError(requestId, 'stop_error', String(e));
  }
};

const handleSetServerSecrets: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const secrets = (message.secrets || {}) as Record<string, string>;

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    installer.setSecrets(serverId, secrets);
    const status = installer.getStatus(serverId);
    return makeResult('set_server_secrets', requestId, { status });
  } catch (e) {
    log(`Failed to set secrets: ${e}`);
    return makeError(requestId, 'secrets_error', String(e));
  }
};

const handleGetServerStatus: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const status = installer.getStatus(serverId);
    return makeResult('get_server_status', requestId, status);
  } catch (e) {
    log(`Failed to get server status: ${e}`);
    return makeError(requestId, 'status_error', String(e));
  }
};

// =============================================================================
// MCP Stdio Handlers (for locally installed servers)
// =============================================================================

/**
 * Connect to an installed MCP server via stdio.
 * This spawns the server process and establishes the MCP connection.
 */
const handleMcpConnect: MessageHandler = async (message, _store, _client, _catalog, installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  // Get the installed server config
  const server = installer.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not installed: ${serverId}`);
  }

  // Check if npm package (only supported for now)
  if (server.packageType !== 'npm') {
    return makeError(
      requestId, 
      'unsupported_package_type', 
      `Only npm packages are supported. Got: ${server.packageType}`
    );
  }

  // Get secrets for this server from the SecretStore
  const secretStore = getSecretStore();
  const missingSecrets = secretStore.getMissingSecrets(serverId, server.requiredEnvVars || []);
  
  if (missingSecrets.length > 0) {
    return makeError(
      requestId,
      'missing_secrets',
      `Missing required secrets: ${missingSecrets.map(s => s.name).join(', ')}`,
      { missing: missingSecrets.map(s => s.name) }
    );
  }

  // Get all secrets as env vars
  const envVars = secretStore.getAll(serverId);

  try {
    const result = await mcpManager.connect(server, envVars);
    
    if (result.success) {
      return makeResult('mcp_connect', requestId, {
        connected: true,
        connection_info: result.connectionInfo,
        tools: result.tools,
        resources: result.resources,
        prompts: result.prompts,
      });
    } else {
      return makeError(requestId, 'connection_failed', result.error || 'Connection failed');
    }
  } catch (e) {
    log(`Failed to connect to MCP server: ${e}`);
    return makeError(requestId, 'connection_error', String(e));
  }
};

/**
 * Disconnect from an MCP server.
 */
const handleMcpDisconnect: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const disconnected = await mcpManager.disconnect(serverId);
    return makeResult('mcp_disconnect', requestId, { disconnected });
  } catch (e) {
    log(`Failed to disconnect from MCP server: ${e}`);
    return makeError(requestId, 'disconnect_error', String(e));
  }
};

/**
 * List all MCP connections.
 */
const handleMcpListConnections: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';

  try {
    const connections = mcpManager.getAllConnections().map(conn => ({
      serverId: conn.serverId,
      serverName: conn.installedServer.name,
      connectionInfo: conn.connectionInfo,
      connectedAt: conn.connectedAt,
      toolCount: conn.tools.length,
      resourceCount: conn.resources.length,
      promptCount: conn.prompts.length,
      pid: mcpManager.getPid(conn.serverId),
    }));
    
    return makeResult('mcp_list_connections', requestId, { connections });
  } catch (e) {
    log(`Failed to list MCP connections: ${e}`);
    return makeError(requestId, 'list_error', String(e));
  }
};

/**
 * List tools from a connected MCP server.
 */
const handleMcpListTools: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  if (!mcpManager.isConnected(serverId)) {
    return makeError(requestId, 'not_connected', `Not connected to server: ${serverId}`);
  }

  try {
    const tools = await mcpManager.listTools(serverId);
    return makeResult('mcp_list_tools', requestId, { tools });
  } catch (e) {
    log(`Failed to list MCP tools: ${e}`);
    return makeError(requestId, 'list_error', String(e));
  }
};

/**
 * List resources from a connected MCP server.
 */
const handleMcpListResources: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  if (!mcpManager.isConnected(serverId)) {
    return makeError(requestId, 'not_connected', `Not connected to server: ${serverId}`);
  }

  try {
    const resources = await mcpManager.listResources(serverId);
    return makeResult('mcp_list_resources', requestId, { resources });
  } catch (e) {
    log(`Failed to list MCP resources: ${e}`);
    return makeError(requestId, 'list_error', String(e));
  }
};

/**
 * List prompts from a connected MCP server.
 */
const handleMcpListPrompts: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  if (!mcpManager.isConnected(serverId)) {
    return makeError(requestId, 'not_connected', `Not connected to server: ${serverId}`);
  }

  try {
    const prompts = await mcpManager.listPrompts(serverId);
    return makeResult('mcp_list_prompts', requestId, { prompts });
  } catch (e) {
    log(`Failed to list MCP prompts: ${e}`);
    return makeError(requestId, 'list_error', String(e));
  }
};

/**
 * Call a tool on a connected MCP server.
 */
const handleMcpCallTool: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const toolName = message.tool_name as string || '';
  const args = (message.arguments || {}) as Record<string, unknown>;

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!toolName) {
    return makeError(requestId, 'invalid_request', 'Missing tool_name');
  }

  if (!mcpManager.isConnected(serverId)) {
    return makeError(requestId, 'not_connected', `Not connected to server: ${serverId}`);
  }

  try {
    const result = await mcpManager.callTool(serverId, toolName, args);
    return makeResult('mcp_call_tool', requestId, { result });
  } catch (e) {
    log(`Failed to call MCP tool: ${e}`);
    return makeError(requestId, 'tool_error', String(e));
  }
};

/**
 * Read a resource from a connected MCP server.
 */
const handleMcpReadResource: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const uri = message.uri as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!uri) {
    return makeError(requestId, 'invalid_request', 'Missing uri');
  }

  if (!mcpManager.isConnected(serverId)) {
    return makeError(requestId, 'not_connected', `Not connected to server: ${serverId}`);
  }

  try {
    const resource = await mcpManager.readResource(serverId, uri);
    return makeResult('mcp_read_resource', requestId, { resource });
  } catch (e) {
    log(`Failed to read MCP resource: ${e}`);
    return makeError(requestId, 'resource_error', String(e));
  }
};

/**
 * Get a prompt from a connected MCP server.
 */
const handleMcpGetPrompt: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const promptName = message.prompt_name as string || '';
  const args = (message.arguments || {}) as Record<string, string>;

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!promptName) {
    return makeError(requestId, 'invalid_request', 'Missing prompt_name');
  }

  if (!mcpManager.isConnected(serverId)) {
    return makeError(requestId, 'not_connected', `Not connected to server: ${serverId}`);
  }

  try {
    const prompt = await mcpManager.getPrompt(serverId, promptName, args);
    return makeResult('mcp_get_prompt', requestId, { prompt });
  } catch (e) {
    log(`Failed to get MCP prompt: ${e}`);
    return makeError(requestId, 'prompt_error', String(e));
  }
};

/**
 * Get stderr logs from a connected MCP server.
 */
const handleMcpGetLogs: MessageHandler = async (message, _store, _client, _catalog, _installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const logs = mcpManager.getStderrLog(serverId);
    const pid = mcpManager.getPid(serverId);
    return makeResult('mcp_get_logs', requestId, { logs, pid });
  } catch (e) {
    log(`Failed to get MCP logs: ${e}`);
    return makeError(requestId, 'logs_error', String(e));
  }
};

// =============================================================================
// Credential Handlers
// =============================================================================

/**
 * Set a credential for a server.
 * Supports API keys, passwords, and other credential types.
 */
const handleSetCredential: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const key = message.key as string || '';
  const value = message.value as string || '';
  const credType = (message.credential_type as CredentialType) || CredentialType.API_KEY;
  const username = message.username as string | undefined;

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!key) {
    return makeError(requestId, 'invalid_request', 'Missing key');
  }
  if (!value) {
    return makeError(requestId, 'invalid_request', 'Missing value');
  }

  try {
    const secretStore = getSecretStore();
    
    const credential: StoredCredential = {
      key,
      value,
      type: credType,
      setAt: Date.now(),
    };
    
    // For password type, include username
    if (credType === CredentialType.PASSWORD && username) {
      credential.username = username;
    }
    
    secretStore.setCredential(serverId, credential);
    
    return makeResult('set_credential', requestId, { 
      success: true,
      credential: {
        key,
        type: credType,
        setAt: credential.setAt,
      },
    });
  } catch (e) {
    log(`Failed to set credential: ${e}`);
    return makeError(requestId, 'credential_error', String(e));
  }
};

/**
 * Get the status of credentials for a server.
 * Compares stored credentials against requirements.
 */
const handleGetCredentialStatus: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const server = installer.getServer(serverId);
    if (!server) {
      return makeError(requestId, 'not_found', `Server not installed: ${serverId}`);
    }

    const secretStore = getSecretStore();
    
    // Convert the old-style requiredEnvVars to CredentialRequirement format
    const requirements: CredentialRequirement[] = (server.requiredEnvVars || [])
      .filter(env => env.isSecret)
      .map(env => ({
        key: env.name,
        label: env.name,
        description: env.description,
        type: CredentialType.API_KEY,
        envVar: env.name,
        required: true,
      }));

    const status = secretStore.getCredentialStatus(serverId, requirements);
    
    return makeResult('get_credential_status', requestId, { status });
  } catch (e) {
    log(`Failed to get credential status: ${e}`);
    return makeError(requestId, 'credential_error', String(e));
  }
};

/**
 * Validate credentials for a server.
 */
const handleValidateCredentials: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const server = installer.getServer(serverId);
    if (!server) {
      return makeError(requestId, 'not_found', `Server not installed: ${serverId}`);
    }

    const secretStore = getSecretStore();
    
    // Convert the old-style requiredEnvVars to CredentialRequirement format
    const requirements: CredentialRequirement[] = (server.requiredEnvVars || [])
      .filter(env => env.isSecret)
      .map(env => ({
        key: env.name,
        label: env.name,
        description: env.description,
        type: CredentialType.API_KEY,
        envVar: env.name,
        required: true,
      }));

    const validation = secretStore.validateCredentials(serverId, requirements);
    
    return makeResult('validate_credentials', requestId, { 
      valid: validation.valid,
      errors: validation.errors,
    });
  } catch (e) {
    log(`Failed to validate credentials: ${e}`);
    return makeError(requestId, 'credential_error', String(e));
  }
};

/**
 * Delete a credential for a server.
 */
const handleDeleteCredential: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const key = message.key as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!key) {
    return makeError(requestId, 'invalid_request', 'Missing key');
  }

  try {
    const secretStore = getSecretStore();
    secretStore.deleteCredential(serverId, key);
    
    return makeResult('delete_credential', requestId, { success: true });
  } catch (e) {
    log(`Failed to delete credential: ${e}`);
    return makeError(requestId, 'credential_error', String(e));
  }
};

/**
 * Get all credentials for a server (without values, for security).
 */
const handleListCredentials: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const secretStore = getSecretStore();
    const credentials = secretStore.getCredentials(serverId);
    
    // Return metadata only, not the actual values
    const credentialList = credentials.map(c => ({
      key: c.key,
      type: c.type,
      setAt: c.setAt,
      hasUsername: c.type === CredentialType.PASSWORD && !!c.username,
      expiresAt: c.expiresAt,
      isExpired: secretStore.isExpired(c),
    }));
    
    return makeResult('list_credentials', requestId, { credentials: credentialList });
  } catch (e) {
    log(`Failed to list credentials: ${e}`);
    return makeError(requestId, 'credential_error', String(e));
  }
};

// =============================================================================
// LLM Handlers
// =============================================================================

/**
 * Detect available LLM providers.
 */
const handleLlmDetect: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';

  try {
    const providers = await llmManager.detectAll();
    const active = llmManager.getActiveId();
    
    return makeResult('llm_detect', requestId, { 
      providers,
      active,
      hasAvailable: llmManager.hasAvailableProvider(),
    });
  } catch (e) {
    log(`Failed to detect LLM providers: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * List all LLM providers and their status.
 */
const handleLlmListProviders: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';

  try {
    const providers = llmManager.getAllStatus();
    const active = llmManager.getActiveId();
    
    return makeResult('llm_list_providers', requestId, { 
      providers,
      active,
    });
  } catch (e) {
    log(`Failed to list LLM providers: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Set the active LLM provider.
 */
const handleLlmSetActive: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const providerId = message.provider_id as string || '';

  if (!providerId) {
    return makeError(requestId, 'invalid_request', 'Missing provider_id');
  }

  try {
    const success = llmManager.setActive(providerId);
    
    if (!success) {
      return makeError(requestId, 'llm_error', `Provider not available: ${providerId}`);
    }
    
    return makeResult('llm_set_active', requestId, { 
      success: true,
      active: providerId,
    });
  } catch (e) {
    log(`Failed to set active LLM provider: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * List models from the active LLM provider.
 */
const handleLlmListModels: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';

  try {
    const active = llmManager.getActiveId();
    if (!active) {
      return makeError(requestId, 'llm_error', 'No active LLM provider. Run llm_detect first.');
    }
    
    const models = await llmManager.listModels();
    
    return makeResult('llm_list_models', requestId, { 
      models,
      provider: active,
    });
  } catch (e) {
    log(`Failed to list LLM models: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Send a chat message to the active LLM.
 */
const handleLlmChat: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const messages = message.messages as ChatMessage[] | undefined;
  const tools = message.tools as ToolDefinition[] | undefined;
  const model = message.model as string | undefined;
  const maxTokens = message.max_tokens as number | undefined;
  const temperature = message.temperature as number | undefined;
  const systemPrompt = message.system_prompt as string | undefined;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return makeError(requestId, 'invalid_request', 'Missing or empty messages array');
  }

  try {
    const active = llmManager.getActiveId();
    if (!active) {
      return makeError(requestId, 'llm_error', 'No active LLM provider. Run llm_detect first.');
    }
    
    const response = await llmManager.chat({
      messages,
      tools,
      model,
      maxTokens,
      temperature,
      systemPrompt,
    });
    
    return makeResult('llm_chat', requestId, { 
      response,
      provider: active,
    });
  } catch (e) {
    log(`Failed to chat with LLM: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Get the active LLM provider status.
 */
const handleLlmGetActive: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';

  try {
    const activeId = llmManager.getActiveId();
    const activeStatus = llmManager.getActiveStatus();
    
    return makeResult('llm_get_active', requestId, { 
      active: activeId,
      status: activeStatus,
    });
  } catch (e) {
    log(`Failed to get active LLM: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

// =============================================================================
// LLM Setup Handlers
// =============================================================================

/**
 * Get LLM setup status.
 * Returns what's available, what's downloaded, what's running.
 */
const handleLlmSetupStatus: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';

  try {
    const setupManager = getLLMSetupManager();
    const status = await setupManager.getStatus();
    
    return makeResult('llm_setup_status', requestId, { status });
  } catch (e) {
    log(`Failed to get LLM setup status: ${e}`);
    return makeError(requestId, 'llm_setup_error', String(e));
  }
};

/**
 * Download a llamafile model.
 * Note: Progress updates are sent as separate messages during download.
 */
const handleLlmDownloadModel: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const modelId = message.model_id as string || '';

  if (!modelId) {
    return makeError(requestId, 'invalid_request', 'Missing model_id');
  }

  try {
    const setupManager = getLLMSetupManager();
    
    // Start download - this is async and takes a while
    // For now, we just wait for it to complete
    // In the future, we could stream progress updates
    await setupManager.downloadModel(modelId, (progress) => {
      // Log progress - in a real implementation we'd stream this to the extension
      if (progress.percent % 10 === 0 || progress.status !== 'downloading') {
        log(`[Download] ${modelId}: ${progress.percent}% (${Math.round(progress.bytesDownloaded / 1_000_000)}MB)`);
      }
    });
    
    const status = await setupManager.getStatus();
    
    return makeResult('llm_download_model', requestId, { 
      success: true,
      modelId,
      status,
    });
  } catch (e) {
    log(`Failed to download model: ${e}`);
    return makeError(requestId, 'download_error', String(e));
  }
};

/**
 * Delete a downloaded model.
 */
const handleLlmDeleteModel: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const modelId = message.model_id as string || '';

  if (!modelId) {
    return makeError(requestId, 'invalid_request', 'Missing model_id');
  }

  try {
    const setupManager = getLLMSetupManager();
    const deleted = setupManager.deleteModel(modelId);
    
    return makeResult('llm_delete_model', requestId, { deleted });
  } catch (e) {
    log(`Failed to delete model: ${e}`);
    return makeError(requestId, 'delete_error', String(e));
  }
};

/**
 * Start a downloaded llamafile.
 */
const handleLlmStartLocal: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const modelId = message.model_id as string || '';
  const port = (message.port as number) || 8080;

  if (!modelId) {
    return makeError(requestId, 'invalid_request', 'Missing model_id');
  }

  try {
    const setupManager = getLLMSetupManager();
    const result = await setupManager.startLocalLLM(modelId, port);
    
    if (!result.success) {
      return makeError(requestId, 'start_error', result.error || 'Failed to start');
    }
    
    // Re-detect LLM providers so the new one is available
    await llmManager.detectAll();
    
    return makeResult('llm_start_local', requestId, { 
      success: true,
      url: result.url,
      modelId,
    });
  } catch (e) {
    log(`Failed to start local LLM: ${e}`);
    return makeError(requestId, 'start_error', String(e));
  }
};

/**
 * Stop the running llamafile.
 */
const handleLlmStopLocal: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';

  try {
    const setupManager = getLLMSetupManager();
    const stopped = await setupManager.stopLocalLLM();
    
    return makeResult('llm_stop_local', requestId, { stopped });
  } catch (e) {
    log(`Failed to stop local LLM: ${e}`);
    return makeError(requestId, 'stop_error', String(e));
  }
};

// =============================================================================
// Chat Session Handlers
// =============================================================================

/**
 * Create a new chat session.
 */
const handleChatCreateSession: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager) => {
  const requestId = message.request_id || '';
  const enabledServers = (message.enabled_servers as string[]) || [];
  const name = message.name as string | undefined;
  const systemPrompt = message.system_prompt as string | undefined;
  const maxIterations = message.max_iterations as number | undefined;

  try {
    const sessionStore = getChatSessionStore();
    
    const session = createSession(enabledServers, {
      name,
      systemPrompt,
      config: maxIterations ? { maxIterations } : undefined,
    });
    
    sessionStore.save(session);
    
    return makeResult('chat_create_session', requestId, { 
      session: {
        id: session.id,
        name: session.name,
        enabledServers: session.enabledServers,
        systemPrompt: session.systemPrompt,
        createdAt: session.createdAt,
        config: session.config,
      },
    });
  } catch (e) {
    log(`Failed to create chat session: ${e}`);
    return makeError(requestId, 'chat_error', String(e));
  }
};

/**
 * Send a message to a chat session and run the orchestration loop.
 */
const handleChatSendMessage: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const sessionId = message.session_id as string || '';
  const userMessage = message.message as string || '';
  const useToolRouter = message.use_tool_router !== false; // Default to true

  if (!sessionId) {
    return makeError(requestId, 'invalid_request', 'Missing session_id');
  }
  if (!userMessage) {
    return makeError(requestId, 'invalid_request', 'Missing message');
  }

  try {
    // Ensure LLM is available
    const activeId = llmManager.getActiveId();
    if (!activeId) {
      return makeError(requestId, 'llm_error', 'No active LLM provider. Run llm_detect first.');
    }

    const sessionStore = getChatSessionStore();
    const session = sessionStore.get(sessionId);
    
    if (!session) {
      return makeError(requestId, 'not_found', `Session not found: ${sessionId}`);
    }
    
    // Apply tool router setting for this request
    session.config.useToolRouter = useToolRouter;
    log(`[ChatSendMessage] Tool router: ${useToolRouter ? 'enabled' : 'disabled'}`);
    
    const orchestrator = getChatOrchestrator();
    const result = await orchestrator.run(session, userMessage);
    
    // Save updated session
    sessionStore.save(session);
    
    return makeResult('chat_send_message', requestId, { 
      response: result.finalResponse,
      steps: result.steps,
      iterations: result.iterations,
      reachedMaxIterations: result.reachedMaxIterations,
      durationMs: result.durationMs,
      routing: result.routing,
    });
  } catch (e) {
    log(`Failed to process chat message: ${e}`);
    return makeError(requestId, 'chat_error', String(e));
  }
};

/**
 * Get a chat session.
 */
const handleChatGetSession: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const sessionId = message.session_id as string || '';

  if (!sessionId) {
    return makeError(requestId, 'invalid_request', 'Missing session_id');
  }

  try {
    const sessionStore = getChatSessionStore();
    const session = sessionStore.get(sessionId);
    
    if (!session) {
      return makeError(requestId, 'not_found', `Session not found: ${sessionId}`);
    }
    
    return makeResult('chat_get_session', requestId, { session });
  } catch (e) {
    log(`Failed to get chat session: ${e}`);
    return makeError(requestId, 'chat_error', String(e));
  }
};

/**
 * List all chat sessions.
 */
const handleChatListSessions: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const limit = (message.limit as number) || 50;

  try {
    const sessionStore = getChatSessionStore();
    const sessions = sessionStore.getRecent(limit).map(s => ({
      id: s.id,
      name: s.name,
      enabledServers: s.enabledServers,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    
    return makeResult('chat_list_sessions', requestId, { sessions });
  } catch (e) {
    log(`Failed to list chat sessions: ${e}`);
    return makeError(requestId, 'chat_error', String(e));
  }
};

/**
 * Delete a chat session.
 */
const handleChatDeleteSession: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const sessionId = message.session_id as string || '';

  if (!sessionId) {
    return makeError(requestId, 'invalid_request', 'Missing session_id');
  }

  try {
    const sessionStore = getChatSessionStore();
    const deleted = sessionStore.delete(sessionId);
    
    return makeResult('chat_delete_session', requestId, { deleted });
  } catch (e) {
    log(`Failed to delete chat session: ${e}`);
    return makeError(requestId, 'chat_error', String(e));
  }
};

/**
 * Update a chat session (name, system prompt, etc).
 */
const handleChatUpdateSession: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const sessionId = message.session_id as string || '';
  const updates = (message.updates || {}) as Partial<{
    name: string;
    systemPrompt: string;
    enabledServers: string[];
  }>;

  if (!sessionId) {
    return makeError(requestId, 'invalid_request', 'Missing session_id');
  }

  try {
    const sessionStore = getChatSessionStore();
    const session = sessionStore.get(sessionId);
    
    if (!session) {
      return makeError(requestId, 'not_found', `Session not found: ${sessionId}`);
    }
    
    // Apply updates
    if (updates.name !== undefined) {
      session.name = updates.name;
    }
    if (updates.systemPrompt !== undefined) {
      session.systemPrompt = updates.systemPrompt;
    }
    if (updates.enabledServers !== undefined) {
      session.enabledServers = updates.enabledServers;
    }
    
    session.updatedAt = Date.now();
    sessionStore.save(session);
    
    return makeResult('chat_update_session', requestId, { 
      session: {
        id: session.id,
        name: session.name,
        enabledServers: session.enabledServers,
        systemPrompt: session.systemPrompt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    });
  } catch (e) {
    log(`Failed to update chat session: ${e}`);
    return makeError(requestId, 'chat_error', String(e));
  }
};

/**
 * Clear messages from a chat session.
 */
const handleChatClearMessages: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const sessionId = message.session_id as string || '';

  if (!sessionId) {
    return makeError(requestId, 'invalid_request', 'Missing session_id');
  }

  try {
    const sessionStore = getChatSessionStore();
    const session = sessionStore.get(sessionId);
    
    if (!session) {
      return makeError(requestId, 'not_found', `Session not found: ${sessionId}`);
    }
    
    session.messages = [];
    session.updatedAt = Date.now();
    sessionStore.save(session);
    
    return makeResult('chat_clear_messages', requestId, { cleared: true });
  } catch (e) {
    log(`Failed to clear chat messages: ${e}`);
    return makeError(requestId, 'chat_error', String(e));
  }
};

// =============================================================================
// Handler Registry
// =============================================================================

const HANDLERS: Record<string, MessageHandler> = {
  hello: handleHello,
  add_server: handleAddServer,
  remove_server: handleRemoveServer,
  list_servers: handleListServers,
  connect_server: handleConnectServer,
  disconnect_server: handleDisconnectServer,
  list_tools: handleListTools,
  list_resources: handleListResources,
  list_prompts: handleListPrompts,
  call_tool: handleCallTool,
  // Catalog handlers
  catalog_get: handleCatalogGet,
  catalog_refresh: handleCatalogRefresh,
  catalog_search: handleCatalogSearch,
  // Installer handlers
  check_runtimes: handleCheckRuntimes,
  install_server: handleInstallServer,
  uninstall_server: handleUninstallServer,
  list_installed: handleListInstalled,
  start_installed: handleStartInstalled,
  stop_installed: handleStopInstalled,
  set_server_secrets: handleSetServerSecrets,
  get_server_status: handleGetServerStatus,
  // MCP stdio handlers (for locally installed servers)
  mcp_connect: handleMcpConnect,
  mcp_disconnect: handleMcpDisconnect,
  mcp_list_connections: handleMcpListConnections,
  mcp_list_tools: handleMcpListTools,
  mcp_list_resources: handleMcpListResources,
  mcp_list_prompts: handleMcpListPrompts,
  mcp_call_tool: handleMcpCallTool,
  mcp_read_resource: handleMcpReadResource,
  mcp_get_prompt: handleMcpGetPrompt,
  mcp_get_logs: handleMcpGetLogs,
  // Credential handlers
  set_credential: handleSetCredential,
  get_credential_status: handleGetCredentialStatus,
  validate_credentials: handleValidateCredentials,
  delete_credential: handleDeleteCredential,
  list_credentials: handleListCredentials,
  // LLM handlers
  llm_detect: handleLlmDetect,
  llm_list_providers: handleLlmListProviders,
  llm_set_active: handleLlmSetActive,
  llm_list_models: handleLlmListModels,
  llm_chat: handleLlmChat,
  llm_get_active: handleLlmGetActive,
  // LLM setup handlers
  llm_setup_status: handleLlmSetupStatus,
  llm_download_model: handleLlmDownloadModel,
  llm_delete_model: handleLlmDeleteModel,
  llm_start_local: handleLlmStartLocal,
  llm_stop_local: handleLlmStopLocal,
  // Chat session handlers
  chat_create_session: handleChatCreateSession,
  chat_send_message: handleChatSendMessage,
  chat_get_session: handleChatGetSession,
  chat_list_sessions: handleChatListSessions,
  chat_delete_session: handleChatDeleteSession,
  chat_update_session: handleChatUpdateSession,
  chat_clear_messages: handleChatClearMessages,
};

export async function dispatchMessage(
  message: Message
): Promise<ResultResponse | ErrorResponse> {
  const messageType = message.type;
  const requestId = message.request_id || '';

  if (!messageType) {
    return makeError(requestId, 'invalid_message', "Missing 'type' field in message");
  }

  const handler = HANDLERS[messageType];
  if (!handler) {
    return makeError(
      requestId,
      'unknown_message_type',
      `Unknown message type: ${messageType}`,
      { received_type: messageType }
    );
  }

  const store = getServerStore();
  const client = getMcpClient();
  const catalog = getCatalogManager();
  const installer = getInstalledServerManager();
  const mcpManager = getMcpClientManager();
  const llmManager = getLLMManager();

  return handler(message, store, client, catalog, installer, mcpManager, llmManager);
}

