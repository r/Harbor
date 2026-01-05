/**
 * Message handlers for the native messaging bridge.
 * 
 * Supports two modes:
 * - Single process: Uses CatalogManager directly
 * - Worker process: Uses CatalogClient to talk to worker
 */

import { log, pushStatus, sendProgressUpdate } from './native-messaging.js';
import { getServerStore, ServerStore } from './server-store.js';
import { getMcpClient, McpClient } from './mcp-client.js';
import { getCatalogManager, CatalogManager, CatalogClient } from './catalog/index.js';
import { getInstalledServerManager, InstalledServerManager, resolveGitHubPackage, needsSecurityApproval, parseMcpConfig, parseVSCodeInstallUrl, ParsedServer } from './installer/index.js';
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
import { CURATED_SERVERS, getCuratedServer, type CuratedServerFull } from './directory/curated-servers.js';
import { getDockerExec } from './installer/docker-exec.js';
import { getDockerImageManager } from './installer/docker-images.js';
import type { CuratedServer } from './types.js';
import {
  startOAuthFlow,
  cancelOAuthFlow,
  revokeOAuthAccess,
  getOAuthStatus,
  isProviderConfigured,
  getConfiguredProviders,
} from './auth/index.js';
import {
  getMcpHost,
  GrantType,
  PermissionScope,
  grantPermission,
  revokePermission,
  checkPermission,
  getPermissions,
  expireTabGrants,
  ErrorCode,
  createError,
} from './host/index.js';

const VERSION = '0.1.0';

// Optional CatalogClient for worker architecture
let _catalogClient: CatalogClient | null = null;

export function setCatalogClient(client: CatalogClient): void {
  _catalogClient = client;
  log('[Handlers] Using catalog worker architecture');
}

export function getCatalogClient(): CatalogClient | null {
  return _catalogClient;
}

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

// Diagnostic ping - sends a status update back to verify the push channel works
const handlePing: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const echo = message.echo as string || 'pong';
  
  // Send a push status update (unsolicited message)
  pushStatus('diagnostic', 'ping_received', { 
    message: `Ping received: ${echo}`,
    echo,
    timestamp: Date.now(),
  });
  
  // Also return a regular response
  return {
    type: 'ping_result',
    request_id: requestId,
    echo,
    timestamp: Date.now(),
    message: 'Ping successful - check for status_update message',
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
    // Use worker client if available
    if (_catalogClient) {
      if (force) {
        await _catalogClient.refresh(true);
      }
      const result = _catalogClient.getCatalog();
      if (query) {
        result.servers = _catalogClient.searchServers(query);
      }
      return makeResult('catalog_get', requestId, result);
    }
    
    // Fall back to single-process CatalogManager
    // First try cache, if empty or stale, refresh from providers
    log(`[handleCatalogGet] Using CatalogManager fallback (no worker)`);
    let result = await catalog.getCached();
    log(`[handleCatalogGet] Cache has ${result.servers.length} servers, isStale=${result.isStale}`);
    
    // If cache is empty or stale, or force refresh requested, fetch from providers
    if (force || result.servers.length === 0 || result.isStale) {
      log(`[handleCatalogGet] Refreshing from providers...`);
      result = await catalog.refresh({ force: true, query });
      log(`[handleCatalogGet] After refresh: ${result.servers.length} servers, ${result.providerStatus?.length || 0} providers`);
      if (result.providerStatus) {
        for (const p of result.providerStatus) {
          log(`[handleCatalogGet] Provider ${p.id}: ok=${p.ok}, count=${p.count}, error=${p.error}`);
        }
      }
    }
    
    // Apply search filter if query provided
    if (query && result.servers.length > 0) {
      const searchTerm = query.toLowerCase();
      result.servers = result.servers.filter(s => 
        s.name.toLowerCase().includes(searchTerm) ||
        (s.description?.toLowerCase().includes(searchTerm)) ||
        (s.tags?.some(t => t.toLowerCase().includes(searchTerm)))
      );
    }
    
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
    // Use worker client if available
    if (_catalogClient) {
      await _catalogClient.refresh(true);
      const result = _catalogClient.getCatalog();
      if (query) {
        result.servers = _catalogClient.searchServers(query);
      }
      return makeResult('catalog_refresh', requestId, result);
    }
    
    // Fall back to single-process CatalogManager
    const result = await catalog.refresh({ force: true, query });
    
    // Apply search filter if query provided
    if (query && result.servers.length > 0) {
      const searchTerm = query.toLowerCase();
      result.servers = result.servers.filter(s => 
        s.name.toLowerCase().includes(searchTerm) ||
        (s.description?.toLowerCase().includes(searchTerm)) ||
        (s.tags?.some(t => t.toLowerCase().includes(searchTerm)))
      );
    }
    
    return makeResult('catalog_refresh', requestId, result);
  } catch (e) {
    log(`Failed to refresh catalog: ${e}`);
    return makeError(requestId, 'catalog_error', `Failed to refresh catalog: ${e}`);
  }
};

const handleCatalogEnrich: MessageHandler = async (message, _store, _client, catalog) => {
  const requestId = message.request_id || '';

  try {
    log('[handleCatalogEnrich] Starting full enrichment...');
    
    // Use worker client if available
    if (_catalogClient) {
      const result = await _catalogClient.enrich();
      return makeResult('catalog_enrich', requestId, result);
    }
    
    // Fall back to single-process CatalogManager
    const result = await catalog.enrichAll();
    return makeResult('catalog_enrich', requestId, {
      enriched: result.enriched,
      failed: result.failed,
    });
  } catch (e) {
    log(`Failed to enrich catalog: ${e}`);
    return makeError(requestId, 'enrich_error', `Failed to enrich catalog: ${e}`);
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
    // If no package info, try to resolve from GitHub
    let entryWithPackage = catalogEntry;
    const hasPackageInfo = catalogEntry.packages && 
                           catalogEntry.packages.length > 0 && 
                           catalogEntry.packages[0].identifier;
    
    if (!hasPackageInfo && catalogEntry.homepageUrl?.includes('github.com')) {
      log(`[handleInstallServer] Resolving package info from GitHub: ${catalogEntry.homepageUrl}`);
      const resolved = await resolveGitHubPackage(catalogEntry.homepageUrl);
      
      if (resolved && resolved.name) {
        // Determine registry type and create package info
        let registryType: 'npm' | 'pypi' | 'oci' | 'binary';
        if (resolved.type === 'python') {
          registryType = 'pypi';
        } else if (resolved.type === 'binary') {
          registryType = 'binary';
        } else {
          registryType = 'npm';
        }
        
        // Create a copy with resolved package info
        log(`[handleInstallServer] Creating package entry: registryType=${registryType}, identifier=${resolved.name}, binaryUrl=${resolved.binaryUrl || 'none'}`);
        entryWithPackage = {
          ...catalogEntry,
          packages: [{
            registryType,
            identifier: resolved.name,
            environmentVariables: [],
            // Include binary URL if it's a binary package
            binaryUrl: resolved.binaryUrl,
          }],
        };
        log(`[handleInstallServer] Resolved: ${resolved.name} (${resolved.type})${resolved.binaryUrl ? ` from ${resolved.binaryUrl}` : ''}`);
      } else {
        // Could not resolve package info
        const url = catalogEntry.homepageUrl || '';
        return makeError(requestId, 'unsupported_server', 
          'Could not find a way to install this server.\n\n' +
          'Harbor supports servers that are:\n' +
          '• Published to npm (JavaScript/TypeScript)\n' +
          '• Published to PyPI (Python)\n' +
          '• Have pre-built binaries in GitHub Releases\n\n' +
          'This server may require manual compilation or installation.\n\n' +
          `Visit ${url} for installation instructions.`);
      }
    }

    const server = await installer.install(entryWithPackage, packageIndex);
    return makeResult('install_server', requestId, { server });
  } catch (e) {
    log(`Failed to install server: ${e}`);
    return makeError(requestId, 'install_error', String(e));
  }
};

// Add a remote HTTP/SSE MCP server
const handleAddRemoteServer: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const name = message.name as string || '';
  const url = message.url as string || '';
  const type = (message.transport_type as 'http' | 'sse') || 'http';
  const headers = message.headers as Record<string, string> | undefined;

  if (!name) {
    return makeError(requestId, 'invalid_request', 'Missing server name');
  }
  if (!url) {
    return makeError(requestId, 'invalid_request', 'Missing server URL');
  }

  try {
    // Validate URL
    new URL(url);
  } catch {
    return makeError(requestId, 'invalid_request', 'Invalid server URL');
  }

  try {
    const server = installer.addRemoteServer(name, url, type, headers);
    return makeResult('add_remote_server', requestId, { server });
  } catch (e) {
    log(`Failed to add remote server: ${e}`);
    return makeError(requestId, 'add_error', String(e));
  }
};

// Import MCP configuration (Claude Desktop or VS Code format)
const handleImportConfig: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const configJson = message.config_json as string || '';
  const installUrl = message.install_url as string || '';

  try {
    let servers: ParsedServer[] = [];
    let format = 'unknown';

    if (installUrl) {
      // Parse VS Code install URL
      const server = parseVSCodeInstallUrl(installUrl);
      if (server) {
        servers = [server];
        format = 'vscode_url';
      } else {
        return makeError(requestId, 'parse_error', 'Invalid VS Code install URL');
      }
    } else if (configJson) {
      // Parse JSON config
      const parsed = parseMcpConfig(configJson);
      servers = parsed.servers;
      format = parsed.format;
    } else {
      return makeError(requestId, 'invalid_request', 'Missing config_json or install_url');
    }

    // Import each server
    const imported = [];
    const errors = [];

    for (const server of servers) {
      try {
        let installedServer;

        if (server.type === 'http' || server.type === 'sse') {
          // Remote server
          installedServer = installer.addRemoteServer(
            server.name,
            server.url!,
            server.type,
            server.headers
          );
        } else {
          // Stdio server - create a minimal catalog entry to install
          // This is a simplified approach; full support would need package resolution
          log(`[handleImportConfig] Stdio server import not fully supported yet: ${server.name}`);
          errors.push({
            name: server.name,
            error: 'Stdio server import from config requires package resolution. Please install from the directory instead.',
          });
          continue;
        }

        // Record required inputs for the UI to prompt for
        imported.push({
          server: installedServer,
          requiredInputs: server.requiredInputs,
        });
      } catch (e) {
        errors.push({
          name: server.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return makeResult('import_config', requestId, {
      format,
      imported,
      errors,
      totalParsed: servers.length,
    });
  } catch (e) {
    log(`Failed to import config: ${e}`);
    return makeError(requestId, 'import_error', e instanceof Error ? e.message : String(e));
  }
};

// Resolve package info from a GitHub URL
const handleResolveGitHub: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const githubUrl = message.github_url as string || '';

  if (!githubUrl) {
    return makeError(requestId, 'invalid_request', 'Missing github_url');
  }

  try {
    const resolved = await resolveGitHubPackage(githubUrl);
    
    if (!resolved) {
      return makeError(requestId, 'resolve_error', 'Could not resolve package info from GitHub URL');
    }

    return makeResult('resolve_github', requestId, { 
      package: resolved,
      canInstall: !!resolved.name,
    });
  } catch (e) {
    log(`Failed to resolve GitHub package: ${e}`);
    return makeError(requestId, 'resolve_error', String(e));
  }
};

// Resolve package info for a server by ID and cache it in the database
const handleResolveServerPackage: MessageHandler = async (message, _store, _client, catalog) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  const db = catalog.getDatabase();
  
  // Check if we already have resolved info
  const cached = db.getResolvedPackage(serverId);
  if (cached && cached.resolvedAt) {
    log(`[handleResolveServerPackage] Using cached package info for ${serverId}`);
    return makeResult('resolve_server_package', requestId, {
      serverId,
      packageType: cached.packageType,
      packageId: cached.packageId,
      cached: true,
    });
  }

  // Get the server from catalog
  const servers = db.getAllServers({ includeRemoved: false });
  const server = servers.find((s: CatalogServer) => s.id === serverId);
  
  if (!server) {
    return makeError(requestId, 'not_found', 'Server not found');
  }

  // If server already has package info from registry, use that
  if (server.packages && server.packages.length > 0 && server.packages[0].identifier) {
    const pkg = server.packages[0];
    // We support npm, pypi, and binary - skip oci for now
    const pkgType = pkg.registryType === 'oci' ? null : pkg.registryType;
    db.updateResolvedPackage(serverId, pkgType, pkg.identifier);
    return makeResult('resolve_server_package', requestId, {
      serverId,
      packageType: pkgType,
      packageId: pkg.identifier,
      cached: false,
    });
  }

  // Try to resolve from GitHub
  const githubUrl = server.homepageUrl || server.repositoryUrl;
  if (!githubUrl || !githubUrl.includes('github.com')) {
    // Can't resolve - no GitHub URL
    db.updateResolvedPackage(serverId, null, null);
    return makeResult('resolve_server_package', requestId, {
      serverId,
      packageType: null,
      packageId: null,
      cached: false,
    });
  }

  try {
    log(`[handleResolveServerPackage] Resolving from GitHub: ${githubUrl}`);
    const resolved = await resolveGitHubPackage(githubUrl);
    
    if (resolved && resolved.name) {
      const packageType = resolved.type === 'python' ? 'pypi' : 'npm';
      db.updateResolvedPackage(serverId, packageType as 'npm' | 'pypi', resolved.name);
      return makeResult('resolve_server_package', requestId, {
        serverId,
        packageType,
        packageId: resolved.name,
        cached: false,
      });
    }
    
    // Could not resolve
    db.updateResolvedPackage(serverId, null, null);
    return makeResult('resolve_server_package', requestId, {
      serverId,
      packageType: null,
      packageId: null,
      cached: false,
    });
  } catch (e) {
    log(`[handleResolveServerPackage] Failed to resolve: ${e}`);
    return makeError(requestId, 'resolve_error', String(e));
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
  const useDocker = message.use_docker as boolean || false;

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    const proc = await installer.start(serverId, { useDocker });
    return makeResult('start_installed', requestId, { process: proc });
  } catch (e) {
    const errorMsg = String(e);
    log(`Failed to start server: ${errorMsg}`);
    
    // Check if this is a macOS Gatekeeper/security issue for a binary server
    const server = installer.getServer(serverId);
    const isBinary = server?.packageType === 'binary';
    const isSecurityError = errorMsg.includes('permission denied') || 
                           errorMsg.includes('not permitted') ||
                           errorMsg.includes('cannot be opened') ||
                           errorMsg.includes('quarantine') ||
                           errorMsg.includes('EPERM') ||
                           errorMsg.includes('spawn') ||
                           errorMsg.includes('EACCES');
    const isMacOS = process.platform === 'darwin';
    
    // For binary servers that fail with security errors, offer Docker as alternative
    // Docker will download and use the Linux binary from GitHub releases
    if (isBinary && isMacOS && isSecurityError && !useDocker && !server.noDocker) {
      const dockerInfo = await installer.checkDockerAvailable();
      const hasGitHubInfo = server.githubOwner && server.githubRepo;
      
      if (dockerInfo.available && hasGitHubInfo) {
        log(`[handleStartInstalled] Binary server failed with security error, Docker available with Linux binary`);
        return makeResult('start_installed', requestId, {
          process: null,
          error: errorMsg,
          docker_available: true,
          docker_recommended: true,
          suggestion: 'This binary was blocked by macOS Gatekeeper. Would you like to run in Docker instead? (The Linux binary will be downloaded automatically)'
        });
      } else {
        log(`[handleStartInstalled] Binary server failed with security error, Docker not available or no GitHub info`);
        return makeResult('start_installed', requestId, {
          process: null,
          error: errorMsg,
          docker_available: false,
          docker_recommended: false,
          suggestion: 'This binary was blocked by macOS Gatekeeper. Go to System Settings → Privacy & Security and click "Allow Anyway".'
        });
      }
    }
    
    return makeError(requestId, 'start_error', errorMsg);
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

/**
 * Update server args (e.g., directory paths for filesystem server).
 */
const handleUpdateServerArgs: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const args = (message.args || []) as string[];

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  try {
    log(`[handleUpdateServerArgs] Updating args for ${serverId}: ${args.join(', ')}`);
    installer.configure(serverId, { args });
    const status = installer.getStatus(serverId);
    return makeResult('update_server_args', requestId, { success: true, status });
  } catch (e) {
    log(`Failed to update server args: ${e}`);
    return makeError(requestId, 'update_error', String(e));
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
 * 
 * Supports Docker mode for running servers in containers, which bypasses
 * macOS Gatekeeper security restrictions for downloaded binaries.
 */
const handleMcpConnect: MessageHandler = async (message, _store, _client, _catalog, installer, mcpManager) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const useDockerOverride = message.use_docker as boolean | undefined;

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }

  // Get the installed server config
  const server = installer.getServer(serverId);
  if (!server) {
    return makeError(requestId, 'not_found', `Server not installed: ${serverId}`);
  }

  // Check if supported package type
  const supportedTypes = ['npm', 'pypi', 'binary', 'http', 'sse', 'oci'];
  if (!supportedTypes.includes(server.packageType)) {
    return makeError(
      requestId, 
      'unsupported_package_type', 
      `Unsupported package type: ${server.packageType}. Supported: ${supportedTypes.join(', ')}`
    );
  }

  // Determine if we should use Docker
  // OCI (Docker image) servers MUST use Docker
  let useDocker = server.packageType === 'oci' || (useDockerOverride ?? server.useDocker ?? false);
  
  // For binary packages on macOS, offer Docker as an option (bypasses Gatekeeper)
  // Docker will use a separately downloaded Linux binary
  if (server.packageType === 'binary' && !useDocker && !message.skip_security_check) {
    const binaryPath = server.binaryPath || `~/.harbor/bin/${serverId}`;
    const dockerPreference = await installer.shouldPreferDocker(serverId);
    const hasGitHubInfo = server.githubOwner && server.githubRepo;
    
    // Always show the choice for binary servers on first run
    if (dockerPreference.dockerAvailable && hasGitHubInfo) {
      log(`[handleMcpConnect] Binary server on macOS - Docker available with Linux binary option`);
      return makeResult('mcp_connect', requestId, {
        connected: false,
        needs_security_approval: true,
        docker_available: true,
        docker_recommended: true,
        security_instructions: `Binary Server - Choose How to Run

This is a compiled binary from GitHub. You have two options:

🐳 OPTION 1: Run in Docker (Recommended)
Click "Run in Docker" to download the Linux binary and run in a container.
This bypasses all macOS security restrictions.

💻 OPTION 2: Run Natively
Click "Run Natively" to use the macOS binary.
If macOS blocks it:
1. Open System Settings → Privacy & Security
2. Find "${server.name}" and click "Allow Anyway"
3. Try starting again

Binary path: ${binaryPath}`,
      });
    } else if (!dockerPreference.dockerAvailable) {
      // No Docker - show native-only instructions
      const needsApproval = await needsSecurityApproval(serverId);
      if (needsApproval) {
        log(`[handleMcpConnect] Binary server needs security approval, Docker not available`);
        return makeResult('mcp_connect', requestId, {
          connected: false,
          needs_security_approval: true,
          docker_available: false,
          docker_recommended: false,
          security_instructions: `macOS Security Approval Required

This is a compiled binary from GitHub. macOS Gatekeeper may block it.

📋 Steps to approve:
1. Click "Run Natively" to attempt starting
2. If macOS blocks it, open System Settings → Privacy & Security
3. Scroll down and click "Allow Anyway" next to "${server.name}"
4. Try starting again

Binary path: ${binaryPath}

💡 TIP: Install Docker Desktop to bypass this in the future.`,
        });
      }
    }
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

  // Progress callback - sends updates to extension
  const onProgress = (progressMessage: string) => {
    log(`[handleMcpConnect] Progress: ${progressMessage}`);
    // Send progress update via native messaging (will be broadcast to extension)
    sendProgressUpdate(serverId, progressMessage);
  };

  try {
    const result = await mcpManager.connect(server, envVars, { useDocker, onProgress });
    
    if (result.success) {
      return makeResult('mcp_connect', requestId, {
        connected: true,
        connection_info: result.connectionInfo,
        tools: result.tools,
        resources: result.resources,
        prompts: result.prompts,
        running_in_docker: useDocker,
      });
    } else {
      // Connection failed - check if we should offer Docker as a fallback
      // This helps when packages have native dependencies that fail to load
      if (!useDocker && server.packageType !== 'http' && server.packageType !== 'sse') {
        const errorLower = (result.error || '').toLowerCase();
        const isRecoverableError = 
          errorLower.includes('module') ||
          errorLower.includes('modulenotfounderror') ||
          errorLower.includes('no module named') ||
          errorLower.includes('enoent') ||
          errorLower.includes('not found') ||
          errorLower.includes('spawn') ||
          errorLower.includes('permission') ||
          errorLower.includes('blocked') ||
          errorLower.includes('gatekeeper') ||
          errorLower.includes('security') ||
          errorLower.includes('sigkill') ||
          errorLower.includes('code signature');
        
        if (isRecoverableError) {
          // Check if Docker is available as a fallback (but not for servers that need host access)
          if (!server.noDocker) {
            const dockerCheck = await installer.checkDockerAvailable();
            if (dockerCheck.available) {
              log(`[handleMcpConnect] Native connection failed but Docker available - offering fallback`);
              return makeResult('mcp_connect', requestId, {
                connected: false,
                error: result.error,
                docker_fallback_available: true,
                docker_fallback_message: `This server couldn't start because of a missing dependency or permission issue.

Docker can run this server in an isolated container with all dependencies included - no additional setup needed.`,
              });
            }
          } else {
            log(`[handleMcpConnect] Server ${serverId} has noDocker flag - not offering Docker fallback`);
          }
        }
      }
      
      return makeError(requestId, 'connection_failed', result.error || 'Connection failed');
    }
  } catch (e) {
    log(`Failed to connect to MCP server: ${e}`);
    
    // Also check for Docker fallback on exceptions (but not for servers that need host access)
    if (!useDocker && !server.noDocker && server.packageType !== 'http' && server.packageType !== 'sse') {
      const dockerCheck = await installer.checkDockerAvailable();
      if (dockerCheck.available) {
        return makeResult('mcp_connect', requestId, {
          connected: false,
          error: String(e),
          docker_fallback_available: true,
          docker_fallback_message: `This server couldn't start due to a system issue.

Docker can run this server in an isolated container - no additional setup needed.`,
        });
      }
    }
    
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
// OAuth Handlers
// =============================================================================

/**
 * Start an OAuth flow for a server credential.
 */
const handleOAuthStart: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const credentialKey = message.credential_key as string || '';
  const providerId = message.provider_id as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!credentialKey) {
    return makeError(requestId, 'invalid_request', 'Missing credential_key');
  }
  if (!providerId) {
    return makeError(requestId, 'invalid_request', 'Missing provider_id');
  }

  // Check if provider is configured
  if (!isProviderConfigured(providerId)) {
    return makeError(requestId, 'provider_not_configured', 
      `OAuth provider "${providerId}" is not configured. ` +
      `Please set the HARBOR_${providerId.toUpperCase()}_CLIENT_ID environment variable.`
    );
  }

  try {
    const { authUrl, state } = await startOAuthFlow(
      serverId,
      credentialKey,
      providerId
    );

    return makeResult('oauth_start', requestId, {
      auth_url: authUrl,
      state,
      provider_id: providerId,
    });
  } catch (e) {
    log(`Failed to start OAuth flow: ${e}`);
    return makeError(requestId, 'oauth_error', String(e));
  }
};

/**
 * Cancel an active OAuth flow.
 */
const handleOAuthCancel: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const state = message.state as string || '';

  if (!state) {
    return makeError(requestId, 'invalid_request', 'Missing state');
  }

  try {
    cancelOAuthFlow(state);
    return makeResult('oauth_cancel', requestId, { cancelled: true });
  } catch (e) {
    log(`Failed to cancel OAuth flow: ${e}`);
    return makeError(requestId, 'oauth_error', String(e));
  }
};

/**
 * Revoke OAuth access for a server credential.
 */
const handleOAuthRevoke: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const credentialKey = message.credential_key as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!credentialKey) {
    return makeError(requestId, 'invalid_request', 'Missing credential_key');
  }

  try {
    await revokeOAuthAccess(serverId, credentialKey);
    return makeResult('oauth_revoke', requestId, { revoked: true });
  } catch (e) {
    log(`Failed to revoke OAuth access: ${e}`);
    return makeError(requestId, 'oauth_error', String(e));
  }
};

/**
 * Get OAuth status for a server credential.
 */
const handleOAuthStatus: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const credentialKey = message.credential_key as string || '';

  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  if (!credentialKey) {
    return makeError(requestId, 'invalid_request', 'Missing credential_key');
  }

  try {
    const status = getOAuthStatus(serverId, credentialKey);
    return makeResult('oauth_status', requestId, { status });
  } catch (e) {
    log(`Failed to get OAuth status: ${e}`);
    return makeError(requestId, 'oauth_error', String(e));
  }
};

/**
 * Get list of configured OAuth providers.
 */
const handleListOAuthProviders: MessageHandler = async (message) => {
  const requestId = message.request_id || '';

  try {
    const providers = getConfiguredProviders();
    return makeResult('list_oauth_providers', requestId, { providers });
  } catch (e) {
    log(`Failed to list OAuth providers: ${e}`);
    return makeError(requestId, 'oauth_error', String(e));
  }
};

// =============================================================================
// Host API Handlers
// =============================================================================

/**
 * Grant a permission to an origin.
 */
const handleHostGrantPermission: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const origin = message.origin as string || '';
  const scope = message.scope as PermissionScope;
  const grantType = (message.grant_type as GrantType) || GrantType.ALLOW_ONCE;

  if (!origin) {
    return makeError(requestId, 'invalid_request', 'Missing origin');
  }
  if (!scope) {
    return makeError(requestId, 'invalid_request', 'Missing scope');
  }

  try {
    await grantPermission(origin, 'default', scope, grantType, {
      tabId: message.tab_id as number | undefined,
      allowedTools: message.allowed_tools as string[] | undefined,
    });
    return makeResult('host_grant_permission', requestId, { granted: true });
  } catch (e) {
    log(`Failed to grant permission: ${e}`);
    return makeError(requestId, 'permission_error', String(e));
  }
};

/**
 * Revoke a permission from an origin.
 */
const handleHostRevokePermission: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const origin = message.origin as string || '';
  const scope = message.scope as PermissionScope;

  if (!origin) {
    return makeError(requestId, 'invalid_request', 'Missing origin');
  }
  if (!scope) {
    return makeError(requestId, 'invalid_request', 'Missing scope');
  }

  try {
    await revokePermission(origin, 'default', scope);
    return makeResult('host_revoke_permission', requestId, { revoked: true });
  } catch (e) {
    log(`Failed to revoke permission: ${e}`);
    return makeError(requestId, 'permission_error', String(e));
  }
};

/**
 * Check if an origin has a permission.
 */
const handleHostCheckPermission: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const origin = message.origin as string || '';
  const scope = message.scope as PermissionScope;

  if (!origin) {
    return makeError(requestId, 'invalid_request', 'Missing origin');
  }
  if (!scope) {
    return makeError(requestId, 'invalid_request', 'Missing scope');
  }

  try {
    const result = checkPermission(origin, 'default', scope);
    return makeResult('host_check_permission', requestId, {
      granted: result.granted,
      grant: result.grant,
      error: result.error,
    });
  } catch (e) {
    log(`Failed to check permission: ${e}`);
    return makeError(requestId, 'permission_error', String(e));
  }
};

/**
 * Get all permissions for an origin.
 */
const handleHostGetPermissions: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const origin = message.origin as string || '';

  if (!origin) {
    return makeError(requestId, 'invalid_request', 'Missing origin');
  }

  try {
    const grants = getPermissions(origin, 'default');
    return makeResult('host_get_permissions', requestId, { grants });
  } catch (e) {
    log(`Failed to get permissions: ${e}`);
    return makeError(requestId, 'permission_error', String(e));
  }
};

/**
 * Expire tab-scoped permissions when a tab closes.
 */
const handleHostExpireTabGrants: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const tabId = message.tab_id as number;

  if (tabId === undefined) {
    return makeError(requestId, 'invalid_request', 'Missing tab_id');
  }

  try {
    const expired = expireTabGrants(tabId);
    return makeResult('host_expire_tab_grants', requestId, { expired });
  } catch (e) {
    log(`Failed to expire tab grants: ${e}`);
    return makeError(requestId, 'permission_error', String(e));
  }
};

/**
 * List tools (with permission enforcement).
 */
const handleHostListTools: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const origin = message.origin as string || '';

  if (!origin) {
    return makeError(requestId, 'invalid_request', 'Missing origin');
  }

  try {
    const host = getMcpHost();
    const result = host.listTools(origin, {
      serverIds: message.server_ids as string[] | undefined,
    });

    if (result.error) {
      return {
        type: 'error',
        request_id: requestId,
        error: result.error,
      };
    }

    return makeResult('host_list_tools', requestId, { tools: result.tools });
  } catch (e) {
    log(`Failed to list tools: ${e}`);
    return makeError(requestId, 'host_error', String(e));
  }
};

/**
 * Call a tool (with permission and rate limit enforcement).
 */
const handleHostCallTool: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const origin = message.origin as string || '';
  const toolName = message.tool_name as string || '';
  const args = (message.args || {}) as Record<string, unknown>;

  if (!origin) {
    return makeError(requestId, 'invalid_request', 'Missing origin');
  }
  if (!toolName) {
    return makeError(requestId, 'invalid_request', 'Missing tool_name');
  }

  try {
    const host = getMcpHost();
    const result = await host.callTool(origin, toolName, args, {
      timeoutMs: message.timeout_ms as number | undefined,
      runId: message.run_id as string | undefined,
    });

    if (!result.ok) {
      return {
        type: 'error',
        request_id: requestId,
        error: result.error,
      };
    }

    return makeResult('host_call_tool', requestId, {
      result: result.result,
      provenance: result.provenance,
    });
  } catch (e) {
    log(`Failed to call tool: ${e}`);
    return makeError(requestId, 'host_error', String(e));
  }
};

/**
 * Get Host statistics.
 */
const handleHostGetStats: MessageHandler = async (message) => {
  const requestId = message.request_id || '';

  try {
    const host = getMcpHost();
    const stats = host.getStats();
    return makeResult('host_get_stats', requestId, { stats });
  } catch (e) {
    log(`Failed to get host stats: ${e}`);
    return makeError(requestId, 'host_error', String(e));
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
 * Set the active LLM provider and optionally the model.
 */
const handleLlmSetActive: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const providerId = message.provider_id as string || '';
  const modelId = message.model_id as string | undefined;

  if (!providerId) {
    return makeError(requestId, 'invalid_request', 'Missing provider_id');
  }

  try {
    const success = llmManager.setActive(providerId, modelId);
    
    if (!success) {
      return makeError(requestId, 'llm_error', `Provider not available: ${providerId}`);
    }
    
    return makeResult('llm_set_active', requestId, { 
      success: true,
      active: providerId,
      model: llmManager.getActiveModelId(),
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
    const activeModelId = llmManager.getActiveModelId();
    
    return makeResult('llm_get_active', requestId, { 
      active: activeId,
      model: activeModelId,
      status: activeStatus,
    });
  } catch (e) {
    log(`Failed to get active LLM: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Set the active model for the current provider.
 */
const handleLlmSetModel: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const modelId = message.model_id as string || '';

  if (!modelId) {
    return makeError(requestId, 'invalid_request', 'Missing model_id');
  }

  try {
    const success = llmManager.setActiveModel(modelId);
    
    if (!success) {
      return makeError(requestId, 'llm_error', 'No active provider to set model for');
    }
    
    return makeResult('llm_set_model', requestId, { 
      success: true,
      model: modelId,
      provider: llmManager.getActiveId(),
    });
  } catch (e) {
    log(`Failed to set active model: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Set an API key for an LLM provider.
 */
const handleLlmSetApiKey: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const providerId = message.provider_id as string || '';
  const apiKey = message.api_key as string || '';

  if (!providerId) {
    return makeError(requestId, 'invalid_request', 'Missing provider_id');
  }
  if (!apiKey) {
    return makeError(requestId, 'invalid_request', 'Missing api_key');
  }

  try {
    llmManager.setApiKey(providerId, apiKey);
    
    // Detect the provider to verify it works
    const providers = await llmManager.detectAll();
    const providerStatus = providers.find(p => p.id === providerId);
    
    return makeResult('llm_set_api_key', requestId, { 
      success: true,
      provider: providerId,
      available: providerStatus?.available || false,
    });
  } catch (e) {
    log(`Failed to set API key: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Remove an API key for an LLM provider.
 */
const handleLlmRemoveApiKey: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const providerId = message.provider_id as string || '';

  if (!providerId) {
    return makeError(requestId, 'invalid_request', 'Missing provider_id');
  }

  try {
    llmManager.removeApiKey(providerId);
    
    return makeResult('llm_remove_api_key', requestId, { 
      success: true,
      provider: providerId,
    });
  } catch (e) {
    log(`Failed to remove API key: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Get supported LLM providers (local and remote).
 */
const handleLlmGetSupportedProviders: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';

  try {
    const supported = llmManager.getSupportedProviders();
    const configured = llmManager.getConfiguredApiKeys();
    
    return makeResult('llm_get_supported_providers', requestId, { 
      local: supported.local,
      remote: supported.remote,
      configuredApiKeys: configured,
    });
  } catch (e) {
    log(`Failed to get supported providers: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * Get LLM configuration summary.
 */
const handleLlmGetConfig: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';

  try {
    const summary = llmManager.getSummary();
    const allStatus = llmManager.getAllStatus();
    
    return makeResult('llm_get_config', requestId, { 
      ...summary,
      providers: allStatus,
    });
  } catch (e) {
    log(`Failed to get LLM config: ${e}`);
    return makeError(requestId, 'llm_error', String(e));
  }
};

/**
 * List models from a specific provider.
 */
const handleLlmListModelsFor: MessageHandler = async (message, _store, _client, _catalog, _installer, _mcpManager, llmManager) => {
  const requestId = message.request_id || '';
  const providerId = message.provider_id as string || '';

  if (!providerId) {
    return makeError(requestId, 'invalid_request', 'Missing provider_id');
  }

  try {
    const models = await llmManager.listModelsFor(providerId);
    
    return makeResult('llm_list_models_for', requestId, { 
      models,
      provider: providerId,
    });
  } catch (e) {
    log(`Failed to list models for ${providerId}: ${e}`);
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
  const useToolRouter = message.use_tool_router === true; // Default to false - let LLM see all tools

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
// Curated Directory Handlers
// =============================================================================

/**
 * Get the curated list of MCP servers (simple version for sidebar).
 * Returns just the basic info needed for the UI.
 */
const handleGetCuratedServers: MessageHandler = async (message, _store, _client, _catalog, _installer) => {
  const requestId = message.request_id || '';
  
  try {
    return makeResult('get_curated_servers', requestId, { servers: CURATED_SERVERS });
  } catch (e) {
    log(`Failed to get curated servers: ${e}`);
    return makeError(requestId, 'curated_error', String(e));
  }
};

/**
 * Get the curated list of MCP servers with installation status.
 * This is a static, handpicked list that we know works well.
 */
const handleGetCuratedList: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  
  try {
    // Get installed server IDs to mark which ones are already installed
    const installedStatuses = installer.getAllStatus();
    const installedIds = new Set(
      installedStatuses
        .filter(s => s.installed && s.server)
        .map(s => s.server!.id)
    );
    
    // Return curated servers with installation status
    const servers = CURATED_SERVERS.map(server => ({
      ...server,
      isInstalled: installedIds.has(server.id),
    }));
    
    return makeResult('get_curated_list', requestId, { servers });
  } catch (e) {
    log(`Failed to get curated list: ${e}`);
    return makeError(requestId, 'curated_error', String(e));
  }
};

/**
 * Install a server from the curated list (simple version for sidebar).
 * Uses server_id from the request.
 */
const handleInstallCuratedServer: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  
  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  
  const curated = getCuratedServer(serverId);
  if (!curated) {
    return makeError(requestId, 'not_found', `Curated server not found: ${serverId}`);
  }
  
  try {
    log(`[handleInstallCuratedServer] Installing ${curated.name} (${curated.id})`);
    
    // Build a catalog entry from the curated server
    const catalogEntry: CatalogServer = {
      id: curated.id,
      name: curated.name,
      description: curated.description,
      endpointUrl: '',
      installableOnly: true,
      tags: curated.tags || [],
      source: 'curated',
      fetchedAt: Date.now(),
      homepageUrl: curated.homepage || curated.homepageUrl || '',
      repositoryUrl: curated.repository || '',
      packages: [],
    };
    
    // Determine package info based on install method
    const install = curated.install;
    let packages: Array<{ registryType: string; identifier: string; binaryUrl?: string }> = [];
    
    switch (install.type) {
      case 'npm':
        packages = [{ registryType: 'npm', identifier: install.package }];
        break;
      case 'pypi':
        packages = [{ registryType: 'pypi', identifier: install.package }];
        break;
      case 'binary':
        // For binary, we need to resolve from GitHub
        const resolved = await resolveGitHubPackage(`https://github.com/${install.github}`);
        if (resolved && resolved.binaryUrl) {
          packages = [{ 
            registryType: 'binary', 
            identifier: install.binaryName,
            binaryUrl: resolved.binaryUrl,
          }];
        } else {
          return makeError(requestId, 'resolve_error', 
            `Could not find binary release for ${install.github}`);
        }
        break;
      case 'docker':
        packages = [{ registryType: 'oci', identifier: install.image }];
        break;
    }
    
    // Add packages to catalog entry (no hardcoded env vars - user configures via UI)
    (catalogEntry as any).packages = packages.map(p => ({
      registryType: p.registryType,
      identifier: p.identifier,
      binaryUrl: p.binaryUrl,
      environmentVariables: [],
    }));
    
    // Install the server
    const server = await installer.install(catalogEntry, 0, { 
      noDocker: curated.noDocker,
    });
    
    return makeResult('install_curated_server', requestId, { 
      success: true,
      server,
    });
  } catch (e) {
    log(`Failed to install curated server: ${e}`);
    return makeError(requestId, 'install_error', String(e));
  }
};

/**
 * Install a server from the curated list (with more options).
 */
const handleInstallCurated: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const curatedId = message.curated_id as string || '';
  const useDocker = message.use_docker as boolean || false;
  
  if (!curatedId) {
    return makeError(requestId, 'invalid_request', 'Missing curated_id');
  }
  
  const curated = getCuratedServer(curatedId);
  if (!curated) {
    return makeError(requestId, 'not_found', `Curated server not found: ${curatedId}`);
  }
  
  try {
    log(`[handleInstallCurated] Installing ${curated.name} (${curated.id})`);
    
    // Build a catalog entry from the curated server
    const catalogEntry: CatalogServer = {
      id: curated.id,
      name: curated.name,
      description: curated.description,
      endpointUrl: '',
      installableOnly: true,
      tags: curated.tags || [],
      source: 'curated',
      fetchedAt: Date.now(),
      homepageUrl: curated.homepage || curated.homepageUrl || '',
      repositoryUrl: curated.repository || '',
      packages: [],
    };
    
    // Determine package info based on install method
    const install = curated.install;
    let packages: Array<{ registryType: string; identifier: string; binaryUrl?: string }> = [];
    
    // Check if user wants Docker and server has Docker alternative
    if (useDocker && curated.dockerAlternative) {
      packages = [{
        registryType: 'oci',
        identifier: curated.dockerAlternative.image,
      }];
    } else {
      switch (install.type) {
        case 'npm':
          packages = [{ registryType: 'npm', identifier: install.package }];
          break;
        case 'pypi':
          packages = [{ registryType: 'pypi', identifier: install.package }];
          break;
        case 'binary':
          // For binary, we need to resolve from GitHub
          const resolved = await resolveGitHubPackage(`https://github.com/${install.github}`);
          if (resolved && resolved.binaryUrl) {
            packages = [{ 
              registryType: 'binary', 
              identifier: install.binaryName,
              binaryUrl: resolved.binaryUrl,
            }];
          } else {
            return makeError(requestId, 'resolve_error', 
              `Could not find binary release for ${install.github}`);
          }
          break;
        case 'docker':
          packages = [{ registryType: 'oci', identifier: install.image }];
          break;
      }
    }
    
    // Add packages to catalog entry (no hardcoded env vars - user configures via UI)
    (catalogEntry as any).packages = packages.map(p => ({
      registryType: p.registryType,
      identifier: p.identifier,
      binaryUrl: p.binaryUrl,
      environmentVariables: [],
    }));
    
    // Install the server
    const server = await installer.install(catalogEntry, 0, { 
      noDocker: curated.noDocker,
    });
    
    return makeResult('install_curated', requestId, { 
      server,
    });
  } catch (e) {
    log(`Failed to install curated server: ${e}`);
    return makeError(requestId, 'install_error', String(e));
  }
};

/**
 * Install a server from a GitHub URL (from sidebar).
 */
const handleInstallGithubRepo: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  let githubUrl = message.github_url as string || '';
  
  if (!githubUrl) {
    return makeError(requestId, 'invalid_request', 'Missing github_url');
  }
  
  // Normalize: support owner/repo format
  if (!githubUrl.includes('github.com') && githubUrl.match(/^[\w-]+\/[\w.-]+$/)) {
    githubUrl = `https://github.com/${githubUrl}`;
  }
  
  // Validate it's a GitHub URL
  if (!githubUrl.includes('github.com')) {
    return makeError(requestId, 'invalid_request', 'Not a valid GitHub URL');
  }
  
  try {
    log(`[handleInstallGithubRepo] Resolving: ${githubUrl}`);
    
    // Resolve package info from GitHub
    const resolved = await resolveGitHubPackage(githubUrl);
    
    if (!resolved || !resolved.name) {
      return makeError(requestId, 'resolve_error', 
        'Could not determine how to install this repository.\n\n' +
        'Supported formats:\n' +
        '• npm packages (package.json)\n' +
        '• Python packages (pyproject.toml)\n' +
        '• Go binaries (GitHub releases)\n\n' +
        'Check the repository for manual installation instructions.');
    }
    
    // Build catalog entry
    const repoName = githubUrl.match(/github\.com\/[^/]+\/([^/]+)/)?.[1] || resolved.name;
    
    // Determine package type
    let registryType: string;
    if (resolved.type === 'python') {
      registryType = 'pypi';
    } else if (resolved.type === 'binary') {
      registryType = 'binary';
    } else {
      registryType = 'npm';
    }
    
    const catalogEntry: CatalogServer = {
      id: `github-${repoName}-${Date.now()}`,
      name: resolved.name,
      description: `Installed from ${githubUrl}`,
      endpointUrl: '',
      installableOnly: true,
      tags: ['custom', 'github'],
      source: 'github',
      fetchedAt: Date.now(),
      homepageUrl: githubUrl,
      repositoryUrl: githubUrl,
      packages: [{
        registryType: registryType as 'npm' | 'pypi' | 'oci' | 'binary',
        identifier: resolved.name,
        binaryUrl: resolved.binaryUrl,
        environmentVariables: [],
      }],
    };
    
    // Install
    const server = await installer.install(catalogEntry, 0);
    
    return makeResult('install_github_repo', requestId, {
      success: true,
      server_id: server.id,
      package_type: registryType,
      needs_config: false, // TODO: detect if server needs config
    });
  } catch (e) {
    log(`Failed to install from GitHub: ${e}`);
    return makeError(requestId, 'install_error', String(e));
  }
};

/**
 * Install a server from a GitHub URL (with more options).
 */
const handleInstallFromGitHub: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const githubUrl = message.github_url as string || '';
  const useDocker = message.use_docker as boolean || false;
  
  if (!githubUrl) {
    return makeError(requestId, 'invalid_request', 'Missing github_url');
  }
  
  // Validate it's a GitHub URL
  if (!githubUrl.includes('github.com')) {
    return makeError(requestId, 'invalid_request', 'Not a valid GitHub URL');
  }
  
  try {
    log(`[handleInstallFromGitHub] Resolving: ${githubUrl}`);
    
    // Resolve package info from GitHub
    const resolved = await resolveGitHubPackage(githubUrl);
    
    if (!resolved || !resolved.name) {
      return makeError(requestId, 'resolve_error', 
        'Could not determine how to install this repository.\n\n' +
        'Supported formats:\n' +
        '• npm packages (package.json)\n' +
        '• Python packages (pyproject.toml)\n' +
        '• Go binaries (GitHub releases)\n\n' +
        'Check the repository for manual installation instructions.');
    }
    
    // Build catalog entry
    const repoName = githubUrl.match(/github\.com\/[^/]+\/([^/]+)/)?.[1] || resolved.name;
    
    // Determine package type
    let registryType: string;
    if (resolved.type === 'python') {
      registryType = 'pypi';
    } else if (resolved.type === 'binary') {
      registryType = 'binary';
    } else {
      registryType = 'npm';
    }
    
    const catalogEntry: CatalogServer = {
      id: `github-${repoName}-${Date.now()}`,
      name: resolved.name,
      description: `Installed from ${githubUrl}`,
      endpointUrl: '',
      installableOnly: true,
      tags: ['custom', 'github'],
      source: 'github',
      fetchedAt: Date.now(),
      homepageUrl: githubUrl,
      repositoryUrl: githubUrl,
      packages: [{
        registryType: registryType as 'npm' | 'pypi' | 'oci' | 'binary',
        identifier: resolved.name,
        binaryUrl: resolved.binaryUrl,
        environmentVariables: [],
      }],
    };
    
    // Install
    const server = await installer.install(catalogEntry, 0);
    
    return makeResult('install_from_github', requestId, {
      server,
      resolved: {
        name: resolved.name,
        type: resolved.type,
        version: resolved.version,
      },
    });
  } catch (e) {
    log(`Failed to install from GitHub: ${e}`);
    return makeError(requestId, 'install_error', String(e));
  }
};

/**
 * Reconnect to orphaned Docker containers that are still running.
 * This is called on extension startup to restore connections.
 */
const handleReconnectOrphanedContainers: MessageHandler = async (message, _store, _client, _catalog, installer, mcpManager) => {
  const requestId = message.request_id || '';
  
  try {
    const dockerExec = getDockerExec();
    const info = await dockerExec.checkDocker();
    
    if (!info.available) {
      return makeResult('reconnect_orphaned_containers', requestId, {
        reconnected: [],
        failed: [],
        message: 'Docker not available',
      });
    }
    
    // Get running Harbor containers
    const containers = dockerExec.listHarborContainers();
    const runningContainers = containers.filter(c => c.status === 'running');
    
    if (runningContainers.length === 0) {
      return makeResult('reconnect_orphaned_containers', requestId, {
        reconnected: [],
        failed: [],
        message: 'No orphaned containers found',
      });
    }
    
    // Check which ones we're not connected to
    const connectedServerIds = new Set(
      mcpManager.getAllConnections().map(c => c.serverId)
    );
    
    const orphaned = runningContainers.filter(c => !connectedServerIds.has(c.serverId));
    
    if (orphaned.length === 0) {
      return makeResult('reconnect_orphaned_containers', requestId, {
        reconnected: [],
        failed: [],
        message: 'All containers are connected',
      });
    }
    
    log(`[handleReconnectOrphanedContainers] Found ${orphaned.length} orphaned containers`);
    
    const reconnected: string[] = [];
    const failed: Array<{ serverId: string; error: string }> = [];
    
    for (const container of orphaned) {
      const serverId = container.serverId;
      log(`[handleReconnectOrphanedContainers] Reconnecting ${serverId}...`);
      
      // Get the installed server config
      const server = installer.getServer(serverId);
      if (!server) {
        log(`[handleReconnectOrphanedContainers] Server ${serverId} not found in installed servers`);
        // Stop the orphan since we don't have its config
        await dockerExec.stopContainer(serverId);
        failed.push({ serverId, error: 'Server not installed' });
        continue;
      }
      
      try {
        // Stop the old container first (we can't reattach to its stdio)
        log(`[handleReconnectOrphanedContainers] Stopping old container for ${serverId}`);
        await dockerExec.stopContainer(serverId);
        
        // Small delay to ensure container is fully stopped
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Get secrets for this server
        const secretStore = getSecretStore();
        const envVars = secretStore.getAll(serverId);
        
        // Reconnect via Docker
        log(`[handleReconnectOrphanedContainers] Starting fresh connection for ${serverId}`);
        const result = await mcpManager.connect(server, envVars, { useDocker: true });
        
        if (result.success) {
          reconnected.push(serverId);
          log(`[handleReconnectOrphanedContainers] Successfully reconnected ${serverId}`);
        } else {
          failed.push({ serverId, error: result.error || 'Connection failed' });
          log(`[handleReconnectOrphanedContainers] Failed to reconnect ${serverId}: ${result.error}`);
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        failed.push({ serverId, error: errorMsg });
        log(`[handleReconnectOrphanedContainers] Error reconnecting ${serverId}: ${errorMsg}`);
      }
    }
    
    return makeResult('reconnect_orphaned_containers', requestId, {
      reconnected,
      failed,
      message: `Reconnected ${reconnected.length} of ${orphaned.length} orphaned containers`,
    });
  } catch (e) {
    log(`Failed to reconnect orphaned containers: ${e}`);
    return makeError(requestId, 'reconnect_error', String(e));
  }
};

/**
 * Check if Docker is available and get image/container status.
 */
const handleCheckDocker: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  
  try {
    const dockerExec = getDockerExec();
    const info = await dockerExec.checkDocker();
    
    // Also get image status and containers if Docker is available
    let images: Record<string, { exists: boolean; size?: string }> = {};
    let containers: Array<{
      id: string;
      name: string;
      serverId: string;
      image: string;
      status: 'running' | 'stopped';
      statusText: string;
      uptime?: string;
      cpu?: string;
      memory?: string;
    }> = [];
    
    if (info.available) {
      // Get image status
      const imageManager = getDockerImageManager();
      images = await imageManager.getImagesStatus();
      
      // Get running containers and their stats
      const containerList = dockerExec.listHarborContainers();
      const stats = dockerExec.getContainerStats();
      
      // Merge stats into container info
      containers = containerList.map(container => {
        const containerStats = stats.find(s => s.serverId === container.serverId);
        return {
          id: container.id,
          name: container.name,
          serverId: container.serverId,
          image: container.image,
          status: container.status,
          statusText: container.statusText,
          uptime: container.uptime,
          cpu: containerStats?.cpu,
          memory: containerStats?.memory,
        };
      });
    }
    
    return makeResult('check_docker', requestId, {
      ...info,
      images,
      containers,
    });
  } catch (e) {
    log(`Failed to check Docker: ${e}`);
    return makeError(requestId, 'docker_error', String(e));
  }
};

/**
 * Build Docker images for MCP server execution.
 */
const handleBuildDockerImages: MessageHandler = async (message) => {
  const requestId = message.request_id || '';
  const imageType = message.image_type as string | undefined;
  
  try {
    const imageManager = getDockerImageManager();
    
    if (imageType) {
      // Build specific image
      await imageManager.buildImage(imageType as 'node' | 'python' | 'binary' | 'multi');
      return makeResult('build_docker_images', requestId, {
        built: [imageType],
      });
    } else {
      // Build all images
      await imageManager.rebuildAllImages();
      return makeResult('build_docker_images', requestId, {
        built: ['node', 'python', 'binary', 'multi'],
      });
    }
  } catch (e) {
    log(`Failed to build Docker images: ${e}`);
    return makeError(requestId, 'docker_build_error', String(e));
  }
};

/**
 * Set Docker mode for a server.
 */
const handleSetDockerMode: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  const useDocker = message.use_docker as boolean ?? true;
  const volumes = message.volumes as string[] | undefined;
  
  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  
  try {
    installer.setDockerMode(serverId, useDocker, volumes);
    
    return makeResult('set_docker_mode', requestId, {
      server_id: serverId,
      use_docker: useDocker,
      volumes,
    });
  } catch (e) {
    log(`Failed to set Docker mode: ${e}`);
    return makeError(requestId, 'docker_mode_error', String(e));
  }
};

/**
 * Check if Docker should be preferred for a server.
 */
const handleShouldPreferDocker: MessageHandler = async (message, _store, _client, _catalog, installer) => {
  const requestId = message.request_id || '';
  const serverId = message.server_id as string || '';
  
  if (!serverId) {
    return makeError(requestId, 'invalid_request', 'Missing server_id');
  }
  
  try {
    const result = await installer.shouldPreferDocker(serverId);
    return makeResult('should_prefer_docker', requestId, result);
  } catch (e) {
    log(`Failed to check Docker preference: ${e}`);
    return makeError(requestId, 'docker_check_error', String(e));
  }
};

// =============================================================================
// Handler Registry
// =============================================================================

const HANDLERS: Record<string, MessageHandler> = {
  hello: handleHello,
  ping: handlePing,
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
  catalog_enrich: handleCatalogEnrich,
  // Curated directory handlers
  get_curated_servers: handleGetCuratedServers,
  get_curated_list: handleGetCuratedList,
  install_curated_server: handleInstallCuratedServer,
  install_curated: handleInstallCurated,
  install_github_repo: handleInstallGithubRepo,
  install_from_github: handleInstallFromGitHub,
  // Docker handlers
  check_docker: handleCheckDocker,
  reconnect_orphaned_containers: handleReconnectOrphanedContainers,
  build_docker_images: handleBuildDockerImages,
  set_docker_mode: handleSetDockerMode,
  should_prefer_docker: handleShouldPreferDocker,
  // Installer handlers
  check_runtimes: handleCheckRuntimes,
  install_server: handleInstallServer,
  add_remote_server: handleAddRemoteServer,
  import_config: handleImportConfig,
  resolve_github: handleResolveGitHub,
  resolve_server_package: handleResolveServerPackage,
  uninstall_server: handleUninstallServer,
  list_installed: handleListInstalled,
  start_installed: handleStartInstalled,
  stop_installed: handleStopInstalled,
  set_server_secrets: handleSetServerSecrets,
  update_server_args: handleUpdateServerArgs,
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
  // OAuth handlers
  oauth_start: handleOAuthStart,
  oauth_cancel: handleOAuthCancel,
  oauth_revoke: handleOAuthRevoke,
  oauth_status: handleOAuthStatus,
  list_oauth_providers: handleListOAuthProviders,
  // Host API handlers
  host_grant_permission: handleHostGrantPermission,
  host_revoke_permission: handleHostRevokePermission,
  host_check_permission: handleHostCheckPermission,
  host_get_permissions: handleHostGetPermissions,
  host_expire_tab_grants: handleHostExpireTabGrants,
  host_list_tools: handleHostListTools,
  host_call_tool: handleHostCallTool,
  host_get_stats: handleHostGetStats,
  // LLM handlers
  llm_detect: handleLlmDetect,
  llm_list_providers: handleLlmListProviders,
  llm_set_active: handleLlmSetActive,
  llm_set_model: handleLlmSetModel,
  llm_list_models: handleLlmListModels,
  llm_list_models_for: handleLlmListModelsFor,
  llm_chat: handleLlmChat,
  llm_get_active: handleLlmGetActive,
  llm_set_api_key: handleLlmSetApiKey,
  llm_remove_api_key: handleLlmRemoveApiKey,
  llm_get_supported_providers: handleLlmGetSupportedProviders,
  llm_get_config: handleLlmGetConfig,
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

