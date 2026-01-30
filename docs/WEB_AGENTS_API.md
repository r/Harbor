# Web Agents API Developer Documentation

**JavaScript APIs injected into web pages for AI agent capabilities.**

The Web Agents API extension injects two global objects into every web page:

- **`window.ai`** — Text generation (Chrome Prompt API compatible)
- **`window.agent`** — Tools, browser access, sessions, and multi-agent communication

These APIs are gated by feature flags configured in the extension's sidebar.

> **Building with an AI coding assistant?** See **[LLMS.txt](./LLMS.txt)** — a compact, token-efficient reference designed specifically for Claude, Cursor, Copilot, and other AI tools. It contains everything an AI assistant needs to write working code quickly.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Feature Flags](#feature-flags)
3. [Detecting the API](#detecting-the-api)
4. [window.ai API](#windowai-api)
5. [window.agent API](#windowagent-api)
   - [Permissions](#permissions)
   - [Tools](#tools)
   - [Autonomous Agent](#autonomous-agent)
   - [Sessions](#sessions)
   - [Browser APIs](#browser-apis)
   - [Multi-Agent](#multi-agent)
6. [Error Handling](#error-handling)
7. [TypeScript Definitions](#typescript-definitions)
8. [Examples](#examples)

---

## Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <title>Web Agents API Demo</title>
</head>
<body>
  <button id="ask">Ask AI</button>
  <pre id="output"></pre>
  
  <script>
    document.getElementById('ask').onclick = async () => {
      const output = document.getElementById('output');
      
      // 1. Check if API is available
      if (!window.ai || !window.agent) {
        output.textContent = 'Web Agents API not available';
        return;
      }
      
      // 2. Request permission
      const { granted } = await window.agent.requestPermissions({
        scopes: ['model:prompt'],
        reason: 'To answer your question'
      });
      
      if (!granted) {
        output.textContent = 'Permission denied';
        return;
      }
      
      // 3. Create session and prompt
      const session = await window.ai.createTextSession();
      const response = await session.prompt('What is 2 + 2?');
      output.textContent = response;
      
      // 4. Clean up
      session.destroy();
    };
  </script>
</body>
</html>
```

---

## Feature Flags

The extension exposes different APIs based on feature flags. Users control these in the extension sidebar.

| Flag | Default | APIs Enabled |
|------|---------|--------------|
| `textGeneration` | ✅ On | `window.ai.*` |
| `toolAccess` | ✅ On | `agent.tools.list()`, `agent.tools.call()` |
| `toolCalling` | ❌ Off | `agent.run()` |
| `browserInteraction` | ❌ Off | `agent.browser.activeTab.*` (click, fill, scroll) |
| `browserControl` | ❌ Off | `agent.browser.navigate()`, `agent.browser.tabs.*`, `agent.browser.fetch()` |
| `multiAgent` | ❌ Off | `agent.agents.*` |

When a feature is disabled, calling its APIs throws an error with code `ERR_FEATURE_DISABLED`.

---

## Detecting the API

### Check Availability

```javascript
// Basic check
if (window.ai && window.agent) {
  console.log('Web Agents API is available');
}

// Wait for ready event (recommended)
window.addEventListener('agent-ready', (event) => {
  console.log('Version:', event.detail.version);
  console.log('Features:', event.detail.features);
  // { textGeneration: true, toolCalling: false, ... }
});
```

### Feature Detection

```javascript
window.addEventListener('agent-ready', (event) => {
  const { features } = event.detail;
  
  if (features.textGeneration) {
    // Can use window.ai
  }
  
  if (features.toolCalling) {
    // Can use agent.run()
  }
  
  if (features.browserControl) {
    // Can use agent.browser.navigate(), tabs, fetch
  }
});
```

---

## window.ai API

Text generation using local AI models. Compatible with the Chrome Prompt API.

### ai.canCreateTextSession()

Check if a text session can be created.

```javascript
const availability = await window.ai.canCreateTextSession();
// Returns: 'readily' | 'after-download' | 'no'

if (availability === 'readily') {
  const session = await window.ai.createTextSession();
}
```

### ai.createTextSession(options?)

Create a text generation session with conversation history.

```javascript
const session = await window.ai.createTextSession({
  model: 'llama3.2',           // Optional: specific model
  provider: 'ollama',          // Optional: specific provider
  temperature: 0.7,            // Optional: 0.0-2.0
  systemPrompt: 'You are a helpful assistant.'
});

// Simple prompt
const response = await session.prompt('Hello!');
console.log(response);

// Follow-up (maintains conversation context)
const followUp = await session.prompt('Tell me more');

// Streaming response
for await (const token of session.promptStreaming('Write a poem')) {
  process.stdout.write(token);
}

// Clean up when done
session.destroy();
```

### ai.languageModel

Alternative API matching Chrome's `ai.languageModel` interface.

```javascript
// Check capabilities
const caps = await window.ai.languageModel.capabilities();
console.log('Available:', caps.available);
console.log('Default temperature:', caps.defaultTemperature);

// Create session
const session = await window.ai.languageModel.create({
  systemPrompt: 'You are a coding assistant.',
  temperature: 0.5,
  topK: 40
});
```

### ai.providers

List and manage LLM providers.

```javascript
// List available providers
const providers = await window.ai.providers.list();
for (const p of providers) {
  console.log(`${p.name} (${p.type}): ${p.available ? 'ready' : 'unavailable'}`);
  console.log('  Models:', p.models?.join(', '));
}

// Get active provider
const { provider, model } = await window.ai.providers.getActive();
console.log(`Using ${provider} with model ${model}`);
```

---

## window.agent API

Tools, browser access, sessions, and multi-agent capabilities.

### Permissions

All agent capabilities require user permission. The permission system is **per-origin** — each website must request and be granted permissions separately.

#### How Permissions Work

1. **Request**: Your page calls `agent.requestPermissions()` with desired scopes
2. **Prompt**: A permission dialog appears showing the origin, requested scopes, and optional reason
3. **User Choice**: User can "Allow" (once or always) or "Deny"
4. **Storage**: Grants are stored in the extension's local storage, keyed by origin
5. **Enforcement**: All API calls check permissions before executing

#### Permission Grant Types

| Grant Type | Lifetime | Use Case |
|------------|----------|----------|
| `granted-always` | Persistent until revoked | Trusted sites the user visits frequently |
| `granted-once` | 10 minutes, or until tab closes | One-time tasks, untrusted sites |
| `denied` | Persistent until revoked | User explicitly rejected |
| `not-granted` | N/A | Never requested, or expired |

#### agent.requestPermissions(options)

Request permission scopes from the user. Shows a permission prompt if scopes aren't already granted.

```javascript
const result = await window.agent.requestPermissions({
  scopes: [
    'model:prompt',           // Text generation
    'model:tools',            // Use AI with tools
    'mcp:tools.list',         // List available tools
    'mcp:tools.call',         // Execute tools
    'browser:activeTab.read', // Read page content
  ],
  reason: 'To help you with your task',  // Shown in prompt
  tools: ['time-wasm/time.now']           // Specific tools to allowlist
});

if (result.granted) {
  console.log('All permissions granted');
} else {
  // Check individual scopes
  for (const [scope, grant] of Object.entries(result.scopes)) {
    console.log(`${scope}: ${grant}`);
    // grant is: 'granted-once' | 'granted-always' | 'denied' | 'not-granted'
  }
}
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `scopes` | `string[]` | Required. Permission scopes to request |
| `reason` | `string` | Optional. Explanation shown in the permission prompt |
| `tools` | `string[]` | Optional. Specific tools to add to the allowlist |

**Response:**

```typescript
interface PermissionGrantResult {
  granted: boolean;              // true if ALL requested scopes were granted
  scopes: Record<PermissionScope, PermissionGrant>;  // Status per scope
  allowedTools?: string[];       // Tools in the allowlist (if any)
}
```

#### Permission Scopes

| Scope | Risk | Description |
|-------|------|-------------|
| `model:prompt` | 🟢 Low | Generate text using AI models |
| `model:tools` | 🟡 Medium | Use AI with tool calling (agentic loop) |
| `model:list` | 🟢 Low | List available providers and models |
| `mcp:tools.list` | 🟢 Low | List available MCP tools |
| `mcp:tools.call` | 🟡 Medium | Execute MCP tools (may access external services) |
| `mcp:servers.register` | 🟡 Medium | Register website MCP servers (BYOC) |
| `browser:activeTab.read` | 🟡 Medium | Read content from the active tab |
| `browser:activeTab.interact` | 🔴 High | Click, fill forms, scroll on active tab |
| `browser:activeTab.screenshot` | 🟡 Medium | Capture screenshots of the active tab |
| `browser:tabs.read` | 🟡 Medium | List browser tabs |
| `browser:tabs.create` | 🔴 High | Create and control new tabs |
| `chat:open` | 🟢 Low | Open the chat sidebar |
| `web:fetch` | 🔴 High | Fetch URLs bypassing CORS |

#### Tool Allowlisting

When requesting `mcp:tools.call`, you can specify which tools to allowlist:

```javascript
// Request permission for specific tools only
const result = await window.agent.requestPermissions({
  scopes: ['mcp:tools.call'],
  tools: ['time-wasm/time.now', 'memory/save'],
  reason: 'To check the time and save notes'
});

// The permission prompt shows checkboxes for each tool
// User can deselect tools they don't want to allow
console.log('Allowed tools:', result.allowedTools);
```

If tools are specified, the permission prompt displays each tool with a checkbox, allowing users to grant access to specific tools only.

#### agent.permissions.list()

Get current permission status for this origin.

```javascript
const status = await window.agent.permissions.list();
console.log('Origin:', status.origin);
console.log('Scopes:', status.scopes);
console.log('Allowed tools:', status.allowedTools);

// Example output:
// {
//   origin: 'https://example.com',
//   scopes: {
//     'model:prompt': 'granted-always',
//     'mcp:tools.list': 'granted-once',
//     'mcp:tools.call': 'denied'
//   },
//   allowedTools: ['time-wasm/time.now']
// }
```

#### Best Practices

1. **Request minimal scopes**: Only request permissions you actually need
2. **Provide a reason**: Explain why you need each capability
3. **Handle denial gracefully**: Provide fallback functionality when permissions are denied
4. **Check before calling**: Use `permissions.list()` to check status before making API calls
5. **Re-request when needed**: If a `granted-once` permission expires, request it again

```javascript
// Example: Graceful permission handling
async function summarizePage() {
  // Check current permissions
  const { scopes } = await window.agent.permissions.list();
  
  if (scopes['browser:activeTab.read'] !== 'granted-always' && 
      scopes['browser:activeTab.read'] !== 'granted-once') {
    
    // Request permission with explanation
    const result = await window.agent.requestPermissions({
      scopes: ['model:prompt', 'browser:activeTab.read'],
      reason: 'To read and summarize this page'
    });
    
    if (!result.granted) {
      // Fallback: let user paste content manually
      return promptUserToPasteContent();
    }
  }
  
  // Permission granted, proceed
  const content = await window.agent.browser.activeTab.readability();
  const session = await window.ai.createTextSession();
  return session.prompt(`Summarize: ${content.textContent}`);
}
```

#### The Permission Prompt

When you call `requestPermissions()`, users see a popup window containing:

1. **Origin Badge**: The requesting website's origin (e.g., `https://example.com`)
2. **Reason** (if provided): Your explanation of why permissions are needed
3. **Requested Permissions**: Each scope with:
   - Icon (🤖 for model:prompt, ⚡ for mcp:tools.call, etc.)
   - Title (e.g., "Text Generation", "Execute Tools")
   - Description of what it allows
   - Risk badge (low/medium/high)
4. **Tools List** (if tools specified): Checkboxes for each requested tool
5. **Grant Duration**: Radio buttons for "This time only" vs "Always allow"
6. **Action Buttons**: "Deny" and "Allow"

```
┌─────────────────────────────────────────┐
│  [W] Permission Request                 │
├─────────────────────────────────────────┤
│  https://example.com                    │
│                                         │
│  "To help you research this topic"      │
│                                         │
│  REQUESTED PERMISSIONS                  │
│  ┌─────────────────────────────────────┐│
│  │ 🤖 Text Generation          [LOW]  ││
│  │ Generate text using AI models       ││
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │ ⚡ Execute Tools           [MEDIUM] ││
│  │ Call MCP tools to perform actions   ││
│  └─────────────────────────────────────┘│
│                                         │
│  REQUESTED TOOLS                        │
│  ☑ time-wasm/time.now                  │
│  ☑ web-search/search                   │
│                                         │
│  GRANT DURATION                         │
│  ○ This time only  ● Always allow      │
│                                         │
│  [ Deny ]              [ Allow ]        │
└─────────────────────────────────────────┘
```

#### Security Model

- **Origin Isolation**: Permissions are scoped to the requesting origin (scheme + host + port)
- **User Consent**: Every permission requires explicit user action in the prompt
- **Revocation**: Users can revoke permissions at any time via the extension sidebar
- **Expiration**: `granted-once` permissions expire after 10 minutes or when the tab closes
- **Tool Filtering**: Even with `mcp:tools.call`, tools must be in the allowlist to be called
- **No Silent Grants**: There's no way to bypass the permission prompt

#### Managing Permissions (User Side)

Users can manage permissions through the extension sidebar:

- **View granted permissions**: See all origins with active permissions
- **Revoke by origin**: Remove all permissions for a specific website
- **Revoke all**: Clear all permissions across all websites
- **View tool allowlists**: See which tools each origin can access

---

### Tools

Access MCP (Model Context Protocol) tools from connected servers.

**Requires:** `toolAccess` feature flag enabled

#### agent.tools.list()

List all available tools.

```javascript
const tools = await window.agent.tools.list();

for (const tool of tools) {
  console.log(`${tool.name}: ${tool.description}`);
  console.log('  Server:', tool.serverId);
  console.log('  Schema:', JSON.stringify(tool.inputSchema, null, 2));
}
```

#### agent.tools.call(options)

Execute a specific tool.

```javascript
// Call a tool
const result = await window.agent.tools.call({
  tool: 'time-wasm/time.now',
  args: { timezone: 'America/New_York' }
});

console.log('Current time:', result);

// Call with error handling
try {
  const data = await window.agent.tools.call({
    tool: 'filesystem/read_file',
    args: { path: '/tmp/data.json' }
  });
} catch (err) {
  if (err.code === 'ERR_TOOL_NOT_FOUND') {
    console.log('Tool not available');
  }
}
```

---

### Autonomous Agent

Run an AI agent that can use tools to accomplish tasks.

**Requires:** `toolCalling` feature flag enabled

#### agent.run(options)

Execute an autonomous agent task. Returns an async iterator of events.

```javascript
for await (const event of window.agent.run({
  task: 'What is the current time in Tokyo?',
  maxToolCalls: 5,
  systemPrompt: 'You are a helpful assistant.'
})) {
  switch (event.type) {
    case 'thinking':
      console.log('[Thinking]', event.content);
      break;
      
    case 'tool_call':
      console.log(`[Tool] Calling ${event.tool}`, event.args);
      break;
      
    case 'tool_result':
      console.log(`[Tool] Result from ${event.tool}:`, event.result);
      break;
      
    case 'final':
      console.log('[Answer]', event.output);
      break;
      
    case 'error':
      console.error('[Error]', event.error);
      break;
  }
}
```

**Event Types:**

| Type | Properties | Description |
|------|------------|-------------|
| `thinking` | `content` | Agent's reasoning process |
| `tool_call` | `tool`, `args` | Tool being called |
| `tool_result` | `tool`, `result` | Tool execution result |
| `final` | `output` | Final response |
| `error` | `error` | Error message |

---

### Sessions

Create explicit sessions with specific capabilities and limits.

#### agent.sessions.create(options)

Create a session with defined capabilities.

```javascript
const session = await window.agent.sessions.create({
  name: 'Research Assistant',
  reason: 'To help research this topic',
  capabilities: {
    llm: { provider: 'ollama', model: 'llama3.2' },
    tools: ['web-search/search', 'memory/save'],
    browser: ['read', 'screenshot']
  },
  limits: {
    maxToolCalls: 20,
    ttlMinutes: 30
  },
  options: {
    systemPrompt: 'You are a research assistant.',
    temperature: 0.3
  }
});

// Use the session
const response = await session.prompt('Find information about AI safety');
console.log(response);

// Call tools through the session
if (session.capabilities.tools.allowed) {
  const result = await session.callTool('web-search/search', {
    query: 'AI alignment research'
  });
}

// List allowed tools
console.log('Allowed tools:', session.listAllowedTools());

// Streaming
for await (const token of session.promptStreaming('Summarize your findings')) {
  process.stdout.write(token);
}

// Clean up
await session.terminate();
```

#### agent.sessions.list()

List active sessions.

```javascript
const sessions = await window.agent.sessions.list();

for (const s of sessions) {
  console.log(`${s.name || s.sessionId} (${s.status})`);
  console.log(`  Type: ${s.type}`);  // 'implicit' or 'explicit'
  console.log(`  Created: ${new Date(s.createdAt)}`);
  console.log(`  Usage: ${s.usage.promptCount} prompts, ${s.usage.toolCallCount} tool calls`);
}
```

#### agent.sessions.get(sessionId)

Get a specific session.

```javascript
const session = await window.agent.sessions.get('session-id-here');
if (session) {
  console.log('Status:', session.status);
}
```

#### agent.sessions.terminate(sessionId)

Terminate a session.

```javascript
const terminated = await window.agent.sessions.terminate('session-id-here');
console.log('Terminated:', terminated);
```

---

### Browser APIs

Control and read from browser tabs.

#### Active Tab (browserInteraction)

Interact with the current tab. **Requires:** `browserInteraction` feature flag.

```javascript
// Get readable content from the page
const content = await window.agent.browser.activeTab.readability();
console.log('Title:', content.title);
console.log('Content:', content.textContent);

// Get interactive elements
const elements = await window.agent.browser.activeTab.getElements();
for (const el of elements) {
  console.log(`[${el.ref}] ${el.role}: ${el.text || el.placeholder || ''}`);
}

// Click an element
await window.agent.browser.activeTab.click('ref-123');

// Fill a form field
await window.agent.browser.activeTab.fill('ref-456', 'Hello world');

// Select dropdown option
await window.agent.browser.activeTab.select('ref-789', 'option-value');

// Scroll the page
await window.agent.browser.activeTab.scroll('down', 500);  // direction, amount

// Take a screenshot
const { dataUrl } = await window.agent.browser.activeTab.screenshot();
document.getElementById('preview').src = dataUrl;
```

#### Browser Control (browserControl)

Navigate and manage tabs. **Requires:** `browserControl` feature flag.

```javascript
// Navigate to a URL
await window.agent.browser.navigate('https://example.com');

// List all tabs
const tabs = await window.agent.browser.tabs.list();
for (const tab of tabs) {
  console.log(`[${tab.id}] ${tab.title} - ${tab.url}`);
  console.log(`  Active: ${tab.active}, Can control: ${tab.canControl}`);
}

// Create a new tab
const newTab = await window.agent.browser.tabs.create({
  url: 'https://example.com',
  active: false
});

// Wait for tab to load
await window.agent.browser.tab.waitForLoad(newTab.id, { timeout: 10000 });

// Read content from spawned tab
const tabContent = await window.agent.browser.tab.readability(newTab.id);
console.log('Page content:', tabContent.text);

// Get HTML from spawned tab
const { html } = await window.agent.browser.tab.getHtml(newTab.id, 'main');

// Close the tab
await window.agent.browser.tabs.close(newTab.id);

// Fetch URL (bypasses CORS)
const response = await window.agent.browser.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { 'Accept': 'application/json' }
});
console.log('Status:', response.status);
console.log('Body:', response.body);
```

---

### Multi-Agent

Agent-to-agent communication and orchestration.

**Requires:** `multiAgent` feature flag enabled

#### Registering as an Agent

```javascript
// Register this page as an agent
const agent = await window.agent.agents.register({
  name: 'Research Agent',
  description: 'Searches the web and summarizes findings',
  capabilities: ['search', 'summarize'],
  tags: ['research', 'web'],
  acceptsInvocations: true,
  acceptsMessages: true
});

console.log('Registered as:', agent.id);

// Handle incoming invocations
window.agent.agents.onInvoke(async (request) => {
  console.log(`Task from ${request.from}:`, request.task);
  
  if (request.task === 'search') {
    // Do the search...
    return { results: ['result1', 'result2'] };
  }
  
  throw new Error('Unknown task');
});

// Handle incoming messages
window.agent.agents.onMessage((message) => {
  console.log(`Message from ${message.from}:`, message.payload);
});

// Unregister when done
await window.agent.agents.unregister();
```

#### Discovering Agents

```javascript
// Discover agents by capabilities
const { agents, total } = await window.agent.agents.discover({
  capabilities: ['search'],
  tags: ['research'],
  includeSameOrigin: true,
  includeCrossOrigin: false
});

console.log(`Found ${total} agents`);
for (const a of agents) {
  console.log(`${a.name} (${a.id}): ${a.capabilities.join(', ')}`);
}

// List all agents
const allAgents = await window.agent.agents.list();
```

#### Invoking Agents

```javascript
// Invoke another agent
const response = await window.agent.agents.invoke('agent-id-here', {
  task: 'search',
  input: { query: 'AI safety research' },
  timeout: 30000
});

if (response.success) {
  console.log('Result:', response.result);
  console.log('Execution time:', response.executionTime, 'ms');
} else {
  console.error('Failed:', response.error);
}

// Send a message (fire and forget)
const { delivered } = await window.agent.agents.send('agent-id', {
  type: 'notification',
  data: { status: 'complete' }
});
```

#### Event Broadcasting

```javascript
// Subscribe to events
await window.agent.agents.subscribe('research-complete', (event) => {
  console.log(`Event from ${event.source}:`, event.data);
});

// Broadcast an event
const { delivered } = await window.agent.agents.broadcast('research-complete', {
  topic: 'AI safety',
  results: ['...']
});
console.log(`Delivered to ${delivered} agents`);

// Unsubscribe
await window.agent.agents.unsubscribe('research-complete');
```

#### Orchestration Patterns

```javascript
// Pipeline: Execute agents sequentially
const pipelineResult = await window.agent.agents.orchestrate.pipeline({
  steps: [
    { agentId: 'researcher', task: 'research' },
    { agentId: 'writer', task: 'write' },
    { agentId: 'reviewer', task: 'review' }
  ]
}, { topic: 'AI safety' });

console.log('Pipeline result:', pipelineResult.result);
console.log('Step results:', pipelineResult.stepResults);

// Parallel: Execute agents concurrently
const parallelResult = await window.agent.agents.orchestrate.parallel({
  tasks: [
    { agentId: 'agent1', task: 'analyze', input: data },
    { agentId: 'agent2', task: 'validate', input: data },
    { agentId: 'agent3', task: 'enrich', input: data }
  ],
  combineStrategy: 'merge'  // 'array' | 'merge' | 'first'
});

console.log('Combined result:', parallelResult.combined);

// Route: Conditional agent selection
const routeResult = await window.agent.agents.orchestrate.route({
  routes: [
    { condition: 'type:technical', agentId: 'tech-agent' },
    { condition: 'type:creative', agentId: 'creative-agent' }
  ],
  defaultAgentId: 'general-agent'
}, input, 'process');
```

---

## Error Handling

All APIs throw errors with consistent codes.

```javascript
try {
  await window.agent.tools.list();
} catch (err) {
  switch (err.code) {
    case 'ERR_FEATURE_DISABLED':
      console.log('Enable the feature in extension settings');
      break;
    case 'ERR_PERMISSION_DENIED':
      console.log('User denied permission');
      break;
    case 'ERR_SCOPE_REQUIRED':
      await window.agent.requestPermissions({
        scopes: ['mcp:tools.list']
      });
      break;
    case 'ERR_TOOL_NOT_FOUND':
      console.log('Tool does not exist');
      break;
    case 'ERR_TOOL_NOT_ALLOWED':
      console.log('Tool not in allowlist');
      break;
    case 'ERR_TIMEOUT':
      console.log('Request timed out');
      break;
    case 'ERR_HARBOR_NOT_FOUND':
      console.log('Harbor extension not installed');
      break;
    default:
      console.error('Unexpected error:', err.message);
  }
}
```

**Error Codes:**

| Code | Description |
|------|-------------|
| `ERR_FEATURE_DISABLED` | Feature flag is off |
| `ERR_PERMISSION_DENIED` | User denied permission |
| `ERR_SCOPE_REQUIRED` | Missing required scope |
| `ERR_TOOL_NOT_FOUND` | Tool does not exist |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist |
| `ERR_TOOL_FAILED` | Tool execution failed |
| `ERR_MODEL_FAILED` | LLM request failed |
| `ERR_SESSION_NOT_FOUND` | Session was destroyed |
| `ERR_HARBOR_NOT_FOUND` | Harbor extension not found |
| `ERR_AGENT_NOT_FOUND` | Agent not registered |
| `ERR_AGENT_NOT_ACCEPTING` | Agent not accepting invocations |
| `ERR_TIMEOUT` | Request timed out |
| `ERR_INTERNAL` | Internal error |

---

## TypeScript Definitions

```typescript
// Feature flags
interface FeatureFlags {
  textGeneration: boolean;
  toolCalling: boolean;
  toolAccess: boolean;
  browserInteraction: boolean;
  browserControl: boolean;
  multiAgent: boolean;
}

// Permission types
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
  | 'chat:open'
  | 'web:fetch';

type PermissionGrant = 'granted-once' | 'granted-always' | 'denied' | 'not-granted';

interface PermissionGrantResult {
  granted: boolean;
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];
}

// Text session
interface TextSessionOptions {
  model?: string;
  provider?: string;
  temperature?: number;
  systemPrompt?: string;
}

interface TextSession {
  readonly sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
  destroy(): void;
}

// Tools
interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId?: string;
}

// Agent run events
type AgentRunEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: unknown }
  | { type: 'final'; output: string }
  | { type: 'error'; error: string };

// Session capabilities
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

// Browser APIs
interface ReadabilityContent {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
}

interface BrowserElement {
  ref: string;
  role: string;
  text?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

// Multi-agent
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

interface AgentInvocationRequest {
  task: string;
  input?: unknown;
  timeout?: number;
}

interface AgentInvocationResponse {
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  executionTime?: number;
}

interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: 'request' | 'response' | 'event' | 'error';
  payload: unknown;
  correlationId?: string;
  timestamp: number;
}

// Global declarations
declare global {
  interface Window {
    ai: {
      canCreateTextSession(): Promise<'readily' | 'after-download' | 'no'>;
      createTextSession(options?: TextSessionOptions): Promise<TextSession>;
      languageModel: {
        capabilities(): Promise<{
          available: 'readily' | 'after-download' | 'no';
          defaultTopK?: number;
          maxTopK?: number;
          defaultTemperature?: number;
        }>;
        create(options?: TextSessionOptions): Promise<TextSession>;
      };
      providers: {
        list(): Promise<LLMProviderInfo[]>;
        getActive(): Promise<{ provider: string | null; model: string | null }>;
      };
    };
    
    agent: {
      requestPermissions(options: {
        scopes: PermissionScope[];
        reason?: string;
        tools?: string[];
      }): Promise<PermissionGrantResult>;
      
      permissions: {
        list(): Promise<PermissionStatus>;
      };
      
      tools: {
        list(): Promise<ToolDescriptor[]>;
        call(options: { tool: string; args?: Record<string, unknown> }): Promise<unknown>;
      };
      
      run(options: {
        task: string;
        maxToolCalls?: number;
        systemPrompt?: string;
      }): AsyncIterable<AgentRunEvent>;
      
      sessions: {
        create(options: CreateSessionOptions): Promise<AgentSession>;
        get(sessionId: string): Promise<SessionSummary | null>;
        list(): Promise<SessionSummary[]>;
        terminate(sessionId: string): Promise<boolean>;
      };
      
      browser: {
        activeTab: {
          readability(): Promise<ReadabilityContent>;
          getElements(): Promise<BrowserElement[]>;
          click(ref: string): Promise<{ success: boolean }>;
          fill(ref: string, value: string): Promise<{ success: boolean }>;
          scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<{ success: boolean }>;
          select(ref: string, value: string): Promise<{ success: boolean }>;
          screenshot(): Promise<{ dataUrl: string }>;
        };
        navigate(url: string): Promise<{ success: boolean }>;
        fetch(url: string, options?: RequestInit): Promise<{ body: string; status: number; headers: Record<string, string> }>;
        tabs: {
          list(): Promise<TabInfo[]>;
          create(options: { url: string; active?: boolean }): Promise<TabInfo>;
          close(tabId: number): Promise<boolean>;
        };
        tab: {
          readability(tabId: number): Promise<TabReadabilityResult>;
          getHtml(tabId: number, selector?: string): Promise<{ html: string; url: string; title: string }>;
          waitForLoad(tabId: number, options?: { timeout?: number }): Promise<void>;
        };
      };
      
      agents: {
        register(options: AgentRegisterOptions): Promise<RegisteredAgent>;
        unregister(): Promise<void>;
        getInfo(agentId: string): Promise<RegisteredAgent | null>;
        discover(query?: AgentDiscoveryQuery): Promise<{ agents: AgentSummary[]; total: number }>;
        list(): Promise<AgentSummary[]>;
        invoke(agentId: string, request: AgentInvocationRequest): Promise<AgentInvocationResponse>;
        send(agentId: string, payload: unknown): Promise<{ delivered: boolean }>;
        onMessage(handler: (message: AgentMessage) => void): () => void;
        onInvoke(handler: (request: AgentInvocationRequest & { from: string }) => Promise<unknown>): () => void;
        subscribe(eventType: string, handler: (event: { type: string; data: unknown; source: string }) => void): Promise<void>;
        unsubscribe(eventType: string, handler?: Function): Promise<void>;
        broadcast(eventType: string, data: unknown): Promise<{ delivered: number }>;
        orchestrate: {
          pipeline(config: { steps: PipelineStep[] }, initialInput: unknown): Promise<{ success: boolean; result: unknown; stepResults: unknown[] }>;
          parallel(config: { tasks: ParallelTask[]; combineStrategy?: 'array' | 'merge' | 'first' }): Promise<{ success: boolean; results: unknown[]; combined: unknown }>;
          route(config: { routes: Array<{ condition: string; agentId: string }>; defaultAgentId?: string }, input: unknown, task: string): Promise<AgentInvocationResponse>;
        };
      };
    };
  }
  
  interface WindowEventMap {
    'agent-ready': CustomEvent<{
      version: string;
      chromeAiDetected: boolean;
      features: FeatureFlags;
    }>;
  }
}
```

---

## Examples

### Simple Chat Interface

```html
<!DOCTYPE html>
<html>
<head>
  <title>Simple Chat</title>
  <style>
    #chat { max-width: 600px; margin: 20px auto; font-family: sans-serif; }
    #messages { height: 400px; overflow-y: auto; border: 1px solid #ccc; padding: 10px; }
    .user { color: blue; }
    .assistant { color: green; }
    #input { width: 100%; padding: 10px; margin-top: 10px; }
  </style>
</head>
<body>
  <div id="chat">
    <div id="messages"></div>
    <input id="input" placeholder="Type a message..." />
  </div>
  
  <script>
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    let session = null;
    
    function addMessage(role, text) {
      const div = document.createElement('div');
      div.className = role;
      div.textContent = `${role}: ${text}`;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }
    
    async function init() {
      if (!window.ai) {
        addMessage('system', 'Web Agents API not available');
        return;
      }
      
      const { granted } = await window.agent.requestPermissions({
        scopes: ['model:prompt'],
        reason: 'Chat with AI'
      });
      
      if (!granted) {
        addMessage('system', 'Permission denied');
        return;
      }
      
      session = await window.ai.createTextSession({
        systemPrompt: 'You are a helpful assistant. Keep responses concise.'
      });
      
      addMessage('system', 'Ready to chat!');
    }
    
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && session && input.value.trim()) {
        const userMessage = input.value.trim();
        input.value = '';
        
        addMessage('user', userMessage);
        
        // Streaming response
        const responseDiv = document.createElement('div');
        responseDiv.className = 'assistant';
        responseDiv.textContent = 'assistant: ';
        messages.appendChild(responseDiv);
        
        for await (const token of session.promptStreaming(userMessage)) {
          responseDiv.textContent += token;
          messages.scrollTop = messages.scrollHeight;
        }
      }
    });
    
    init();
  </script>
</body>
</html>
```

### Tool-Calling Agent

```html
<!DOCTYPE html>
<html>
<head>
  <title>Tool Agent</title>
</head>
<body>
  <h1>Time Agent</h1>
  <button id="ask">What time is it?</button>
  <pre id="output"></pre>
  
  <script>
    document.getElementById('ask').onclick = async () => {
      const output = document.getElementById('output');
      output.textContent = 'Working...\n';
      
      try {
        // Request permissions
        await window.agent.requestPermissions({
          scopes: ['model:tools', 'mcp:tools.list', 'mcp:tools.call'],
          reason: 'To check the time'
        });
        
        // Run agent
        for await (const event of window.agent.run({
          task: 'What is the current time?',
          maxToolCalls: 3
        })) {
          if (event.type === 'tool_call') {
            output.textContent += `Calling: ${event.tool}\n`;
          }
          if (event.type === 'tool_result') {
            output.textContent += `Result: ${JSON.stringify(event.result)}\n`;
          }
          if (event.type === 'final') {
            output.textContent += `\nAnswer: ${event.output}`;
          }
        }
      } catch (err) {
        output.textContent = `Error: ${err.message}`;
      }
    };
  </script>
</body>
</html>
```

### Page Summarizer

```html
<!DOCTYPE html>
<html>
<head>
  <title>Page Summarizer</title>
</head>
<body>
  <h1>Summarize Current Page</h1>
  <button id="summarize">Summarize</button>
  <div id="summary"></div>
  
  <script>
    document.getElementById('summarize').onclick = async () => {
      const summaryDiv = document.getElementById('summary');
      summaryDiv.textContent = 'Reading page...';
      
      try {
        // Request permissions
        await window.agent.requestPermissions({
          scopes: ['model:prompt', 'browser:activeTab.read'],
          reason: 'To summarize this page'
        });
        
        // Get page content
        const content = await window.agent.browser.activeTab.readability();
        summaryDiv.textContent = `Title: ${content.title}\nAnalyzing...`;
        
        // Create session and summarize
        const session = await window.ai.createTextSession({
          systemPrompt: 'Summarize the following text in 2-3 sentences.'
        });
        
        summaryDiv.textContent = `Title: ${content.title}\n\nSummary: `;
        
        for await (const token of session.promptStreaming(content.textContent)) {
          summaryDiv.textContent += token;
        }
        
        session.destroy();
      } catch (err) {
        summaryDiv.textContent = `Error: ${err.message}`;
      }
    };
  </script>
</body>
</html>
```

### Multi-Agent Research System

```html
<!DOCTYPE html>
<html>
<head>
  <title>Research Agent</title>
</head>
<body>
  <h1>Research Agent</h1>
  <input id="topic" placeholder="Enter research topic" />
  <button id="research">Research</button>
  <pre id="output"></pre>
  
  <script>
    // Register as a research agent
    async function init() {
      if (!window.agent?.agents) {
        document.getElementById('output').textContent = 'Multi-agent not enabled';
        return;
      }
      
      const agent = await window.agent.agents.register({
        name: 'Web Research Agent',
        capabilities: ['search', 'summarize'],
        acceptsInvocations: true
      });
      
      console.log('Registered as:', agent.id);
      
      // Handle invocations from other agents
      window.agent.agents.onInvoke(async (request) => {
        if (request.task === 'search') {
          // Simulate search
          return { results: [`Found info about: ${request.input.query}`] };
        }
        throw new Error('Unknown task');
      });
    }
    
    document.getElementById('research').onclick = async () => {
      const topic = document.getElementById('topic').value;
      const output = document.getElementById('output');
      
      output.textContent = 'Searching for agents...\n';
      
      // Find other agents
      const { agents } = await window.agent.agents.discover({
        capabilities: ['analyze']
      });
      
      output.textContent += `Found ${agents.length} agents\n`;
      
      if (agents.length > 0) {
        // Invoke another agent
        const response = await window.agent.agents.invoke(agents[0].id, {
          task: 'analyze',
          input: { topic },
          timeout: 30000
        });
        
        output.textContent += `Analysis: ${JSON.stringify(response.result)}`;
      }
    };
    
    init();
  </script>
</body>
</html>
```

---

## Related Documentation

- [Developer Guide](./DEVELOPER_GUIDE.md) — Full Harbor developer guide
- [Sessions Guide](./SESSIONS_GUIDE.md) — When to use `window.ai` vs `agent.sessions`
- [JS API Reference](./JS_AI_PROVIDER_API.md) — Detailed API reference
- [Demo Code](../demo/web-agents/) — Working examples

---

**Version:** Web Agents API v1.0
