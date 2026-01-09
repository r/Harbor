/**
 * MCP Client Manager - manages multiple MCP server connections.
 * 
 * Integrates with the InstalledServerManager to:
 * - Build command/args from installed server config
 * - Inject environment variables (including secrets)
 * - Track connection state
 * 
 * Process Isolation:
 * When enabled (HARBOR_MCP_ISOLATION=1), each server runs in a forked process.
 * This provides crash isolation - if a server misbehaves, only the runner dies.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import { HttpMcpClient } from './http-client.js';
import { McpRunnerClient } from './runner-client.js';
import { resolveExecutable, getEnhancedPath } from '../utils/resolve-executable.js';
import { getBinaryPath, isLinuxBinaryDownloaded, downloadLinuxBinary } from '../installer/binary-downloader.js';
import { getLinuxBinaryUrl } from '../installer/github-resolver.js';
import { getDockerImageManager } from '../installer/docker-images.js';
import { spawn } from 'node:child_process';

// Union type for all client types (including isolated runner)
type McpClient = StdioMcpClient | HttpMcpClient | McpRunnerClient;

// Import the isolation checker (allows dynamic control in tests)
import { isProcessIsolationEnabled } from './isolation-config.js';

// Track servers that have successfully connected at least once
const CONNECTED_HISTORY_FILE = join(homedir(), '.harbor', 'connected_servers.json');

function loadConnectedHistory(): Set<string> {
  try {
    if (existsSync(CONNECTED_HISTORY_FILE)) {
      const data = JSON.parse(readFileSync(CONNECTED_HISTORY_FILE, 'utf-8'));
      return new Set(data.servers || []);
    }
  } catch (e) {
    log(`[McpClientManager] Failed to load connection history: ${e}`);
  }
  return new Set();
}

function saveConnectedHistory(servers: Set<string>): void {
  try {
    mkdirSync(join(homedir(), '.harbor'), { recursive: true });
    writeFileSync(CONNECTED_HISTORY_FILE, JSON.stringify({ servers: Array.from(servers) }, null, 2));
  } catch (e) {
    log(`[McpClientManager] Failed to save connection history: ${e}`);
  }
}

export interface ConnectedServer {
  serverId: string;
  client: McpClient;
  connectionInfo: McpConnectionInfo;
  installedServer: InstalledServer;
  connectedAt: number;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  runningInDocker?: boolean;
}

export interface McpConnectOptions {
  useDocker?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Server crash tracking for automatic restart.
 */
interface CrashTracker {
  serverId: string;
  restartCount: number;
  lastCrashAt: number;
  isRestarting: boolean;
}

/**
 * Max restart attempts before giving up.
 */
const MAX_RESTART_ATTEMPTS = 3;

/**
 * Restart delay multiplier (2s * attempt number).
 */
const RESTART_DELAY_MS = 2000;

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
  private connectedHistory: Set<string> = loadConnectedHistory();
  private crashTrackers: Map<string, CrashTracker> = new Map();
  private onServerCrash?: (serverId: string, restartAttempt: number, maxAttempts: number) => void;
  private onServerRestarted?: (serverId: string) => void;
  private onServerFailed?: (serverId: string, error: string) => void;

  /**
   * Set callback for when a server crashes.
   */
  setOnServerCrash(cb: (serverId: string, restartAttempt: number, maxAttempts: number) => void): void {
    this.onServerCrash = cb;
  }

  /**
   * Set callback for when a server restarts successfully.
   */
  setOnServerRestarted(cb: (serverId: string) => void): void {
    this.onServerRestarted = cb;
  }

  /**
   * Set callback for when a server fails all restart attempts.
   */
  setOnServerFailed(cb: (serverId: string, error: string) => void): void {
    this.onServerFailed = cb;
  }

  /**
   * Check if a server has ever successfully connected.
   * Used to detect first-time Python packages on macOS.
   */
  hasConnectedBefore(serverId: string): boolean {
    return this.connectedHistory.has(serverId);
  }

  /**
   * Mark a server as having successfully connected.
   */
  private markConnectedSuccess(serverId: string): void {
    if (!this.connectedHistory.has(serverId)) {
      this.connectedHistory.add(serverId);
      saveConnectedHistory(this.connectedHistory);
      log(`[McpClientManager] Marked ${serverId} as successfully connected`);
    }
  }

  /**
   * Connect to an installed MCP server.
   * 
   * @param server The installed server configuration
   * @param secrets Environment variables to inject (including secrets)
   * @param options Connection options including Docker mode
   * @returns Connection result with server info and capabilities
   */
  async connect(
    server: InstalledServer,
    secrets: Record<string, string> = {},
    options: McpConnectOptions = {}
  ): Promise<ConnectionResult> {
    const { id: serverId, packageType } = server;

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

    // Handle HTTP/SSE remote servers differently
    if (packageType === 'http' || packageType === 'sse') {
      return this.connectHttp(server, secrets);
    }

    // Handle local stdio servers (npm, pypi, binary)
    // Use Docker mode if requested
    if (options.useDocker) {
      return this.connectDocker(server, secrets, options);
    }

    return this.connectStdio(server, secrets);
  }

  /**
   * Connect to a remote HTTP/SSE MCP server.
   */
  private async connectHttp(
    server: InstalledServer,
    secrets: Record<string, string>
  ): Promise<ConnectionResult> {
    const { id: serverId, remoteUrl, remoteHeaders } = server;

    if (!remoteUrl) {
      return {
        success: false,
        serverId,
        error: 'Remote server URL is not configured.',
      };
    }

    log(`[McpClientManager] Connecting to HTTP server ${serverId}: ${remoteUrl}`);

    // Build headers, including any from secrets (e.g., Authorization tokens)
    const headers: Record<string, string> = {
      ...remoteHeaders,
    };
    
    // Check for common auth env vars and add as headers
    if (secrets['AUTHORIZATION']) {
      headers['Authorization'] = secrets['AUTHORIZATION'];
    }
    if (secrets['API_KEY']) {
      headers['Authorization'] = `Bearer ${secrets['API_KEY']}`;
    }

    const client = new HttpMcpClient({
      url: remoteUrl,
      headers,
    });

    try {
      const connectionInfo = await client.connect();

      const [tools, resources, prompts] = await Promise.all([
        connectionInfo.capabilities.tools ? client.listTools() : Promise.resolve([]),
        connectionInfo.capabilities.resources ? client.listResources() : Promise.resolve([]),
        connectionInfo.capabilities.prompts ? client.listPrompts() : Promise.resolve([]),
      ]);

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
      this.markConnectedSuccess(serverId);

      log(`[McpClientManager] Connected to HTTP server ${serverId}: ${tools.length} tools, ${resources.length} resources`);

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
      log(`[McpClientManager] Failed to connect to HTTP server ${serverId}: ${message}`);

      try {
        await client.disconnect();
      } catch {
        // Ignore
      }

      this.connections.delete(serverId);

      return {
        success: false,
        serverId,
        error: `Failed to connect to remote server: ${message}`,
      };
    }
  }

  /**
   * Connect to a local MCP server running in Docker.
   * 
   * This bypasses macOS Gatekeeper issues by running the server
   * inside a container.
   */
  private async connectDocker(
    server: InstalledServer,
    secrets: Record<string, string>,
    options: McpConnectOptions
  ): Promise<ConnectionResult> {
    const { id: serverId, packageType, packageId } = server;
    const progress = options.onProgress || ((msg: string) => log(`[Docker Progress] ${msg}`));

    log(`[McpClientManager] Connecting to ${serverId} via Docker`);
    progress(`🐳 Starting Docker setup for ${server.name}...`);

    // Declare client outside try block so it's accessible in catch for error logging
    let client: StdioMcpClient | null = null;

    try {
      let imageName: string;
      
      // For OCI packages, use the package ID directly as the Docker image
      // No need to build a custom image
      if (packageType === 'oci') {
        progress('Using official Docker image...');
        imageName = packageId;  // e.g., "ghcr.io/github/github-mcp-server"
        
        // Pull the image if needed
        progress(`Pulling Docker image: ${imageName}...`);
        const dockerPath = resolveExecutable('docker');
        
        await new Promise<void>((resolve, reject) => {
          const pull = spawn(dockerPath, ['pull', imageName], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          
          pull.stdout?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            if (line) progress(line);
          });
          
          pull.stderr?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            if (line) log(`[Docker pull stderr] ${line}`);
          });
          
          pull.on('close', (code) => {
            if (code === 0) {
              progress(`✓ Docker image ready: ${imageName}`);
              resolve();
            } else {
              reject(new Error(`Failed to pull Docker image: ${imageName}`));
            }
          });
          
          pull.on('error', (err) => {
            reject(new Error(`Docker pull failed: ${err.message}`));
          });
        });
      } else {
        // Import Docker modules dynamically to avoid loading if not used
        progress('Checking Docker image...');
        const imageManager = getDockerImageManager();
        
        // Ensure the appropriate Docker image is built
        const imageType = imageManager.getImageTypeForPackage(packageType);
        progress(`Checking for ${imageType} runtime image...`);
        
        // Check if image exists
        const imageExists = await imageManager.imageExists(imageType);
        if (!imageExists) {
          progress(`Building ${imageType} Docker image (first time only)...`);
          progress('This may take 1-2 minutes to download and build...');
        }
        
        imageName = await imageManager.ensureImage(imageType, progress);
        progress(`✓ Docker image ready: ${imageName}`);
      }
      
      // Build docker run command
      progress('Preparing container configuration...');
      const containerName = `harbor-mcp-${serverId.replace(/[^a-zA-Z0-9-]/g, '-')}`;
      const dockerArgs: string[] = [
        'run',
        '--rm',
        '-i',
        '--name', containerName,
      ];
      
      // Add environment variables
      for (const [key, value] of Object.entries(secrets)) {
        dockerArgs.push('-e', `${key}=${value}`);
      }
      
      // Add volume mounts if configured
      if (server.dockerVolumes) {
        for (const vol of server.dockerVolumes) {
          dockerArgs.push('-v', vol);
        }
      }
      
      // For binary packages, we need the LINUX binary (not the native one)
      // Docker runs Linux containers, so macOS/Windows binaries won't work
      if (packageType === 'binary') {
        // Check if we have the Linux binary already
        let linuxBinaryPath = getBinaryPath(serverId, undefined, true);
        
        if (!isLinuxBinaryDownloaded(serverId)) {
          // Need to download the Linux binary
          progress('Downloading Linux binary for Docker...');
          
          if (!server.githubOwner || !server.githubRepo) {
            throw new Error(
              'Cannot run this binary server in Docker: missing GitHub repository info. ' +
              'The Linux binary needs to be downloaded from GitHub releases.'
            );
          }
          
          const linuxUrl = await getLinuxBinaryUrl(server.githubOwner, server.githubRepo);
          if (!linuxUrl) {
            throw new Error(
              `No Linux binary found for ${server.githubOwner}/${server.githubRepo}. ` +
              'This server may not have Linux releases available.'
            );
          }
          
          log(`[McpClientManager] Downloading Linux binary from: ${linuxUrl}`);
          linuxBinaryPath = await downloadLinuxBinary(serverId, linuxUrl, {
            expectedBinaryName: server.name,
            onProgress: progress,
          });
        }
        
        log(`[McpClientManager] Mounting Linux binary: ${linuxBinaryPath}`);
        progress('Mounting Linux binary into container...');
        dockerArgs.push('-v', `${linuxBinaryPath}:/app/server:ro`);
      }
      
      // Add the image
      dockerArgs.push(imageName);
      
      // Add the package/command to run based on package type
      if (packageType === 'npm') {
        // Our node image expects the npm package as argument
        dockerArgs.push(packageId);
      } else if (packageType === 'git') {
        // For git packages, convert URL to github:user/repo format
        let gitRef = packageId;
        const match = packageId.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (match) {
          gitRef = `github:${match[1]}`;
        }
        log(`[McpClientManager] Git package: ${packageId} -> ${gitRef}`);
        dockerArgs.push(gitRef);
      } else if (packageType === 'pypi') {
        // Our python image expects the pypi package as argument
        dockerArgs.push(packageId);
      } else if (packageType === 'oci') {
        // OCI images have their own entrypoint, no command needed
        // Just add any user-specified args
      }
      // For binary, the entrypoint handles /app/server
      
      // Add server arguments
      if (server.args && server.args.length > 0) {
        dockerArgs.push(...server.args);
      } else if (packageType === 'binary') {
        // Most Go MCP servers need 'stdio' subcommand
        dockerArgs.push('stdio');
      } else if (packageType === 'oci') {
        // GitHub MCP server needs 'stdio' mode
        // Most MCP servers in Docker expect stdio transport
        dockerArgs.push('stdio');
      }
      
      log(`[McpClientManager] Docker command: docker ${dockerArgs.join(' ')}`);
      progress(`Starting container with ${packageId}...`);
      
      // Resolve docker executable path
      const dockerPath = resolveExecutable('docker');
      
      // Create the client
      client = new StdioMcpClient({
        command: dockerPath,
        args: dockerArgs,
        env: {
          PATH: getEnhancedPath(),
        },
        onExit: (_code, _signal) => {
          log(`[McpClientManager] Docker container for ${serverId} exited`);
          this.handleServerCrash(serverId, server, secrets);
        },
      });

      // Connect via the MCP protocol
      progress('Container starting, waiting for MCP handshake...');
      log(`[McpClientManager] Waiting for MCP handshake from Docker container ${containerName}...`);
      
      // Log periodic updates while waiting
      const connectStartTime = Date.now();
      const connectStatusInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - connectStartTime) / 1000);
        log(`[McpClientManager:${serverId}] Still waiting for MCP response... (${elapsed}s)`);
        progress(`Waiting for server to initialize... (${elapsed}s)`);
      }, 10000);
      
      let connectionInfo;
      try {
        connectionInfo = await client.connect();
      } finally {
        clearInterval(connectStatusInterval);
      }
      const connectTime = Math.round((Date.now() - connectStartTime) / 1000);
      progress(`✓ MCP connection established! (${connectTime}s)`);
      log(`[McpClientManager] Docker MCP handshake completed in ${connectTime}s`);

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
        runningInDocker: true,
      };

      this.connections.set(serverId, connectedServer);
      this.markConnectedSuccess(serverId);

      log(`[McpClientManager] Connected to ${serverId} via Docker: ${tools.length} tools, ${resources.length} resources`);

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
      log(`[McpClientManager] Failed to connect to ${serverId} via Docker: ${message}`);

      // Try to get stderr output from the client for better error messages
      let stderrOutput = '';
      try {
        if (client && client.getStderrLog) {
          const stderrLines = client.getStderrLog();
          if (stderrLines.length > 0) {
            stderrOutput = '\n\nServer output:\n' + stderrLines.slice(-10).join('\n');
          }
        }
      } catch {
        // Ignore errors getting stderr
      }

      // Try to provide more context about why the connection failed
      let errorDetail = `Docker connection failed: ${message}`;
      
      // Check if we have any stderr output that might explain the failure
      if (message.includes('Connection closed') || message.includes('-32000')) {
        errorDetail += '\n\nThe server crashed on startup. Common causes:';
        errorDetail += '\n• Missing required environment variables (API tokens, credentials)';
        errorDetail += '\n• Invalid configuration or arguments';
        errorDetail += '\n\nClick ⚙️ to configure, then check the server documentation for required settings.';
      }
      
      errorDetail += stderrOutput;

      return {
        success: false,
        serverId,
        error: errorDetail,
      };
    }
  }

  /**
   * Connect to a local stdio-based MCP server.
   * 
   * When process isolation is enabled (HARBOR_MCP_ISOLATION=1), the server
   * runs in a forked process for crash isolation.
   */
  private async connectStdio(
    server: InstalledServer,
    secrets: Record<string, string>
  ): Promise<ConnectionResult> {
    const { id: serverId } = server;

    let command: string;
    let args: string[];
    
    try {
      // Build the command based on package type
      const cmdResult = this.buildCommand(server);
      command = cmdResult.command;
      args = cmdResult.args;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      log(`[McpClientManager] Failed to build command for ${serverId}: ${errorMsg}`);
      return {
        success: false,
        serverId,
        error: errorMsg,
      };
    }
    
    const isolationMode = isProcessIsolationEnabled() ? 'isolated' : 'direct';
    log(`[McpClientManager] Connecting to ${serverId} (${isolationMode}): ${command} ${args.join(' ')}`);

    // Use isolated runner or direct client based on configuration
    if (isProcessIsolationEnabled()) {
      return this.connectStdioIsolated(server, serverId, command, args, secrets);
    } else {
      return this.connectStdioDirect(server, serverId, command, args, secrets);
    }
  }

  /**
   * Connect to a server using an isolated runner process.
   * Provides crash isolation: if the server crashes, only the runner dies.
   */
  private async connectStdioIsolated(
    server: InstalledServer,
    serverId: string,
    command: string,
    args: string[],
    secrets: Record<string, string>
  ): Promise<ConnectionResult> {
    // Create the isolated runner client
    const client = new McpRunnerClient({
      serverId,
      onCrash: (error) => {
        log(`[McpClientManager] Isolated runner for ${serverId} crashed: ${error}`);
        this.handleServerCrash(serverId, server, secrets);
      },
    });

    try {
      // Start the runner and connect
      const connectionInfo = await client.connect({
        command,
        args,
        env: {
          ...secrets,
          PATH: getEnhancedPath(),
        },
      });

      // Get cached capabilities from connect
      const tools = client.getCachedTools();
      const resources = client.getCachedResources();
      const prompts = client.getCachedPrompts();

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
      this.markConnectedSuccess(serverId);

      log(`[McpClientManager] Connected to ${serverId} (isolated): ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`);

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
      log(`[McpClientManager] Failed to connect to ${serverId} (isolated): ${message}`);

      // Clean up
      try {
        await client.stopRunner();
      } catch {
        // Ignore cleanup errors
      }

      return {
        success: false,
        serverId,
        error: `Failed to connect (isolated): ${message}`,
      };
    }
  }

  /**
   * Connect to a server directly (no process isolation).
   * Traditional approach: server runs as child process of the bridge.
   */
  private async connectStdioDirect(
    server: InstalledServer,
    serverId: string,
    command: string,
    args: string[],
    secrets: Record<string, string>
  ): Promise<ConnectionResult> {
    // Create the client with enhanced PATH for finding executables
    const client = new StdioMcpClient({
      command,
      args,
      env: {
        ...secrets,
        PATH: getEnhancedPath(),
      },
      // Handle unexpected process exit
      onExit: (_code, _signal) => {
        log(`[McpClientManager] Server ${serverId} exited unexpectedly`);
        // Trigger crash handler
        this.handleServerCrash(serverId, server, secrets);
      },
    });

    try {
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
      
      // Mark this server as having successfully connected (for first-run detection)
      this.markConnectedSuccess(serverId);

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
      
      // Try to get stderr logs for better error reporting
      const stderrLogs = client.getStderrLog();
      if (stderrLogs.length > 0) {
        log(`[McpClientManager] Server stderr output:`);
        for (const line of stderrLogs.slice(-10)) {
          log(`  ${line}`);
        }
      }
      
      // Clean up the client
      try {
        await client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      
      // Clean up any partial connection
      this.connections.delete(serverId);

      // Build the command string for user instructions
      const cmdParts = [command, ...args];
      const commandStr = cmdParts.join(' ');

      // Check for specific error patterns and provide helpful messages
      let errorMessage = message;
      const stderrText = stderrLogs.join('\n');
      
      // macOS code signing / Gatekeeper blocking - detect various patterns
      const isMacOSSecurityBlock = 
        stderrText.includes('library load disallowed by system policy') ||
        stderrText.includes('not valid for use in process') ||
        stderrText.includes('code signature') ||
        stderrText.includes('killed') ||
        stderrText.includes('cannot be opened') ||
        (stderrText.includes('dlopen') && stderrText.includes('.so')) ||
        // SIGKILL with no stderr often means macOS killed it
        (message.includes('SIGKILL') && stderrLogs.length === 0);
      
      if (isMacOSSecurityBlock) {
        // For binary packages, provide detailed Gatekeeper bypass instructions
        if (server.packageType === 'binary') {
          const binaryPath = server.binaryPath || command;
          errorMessage = `macOS Security Approval Required

macOS Gatekeeper blocked this binary because it wasn't downloaded from the App Store.

To allow it, follow these steps:

1. Open System Settings → Privacy & Security

2. Scroll down to the "Security" section

3. Look for a message about "${server.name}" being blocked

4. Click "Allow Anyway"

5. Come back here and click Start again

6. If macOS shows another prompt, click "Open"

Alternatively, run this command in Terminal:
  sudo xattr -rd com.apple.quarantine "${binaryPath}"`;
        } else {
          errorMessage = `macOS Blocked This Package

macOS security (Gatekeeper) is blocking this package because it contains native code that isn't signed by Apple.

This is a macOS restriction that Harbor cannot bypass for npm/Python packages with native extensions.

Please try a different MCP server, or check the package's GitHub page for manual installation instructions.`;
        }
      }
      // Python module not found
      else if (stderrText.includes('ModuleNotFoundError') || stderrText.includes('No module named')) {
        errorMessage = `Python dependency issue: A required module could not be loaded. This often happens when the package has dependencies that aren't installed.`;
      }
      // Command not found (uvx/npx not available)
      else if (message.includes('ENOENT') || message.includes('not found') || message.includes('spawn')) {
        if (server.packageType === 'pypi') {
          errorMessage = `Python runtime not available: The Python package runner (uvx) is not installed on this system.`;
        } else {
          errorMessage = `Node.js runtime not available: The Node.js package runner (npx) is not installed on this system.`;
        }
      }
      // Generic error with stderr
      else if (stderrLogs.length > 0) {
        const lastLines = stderrLogs.slice(-8).join('\n');
        errorMessage = `${message}\n\nServer output:\n${lastLines}`;
      }

      return {
        success: false,
        serverId,
        error: errorMessage,
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
   * Handle server crash and attempt restart.
   */
  private async handleServerCrash(serverId: string, server: InstalledServer, secrets: Record<string, string>): Promise<void> {
    // Get or create crash tracker
    let tracker = this.crashTrackers.get(serverId);
    if (!tracker) {
      tracker = {
        serverId,
        restartCount: 0,
        lastCrashAt: Date.now(),
        isRestarting: false,
      };
      this.crashTrackers.set(serverId, tracker);
    }

    // Check if already restarting
    if (tracker.isRestarting) {
      log(`[McpClientManager] Already restarting ${serverId}, ignoring duplicate crash event`);
      return;
    }

    // Clean up the crashed connection
    this.connections.delete(serverId);

    // Check if we've exceeded restart attempts
    if (tracker.restartCount >= MAX_RESTART_ATTEMPTS) {
      log(`[McpClientManager] Server ${serverId} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`);
      this.onServerFailed?.(serverId, `Server crashed ${MAX_RESTART_ATTEMPTS} times`);
      return;
    }

    // Increment restart count and set restarting flag
    tracker.restartCount++;
    tracker.lastCrashAt = Date.now();
    tracker.isRestarting = true;

    log(`[McpClientManager] Server ${serverId} crashed, attempting restart ${tracker.restartCount}/${MAX_RESTART_ATTEMPTS}`);
    this.onServerCrash?.(serverId, tracker.restartCount, MAX_RESTART_ATTEMPTS);

    // Wait before restarting (exponential backoff)
    const delay = RESTART_DELAY_MS * tracker.restartCount;
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      // Attempt to reconnect
      const result = await this.connect(server, secrets);

      if (result.success) {
        log(`[McpClientManager] Successfully restarted ${serverId}`);
        tracker.isRestarting = false;
        // Reset restart count on successful restart
        tracker.restartCount = 0;
        this.onServerRestarted?.(serverId);
      } else {
        log(`[McpClientManager] Failed to restart ${serverId}: ${result.error}`);
        tracker.isRestarting = false;
        // Try again if we haven't exceeded max attempts
        if (tracker.restartCount < MAX_RESTART_ATTEMPTS) {
          this.handleServerCrash(serverId, server, secrets);
        } else {
          this.onServerFailed?.(serverId, result.error || 'Restart failed');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[McpClientManager] Error restarting ${serverId}: ${message}`);
      tracker.isRestarting = false;
      if (tracker.restartCount < MAX_RESTART_ATTEMPTS) {
        this.handleServerCrash(serverId, server, secrets);
      } else {
        this.onServerFailed?.(serverId, message);
      }
    }
  }

  /**
   * Reset crash tracker for a server.
   * Call this when a server is intentionally stopped.
   */
  resetCrashTracker(serverId: string): void {
    this.crashTrackers.delete(serverId);
  }

  /**
   * Get crash status for a server.
   */
  getCrashStatus(serverId: string): { restartCount: number; lastCrashAt: number | null; isRestarting: boolean } {
    const tracker = this.crashTrackers.get(serverId);
    return {
      restartCount: tracker?.restartCount ?? 0,
      lastCrashAt: tracker?.lastCrashAt ?? null,
      isRestarting: tracker?.isRestarting ?? false,
    };
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
   * Only available for stdio-based servers.
   */
  getStderrLog(serverId: string): string[] {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return [];
    }
    // HTTP clients don't have stderr
    if ('getStderrLog' in connection.client) {
      return (connection.client as StdioMcpClient).getStderrLog();
    }
    return [];
  }

  /**
   * Get the PID of a connected server's process.
   * Only available for stdio-based servers; HTTP servers return null.
   */
  getPid(serverId: string): number | null {
    const connection = this.connections.get(serverId);
    if (!connection) return null;
    // HTTP clients don't have a PID
    if ('getPid' in connection.client) {
      return (connection.client as StdioMcpClient).getPid();
    }
    return null;
  }

  /**
   * Build the command and args for starting an MCP server.
   * 
   * Resolves full paths to executables (npx, uvx, docker) to handle
   * cases where the bridge is started with a minimal PATH.
   * 
   * Supports npm (JS/TS) and pypi (Python) packages.
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

    if (packageType === 'git') {
      // For git packages, use npx with GitHub URL
      // npm supports: github:user/repo, https://github.com/user/repo.git
      const npxPath = resolveExecutable('npx');
      // Convert full URL to github:user/repo format
      let gitRef = packageId;
      const match = packageId.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) {
        gitRef = `github:${match[1]}`;
      }
      return {
        command: npxPath,
        args: ['-y', gitRef, ...(serverArgs || [])],
      };
    }

    if (packageType === 'pypi') {
      // Use uvx to run Python packages (from uv)
      // uvx runs packages in isolated environments automatically
      const uvxPath = resolveExecutable('uvx');
      return {
        command: uvxPath,
        args: [packageId, ...(serverArgs || [])],
      };
    }

    if (packageType === 'binary') {
      // For binary packages, packageId is the serverId
      // The binary is stored in ~/.harbor/bin/
      const binaryPath = server.binaryPath || getBinaryPath(packageId);
      if (!existsSync(binaryPath)) {
        throw new Error(`Binary not found: ${binaryPath}. Try reinstalling the server.`);
      }
      
      // Most Go MCP servers use 'stdio' subcommand to start the server
      // Add it if no args are provided (user can override if needed)
      const binaryArgs = serverArgs && serverArgs.length > 0 
        ? serverArgs 
        : ['stdio'];
        
      return {
        command: binaryPath,
        args: binaryArgs,
      };
    }

    // Future: Docker support
    // if (packageType === 'oci') {
    //   const dockerPath = resolveExecutable('docker');
    //   return {
    //     command: dockerPath,
    //     args: ['run', '-i', '--rm', packageId, ...(serverArgs || [])],
    //   };
    // }

    throw new Error(`Unsupported package type: ${packageType}. Supported: npm, git, pypi, binary`);
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

