/**
 * TypeScript declarations for the Web Agent API (window.ai and window.agent).
 * Generated from Harbor's spec/testing harness; matches the real API surface.
 */

type PermissionScope =
  | 'model:prompt'
  | 'model:tools'
  | 'mcp:tools.list'
  | 'mcp:tools.call'
  | 'browser:activeTab.read'
  | 'browser:activeTab.interact'
  | 'browser:tabs.read'
  | 'browser:tabs.create'
  | 'web:fetch';

type PermissionGrant = 'granted-once' | 'granted-always' | 'denied' | 'not-granted';

interface PermissionGrantResult {
  granted: boolean;
  scopes: Record<string, PermissionGrant>;
}

interface PermissionStatus {
  origin: string;
  scopes: Record<string, PermissionGrant>;
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId?: string;
}

interface TextSessionOptions {
  model?: string;
  temperature?: number;
  top_p?: number;
  systemPrompt?: string;
  provider?: string;
}

interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;
  error?: ApiError;
}

interface TextSession {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
}

interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

interface AgentRunOptions {
  task: string;
  tools?: string[];
  useAllTools?: boolean;
  maxToolCalls?: number;
  signal?: AbortSignal;
  provider?: string;
  systemPrompt?: string;
}

type RunEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown; error?: ApiError }
  | { type: 'token'; token: string }
  | { type: 'final'; output: string; citations?: unknown[] }
  | { type: 'error'; error: ApiError };

declare global {
  interface Window {
    ai: {
      createTextSession(options?: TextSessionOptions): Promise<TextSession>;
      canCreateTextSession?(): Promise<'readily' | 'after-download' | 'no'>;
      providers?: { list(): Promise<unknown[]>; getActive(): Promise<{ provider?: string; model?: string }> };
    };
    agent: {
      requestPermissions(options: {
        scopes: PermissionScope[];
        reason?: string;
        tools?: string[];
      }): Promise<PermissionGrantResult>;
      permissions: { list(): Promise<PermissionStatus> };
      tools: {
        list(): Promise<ToolDescriptor[]>;
        call(options: { tool: string; args: Record<string, unknown> }): Promise<unknown>;
      };
      run(options: AgentRunOptions): AsyncIterable<RunEvent>;
      browser?: unknown;
      sessions?: unknown;
      agents?: unknown;
      mcp?: unknown;
      chat?: unknown;
    };
  }
}

export {};
