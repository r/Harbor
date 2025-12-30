/**
 * MCP Client Manager - manages multiple MCP server connections.
 * 
 * Integrates with the InstalledServerManager to:
 * - Build command/args from installed server config
 * - Inject environment variables (including secrets)
 * - Track connection state
 */

import { log } from '../native-messaging.js';
import { InstalledServer } from '../types.js';
import { 
  StdioMcpClient, 
  McpConnectionInfo, 
  McpTool, 
  McpResource, 
  McpPrompt,
  McpToolCallResult 
} from './stdio-client.js';
import { resolveExecutable, getEnhancedPath } from '../utils/resolve-executable.js';

export interface ConnectedServer {
  serverId: string;
  client: StdioMcpClient;
  connectionInfo: McpConnectionInfo;
  installedServer: InstalledServer;
  connectedAt: number;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

export interface ConnectionResult {
  success: boolean;
  serverId: string;
  connectionInfo?: McpConnectionInfo;
  tools?: McpTool[];
  resources?: McpResource[];
  prompts?: McpPrompt[];
  error?: string;
}

/**
 * Manages multiple MCP client connections.
 * 
 * Design notes:
 * - Each installed server gets at most one connection
 * - Connections are tracked by serverId
 * - Tools/resources/prompts are cached after connection
 * - Future: Could support connection pooling for high-throughput
 */
export class McpClientManager {
  private connections: Map<string, ConnectedServer> = new Map();

  /**
   * Connect to an installed MCP server.
   * 
   * @param server The installed server configuration
   * @param secrets Environment variables to inject (including secrets)
   * @returns Connection result with server info and capabilities
   */
  async connect(
    server: InstalledServer,
    secrets: Record<string, string> = {}
  ): Promise<ConnectionResult> {
    const { id: serverId } = server;

    // Check if already connected
    const existing = this.connections.get(serverId);
    if (existing && existing.client.isConnected()) {
      log(`[McpClientManager] Already connected to ${serverId}`);
      return {
        success: true,
        serverId,
        connectionInfo: existing.connectionInfo,
        tools: existing.tools,
        resources: existing.resources,
        prompts: existing.prompts,
      };
    }

    try {
      // Build the command based on package type
      const { command, args } = this.buildCommand(server);
      
      log(`[McpClientManager] Connecting to ${serverId}: ${command} ${args.join(' ')}`);

      // Create the client with enhanced PATH for finding executables
      const client = new StdioMcpClient({
        command,
        args,
        env: {
          ...secrets,
          PATH: getEnhancedPath(),
        },
      });

      // Connect
      const connectionInfo = await client.connect();

      // Fetch capabilities
      const [tools, resources, prompts] = await Promise.all([
        connectionInfo.capabilities.tools ? client.listTools() : Promise.resolve([]),
        connectionInfo.capabilities.resources ? client.listResources() : Promise.resolve([]),
        connectionInfo.capabilities.prompts ? client.listPrompts() : Promise.resolve([]),
      ]);

      // Store the connection
      const connectedServer: ConnectedServer = {
        serverId,
        client,
        connectionInfo,
        installedServer: server,
        connectedAt: Date.now(),
        tools,
        resources,
        prompts,
      };

      this.connections.set(serverId, connectedServer);

      log(`[McpClientManager] Connected to ${serverId}: ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`);

      return {
        success: true,
        serverId,
        connectionInfo,
        tools,
        resources,
        prompts,
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[McpClientManager] Failed to connect to ${serverId}: ${message}`);
      
      // Clean up any partial connection
      this.connections.delete(serverId);

      return {
        success: false,
        serverId,
        error: message,
      };
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(serverId: string): Promise<boolean> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      log(`[McpClientManager] No connection found for ${serverId}`);
      return false;
    }

    try {
      await connection.client.disconnect();
      this.connections.delete(serverId);
      log(`[McpClientManager] Disconnected from ${serverId}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[McpClientManager] Error disconnecting from ${serverId}: ${message}`);
      // Remove from connections anyway
      this.connections.delete(serverId);
      return true;
    }
  }

  /**
   * Disconnect from all servers.
   */
  async disconnectAll(): Promise<void> {
    const serverIds = Array.from(this.connections.keys());
    await Promise.all(serverIds.map(id => this.disconnect(id)));
  }

  /**
   * Check if connected to a server.
   */
  isConnected(serverId: string): boolean {
    const connection = this.connections.get(serverId);
    return connection?.client.isConnected() ?? false;
  }

  /**
   * Get a connection by server ID.
   */
  getConnection(serverId: string): ConnectedServer | undefined {
    return this.connections.get(serverId);
  }

  /**
   * Get all connections.
   */
  getAllConnections(): ConnectedServer[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get all connected server IDs.
   */
  getConnectedServerIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * List tools from a connected server.
   */
  async listTools(serverId: string): Promise<McpTool[]> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Not connected to server: ${serverId}`);
    }
    return connection.tools;
  }

  /**
   * Refresh tools from a connected server.
   */
  async refreshTools(serverId: string): Promise<McpTool[]> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Not connected to server: ${serverId}`);
    }
    
    const tools = await connection.client.listTools();
    connection.tools = tools;
    return tools;
  }

  /**
   * List resources from a connected server.
   */
  async listResources(serverId: string): Promise<McpResource[]> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Not connected to server: ${serverId}`);
    }
    return connection.resources;
  }

  /**
   * List prompts from a connected server.
   */
  async listPrompts(serverId: string): Promise<McpPrompt[]> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Not connected to server: ${serverId}`);
    }
    return connection.prompts;
  }

  /**
   * Call a tool on a connected server.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Not connected to server: ${serverId}`);
    }

    return connection.client.callTool(toolName, args);
  }

  /**
   * Read a resource from a connected server.
   */
  async readResource(
    serverId: string,
    uri: string
  ): Promise<{ content: string; mimeType?: string }> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Not connected to server: ${serverId}`);
    }

    return connection.client.readResource(uri);
  }

  /**
   * Get a prompt from a connected server.
   */
  async getPrompt(
    serverId: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<{ description?: string; messages: Array<{ role: string; content: string }> }> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Not connected to server: ${serverId}`);
    }

    return connection.client.getPrompt(promptName, args);
  }

  /**
   * Get stderr logs from a connected server.
   */
  getStderrLog(serverId: string): string[] {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return [];
    }
    return connection.client.getStderrLog();
  }

  /**
   * Get the PID of a connected server's process.
   */
  getPid(serverId: string): number | null {
    const connection = this.connections.get(serverId);
    return connection?.client.getPid() ?? null;
  }

  /**
   * Build the command and args for starting an MCP server.
   * 
   * Resolves full paths to executables (npx, uvx, docker) to handle
   * cases where the bridge is started with a minimal PATH.
   * 
   * Currently only supports npm packages (JS/TS servers).
   * Future: Add support for Python (uvx), Docker, etc.
   */
  private buildCommand(server: InstalledServer): { command: string; args: string[] } {
    const { packageType, packageId, args: serverArgs } = server;

    if (packageType === 'npm') {
      // Use npx to run npm packages
      // The -y flag auto-confirms installation
      // Resolve full path to npx for environments with minimal PATH
      const npxPath = resolveExecutable('npx');
      return {
        command: npxPath,
        args: ['-y', packageId, ...(serverArgs || [])],
      };
    }

    // Future: Python support
    // if (packageType === 'pypi') {
    //   const uvxPath = resolveExecutable('uvx');
    //   return {
    //     command: uvxPath,
    //     args: [packageId, ...(serverArgs || [])],
    //   };
    // }

    // Future: Docker support
    // if (packageType === 'oci') {
    //   const dockerPath = resolveExecutable('docker');
    //   return {
    //     command: dockerPath,
    //     args: ['run', '-i', '--rm', packageId, ...(serverArgs || [])],
    //   };
    // }

    throw new Error(`Unsupported package type: ${packageType}. Currently only npm packages are supported.`);
  }
}

// Singleton instance
let _manager: McpClientManager | null = null;

export function getMcpClientManager(): McpClientManager {
  if (!_manager) {
    _manager = new McpClientManager();
  }
  return _manager;
}

