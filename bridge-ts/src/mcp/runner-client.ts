/**
 * MCP Runner Client - Bridge-side client for communicating with isolated MCP runners
 * 
 * This client manages forked runner processes and provides an API similar to
 * StdioMcpClient, but with the actual MCP connection running in a separate process.
 * 
 * Benefits:
 * - Crash isolation: If a server crashes, only the runner dies
 * - Memory isolation: Each server has its own memory space
 * - Works in pkg binaries: Uses --mcp-runner flag instead of forking .js files
 */

import { fork, ChildProcess } from 'child_process';
import { log } from '../native-messaging.js';
import { McpConnectionInfo, McpTool, McpResource, McpPrompt, McpToolCallResult } from './stdio-client.js';

// ===========================================================================
// Types
// ===========================================================================

export interface RunnerClientOptions {
  /** Server ID for logging and identification */
  serverId: string;
  /** Callback when the runner crashes */
  onCrash?: (error?: string) => void;
  /** Callback when the runner recovers from a crash */
  onRecover?: () => void;
}

export interface RunnerConnectOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// ===========================================================================
// Runner Client
// ===========================================================================

/**
 * Client for communicating with an isolated MCP runner process.
 */
export class McpRunnerClient {
  private runner: ChildProcess | null = null;
  private serverId: string;
  private connected: boolean = false;
  private connectionInfo: McpConnectionInfo | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private options: RunnerClientOptions;
  private cachedTools: McpTool[] = [];
  private cachedResources: McpResource[] = [];
  private cachedPrompts: McpPrompt[] = [];
  private pid: number | null = null;

  constructor(options: RunnerClientOptions) {
    this.options = options;
    this.serverId = options.serverId;
  }

  // ===========================================================================
  // Runner Lifecycle
  // ===========================================================================

  /**
   * Start the runner process.
   * This must be called before connect().
   */
  async startRunner(): Promise<void> {
    if (this.runner) {
      log(`[RunnerClient:${this.serverId}] Runner already started`);
      return;
    }

    log(`[RunnerClient:${this.serverId}] Starting runner process...`);

    // Fork using pkg-compatible approach: same script with --mcp-runner flag
    // fork(modulePath, args) - modulePath is the script to run, NOT the node executable
    const scriptPath = process.argv[1]; // e.g., /path/to/main.js
    this.runner = fork(scriptPath, ['--mcp-runner', this.serverId], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        // Prevent cascading forks
        HARBOR_CATALOG_WORKER: '0',
      },
    });

    // Handle runner messages
    this.runner.on('message', (message: { id?: string; type: string; success?: boolean; data?: unknown; error?: string; status?: string }) => {
      this.handleRunnerMessage(message);
    });

    // Handle runner stdout/stderr
    this.runner.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        log(`[RunnerClient:${this.serverId}:stdout] ${line}`);
      }
    });

    this.runner.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        log(`[RunnerClient:${this.serverId}:stderr] ${line}`);
      }
    });

    // Handle runner exit
    this.runner.on('exit', (code) => {
      log(`[RunnerClient:${this.serverId}] Runner exited with code ${code}`);
      this.runner = null;
      this.connected = false;
      this.connectionInfo = null;
      this.pid = null;

      // Reject pending requests
      const pendingEntries = Array.from(this.pendingRequests.entries());
      for (const [id, pending] of pendingEntries) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Runner exited'));
        this.pendingRequests.delete(id);
      }

      // Notify crash handler
      if (this.options.onCrash) {
        this.options.onCrash(`Runner exited with code ${code}`);
      }
    });

    this.runner.on('error', (error) => {
      log(`[RunnerClient:${this.serverId}] Runner error: ${error.message}`);
    });

    // Wait for runner to signal ready
    await this.waitForReady();
    log(`[RunnerClient:${this.serverId}] Runner started`);
  }

  /**
   * Wait for the runner to signal it's ready.
   */
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 2 minute timeout for runner startup
      // Docker + git packages need extra time for image pull + npm install
      const timeout = setTimeout(() => {
        reject(new Error('Runner startup timeout (120s) - Docker builds may need more time'));
      }, 120000);

      const messageHandler = (message: { type: string; status?: string }) => {
        if (message.type === 'status' && message.status === 'ready') {
          clearTimeout(timeout);
          this.runner?.off('message', messageHandler);
          resolve();
        }
      };

      this.runner?.on('message', messageHandler);
    });
  }

  /**
   * Stop the runner process.
   */
  async stopRunner(): Promise<void> {
    if (!this.runner) {
      return;
    }

    log(`[RunnerClient:${this.serverId}] Stopping runner...`);

    try {
      await this.sendRequest('shutdown', {});
    } catch {
      // Ignore errors, we're shutting down anyway
    }

    // Force kill if still running after timeout
    if (this.runner) {
      setTimeout(() => {
        if (this.runner) {
          this.runner.kill();
          this.runner = null;
        }
      }, 3000);
    }
  }

  /**
   * Check if the runner process is running.
   */
  isRunnerAlive(): boolean {
    return this.runner !== null;
  }

  // ===========================================================================
  // IPC Communication
  // ===========================================================================

  private sendToRunner(message: Record<string, unknown>): void {
    if (!this.runner) {
      throw new Error('Runner not started');
    }
    this.runner.send(message);
  }

  private sendRequest<T>(type: string, data: Record<string, unknown>, timeoutMs = 120000): Promise<T> {
    if (!this.runner) {
      return Promise.reject(new Error('Runner not started'));
    }

    const id = String(++this.requestIdCounter);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${type} timed out`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      this.sendToRunner({ type, id, ...data });
    });
  }

  private handleRunnerMessage(message: { id?: string; type: string; success?: boolean; data?: unknown; error?: string; status?: string }): void {
    // Handle status updates
    if (message.type === 'status') {
      if (message.status === 'crashed') {
        this.connected = false;
        this.connectionInfo = null;
        if (this.options.onCrash) {
          this.options.onCrash('Server crashed');
        }
      } else if (message.status === 'connected') {
        this.connected = true;
        if (this.options.onRecover) {
          this.options.onRecover();
        }
      } else if (message.status === 'disconnected') {
        this.connected = false;
        this.connectionInfo = null;
      }
      return;
    }

    // Handle request responses
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);

      if (message.success) {
        pending.resolve(message.data);
      } else {
        pending.reject(new Error(message.error || 'Unknown error'));
      }
    }
  }

  // ===========================================================================
  // MCP API (mirrors StdioMcpClient)
  // ===========================================================================

  /**
   * Connect to the MCP server via the runner.
   */
  async connect(options: RunnerConnectOptions): Promise<McpConnectionInfo> {
    if (!this.runner) {
      await this.startRunner();
    }

    if (this.connected && this.connectionInfo) {
      return this.connectionInfo;
    }

    const result = await this.sendRequest<{
      connectionInfo: McpConnectionInfo;
      tools: McpTool[];
      resources: McpResource[];
      prompts: McpPrompt[];
      pid: number;
    }>('connect', {
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
    });

    this.connected = true;
    this.connectionInfo = result.connectionInfo;
    this.cachedTools = result.tools;
    this.cachedResources = result.resources;
    this.cachedPrompts = result.prompts;
    this.pid = result.pid;

    return result.connectionInfo;
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (!this.runner) {
      return;
    }

    try {
      await this.sendRequest('disconnect', {});
    } catch {
      // Ignore errors
    }

    this.connected = false;
    this.connectionInfo = null;
  }

  /**
   * Check if connected to the MCP server.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get connection info.
   */
  getConnectionInfo(): McpConnectionInfo | null {
    return this.connectionInfo;
  }

  /**
   * Get cached tools (from connect).
   */
  getCachedTools(): McpTool[] {
    return this.cachedTools;
  }

  /**
   * Get cached resources (from connect).
   */
  getCachedResources(): McpResource[] {
    return this.cachedResources;
  }

  /**
   * Get cached prompts (from connect).
   */
  getCachedPrompts(): McpPrompt[] {
    return this.cachedPrompts;
  }

  /**
   * List tools from the server.
   */
  async listTools(): Promise<McpTool[]> {
    const result = await this.sendRequest<{ tools: McpTool[] }>('list_tools', {});
    this.cachedTools = result.tools;
    return result.tools;
  }

  /**
   * List resources from the server.
   */
  async listResources(): Promise<McpResource[]> {
    const result = await this.sendRequest<{ resources: McpResource[] }>('list_resources', {});
    this.cachedResources = result.resources;
    return result.resources;
  }

  /**
   * List prompts from the server.
   */
  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.sendRequest<{ prompts: McpPrompt[] }>('list_prompts', {});
    this.cachedPrompts = result.prompts;
    return result.prompts;
  }

  /**
   * Call a tool on the server.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.sendRequest<{ result: McpToolCallResult }>('call_tool', {
      toolName,
      toolArgs: args,
    });
    return result.result;
  }

  /**
   * Read a resource from the server.
   */
  async readResource(uri: string): Promise<{ content: string; mimeType?: string }> {
    const result = await this.sendRequest<{ result: { content: string; mimeType?: string } }>('read_resource', {
      uri,
    });
    return result.result;
  }

  /**
   * Get a prompt from the server.
   */
  async getPrompt(promptName: string, args?: Record<string, string>): Promise<{ description?: string; messages: Array<{ role: string; content: string }> }> {
    const result = await this.sendRequest<{ result: { description?: string; messages: Array<{ role: string; content: string }> } }>('get_prompt', {
      promptName,
      promptArgs: args,
    });
    return result.result;
  }

  /**
   * Get the PID of the server process (if known).
   */
  getPid(): number | null {
    return this.pid;
  }

  /**
   * Get stderr log from the runner.
   * Note: This returns an empty array as logs are forwarded to the main process.
   */
  getStderrLog(): string[] {
    // Logs are forwarded through the runner's stdout/stderr handlers
    return [];
  }
}

