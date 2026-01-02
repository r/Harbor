# Harbor JS AI Provider - Compact Reference

Use `window.ai` and `window.agent` when the Harbor browser extension is installed.

> **Full Reference:** See [JS_AI_PROVIDER_API.md](./JS_AI_PROVIDER_API.md) for complete documentation with all options and examples.
>
> **For AI Agents:** See [LLMS.txt](./LLMS.txt) for a token-efficient version optimized for AI coding assistants.

## Quick Check

```javascript
if (window.agent) { /* Harbor available */ }
```

## Permissions (Required First)

```javascript
// Request permissions
const result = await window.agent.requestPermissions({
  scopes: ['model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call', 'browser:activeTab.read'],
  reason: 'Why your app needs these',
});
// result.granted: boolean
// result.scopes: { 'model:prompt': 'granted-always' | 'granted-once' | 'denied' | 'not-granted', ... }

// Check current permissions
const status = await window.agent.permissions.list();
```

## Text Generation (window.ai)

```javascript
// Create session
const session = await window.ai.createTextSession({
  systemPrompt: 'You are helpful.',  // optional
  temperature: 0.7,                   // optional
});

// Simple prompt
const response = await session.prompt('Hello');

// Streaming
for await (const e of session.promptStreaming('Tell me a story')) {
  if (e.type === 'token') console.log(e.token);
  if (e.type === 'done') break;
  if (e.type === 'error') throw e.error;
}

// Cleanup
await session.destroy();
```

## Tools (window.agent)

```javascript
// List all tools
const tools = await window.agent.tools.list();
// Returns: [{ name: 'serverId/toolName', description: '...', inputSchema: {...} }, ...]

// Call a tool
const result = await window.agent.tools.call({
  tool: 'memory-server/save_memory',
  args: { content: 'Remember this' }
});
```

## Browser (window.agent)

```javascript
// Read active tab content
const tab = await window.agent.browser.activeTab.readability();
// Returns: { url: '...', title: '...', text: '...' }
```

## Agent Run (window.agent)

Autonomous task execution with tools. **Tool router is built-in** — it automatically selects relevant tools based on keywords in your task (e.g., "GitHub" → GitHub tools only).

```javascript
for await (const event of window.agent.run({
  task: 'Research AI news and summarize',
  tools: ['search/web_search'],  // optional filter (overrides router)
  useAllTools: false,            // set true to disable router
  maxToolCalls: 5,               // default: 5
  requireCitations: true,        // optional
})) {
  switch (event.type) {
    case 'status':     // { message: string }
    case 'tool_call':  // { tool: string, args: any }
    case 'tool_result':// { tool: string, result: any, error?: ApiError }
    case 'token':      // { token: string }
    case 'final':      // { output: string, citations?: [...] }
    case 'error':      // { error: ApiError }
  }
}
```

## Error Codes

| Code | Meaning |
|------|---------|
| `ERR_PERMISSION_DENIED` | User denied |
| `ERR_SCOPE_REQUIRED` | Missing permission |
| `ERR_TOOL_FAILED` | Tool error |
| `ERR_MODEL_FAILED` | LLM error |
| `ERR_SESSION_NOT_FOUND` | Session destroyed |
| `ERR_TIMEOUT` | Request timeout |

## Complete Example

```javascript
async function main() {
  // 1. Request permissions
  const perm = await window.agent.requestPermissions({
    scopes: ['model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call'],
  });
  if (!perm.granted) throw new Error('Permissions denied');

  // 2. Run agent task
  for await (const e of window.agent.run({ task: 'What tools are available?' })) {
    if (e.type === 'token') process.stdout.write(e.token);
    if (e.type === 'final') console.log('\nDone:', e.output);
    if (e.type === 'error') throw new Error(e.error.message);
  }
}
```

