/**
 * MCP Client that communicates with locally spawned servers via stdio.
 * 
 * Uses @modelcontextprotocol/sdk for protocol handling.
 * This wraps the SDK's Client and StdioClientTransport for our use case.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log } from '../native-messaging.js';

export interface McpConnectionInfo {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpToolCallResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface StdioMcpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Wrapper around the MCP SDK's Client for stdio-based communication.
 * 
 * Handles:
 * - Spawning the MCP server process
 * - Protocol initialization
 * - Tool/resource/prompt discovery
 * - Tool execution
 */
export class StdioMcpClient {
  private client: Client;
  private transport: StdioClientTransport;
  private connected: boolean = false;
  private connectionInfo: McpConnectionInfo | null = null;
  private stderrBuffer: string[] = [];

  constructor(private options: StdioMcpClientOptions) {
    // Create the client
    this.client = new Client(
      { name: 'harbor-bridge', version: '0.1.0' },
      { capabilities: {} }
    );

    // Merge environment: default safe vars + custom env
    const env = {
      ...getDefaultEnvironment(),
      ...options.env,
    };

    // Create the transport
    this.transport = new StdioClientTransport({
      command: options.command,
      args: options.args,
      env,
      cwd: options.cwd,
      stderr: 'pipe', // Capture stderr for logging
    });

    // Capture stderr output
    const stderr = this.transport.stderr;
    if (stderr) {
      stderr.on('data', (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          this.stderrBuffer.push(line);
          // Keep buffer size reasonable
          if (this.stderrBuffer.length > 100) {
            this.stderrBuffer = this.stderrBuffer.slice(-50);
          }
          log(`[MCP stderr] ${line}`);
        }
      });
    }
  }

  /**
   * Connect to the MCP server.
   * This spawns the process and performs the MCP initialization handshake.
   */
  async connect(): Promise<McpConnectionInfo> {
    if (this.connected) {
      if (this.connectionInfo) {
        return this.connectionInfo;
      }
      throw new Error('Already connected but no connection info available');
    }

    try {
      log(`[StdioMcpClient] Connecting to: ${this.options.command} ${this.options.args?.join(' ') || ''}`);
      
      // Connect the client to the transport
      await this.client.connect(this.transport);
      
      this.connected = true;

      // Get server info
      const serverVersion = this.client.getServerVersion();
      const serverCapabilities = this.client.getServerCapabilities();

      this.connectionInfo = {
        serverName: serverVersion?.name || 'unknown',
        serverVersion: serverVersion?.version || 'unknown',
        protocolVersion: '2024-11-05', // Current MCP protocol version
        capabilities: {
          tools: !!serverCapabilities?.tools,
          resources: !!serverCapabilities?.resources,
          prompts: !!serverCapabilities?.prompts,
        },
      };

      log(`[StdioMcpClient] Connected to ${this.connectionInfo.serverName} v${this.connectionInfo.serverVersion}`);
      log(`[StdioMcpClient] Capabilities: tools=${this.connectionInfo.capabilities.tools}, resources=${this.connectionInfo.capabilities.resources}, prompts=${this.connectionInfo.capabilities.prompts}`);

      return this.connectionInfo;
    } catch (error) {
      this.connected = false;
      const message = error instanceof Error ? error.message : String(error);
      log(`[StdioMcpClient] Connection failed: ${message}`);
      throw new Error(`Failed to connect to MCP server: ${message}`);
    }
  }

  /**
   * Disconnect from the MCP server.
   * This closes the transport and terminates the child process.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      log('[StdioMcpClient] Disconnecting...');
      await this.client.close();
      await this.transport.close();
      this.connected = false;
      this.connectionInfo = null;
      log('[StdioMcpClient] Disconnected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[StdioMcpClient] Disconnect error: ${message}`);
      // Force state to disconnected even on error
      this.connected = false;
      this.connectionInfo = null;
    }
  }

  /**
   * Check if connected to the server.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get connection info if connected.
   */
  getConnectionInfo(): McpConnectionInfo | null {
    return this.connectionInfo;
  }

  /**
   * Get recent stderr output from the server process.
   */
  getStderrLog(): string[] {
    return [...this.stderrBuffer];
  }

  /**
   * Get the process ID of the spawned server.
   */
  getPid(): number | null {
    return this.transport.pid;
  }

  /**
   * List available tools from the server.
   */
  async listTools(): Promise<McpTool[]> {
    this.assertConnected();

    try {
      const result = await this.client.listTools();
      return result.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[StdioMcpClient] listTools failed: ${message}`);
      throw new Error(`Failed to list tools: ${message}`);
    }
  }

  /**
   * List available resources from the server.
   */
  async listResources(): Promise<McpResource[]> {
    this.assertConnected();

    try {
      const result = await this.client.listResources();
      return result.resources.map(resource => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[StdioMcpClient] listResources failed: ${message}`);
      throw new Error(`Failed to list resources: ${message}`);
    }
  }

  /**
   * List available prompts from the server.
   */
  async listPrompts(): Promise<McpPrompt[]> {
    this.assertConnected();

    try {
      const result = await this.client.listPrompts();
      return result.prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map(arg => ({
          name: arg.name,
          description: arg.description,
          required: arg.required,
        })),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[StdioMcpClient] listPrompts failed: ${message}`);
      throw new Error(`Failed to list prompts: ${message}`);
    }
  }

  /**
   * Call a tool on the server.
   * 
   * Note: Some MCP servers (like server-memory) have schema validation issues
   * where the server's output doesn't match its declared schema. We catch
   * these errors and try to extract useful data anyway.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    this.assertConnected();

    try {
      log(`[StdioMcpClient] Calling tool: ${toolName}`);
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      });

      return this.parseToolResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      
      // Check if this is a schema validation error from the SDK
      // These often contain the actual data in the error, we can try to extract it
      if (message.includes('Structured content does not match') || 
          message.includes('must NOT have additional properties')) {
        log(`[StdioMcpClient] Schema validation error, attempting workaround...`);
        
        // Try calling with raw request to bypass validation
        try {
          const rawResult = await this.callToolRaw(toolName, args);
          if (rawResult) {
            return rawResult;
          }
        } catch (rawError) {
          log(`[StdioMcpClient] Raw call also failed: ${rawError}`);
        }
      }
      
      log(`[StdioMcpClient] callTool failed: ${message}`);
      throw new Error(`Failed to call tool ${toolName}: ${message}`);
    }
  }

  /**
   * Parse tool result from various formats.
   */
  private parseToolResult(result: unknown): McpToolCallResult {
    const r = result as Record<string, unknown>;
    
    // Handle both old and new result formats
    if ('content' in r && Array.isArray(r.content)) {
      return {
        content: (r.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>).map(c => ({
          type: c.type,
          text: c.text,
          data: c.data,
          mimeType: c.mimeType,
        })),
        isError: 'isError' in r ? Boolean(r.isError) : undefined,
      };
    } else if ('toolResult' in r) {
      // Legacy format
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(r.toolResult),
        }],
      };
    }

    // Fallback
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result),
      }],
    };
  }

  /**
   * Call a tool using raw JSON-RPC, bypassing SDK validation.
   * This is a workaround for servers with schema validation issues.
   */
  private async callToolRaw(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult | null> {
    // Access the transport's underlying process to send raw JSON-RPC
    // This is a hack but necessary for servers with broken schemas
    try {
      // Use the client's request method which might bypass some validation
      const result = await (this.client as unknown as { 
        request: (req: { method: string; params: unknown }) => Promise<unknown> 
      }).request({
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      });

      log(`[StdioMcpClient] Raw call succeeded`);
      return this.parseToolResult(result);
    } catch (e) {
      log(`[StdioMcpClient] Raw call failed: ${e}`);
      return null;
    }
  }

  /**
   * Read a resource from the server.
   */
  async readResource(uri: string): Promise<{ content: string; mimeType?: string }> {
    this.assertConnected();

    try {
      const result = await this.client.readResource({ uri });
      const content = result.contents[0];
      
      if ('text' in content) {
        return {
          content: content.text,
          mimeType: content.mimeType,
        };
      } else if ('blob' in content) {
        return {
          content: content.blob, // Base64 encoded
          mimeType: content.mimeType,
        };
      }

      throw new Error('Unexpected resource content format');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[StdioMcpClient] readResource failed: ${message}`);
      throw new Error(`Failed to read resource ${uri}: ${message}`);
    }
  }

  /**
   * Get a prompt from the server.
   */
  async getPrompt(
    promptName: string,
    args?: Record<string, string>
  ): Promise<{ description?: string; messages: Array<{ role: string; content: string }> }> {
    this.assertConnected();

    try {
      const result = await this.client.getPrompt({
        name: promptName,
        arguments: args,
      });

      return {
        description: result.description,
        messages: result.messages.map(msg => ({
          role: msg.role,
          content: typeof msg.content === 'string' 
            ? msg.content 
            : 'text' in msg.content 
              ? msg.content.text 
              : JSON.stringify(msg.content),
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[StdioMcpClient] getPrompt failed: ${message}`);
      throw new Error(`Failed to get prompt ${promptName}: ${message}`);
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }
  }
}

