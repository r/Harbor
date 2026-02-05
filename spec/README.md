# Web Agent API

**A specification for bringing AI capabilities to the web platform.**

---

## The Problem

Today, if a website wants to offer AI features, it has three bad options:

### Option 1: Ask Users for API Keys
```
"Please enter your OpenAI API key to use this feature"
```
- Terrible user experience
- Users don't know what keys to trust websites with
- Keys can be leaked or stolen
- No way to revoke access per-site

### Option 2: Build Your Own AI Backend
```
Website → Their Server → AI Provider → Back to User
```
- Expensive infrastructure to maintain
- All user data flows through the website's servers
- Website becomes responsible for data custody
- Users have no control over which AI is used

### Option 3: Embedded Third-Party AI
```
Website embeds a chat widget from an AI company
```
- User data goes to yet another company
- No integration with user's existing AI preferences
- Fragmented experience across websites
- No way to use local/private models

**All three options share a fundamental problem:** the user loses control over their AI experience and their data.

---

## The Vision: AI as a Browser Capability

What if AI worked like other browser capabilities?

| Capability | How It Works Today |
|------------|-------------------|
| **Network** | Websites call `fetch()`, browser handles the connection |
| **Storage** | Websites use `localStorage`, browser manages the data |
| **Location** | Websites request `geolocation`, user grants permission |
| **AI** | ??? |

The Web Agent API proposes that **AI should work the same way**:

```javascript
// Website requests AI capability
const session = await window.ai.createTextSession();
const response = await session.prompt("Summarize this article");
```

The website doesn't need to know:
- Which AI model is being used
- Whether it's local (Ollama) or cloud (OpenAI)
- What the user's preferences are
- How to handle authentication

The **user** controls all of that through their browser.

---

## How It Works

### For Users

1. **Install an implementation** (like Harbor)
2. **Configure your AI** (local Ollama, cloud provider, etc.)
3. **Grant permissions** when websites request AI access

The user experience looks like:

```
┌────────────────────────────────────────────────┐
│  example.com wants to:                         │
│                                                │
│  🤖 Generate text using AI                     │
│  🔧 Use the following tools:                   │
│     ☑ brave-search/search                      │
│     ☑ memory/save                              │
│                                                │
│  "To help you research this topic"             │
│                                                │
│  ○ Allow once    ● Always allow                │
│                                                │
│  [ Deny ]                    [ Allow ]         │
└────────────────────────────────────────────────┘
```

### For Developers

Two JavaScript APIs are available on web pages:

**`window.ai`** — Text generation (Chrome Prompt API compatible)
```javascript
const session = await window.ai.createTextSession({
  systemPrompt: "You are a helpful assistant."
});
const response = await session.prompt("Hello!");
```

**`window.agent`** — Tools and autonomous capabilities
```javascript
// Request permissions
await window.agent.requestPermissions({
  scopes: ['model:tools', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'Research assistant needs search access'
});

// Run an autonomous task
for await (const event of window.agent.run({
  task: 'Find recent news about AI safety'
})) {
  if (event.type === 'token') process.stdout.write(event.token);
  if (event.type === 'final') console.log('\n\nDone:', event.output);
}
```

### For AI/Tool Providers

The Web Agent API uses **[MCP (Model Context Protocol)](https://modelcontextprotocol.io/)** for tool extensibility:

```
User installs MCP servers → Browser connects them → Websites can use their tools
```

Examples of MCP servers:
- **File system** — Read/write local files
- **GitHub** — Manage repos, issues, PRs
- **Brave Search** — Web search
- **Memory** — Persistent user memory
- **Database** — Query databases

Users control which tools are available to which websites.

---

## Key Principles

### 1. User Consent Required

Every AI operation requires explicit user permission:

| Scope | What It Allows |
|-------|---------------|
| `model:prompt` | Basic text generation |
| `model:tools` | AI with autonomous tool use |
| `mcp:tools.list` | List available tools |
| `mcp:tools.call` | Execute tools |
| `browser:activeTab.read` | Read page content |

### 2. Origin Isolation

Permissions are scoped per-origin. `example.com` permissions don't affect `other.com`.

### 3. Local-First Privacy

Users can run entirely local AI (Ollama, llamafile) — data never leaves their machine.

### 4. Chrome Prompt API Compatible

The `window.ai` surface is designed to work with Chrome's built-in AI:

```javascript
// Same code works with Chrome AI or Web Agent API implementations
const session = await window.ai.languageModel.create({
  systemPrompt: "Be helpful."
});
```

### 5. Extensible via MCP

Any MCP server can be connected. The ecosystem is open.

---

## What You Can Build

### AI-Enhanced Web Apps
```javascript
// Writing assistant
const session = await window.ai.createTextSession();
const improved = await session.prompt(`Improve: ${selectedText}`);
```

### Research Agents
```javascript
// Agent that can search and synthesize
for await (const event of window.agent.run({
  task: 'Research quantum computing breakthroughs in 2025',
  maxToolCalls: 10
})) {
  // Streams tool calls and final answer
}
```

### Page Summarizers
```javascript
// Summarize current tab
const page = await window.agent.browser.activeTab.readability();
const summary = await session.prompt(`Summarize: ${page.text}`);
```

### Bring Your Own Chatbot
```javascript
// Website provides tools, user brings their AI
await window.agent.mcp.register({
  url: 'https://shop.example/mcp',
  name: 'Acme Shop',
  tools: ['search_products', 'add_to_cart']
});
await window.agent.chat.open();  // Opens user's AI chatbot
```

---

## Specification Documents

| Document | Description |
|----------|-------------|
| **[Full Explainer](explainer.md)** | Complete specification with Web IDL |
| **[Security & Privacy](security-privacy.md)** | Threat model and mitigations |
| **[Examples](examples/)** | Working code examples |

---

## Implementations

| Implementation | Platform | Status |
|----------------|----------|--------|
| **[Harbor](../)** | Firefox, Chrome | Working implementation |

---

## Relationship to Other Proposals

### Chrome Built-in AI / Prompt API

Chrome is building AI capabilities directly into the browser. The Web Agent API:
- Uses a compatible `window.ai` surface
- Extends it with tools and agent capabilities via `window.agent`
- Works as a polyfill until native support exists

### Model Context Protocol (MCP)

MCP is the protocol for tool extensibility. The Web Agent API uses MCP to:
- Connect to tool servers (file system, GitHub, search, etc.)
- Provide a standardized way to extend AI capabilities
- Enable an open ecosystem of tools

---

## FAQ

### Why not just use the Chrome Prompt API?

Chrome's Prompt API is great for basic text generation. The Web Agent API extends it with:
- Tool calling via MCP
- Autonomous agent tasks
- User control over AI providers
- Works in Firefox and other browsers

### Why not just call AI APIs directly from JavaScript?

You could, but then:
- Every user needs API keys
- Every website manages its own AI infrastructure
- No unified permission model
- No way to use local/private models
- Fragmented experience

### What about security?

See [Security & Privacy](security-privacy.md) for the full threat model. Key protections:
- All operations require user consent
- Permissions are scoped per-origin
- Tool access is granular (users can allow specific tools)
- Rate limiting prevents abuse

### Can websites see my AI responses?

Websites receive the AI's responses (they made the request), but:
- They don't see your API keys or configuration
- They can't access other websites' permissions
- You control which AI backend is used
- Local models mean data never leaves your machine

---

## Get Started

**Try it:** [Install Harbor](../) and run the demos

**Build with it:** [Developer Guide](../docs/DEVELOPER_GUIDE.md)

**Read the spec:** [Full Explainer](explainer.md)

**Using an AI coding assistant?** Point it to [docs/LLMS.txt](../docs/LLMS.txt) — a compact reference designed for AI tools to quickly build with the API.

---

*This specification is a draft proposal. Feedback welcome via [GitHub Issues](https://github.com/r/harbor/issues).*
