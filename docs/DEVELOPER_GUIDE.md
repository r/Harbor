# Harbor Developer Guide

**Harbor** is a Firefox browser extension with a native TypeScript/Node.js bridge that enables web applications to securely access AI models and MCP (Model Context Protocol) tools through a capability-based permission system.

> **Related Documentation:**
> - [LLMS.txt](./LLMS.txt) - Token-efficient version for AI coding assistants
> - [JS AI Provider API](./JS_AI_PROVIDER_API.md) - Detailed `window.ai` and `window.agent` reference
> - [MCP Host](./MCP_HOST.md) - MCP execution environment internals

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Getting Started](#getting-started)
3. [Web Page APIs](#web-page-apis)
   - [window.ai API](#windowai-api)
   - [window.agent API](#windowagent-api)
4. [Permission System](#permission-system)
5. [Bridge Protocol](#bridge-protocol)
6. [MCP Host](#mcp-host)
7. [Catalog System](#catalog-system)
8. [LLM Integration](#llm-integration)
9. [Chat Orchestration](#chat-orchestration)
10. [Installer (App Store)](#installer-app-store)
11. [Error Handling](#error-handling)
12. [TypeScript Definitions](#typescript-definitions)

---

## Architecture Overview

Harbor consists of three main components:

```
┌─────────────────────────┐   postMessage    ┌──────────────────────────┐
│      Web Page           │ ◄───────────────► │  Content Script          │
│  window.ai / agent      │                   │  (provider bridge)       │
└─────────────────────────┘                   └───────────┬──────────────┘
                                                          │ chrome.runtime
                                                          ▼
┌─────────────────────────┐   Native Msg    ┌──────────────────────────┐
│    Firefox Extension    │ ◄─────────────► │    Node.js Bridge        │
│    (background.ts)      │   (stdio JSON)  │    (bridge-ts)           │
└─────────────────────────┘                   └───────────┬──────────────┘
                                                          │ MCP Protocol
                                                          ▼
                                              ┌──────────────────────────┐
                                              │     MCP Servers          │
                                              │  (stdio, HTTP, Docker)   │
                                              └──────────────────────────┘
```

### Data Flow

1. **Web Page** → Calls `window.ai` or `window.agent` APIs
2. **Content Script** → Validates permissions, routes to background
3. **Background Script** → Sends native message to bridge
4. **Node.js Bridge** → Executes via MCP clients or LLM providers
5. **Response** → Flows back through the same chain

---

## Getting Started

### Prerequisites

- **Node.js** 18+ and npm
- **Firefox** 109+
- An LLM provider (llamafile or Ollama)

### Installation

```bash
# 1. Build the extension
cd extension
npm install && npm run build

# 2. Build the bridge
cd ../bridge-ts
npm install && npm run build

# 3. Install native messaging manifest
cd scripts
./install_native_manifest_macos.sh  # or linux version

# 4. Load extension in Firefox
# Go to about:debugging → Load Temporary Add-on → select extension/dist/manifest.json
```

### Quick Test

```javascript
// In browser console on any page
if (window.agent) {
  const result = await window.agent.requestPermissions({
    scopes: ['model:prompt'],
    reason: 'Test Harbor installation'
  });
  console.log('Granted:', result.granted);
}
```

---

## Web Page APIs

Harbor exposes two global objects to web pages: `window.ai` for text generation and `window.agent` for tools and agent capabilities.

### Detecting Harbor

```javascript
// Check if Harbor is installed
if (typeof window.agent !== 'undefined') {
  console.log('Harbor is available');
}

// Wait for provider to be ready
window.addEventListener('harbor-provider-ready', () => {
  console.log('Harbor APIs are ready to use');
});
```

---

### window.ai API

The `window.ai` API provides Chrome Prompt API-compatible text generation.

#### ai.createTextSession(options?)

Create a new text generation session with conversation history.

**Signature:**
```typescript
ai.createTextSession(options?: {
  model?: string;        // Model identifier (default: "default")
  temperature?: number;  // Sampling temperature 0.0-2.0
  top_p?: number;        // Nucleus sampling 0.0-1.0
  systemPrompt?: string; // System prompt for the session
}): Promise<TextSession>
```

**Returns:**
```typescript
interface TextSession {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
}

interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;
  error?: ApiError;
}
```

**Example:**
```javascript
// Request permission first
await window.agent.requestPermissions({
  scopes: ['model:prompt'],
  reason: 'Enable AI text generation'
});

// Create a session
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful coding assistant.',
  temperature: 0.7
});

// Simple prompt
const response = await session.prompt('Explain async/await in JavaScript');
console.log(response);

// Follow-up (session maintains context)
const followUp = await session.prompt('Show me an example');
console.log(followUp);

// Streaming
for await (const event of session.promptStreaming('Write a haiku')) {
  if (event.type === 'token') {
    process.stdout.write(event.token);
  }
}

// Clean up
await session.destroy();
```

---

### window.agent API

The `window.agent` API provides permission management, MCP tools, and agent capabilities.

#### agent.requestPermissions(options)

Request permission scopes from the user. Shows a permission prompt if needed.

**Signature:**
```typescript
agent.requestPermissions(options: {
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];  // Specific tools needed (for mcp:tools.call)
}): Promise<PermissionGrantResult>
```

**Permission Scopes:**

| Scope | Description |
|-------|-------------|
| `model:prompt` | Generate text using AI models |
| `model:tools` | Use AI with tool calling |
| `mcp:tools.list` | List available MCP tools |
| `mcp:tools.call` | Execute MCP tools |
| `browser:activeTab.read` | Read content from active tab |

**Grant Types:**

| Grant | Meaning |
|-------|---------|
| `granted-always` | Persisted permission for this origin |
| `granted-once` | Temporary (expires after ~10 minutes or tab close) |
| `denied` | User explicitly denied |
| `not-granted` | Never requested |

**Example:**
```javascript
const result = await window.agent.requestPermissions({
  scopes: ['model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'This app uses AI to help you with tasks.',
});

if (result.granted) {
  console.log('All permissions granted');
} else {
  // Check individual scopes
  for (const [scope, grant] of Object.entries(result.scopes)) {
    console.log(`${scope}: ${grant}`);
  }
}
```

---

#### agent.permissions.list()

Get current permission status for this origin.

```typescript
const status = await window.agent.permissions.list();
console.log('Origin:', status.origin);
console.log('Scopes:', status.scopes);
```

---

#### agent.tools.list()

List all available tools from connected MCP servers.

**Requires:** `mcp:tools.list` permission

```typescript
const tools = await window.agent.tools.list();
for (const tool of tools) {
  console.log(`${tool.name}: ${tool.description}`);
  // Example output:
  // memory-server/save_memory: Save a memory to long-term storage
  // filesystem/read_file: Read contents of a file
}
```

---

#### agent.tools.call(options)

Execute a specific MCP tool.

**Requires:** `mcp:tools.call` permission

**Signature:**
```typescript
agent.tools.call(options: {
  tool: string;  // Format: "serverId/toolName"
  args: Record<string, unknown>;
}): Promise<unknown>
```

**Example:**
```javascript
// Save a memory
const result = await window.agent.tools.call({
  tool: 'memory-server/save_memory',
  args: {
    content: 'User prefers dark mode',
    metadata: { category: 'preferences' }
  }
});

// Read a file
const content = await window.agent.tools.call({
  tool: 'filesystem/read_file',
  args: { path: '/path/to/file.txt' }
});
```

---

#### agent.browser.activeTab.readability()

Extract readable text content from the currently active browser tab.

**Requires:** `browser:activeTab.read` permission

```typescript
const tab = await window.agent.browser.activeTab.readability();
console.log('URL:', tab.url);
console.log('Title:', tab.title);
console.log('Content:', tab.text.slice(0, 500));
```

---

#### agent.run(options)

Run an autonomous agent task with access to tools. Returns an async iterator of events.

**Built-in Tool Router:** The agent automatically analyzes your task and selects only relevant tools based on keywords. For example, mentioning "GitHub" or "repo" will only present GitHub-related tools to the LLM. This dramatically improves performance with local models.

**Requires:** `model:tools` permission, plus `mcp:tools.list` and `mcp:tools.call` for tool access

**Signature:**
```typescript
agent.run(options: {
  task: string;
  tools?: string[];        // Override: only allow these tools
  useAllTools?: boolean;   // Disable router, use all tools
  requireCitations?: boolean;
  maxToolCalls?: number;   // Default: 5
  signal?: AbortSignal;
}): AsyncIterable<RunEvent>
```

**Event Types:**
```typescript
type RunEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown; error?: ApiError }
  | { type: 'token'; token: string }
  | { type: 'final'; output: string; citations?: Citation[] }
  | { type: 'error'; error: ApiError };
```

**Example:**
```javascript
// Basic agent run
for await (const event of window.agent.run({
  task: 'What GitHub repos do I have?'
})) {
  switch (event.type) {
    case 'status':
      console.log('Status:', event.message);
      break;
    case 'tool_call':
      console.log('Calling:', event.tool);
      break;
    case 'tool_result':
      console.log('Result:', event.result);
      break;
    case 'token':
      process.stdout.write(event.token);
      break;
    case 'final':
      console.log('\n\nFinal:', event.output);
      break;
    case 'error':
      console.error('Error:', event.error.message);
      break;
  }
}

// With specific tools only
for await (const event of window.agent.run({
  task: 'Save a note about this meeting',
  tools: ['memory-server/save_memory'],
  maxToolCalls: 3
})) {
  // handle events...
}

// With abort signal
const controller = new AbortController();
setTimeout(() => controller.abort(), 30000);

for await (const event of window.agent.run({
  task: 'Research this topic',
  signal: controller.signal
})) {
  // handle events...
}
```

---

## Permission System

Harbor uses a capability-based permission system scoped per-origin.

### Security Model

1. **Per-origin permissions**: Each website must be granted access separately
2. **User consent required**: Extension shows a permission prompt for new sites
3. **Grant types**: "Allow once" (session) or "Always allow" (persistent)
4. **Scope isolation**: Sites can only access granted scopes
5. **Tool filtering**: `agent.run()` can be limited to specific tools

### Storage

Permissions are stored in browser extension storage:
- **Persistent grants**: `browser.storage.local`
- **Temporary grants**: In-memory with TTL (10 minutes default)
- **Tab-scoped grants**: Expire when tab closes

---

## Bridge Protocol

The bridge communicates with the extension via native messaging (stdin/stdout JSON).

### Message Format

```typescript
interface Message {
  type: string;
  request_id: string;
  [key: string]: unknown;
}

interface ErrorResponse {
  type: 'error';
  request_id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

### Message Types

#### Server Management
| Type | Description |
|------|-------------|
| `add_server` | Add a new remote MCP server |
| `remove_server` | Remove a server |
| `list_servers` | List all servers |
| `connect_server` | Connect to a server |
| `disconnect_server` | Disconnect from a server |

#### MCP Operations
| Type | Description |
|------|-------------|
| `mcp_connect` | Connect to an installed server via stdio |
| `mcp_disconnect` | Disconnect from a server |
| `mcp_list_connections` | List all active connections |
| `mcp_list_tools` | List tools from connected server |
| `mcp_list_resources` | List resources from connected server |
| `mcp_list_prompts` | List prompts from connected server |
| `mcp_call_tool` | Call a tool with arguments |
| `mcp_read_resource` | Read a resource by URI |
| `mcp_get_prompt` | Get a prompt with arguments |

#### Catalog
| Type | Description |
|------|-------------|
| `catalog_get` | Get catalog (from cache or refresh) |
| `catalog_refresh` | Force refresh catalog |
| `catalog_search` | Search catalog |

#### Installer
| Type | Description |
|------|-------------|
| `check_runtimes` | Check available runtimes |
| `install_server` | Install a server from catalog |
| `uninstall_server` | Uninstall a server |
| `list_installed` | List installed servers |
| `start_installed` | Start an installed server |
| `stop_installed` | Stop a running server |

#### LLM
| Type | Description |
|------|-------------|
| `llm_detect` | Detect available LLM providers |
| `llm_list_providers` | List all providers and status |
| `llm_set_active` | Set the active provider |
| `llm_list_models` | List models from active provider |
| `llm_chat` | Send a chat completion request |

#### Chat Orchestration
| Type | Description |
|------|-------------|
| `chat_create_session` | Create a chat session with enabled servers |
| `chat_send_message` | Send a message and run orchestration loop |
| `chat_get_session` | Get a session by ID |
| `chat_list_sessions` | List all chat sessions |
| `chat_delete_session` | Delete a session |

---

## MCP Host

The MCP Host manages server connections, tool registration, permissions, and rate limiting.

### Components

1. **Permission System** (`host/permissions.ts`)
   - Capability-based permissioning keyed by origin and profile
   - Supports ALLOW_ONCE, ALLOW_ALWAYS, DENY grants
   - Tab-scoped grants that expire on close

2. **Tool Registry** (`host/tool-registry.ts`)
   - Maintains registry of tools from all connected servers
   - Namespaces tools as `{serverId}/{toolName}`
   - Enforces permission checks on list/resolve

3. **Rate Limiter** (`host/rate-limiter.ts`)
   - Default: 5 max calls per run, 2 concurrent per origin
   - 30 second default timeout per tool call

4. **Observability** (`host/observability.ts`)
   - Logs tool calls without exposing payload content
   - Records metrics: duration, success/failure, error codes

### Usage Example

```typescript
import { getMcpHost, grantPermission, GrantType, PermissionScope } from './host/index.js';

const host = getMcpHost();
const origin = 'https://example.com';

// Grant permissions
await grantPermission(origin, 'default', PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);
await grantPermission(origin, 'default', PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS, {
  allowedTools: ['filesystem/read_file', 'github/search_issues']
});

// List and call tools
const { tools } = host.listTools(origin);
const result = await host.callTool(origin, 'filesystem/read_file', { path: '/tmp/test.txt' });

if (result.ok) {
  console.log('Result:', result.result);
  console.log('Provenance:', result.provenance);
}
```

---

## Catalog System

The catalog aggregates MCP server listings from multiple sources.

### Data Sources

1. **Official Registry** (`official_registry`)
   - API: `https://registry.modelcontextprotocol.io/v0/servers`
   - Primary source of truth

2. **GitHub Awesome List** (`github_awesome`)
   - Source: `https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md`
   - Community curated

### Caching

- **TTL**: 1 hour
- **Storage**: SQLite database (`~/.harbor/catalog.db`)
- **Background refresh**: Stale cache triggers background update

### Enrichment

The catalog enriches server entries with popularity data:
- GitHub stars
- npm downloads
- Last commit date
- Computed popularity score

### API

```typescript
import { getCatalogManager } from './catalog/manager.js';

const catalog = getCatalogManager();

// Get cached data (fast)
const cached = await catalog.getCached();

// Force refresh from providers
const fresh = await catalog.refresh({ force: true });

// Search
const results = await catalog.search('github', 100);
```

---

## LLM Integration

Harbor supports multiple LLM providers for local inference.

### Supported Providers

| Provider | Default URL | Status |
|----------|-------------|--------|
| llamafile | `localhost:8080` | ✅ Supported |
| Ollama | `localhost:11434` | ✅ Supported |
| OpenAI API | - | 🔜 Planned |
| Anthropic API | - | 🔜 Planned |

### LLM Manager API

```typescript
import { getLLMManager } from './llm/manager.js';

const llm = getLLMManager();

// Detect available providers
const providers = await llm.detectAll();
console.log('Available:', providers.filter(p => p.available));

// Set active provider
llm.setActive('llamafile');

// List models
const models = await llm.listModels();

// Chat completion
const response = await llm.chat({
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello!' }
  ],
  tools: [...],  // Optional tool definitions
});

// Streaming
for await (const chunk of llm.chatStream(request)) {
  console.log(chunk.delta.content);
}
```

### Tool Calling Support

Ollama requires version 0.3.0+ for native tool calling. Harbor detects the version and warns if tools are unavailable.

---

## Chat Orchestration

The Chat Orchestrator is the agent loop that connects LLMs to MCP tools.

### How It Works

1. **Collect Tools**: Gather tools from enabled MCP servers
2. **Build Request**: Send user message to LLM with tool definitions
3. **Execute Tools**: If LLM requests tool calls, execute via MCP
4. **Feed Results**: Send tool results back to LLM
5. **Repeat**: Continue until LLM produces final response

### Tool Router

The built-in tool router intelligently selects which servers to use based on keywords in the user's message:

| Keywords | Servers Selected |
|----------|-----------------|
| github, repo, commit, PR | github |
| file, folder, directory | filesystem |
| remember, memory, recall | memory |
| slack, channel, message | slack |
| database, SQL, query | database, postgres, mysql |

This reduces cognitive load on local LLMs by only presenting relevant tools.

### Orchestration API

```typescript
import { getChatOrchestrator } from './chat/orchestrator.js';
import { createSession } from './chat/session.js';

const orchestrator = getChatOrchestrator();

// Create session with enabled servers
const session = createSession({
  enabledServers: ['memory-server', 'filesystem'],
  maxIterations: 10,
  useToolRouter: true,
});

// Run orchestration
const result = await orchestrator.run(
  session,
  'Save a note about today's meeting',
  (step) => {
    console.log(`Step ${step.index}:`, step.type);
  }
);

console.log('Final:', result.finalResponse);
console.log('Iterations:', result.iterations);
console.log('Routing:', result.routing?.reason);
```

---

## Installer (App Store)

The installer manages installation and execution of MCP servers.

### Supported Package Types

| Type | Runner | Description |
|------|--------|-------------|
| `npm` | `npx -y` | Node.js packages |
| `pypi` | `uvx` | Python packages |
| `binary` | Direct | Pre-compiled binaries |
| `oci` | Docker | Container images |
| `http`/`sse` | HTTP client | Remote servers |

### Runtime Detection

```typescript
import { getInstalledServerManager } from './installer/manager.js';

const manager = getInstalledServerManager();

const { runtimes, canInstall } = await manager.checkRuntimes();
console.log('Can install npm:', canInstall.npm);
console.log('Can install pypi:', canInstall.pypi);
console.log('Docker available:', canInstall.oci);
```

### Server Installation

```typescript
// Install from catalog
const server = await manager.install(catalogEntry, 0, { noDocker: true });

// Add remote server
const remote = manager.addRemoteServer(
  'My API',
  'https://api.example.com/mcp',
  'http',
  { 'Authorization': 'Bearer token' }
);

// Start server
const process = await manager.start(server.id, { useDocker: false });

// Get status
const status = manager.getStatus(server.id);
console.log('Running:', status.process?.state === 'running');
console.log('Missing secrets:', status.missingSecrets);
```

### Secret Management

```typescript
// Set API key for a server
manager.setSecret('openai-server', 'OPENAI_API_KEY', 'sk-...');

// Set multiple secrets
manager.setSecrets('server-id', {
  'API_KEY': 'value1',
  'API_SECRET': 'value2',
});
```

---

## Error Handling

All APIs use consistent error codes:

| Code | Description |
|------|-------------|
| `ERR_NOT_INSTALLED` | Extension not installed |
| `ERR_PERMISSION_DENIED` | User denied permission |
| `ERR_USER_GESTURE_REQUIRED` | Needs user interaction (click) |
| `ERR_SCOPE_REQUIRED` | Missing required permission scope |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist |
| `ERR_TOOL_NOT_FOUND` | Tool does not exist |
| `ERR_TOOL_FAILED` | Tool execution failed |
| `ERR_TOOL_TIMEOUT` | Tool call timed out |
| `ERR_MODEL_FAILED` | LLM request failed |
| `ERR_NOT_IMPLEMENTED` | Feature not available |
| `ERR_SESSION_NOT_FOUND` | Session was destroyed |
| `ERR_TIMEOUT` | Request timed out |
| `ERR_SERVER_UNAVAILABLE` | MCP server not available |
| `ERR_RATE_LIMITED` | Rate limit exceeded |
| `ERR_BUDGET_EXCEEDED` | Budget exceeded for run |
| `ERR_INTERNAL` | Internal error |

**Example:**
```javascript
try {
  const tools = await window.agent.tools.list();
} catch (err) {
  switch (err.code) {
    case 'ERR_SCOPE_REQUIRED':
      await window.agent.requestPermissions({ scopes: ['mcp:tools.list'] });
      break;
    case 'ERR_PERMISSION_DENIED':
      console.log('User denied permission');
      break;
    default:
      console.error('Unexpected error:', err.message);
  }
}
```

---

## TypeScript Definitions

For TypeScript projects, use these type definitions:

```typescript
declare global {
  interface Window {
    ai: {
      createTextSession(options?: TextSessionOptions): Promise<TextSession>;
    };
    agent: {
      requestPermissions(options: {
        scopes: PermissionScope[];
        reason?: string;
      }): Promise<PermissionGrantResult>;
      permissions: {
        list(): Promise<PermissionStatus>;
      };
      tools: {
        list(): Promise<ToolDescriptor[]>;
        call(options: { tool: string; args: Record<string, unknown> }): Promise<unknown>;
      };
      browser: {
        activeTab: {
          readability(): Promise<ActiveTabReadability>;
        };
      };
      run(options: AgentRunOptions): AsyncIterable<RunEvent>;
    };
  }
}

type PermissionScope =
  | 'model:prompt'
  | 'model:tools'
  | 'mcp:tools.list'
  | 'mcp:tools.call'
  | 'browser:activeTab.read';

type PermissionGrant = 'granted-once' | 'granted-always' | 'denied' | 'not-granted';

interface PermissionGrantResult {
  granted: boolean;
  scopes: Record<PermissionScope, PermissionGrant>;
}

interface PermissionStatus {
  origin: string;
  scopes: Record<PermissionScope, PermissionGrant>;
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId?: string;
}

interface ActiveTabReadability {
  url: string;
  title: string;
  text: string;
}

interface TextSessionOptions {
  model?: string;
  temperature?: number;
  top_p?: number;
  systemPrompt?: string;
}

interface TextSession {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
}

interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;
  error?: ApiError;
}

interface AgentRunOptions {
  task: string;
  tools?: string[];
  useAllTools?: boolean;
  requireCitations?: boolean;
  maxToolCalls?: number;
  signal?: AbortSignal;
}

type RunEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown; error?: ApiError }
  | { type: 'token'; token: string }
  | { type: 'final'; output: string; citations?: Citation[] }
  | { type: 'error'; error: ApiError };

interface Citation {
  source: 'tab' | 'tool';
  ref: string;
  excerpt: string;
}

interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
```

---

## Data Storage

All data is stored in `~/.harbor/`:

| File | Description |
|------|-------------|
| `harbor.db` | Server configurations (SQLite) |
| `catalog.db` | Catalog cache (SQLite) |
| `installed_servers.json` | Installed server configs |
| `secrets/credentials.json` | API keys (restricted permissions) |
| `sessions/*.json` | Chat session history |

---

## Version

This document describes **Harbor v1**.

