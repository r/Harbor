# Sessions Guide

**Choosing Between `window.ai.createTextSession()` and `agent.sessions.create()`**

Harbor provides two ways to create AI sessions, each designed for different use cases. This guide helps you choose the right one.

---

## Quick Decision Tree

```
Do you need tools, browser access, or explicit limits?
│
├── NO  → Use window.ai.createTextSession()
│         (Simple, Chrome-compatible, LLM-only)
│
└── YES → Use agent.sessions.create()
          (Full capabilities, tool allowlisting, budgets)
```

---

## Summary Table

| Feature | `window.ai.createTextSession()` | `agent.sessions.create()` |
|---------|--------------------------------|---------------------------|
| **Purpose** | Simple text generation | Full agent capabilities |
| **Chrome Prompt API Compatible** | Yes | No |
| **LLM Access** | Yes | Yes |
| **Tool Calling** | No | Yes (allowlisted) |
| **Browser Access** | No | Yes (read, interact, screenshot) |
| **Explicit Limits** | No | Yes (maxToolCalls, TTL) |
| **Session Type** | Implicit | Explicit |
| **Permission Required** | `model:prompt` | Varies by capabilities |
| **Best For** | Chatbots, text generation | Agents, sandboxed execution |

---

## Implicit Sessions (`window.ai`)

### When to Use

- Building a simple chatbot or text completion feature
- You only need LLM prompting (no tools)
- You want Chrome Prompt API compatibility
- You want the simplest possible API

### API

```javascript
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
  model: 'llama3.2:3b',      // Optional: specific model
  provider: 'ollama'          // Optional: specific provider
});

// Simple prompt
const response = await session.prompt('Hello!');

// Streaming
for await (const event of session.promptStreaming('Write a story')) {
  if (event.type === 'token') {
    console.log(event.token);
  }
}

// Clean up
await session.destroy();
```

### Capabilities

Implicit sessions have **default capabilities**:
- **LLM**: Allowed (whichever provider is active or specified)
- **Tools**: Not allowed
- **Browser**: Not allowed
- **Limits**: None (no tool call budget)

### Permission

Requires the `model:prompt` permission. If not already granted, Harbor will auto-request it when you call `createTextSession()`.

---

## Explicit Sessions (`agent.sessions`)

### When to Use

- You need tool calling capabilities
- You need browser access (read pages, interact, screenshots)
- You want to enforce limits (max tool calls, session TTL)
- You're building a sandboxed agent execution environment
- You need fine-grained control over what the session can do

### API

```javascript
const session = await agent.sessions.create({
  name: 'Research Assistant',           // Human-readable name
  reason: 'Help user research topics',  // Shown in permission prompt
  capabilities: {
    llm: {
      provider: 'ollama',               // Optional: specific provider
      model: 'llama3.2:3b'              // Optional: specific model
    },
    tools: [
      'brave-search/search',
      'memory-server/save_memory'
    ],
    browser: ['read', 'screenshot']     // 'read' | 'interact' | 'screenshot'
  },
  limits: {
    maxToolCalls: 10,                   // Budget for tool invocations
    ttlMinutes: 30                      // Session expires after 30 minutes
  },
  options: {
    systemPrompt: 'You are a research assistant.',
    temperature: 0.7
  }
});

// Check granted capabilities
console.log('LLM allowed:', session.capabilities.llm.allowed);
console.log('Tools allowed:', session.capabilities.tools.allowedTools);
console.log('Browser read:', session.capabilities.browser.readActiveTab);

// Use LLM
const response = await session.prompt('What should I research?');

// Call tools (if allowed)
const result = await session.callTool('brave-search/search', { query: 'AI news' });

// Clean up
await session.terminate();
```

### Capabilities

Explicit sessions have **requested capabilities** bounded by the origin's permissions:
- **LLM**: Allowed if requested and origin has `model:prompt`
- **Tools**: Only the allowlisted tools that the origin can access
- **Browser**: Only the requested browser capabilities
- **Limits**: `ttlMinutes` ends the session when it runs out. `maxToolCalls` caps the session's `callTool()` calls: once it's spent, `callTool()` fails with `ERR_BUDGET_EXCEEDED` and the tool doesn't run. A refused call doesn't count, whether the page-side permission or allowlist check refuses it or the policy engine does (a deny rule, or a prompt the person declines). A call whose tool runs and fails does count. A call holds its budget slot while Harbor checks it, so while one call waits on a permission prompt, a parallel call that needs the same last slot fails with `ERR_BUDGET_EXCEEDED` instead of prompting too.

### Permissions

The session's effective capabilities are the **intersection** of:
1. What you request in `capabilities`
2. What the origin has permission to use

For example, if you request `tools: ['brave-search/search', 'filesystem/read_file']` but the origin only has permission for `brave-search/search`, the session will only have access to `brave-search/search`.

Harbor checks that a session is still alive, and belongs to your origin, before every `prompt()` and `promptStreaming()`. A terminated or expired session fails with `ERR_SESSION_NOT_FOUND`.

Each session also keeps its own internal information-flow labels. Output from a site-owned tool, including tool error text, adds the sensitivity labels Harbor assigns to that site. Those labels carry into later tool calls and model prompts, including streaming and ACP prompts. A destination that does not accept them is refused with `ERR_LABEL_FLOW_BLOCKED`. Pages cannot clear these labels or supply trusted labels themselves; separate sessions keep separate label state. This does not associate native browser reads with a session.

---

## Comparison Examples

### Example 1: Simple Chatbot

**Use `window.ai.createTextSession()`** — You only need text generation.

```javascript
// Simple and sufficient
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a friendly chatbot.'
});

const response = await session.prompt(userMessage);
displayMessage(response);
```

### Example 2: Research Agent with Tools

**Use `agent.sessions.create()`** — You need tool access with limits.

```javascript
// Need tools and want to limit tool calls
const session = await agent.sessions.create({
  name: 'Research Agent',
  capabilities: {
    llm: {},
    tools: ['brave-search/search', 'memory-server/save_memory']
  },
  limits: {
    maxToolCalls: 5  // Prevent runaway tool loops
  }
});

// Safe execution with enforced limits
const searchResult = await session.callTool('brave-search/search', {
  query: 'latest AI developments'
});
```

### Example 3: Page Analyzer

**Use `agent.sessions.create()`** — You need browser access.

```javascript
const session = await agent.sessions.create({
  name: 'Page Analyzer',
  capabilities: {
    llm: {},
    browser: ['read', 'screenshot']
  }
});

// Now you can read the active tab within this session's context
```

### Example 4: Chrome-Compatible App

**Use `window.ai.createTextSession()`** — You want code that works with Chrome's built-in AI too.

```javascript
// This code works with both Harbor and Chrome's Prompt API
const session = await window.ai.languageModel.create({
  systemPrompt: 'Be concise.'
});

const response = await session.prompt('Explain quantum computing');
```

---

## Session Management

### Listing Sessions

```javascript
// List all active sessions for this origin
const sessions = await agent.sessions.list();

for (const summary of sessions) {
  console.log(`${summary.sessionId}: ${summary.name || 'Unnamed'}`);
  console.log(`  Type: ${summary.type}`);  // 'implicit' or 'explicit'
  console.log(`  Status: ${summary.status}`);
  console.log(`  Tool calls: ${summary.usage.toolCallCount}`);
}
```

### Getting Session Info

```javascript
const info = await agent.sessions.get(sessionId);
if (info) {
  console.log('Session found:', info.name);
}
```

### Terminating Sessions

```javascript
// For implicit sessions
await session.destroy();

// For explicit sessions
await session.terminate();

// Or by ID
await agent.sessions.terminate(sessionId);
```

---

## Best Practices

1. **Start Simple**: Use `window.ai.createTextSession()` unless you need explicit capabilities.

2. **Request Minimum Capabilities**: Only request the tools and browser access you actually need.

3. **Set Limits**: For explicit sessions, always set `maxToolCalls` to prevent runaway agents.

4. **Clean Up**: Always destroy/terminate sessions when done to free resources.

5. **Handle Errors**: Check if capabilities were actually granted before using them.

```javascript
const session = await agent.sessions.create({
  capabilities: { tools: ['some-tool/action'] }
});

// Check before using
if (session.capabilities.tools.allowed) {
  await session.callTool('some-tool/action', {});
} else {
  console.log('Tool access was not granted');
}
```

---

## Related Documentation

- [Developer Guide](./DEVELOPER_GUIDE.md) — Full API reference
- [Web API Explainer](./HARBOR_WEB_API_EXPLAINER.md) — Detailed API specification
- [Permission Model](./HARBOR_WEB_API_EXPLAINER.md#permission-model) — How permissions work
