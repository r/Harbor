# Harbor Implementation Plan

## Vision

A Firefox extension that allows users to:
1. Browse and select MCP servers from a catalog
2. Install and configure them (including authentication)
3. Run them locally
4. Interact with them through an LLM (starting with llamafile)

---

## Architecture Principles

### Flexibility Points (Architect Now, Implement Later)

| Concern | Now | Future |
|---------|-----|--------|
| **Isolation** | No isolation (spawn directly) | Docker containers |
| **LLM Provider** | llamafile only | Ollama, OpenAI, Claude API |
| **MCP Languages** | JavaScript/TypeScript only | Python, Go, Rust |
| **Auth Flows** | API tokens, password | OAuth 2.0 |

### Design Decisions

1. **Abstraction Layer for Isolation**: `ExecutionProvider` interface that can be swapped
2. **Abstraction Layer for LLM**: `LLMProvider` interface 
3. **Abstraction Layer for MCP Transport**: Use `@modelcontextprotocol/sdk` which handles stdio
4. **Auth stored per-server**: Secrets keyed by `serverId` (already implemented)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FIREFOX EXTENSION                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────┐   ┌─────────────────┐   ┌──────────────────────────┐    │
│  │   Directory   │   │  My Servers     │   │    Chat Playground       │    │
│  │   (catalog)   │   │  (installed)    │   │                          │    │
│  │               │   │                 │   │  ┌────────────────────┐  │    │
│  │ • Browse      │──►│ • Server A ✓    │──►│  │ User: "What's the  │  │    │
│  │ • Search      │   │   [Running]     │   │  │ weather in NYC?"   │  │    │
│  │ • Install     │   │                 │   │  │                    │  │    │
│  │               │   │ • Server B ○    │   │  │ [llamafile ▾]      │  │    │
│  │               │   │   [Needs Auth]  │   │  │                    │  │    │
│  │               │   │   [Configure]   │   │  │ Active Servers:    │  │    │
│  │               │   │                 │   │  │ ☑ weather-server   │  │    │
│  │               │   │ • Server C ●    │   │  │ ☐ github-server    │  │    │
│  └───────────────┘   │   [Stopped]     │   │  └────────────────────┘  │    │
│                      │   [Start]       │   │                          │    │
│                      └─────────────────┘   └──────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                         Native Messaging (JSON)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NODE.JS BRIDGE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Existing Components                            │  │
│  │  • CatalogManager (fetch servers from registry)                       │  │
│  │  • InstalledServerManager (track what's installed)                    │  │
│  │  • SecretStore (store API keys, passwords)                            │  │
│  │  • RuntimeManager (detect node/python/docker)                         │  │
│  │  • PackageRunner (spawn processes)                                    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        NEW Components                                 │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐   │  │
│  │  │ MCPClientManager│  │  LLMManager     │  │  ChatOrchestrator   │   │  │
│  │  │                 │  │                 │  │                     │   │  │
│  │  │ • Connect to    │  │ • Detect LLMs   │  │ • Agent loop        │   │  │
│  │  │   running MCP   │  │ • llamafile     │  │ • Tool execution    │   │  │
│  │  │   servers via   │  │ • (ollama)      │  │ • Message history   │   │  │
│  │  │   stdio         │  │ • (openai)      │  │                     │   │  │
│  │  │ • List tools    │  │                 │  │                     │   │  │
│  │  │ • Call tools    │  │                 │  │                     │   │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘   │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐                                                  │  │
│  │  │ExecutionProvider│  (Interface for future Docker support)          │  │
│  │  │                 │                                                  │  │
│  │  │ • NativeExec    │  ← Current: spawn directly                      │  │
│  │  │ • (DockerExec)  │  ← Future: docker run                           │  │
│  │  └─────────────────┘                                                  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
         │                              │
         │ stdio (JSON-RPC)             │ HTTP (OpenAI-compatible)
         ▼                              ▼
┌─────────────────┐            ┌─────────────────┐
│  MCP Server     │            │  llamafile      │
│  (child process)│            │  (localhost)    │
└─────────────────┘            └─────────────────┘
```

---

## Phase 1: MCP Client via stdio (Week 1)

### Goal
Connect to locally-spawned MCP servers using the official SDK over stdio.

### Tasks

#### 1.1 Add MCP SDK dependency
```bash
cd bridge-ts
npm install @modelcontextprotocol/sdk
```

#### 1.2 Create `src/mcp/stdio-client.ts`

```typescript
/**
 * MCP Client that communicates with locally spawned servers via stdio.
 * 
 * Uses @modelcontextprotocol/sdk for protocol handling.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpTool, McpResource, McpPrompt } from '../types.js';

export interface StdioMcpClientOptions {
  serverId: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ConnectedMcpServer {
  serverId: string;
  client: Client;
  transport: StdioClientTransport;
  serverInfo: {
    name?: string;
    version?: string;
  };
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

export class StdioMcpClientManager {
  private connections: Map<string, ConnectedMcpServer> = new Map();

  async connect(options: StdioMcpClientOptions): Promise<ConnectedMcpServer>;
  async disconnect(serverId: string): Promise<void>;
  async listTools(serverId: string): Promise<McpTool[]>;
  async callTool(serverId: string, toolName: string, args: object): Promise<unknown>;
  getConnection(serverId: string): ConnectedMcpServer | undefined;
  getAllConnections(): ConnectedMcpServer[];
}
```

#### 1.3 Integrate with PackageRunner

Modify `runner.ts` to return the command/args needed for the SDK transport, rather than spawning directly. The `StdioMcpClientManager` will handle spawning.

#### 1.4 New message handlers

| Message Type | Description |
|--------------|-------------|
| `mcp_connect` | Connect to a running/installed server via stdio |
| `mcp_disconnect` | Disconnect from a server |
| `mcp_list_tools` | List tools from connected server |
| `mcp_list_resources` | List resources |
| `mcp_call_tool` | Call a tool with arguments |

#### 1.5 Deliverable
- Can install an npm MCP server from catalog
- Can connect to it via stdio
- Can list its tools and call them from bridge

---

## Phase 2: Authentication Flow (Week 1-2)

### Goal
Handle servers that require API keys, passwords, or other credentials.

### Auth Types to Support

1. **API Token** - Single secret value (e.g., `OPENAI_API_KEY`)
2. **Password** - Username + password pair
3. **Header Auth** - Custom header (e.g., `Authorization: Bearer xxx`)
4. **OAuth 2.0** - (Future) Full OAuth flow with browser redirect

### Tasks

#### 2.1 Extend credential schema

Current schema in `types.ts`:
```typescript
requiredEnvVars: Array<{
  name: string;
  description?: string;
  isSecret?: boolean;
}>;
```

New schema:
```typescript
interface CredentialRequirement {
  // Unique key for this credential
  key: string;
  
  // Human-readable name
  label: string;
  
  // Description/help text
  description?: string;
  
  // Type of credential
  type: 'api_key' | 'password' | 'oauth' | 'custom';
  
  // For env var injection
  envVar?: string;
  
  // For password type
  usernameEnvVar?: string;
  
  // Is this required or optional?
  required: boolean;
  
  // Validation pattern (regex)
  pattern?: string;
  
  // Placeholder/hint
  placeholder?: string;
}
```

#### 2.2 Update SecretStore

```typescript
// secrets.ts additions

interface StoredCredential {
  key: string;
  value: string;
  type: 'api_key' | 'password' | 'oauth';
  // For password type
  username?: string;
  // When it was set
  setAt: number;
  // When it expires (for OAuth tokens)
  expiresAt?: number;
}

class SecretStore {
  // Existing methods...
  
  // New methods
  setCredential(serverId: string, credential: StoredCredential): void;
  getCredential(serverId: string, key: string): StoredCredential | undefined;
  validateCredentials(serverId: string, requirements: CredentialRequirement[]): {
    valid: boolean;
    missing: string[];
    expired: string[];
  };
}
```

#### 2.3 UI for credential entry

Extension sidebar needs:
- Form to enter API keys
- Form to enter username/password
- Validation feedback
- "Test connection" button

#### 2.4 New message handlers

| Message Type | Description |
|--------------|-------------|
| `set_credential` | Set a single credential |
| `set_credentials` | Set multiple credentials at once |
| `get_credential_status` | Check which credentials are set/missing |
| `validate_credentials` | Validate credentials meet requirements |
| `clear_credentials` | Clear credentials for a server |

#### 2.5 Deliverable
- UI shows which servers need auth
- User can enter API keys
- User can enter username/password
- Credentials are stored securely
- Server won't start until required credentials are set

---

## Phase 3: LLM Integration - llamafile (Week 2)

### Goal
Detect and communicate with llamafile to enable chat with tool calling.

### Tasks

#### 3.1 Create `src/llm/provider.ts` (interface)

```typescript
/**
 * LLM Provider abstraction.
 * 
 * Start with llamafile, but design for swappability.
 */

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  
  // Check if this provider is available
  detect(): Promise<boolean>;
  
  // Get available models
  listModels(): Promise<LLMModel[]>;
  
  // Chat completion with optional tool calling
  chat(request: ChatRequest): Promise<ChatResponse>;
  
  // Stream chat completion
  chatStream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface LLMModel {
  id: string;
  name: string;
  contextLength?: number;
  supportsTools: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // For tool role
  toolCallId?: string;
  // For assistant role with tool calls
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ChatResponse {
  message: ChatMessage;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface ChatChunk {
  delta: Partial<ChatMessage>;
  finishReason?: 'stop' | 'tool_calls' | 'length';
}
```

#### 3.2 Create `src/llm/llamafile.ts`

```typescript
/**
 * llamafile provider.
 * 
 * Assumes llamafile is running on localhost:8080 with OpenAI-compatible API.
 */

export class LlamafileProvider implements LLMProvider {
  readonly id = 'llamafile';
  readonly name = 'llamafile';
  
  private baseUrl: string;
  
  constructor(baseUrl = 'http://localhost:8080') {
    this.baseUrl = baseUrl;
  }
  
  async detect(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`);
      return response.ok;
    } catch {
      return false;
    }
  }
  
  async listModels(): Promise<LLMModel[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`);
    const data = await response.json();
    return data.data.map((m: any) => ({
      id: m.id,
      name: m.id,
      supportsTools: true, // Assume yes for now
    }));
  }
  
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model || 'default',
        messages: request.messages,
        tools: request.tools?.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      }),
    });
    
    const data = await response.json();
    const choice = data.choices[0];
    
    return {
      message: {
        role: 'assistant',
        content: choice.message.content || '',
        toolCalls: choice.message.tool_calls?.map((tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })),
      },
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
    };
  }
  
  // Streaming implementation...
}
```

#### 3.3 Create `src/llm/manager.ts`

```typescript
/**
 * LLM Manager - detects and manages LLM providers.
 */

export class LLMManager {
  private providers: Map<string, LLMProvider> = new Map();
  private activeProvider: LLMProvider | null = null;
  
  constructor() {
    // Register built-in providers
    this.registerProvider(new LlamafileProvider());
    // Future: this.registerProvider(new OllamaProvider());
  }
  
  registerProvider(provider: LLMProvider): void;
  async detectAll(): Promise<LLMProvider[]>;
  async setActive(providerId: string): Promise<void>;
  getActive(): LLMProvider | null;
  async chat(request: ChatRequest): Promise<ChatResponse>;
}
```

#### 3.4 New message handlers

| Message Type | Description |
|--------------|-------------|
| `llm_detect` | Detect available LLM providers |
| `llm_list_providers` | List all registered providers |
| `llm_set_active` | Set the active provider |
| `llm_list_models` | List models for active provider |
| `llm_chat` | Send a chat message |

#### 3.5 Deliverable
- Bridge detects if llamafile is running
- Extension shows llamafile status
- Can send chat messages to llamafile

---

## Phase 4: Chat Orchestration (Week 2-3)

### Goal
Create the agent loop that connects LLM to MCP tools.

### Tasks

#### 4.1 Create `src/chat/orchestrator.ts`

```typescript
/**
 * Chat Orchestrator - runs the agent loop.
 * 
 * 1. User sends message
 * 2. Collect tools from enabled MCP servers
 * 3. Send to LLM with tools
 * 4. If LLM calls a tool, execute it
 * 5. Feed result back to LLM
 * 6. Repeat until LLM gives final response
 */

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  enabledServers: string[];
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorEvent {
  type: 'message' | 'tool_call' | 'tool_result' | 'error' | 'done';
  data: unknown;
}

export class ChatOrchestrator {
  private sessions: Map<string, ChatSession> = new Map();
  private mcpManager: StdioMcpClientManager;
  private llmManager: LLMManager;
  
  constructor(mcpManager: StdioMcpClientManager, llmManager: LLMManager) {
    this.mcpManager = mcpManager;
    this.llmManager = llmManager;
  }
  
  createSession(enabledServers: string[]): ChatSession;
  
  async *runTurn(
    sessionId: string, 
    userMessage: string
  ): AsyncIterable<OrchestratorEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    
    // Add user message
    session.messages.push({ role: 'user', content: userMessage });
    yield { type: 'message', data: { role: 'user', content: userMessage } };
    
    // Collect tools from enabled servers
    const tools: ToolDefinition[] = [];
    const toolToServer: Map<string, string> = new Map();
    
    for (const serverId of session.enabledServers) {
      const conn = this.mcpManager.getConnection(serverId);
      if (!conn) continue;
      
      for (const tool of conn.tools) {
        tools.push({
          name: `${serverId}__${tool.name}`,
          description: tool.description || '',
          inputSchema: tool.inputSchema as object || {},
        });
        toolToServer.set(`${serverId}__${tool.name}`, serverId);
      }
    }
    
    // Agent loop
    let maxIterations = 10;
    while (maxIterations-- > 0) {
      const response = await this.llmManager.chat({
        messages: session.messages,
        tools,
      });
      
      session.messages.push(response.message);
      yield { type: 'message', data: response.message };
      
      if (response.finishReason !== 'tool_calls' || !response.message.toolCalls) {
        break; // Done
      }
      
      // Execute tool calls
      for (const toolCall of response.message.toolCalls) {
        yield { type: 'tool_call', data: toolCall };
        
        const [serverId, toolName] = toolCall.name.split('__', 2);
        
        try {
          const result = await this.mcpManager.callTool(
            serverId, 
            toolName, 
            toolCall.arguments
          );
          
          session.messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            toolCallId: toolCall.id,
          });
          
          yield { type: 'tool_result', data: { id: toolCall.id, result } };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          session.messages.push({
            role: 'tool',
            content: JSON.stringify({ error: errorMsg }),
            toolCallId: toolCall.id,
          });
          
          yield { type: 'error', data: { id: toolCall.id, error: errorMsg } };
        }
      }
    }
    
    yield { type: 'done', data: null };
  }
  
  getSession(sessionId: string): ChatSession | undefined;
  deleteSession(sessionId: string): void;
}
```

#### 4.2 New message handlers

| Message Type | Description |
|--------------|-------------|
| `chat_create_session` | Create a new chat session |
| `chat_send_message` | Send a message (starts agent loop) |
| `chat_get_session` | Get session history |
| `chat_delete_session` | Delete a session |

Note: For streaming, we may need to send multiple responses per request. Consider a streaming protocol or use request_id correlation.

#### 4.3 Deliverable
- Can create a chat session with enabled MCP servers
- LLM can call tools and get results
- Full conversation visible in UI

---

## Phase 5: Extension UI (Week 3)

### Goal
Build the browser UI for all the above functionality.

### Tasks

#### 5.1 Directory Tab (exists, enhance)
- Show runtime compatibility (can we run npm servers?)
- Show auth requirements before install
- Better install flow

#### 5.2 My Servers Tab (new)
- List installed servers
- Status: Running / Stopped / Needs Auth
- Configure credentials button
- Start/Stop buttons
- Logs viewer

#### 5.3 Chat Tab (new)
- LLM provider selector (just llamafile for now)
- Server picker (which MCP servers to enable)
- Chat interface
- Tool call visualization
- Streaming responses

#### 5.4 Settings Tab (new)
- LLM provider configuration
- llamafile URL (default localhost:8080)
- Future: Ollama URL, API keys for cloud providers

---

## File Structure (Final)

```
bridge-ts/src/
├── main.ts
├── native-messaging.ts
├── handlers.ts                    # Add new handlers
├── types.ts                       # Add new types
├── server-store.ts
│
├── catalog/                       # Existing
│   ├── index.ts
│   ├── manager.ts
│   ├── database.ts
│   ├── schema.ts
│   ├── base.ts
│   ├── official-registry.ts
│   └── github-awesome.ts
│
├── installer/                     # Existing (modify)
│   ├── index.ts
│   ├── manager.ts
│   ├── runner.ts                  # Modify for SDK integration
│   ├── runtime.ts
│   └── secrets.ts                 # Enhance for credential types
│
├── mcp/                           # NEW
│   ├── index.ts
│   ├── stdio-client.ts           # MCP SDK wrapper
│   └── manager.ts                # Manage multiple connections
│
├── llm/                           # NEW
│   ├── index.ts
│   ├── provider.ts               # Interface
│   ├── llamafile.ts              # llamafile implementation
│   └── manager.ts                # Provider management
│
└── chat/                          # NEW
    ├── index.ts
    ├── orchestrator.ts           # Agent loop
    └── session.ts                # Session management
```

---

## Message Protocol Additions

### Phase 1: MCP Client
```
mcp_connect         { server_id }                     → { connection_info }
mcp_disconnect      { server_id }                     → { success }
mcp_list_tools      { server_id }                     → { tools[] }
mcp_call_tool       { server_id, tool_name, args }    → { result }
```

### Phase 2: Authentication
```
set_credential      { server_id, key, value, type }   → { success }
get_credential_status { server_id }                   → { credentials[] }
validate_credentials  { server_id }                   → { valid, missing[] }
```

### Phase 3: LLM
```
llm_detect          {}                                → { providers[] }
llm_set_active      { provider_id }                   → { success }
llm_list_models     {}                                → { models[] }
```

### Phase 4: Chat
```
chat_create_session { enabled_servers[] }             → { session_id }
chat_send_message   { session_id, content }           → { events[] }
chat_get_session    { session_id }                    → { messages[] }
```

---

## Dependencies to Add

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

---

## Testing Strategy

### Unit Tests
- `StdioMcpClientManager` with mock transport
- `LlamafileProvider` with mock HTTP
- `ChatOrchestrator` with mock MCP and LLM

### Integration Tests
- Full flow with a simple test MCP server (e.g., `@modelcontextprotocol/server-memory`)
- Full flow with llamafile running locally

### Manual Testing
1. Install a server from catalog
2. Set its API key
3. Start it
4. Chat with it via llamafile

---

## Timeline

| Week | Phase | Deliverable |
|------|-------|-------------|
| 1 | Phase 1 | MCP stdio client working |
| 1-2 | Phase 2 | Auth flow complete |
| 2 | Phase 3 | llamafile integration |
| 2-3 | Phase 4 | Agent loop working |
| 3 | Phase 5 | UI complete |

---

## Future Enhancements (Not in Scope)

1. **Docker Isolation** - Add `DockerExecutionProvider`
2. **OAuth Flow** - Browser popup for OAuth redirect
3. **Python MCP Servers** - Use uvx/pipx
4. **Ollama Provider** - Similar to llamafile
5. **Cloud LLM Providers** - OpenAI, Anthropic, etc.
6. **Multi-model Routing** - Different models for different tasks
7. **Conversation Persistence** - Save/load chat sessions
8. **MCP Server Marketplace** - Ratings, reviews, verification



