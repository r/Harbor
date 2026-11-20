export type McpRequest = {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
};

export type McpError = {
  code: number;
  message: string;
};

export type McpResponse = {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: McpError;
};

/** A one-way JSON-RPC message, e.g. `notifications/initialized`. No `id`, no response expected. */
export type McpNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type ToolCallParams = {
  name: string;
  arguments: Record<string, unknown>;
};
