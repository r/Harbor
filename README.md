# Harbor

**A browser extension that brings AI agent capabilities to web applications.**

Harbor implements the **[Web Agent API](spec/)** — a proposed standard that exposes `window.ai` and `window.agent` to web pages, giving them access to AI models and tools with user consent.

---

## Why This Exists

**The problem:** Every website that wants AI features needs to either:
1. Ask users for API keys (bad UX, privacy concerns)
2. Pay for and manage their own AI infrastructure (expensive, data custody issues)
3. Use cloud services that see all user data (privacy nightmare)

**The vision:** What if the browser could provide AI capabilities directly to web pages — like it provides `fetch()` for network access or `localStorage` for persistence?

With the Web Agent API:
- **Users** control their own AI (run local models, choose providers, manage permissions)
- **Websites** get AI capabilities without managing infrastructure or handling sensitive data
- **Privacy** is preserved because data can stay local

```javascript
// Any website can use AI — no API keys, no backend needed
const session = await window.ai.createTextSession();
const response = await session.prompt("Summarize this page");
```

→ **[Read the full explainer: Why Web Agents?](spec/README.md)**

---

## Quick Start: Try the Demos

**Just want to see it work? Get running in 5 minutes.**

### 1. Prerequisites
- Firefox 109+ or Chrome 120+
- [Node.js 18+](https://nodejs.org)
- [Rust](https://rustup.rs) (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- [Ollama](https://ollama.com) for local AI (`brew install ollama && ollama serve && ollama pull llama3.2`)

### 2. Build & Install

```bash
# Clone and build
git clone --recurse-submodules https://github.com/anthropics/harbor.git
cd harbor
cd extension && npm install && npm run build && cd ..
cd bridge-rs && cargo build --release && ./install.sh && cd ..

# Load extension
# Firefox: about:debugging → Load Temporary Add-on → extension/dist/manifest.json
# Chrome: chrome://extensions → Developer mode → Load unpacked → extension/dist/
```

### 3. Run the Demos

```bash
cd demo && npm install && npm start
```

Open http://localhost:8000 and try:
- **[Getting Started](http://localhost:8000/web-agents/getting-started/)** — Interactive tutorial
- **[Chat Demo](http://localhost:8000/web-agents/chat-poc/)** — Full chat with tools
- **[Page Summarizer](http://localhost:8000/web-agents/summarizer/)** — One-click summaries

→ **[Full installation guide](docs/USER_GUIDE.md)** | **[More demos](demo/README.md)**

---

## Build With the Web Agent API

**Building a hackathon project or integrating AI into your web app?**

The Web Agent API gives your web pages access to:

| API | What It Does |
|-----|--------------|
| `window.ai.createTextSession()` | Chat with AI models |
| `window.agent.tools.list()` | List available MCP tools |
| `window.agent.tools.call()` | Execute tools (search, files, databases) |
| `window.agent.run()` | Run autonomous agent tasks |
| `window.agent.browser.activeTab.readability()` | Read page content |

### Minimal Example

```html
<!DOCTYPE html>
<html>
<body>
  <button id="ask">Ask AI</button>
  <div id="output"></div>
  <script>
    document.getElementById('ask').onclick = async () => {
      // 1. Request permission
      await window.agent.requestPermissions({
        scopes: ['model:prompt'],
        reason: 'To answer your question'
      });
      
      // 2. Create session and prompt
      const session = await window.ai.createTextSession();
      const response = await session.prompt('What is 2+2?');
      document.getElementById('output').textContent = response;
    };
  </script>
</body>
</html>
```

### Developer Documentation

| Document | Description |
|----------|-------------|
| **[API Quickstart](QUICKSTART.md)** | Get from zero to working code in 15 minutes |
| **[Web Agents API Reference](docs/WEB_AGENTS_API.md)** | Complete API docs with examples |
| **[JS API Reference](docs/JS_AI_PROVIDER_API.md)** | Detailed `window.ai` and `window.agent` reference |
| **[LLMS.txt](docs/LLMS.txt)** | AI-optimized reference for Claude, Cursor, Copilot |
| **[Working Examples](spec/examples/)** | Copy-paste ready code |
| **[Demo Source Code](demo/)** | Full demo implementations |

> **Using an AI coding assistant?** Point it to **[docs/LLMS.txt](docs/LLMS.txt)** — it's designed for AI tools to quickly understand and build with the Web Agents API.

### Create Custom Tools (MCP Servers)

Want your AI to do more? Create MCP servers that give it new capabilities:

```bash
# Copy the template and start building
cp -r mcp-servers/templates/javascript my-tool
cd my-tool && edit server.js
```

| Document | Description |
|----------|-------------|
| **[Tool Creation Quickstart](QUICKSTART.md#part-3-create-your-own-tools)** | Build your first tool in 15 minutes |
| **[MCP Authoring Guide](mcp-servers/AUTHORING_GUIDE.md)** | Complete guide (JS and WASM) |
| **[Example: Gmail Integration](mcp-servers/examples/gmail/)** | Real-world OAuth example |

### Key Concepts

**Permissions:** All capabilities require user consent. Request what you need:
```javascript
await window.agent.requestPermissions({
  scopes: ['model:prompt', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'Enable AI features'
});
```

**Feature Flags:** Some APIs are gated. Users enable them in the sidebar:
- `toolCalling` — Enables `agent.run()` for autonomous tasks
- `browserInteraction` — Enables click/fill/scroll automation
- `browserControl` — Enables tab management and navigation

→ **[Feature Flags Reference](docs/WEB_AGENTS_API.md#feature-flags)**

---

## Hack on Harbor

**Want to contribute to Harbor or build your own Web Agent API implementation?**

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         WEB PAGE                                 │
│            window.ai / window.agent (injected APIs)             │
└───────────────────────────────┬─────────────────────────────────┘
                                │ postMessage
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER EXTENSION                             │
│  • Permission enforcement       • In-browser WASM/JS MCP        │
│  • Feature flags               • Message routing                │
└───────────────────────────────┬─────────────────────────────────┘
                                │ Native Messaging
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RUST BRIDGE                                 │
│  • LLM provider abstraction    • Native MCP servers             │
│  • Ollama/OpenAI/Anthropic     • OAuth flows                    │
└─────────────────────────────────────────────────────────────────┘
```

### Contributor Documentation

| Document | Description |
|----------|-------------|
| **[Architecture](ARCHITECTURE.md)** | System design and component details |
| **[Contributing Guide](CONTRIBUTING.md)** | Build, test, and submit changes |
| **[MCP Host](docs/MCP_HOST.md)** | MCP execution environment internals |
| **[Testing Plan](docs/TESTING_PLAN.md)** | Test coverage and QA procedures |

### Development Setup

```bash
# Watch mode
cd extension && npm run dev    # Auto-rebuild on changes
cd bridge-rs && cargo build    # Rebuild after Rust changes

# Test
cd bridge-rs && cargo test
cd extension && npm test
```

→ **[Full contributing guide](CONTRIBUTING.md)**

---

## The Web Agent API Specification

Harbor is an *implementation* of the Web Agent API. The specification itself is browser-agnostic.

| Document | Description |
|----------|-------------|
| **[Specification Overview](spec/README.md)** | What the Web Agent API is and why it matters |
| **[Full Explainer](spec/explainer.md)** | Complete spec with Web IDL and security model |
| **[Security & Privacy](spec/security-privacy.md)** | Threat model and mitigations |

---

## Project Structure

```
harbor/
├── spec/               # Web Agent API specification (browser-agnostic)
├── extension/          # Browser extension (TypeScript)
│   └── src/agents/     # window.ai / window.agent implementation
├── bridge-rs/          # Rust native messaging bridge
├── demo/               # Working examples
├── docs/               # Implementation documentation
├── mcp-servers/        # Built-in MCP servers (WASM, JS)
└── installer/          # macOS package builder
```

---

## License

MIT
