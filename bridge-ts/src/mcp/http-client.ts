/**
 * MCP Client that communicates with remote servers via HTTP/SSE.
 * 
 * Uses @modelcontextprotocol/sdk for protocol handling.
 * This wraps the SDK's Client and StreamableHTTPClientTransport for remote MCP servers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { log } from '../native-messaging.js';
import type { 
  McpConnectionInfo, 
  McpTool, 
  McpResource, 
  McpPrompt, 
  McpToolCallResult 
} from './stdio-client.js';

export interface HttpMcpClientOptions {
  url: string;
  headers?: Record<string, string>;
  sessionId?: string;
}

/**
 * Wrapper around the MCP SDK's Client for HTTP-based communication.
 * 
 * Supports both StreamableHTTP (newer) and SSE (older) transports,
 * with automatic fallback.
 */
export class HttpMcpClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private connected: boolean = false;
  private connectionInfo: McpConnectionInfo | null = null;

  constructor(private options: HttpMcpClientOptions) {
    // Create the client
    this.client = new Client({
      name: 'harbor-mcp-client',
      version: '1.0.0',
    }, {
      capabilities: {
        // We support receiving tool calls but not implementing them
        // (we're a client, not a server)
      },
    });
  }

  /**
   * Connect to the remote MCP server.
   * Tries StreamableHTTP first, falls back to SSE if needed.
   */
  async connect(): Promise<McpConnectionInfo> {
    const url = new URL(this.options.url);
    
    log(`[HttpMcpClient] Connecting to: ${url.toString()}`);

    // Build request init with custom headers
    const requestInit: RequestInit = {};
    if (this.options.headers) {
      requestInit.headers = this.options.headers;
    }

    // Try StreamableHTTP first (modern MCP servers)
    try {
      this.transport = new StreamableHTTPClientTransport(url, {
        requestInit,
        sessionId: this.options.sessionId,
      });

      await this.client.connect(this.transport);
      this.connected = true;

      const serverInfo = this.client.getServerVersion();
      const capabilities = this.client.getServerCapabilities();

      this.connectionInfo = {
        serverName: serverInfo?.name ?? 'Unknown',
        serverVersion: serverInfo?.version ?? 'Unknown',
        protocolVersion: 'unknown',
        capabilities: {
          tools: !!capabilities?.tools,
          resources: !!capabilities?.resources,
          prompts: !!capabilities?.prompts,
        },
      };

      log(`[HttpMcpClient] Connected via StreamableHTTP: ${this.connectionInfo.serverName} v${this.connectionInfo.serverVersion}`);
      return this.connectionInfo;

    } catch (streamableError) {
      log(`[HttpMcpClient] StreamableHTTP failed, trying SSE fallback: ${streamableError}`);
      
      // Fall back to SSE transport
      try {
        // Reset client for new connection attempt
        this.client = new Client({
          name: 'harbor-mcp-client',
          version: '1.0.0',
        }, {
          capabilities: {},
        });

        this.transport = new SSEClientTransport(url, {
          requestInit,
        });

        await this.client.connect(this.transport);
        this.connected = true;

        const serverInfo = this.client.getServerVersion();
        const capabilities = this.client.getServerCapabilities();

        this.connectionInfo = {
          serverName: serverInfo?.name ?? 'Unknown',
          serverVersion: serverInfo?.version ?? 'Unknown',
          protocolVersion: 'unknown',
          capabilities: {
            tools: !!capabilities?.tools,
            resources: !!capabilities?.resources,
            prompts: !!capabilities?.prompts,
          },
        };

        log(`[HttpMcpClient] Connected via SSE: ${this.connectionInfo.serverName} v${this.connectionInfo.serverVersion}`);
        return this.connectionInfo;

      } catch (sseError) {
        log(`[HttpMcpClient] SSE also failed: ${sseError}`);
        throw new Error(`Failed to connect to MCP server at ${url}: ${sseError}`);
      }
    }
  }

  /**
   * Disconnect from the server.
   */
  async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (e) {
        log(`[HttpMcpClient] Error closing transport: ${e}`);
      }
    }
    this.connected = false;
    this.connectionInfo = null;
    log('[HttpMcpClient] Disconnected');
  }

  /**
   * Check if connected.
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
   * List available tools.
   */
  async listTools(): Promise<McpTool[]> {
    this.assertConnected();
    
    const result = await this.client.listTools();
    return result.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  /**
   * List available resources.
   */
  async listResources(): Promise<McpResource[]> {
    this.assertConnected();
    
    const result = await this.client.listResources();
    return result.resources.map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /**
   * List available prompts.
   */
  async listPrompts(): Promise<McpPrompt[]> {
    this.assertConnected();
    
    const result = await this.client.listPrompts();
    return result.prompts.map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments?.map(a => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    }));
  }

  /**
   * Call a tool.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    this.assertConnected();
    
    log(`[HttpMcpClient] Calling tool: ${name}`);
    const result = await this.client.callTool({ name, arguments: args });
    
    // Type guard for content array
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; blob?: string; mimeType?: string } }>;
    
    return {
      content: content.map(c => {
        if (c.type === 'text') {
          return { type: 'text', text: c.text };
        } else if (c.type === 'image') {
          return { type: 'image', data: c.data, mimeType: c.mimeType };
        } else if (c.type === 'resource' && c.resource) {
          // Handle embedded resource
          const resource = c.resource;
          if (resource.text) {
            return { type: 'text', text: resource.text };
          } else if (resource.blob) {
            return { type: 'image', data: resource.blob, mimeType: resource.mimeType };
          }
          return { type: 'unknown' };
        }
        return { type: 'unknown' };
      }),
      isError: result.isError === true,
    };
  }

  /**
   * Read a resource.
   */
  async readResource(uri: string): Promise<{ content: string; mimeType?: string }> {
    this.assertConnected();
    
    log(`[HttpMcpClient] Reading resource: ${uri}`);
    const result = await this.client.readResource({ uri });
    
    // Get first content item
    const content = result.contents[0];
    if (!content) {
      throw new Error('No content returned');
    }

    if ('text' in content) {
      return { content: content.text, mimeType: content.mimeType };
    } else if ('blob' in content) {
      return { content: content.blob, mimeType: content.mimeType };
    }
    
    throw new Error('Unsupported content type');
  }

  /**
   * Get a prompt.
   */
  async getPrompt(
    name: string, 
    args?: Record<string, string>
  ): Promise<{ description?: string; messages: Array<{ role: string; content: string }> }> {
    this.assertConnected();
    
    log(`[HttpMcpClient] Getting prompt: ${name}`);
    const result = await this.client.getPrompt({ name, arguments: args });
    
    return {
      description: result.description,
      messages: result.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' 
          ? m.content 
          : Array.isArray(m.content) 
            ? (m.content as Array<{ type: string; text?: string }>).map(c => c.type === 'text' ? (c.text || '') : '').join('')
            : '',
      })),
    };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }
  }
}

