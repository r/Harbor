# Web Agent API Developer Documentation

**JavaScript APIs injected into web pages for AI agent capabilities.**

The Harbor extension injects two global objects into every web page:

- **`window.ai`** — Text generation (Chrome Prompt API compatible)
- **`window.agent`** — Tools, browser access, sessions, and multi-agent communication

These APIs are gated by feature flags configured in Harbor's sidebar.

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
| `toolCalling` | ✅ On | `agent.run()` |
| `browserInteraction` | ❌ Off | `agent.browser.activeTab.*` (click, fill, scroll); `activeTab.readability()` also works under `browserControl` |
| `browserControl` | ❌ Off | `agent.browser.navigate()`, `agent.browser.tabs.*`, `agent.browser.fetch()` |
| `multiAgent` | ❌ Off | `agent.agents.*` |

Agentic Tool Use (`toolCalling`) is enabled by default when no saved value exists. Saved choices, including an explicit off setting, are preserved. Feature availability does not grant site permissions: model and tool requests still go through the existing permission checks. Browser interaction, browser control and multi-agent features remain off by default.

When a feature is disabled, calling its APIs throws an error with code `ERR_FEATURE_DISABLED`. Harbor checks the setting again when the request arrives, so a page can't reach a disabled feature by messaging the extension directly. Prompts on an existing `window.ai` session are refused once `textGeneration` is off. A session's `callTool()` follows `toolAccess`.

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
  // { textGeneration: true, toolCalling: true, ... }
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

// Streaming response. It yields plain strings, so a failure (such as
// ERR_PERMISSION_DENIED after the site's permission is revoked) throws,
// the same as prompt(). The error has a `code` and a `message`.
try {
  for await (const token of session.promptStreaming('Write a poem')) {
    process.stdout.write(token);
  }
} catch (err) {
  console.error(err.code, err.message);
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

When the person has chosen their own agent instead of Harbor's built-in model, `list()` returns that agent alone, as `{ id, type: 'agent', name, available: true, isDefault: true }`. `getActive()` returns `{ provider: <agent id>, model: null }`, and `listConfiguredModels()` and `getConfiguredModelsMetadata()` return empty lists: the agent picks its own model.

---

## window.agent API

Tools, browser access, sessions, and multi-agent capabilities.

### Permissions

All agent capabilities require user permission. The permission system is **per-origin** — each website must request and be granted permissions separately.

> **Recommended for new code:** call
> [`agent.requestCapabilities()`](#agentrequestcapabilitiesoptions) instead of the
> legacy `requestPermissions` flow. The new API operates in the same
> typed-action vocabulary as the policy engine, so what you ask for,
> what the user sees, and what the audit log records all line up.
> The full design is in
> [`docs/PERMISSIONS.md`](./PERMISSIONS.md). The legacy flow below
> still works and is internally translated into the same engine
> calls, so existing pages keep running.

#### How Permissions Work

1. **Request**: Your page calls `agent.requestPermissions()` with desired scopes
2. **Prompt**: A permission dialog appears showing the origin, requested scopes, and optional reason
3. **User Choice**: User can "Allow" (once or always) or "Deny"
4. **Storage**: Grants are stored in the extension's local storage, keyed by origin
5. **Enforcement**: All API calls check permissions before executing

Behind the scenes, every call from your page now flows through the
**PolicyEngine**, which evaluates the call against typed actions
(`model.prompt.local`, `tool.call`, `browser.read.activeTab`,
`network.egress.cross_origin`, etc.). Origin grants from `requestPermissions` are honored
at Tier 8 of the engine ladder; explicit `deny` rules in the user's
policy still win, and Tier 1–4 safety floors (managed denies,
sensitivity gates, information-flow checks, watchdog containment)
cannot be overridden by any grant. See
[`docs/PERMISSIONS.md`](./PERMISSIONS.md) for the full ladder.

#### Permission Grant Types

| Grant Type | Lifetime | Use Case |
|------------|----------|----------|
| `granted-always` | Persistent until revoked | Trusted sites the user visits frequently |
| `granted-once` | 10 minutes, or until tab closes | One-time tasks, untrusted sites |
| `denied` | Persistent until revoked | User explicitly rejected |
| `not-granted` | N/A | Never requested, or expired |

#### agent.requestPermissions(options)

Request permission scopes from the user. Shows a permission prompt if scopes aren't already granted.

The call waits up to 5 minutes for the person to answer, then rejects with `ERR_TIMEOUT`. If the page stops waiting first, because of that timeout or because the tab closes, Harbor discards the answer, so a late Allow grants nothing.

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
| `agentOrigins` | `string[]` | Required with `agents:crossOrigin`. The sites whose agents you want to reach, such as `"https://example.com"` |

**Response:**

```typescript
interface PermissionGrantResult {
  granted: boolean;              // true if ALL requested scopes were granted
  scopes: Record<PermissionScope, PermissionGrant>;  // Status per scope
  allowedTools: string[];        // Tools the site may call; empty means none
  agentOrigins: string[];        // Sites whose agents the site may reach; empty means none
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
| `browser:tabs.create` | 🔴 High | Open tabs on any site and close them; read them only while they show your own origin's pages |
| `chat:open` | 🟢 Low | Open the chat sidebar |
| `web:fetch` | 🔴 High | Fetch URLs bypassing CORS |
| `agents:crossOrigin` | 🔴 High | Call, message and discover agents on the named other sites |

#### Agents on Other Sites

`agents:crossOrigin` is granted one site at a time. Allowing your page to reach agents on `https://b.example` lets it call, message and discover agents registered by `https://b.example`, and no other site. Each site's grant has its own duration: "Allow once" for one site doesn't extend another site's grant.

Ask up front by naming the sites:

```javascript
const result = await window.agent.requestPermissions({
  scopes: ['agents:crossOrigin'],
  agentOrigins: ['https://b.example'],
  reason: 'Hand research tasks to your notes agent',
});
console.log(result.agentOrigins); // ['https://b.example']
```

A request for `agents:crossOrigin` without `agentOrigins` fails. If you don't ask up front, calling or messaging an agent on a site you have no grant for shows a prompt that names that site.

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

#### agent.requestCapabilities(options)

The recommended replacement for `requestPermissions`. Creates a session
for the capabilities you ask for. Model and tool access need the matching
origin grant first; without one the call fails instead of asking for it. Returns
the session object you can pass to `agent.tools.call`,
`agent.browser.*`, etc.

```javascript
const session = await window.agent.requestCapabilities({
  name: 'Article assistant',
  reason: 'Read the page and propose follow-ups.',
  require: [
    { action: 'model.prompt.local' },
    { action: 'browser.read.activeTab' },
    { action: 'tool.call', server: 'time-wasm', toolNames: ['time.now'] },
  ],
  optional: [
    { action: 'network.egress.cross_origin' },
  ],
  budget: { maxToolCalls: 30, ttlMinutes: 15 },
});

// Use the session like any other.
await session.tools.call('time-wasm', 'time.now', {});
```

Behind the scenes the request becomes a `session.create` call; the
engine grants the intersection of what the user has granted, what
your `require` list asks for, and what your origin policy allows.

To get more authority later — e.g. write access after the user
clicks "Apply" — ask for the grant with `agent.requestPermissions()`, which shows
the user a prompt, then call `agent.requestCapabilities()` again for
a new session. `requestCapabilities()` doesn't ask for grants; it only prompts when
a policy rule or a watchdog restriction calls for it. The
new session is independent; the original session continues with its
narrower scope. Terminate a session when you're done with it.

For the full design, see
[`docs/PERMISSIONS.md`](./PERMISSIONS.md).

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
  return session.prompt(`Summarize: ${content.text}`);
}
```

#### The Permission Prompt

Harbor names the requesting site and highlights the reason it supplied. When a site asks to use a selected agent, Harbor names that agent and explains its access to tools and memory. Requests for other capabilities list the scopes involved. Requested tools can be selected individually.

The person can deny the request, allow it for ten minutes, or grant ongoing access using a separate action below the temporary choice. They can revoke the decision in the sidebar.

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

### Page Tools (Web MCP)

Pages can register JavaScript functions as "page tools" that appear alongside MCP tools. Page tools execute in the page context. The person's agent can call them too (see [Page tools and the person's agent](#page-tools-and-the-persons-agent)).

**Registration API:** `document.modelContext`, as in the [WebMCP draft](https://webmachinelearning.github.io/webmcp/). `navigator.modelContext` is the same object, kept as Harbor's older name.

#### document.modelContext.registerTool(tool, options?)

Register a page tool. Returns a promise that resolves to `undefined`.

```javascript
const registration = new AbortController();

await document.modelContext.registerTool({
  name: 'get_cart_items',
  description: 'Returns the current shopping cart contents',
  inputSchema: {
    type: 'object',
    properties: {
      includeMetadata: { type: 'boolean', description: 'Include product metadata' }
    }
  },
  execute: async (input, { signal }) => {
    const items = document.querySelectorAll('.cart-item');
    return Array.from(items).map(el => ({
      name: el.querySelector('.name')?.textContent,
      price: el.querySelector('.price')?.textContent,
    }));
  },
}, { signal: registration.signal });

// Later: unregister by aborting the signal you registered with
registration.abort();
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | 1–128 ASCII letters, digits, `_`, `-` or `.` |
| `description` | yes | Must not be empty |
| `title` | no | A human-readable name, passed to the agent as MCP's `title` |
| `inputSchema` | no | JSON Schema for the input |
| `outputSchema` | no | JSON Schema for the result. Passed to the agent only when its `type` is `"object"`, as MCP requires; return a matching object |
| `annotations` | no | MCP's tool hints: `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Harbor passes on only these, with the right types. They inform the person's agent; Harbor's own permission and policy checks ignore them |
| `execute(input, { signal })` | yes | `handler` is accepted as an older name |

A `title`, `outputSchema` or `annotations` of the wrong type is left out; the tool still registers. `document.modelContext.tools` lists each tool with the fields Harbor kept.

The promise rejects with:

- `InvalidStateError` for a duplicate name, an invalid name or an empty description.
- `TypeError` when `execute` is missing.
- the signal's abort reason when `options.signal` is already aborted.
- `NotSupportedError` for a non-empty `options.exposedTo`. Harbor doesn't share a page's tools with other origins.

#### navigator.modelContext.addTool(descriptor) / removeTool(name)

`addTool`/`removeTool` are older aliases of `registerTool` and of aborting its signal, kept on `navigator.modelContext`. Both keep working. `addTool` registers synchronously and replaces a tool of the same name; `removeTool(name)` returns `true` if a tool was removed.

```javascript
navigator.modelContext.addTool({ name: 'get_cart_items', description: '…', handler: async () => [] });
navigator.modelContext.removeTool('get_cart_items');
```

#### navigator.modelContext.tools

Read-only snapshot of all registered page tools.

```javascript
const tools = navigator.modelContext.tools;
console.log(`${tools.length} page tools registered`);
```

#### Page tools in agent.tools.list()

Page tools appear in `agent.tools.list()` with `serverId: 'page'` and a `page/` name prefix:

```javascript
const tools = await window.agent.tools.list();
// → [...mcpTools, { name: 'page/get_cart_items', serverId: 'page', description: '...' }]
```

#### Calling page tools

```javascript
// Using the prefixed name (preferred)
const cart = await window.agent.tools.call({
  tool: 'page/get_cart_items',
  args: { includeMetadata: true },
});

// Bare name also works if it matches a registered page tool
const cart2 = await window.agent.tools.call({
  tool: 'get_cart_items',
  args: {},
});
```

Page tool errors produce `ERR_TOOL_FAILED` errors, matching the behavior of MCP tool errors.

#### Page tools and the person's agent

A page's tools also reach the agent work that page starts: `agent.run()`, and `agent.chat.open()` when the person has chosen their own agent. Page chat on Harbor's built-in model sends each message straight to the model, with no tools. The handlers still run in the page; only each tool's name, description and input schema leave it, plus its `title`, `outputSchema` and `annotations` when the page sets them.

- **Harbor's built-in agent** sees them in `agent.run()` as `page:<host>/<tool>`, beside Harbor's installed tools.
- **The person's own ACP agent** (goose, Claude Code, Codex) gets them as an MCP server named after the site's host (for example `tale.example`), alongside the tools of the site's registered MCP servers (as `<server>__<tool>`), which Harbor serves on `127.0.0.1` for that session only. The agent needs to support HTTP MCP servers.
- **No grant of their own.** The grant that lets the page start the run or chat covers them. `mcp:tools.list` and `mcp:tools.call` aren't needed, since those would also open the person's own MCP servers. A policy rule can still refuse them (`tool.list` or `tool.call` on the `page:<host>` server), and every check is in the audit log.
- **Lifetime.** Tools last as long as the page's document. A reload or real navigation drops them, and a call in flight then fails with `ERR_TOOL_FAILED`. A same-document hash or `pushState` change keeps them. A call also fails with `ERR_TOOL_FAILED` when the handler throws (its message is passed on), the result is over 1 MB, or the page doesn't answer within 60 seconds. Calls are never retried.
- **Budget.** An `agent.run`'s `maxToolCalls` counts page tool calls too.
- **Untrusted output.** A tool's result reaches the agent as tool output only, never as instructions. An object result is also sent to an ACP agent as MCP `structuredContent`.
- `window.ai` text sessions never get page tools.

The page sends its current list before `agent.run()` or `agent.chat.open()`, so tools registered just before the call are included. A page that registers no tools sends nothing. See [PAGE_TOOLS_FOR_AGENTS.md](PAGE_TOOLS_FOR_AGENTS.md) for the design.

---

### Autonomous Agent

Run an AI agent that can use tools to accomplish tasks.

**Requires:** `toolCalling` feature flag enabled

#### agent.run(options)

Execute an autonomous agent task. Returns an async iterator of events.

`maxToolCalls` (default 5) caps the tool calls for the whole run, even when the model asks for several in one turn; calls past it don't run, and the model is told. A turn whose tool calls are refused because the site lacks `mcp:tools.call` also counts as one. When the budget is spent, the model gives a final answer without tools.

When the person has chosen their own agent (over the Agent Client Protocol) instead of Harbor's built-in model, `maxToolCalls` is ignored: the agent decides how many tools to use.

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
      console.error('[Error]', event.error.code, event.error.message);
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
| `error` | `error` (`{ code, message }`) | The run failed and is over |

`agent.run()` doesn't throw when a run fails. Every failure arrives as one `error` event, after which the run ends: a refusal before it starts (for example, `ERR_PERMISSION_DENIED` without `model:prompt`), the site's permission being revoked partway through, Harbor's policy engine refusing the tool list or, on Harbor's own model, a model call (`ERR_BLOCKED_BY_POLICY`, `ERR_QUARANTINED`), or a model call failing (`ERR_MODEL_FAILED`).

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

When the person has chosen their own agent instead of Harbor's built-in model, `prompt()` and `promptStreaming()` run on that agent, and `capabilities.llm`'s `provider`, `model` and `temperature` are ignored. The session's `tools` allowlist and `maxToolCalls` still govern `session.callTool()`, the tools your page calls itself. They don't limit the agent's own tools while it answers a prompt: those are the agent's, under its own settings. If the person switches agents, or switches back to the built-in model, a session with model access ends: a prompt gets `ERR_SESSION_NOT_FOUND`, and it no longer appears in `agent.sessions.list()`. Create a new one. A tools-only session isn't affected. Like any session, one that expires or sits idle for an hour ends, and so does its agent.

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
console.log('Content:', content.text);

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

`screenshot()` captures the calling page only. It fails with `ERR_PERMISSION_DENIED` unless the calling tab is the one showing in its window, for example when the page is in a background tab.

#### Browser Control (browserControl)

Tabs open in the calling tab’s window by default. An explicit destination window must have the same private-browsing state. Firefox also preserves the calling tab’s cookie store, including its container. Harbor refuses tab creation if it cannot preserve that context. On Chrome, regular tabs open in a regular window and requests from incognito tabs are refused.

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

// Create a new tab. You can open any site, but you can read the tab only
// while it shows a page on your own origin.
const newTab = await window.agent.browser.tabs.create({
  url: `${location.origin}/report`,
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
    // request.signal aborts if the caller stops waiting
    const res = await fetch('/search?q=' + encodeURIComponent(request.input.query), { signal: request.signal });
    return { results: await res.json() };
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

`unregister()` rejects with `ERR_AGENT_NOT_FOUND` for an id that isn't registered, and for another site's agent, so it doesn't reveal whether that agent exists.

An agent belongs to the page that registered it. When the page leaves its tab (the tab closes, the page reloads or navigates, or the page goes into the back/forward cache), Harbor forgets the agent and its subscriptions. If the person goes Back and the browser restores the page from the back/forward cache, the page registers its agents again without you doing anything: each gets its old id back, and its subscriptions, page tools and `agent.mcp.register()` servers return. Its sessions on the person's own agent (`window.ai` sessions, and `agent.sessions` sessions with a model) keep working too: Harbor keeps each cached page's sessions for up to 30 minutes after it left. They end sooner if the tab closes, or if your site needs the agent slot for a new session (the oldest cached page's go first). Only the same site in the same tab can get an id back, also within 30 minutes. If the browser reloads the page instead, your page's code runs again as on any load.

#### Discovering Agents

```javascript
// Discover agents by capabilities
const { agents, total } = await window.agent.agents.discover({
  capabilities: ['search'],
  tags: ['research'],
  includeSameOrigin: true,
  includeCrossOrigin: false  // true lists agents only on sites you hold an agents:crossOrigin grant for
});

console.log(`Found ${total} agents`);
for (const a of agents) {
  console.log(`${a.name} (${a.id}): ${a.capabilities.join(', ')}`);
}

// List agents registered by pages on this origin
const allAgents = await window.agent.agents.list();
```

`list()` returns an array of `{ id, name, status }` entries for the calling origin, or `[]` when it has no registered agents. It needs the Multi-Agent feature enabled and no discovery grant. Use `discover()` with `agents:discover` to retrieve capabilities and tags.

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
```

`timeout` defaults to 30 seconds and is capped at 5 minutes. If the agent's tab closes, its page reloads, the tab moves to another site, or the page goes into the back/forward cache before it answers, the invocation fails at once with `ERR_AGENT_NOT_FOUND`.

When the caller stops waiting (the invocation times out, or the caller's page goes), the agent's `request.signal` aborts and any answer it sends later is dropped. The page script only passes an agent's own invocations, messages and broadcasts to its handlers.

```javascript
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

A broadcast reaches agents subscribed to that event on your own site, and on other sites you hold an `agents:crossOrigin` grant for (and that Harbor's policy still allows). It never asks about other sites, because there's no single site to ask about. `delivered` counts only the agents it reached. Broadcasting needs `agents:message`, and your page must be registered as an agent.

Messages and broadcasts reach a page agent registered with `acceptsMessages` (the default). If Harbor refuses an agent call, the error keeps Harbor's code, such as `ERR_PERMISSION_DENIED` or `ERR_NOT_REGISTERED`.

#### Where an answer came from

Every answer from an agent says which site's agent sent it, in a `provenance` field:

```javascript
{ source: 'agent', origin: 'https://bank.example', agentId: 'agent-…' }
```

It's on an `invoke()` response, a message passed to `onMessage`, an event passed to a `subscribe()` handler, each pipeline step in `stepResults`, each parallel task in `taskResults`, a route's `invocationResult` and each supervisor task in `results`. Harbor fills it in from the site that registered the agent, after the agent answers, so an agent can't claim to be another site's. It's missing only when Harbor answered instead of an agent: the agent wasn't found, a check refused the call, or it timed out.

Harbor doesn't decide how sensitive an answer is. `provenance` tells you, and any agent or model you pass the answer to, whose it is, so you and it can decide. Pass it along with the answer if you hand the answer on.

#### Orchestration Patterns

An orchestration call can run for up to 30 minutes; each step keeps its own 30-second invocation timeout. If the page stops waiting, no further steps start. An orchestration call needs `agents:invoke`. Harbor then checks each step's agent just before that step runs, the same way it checks a direct `invoke`. An agent on another origin needs an `agents:crossOrigin` grant for that agent's site, so the user may be asked partway through a pipeline. A route checks only the agent it picks. If the user refuses a step, a pipeline stops there. In a parallel run, only that task fails.

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

**General**

| Code | Description |
|------|-------------|
| `ERR_PERMISSION_DENIED` | User denied permission, or declined Harbor's prompt for this call — including a missing scope Harbor asked about and the person declined (or couldn't be asked) |
| `ERR_FEATURE_DISABLED` | Feature flag is off |
| `ERR_BLOCKED_BY_POLICY` | A policy rule denied the call (see [PERMISSIONS.md](PERMISSIONS.md)) |
| `ERR_QUARANTINED` | Harbor has quarantined this site; every call is refused until the user resets it |
| `ERR_LABEL_FLOW_BLOCKED` | The policy engine's information-flow check: the call carries a data label (credentials, payments, ...) the destination doesn't accept |
| `ERR_HARBOR_NOT_FOUND` | Harbor extension not found |
| `ERR_TIMEOUT` | Request timed out |
| `ERR_ABORTED` | The page aborted an `agent.run` or a `window.ai` prompt, its tab closed, or its port disconnected |
| `ERR_INVALID_REQUEST` | The request was missing a required parameter or otherwise malformed |
| `ERR_INTERNAL` | Internal error |
| `ERR_NOT_IMPLEMENTED` | The requested method isn't implemented |
| `ERR_ELEMENT_NOT_FOUND` | A browser automation call (`click`, `fill`, `select`) couldn't find the target element |

**Tools, models and sessions**

| Code | Description |
|------|-------------|
| `ERR_TOOL_NOT_FOUND` | Tool does not exist |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist |
| `ERR_TOOL_FAILED` | Tool execution failed, its handler threw, or it didn't answer within 60 seconds |
| `ERR_MODEL_FAILED` | LLM request failed |
| `ERR_SESSION_NOT_FOUND` | Session was destroyed |
| `ERR_BUDGET_EXCEEDED` | A session's `maxToolCalls` budget is spent |

**Agents and multi-agent**

| Code | Description |
|------|-------------|
| `ERR_AGENT_NOT_FOUND` | Agent not registered (or another site's, for `unregister`), or its page went away before answering |
| `ERR_AGENT_NOT_ACCEPTING` | Agent not accepting invocations |
| `ERR_AGENT_FAILED` | The agent loop running `agent.run`, or a `window.ai` text session on the ACP backend, failed — a model call, or (on the ACP backend) a transport failure, an agent exit before it answered, or a JSON-RPC error |
| `ERR_AGENT_REFUSED` | An ACP agent's turn ended with `stopReason: "refusal"` |
| `ERR_AGENT_LIMIT` | An ACP agent's turn ended with `stopReason: "max_tokens"` or `"max_turn_requests"` |
| `ERR_AGENT_BUSY` | Too many ACP agents are already running: this site's own cap (2 at once, counting `agent.run` and `window.ai` text sessions together), or the person's bridge-wide limit |
| `ERR_HANDLER_FAILED` | The page's own invocation handler threw while answering an incoming call |
| `ERR_NOT_REGISTERED` | The caller must register as an agent before sending, broadcasting or orchestrating |
| `ERR_NO_ROUTE` | `orchestrate.route()` matched no route and no default agent |
| `ERR_UNKNOWN_ACTION` | The policy engine has no rule for the requested action |

**Chat and MCP**

| Code | Description |
|------|-------------|
| `ERR_CHAT` | `agent.chat` call failed for a reason other than policy |
| `ERR_CHAT_OPEN` | `agent.chat.open` failed for a reason other than policy |
| `ERR_CHAT_CLOSE` | `agent.chat.close` failed for a reason other than policy |
| `ERR_MCP_DISCOVER` | `agent.mcp.discover` failed for a reason other than policy |
| `ERR_MCP_REGISTER` | `agent.mcp.register` failed for a reason other than policy |
| `ERR_MCP_UNREGISTER` | `agent.mcp.unregister` failed for a reason other than policy |

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
  url: string;
  title: string;
  text: string; // main text, line breaks kept, at most 50,000 characters
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
          readability(tabId: number): Promise<ReadabilityContent>;
          getHtml(tabId: number, selector?: string): Promise<{ html: string; url: string; title: string }>;
          waitForLoad(tabId: number, options?: { timeout?: number }): Promise<void>;
        };
      };
      
      agents: {
        register(options: AgentRegisterOptions): Promise<RegisteredAgent>;
        unregister(agentId?: string): Promise<void>;
        getInfo(agentId: string): Promise<RegisteredAgent | null>;
        discover(query?: AgentDiscoveryQuery): Promise<{ agents: AgentSummary[]; total: number }>;
        list(): Promise<Array<{ id: string; name: string; status: 'active' | 'suspended' | 'terminated' }>>;
        invoke(agentId: string, request: AgentInvocationRequest): Promise<AgentInvocationResponse>;
        send(agentId: string, payload: unknown): Promise<{ delivered: boolean }>;
        onMessage(handler: (message: AgentMessage) => void): () => void;
        onInvoke(handler: (request: AgentInvocationRequest & { from: string; signal: AbortSignal }) => Promise<unknown>): () => void;
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
        
        for await (const token of session.promptStreaming(content.text)) {
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
