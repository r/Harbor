import type { McpNotification, McpRequest, McpResponse } from './protocol';

export interface McpTransport {
  send(request: McpRequest): Promise<McpResponse>;
  /** Send a one-way message (e.g. `notifications/initialized`). Not every transport needs one. */
  notify?(notification: McpNotification): Promise<void>;
  /** Tear the connection down. Not every transport holds one open. */
  disconnect?(): void | Promise<void>;
}

export class UnwiredTransport implements McpTransport {
  async send(request: McpRequest): Promise<McpResponse> {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32000,
        message: 'WASM transport not wired',
      },
    };
  }
}
