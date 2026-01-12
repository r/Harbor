# Web Agent API

**A specification for JavaScript APIs that bring AI agent capabilities to web applications.**

---

## What is the Web Agent API?

The Web Agent API is a proposed web platform specification that exposes two JavaScript APIs to web pages:

- **`window.ai`** — Text generation using language models (Chrome Prompt API compatible)
- **`window.agent`** — Tool calling, browser access, and autonomous agent capabilities via [MCP](https://modelcontextprotocol.io/) servers

These APIs provide the primitives for building AI agents on the web — with user consent, permission controls, and privacy by default.

## Relationship to Harbor

**Web Agent API** is the specification. **Harbor** is an implementation.

| | Web Agent API | Harbor |
|---|---------------|--------|
| **What** | The API specification | A Firefox extension |
| **Defines** | `window.ai`, `window.agent` interfaces | How to actually run them |
| **Scope** | Browser-agnostic standard | Firefox (and Chrome) implementation |
| **Who** | Could be implemented by any browser or extension | This implementation |

Think of it like the Fetch API (specification) vs. how Firefox implements it.

## Documents

| Document | Description |
|----------|-------------|
| [Explainer](./explainer.md) | Full API specification with examples and Web IDL |
| [Security & Privacy](./security-privacy.md) | Security model and privacy considerations |
| [Examples](./examples/) | Working code examples |

## Quick Example

```javascript
// Check if an implementation is available
if (typeof window.agent !== 'undefined') {
  // Request permissions
  await window.agent.requestPermissions({
    scopes: ['model:prompt'],
    reason: 'This app wants to help you write better.'
  });

  // Create an AI session
  const session = await window.ai.createTextSession({
    systemPrompt: 'You are a helpful writing assistant.'
  });

  // Generate text
  const response = await session.prompt('Improve this paragraph: ' + text);
  console.log(response);
}
```

## Key Features

### 🔒 Permission-First Design

All AI operations require explicit user consent, scoped per-origin:

| Permission | Description |
|------------|-------------|
| `model:prompt` | Basic text generation |
| `model:tools` | AI with tool calling |
| `model:list` | List available AI providers |
| `mcp:tools.list` | List available MCP tools |
| `mcp:tools.call` | Execute MCP tools |
| `browser:activeTab.read` | Read active tab content |

### 🔧 Tool Extensibility via MCP

Connect to any [MCP server](https://modelcontextprotocol.io/) to extend AI capabilities:

```javascript
// List available tools
const tools = await window.agent.tools.list();
// → ['brave-search/search', 'github/list_issues', 'memory/save', ...]

// Call a tool directly
const results = await window.agent.tools.call({
  tool: 'brave-search/search',
  args: { query: 'latest AI news' }
});
```

### 🤖 Autonomous Agents

Run multi-step agent tasks with tool access:

```javascript
for await (const event of window.agent.run({
  task: 'Research recent developments in quantum computing',
  maxToolCalls: 5
})) {
  if (event.type === 'tool_call') console.log('Using:', event.tool);
  if (event.type === 'token') process.stdout.write(event.token);
  if (event.type === 'final') console.log('\n\nDone:', event.output);
}
```

### 🌐 Chrome Prompt API Compatible

The `window.ai` surface is designed for compatibility with Chrome's built-in Prompt API:

```javascript
// Same API surface
const session = await window.ai.languageModel.create({
  systemPrompt: 'Be helpful.'
});
const response = await session.prompt('Hello!');

// But with provider choice
const providers = await window.ai.providers.list();
// → [{ id: 'ollama', available: true }, { id: 'openai', available: true }]
```

## Architecture

The Web Agent API can be implemented in various ways. The reference architecture uses a browser extension:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Web Page   │────▶│  Extension  │────▶│   Bridge    │
│  window.ai  │     │  (perms)    │     │  (runtime)  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                         ┌─────────────────────┼─────────────────────┐
                         ▼                     ▼                     ▼
                   ┌──────────┐          ┌──────────┐          ┌──────────┐
                   │  Local   │          │  Cloud   │          │   MCP    │
                   │   LLM    │          │   API    │          │ Servers  │
                   └──────────┘          └──────────┘          └──────────┘
```

Alternative implementations could include:
- Native browser integration (built into Gecko, Chromium, WebKit)
- Different extension architectures
- Server-side proxies

## Status

**Current Version:** 1.0 (Draft)

This is an active proposal. We welcome feedback via GitHub Issues and Discussions.

## Implementations

| Implementation | Platform | Status |
|----------------|----------|--------|
| **[Harbor](../)** | Firefox, Chrome | Working implementation |
| *(your implementation?)* | | |

## Related

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — The protocol powering tool extensibility
- [Chrome Built-in AI](https://developer.chrome.com/docs/ai/built-in) — Chrome's built-in AI initiative
- [Harbor](../) — Implementation of this proposal

---

**Author**: Raffi Krikorian &lt;raffi@mozilla.org&gt;
