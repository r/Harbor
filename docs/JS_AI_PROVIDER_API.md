# Harbor JS AI Provider API Reference

This document describes the JavaScript APIs exposed by the Harbor browser extension to web pages. These APIs enable web applications to use AI models and MCP tools with user consent.

> **For AI Agents:** See [LLMS.txt](./LLMS.txt) for a compact, token-efficient version of this documentation optimized for AI coding assistants.
>
> **Quick Reference:** See [JS_AI_PROVIDER_API_COMPACT.md](./JS_AI_PROVIDER_API_COMPACT.md) for a condensed cheat-sheet version.

## Overview

When the Harbor extension is installed, two global objects are available on any web page:

- `window.ai` - Text generation API (Chrome Prompt API compatible)
- `window.agent` - Tools, browser access, and autonomous agent capabilities

## Availability

```javascript
// Check if Harbor is installed
if (typeof window.agent !== 'undefined') {
  console.log('Harbor is available');
}

// Wait for the provider to be ready
window.addEventListener('harbor-provider-ready', () => {
  console.log('Harbor APIs are ready');
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
| `mcp:tools.list` | List available MCP tools | `agent.tools.list()` |
| `mcp:tools.call` | Execute MCP tools | `agent.tools.call()` |
| `browser:activeTab.read` | Read content from active tab | `agent.browser.activeTab.readability()` |
| `web:fetch` | Proxy fetch requests | Not implemented in v1 |

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
  useAllTools?: boolean;
  requireCitations?: boolean;
  maxToolCalls?: number;
  signal?: AbortSignal;
}): AsyncIterable<RunEvent>
```

**Parameters:**
- `task` - The task description / user request
- `tools` - Optional array of allowed tool names (overrides the router)
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
  temperature?: number;  // Sampling temperature 0.0-2.0
  top_p?: number;        // Nucleus sampling 0.0-1.0
  systemPrompt?: string; // System prompt for the session
}
```

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
async function initHarbor() {
  // Check if Harbor is available
  if (typeof window.agent === 'undefined') {
    throw new Error('Harbor extension not installed');
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
  | 'browser:activeTab.read'
  | 'web:fetch';

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
```

---

## Version

This document describes **Harbor JS AI Provider v1**.

