/**
 * TypeScript declarations for the Web Agent API (window.ai and window.agent).
 * Generated from Harbor's spec/testing harness; matches the real API surface.
 */

type PermissionScope =
  | 'model:prompt'
  | 'model:tools'
  | 'model:list'
  | 'mcp:tools.list'
  | 'mcp:tools.call'
  | 'mcp:servers.register'
  | 'browser:activeTab.read'
  | 'browser:activeTab.interact'
  | 'browser:activeTab.screenshot'
  | 'browser:tabs.create'
  | 'browser:tabs.read'
  | 'browser:navigate'
  | 'web:fetch'
  | 'chat:open'
  | 'agents:register'
  | 'agents:discover'
  | 'agents:invoke'
  | 'agents:message'
  | 'agents:crossOrigin';

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

interface TextSession {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
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

// Multi-agent types, as in extension/src/page-api/injected.ts.

interface AgentRegisterOptions {
  name: string;
  description?: string;
  capabilities?: string[];
  tags?: string[];
  acceptsInvocations?: boolean;
  acceptsMessages?: boolean;
}

interface RegisteredAgent {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  tags: string[];
  status: 'active' | 'suspended' | 'terminated';
  origin: string;
  acceptsInvocations: boolean;
  acceptsMessages: boolean;
  registeredAt: number;
  lastActiveAt: number;
}

interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  tags: string[];
  status: 'active' | 'suspended' | 'terminated';
  sameOrigin: boolean;
  isRemote: boolean;
}

/** Basic identity and lifecycle state of an agent on the calling origin. */
type AgentListEntry = Pick<AgentSummary, 'id' | 'name' | 'status'>;

interface AgentDiscoveryQuery {
  name?: string;
  capabilities?: string[];
  tags?: string[];
  includeSameOrigin?: boolean;
  includeCrossOrigin?: boolean;
}

interface AgentInvocationRequest {
  task: string;
  input?: unknown;
  timeout?: number;
}

/** Which site's agent produced an answer. Harbor sets it, never the agent. */
interface AgentProvenance {
  source: 'agent';
  origin: string;
  agentId: string;
}

interface AgentInvocationResponse {
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  executionTime?: number;
  /** Absent when Harbor answered instead of the agent (not found, refused, timed out). */
  provenance?: AgentProvenance;
}

interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: 'request' | 'response' | 'event' | 'error';
  payload: unknown;
  correlationId?: string;
  timestamp: number;
  provenance?: AgentProvenance;
}

interface PipelineStep {
  agentId: string;
  task: string;
  inputTransform?: string;
  outputTransform?: string;
}

interface ParallelTask {
  agentId: string;
  task: string;
  input?: unknown;
}

interface AgentEvent {
  type: string;
  data: unknown;
  source: string;
  provenance?: AgentProvenance;
}

/** `window.agent.agents`. Needs Harbor's multiAgent feature; otherwise every call fails with ERR_FEATURE_DISABLED. */
interface AgentsApi {
  register(options: AgentRegisterOptions): Promise<RegisteredAgent>;
  unregister(agentId?: string): Promise<void>;
  getInfo(agentId: string): Promise<RegisteredAgent | null>;
  discover(query?: AgentDiscoveryQuery): Promise<{ agents: AgentSummary[]; total: number }>;
  list(): Promise<AgentListEntry[]>;
  invoke(agentId: string, request: AgentInvocationRequest): Promise<AgentInvocationResponse>;
  send(agentId: string, payload: unknown): Promise<{ delivered: boolean }>;
  onMessage(handler: (message: AgentMessage) => void): () => void;
  onInvoke(handler: (request: AgentInvocationRequest & { from: string }) => Promise<unknown>): () => void;
  subscribe(eventType: string, handler: (event: AgentEvent) => void): Promise<void>;
  unsubscribe(eventType: string, handler?: (event: AgentEvent) => void): Promise<void>;
  /** Always fails in Harbor today. */
  broadcast(eventType: string, data: unknown): Promise<{ delivered: number }>;
  orchestrate: {
    pipeline(
      config: { steps: PipelineStep[] },
      initialInput: unknown,
    ): Promise<{ success: boolean; result: unknown; stepResults: unknown[] }>;
    parallel(
      config: { tasks: ParallelTask[]; combineStrategy?: 'array' | 'merge' | 'first' },
    ): Promise<{ success: boolean; results: unknown[]; combined: unknown }>;
    route(
      config: { routes: Array<{ condition: string; agentId: string }>; defaultAgentId?: string },
      input: unknown,
      task: string,
    ): Promise<AgentInvocationResponse>;
  };
}

/** One typed action in agent.requestCapabilities(). */
interface CapabilityRequest {
  action: string;
  server?: string;
  toolNames?: string[];
}

interface SessionCapabilities {
  llm: { allowed: boolean; provider?: string; model?: string };
  tools: { allowed: boolean; allowedTools: string[] };
  browser: { readActiveTab: boolean; interact: boolean; screenshot: boolean };
  limits?: { maxToolCalls?: number; expiresAt?: number };
}

interface AgentSession {
  readonly sessionId: string;
  readonly capabilities: SessionCapabilities;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
  callTool(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  listAllowedTools(): string[];
  terminate(): Promise<void>;
}

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
        /** Required with agents:crossOrigin: the sites whose agents to reach. */
        agentOrigins?: string[];
      }): Promise<PermissionGrantResult>;
      /**
       * Make a session from grants the site already holds. An optional
       * capability it hasn't been granted is left out; a required one it
       * lacks fails the request with ERR_PERMISSION_DENIED. Doesn't prompt.
       */
      requestCapabilities(options: {
        require: CapabilityRequest[];
        optional?: CapabilityRequest[];
        budget?: { maxToolCalls?: number; ttlMinutes?: number };
        name?: string;
        reason?: string;
      }): Promise<AgentSession>;
      permissions: { list(): Promise<PermissionStatus> };
      tools: {
        list(): Promise<ToolDescriptor[]>;
        call(options: { tool: string; args: Record<string, unknown> }): Promise<unknown>;
      };
      run(options: AgentRunOptions): AsyncIterable<RunEvent>;
      browser?: unknown;
      sessions?: unknown;
      agents: AgentsApi;
      mcp?: unknown;
      chat?: unknown;
    };
  }
}

export {};
