/**
 * MCP Client module - manages connections to MCP servers.
 * 
 * Supports:
 * - Local servers via stdio (npm, pypi, binary)
 * - Remote servers via HTTP/SSE
 */

export { StdioMcpClient, type McpConnectionInfo } from './stdio-client.js';
export { HttpMcpClient } from './http-client.js';
export { McpClientManager, getMcpClientManager, type ConnectedServer } from './manager.js';
