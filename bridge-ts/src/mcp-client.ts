/**
 * MCP Client - connects to MCP servers via SSE/HTTP.
 * 
 * Implements the MCP protocol for remote server connections.
 */

import { log } from './native-messaging.js';
import { 
  McpConnectionResult, 
  McpTool, 
  McpResource, 
  McpPrompt,
  McpToolResult 
} from './types.js';

interface McpSession {
  baseUrl: string;
  sessionId?: string;
  serverInfo?: {
    name?: string;
    version?: string;
    protocolVersion?: string;
  };
  tools?: McpTool[];
  resources?: McpResource[];
  prompts?: McpPrompt[];
}

export class McpClient {
  private sessions: Map<string, McpSession> = new Map();

  /**
   * Connect to an MCP server.
   */
  async connect(baseUrl: string): Promise<McpConnectionResult> {
    log(`[McpClient] Connecting to ${baseUrl}`);

    try {
      // Normalize URL
      const url = new URL(baseUrl);
      const sseUrl = new URL('/sse', url);
      
      // Try to establish SSE connection by making initial request
      const response = await fetch(sseUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
        },
      });

      if (!response.ok) {
        return {
          success: false,
          message: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      // For now, we just verify the endpoint is reachable
      // Full SSE handling would require streaming the response
      const session: McpSession = {
        baseUrl,
        serverInfo: {
          name: 'MCP Server',
          version: 'unknown',
          protocolVersion: '2024-11-05',
        },
      };

      this.sessions.set(baseUrl, session);

      log(`[McpClient] Connected to ${baseUrl}`);
      return {
        success: true,
        message: 'Connected',
        serverInfo: session.serverInfo,
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[McpClient] Connection failed: ${message}`);
      return {
        success: false,
        message: `Connection failed: ${message}`,
      };
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(baseUrl: string): Promise<void> {
    log(`[McpClient] Disconnecting from ${baseUrl}`);
    this.sessions.delete(baseUrl);
  }

  /**
   * Check if connected to a server.
   */
  isConnected(baseUrl: string): boolean {
    return this.sessions.has(baseUrl);
  }

  /**
   * List tools from a connected server.
   */
  async listTools(baseUrl: string): Promise<McpTool[]> {
    const session = this.sessions.get(baseUrl);
    if (!session) {
      throw new Error(`Not connected to ${baseUrl}`);
    }

    // If we already have tools cached, return them
    if (session.tools) {
      return session.tools;
    }

    try {
      const url = new URL('/mcp/v1/tools/list', baseUrl);
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as { result?: { tools?: McpTool[] } };
      session.tools = data.result?.tools || [];
      return session.tools;

    } catch (error) {
      log(`[McpClient] Failed to list tools: ${error}`);
      // Return empty array on error - server may not support this
      return [];
    }
  }

  /**
   * List resources from a connected server.
   */
  async listResources(baseUrl: string): Promise<McpResource[]> {
    const session = this.sessions.get(baseUrl);
    if (!session) {
      throw new Error(`Not connected to ${baseUrl}`);
    }

    if (session.resources) {
      return session.resources;
    }

    try {
      const url = new URL('/mcp/v1/resources/list', baseUrl);
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'resources/list', id: 1 }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as { result?: { resources?: McpResource[] } };
      session.resources = data.result?.resources || [];
      return session.resources;

    } catch (error) {
      log(`[McpClient] Failed to list resources: ${error}`);
      return [];
    }
  }

  /**
   * List prompts from a connected server.
   */
  async listPrompts(baseUrl: string): Promise<McpPrompt[]> {
    const session = this.sessions.get(baseUrl);
    if (!session) {
      throw new Error(`Not connected to ${baseUrl}`);
    }

    if (session.prompts) {
      return session.prompts;
    }

    try {
      const url = new URL('/mcp/v1/prompts/list', baseUrl);
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'prompts/list', id: 1 }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as { result?: { prompts?: McpPrompt[] } };
      session.prompts = data.result?.prompts || [];
      return session.prompts;

    } catch (error) {
      log(`[McpClient] Failed to list prompts: ${error}`);
      return [];
    }
  }

  /**
   * Call a tool on a connected server.
   */
  async callTool(
    baseUrl: string, 
    toolName: string, 
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const session = this.sessions.get(baseUrl);
    if (!session) {
      return { success: false, error: `Not connected to ${baseUrl}` };
    }

    try {
      const url = new URL('/mcp/v1/tools/call', baseUrl);
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: Date.now(),
          params: {
            name: toolName,
            arguments: args,
          },
        }),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as { 
        result?: { content?: unknown };
        error?: { message?: string };
      };
      
      if (data.error) {
        return { success: false, error: data.error.message || 'Tool call failed' };
      }

      return { success: true, content: data.result?.content };

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }
}

// Singleton
let _client: McpClient | null = null;

export function getMcpClient(): McpClient {
  if (!_client) {
    _client = new McpClient();
  }
  return _client;
}





