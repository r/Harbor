# Web Agent API Explainer

**Status**: Draft Proposal  
**Author**: Raffi Krikorian &lt;raffi@mozilla.org&gt;  
**Last Updated**: January 2026  
**Version**: 1.0

---

## Table of Contents

1. [Introduction](#introduction)
2. [Goals](#goals)
3. [Non-Goals](#non-goals)
4. [User Stories](#user-stories)
5. [API Overview](#api-overview)
6. [Permission Model](#permission-model)
7. [API Reference](#api-reference)
   - [window.ai](#windowai)
   - [window.agent](#windowagent)
8. [Web IDL Definitions](#web-idl-definitions)
9. [Security Considerations](#security-considerations)
10. [Privacy Considerations](#privacy-considerations)
11. [Implementation Notes](#implementation-notes)
12. [Examples](#examples)
13. [Comparison with Chrome Prompt API](#comparison-with-chrome-prompt-api)
14. [Open Questions](#open-questions)

---

## Introduction

The Web Agent API exposes two global JavaScript APIs to web pages for AI capabilities:

- **`window.ai`** — Text generation using language models (Chrome Prompt API compatible)
- **`window.agent`** — Tool calling, browser access, and autonomous agent capabilities via MCP (Model Context Protocol) servers

These APIs provide the web platform primitives needed to build AI agents — applications that can reason, use tools, and accomplish tasks on behalf of users. The specification is implementation-agnostic; any browser or extension can implement these APIs.

**Implementation:** [Harbor](../) is an implementation of this proposal, available as a Firefox extension with a Node.js bridge.

### Design Principles

1. **User Consent First**: All capabilities require explicit user permission, scoped per-origin.
2. **Chrome Compatibility**: The `window.ai` API surface is designed for compatibility with Chrome's built-in Prompt API, enabling graceful fallback.
3. **Tool Extensibility**: MCP servers provide a plugin architecture for extending AI capabilities with tools (file system, GitHub, databases, etc.).
4. **Secure by Default**: Tool access is granular; users can allowlist specific tools per-origin.

---

## Goals

1. **Provide AI capabilities to web applications** without requiring developers to manage API keys, model hosting, or authentication.

2. **Enable tool-augmented AI interactions** where language models can call external tools (search, file access, APIs) with user consent.

3. **Maintain user privacy and control** by requiring explicit permission grants before any AI operation.

4. **Support both simple and complex use cases** from single-turn text generation to multi-step autonomous agents.

5. **Be compatible with Chrome's Prompt API** to enable applications to work with both Chrome's built-in AI and Harbor's backend.

---

## Non-Goals

1. **Replace cloud AI providers**: Harbor is designed to complement, not replace, existing AI APIs. It's ideal for privacy-sensitive or offline-capable applications.

2. **Provide model training or fine-tuning**: This API is inference-only.

3. **Guarantee specific model capabilities**: Model behavior depends on the user's configured backend (Ollama, llamafile, etc.).

4. **Handle payment or usage quotas**: Resource management is the user's responsibility.

---

## User Stories

### Story 1: AI-Powered Writing Assistant

> As a user of a web-based text editor, I want the application to offer AI-powered writing suggestions without the developer needing my API key.

```javascript
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful writing assistant. Be concise.'
});
const suggestion = await session.prompt('Improve this paragraph: ' + selectedText);
```

### Story 2: Research Agent with Web Search

> As a user, I want a web application to research topics on my behalf using web search tools, with my explicit consent.

```javascript
// Request tool permissions
await window.agent.requestPermissions({
  scopes: ['model:tools', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'Research requires access to web search tools'
});

// Run agent task
for await (const event of window.agent.run({
  task: 'Find recent developments in quantum computing',
  maxToolCalls: 5
})) {
  if (event.type === 'token') console.log(event.token);
  if (event.type === 'final') console.log('Result:', event.output);
}
```

### Story 3: Page Summarization

> As a user, I want a browser extension popup to summarize the current page content.

```javascript
const tab = await window.agent.browser.activeTab.readability();
const session = await window.ai.createTextSession();
const summary = await session.prompt(`Summarize this article:\n\n${tab.text}`);
```

---

## API Overview

### Global Objects

When the Web Agent API is available, these global objects are exposed:

| Object | Purpose |
|--------|---------|
| `window.ai` | Text generation API (Chrome Prompt API compatible) |
| `window.agent` | Tools, browser access, and autonomous agent capabilities |

Implementations MAY also expose implementation-specific namespaces (e.g., Harbor exposes `window.harbor`).

### Feature Detection

```javascript
// Check if the Web Agent API is available
if (typeof window.agent !== 'undefined') {
  console.log('Web Agent API is available');
}

// Implementations may fire a ready event
window.addEventListener('agent-ready', (event) => {
  console.log('Providers available:', event.detail.providers);
});

// Check capability availability
const availability = await window.ai.canCreateTextSession();
// 'readily' | 'after-download' | 'no'
```

---

## Permission Model

All API calls that access AI models or external tools require user permission. Permissions are:

1. **Scoped per-origin**: Each website has its own permission set
2. **Capability-based**: Specific scopes grant access to specific APIs
3. **Explicitly granted**: User must consent via a permission prompt
4. **Revocable**: Users can revoke permissions at any time

---

## Proposed Permissions

This section formally defines the permission scopes proposed by Harbor.

### 1. `model:prompt`

**Purpose**: Allow the origin to generate text using AI language models.

**Capabilities Granted**:
- Create text generation sessions via `ai.createTextSession()`
- Send prompts and receive AI-generated responses
- Maintain multi-turn conversation context within a session

**User-Facing Description**: "Generate text using AI models"

**Risk Level**: Low — Limited to text generation; no tool execution or browser access.

**APIs Gated**:
```
ai.createTextSession()
ai.languageModel.create()
session.prompt()
session.promptStreaming()
```

---

### 2. `model:tools`

**Purpose**: Allow the origin to run autonomous agent tasks where the AI can decide to call tools.

**Capabilities Granted**:
- Execute agent runs via `agent.run()`
- AI model can autonomously decide which tools to invoke (subject to `mcp:tools.call` permission)
- Receive streaming events including tool calls, results, and final output

**User-Facing Description**: "Use AI with tool calling capabilities"

**Risk Level**: Medium — AI makes decisions about tool invocation; combined with `mcp:tools.call` enables autonomous actions.

**Depends On**: Typically used with `mcp:tools.list` and `mcp:tools.call` for full functionality.

**APIs Gated**:
```
agent.run()
```

---

### 3. `model:list`

**Purpose**: Allow the origin to discover available LLM providers and their configuration.

**Capabilities Granted**:
- List all configured LLM providers (Ollama, OpenAI, Anthropic, etc.)
- See which models are available for each provider
- Check which provider/model is currently active
- Determine provider capabilities (e.g., tool calling support)

**User-Facing Description**: "List available AI providers and models"

**Risk Level**: Low — Read-only access to provider metadata; no execution capability.

**APIs Gated**:
```
ai.providers.list()
ai.providers.getActive()
```

---

### 4. `mcp:tools.list`

**Purpose**: Allow the origin to enumerate available tools from connected MCP servers.

**Capabilities Granted**:
- List all tools from all connected MCP servers
- Read tool names, descriptions, and input schemas
- Discover server IDs providing each tool

**User-Facing Description**: "List available MCP tools"

**Risk Level**: Low — Read-only access to tool metadata; no execution capability.

**APIs Gated**:
```
agent.tools.list()
```

---

### 5. `mcp:tools.call`

**Purpose**: Allow the origin to execute specific MCP tools.

**Capabilities Granted**:
- Call tools directly via `agent.tools.call()`
- Receive tool execution results
- **Subject to Tool Allowlist**: Only tools explicitly permitted by the user can be called

**User-Facing Description**: "Execute MCP tools on your behalf"

**Risk Level**: High — Tools can perform actions like file system access, API calls, database operations, etc. Risk depends on which tools are allowed.

**Additional Controls**:
- **Tool Allowlist**: User can restrict which specific tools this origin may call
- **Per-Call Validation**: Each tool call is checked against the allowlist
- **Empty Allowlist = No Access**: If user grants permission but selects no tools, origin cannot call any tools

**APIs Gated**:
```
agent.tools.call()
```

**Tool Allowlist Behavior**:
```javascript
// When requesting permission, origin can specify desired tools:
await agent.requestPermissions({
  scopes: ['mcp:tools.call'],
  tools: ['memory-server/save_memory', 'brave-search/search']
});

// User sees a checklist and can uncheck tools they don't want to allow
// Only checked tools are added to the origin's allowlist
```

---

### 6. `browser:activeTab.read`

**Purpose**: Allow the origin to read content from the user's currently active browser tab.

**Capabilities Granted**:
- Extract readable text content from the active tab
- Read the tab's URL and title
- Content is cleaned of scripts, navigation, ads, etc.

**User-Facing Description**: "Read content from the currently active browser tab"

**Risk Level**: Medium-High — Can access content from any website the user is viewing; potential privacy implications.

**Restrictions**:
- Cannot read privileged pages (`about:`, `chrome:`, `moz-extension:`, etc.)
- Content is truncated to 50,000 characters
- Only reads the currently active tab at the moment of the call

**APIs Gated**:
```
agent.browser.activeTab.readability()
```

---

### 7. `web:fetch` (Reserved — Not Implemented in v1)

**Purpose**: Allow the origin to proxy HTTP requests through the extension.

**Capabilities Granted** (when implemented):
- Make HTTP requests to arbitrary URLs
- Bypass CORS restrictions
- Access cross-origin resources

**User-Facing Description**: "Make web requests on your behalf"

**Risk Level**: High — Could be used to exfiltrate data or access internal networks.

**Status**: Reserved for future implementation. Requesting this permission returns `ERR_NOT_IMPLEMENTED`.

**APIs Gated** (future):
```
agent.web.fetch()  // Not yet implemented
```

---

### Permission Summary Table

| Scope | Risk Level | Read/Write | Requires User Gesture |
|-------|------------|------------|----------------------|
| `model:prompt` | Low | Read (model output) | No |
| `model:tools` | Medium | Read/Write (via tools) | No |
| `model:list` | Low | Read | No |
| `mcp:tools.list` | Low | Read | No |
| `mcp:tools.call` | High | Read/Write | No |
| `browser:activeTab.read` | Medium-High | Read | Recommended* |
| `web:fetch` | High | Read/Write | No |

*User gesture requirement for `browser:activeTab.read` is recommended but not enforced in v1.

---

### Grant Types

| Grant | Behavior | Storage | Duration |
|-------|----------|---------|----------|
| `granted-always` | Persists across browser sessions | `browser.storage.local` | Until revoked |
| `granted-once` | Temporary permission | In-memory | 10 minutes or until tab closes |
| `denied` | Explicitly rejected (no re-prompt) | `browser.storage.local` | Until user clears |
| `not-granted` | Never requested | — | — |

### Permission Request Flow

```
┌─────────────────┐
│ Web Page calls  │
│ requestPerms()  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ Check if all scopes already granted │
└────────┬───────────────────────────┘
         │
    ┌────┴────┐
    │ Granted │───────────────▶ Return { granted: true }
    └────┬────┘
         │ No
         ▼
┌─────────────────────────────────────┐
│ Check if any scope explicitly denied│
└────────┬───────────────────────────┘
         │
    ┌────┴────┐
    │ Denied  │───────────────▶ Return { granted: false }
    └────┬────┘               (no re-prompt)
         │ No
         ▼
┌─────────────────────────────────────┐
│ Show Permission Prompt              │
│ • Origin                            │
│ • Requested scopes                  │
│ • Reason (optional)                 │
│ • Tool selection (if applicable)   │
└────────┬───────────────────────────┘
         │
    User Decision
         │
    ┌────┴────┬────────────────┐
    ▼         ▼                ▼
 Always     Once            Deny
    │         │                │
    ▼         ▼                ▼
 Persist   Memory           Persist
 forever   10 min           forever
```

### Tool Allowlisting

When granting `mcp:tools.call` permission, users can select which specific tools an origin is allowed to call. This provides fine-grained control:

```javascript
// Request specific tools
const result = await window.agent.requestPermissions({
  scopes: ['mcp:tools.call'],
  tools: ['brave-search/search', 'memory-server/save_memory'],
  reason: 'App needs search and memory tools'
});

// The permission prompt will show only the requested tools
// User can uncheck tools they don't want to allow
```

---

## API Reference

### window.ai

The `window.ai` object provides text generation capabilities compatible with Chrome's Prompt API.

#### `ai.canCreateTextSession()`

Check if a text session can be created.

**Signature:**
```typescript
ai.canCreateTextSession(): Promise<AICapabilityAvailability>
```

**Returns:**
- `'readily'` — Model is available and ready
- `'after-download'` — Model needs setup (not used in Harbor)
- `'no'` — AI not available (bridge not connected)

**Example:**
```javascript
const status = await window.ai.canCreateTextSession();
if (status === 'readily') {
  // Can create session
}
```

---

#### `ai.createTextSession(options?)`

Create a new text generation session. Sessions maintain conversation history for multi-turn interactions.

**Signature:**
```typescript
ai.createTextSession(options?: TextSessionOptions): Promise<AITextSession>
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | `string` | `'default'` | Model identifier |
| `provider` | `string` | — | LLM provider to use (e.g., `'ollama'`, `'openai'`, `'anthropic'`) |
| `temperature` | `number` | `1.0` | Sampling temperature (0.0 - 2.0) |
| `top_p` | `number` | `1.0` | Nucleus sampling threshold (0.0 - 1.0) |
| `systemPrompt` | `string` | — | System prompt for the session |

**Returns:** `AITextSession` object

**Permission Required:** `model:prompt` (auto-requested if not granted)

**Throws:**
- `ERR_PERMISSION_DENIED` — User denied permission

**Example:**
```javascript
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful coding assistant.',
  temperature: 0.7
});
```

---

#### `ai.languageModel.capabilities()`

Chrome Prompt API compatible. Returns capability information.

**Signature:**
```typescript
ai.languageModel.capabilities(): Promise<AILanguageModelCapabilities>
```

**Returns:**
```typescript
{
  available: 'readily' | 'after-download' | 'no',
  defaultTemperature?: number,
  defaultTopK?: number,
  maxTopK?: number
}
```

---

#### `ai.languageModel.create(options?)`

Chrome Prompt API compatible. Creates a session with Chrome-style options.

**Signature:**
```typescript
ai.languageModel.create(options?: AILanguageModelCreateOptions): Promise<AITextSession>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `systemPrompt` | `string` | System prompt |
| `initialPrompts` | `Array<{role, content}>` | Conversation history to replay |
| `temperature` | `number` | Sampling temperature |
| `topK` | `number` | Top-K sampling (mapped to Harbor equivalent) |
| `signal` | `AbortSignal` | Cancellation signal |

---

#### `session.prompt(input)`

Send a prompt and get the complete response.

**Signature:**
```typescript
session.prompt(input: string): Promise<string>
```

**Parameters:**
- `input` — The user message/prompt

**Returns:** Complete assistant response as a string

**Example:**
```javascript
const response = await session.prompt('Explain quantum computing');
console.log(response);

// Follow-up (session maintains context)
const followUp = await session.prompt('Can you give an example?');
```

---

#### `session.promptStreaming(input)`

Send a prompt and stream the response token by token.

**Signature:**
```typescript
session.promptStreaming(input: string): AsyncIterable<StreamToken>
```

**Yields:**
```typescript
type StreamToken = {
  type: 'token',
  token: string
} | {
  type: 'done'
} | {
  type: 'error',
  error: ApiError
}
```

**Example:**
```javascript
let fullResponse = '';

for await (const event of session.promptStreaming('Write a haiku')) {
  if (event.type === 'token') {
    document.body.textContent += event.token;
    fullResponse += event.token;
  } else if (event.type === 'error') {
    console.error('Error:', event.error.message);
    break;
  }
}

console.log('Complete:', fullResponse);
```

---

#### `session.clone()`

Create a copy of the session with the same options.

**Signature:**
```typescript
session.clone(): Promise<AITextSession>
```

**Note:** The cloned session starts fresh (no conversation history).

---

#### `session.destroy()`

Clean up the session and free resources.

**Signature:**
```typescript
session.destroy(): Promise<void>
```

**Best Practice:** Always destroy sessions when done.

```javascript
const session = await window.ai.createTextSession();
try {
  const response = await session.prompt('Hello');
} finally {
  await session.destroy();
}
```

---

#### `ai.providers.list()`

List all configured LLM providers and their availability.

**Signature:**
```typescript
ai.providers.list(): Promise<LLMProviderInfo[]>
```

**Permission Required:** `model:list`

**Returns:**
```typescript
interface LLMProviderInfo {
  id: string;              // Provider ID (e.g., 'ollama', 'openai', 'anthropic')
  name: string;            // Human-readable name
  available: boolean;      // Whether the provider is currently available
  baseUrl?: string;        // Base URL for the provider's API
  models?: string[];       // Available models for this provider
  isDefault: boolean;      // Whether this is the currently active provider
  supportsTools?: boolean; // Whether the provider supports tool calling
}
```

**Example:**
```javascript
const providers = await window.ai.providers.list();

for (const provider of providers) {
  console.log(`${provider.name} (${provider.id})`);
  console.log(`  Available: ${provider.available}`);
  console.log(`  Default: ${provider.isDefault}`);
  console.log(`  Models: ${provider.models?.join(', ') || 'unknown'}`);
  console.log(`  Supports Tools: ${provider.supportsTools}`);
}

// Example output:
// Ollama (ollama)
//   Available: true
//   Default: true
//   Models: llama3.2:3b, mistral:7b, codellama:13b
//   Supports Tools: true
// OpenAI (openai)
//   Available: true
//   Default: false
//   Models: gpt-4o, gpt-4o-mini, gpt-3.5-turbo
//   Supports Tools: true
```

---

#### `ai.providers.getActive()`

Get the currently active (default) provider and model.

**Signature:**
```typescript
ai.providers.getActive(): Promise<ActiveLLMConfig>
```

**Permission Required:** `model:list`

**Returns:**
```typescript
interface ActiveLLMConfig {
  provider: string | null;  // Active provider ID
  model: string | null;     // Active model ID
}
```

**Example:**
```javascript
const active = await window.ai.providers.getActive();

console.log(`Active provider: ${active.provider}`);
console.log(`Active model: ${active.model}`);

// Example output:
// Active provider: ollama
// Active model: llama3.2:3b
```

---

#### `ai.runtime`

The `ai.runtime` namespace provides direct access to specific AI backends (Firefox ML, Chrome's built-in AI, or Harbor's bridge). This is useful when you want to explicitly choose which runtime to use.

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `harbor` | `AIApi` | Direct access to Harbor's bridge API |
| `firefox` | `object \| null` | Firefox's `browser.trial.ml` API (if available) |
| `chrome` | `object \| null` | Chrome's built-in AI API (if available) |

**Methods:**

#### `ai.runtime.getBest()`

Get the best available AI backend. Respects user preferences when configured.

**Signature:**
```typescript
ai.runtime.getBest(): Promise<'firefox' | 'chrome' | 'harbor' | null>
```

**Returns:** The identifier of the best available runtime, or `null` if none available.

**Selection Priority:**
1. User's configured default (if set)
2. Firefox wllama (if available, for privacy-first local inference)
3. Chrome AI (if available)
4. Harbor bridge (if connected)

**Example:**
```javascript
// Check which backends are available
const best = await window.ai.runtime.getBest();
console.log('Best available backend:', best);

// Use Harbor's API directly (bypasses native browser AI)
const harborSession = await window.ai.runtime.harbor.createTextSession({
  systemPrompt: 'You are helpful.'
});
const response = await harborSession.prompt('Hello');

// Use Firefox's native AI if available
if (window.ai.runtime.firefox) {
  // Access Firefox ML API directly
  const engine = await window.ai.runtime.firefox.createEngine({
    modelId: 'llama-3.2-1b'
  });
}

// Use Chrome's API if available
if (window.ai.runtime.chrome) {
  const chromeSession = await window.ai.runtime.chrome.languageModel.create();
  // Use Chrome's on-device AI
}
```

#### `ai.runtime.getCapabilities()`

Get detailed capabilities of each available runtime.

**Signature:**
```typescript
ai.runtime.getCapabilities(): Promise<RuntimeCapabilities>
```

**Returns:**
```typescript
interface RuntimeCapabilities {
  firefox: {
    available: boolean;
    hasWllama: boolean;      // Firefox 142+ LLM support
    hasTransformers: boolean; // Firefox 134+ embeddings
    supportsTools: boolean;
    models: string[];
  } | null;
  chrome: {
    available: boolean;
    supportsTools: boolean;
  } | null;
  harbor: {
    available: boolean;
    bridgeConnected: boolean;
    providers: string[];     // Connected bridge providers
  };
}
```

---

### window.agent

The `window.agent` object provides access to MCP tools, browser APIs, and autonomous agent capabilities.

#### `agent.requestPermissions(options)`

Request permission scopes from the user. Shows a permission prompt if needed.

**Signature:**
```typescript
agent.requestPermissions(options: {
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];
}): Promise<PermissionGrantResult>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `scopes` | `PermissionScope[]` | Array of permission scopes to request |
| `reason` | `string` | Human-readable explanation shown in prompt |
| `tools` | `string[]` | Specific tools to request (for `mcp:tools.call`) |

**Returns:**
```typescript
{
  granted: boolean;  // true if ALL requested scopes were granted
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];  // Tools allowed for this origin
}
```

**Example:**
```javascript
const result = await window.agent.requestPermissions({
  scopes: ['model:prompt', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'This app needs AI to help you manage tasks',
  tools: ['memory-server/save_memory', 'memory-server/search_memories']
});

if (result.granted) {
  console.log('All permissions granted');
} else {
  console.log('Some permissions denied:', result.scopes);
}
```

---

#### `agent.permissions.list()`

Get current permission status for this origin.

**Signature:**
```typescript
agent.permissions.list(): Promise<PermissionStatus>
```

**Returns:**
```typescript
{
  origin: string;
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];
}
```

**Example:**
```javascript
const status = await window.agent.permissions.list();
console.log('Origin:', status.origin);

for (const [scope, grant] of Object.entries(status.scopes)) {
  console.log(`${scope}: ${grant}`);
}

if (status.allowedTools) {
  console.log('Allowed tools:', status.allowedTools);
}
```

---

#### `agent.tools.list()`

List all available tools from connected MCP servers.

**Signature:**
```typescript
agent.tools.list(): Promise<ToolDescriptor[]>
```

**Permission Required:** `mcp:tools.list`

**Returns:**
```typescript
interface ToolDescriptor {
  name: string;           // Fully qualified: "serverId/toolName"
  description?: string;   // Human-readable description
  inputSchema?: object;   // JSON Schema for arguments
  serverId?: string;      // The MCP server providing this tool
}
```

**Example:**
```javascript
const tools = await window.agent.tools.list();

for (const tool of tools) {
  console.log(`Tool: ${tool.name}`);
  console.log(`  Description: ${tool.description}`);
  console.log(`  Input Schema:`, tool.inputSchema);
}
```

**Example Output:**
```javascript
[
  {
    name: 'brave-search/search',
    description: 'Search the web using Brave Search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results' }
      },
      required: ['query']
    },
    serverId: 'brave-search'
  },
  {
    name: 'filesystem/read_file',
    description: 'Read contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' }
      },
      required: ['path']
    },
    serverId: 'filesystem'
  }
]
```

---

#### `agent.tools.call(options)`

Execute a specific MCP tool.

**Signature:**
```typescript
agent.tools.call(options: {
  tool: string;
  args: Record<string, unknown>;
}): Promise<unknown>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `tool` | `string` | Fully qualified tool name (`serverId/toolName`) |
| `args` | `object` | Arguments matching the tool's input schema |

**Permission Required:** `mcp:tools.call` AND tool must be in origin's allowlist

**Returns:** Tool result (type depends on the tool)

**Throws:**
- `ERR_TOOL_NOT_ALLOWED` — Tool not in allowlist for this origin
- `ERR_TOOL_FAILED` — Tool execution failed

**Example:**
```javascript
// Search the web
const results = await window.agent.tools.call({
  tool: 'brave-search/search',
  args: { query: 'latest AI news', count: 5 }
});

// Read a file
const content = await window.agent.tools.call({
  tool: 'filesystem/read_file',
  args: { path: '/path/to/file.txt' }
});

// Save a memory
await window.agent.tools.call({
  tool: 'memory-server/save_memory',
  args: {
    content: 'User prefers dark mode',
    metadata: { category: 'preferences' }
  }
});
```

---

#### `agent.browser.activeTab.readability()`

Extract readable text content from the currently active browser tab.

**Signature:**
```typescript
agent.browser.activeTab.readability(): Promise<ActiveTabReadability>
```

**Permission Required:** `browser:activeTab.read`

**Returns:**
```typescript
{
  url: string;    // Full URL of the active tab
  title: string;  // Document title
  text: string;   // Extracted readable text (max 50,000 chars)
}
```

**Throws:**
- `ERR_PERMISSION_DENIED` — Tab is a privileged page (about:, chrome:, etc.)
- `ERR_INTERNAL` — Content extraction failed

**Content Extraction:**
- Removes scripts, styles, navigation, ads, and non-content elements
- Attempts to find main content area (article, main, [role="main"])
- Collapses whitespace and limits output to 50,000 characters

**Example:**
```javascript
const tab = await window.agent.browser.activeTab.readability();

console.log('URL:', tab.url);
console.log('Title:', tab.title);
console.log('Content length:', tab.text.length);

// Use as context for AI
const session = await window.ai.createTextSession();
const summary = await session.prompt(
  `Summarize this article:\n\n${tab.text}`
);
```

---

#### `agent.run(options)`

Run an autonomous agent task with access to tools. Returns an async iterator of events.

**Signature:**
```typescript
agent.run(options: AgentRunOptions): AsyncIterable<RunEvent>
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | `string` | — | The task description / user request |
| `tools` | `string[]` | — | Allowed tool names (overrides router) |
| `provider` | `string` | — | LLM provider to use (e.g., `'ollama'`, `'openai'`) |
| `useAllTools` | `boolean` | `false` | Disable tool router, use all tools |
| `requireCitations` | `boolean` | `false` | Include source citations |
| `maxToolCalls` | `number` | `5` | Maximum tool invocations |
| `signal` | `AbortSignal` | — | Cancellation signal |

**Permission Required:** `model:tools` (plus `mcp:tools.list` and `mcp:tools.call` for tool access)

**Event Types:**

| Event | Fields | Description |
|-------|--------|-------------|
| `status` | `message: string` | Progress status update |
| `tool_call` | `tool: string, args: unknown` | Tool is being called |
| `tool_result` | `tool: string, result: unknown, error?: ApiError` | Tool returned result |
| `token` | `token: string` | Streaming output token |
| `final` | `output: string, citations?: Citation[]` | Final response |
| `error` | `error: ApiError` | Error occurred |

**Citation Structure:**
```typescript
interface Citation {
  source: 'tab' | 'tool';
  ref: string;      // Tool name or URL
  excerpt: string;  // Relevant excerpt
}
```

**Example: Basic Agent Run:**
```javascript
for await (const event of window.agent.run({ 
  task: 'What is the weather in Paris?' 
})) {
  switch (event.type) {
    case 'status':
      console.log('Status:', event.message);
      break;
    case 'tool_call':
      console.log('Calling:', event.tool, event.args);
      break;
    case 'tool_result':
      console.log('Result:', event.result);
      break;
    case 'token':
      process.stdout.write(event.token);
      break;
    case 'final':
      console.log('\n\nAnswer:', event.output);
      break;
    case 'error':
      console.error('Error:', event.error.message);
      break;
  }
}
```

**Example: With Abort Controller:**
```javascript
const controller = new AbortController();

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30000);

try {
  for await (const event of window.agent.run({
    task: 'Research this topic thoroughly',
    signal: controller.signal,
    maxToolCalls: 10
  })) {
    // Handle events...
  }
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('Agent run was cancelled');
  }
}
```

**Example: With Tool Filtering:**
```javascript
// Only allow specific tools
for await (const event of window.agent.run({
  task: 'Save a note about this meeting',
  tools: ['memory-server/save_memory', 'memory-server/search_memories'],
  maxToolCalls: 3
})) {
  // The agent can only use the specified tools
}
```

---

### Implementation-Specific Namespaces

Implementations MAY expose additional namespaces for implementation-specific features. For example, Harbor exposes `window.harbor`:

```typescript
// Harbor-specific (not part of the Web Agent API specification)
window.harbor = {
  ai: AIApi;          // Harbor's AI API
  agent: AgentApi;    // Agent API
  version: string;    // Harbor version (e.g., '1.0.0')
  chromeAiDetected: boolean;  // Whether Chrome's built-in AI was detected
}
```

Other implementations may expose their own namespaces as needed.

---

## Web IDL Definitions

```webidl
// =============================================================================
// Error Types
// =============================================================================

enum ApiErrorCode {
  "ERR_NOT_INSTALLED",
  "ERR_PERMISSION_DENIED",
  "ERR_USER_GESTURE_REQUIRED",
  "ERR_SCOPE_REQUIRED",
  "ERR_TOOL_NOT_ALLOWED",
  "ERR_TOOL_FAILED",
  "ERR_MODEL_FAILED",
  "ERR_NOT_IMPLEMENTED",
  "ERR_SESSION_NOT_FOUND",
  "ERR_TIMEOUT",
  "ERR_INTERNAL"
};

dictionary ApiError {
  required ApiErrorCode code;
  required DOMString message;
  any details;
};

// =============================================================================
// Permission Types
// =============================================================================

enum PermissionScope {
  "model:prompt",
  "model:tools",
  "model:list",
  "mcp:tools.list",
  "mcp:tools.call",
  "browser:activeTab.read",
  "web:fetch"
};

enum PermissionGrant {
  "granted-once",
  "granted-always",
  "denied",
  "not-granted"
};

dictionary PermissionGrantResult {
  required boolean granted;
  required record<PermissionScope, PermissionGrant> scopes;
  sequence<DOMString> allowedTools;
};

dictionary PermissionStatus {
  required DOMString origin;
  required record<PermissionScope, PermissionGrant> scopes;
  sequence<DOMString> allowedTools;
};

dictionary RequestPermissionsOptions {
  required sequence<PermissionScope> scopes;
  DOMString reason;
  sequence<DOMString> tools;
};

// =============================================================================
// Tool Types
// =============================================================================

dictionary ToolDescriptor {
  required DOMString name;
  DOMString description;
  object inputSchema;
  DOMString serverId;
};

dictionary ToolCallOptions {
  required DOMString tool;
  required record<DOMString, any> args;
};

// =============================================================================
// Text Session Types
// =============================================================================

enum AICapabilityAvailability {
  "readily",
  "after-download",
  "no"
};

dictionary TextSessionOptions {
  DOMString model;
  DOMString provider;
  double temperature;
  double top_p;
  DOMString systemPrompt;
};

// =============================================================================
// LLM Provider Types
// =============================================================================

dictionary LLMProviderInfo {
  required DOMString id;
  required DOMString name;
  required DOMString type;
  required boolean available;
  DOMString baseUrl;
  sequence<DOMString> models;
  required boolean isDefault;
  boolean isTypeDefault;
  boolean supportsTools;
  boolean isNative;
  DOMString runtime;  // 'firefox' | 'chrome' | 'bridge'
  boolean downloadRequired;
  double downloadProgress;
};

dictionary ActiveLLMConfig {
  DOMString? provider;
  DOMString? model;
};

dictionary AILanguageModelCapabilities {
  required AICapabilityAvailability available;
  double defaultTopK;
  double maxTopK;
  double defaultTemperature;
};

dictionary AILanguageModelCreateOptions {
  DOMString systemPrompt;
  sequence<ConversationMessage> initialPrompts;
  double temperature;
  double topK;
  AbortSignal signal;
};

dictionary ConversationMessage {
  required DOMString role;  // "user" | "assistant"
  required DOMString content;
};

dictionary StreamToken {
  required DOMString type;  // "token" | "done" | "error"
  DOMString token;
  ApiError error;
};

interface AITextSession {
  readonly attribute DOMString sessionId;
  Promise<DOMString> prompt(DOMString input);
  AsyncIterable<StreamToken> promptStreaming(DOMString input);
  Promise<undefined> destroy();
  Promise<AITextSession> clone();
};

// =============================================================================
// Agent Run Types
// =============================================================================

dictionary AgentRunOptions {
  required DOMString task;
  sequence<DOMString> tools;
  DOMString provider;
  boolean useAllTools;
  boolean requireCitations;
  unsigned long maxToolCalls;
  AbortSignal signal;
};

dictionary Citation {
  required DOMString source;  // "tab" | "tool"
  required DOMString ref;
  required DOMString excerpt;
};

dictionary StatusEvent {
  required DOMString type;  // "status"
  required DOMString message;
};

dictionary ToolCallEvent {
  required DOMString type;  // "tool_call"
  required DOMString tool;
  required any args;
};

dictionary ToolResultEvent {
  required DOMString type;  // "tool_result"
  required DOMString tool;
  any result;
  ApiError error;
};

dictionary TokenEvent {
  required DOMString type;  // "token"
  required DOMString token;
};

dictionary FinalEvent {
  required DOMString type;  // "final"
  required DOMString output;
  sequence<Citation> citations;
};

dictionary ErrorEvent {
  required DOMString type;  // "error"
  required ApiError error;
};

typedef (StatusEvent or ToolCallEvent or ToolResultEvent or TokenEvent or FinalEvent or ErrorEvent) RunEvent;

// =============================================================================
// Browser API Types
// =============================================================================

dictionary ActiveTabReadability {
  required DOMString url;
  required DOMString title;
  required DOMString text;
};

// =============================================================================
// Main Interfaces
// =============================================================================

interface LanguageModel {
  Promise<AILanguageModelCapabilities> capabilities();
  Promise<AITextSession> create(optional AILanguageModelCreateOptions options = {});
};

interface Providers {
  Promise<sequence<LLMProviderInfo>> list();
  Promise<ActiveLLMConfig> getActive();
};

interface AIRuntime {
  readonly attribute AI harbor;
  readonly attribute object? firefox;
  readonly attribute object? chrome;
  Promise<DOMString?> getBest();
  Promise<RuntimeCapabilities> getCapabilities();
};

dictionary RuntimeCapabilities {
  FirefoxCapabilities? firefox;
  ChromeCapabilities? chrome;
  HarborCapabilities harbor;
};

dictionary FirefoxCapabilities {
  required boolean available;
  required boolean hasWllama;
  required boolean hasTransformers;
  required boolean supportsTools;
  required sequence<DOMString> models;
};

dictionary ChromeCapabilities {
  required boolean available;
  required boolean supportsTools;
};

dictionary HarborCapabilities {
  required boolean available;
  required boolean bridgeConnected;
  required sequence<DOMString> providers;
};

interface AI {
  Promise<AICapabilityAvailability> canCreateTextSession();
  Promise<AITextSession> createTextSession(optional TextSessionOptions options = {});
  readonly attribute LanguageModel languageModel;
  readonly attribute Providers providers;
  readonly attribute AIRuntime runtime;
};

interface Permissions {
  Promise<PermissionStatus> list();
};

interface Tools {
  Promise<sequence<ToolDescriptor>> list();
  Promise<any> call(ToolCallOptions options);
};

interface ActiveTab {
  Promise<ActiveTabReadability> readability();
};

interface Browser {
  readonly attribute ActiveTab activeTab;
};

interface Agent {
  Promise<PermissionGrantResult> requestPermissions(RequestPermissionsOptions options);
  readonly attribute Permissions permissions;
  readonly attribute Tools tools;
  readonly attribute Browser browser;
  AsyncIterable<RunEvent> run(AgentRunOptions options);
};

partial interface Window {
  readonly attribute AI ai;
  readonly attribute Agent agent;
};
```

---

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| **Malicious website abusing AI** | All operations require explicit user consent |
| **Unauthorized tool access** | Tools are namespaced; users can allowlist specific tools per-origin |
| **Data exfiltration via AI** | No automatic data sharing; content must be explicitly passed to prompts |
| **Prompt injection attacks** | Mitigated by system prompts; users responsible for input sanitization |
| **Cross-origin attacks** | Permissions strictly scoped to origin |
| **Session hijacking** | Session IDs are origin-bound and validated on each request |

### Permission Enforcement

```
┌───────────────────────────────────────────────────────────────────────┐
│                           Request Pipeline                             │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. Web Page Request                                                   │
│     └─► Origin extracted from sender                                  │
│                                                                        │
│  2. Content Script                                                     │
│     └─► Validates message format                                      │
│     └─► Attaches verified origin                                      │
│                                                                        │
│  3. Background Script                                                  │
│     └─► Checks DENY grants → Reject immediately                       │
│     └─► Checks ALWAYS grants → Proceed                                │
│     └─► Checks ONCE grants → Check expiry & tab → Proceed/Reject     │
│     └─► Missing? → Return ERR_SCOPE_REQUIRED                          │
│                                                                        │
│  4. Tool Calls (additional layer)                                      │
│     └─► Check tool allowlist for origin                               │
│     └─► Reject if tool not in allowlist                               │
│                                                                        │
└───────────────────────────────────────────────────────────────────────┘
```

### Rate Limiting

To prevent runaway agent loops or abuse:

| Limit | Default | Purpose |
|-------|---------|---------|
| `maxCallsPerRun` | 5 | Prevent infinite tool loops |
| `maxConcurrentPerOrigin` | 2 | Fair resource sharing |
| `defaultTimeoutMs` | 30,000 | Prevent hanging calls |

### Secure Defaults

- **No default tool access**: `mcp:tools.call` grants access to NO tools by default
- **Explicit allowlisting**: Users must select which tools each origin can use
- **No cross-origin leakage**: Sessions and permissions are strictly isolated
- **Privileged pages blocked**: Cannot read from `about:`, `chrome:`, or extension pages

---

## Privacy Considerations

### Data Flow

Implementations SHOULD support local-first AI backends where data never leaves the user's machine:

```
┌──────────────┐    prompts/args     ┌──────────────┐
│   Web Page   │ ──────────────────► │Implementation│
│              │ ◄────────────────── │  (browser)   │
└──────────────┘    responses        └──────┬───────┘
                                            │
                         ┌──────────────────┼──────────────────┐
                         ▼                  ▼                  ▼
                  ┌──────────┐      ┌──────────────┐    ┌──────────┐
                  │  Local   │      │ MCP Servers  │    │  Cloud   │
                  │  LLM     │      │  (tools)     │    │   API    │
                  │          │      │              │    │(optional)│
                  └──────────┘      └──────────────┘    └──────────┘
```

### Privacy Principles

Implementations SHOULD adhere to these principles:

1. **Local-First Option**: Support local LLM backends where no data leaves the machine.

2. **Minimal Telemetry**: Avoid collecting usage data, analytics, or crash reports.

3. **No Payload Logging**: Do not log tool arguments, results, or prompt content.

4. **User Data Control**: 
   - Users control which AI backend is used
   - Users can choose local-only models
   - Session data is not persisted beyond the session

5. **Credential Security**: API keys and secrets should be stored securely.

### Data Retained

| Data | Location | Duration | Purpose |
|------|----------|----------|---------|
| Permissions | `browser.storage.local` | Until revoked | Remember user choices |
| Session history | In-memory | Until session destroyed | Multi-turn conversation |
| Tool allowlists | `browser.storage.local` | Until revoked | Tool access control |

### Data NOT Retained

- Prompt content
- AI responses  
- Tool call arguments/results
- Page content from `activeTab.readability()`

---

## Implementation Notes

This section describes how **Harbor** works. Other implementations may use different architectures.

### Reference Architecture (Harbor)

Harbor uses a multi-process architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                         Web Page                                 │
│  window.ai, window.agent (frozen, non-configurable)             │
└──────────────────────────────┬──────────────────────────────────┘
                               │ postMessage
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Content Script                                │
│  Bridges postMessage ↔ browser.runtime.Port                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ browser.runtime.Port
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Background Script                             │
│  • Permission enforcement                                        │
│  • Session management                                            │
│  • Request routing                                               │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Native Messaging
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Node.js Bridge                                │
│  • MCP server management                                         │
│  • LLM provider abstraction                                      │
│  • Chat orchestration                                            │
│  • Tool routing                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Message Protocol

Messages use length-prefixed JSON frames over native messaging:

```
┌─────────────────┬────────────────────────────────────────┐
│ Length (4 bytes)│ JSON Payload (UTF-8)                   │
│ Little-endian   │ { "type": "...", "request_id": "..." } │
└─────────────────┴────────────────────────────────────────┘
```

### Process Isolation

MCP servers run in isolated child processes to prevent:
- Crashes from affecting the main bridge
- Memory leaks from impacting other servers
- Potential security issues from untrusted server code

### Async Streaming

Streaming responses use the async iterator protocol with queued events:

```javascript
// Internal implementation pattern
return {
  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    const queue: RunEvent[] = [];
    let resolveNext: ((result: IteratorResult<RunEvent>) => void) | null = null;
    let done = false;
    
    // Register listener before sending message (prevents race conditions)
    transport.addStreamListener(requestId, {
      onEvent(event: RunEvent) {
        if (event.type === 'final' || event.type === 'error') {
          done = true;
        }
        if (resolveNext) {
          resolveNext({ done: false, value: event });
          resolveNext = null;
        } else {
          queue.push(event);
        }
      }
    });
    
    return {
      async next(): Promise<IteratorResult<RunEvent>> {
        if (queue.length > 0) {
          return { done: false, value: queue.shift()! };
        }
        if (done) {
          return { done: true, value: undefined };
        }
        return new Promise(resolve => { resolveNext = resolve; });
      }
    };
  }
};
```

---

## Examples

### Complete Example: AI Chat with Tool Access

```html
<!DOCTYPE html>
<html>
<head>
  <title>AI Chat with Tools</title>
</head>
<body>
  <div id="chat"></div>
  <input type="text" id="input" placeholder="Ask something...">
  <button id="send">Send</button>

  <script>
    const chatDiv = document.getElementById('chat');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');

    async function init() {
      // Check if Harbor is available
      if (typeof window.agent === 'undefined') {
        chatDiv.textContent = 'Please install the Harbor extension';
        return;
      }

      // Request permissions upfront
      const perms = await window.agent.requestPermissions({
        scopes: ['model:tools', 'mcp:tools.list', 'mcp:tools.call'],
        reason: 'Chat app needs AI and tool access'
      });

      if (!perms.granted) {
        chatDiv.textContent = 'Permissions required for chat';
        return;
      }

      // List available tools
      const tools = await window.agent.tools.list();
      console.log('Available tools:', tools.map(t => t.name));

      sendBtn.addEventListener('click', sendMessage);
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
      });
    }

    async function sendMessage() {
      const message = input.value.trim();
      if (!message) return;

      input.value = '';
      addMessage('You', message);

      const responseDiv = addMessage('AI', '');
      
      try {
        for await (const event of window.agent.run({ task: message })) {
          switch (event.type) {
            case 'status':
              responseDiv.textContent = `[${event.message}]`;
              break;
            case 'tool_call':
              responseDiv.textContent += `\n[Calling ${event.tool}...]`;
              break;
            case 'token':
              responseDiv.textContent += event.token;
              break;
            case 'final':
              responseDiv.textContent = event.output;
              break;
            case 'error':
              responseDiv.textContent = `Error: ${event.error.message}`;
              break;
          }
        }
      } catch (err) {
        responseDiv.textContent = `Error: ${err.message}`;
      }
    }

    function addMessage(sender, text) {
      const div = document.createElement('div');
      div.innerHTML = `<strong>${sender}:</strong> <span>${text}</span>`;
      chatDiv.appendChild(div);
      return div.querySelector('span');
    }

    init();
  </script>
</body>
</html>
```

### Example: Page Analyzer

```javascript
async function analyzePage() {
  // Request permissions
  const result = await window.agent.requestPermissions({
    scopes: ['model:prompt', 'browser:activeTab.read'],
    reason: 'Analyze current page content'
  });

  if (!result.granted) {
    throw new Error('Permissions required');
  }

  // Get page content
  const tab = await window.agent.browser.activeTab.readability();

  // Create AI session with analysis instructions
  const session = await window.ai.createTextSession({
    systemPrompt: `You are a web page analyzer. Analyze the following aspects:
    1. Main topic
    2. Key points (bullet list)
    3. Sentiment
    4. Reading time estimate
    Be concise.`
  });

  try {
    const analysis = await session.prompt(`
Page URL: ${tab.url}
Page Title: ${tab.title}

Content:
${tab.text.slice(0, 30000)}
    `);

    return {
      url: tab.url,
      title: tab.title,
      analysis
    };
  } finally {
    await session.destroy();
  }
}
```

### Example: Provider Selection

```javascript
// List available providers (requires model:list permission)
await window.agent.requestPermissions({
  scopes: ['model:list'],
  reason: 'App wants to show available AI providers'
});

const providers = await window.ai.providers.list();
console.log('Available providers:');
for (const p of providers) {
  const status = p.available ? '✓' : '✗';
  const active = p.isDefault ? ' (active)' : '';
  console.log(`  ${status} ${p.name}${active}`);
  if (p.models) {
    console.log(`    Models: ${p.models.join(', ')}`);
  }
}

// Get current active provider
const active = await window.ai.providers.getActive();
console.log(`Using: ${active.provider} / ${active.model}`);

// Create session with specific provider
const session = await window.ai.createTextSession({
  provider: 'openai',  // Use OpenAI instead of default
  model: 'gpt-4o',
  systemPrompt: 'Be concise.'
});

// Run agent with specific provider
for await (const event of window.agent.run({
  task: 'Summarize recent news',
  provider: 'anthropic',  // Use Anthropic for this task
  maxToolCalls: 3
})) {
  if (event.type === 'final') {
    console.log(event.output);
  }
}

// Use the best available runtime explicitly
const best = await window.ai.runtime.getBest();
switch (best) {
  case 'firefox':
    // Use Firefox's local AI (private, no network)
    const ffSession = await window.ai.createTextSession({ provider: 'firefox-wllama' });
    break;
  case 'chrome':
    // Use Chrome's on-device AI
    const chromeSession = await window.ai.runtime.chrome.languageModel.create();
    break;
  case 'harbor':
    // Use Harbor's backend (supports tools, multiple providers)
    const harborSession = await window.ai.runtime.harbor.createTextSession();
    break;
}
```

### Example: Tool-Specific Integration

```javascript
// Memory Tool Integration
class AIMemory {
  constructor() {
    this.initialized = false;
  }

  async init() {
    const result = await window.agent.requestPermissions({
      scopes: ['mcp:tools.call'],
      tools: ['memory-server/save_memory', 'memory-server/search_memories']
    });
    
    if (!result.granted) {
      throw new Error('Memory permissions required');
    }
    
    this.initialized = true;
  }

  async save(content, metadata = {}) {
    if (!this.initialized) await this.init();
    
    return window.agent.tools.call({
      tool: 'memory-server/save_memory',
      args: { content, metadata }
    });
  }

  async search(query, limit = 10) {
    if (!this.initialized) await this.init();
    
    return window.agent.tools.call({
      tool: 'memory-server/search_memories',
      args: { query, limit }
    });
  }
}

// Usage
const memory = new AIMemory();
await memory.save('User prefers dark mode', { category: 'preferences' });
const results = await memory.search('user preferences');
```

---

## Comparison with Chrome Prompt API

The Web Agent API's `window.ai` surface is designed for compatibility with Chrome's built-in Prompt API.

### Compatibility

| Feature | Chrome Prompt API | Web Agent API |
|---------|-------------------|---------------|
| `ai.languageModel.create()` | ✓ | ✓ |
| `ai.languageModel.capabilities()` | ✓ | ✓ |
| `session.prompt()` | ✓ | ✓ |
| `session.promptStreaming()` | ✓ | ✓ |
| `session.clone()` | ✓ | ✓ |
| `systemPrompt` | ✓ | ✓ |
| `initialPrompts` | ✓ | ✓ |
| `temperature` | ✓ | ✓ |
| `topK` | ✓ | Mapped to equivalent |

### Extensions

The Web Agent API extends Chrome's API with:

| Feature | Description |
|---------|-------------|
| `window.agent` | Tool calling, browser access, agent runs |
| Provider selection | List and select from multiple AI providers |
| MCP integration | Extensible tool system via Model Context Protocol |

### Unified Usage

```javascript
// Works with both Chrome's built-in AI and Web Agent API implementations
const session = await window.ai.languageModel.create({
  systemPrompt: 'Be helpful'
});
const response = await session.prompt('Hello');

// Web Agent API extension: choose provider explicitly
const session2 = await window.ai.createTextSession({
  provider: 'anthropic',  // Select specific provider
  systemPrompt: 'Be helpful'
});

// Web Agent API extension: agent capabilities
for await (const event of window.agent.run({ task: '...' })) {
  // ...
}
```

---

## Extension: Bring Your Own Chatbot (BYOC)

The BYOC extension allows websites to integrate with the user's own AI chatbot rather than embedding their own AI. This enables:

- **User control**: Users use their preferred AI with their privacy settings
- **No API keys**: Websites don't need to manage AI keys
- **Contextual tools**: Websites provide domain-specific tools via MCP

### Declarative MCP Server Discovery

Websites can declare MCP server availability via HTML `<link>` elements:

```html
<link 
  rel="mcp-server" 
  href="https://shop.example/mcp"
  title="Shop Assistant"
  data-description="Search products, manage cart"
  data-tools="search_products,add_to_cart"
>
```

### New Permission Scopes

| Scope | Description |
|-------|-------------|
| `mcp:servers.register` | Register website MCP servers |
| `chat:open` | Open the browser's chat UI |

### New API Methods

| Method | Description |
|--------|-------------|
| `agent.mcp.discover()` | Get `<link>`-declared MCP servers |
| `agent.mcp.register(options)` | Register a website's MCP server |
| `agent.mcp.unregister(serverId)` | Unregister a server |
| `agent.chat.canOpen()` | Check if chat UI is available |
| `agent.chat.open(options)` | Open browser chat UI with config |
| `agent.chat.close(chatId?)` | Close the chat UI |

### Example

```javascript
// Register website's MCP server
const reg = await window.agent.mcp.register({
  url: 'https://shop.example/mcp',
  name: 'Acme Shop',
  tools: ['search_products', 'add_to_cart'],
});

// Open the user's chatbot with website context
await window.agent.chat.open({
  systemPrompt: 'You are a shopping assistant.',
  style: { accentColor: '#ff9900' },
});
```

See [JS_AI_PROVIDER_API.md](../docs/JS_AI_PROVIDER_API.md) for complete BYOC API reference.

---

## Native Browser AI Providers

The Web Agent API supports native browser AI capabilities when available. These providers run inference directly in the browser without requiring external services, offering improved privacy and reduced latency.

### Supported Native Providers

| Browser | API | Provider ID | Min Version | Capabilities |
|---------|-----|-------------|-------------|--------------|
| Firefox | `browser.trial.ml.wllama` | `firefox-wllama` | 142+ | Chat, streaming, tool calling |
| Firefox | `browser.trial.ml` | `firefox-transformers` | 134+ | Embeddings, classification |
| Chrome | `window.ai.languageModel` | `chrome` | 131+ | Chat, streaming |

### Provider Selection Priority

User choice is always respected first. When no explicit provider is specified, the selection follows this priority:

```
1. User-specified provider (explicit `provider` parameter)
   ↓
2. User's configured default provider
   ↓  
3. Native browser AI (if available and supports the request)
   ↓
4. Bridge providers (Ollama, OpenAI, Anthropic, etc.)
```

### Detection and Availability

```javascript
// Check which native providers are available
const providers = await window.ai.providers.list();

const nativeProviders = providers.filter(p => p.isNative);
console.log('Native providers:', nativeProviders.map(p => p.id));
// Example: ['firefox-wllama', 'firefox-transformers']

// Check specific runtime availability
const best = await window.ai.runtime.getBest();
console.log('Best available:', best);
// Returns: 'firefox' | 'chrome' | 'harbor' | null
```

### Firefox ML Integration

Firefox 134+ includes a built-in ML inference API (`browser.trial.ml`) that Harbor automatically detects and exposes as providers.

**Firefox Transformers.js** (Firefox 134+):
- Uses ONNX runtime via Transformers.js
- Supports embeddings, classification, and small inference tasks
- Models cached in IndexedDB and shared across extensions

**Firefox wllama** (Firefox 142+):
- WebAssembly bindings for llama.cpp
- Full LLM chat completions with streaming
- Supports tool/function calling
- Local inference with no network requests after model download

```javascript
// Use Firefox's native AI explicitly
const session = await window.ai.createTextSession({
  provider: 'firefox-wllama',
  model: 'llama-3.2-1b',
  systemPrompt: 'You are a helpful assistant.'
});

// Or access the Firefox runtime directly
if (window.ai.runtime.firefox) {
  const engine = await window.ai.runtime.firefox.createEngine({
    modelId: 'llama-3.2-1b'
  });
}
```

### Chrome AI Integration

Chrome 131+ includes a built-in Prompt API that Harbor can use as a fallback or explicit provider.

```javascript
// Use Chrome's native AI explicitly
const session = await window.ai.createTextSession({
  provider: 'chrome',
  systemPrompt: 'Be helpful and concise.'
});

// Or access Chrome's API directly
if (window.ai.runtime.chrome) {
  const chromeSession = await window.ai.runtime.chrome.languageModel.create({
    systemPrompt: 'You are helpful.'
  });
}
```

### Split Routing

Harbor supports routing different operations to different providers. This is useful when you want to use native browser AI for chat but need bridge providers for tool-enabled operations.

```javascript
// Chat uses Firefox's local AI
const session = await window.ai.createTextSession({
  provider: 'firefox-wllama'
});
const response = await session.prompt('Hello!');

// Agent tasks use bridge provider with tool support
for await (const event of window.agent.run({
  task: 'Search for recent AI news',
  provider: 'openai',  // Use OpenAI for tool-enabled tasks
  maxToolCalls: 5
})) {
  // ...
}
```

### Graceful Degradation

Harbor automatically handles cases where native AI is unavailable or limited:

| Scenario | Detection | Fallback Behavior |
|----------|-----------|-------------------|
| Firefox < 134 | `browser.trial.ml` undefined | Use bridge providers |
| Firefox 134-141 | `wllama` undefined | Transformers.js for embeddings, bridge for chat |
| Model not downloaded | Provider returns `available: false` | Show download prompt or use bridge |
| Native doesn't support tools | `supportsTools: false` | Route `agent.run()` to bridge |
| Chrome AI unavailable | `window.ai.languageModel` undefined | Use Firefox or bridge |

```javascript
// Check if a provider supports what you need
const providers = await window.ai.providers.list();
const wllama = providers.find(p => p.id === 'firefox-wllama');

if (wllama?.available && wllama?.supportsTools) {
  // Can use Firefox wllama for agent tasks
} else {
  // Fall back to bridge provider
}
```

### LLMProviderInfo Extensions

Native providers include additional fields:

```typescript
interface LLMProviderInfo {
  // ... existing fields ...
  
  isNative: boolean;       // true for browser-native providers
  runtime: 'firefox' | 'chrome' | 'bridge';  // Which runtime provides this
  downloadRequired?: boolean;  // true if model needs to be downloaded first
  downloadProgress?: number;   // 0-100 if currently downloading
}
```

---

## Open Questions

### 1. Streaming API Design

Should streaming use `ReadableStream` instead of `AsyncIterable` for better consistency with Fetch API patterns?

```javascript
// Current (AsyncIterable)
for await (const event of session.promptStreaming(input)) { }

// Alternative (ReadableStream)
const stream = session.promptStreaming(input);
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
}
```

### 2. Tool Schema Introspection

Should there be a way to introspect tool schemas before calling them?

```javascript
const schema = await window.agent.tools.describe('brave-search/search');
// Returns detailed JSON Schema
```

### 3. Session Persistence

Should sessions be persistable across page reloads?

```javascript
const session = await window.ai.createTextSession({ 
  persist: true,
  sessionId: 'my-session-id'
});
```

### 4. Model Selection ✅ IMPLEMENTED

~~Should users be able to specify which model to use?~~

This is now implemented via the `provider` and `model` options:

```javascript
const session = await window.ai.createTextSession({
  provider: 'ollama',     // Choose provider
  model: 'llama3.2:3b'    // Choose specific model
});

// List available providers
const providers = await window.ai.providers.list();
```

### 5. Capability Negotiation (Partial)

Provider capabilities are now queryable via `ai.providers.list()`:

```javascript
const providers = await window.ai.providers.list();
for (const p of providers) {
  console.log(p.id, 'supports tools:', p.supportsTools);
}
```

Open question: Should there be a unified capability query for agent features?

```javascript
const caps = await window.agent.capabilities();
// { tools: true, browser: true, activeProviders: 3, ... }
```

---

## Appendix: Error Codes Reference

| Code | Description | When Thrown |
|------|-------------|-------------|
| `ERR_NOT_INSTALLED` | Extension not installed | Any API call without extension |
| `ERR_PERMISSION_DENIED` | User denied permission | Permission prompt rejected |
| `ERR_USER_GESTURE_REQUIRED` | Needs user interaction | `activeTab.read` without gesture |
| `ERR_SCOPE_REQUIRED` | Missing required permission | API call without required scope |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist | `tools.call` with blocked tool |
| `ERR_TOOL_FAILED` | Tool execution failed | MCP tool error |
| `ERR_MODEL_FAILED` | LLM request failed | Backend unavailable |
| `ERR_NOT_IMPLEMENTED` | Feature not available | `web:fetch` in v1 |
| `ERR_SESSION_NOT_FOUND` | Session was destroyed | Operation on destroyed session |
| `ERR_TIMEOUT` | Request timed out | Slow backend response |
| `ERR_INTERNAL` | Internal error | Unexpected failure |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.3 | January 2026 | Native browser AI providers (Firefox ML, Chrome AI), split routing, `ai.runtime.*` |
| 1.2 | January 2026 | Address Bar API (`agent.addressBar.*`, `agent.commandBar.*`) |
| 1.1 | January 2026 | Added BYOC extension (`agent.mcp.*`, `agent.chat.*`) |
| 1.0 | January 2026 | Initial specification |

---

*This document is a draft proposal for the Web Agent API. For an implementation, see [Harbor](../).*

