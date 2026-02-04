# Web Agent API Reference

This document is a detailed reference for the **[Web Agent API](../spec/)** — the JavaScript APIs exposed to web pages for AI agent capabilities.

Harbor is an implementation of this proposal. For the full specification, see [spec/explainer.md](../spec/explainer.md).

> **Building with an AI coding assistant?** See **[LLMS.txt](./LLMS.txt)** — a compact, token-efficient reference designed specifically for Claude, Cursor, Copilot, and other AI tools. It contains everything an AI assistant needs to write working code quickly.

## Overview

When the Web Agent API is available (e.g., via Harbor), two global objects are exposed on web pages:

- `window.ai` - Text generation API (Chrome Prompt API compatible)
- `window.agent` - Tools, browser access, and autonomous agent capabilities

## Availability

```javascript
// Check if Web Agent API is available
if (typeof window.agent !== 'undefined') {
  console.log('Web Agent API is available');
}

// Wait for the provider to be ready (Harbor-specific)
window.addEventListener('harbor-provider-ready', () => {
  console.log('Harbor is ready');
});
```

---

## Permission System

All API calls require permission from the user. Permissions are scoped per-origin.

### Permission Scopes

| Scope | Description | Required For |
|-------|-------------|--------------|
| `model:prompt` | Generate text using AI models | `ai.createTextSession()` |
| `model:tools` | Use AI with tool calling | `agent.run()` |
| `model:list` | List configured AI providers | `ai.providers.list()`, `ai.providers.getActive()` |
| `mcp:tools.list` | List available MCP tools | `agent.tools.list()` |
| `mcp:tools.call` | Execute MCP tools | `agent.tools.call()` |
| `mcp:servers.register` | Register website MCP servers | `agent.mcp.register()` |
| `browser:activeTab.read` | Read content from active tab | `agent.browser.activeTab.readability()` |
| `chat:open` | Open browser's chat UI | `agent.chat.open()` |
| `web:fetch` | Proxy fetch requests | Not implemented in v1 |
| `addressBar:suggest` | Provide address bar suggestions | `agent.addressBar.registerProvider()` |
| `addressBar:context` | Access current tab context | Smart navigation features |
| `addressBar:history` | Access recent navigation history | Personalized suggestions |
| `addressBar:execute` | Execute actions from address bar | Tool invocation |

### Permission Grants

| Grant | Meaning |
|-------|---------|
| `granted-always` | Persisted permission for this origin |
| `granted-once` | Temporary permission (expires after ~10 minutes or tab close) |
| `denied` | User explicitly denied (won't re-prompt) |
| `not-granted` | Never requested |

---

## window.agent

### agent.requestPermissions(options)

Request permission scopes from the user. Shows a permission prompt if needed.

**Signature:**
```typescript
agent.requestPermissions(options: {
  scopes: PermissionScope[];
  reason?: string;
}): Promise<PermissionGrantResult>
```

**Parameters:**
- `scopes` - Array of permission scope strings to request
- `reason` - Optional human-readable explanation shown in the prompt

**Returns:**
```typescript
interface PermissionGrantResult {
  granted: boolean;  // true if ALL requested scopes were granted
  scopes: Record<PermissionScope, PermissionGrant>;
}
```

**Example:**
```javascript
const result = await window.agent.requestPermissions({
  scopes: ['model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'This app needs AI capabilities to help you write code.',
});

if (result.granted) {
  console.log('All permissions granted');
} else {
  // Check individual scopes
  if (result.scopes['model:prompt'] === 'denied') {
    console.log('User denied text generation');
  }
}
```

---

### agent.permissions.list()

Get current permission status for this origin.

**Signature:**
```typescript
agent.permissions.list(): Promise<PermissionStatus>
```

**Returns:**
```typescript
interface PermissionStatus {
  origin: string;
  scopes: Record<PermissionScope, PermissionGrant>;
}
```

**Example:**
```javascript
const status = await window.agent.permissions.list();
console.log('Origin:', status.origin);

for (const [scope, grant] of Object.entries(status.scopes)) {
  console.log(`${scope}: ${grant}`);
}
```

---

### agent.tools.list()

List all available tools from connected MCP servers.

**Requires:** `mcp:tools.list` permission

**Signature:**
```typescript
agent.tools.list(): Promise<ToolDescriptor[]>
```

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
  console.log(`  Server: ${tool.serverId}`);
}

// Example output:
// Tool: memory-server/save_memory
//   Description: Save a memory to long-term storage
//   Server: memory-server
// Tool: filesystem/read_file
//   Description: Read contents of a file
//   Server: filesystem
```

---

### agent.tools.call(options)

Execute a specific MCP tool.

**Requires:** `mcp:tools.call` permission

**Signature:**
```typescript
agent.tools.call(options: {
  tool: string;
  args: Record<string, unknown>;
}): Promise<unknown>
```

**Parameters:**
- `tool` - Fully qualified tool name in format `"serverId/toolName"`
- `args` - Arguments matching the tool's input schema

**Returns:** The tool's result (type depends on the tool)

**Throws:** Error with `code: 'ERR_TOOL_FAILED'` if tool execution fails

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
const fileContent = await window.agent.tools.call({
  tool: 'filesystem/read_file',
  args: { path: '/path/to/file.txt' }
});

// Search the web
const searchResults = await window.agent.tools.call({
  tool: 'brave-search/search',
  args: { query: 'latest AI news', count: 5 }
});
```

---

### agent.browser.activeTab.readability()

Extract readable text content from the currently active browser tab.

**Requires:** `browser:activeTab.read` permission

**Signature:**
```typescript
agent.browser.activeTab.readability(): Promise<ActiveTabReadability>
```

**Returns:**
```typescript
interface ActiveTabReadability {
  url: string;    // Full URL of the active tab
  title: string;  // Document title
  text: string;   // Extracted readable text (max 50,000 chars)
}
```

**Throws:** 
- `ERR_PERMISSION_DENIED` if the tab is a privileged page (about:, chrome:, etc.)
- `ERR_INTERNAL` if content extraction fails

**Example:**
```javascript
const tab = await window.agent.browser.activeTab.readability();

console.log('URL:', tab.url);
console.log('Title:', tab.title);
console.log('Content preview:', tab.text.slice(0, 500));

// Use as context for AI
const response = await session.prompt(
  `Based on this article:\n\n${tab.text}\n\nSummarize the key points.`
);
```

---

### agent.run(options)

Run an autonomous agent task with access to tools. Returns an async iterator of events.

**Built-in Tool Router:** The agent automatically analyzes your task and selects only relevant tools based on keywords. For example, mentioning "GitHub" or "repo" will only present GitHub-related tools to the LLM. This dramatically improves performance with local models by reducing cognitive load.

**Requires:** `model:tools` permission, plus `mcp:tools.list` and `mcp:tools.call` for tool access

**Signature:**
```typescript
agent.run(options: {
  task: string;
  tools?: string[];
  provider?: string;
  useAllTools?: boolean;
  requireCitations?: boolean;
  maxToolCalls?: number;
  signal?: AbortSignal;
}): AsyncIterable<RunEvent>
```

**Parameters:**
- `task` - The task description / user request
- `tools` - Optional array of allowed tool names (overrides the router)
- `provider` - Optional LLM provider to use (e.g., 'openai', 'anthropic')
- `useAllTools` - If true, disable the tool router and use all available tools
- `requireCitations` - If true, include source citations in final output
- `maxToolCalls` - Maximum tool invocations (default: 5)
- `signal` - AbortSignal to cancel the run

**Event Types:**
```typescript
type RunEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown; error?: ApiError }
  | { type: 'token'; token: string }
  | { type: 'final'; output: string; citations?: Citation[] }
  | { type: 'error'; error: ApiError }

interface Citation {
  source: 'tab' | 'tool';
  ref: string;      // Tool name or URL
  excerpt: string;  // Relevant excerpt
}
```

**Example:**
```javascript
// Basic agent run
for await (const event of window.agent.run({ task: 'What is the weather in Paris?' })) {
  switch (event.type) {
    case 'status':
      console.log('Status:', event.message);
      break;
    case 'tool_call':
      console.log('Calling tool:', event.tool, event.args);
      break;
    case 'tool_result':
      console.log('Tool result:', event.result);
      break;
    case 'token':
      process.stdout.write(event.token);  // Stream output
      break;
    case 'final':
      console.log('\n\nFinal:', event.output);
      break;
    case 'error':
      console.error('Error:', event.error.message);
      break;
  }
}
```

**Example with tool filtering:**
```javascript
// Only allow specific tools (overrides the router)
for await (const event of window.agent.run({
  task: 'Save a note about this meeting',
  tools: ['memory-server/save_memory', 'memory-server/search_memories'],
  maxToolCalls: 3,
})) {
  // handle events...
}
```

**Example disabling the tool router:**
```javascript
// Use ALL available tools (bypass the intelligent routing)
for await (const event of window.agent.run({
  task: 'Help me with this complex task',
  useAllTools: true,  // Disable router, present all tools to LLM
  maxToolCalls: 10,
})) {
  // handle events...
}
```

**Example with abort:**
```javascript
const controller = new AbortController();

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30000);

for await (const event of window.agent.run({
  task: 'Research this topic thoroughly',
  signal: controller.signal,
})) {
  // handle events...
}
```

---

## Bring Your Own Chatbot (BYOC)

The BYOC APIs allow websites to integrate with the user's own AI chatbot instead of embedding their own. Websites can declare MCP servers that provide domain-specific tools, and request the browser to open its chat UI.

### `<link rel="mcp-server">` — Declarative MCP Server Discovery

Websites can declare MCP server availability via HTML, similar to RSS feeds:

```html
<link 
  rel="mcp-server" 
  href="https://shop.example/mcp"
  title="Shop Assistant"
  data-description="Search products, manage cart"
  data-tools="search_products,get_cart,add_to_cart"
  data-transport="sse"
>
```

**Attributes:**

| Attribute | Required | Description |
|-----------|----------|-------------|
| `rel` | ✓ | Must be `"mcp-server"` |
| `href` | ✓ | URL of the MCP server endpoint |
| `title` | ✓ | Human-readable name |
| `data-description` | | Description of capabilities |
| `data-tools` | | Comma-separated tool names |
| `data-transport` | | `"sse"` (default) or `"websocket"` |

---

### agent.mcp.discover()

Get MCP servers declared via `<link rel="mcp-server">` on the current page.

**Signature:**
```typescript
agent.mcp.discover(): Promise<DeclaredMCPServer[]>
```

**Returns:**
```typescript
interface DeclaredMCPServer {
  url: string;
  title: string;
  description?: string;
  tools?: string[];
  transport?: 'sse' | 'websocket';
}
```

**Example:**
```javascript
const servers = await window.agent.mcp.discover();

for (const server of servers) {
  console.log(`Found: ${server.title} at ${server.url}`);
  console.log(`  Tools: ${server.tools?.join(', ')}`);
}
```

---

### agent.mcp.register(options)

Register a website's MCP server for the user's chatbot to use.

**Requires:** `mcp:servers.register` permission

**Signature:**
```typescript
agent.mcp.register(options: MCPServerRegistration): Promise<MCPRegistrationResult>
```

**Parameters:**
```typescript
interface MCPServerRegistration {
  url: string;          // Server endpoint (HTTPS or localhost)
  name: string;         // Human-readable name
  description?: string; // What the server provides
  tools?: string[];     // Tool names for transparency
  transport?: 'sse' | 'websocket';
}
```

**Returns:**
```typescript
interface MCPRegistrationResult {
  success: boolean;
  serverId?: string;
  error?: {
    code: 'USER_DENIED' | 'INVALID_URL' | 'CONNECTION_FAILED' | 'NOT_SUPPORTED';
    message: string;
  };
}
```

**Example:**
```javascript
const result = await window.agent.mcp.register({
  url: 'https://shop.example/mcp',
  name: 'Acme Shop Assistant',
  description: 'Search products and manage cart',
  tools: ['search_products', 'add_to_cart', 'get_cart'],
});

if (result.success) {
  console.log('Registered with ID:', result.serverId);
} else if (result.error?.code === 'USER_DENIED') {
  console.log('User declined - show fallback UI');
}
```

---

### agent.mcp.unregister(serverId)

Unregister a previously registered MCP server.

**Signature:**
```typescript
agent.mcp.unregister(serverId: string): Promise<{ success: boolean }>
```

**Example:**
```javascript
await window.agent.mcp.unregister(result.serverId);
```

---

### agent.chat.canOpen()

Check if the browser's chat UI can be opened.

**Signature:**
```typescript
agent.chat.canOpen(): Promise<ChatAvailability>
```

**Returns:**
```typescript
type ChatAvailability = 'readily' | 'no';
```

**Example:**
```javascript
const availability = await window.agent.chat.canOpen();

if (availability === 'readily') {
  showChatButton();
} else {
  showFallbackHelp();
}
```

---

### agent.chat.open(options?)

Open the browser's chat UI with optional configuration.

**Requires:** `chat:open` permission

**Signature:**
```typescript
agent.chat.open(options?: ChatOpenOptions): Promise<ChatOpenResult>
```

**Parameters:**
```typescript
interface ChatOpenOptions {
  initialMessage?: string;   // Message to start with
  systemPrompt?: string;     // Configure AI behavior
  tools?: string[];          // Which tools to enable
  sessionId?: string;        // For persistence across pages
  style?: {
    theme?: 'light' | 'dark' | 'auto';
    accentColor?: string;
    position?: 'right' | 'left' | 'center';
  };
}
```

**Returns:**
```typescript
interface ChatOpenResult {
  success: boolean;
  chatId?: string;
  error?: {
    code: 'USER_DENIED' | 'NOT_AVAILABLE' | 'ALREADY_OPEN';
    message: string;
  };
}
```

**Example:**
```javascript
const result = await window.agent.chat.open({
  systemPrompt: 'You are a helpful shopping assistant for Acme Shop.',
  tools: ['search_products', 'add_to_cart'],
  style: {
    theme: 'light',
    accentColor: '#ff9900',
  },
});

if (result.success) {
  console.log('Chat opened:', result.chatId);
}
```

---

### agent.chat.close(chatId?)

Close the browser's chat UI.

**Signature:**
```typescript
agent.chat.close(chatId?: string): Promise<{ success: boolean }>
```

**Example:**
```javascript
await window.agent.chat.close();
```

---

### Complete BYOC Example

```javascript
async function initShopAssistant() {
  // Check if Web Agent API is available
  if (typeof window.agent === 'undefined') {
    showTraditionalHelp();
    return;
  }

  // Request permissions
  const perms = await window.agent.requestPermissions({
    scopes: ['mcp:servers.register', 'chat:open', 'model:prompt'],
    reason: 'Acme Shop wants to provide AI shopping assistance',
  });

  if (!perms.granted) {
    showTraditionalHelp();
    return;
  }

  // Register our MCP server
  const reg = await window.agent.mcp.register({
    url: 'https://shop.example/mcp',
    name: 'Acme Shop',
    tools: ['search_products', 'get_cart', 'add_to_cart'],
  });

  if (!reg.success) {
    showTraditionalHelp();
    return;
  }

  // Show chat button
  document.getElementById('chat-btn').addEventListener('click', async () => {
    await window.agent.chat.open({
      systemPrompt: 'You are a helpful shopping assistant.',
      style: { accentColor: '#ff9900' },
    });
  });
}

initShopAssistant();
```

---

## window.ai

### ai.createTextSession(options?)

Create a new text generation session. Sessions maintain conversation history.

**Requires:** `model:prompt` permission

**Signature:**
```typescript
ai.createTextSession(options?: TextSessionOptions): Promise<TextSession>
```

**Parameters:**
```typescript
interface TextSessionOptions {
  model?: string;        // Model identifier (default: "default")
  provider?: string;     // Provider identifier (e.g., 'openai', 'anthropic', 'ollama')
  temperature?: number;  // Sampling temperature 0.0-2.0
  top_p?: number;        // Nucleus sampling 0.0-1.0
  systemPrompt?: string; // System prompt for the session
}
```

**Provider Selection:**
- If `provider` is not specified, the default (active) provider is used
- Use `ai.providers.list()` to see available providers
- Use `ai.providers.getActive()` to see the current default

**Returns:**
```typescript
interface TextSession {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
}
```

**Example:**
```javascript
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful coding assistant. Be concise.',
  temperature: 0.7,
});

console.log('Session created:', session.sessionId);
```

**Example with specific provider:**
```javascript
// Use a specific LLM provider
const session = await window.ai.createTextSession({
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  systemPrompt: 'You are Claude, a helpful AI assistant.',
});

const response = await session.prompt('Explain quantum computing');
```

---

### ai.providers.list()

List all configured LLM provider instances and their availability.

**Multi-Instance Support:** Harbor supports multiple instances of the same provider type. For example, you can have two different OpenAI accounts configured with different API keys and names.

**Requires:** `model:list` permission

**Signature:**
```typescript
ai.providers.list(): Promise<LLMProviderInfo[]>
```

**Returns:**
```typescript
interface LLMProviderInfo {
  id: string;              // Unique instance ID (e.g., 'openai-work', 'firefox-wllama')
  type: string;            // Provider type: 'openai', 'anthropic', 'ollama', 'firefox', 'chrome'
  name: string;            // User-defined or native display name
  available: boolean;      // Whether the provider is currently accessible
  baseUrl?: string;        // Custom API endpoint (bridge providers only)
  models?: string[];       // Available model IDs
  isDefault: boolean;      // Whether this is the global default provider
  isTypeDefault: boolean;  // Whether this is the default for its provider type
  supportsTools?: boolean; // Whether it supports tool calling
  
  // Native provider fields (Firefox ML, Chrome AI)
  isNative?: boolean;      // true for browser-native providers
  runtime?: 'firefox' | 'chrome' | 'bridge';  // Which runtime provides this
  downloadRequired?: boolean;  // true if model needs download first
  downloadProgress?: number;   // 0-100 if currently downloading
}
```

**Provider Types:**

| Type | Runtime | Description |
|------|---------|-------------|
| `openai` | bridge | OpenAI API (cloud) |
| `anthropic` | bridge | Anthropic Claude API (cloud) |
| `ollama` | bridge | Ollama local server |
| `llamafile` | bridge | llamafile local server |
| `firefox` | firefox | Firefox native ML (local) |
| `chrome` | chrome | Chrome built-in AI (local) |

**Provider Selection Logic:**
- If you specify `provider: 'openai-work'` (an instance ID), that specific instance is used
- If you specify `provider: 'openai'` (a type), the type default is used
- If you have only one instance of a type, it's automatically the type default
- If no provider is specified, the global default is used

**Example:**
```javascript
// First request the permission
await window.agent.requestPermissions({
  scopes: ['model:list'],
  reason: 'To show available AI providers',
});

// List all provider instances
const providers = await window.ai.providers.list();

console.log('Available providers:');
for (const provider of providers) {
  const status = provider.available ? '✓' : '✗';
  const defaultMark = provider.isDefault ? ' (global default)' : 
                      provider.isTypeDefault ? ` (${provider.type} default)` : '';
  console.log(`  ${status} ${provider.name} [${provider.type}]${defaultMark}`);
}

// Example output:
// ✓ Work OpenAI [openai] (global default)
// ✓ Personal OpenAI [openai]
// ✓ Ollama Local [ollama] (ollama default)
```

---

### ai.providers.getActive()

Get the currently active (default) provider and model.

**Requires:** `model:list` permission

**Signature:**
```typescript
ai.providers.getActive(): Promise<ActiveLLMConfig>
```

**Returns:**
```typescript
interface ActiveLLMConfig {
  provider: string | null;  // Active provider instance ID
  model: string | null;     // Active model ID
}
```

**Example:**
```javascript
const active = await window.ai.providers.getActive();

if (active.provider) {
  console.log(`Using ${active.provider} with model ${active.model}`);
} else {
  console.log('No LLM provider configured');
}
```

---

### ai.providers.add(options)

Add a new provider instance.

**Requires:** `model:list` permission

**Signature:**
```typescript
ai.providers.add(options: {
  type: string;      // Provider type: 'openai', 'anthropic', 'ollama', etc.
  name: string;      // User-defined display name
  apiKey?: string;   // API key (for cloud providers)
  baseUrl?: string;  // Custom API endpoint
}): Promise<{ id: string }>
```

**Returns:** The unique instance ID for the new provider

**Example:**
```javascript
// Add a second OpenAI account
const result = await window.ai.providers.add({
  type: 'openai',
  name: 'Personal OpenAI',
  apiKey: 'sk-...',
});

console.log('Added provider with ID:', result.id);
// Output: Added provider with ID: openai-a1b2c3
```

---

### ai.providers.remove(instanceId)

Remove a provider instance.

**Requires:** `model:list` permission

**Signature:**
```typescript
ai.providers.remove(instanceId: string): Promise<void>
```

**Example:**
```javascript
await window.ai.providers.remove('openai-a1b2c3');
```

---

### ai.providers.setDefault(instanceId)

Set the global default provider instance.

**Requires:** `model:list` permission

**Signature:**
```typescript
ai.providers.setDefault(instanceId: string): Promise<void>
```

**Example:**
```javascript
// Make 'openai-work' the default provider
await window.ai.providers.setDefault('openai-work');
```

---

### ai.providers.setTypeDefault(instanceId)

Set an instance as the default for its provider type. This is used when you specify just the type (e.g., `provider: 'openai'`) rather than a specific instance ID.

**Requires:** `model:list` permission

**Signature:**
```typescript
ai.providers.setTypeDefault(instanceId: string): Promise<void>
```

**Example:**
```javascript
// Make 'openai-personal' the default when 'openai' is specified
await window.ai.providers.setTypeDefault('openai-personal');

// Now this will use 'openai-personal':
const session = await window.ai.createTextSession({ provider: 'openai' });
```

---

## Native Browser AI Providers

Harbor supports native browser AI capabilities when available. These run inference directly in the browser without requiring external services.

### Supported Native Providers

| Browser | Provider ID | Min Version | Capabilities |
|---------|-------------|-------------|--------------|
| Firefox | `firefox-wllama` | 142+ | Chat, streaming, tool calling |
| Firefox | `firefox-transformers` | 134+ | Embeddings, classification |
| Chrome | `chrome` | 131+ | Chat, streaming |

### ai.runtime

The `ai.runtime` namespace provides direct access to specific AI backends.

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `harbor` | `AIApi` | Direct access to Harbor's bridge API |
| `firefox` | `object \| null` | Firefox's `browser.trial.ml` API (if available) |
| `chrome` | `object \| null` | Chrome's built-in AI API (if available) |

---

### ai.runtime.getBest()

Get the best available AI backend. Respects user preferences when configured.

**Signature:**
```typescript
ai.runtime.getBest(): Promise<'firefox' | 'chrome' | 'harbor' | null>
```

**Selection Priority:**
1. User's configured default (if set)
2. Firefox wllama (if available, for privacy-first local inference)
3. Chrome AI (if available)
4. Harbor bridge (if connected)

**Example:**
```javascript
const best = await window.ai.runtime.getBest();
console.log('Best available backend:', best);

switch (best) {
  case 'firefox':
    console.log('Using Firefox local AI');
    break;
  case 'chrome':
    console.log('Using Chrome on-device AI');
    break;
  case 'harbor':
    console.log('Using Harbor bridge');
    break;
}
```

---

### ai.runtime.getCapabilities()

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
    hasWllama: boolean;       // Firefox 142+ LLM support
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
    providers: string[];      // Connected bridge providers
  };
}
```

**Example:**
```javascript
const caps = await window.ai.runtime.getCapabilities();

if (caps.firefox?.hasWllama) {
  console.log('Firefox wllama available with models:', caps.firefox.models);
}

if (caps.chrome?.available) {
  console.log('Chrome AI available');
}

if (caps.harbor.bridgeConnected) {
  console.log('Bridge providers:', caps.harbor.providers);
}
```

---

### Using Native Providers

**Firefox wllama (Firefox 142+):**
```javascript
// Use Firefox's native LLM
const session = await window.ai.createTextSession({
  provider: 'firefox-wllama',
  model: 'llama-3.2-1b',
  systemPrompt: 'You are a helpful assistant.'
});

const response = await session.prompt('Hello!');

// Or access Firefox ML API directly
if (window.ai.runtime.firefox) {
  const engine = await window.ai.runtime.firefox.createEngine({
    modelId: 'llama-3.2-1b'
  });
}
```

**Chrome AI (Chrome 131+):**
```javascript
// Use Chrome's native AI
const session = await window.ai.createTextSession({
  provider: 'chrome',
  systemPrompt: 'Be helpful and concise.'
});

// Or access Chrome API directly
if (window.ai.runtime.chrome) {
  const chromeSession = await window.ai.runtime.chrome.languageModel.create({
    systemPrompt: 'You are helpful.'
  });
}
```

---

### Split Routing

Harbor supports routing different operations to different providers. Use native browser AI for simple chat while using bridge providers for tool-enabled operations.

```javascript
// Chat uses Firefox's local AI (private, fast)
const session = await window.ai.createTextSession({
  provider: 'firefox-wllama'
});
const response = await session.prompt('Hello!');

// Agent tasks use bridge provider with full tool support
for await (const event of window.agent.run({
  task: 'Search for recent AI news and summarize',
  provider: 'openai',  // Use OpenAI for tool-enabled tasks
  maxToolCalls: 5
})) {
  if (event.type === 'final') {
    console.log(event.output);
  }
}
```

---

### Graceful Degradation

Harbor automatically handles cases where native AI is unavailable:

| Scenario | Detection | Fallback |
|----------|-----------|----------|
| Firefox < 134 | `firefox: null` in capabilities | Use bridge |
| Firefox 134-141 | `hasWllama: false` | Transformers.js for embeddings, bridge for chat |
| Model not downloaded | `downloadRequired: true` | Show prompt or use bridge |
| Native doesn't support tools | `supportsTools: false` | Route `agent.run()` to bridge |

```javascript
// Check before using native provider
const providers = await window.ai.providers.list();
const wllama = providers.find(p => p.id === 'firefox-wllama');

if (wllama?.available && !wllama?.downloadRequired) {
  // Ready to use
  const session = await window.ai.createTextSession({ provider: 'firefox-wllama' });
} else if (wllama?.downloadRequired) {
  // Model needs to be downloaded first
  console.log('Firefox AI requires model download');
  // Fall back to bridge
  const session = await window.ai.createTextSession({ provider: 'ollama' });
} else {
  // Not available, use bridge
  const session = await window.ai.createTextSession();
}
```

---

### session.prompt(input)

Send a prompt and get the complete response.

**Signature:**
```typescript
session.prompt(input: string): Promise<string>
```

**Parameters:**
- `input` - The user message / prompt

**Returns:** The complete assistant response as a string

**Example:**
```javascript
const session = await window.ai.createTextSession();

// First turn
const response1 = await session.prompt('What is TypeScript?');
console.log(response1);

// Follow-up (session remembers context)
const response2 = await session.prompt('How does it compare to JavaScript?');
console.log(response2);
```

---

### session.promptStreaming(input)

Send a prompt and stream the response token by token.

**Signature:**
```typescript
session.promptStreaming(input: string): AsyncIterable<StreamToken>
```

**Parameters:**
- `input` - The user message / prompt

**Yields:**
```typescript
interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;       // The token text (when type === 'token')
  error?: ApiError;     // Error details (when type === 'error')
}
```

**Example:**
```javascript
const session = await window.ai.createTextSession();

let fullResponse = '';

for await (const event of session.promptStreaming('Write a haiku about coding')) {
  if (event.type === 'token') {
    process.stdout.write(event.token);
    fullResponse += event.token;
  } else if (event.type === 'error') {
    console.error('Error:', event.error.message);
    break;
  }
  // type === 'done' means streaming is complete
}

console.log('\n\nFull response:', fullResponse);
```

---

### session.destroy()

Clean up the session and free resources.

**Signature:**
```typescript
session.destroy(): Promise<void>
```

**Example:**
```javascript
const session = await window.ai.createTextSession();

try {
  const response = await session.prompt('Hello!');
  console.log(response);
} finally {
  await session.destroy();
}
```

---

## Error Handling

All API methods can throw errors with the following structure:

```typescript
interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

type ApiErrorCode =
  | 'ERR_NOT_INSTALLED'        // Extension not installed
  | 'ERR_PERMISSION_DENIED'    // User denied permission
  | 'ERR_USER_GESTURE_REQUIRED'// Needs user interaction (click)
  | 'ERR_SCOPE_REQUIRED'       // Missing required permission scope
  | 'ERR_TOOL_NOT_ALLOWED'     // Tool not in allowlist
  | 'ERR_TOOL_FAILED'          // Tool execution failed
  | 'ERR_MODEL_FAILED'         // LLM request failed
  | 'ERR_NOT_IMPLEMENTED'      // Feature not available
  | 'ERR_SESSION_NOT_FOUND'    // Session was destroyed
  | 'ERR_TIMEOUT'              // Request timed out
  | 'ERR_INTERNAL'             // Internal error
```

**Example error handling:**
```javascript
try {
  const tools = await window.agent.tools.list();
} catch (err) {
  switch (err.code) {
    case 'ERR_SCOPE_REQUIRED':
      console.log('Need to request mcp:tools.list permission first');
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

## Common Patterns

### Initialize with Permissions

```javascript
async function initWebAgentAPI() {
  // Check if Web Agent API is available
  if (typeof window.agent === 'undefined') {
    throw new Error('Web Agent API not available');
  }
  
  // Request all needed permissions upfront
  const result = await window.agent.requestPermissions({
    scopes: [
      'model:prompt',
      'model:tools', 
      'mcp:tools.list',
      'mcp:tools.call'
    ],
    reason: 'This app uses AI to help you with tasks.',
  });
  
  if (!result.granted) {
    throw new Error('Required permissions not granted');
  }
  
  return true;
}
```

### Chat with Optional Tools

```javascript
async function chat(message, useTools = false) {
  if (useTools) {
    // Use agent.run for tool-enabled responses
    let response = '';
    
    for await (const event of window.agent.run({ task: message })) {
      if (event.type === 'token') {
        response += event.token;
      } else if (event.type === 'final') {
        return event.output;
      } else if (event.type === 'error') {
        throw new Error(event.error.message);
      }
    }
    
    return response;
  } else {
    // Use simple text session
    const session = await window.ai.createTextSession();
    try {
      return await session.prompt(message);
    } finally {
      await session.destroy();
    }
  }
}
```

### Use Active Tab as Context

```javascript
async function askAboutCurrentPage(question) {
  // Get tab content
  const tab = await window.agent.browser.activeTab.readability();
  
  // Create session with context
  const session = await window.ai.createTextSession({
    systemPrompt: `You are analyzing a web page. Answer questions based on the content provided.`
  });
  
  try {
    const prompt = `
Page URL: ${tab.url}
Page Title: ${tab.title}

Page Content:
${tab.text}

---

Question: ${question}
`;
    
    return await session.prompt(prompt);
  } finally {
    await session.destroy();
  }
}
```

### Stream Response to UI

```javascript
async function streamToElement(message, outputElement) {
  outputElement.textContent = '';
  
  const session = await window.ai.createTextSession();
  
  try {
    for await (const event of session.promptStreaming(message)) {
      if (event.type === 'token') {
        outputElement.textContent += event.token;
      }
    }
  } finally {
    await session.destroy();
  }
}
```

### Execute Specific Tool

```javascript
async function saveToMemory(content, tags = []) {
  return await window.agent.tools.call({
    tool: 'memory-server/save_memory',
    args: {
      content,
      metadata: { tags, timestamp: Date.now() }
    }
  });
}

async function searchMemories(query) {
  return await window.agent.tools.call({
    tool: 'memory-server/search_memories', 
    args: { query, limit: 10 }
  });
}
```

### Agent with Progress Callback

```javascript
async function runAgentWithProgress(task, onProgress) {
  const events = [];
  
  for await (const event of window.agent.run({ task, maxToolCalls: 10 })) {
    events.push(event);
    
    // Report progress
    if (event.type === 'status') {
      onProgress({ type: 'status', message: event.message });
    } else if (event.type === 'tool_call') {
      onProgress({ type: 'tool', tool: event.tool, status: 'calling' });
    } else if (event.type === 'tool_result') {
      onProgress({ type: 'tool', tool: event.tool, status: 'done' });
    } else if (event.type === 'token') {
      onProgress({ type: 'token', token: event.token });
    } else if (event.type === 'final') {
      return { output: event.output, citations: event.citations, events };
    } else if (event.type === 'error') {
      throw new Error(event.error.message);
    }
  }
}

// Usage
const result = await runAgentWithProgress(
  'Research the latest developments in AI',
  (progress) => {
    console.log('Progress:', progress);
    updateUI(progress);
  }
);
```

---

## TypeScript Definitions

For TypeScript projects, you can use these type definitions:

```typescript
declare global {
  interface Window {
    ai: {
      createTextSession(options?: TextSessionOptions): Promise<TextSession>;
      providers: {
        list(): Promise<LLMProviderInfo[]>;
        getActive(): Promise<ActiveLLMConfig>;
        add(options: AddProviderOptions): Promise<{ id: string }>;
        remove(instanceId: string): Promise<void>;
        setDefault(instanceId: string): Promise<void>;
        setTypeDefault(instanceId: string): Promise<void>;
      };
      runtime: {
        harbor: AIApi;
        firefox: object | null;  // Firefox browser.trial.ml API
        chrome: object | null;   // Chrome built-in AI API
        getBest(): Promise<'firefox' | 'chrome' | 'harbor' | null>;
        getCapabilities(): Promise<RuntimeCapabilities>;
      };
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
      // BYOC APIs
      mcp: {
        discover(): Promise<DeclaredMCPServer[]>;
        register(options: MCPServerRegistration): Promise<MCPRegistrationResult>;
        unregister(serverId: string): Promise<{ success: boolean }>;
      };
      chat: {
        canOpen(): Promise<ChatAvailability>;
        open(options?: ChatOpenOptions): Promise<ChatOpenResult>;
        close(chatId?: string): Promise<{ success: boolean }>;
      };
      // Address Bar APIs (also available as agent.commandBar)
      addressBar: AddressBarAPI;
      commandBar: AddressBarAPI;  // Alias
    };
  }
}

// Address Bar API
interface AddressBarAPI {
  canProvide(): Promise<'readily' | 'no'>;
  registerProvider(options: AddressBarProviderOptions): Promise<{ providerId: string }>;
  registerToolShortcuts(options: ToolShortcutsOptions): Promise<{ registered: string[] }>;
  registerSiteProvider(options: SiteProviderOptions): Promise<{ providerId: string }>;
  discover(): Promise<DeclaredAddressBarProvider[]>;
  listProviders(): Promise<AddressBarProviderInfo[]>;
  unregisterProvider(providerId: string): Promise<void>;
  setDefaultProvider(providerId: string): Promise<void>;
  getDefaultProvider(): Promise<string | null>;
}

interface AddressBarProviderOptions {
  id: string;
  name: string;
  description: string;
  triggers: AddressBarTrigger[];
  onQuery(context: AddressBarQueryContext): Promise<AddressBarSuggestion[]>;
  onSelect?(suggestion: AddressBarSuggestion): Promise<AddressBarAction>;
}

interface AddressBarTrigger {
  type: 'prefix' | 'keyword' | 'regex' | 'always';
  value: string;
  hint?: string;
}

interface AddressBarQueryContext {
  query: string;
  trigger: AddressBarTrigger;
  currentTab?: {
    url: string;
    title: string;
    domain: string;
  };
  recentHistory?: {
    url: string;
    title: string;
    visitCount: number;
    lastVisit: number;
  }[];
  isTyping: boolean;
  timeSinceLastKeystroke: number;
}

interface AddressBarSuggestion {
  id: string;
  type: 'url' | 'search' | 'tool' | 'action' | 'answer';
  title: string;
  description?: string;
  icon?: string;
  url?: string;
  searchQuery?: string;
  searchEngine?: string;
  tool?: {
    name: string;
    args: Record<string, unknown>;
  };
  action?: AddressBarAction;
  answer?: {
    text: string;
    source?: string;
    copyable?: boolean;
  };
  confidence?: number;
  provider: string;
}

type AddressBarAction =
  | { type: 'navigate'; url: string }
  | { type: 'search'; query: string; engine?: string }
  | { type: 'copy'; text: string; notify?: boolean }
  | { type: 'execute'; tool: string; args: Record<string, unknown> }
  | { type: 'show'; content: string; format: 'text' | 'markdown' | 'html' }
  | { type: 'agent'; task: string; tools?: string[] };

interface ToolShortcutsOptions {
  shortcuts: ToolShortcut[];
  resultHandler: 'inline' | 'popup' | 'navigate' | 'clipboard';
}

interface ToolShortcut {
  trigger: string;
  tool: string;
  description: string;
  examples?: string[];
  argParser?: (query: string) => Record<string, unknown>;
  useLLMParser?: boolean;
  llmParserPrompt?: string;
}

interface SiteProviderOptions {
  origin: string;
  name: string;
  description: string;
  patterns: string[];
  icon?: string;
  endpoint?: string;
  onQuery?: (query: string) => Promise<AddressBarSuggestion[]>;
}

interface DeclaredAddressBarProvider {
  origin: string;
  name: string;
  description?: string;
  endpoint: string;
  patterns: string[];
  icon?: string;
}

interface AddressBarProviderInfo {
  id: string;
  name: string;
  description: string;
  triggers: AddressBarTrigger[];
  isDefault: boolean;
  origin?: string;
}

type PermissionScope =
  | 'model:prompt'
  | 'model:tools'
  | 'model:list'
  | 'mcp:tools.list'
  | 'mcp:tools.call'
  | 'mcp:servers.register'
  | 'browser:activeTab.read'
  | 'chat:open'
  | 'web:fetch'
  | 'addressBar:suggest'
  | 'addressBar:context'
  | 'addressBar:history'
  | 'addressBar:execute';

type PermissionGrant =
  | 'granted-once'
  | 'granted-always'
  | 'denied'
  | 'not-granted';

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
  provider?: string;
  temperature?: number;
  top_p?: number;
  systemPrompt?: string;
}

interface LLMProviderInfo {
  id: string;              // Unique instance ID (e.g., 'openai-work', 'firefox-wllama')
  type: string;            // Provider type: 'openai', 'anthropic', 'firefox', 'chrome', etc.
  name: string;            // User-defined or native display name
  available: boolean;
  baseUrl?: string;
  models?: string[];
  isDefault: boolean;      // Is global default?
  isTypeDefault: boolean;  // Is default for its type?
  supportsTools?: boolean;
  // Native provider fields
  isNative?: boolean;      // true for browser-native providers
  runtime?: 'firefox' | 'chrome' | 'bridge';
  downloadRequired?: boolean;
  downloadProgress?: number;
}

interface ActiveLLMConfig {
  provider: string | null;  // Instance ID of active provider
  model: string | null;
}

// Runtime capabilities
interface RuntimeCapabilities {
  firefox: FirefoxCapabilities | null;
  chrome: ChromeCapabilities | null;
  harbor: HarborCapabilities;
}

interface FirefoxCapabilities {
  available: boolean;
  hasWllama: boolean;       // Firefox 142+ LLM support
  hasTransformers: boolean; // Firefox 134+ embeddings
  supportsTools: boolean;
  models: string[];
}

interface ChromeCapabilities {
  available: boolean;
  supportsTools: boolean;
}

interface HarborCapabilities {
  available: boolean;
  bridgeConnected: boolean;
  providers: string[];      // Connected bridge providers
}

interface AddProviderOptions {
  type: string;       // Provider type: 'openai', 'anthropic', etc.
  name: string;       // User-defined display name
  apiKey?: string;    // API key (for cloud providers)
  baseUrl?: string;   // Custom API endpoint
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
  provider?: string;          // Specify which LLM provider to use
  useAllTools?: boolean;      // Disable tool router, use all tools
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

// BYOC Types
interface DeclaredMCPServer {
  url: string;
  title: string;
  description?: string;
  tools?: string[];
  transport?: 'sse' | 'websocket';
}

interface MCPServerRegistration {
  url: string;
  name: string;
  description?: string;
  tools?: string[];
  transport?: 'sse' | 'websocket';
}

interface MCPRegistrationResult {
  success: boolean;
  serverId?: string;
  error?: {
    code: 'USER_DENIED' | 'INVALID_URL' | 'CONNECTION_FAILED' | 'NOT_SUPPORTED';
    message: string;
  };
}

type ChatAvailability = 'readily' | 'no';

interface ChatOpenOptions {
  initialMessage?: string;
  systemPrompt?: string;
  tools?: string[];
  sessionId?: string;
  style?: {
    theme?: 'light' | 'dark' | 'auto';
    accentColor?: string;
    position?: 'right' | 'left' | 'center';
  };
}

interface ChatOpenResult {
  success: boolean;
  chatId?: string;
  error?: {
    code: 'USER_DENIED' | 'NOT_AVAILABLE' | 'ALREADY_OPEN';
    message: string;
  };
}
```

---

## Address Bar API (Omnibox)

The Address Bar API allows web pages and the extension to provide AI-powered suggestions and tool invocations directly from the browser's URL bar. This enables:

1. **AI Search Enhancement** - Get LLM-powered search suggestions as you type
2. **Smart Navigation** - Context-aware page suggestions based on current tab
3. **Tool Invocation** - Execute MCP tools directly from the URL bar (e.g., `@time`, `@calc`)
4. **Site-Specific Suggestions** - Websites can provide deep-link suggestions for their own content

Both `agent.addressBar` and `agent.commandBar` are provided as aliases for the same API.

### Permission Scopes

| Scope | Description | Required For |
|-------|-------------|--------------|
| `addressBar:suggest` | Provide autocomplete suggestions | `registerProvider()`, `registerToolShortcuts()` |
| `addressBar:context` | Access current tab context | Smart navigation features |
| `addressBar:history` | Access recent navigation history | Personalized suggestions (sensitive) |
| `addressBar:execute` | Execute actions from suggestions | Tool invocation, agent tasks |

---

### agent.addressBar.canProvide()

Check if address bar suggestion integration is available.

**Signature:**
```typescript
agent.addressBar.canProvide(): Promise<'readily' | 'no'>
```

**Returns:** `'readily'` if the browser supports omnibox integration, `'no'` otherwise.

**Example:**
```javascript
const availability = await window.agent.addressBar.canProvide();

if (availability === 'readily') {
  // Can register suggestion providers
  await registerMyProvider();
}
```

---

### agent.addressBar.registerProvider(options)

Register an AI-powered suggestion provider that responds to specific triggers in the address bar.

**Requires:** `addressBar:suggest` permission

**Signature:**
```typescript
agent.addressBar.registerProvider(options: AddressBarProviderOptions): Promise<{ providerId: string }>
```

**Parameters:**
```typescript
interface AddressBarProviderOptions {
  id: string;           // Unique identifier for this provider
  name: string;         // Human-readable name
  description: string;  // Shown in settings/UI
  triggers: AddressBarTrigger[];
  
  // Called when user types matching trigger
  onQuery(context: AddressBarQueryContext): Promise<AddressBarSuggestion[]>;
  
  // Optional: Called when a suggestion is selected
  onSelect?(suggestion: AddressBarSuggestion): Promise<AddressBarAction>;
}

interface AddressBarTrigger {
  type: 'prefix' | 'keyword' | 'regex' | 'always';
  value: string;   // The trigger pattern
  hint?: string;   // Shown in address bar as placeholder
}
```

**Trigger Types:**

| Type | Example | Behavior |
|------|---------|----------|
| `prefix` | `"@ai "` | Activates when user types `@ai ` followed by query |
| `keyword` | `"ai"` | Activates when first word is `ai` |
| `regex` | `"^\\?\\s"` | Activates when input matches regex |
| `always` | N/A | Always receives queries (use sparingly) |

**Returns:**
```typescript
{ providerId: string }  // Use this ID to unregister later
```

**Example - AI Search Enhancement (Use Case 1):**
```javascript
await window.agent.addressBar.registerProvider({
  id: 'ai-search',
  name: 'AI Search',
  description: 'Get AI-powered search suggestions',
  triggers: [
    { type: 'prefix', value: '@ai ', hint: 'Ask AI anything...' },
    { type: 'prefix', value: '? ', hint: 'Quick AI question...' },
  ],
  
  async onQuery(ctx) {
    // Don't query while user is actively typing
    if (ctx.isTyping && ctx.timeSinceLastKeystroke < 300) {
      return [];
    }
    
    const session = await window.ai.createTextSession({
      systemPrompt: 'Generate 5 search query suggestions based on the user input. Return as JSON array of strings.'
    });
    
    try {
      const result = await session.prompt(ctx.query);
      const suggestions = JSON.parse(result);
      
      return suggestions.map((text, i) => ({
        id: `ai-${i}`,
        type: 'search',
        title: text,
        description: 'AI-suggested search',
        url: `https://google.com/search?q=${encodeURIComponent(text)}`,
        confidence: 1 - (i * 0.1),
        provider: 'ai-search'
      }));
    } finally {
      await session.destroy();
    }
  }
});
```

**Example - Smart Navigation (Use Case 2):**
```javascript
await window.agent.addressBar.registerProvider({
  id: 'smart-nav',
  name: 'Smart Navigation',
  description: 'Context-aware page suggestions',
  triggers: [
    { type: 'prefix', value: '@go ', hint: 'Navigate smartly...' },
  ],
  
  async onQuery(ctx) {
    // Use current tab context for relevance
    const currentDomain = ctx.currentTab?.domain;
    const suggestions = [];
    
    // Check recent history for related pages
    if (ctx.recentHistory) {
      const related = ctx.recentHistory
        .filter(h => h.url.includes(ctx.query) || h.title.toLowerCase().includes(ctx.query.toLowerCase()))
        .slice(0, 3);
      
      for (const page of related) {
        suggestions.push({
          id: `history-${page.url}`,
          type: 'url',
          title: page.title,
          description: `Visited ${page.visitCount} times`,
          url: page.url,
          confidence: 0.8,
          provider: 'smart-nav'
        });
      }
    }
    
    // Add AI-generated suggestions
    const session = await window.ai.createTextSession({
      systemPrompt: `Suggest relevant URLs for a user currently on ${currentDomain}. Return JSON array with {title, url}.`
    });
    
    try {
      const result = await session.prompt(`User wants: ${ctx.query}`);
      const aiSuggestions = JSON.parse(result);
      
      for (const s of aiSuggestions.slice(0, 2)) {
        suggestions.push({
          id: `ai-nav-${s.url}`,
          type: 'url',
          title: s.title,
          description: 'AI suggested',
          url: s.url,
          confidence: 0.6,
          provider: 'smart-nav'
        });
      }
    } finally {
      await session.destroy();
    }
    
    return suggestions;
  }
});
```

---

### agent.addressBar.registerToolShortcuts(options)

Register MCP tools as address bar shortcuts for quick invocation.

**Requires:** `addressBar:suggest` and `addressBar:execute` permissions

**Signature:**
```typescript
agent.addressBar.registerToolShortcuts(options: ToolShortcutsOptions): Promise<{ registered: string[] }>
```

**Parameters:**
```typescript
interface ToolShortcutsOptions {
  shortcuts: ToolShortcut[];
  resultHandler: 'inline' | 'popup' | 'navigate' | 'clipboard';
}

interface ToolShortcut {
  trigger: string;          // e.g., "@time", "@calc", "@weather"
  tool: string;             // MCP tool name: "serverId/toolName"
  description: string;      // Shown in suggestions
  examples?: string[];      // Example usages
  
  // How to parse the query into tool arguments
  argParser?: (query: string) => Record<string, unknown>;
  
  // Or use LLM to intelligently parse arguments
  useLLMParser?: boolean;
  llmParserPrompt?: string;  // Custom prompt for LLM parsing
}
```

**Result Handlers:**

| Handler | Behavior |
|---------|----------|
| `inline` | Show result directly in address bar dropdown |
| `popup` | Show result in a small popup near address bar |
| `navigate` | Navigate to a results page |
| `clipboard` | Copy result to clipboard with notification |

**Example - Tool Invocation (Use Case 3):**
```javascript
await window.agent.addressBar.registerToolShortcuts({
  shortcuts: [
    {
      trigger: '@time',
      tool: 'time-wasm/time.now',
      description: 'Get current time',
      examples: ['@time', '@time UTC', '@time America/New_York'],
      argParser: (query) => ({ timezone: query.trim() || 'local' })
    },
    {
      trigger: '@calc',
      tool: 'calculator/evaluate',
      description: 'Calculate expression',
      examples: ['@calc 2+2', '@calc sin(pi/2)', '@calc 15% of 200'],
      argParser: (query) => ({ expression: query })
    },
    {
      trigger: '@weather',
      tool: 'weather/current',
      description: 'Get weather for location',
      examples: ['@weather London', '@weather 90210'],
      useLLMParser: true,
      llmParserPrompt: 'Extract location from: "{query}". Return JSON: {location: string}'
    },
    {
      trigger: '@search',
      tool: 'brave-search/search',
      description: 'Search the web',
      examples: ['@search latest AI news'],
      argParser: (query) => ({ query, count: 5 })
    },
    {
      trigger: '@remember',
      tool: 'memory-server/save_memory',
      description: 'Save a quick note',
      examples: ['@remember buy milk', '@remember meeting at 3pm'],
      argParser: (query) => ({ content: query, metadata: { source: 'addressbar' } })
    }
  ],
  resultHandler: 'inline'  // Show results right in the dropdown
});
```

---

### agent.addressBar.registerSiteProvider(options)

Register a site-specific suggestion provider. Only works for the current origin.

**Requires:** `addressBar:suggest` permission

**Signature:**
```typescript
agent.addressBar.registerSiteProvider(options: SiteProviderOptions): Promise<{ providerId: string }>
```

**Parameters:**
```typescript
interface SiteProviderOptions {
  origin: string;         // Must match window.location.origin
  name: string;           // Human-readable name
  description: string;    // Description of capabilities
  patterns: string[];     // URL patterns this provider handles
  icon?: string;          // Icon URL or data URI
  
  // Either endpoint OR onQuery (not both)
  endpoint?: string;      // URL that accepts POST with {query: string}
  onQuery?: (query: string) => Promise<AddressBarSuggestion[]>;
}
```

**Example - Site-Specific Provider (Use Case 4):**
```javascript
// On docs.example.com
await window.agent.addressBar.registerSiteProvider({
  origin: 'https://docs.example.com',
  name: 'Example Docs Search',
  description: 'Search our documentation',
  patterns: ['docs:*', 'api:*', 'guide:*'],
  icon: '/favicon.ico',
  
  async onQuery(query) {
    // Call your own search API
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const results = await response.json();
    
    return results.map(r => ({
      id: r.id,
      type: 'url',
      title: r.title,
      description: r.excerpt,
      url: r.url,
      icon: r.icon,
      provider: 'docs-search'
    }));
  }
});

// Or use endpoint-based approach
await window.agent.addressBar.registerSiteProvider({
  origin: 'https://shop.example.com',
  name: 'Product Search',
  description: 'Search products',
  patterns: ['product:*', 'buy:*'],
  endpoint: '/api/omnibox-suggestions'  // Server handles the query
});
```

**HTML Declaration (Alternative):**
```html
<!-- Declare provider in HTML for automatic discovery -->
<link 
  rel="addressbar-provider" 
  href="/api/omnibox-suggestions"
  title="Search Our Docs"
  data-description="AI-powered documentation search"
  data-patterns="docs:*,api:*,guide:*"
  data-icon="/favicon.ico"
>
```

---

### agent.addressBar.discover()

Discover address bar providers declared via `<link rel="addressbar-provider">` on the current page.

**Signature:**
```typescript
agent.addressBar.discover(): Promise<DeclaredAddressBarProvider[]>
```

**Returns:**
```typescript
interface DeclaredAddressBarProvider {
  origin: string;
  name: string;
  description?: string;
  endpoint: string;
  patterns: string[];
  icon?: string;
}
```

---

### Query Context

When your `onQuery` handler is called, it receives rich context:

```typescript
interface AddressBarQueryContext {
  // What the user typed (after trigger)
  query: string;
  
  // Which trigger matched
  trigger: AddressBarTrigger;
  
  // Current tab info (requires 'addressBar:context')
  currentTab?: {
    url: string;
    title: string;
    domain: string;
  };
  
  // Recent history (requires 'addressBar:history')
  recentHistory?: {
    url: string;
    title: string;
    visitCount: number;
    lastVisit: number;  // timestamp
  }[];
  
  // Typing state (for debouncing)
  isTyping: boolean;
  timeSinceLastKeystroke: number;  // ms
}
```

---

### Suggestions

Your provider returns an array of suggestions:

```typescript
interface AddressBarSuggestion {
  id: string;           // Unique ID for this suggestion
  
  // Type determines behavior
  type: 'url' | 'search' | 'tool' | 'action' | 'answer';
  
  // Display
  title: string;
  description?: string;
  icon?: string;        // URL or data URI
  
  // For type='url' - navigate to URL
  url?: string;
  
  // For type='search' - perform search
  searchQuery?: string;
  searchEngine?: string;  // 'google', 'duckduckgo', etc.
  
  // For type='tool' - execute MCP tool
  tool?: {
    name: string;                    // "serverId/toolName"
    args: Record<string, unknown>;
  };
  
  // For type='action' - custom action
  action?: AddressBarAction;
  
  // For type='answer' - show inline answer
  answer?: {
    text: string;
    source?: string;
    copyable?: boolean;
  };
  
  // Metadata
  confidence?: number;  // 0-1, affects ranking
  provider: string;     // Which provider generated this
}
```

---

### Actions

When a suggestion is selected, it can trigger various actions:

```typescript
type AddressBarAction =
  | { type: 'navigate'; url: string }
  | { type: 'search'; query: string; engine?: string }
  | { type: 'copy'; text: string; notify?: boolean }
  | { type: 'execute'; tool: string; args: Record<string, unknown> }
  | { type: 'show'; content: string; format: 'text' | 'markdown' | 'html' }
  | { type: 'agent'; task: string; tools?: string[] };  // Trigger agent.run()
```

---

### Management

```typescript
// List all registered providers
agent.addressBar.listProviders(): Promise<AddressBarProviderInfo[]>

// Unregister a provider
agent.addressBar.unregisterProvider(providerId: string): Promise<void>

// Set default provider for unmatched queries
agent.addressBar.setDefaultProvider(providerId: string): Promise<void>

// Get current default
agent.addressBar.getDefaultProvider(): Promise<string | null>
```

---

### Complete Example

```javascript
async function initAddressBarIntegration() {
  // Check availability
  if (await window.agent.addressBar.canProvide() !== 'readily') {
    console.log('Address bar integration not available');
    return;
  }
  
  // Request permissions
  const perms = await window.agent.requestPermissions({
    scopes: ['addressBar:suggest', 'addressBar:execute', 'addressBar:context'],
    reason: 'Enable AI-powered address bar suggestions and tool shortcuts'
  });
  
  if (!perms.granted) {
    console.log('Permissions not granted');
    return;
  }
  
  // Register AI search provider
  const { providerId: aiId } = await window.agent.addressBar.registerProvider({
    id: 'my-ai-search',
    name: 'AI Search',
    description: 'Smart search suggestions',
    triggers: [
      { type: 'prefix', value: '? ', hint: 'Ask anything...' }
    ],
    async onQuery(ctx) {
      if (ctx.query.length < 3) return [];
      
      const session = await window.ai.createTextSession();
      const result = await session.prompt(
        `Generate 3 search suggestions for: "${ctx.query}". Return JSON array of strings.`
      );
      await session.destroy();
      
      return JSON.parse(result).map((text, i) => ({
        id: `q-${i}`,
        type: 'search',
        title: text,
        provider: 'my-ai-search'
      }));
    }
  });
  
  // Register tool shortcuts
  await window.agent.addressBar.registerToolShortcuts({
    shortcuts: [
      {
        trigger: '@time',
        tool: 'time-wasm/time.now',
        description: 'Current time',
        argParser: (q) => ({ timezone: q || 'local' })
      }
    ],
    resultHandler: 'inline'
  });
  
  console.log('Address bar integration ready!');
}

initAddressBarIntegration();
```

---

## Version

This document describes **Web Agent API v1.3** as implemented by **Harbor v1**.

**v1.3 additions:** Native Browser AI Providers (`ai.runtime.*`, Firefox ML, Chrome AI), split routing

**v1.2 additions:** Address Bar API (`agent.addressBar.*`, `agent.commandBar.*`)

**v1.1 additions:** BYOC APIs (`agent.mcp.*`, `agent.chat.*`)