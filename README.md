# Harbor

**AI as a browser capability.** A working sketch of what user-controlled AI on the open web could look like.

> **Note:** Harbor + Web Agents is an invitation to explore what user-controlled AI on the web could look like. This is meant to start a conversation — not announce a product. Nothing here is a commitment that these ideas will appear in Firefox or any Mozilla product. But if we're going to shape how AI works on the web, it helps to have something concrete to talk about.

This repository contains two browser extensions plus a small native bridge that, together, implement the **[Web Agent API](spec/)** specification:

- **Harbor** — Infrastructure extension that provides LLM connections (Ollama, OpenAI, Anthropic), hosts MCP servers, and manages the native bridge.
- **Web Agents API** — Implements the **[Web Agent API](spec/)** specification, exposing `window.ai`, `window.agent`, and `navigator.modelContext` (W3C [WebMCP](https://webmachinelearning.github.io/webmcp/)) to web pages. Requires Harbor for LLM/MCP infrastructure.

---

## Browser Support

| Browser | Status | Notes |
|---------|--------|-------|
| **Firefox** | ✅ Primary | Best supported, recommended for development |
| **Chrome** | ✅ Supported | Also works with Edge, Brave, Arc, Vivaldi |
| **Safari** | ⚠️ Experimental | macOS only, code in repo but not fully supported |

---

## Why This Exists

**The problem (May 2026 edition):** AI is everywhere in the browser, and somehow you have less choice than a year ago.

- **Vendor agent browsers** (ChatGPT Atlas, Comet, Gemini in Chrome, Copilot Mode in Edge, Dia) ask you to pick a side. Each replaces your browser with their agent and routes your context to one company.
- **Sidebar AI assistants** (Brave Leo, Mozilla's AI Window) let you bring your own model, but only to chat with yourself. Websites can't program against them.
- **Standards** like W3C [WebMCP](https://webmachinelearning.github.io/webmcp/) (April 2026) and Chrome's [Prompt API](https://developer.chrome.com/docs/ai/built-in-apis) solve slices — page-side tools, one on-device model — but neither answers the central question: *how does an arbitrary website call the user's chosen AI, with the user's chosen tools, on whatever browser the user happens to be on?*

**The vision:** treat AI like `fetch()`. The browser holds your model connections, your credentials, and your tools. Websites declare what they need through standard APIs (`window.ai`, `window.agent`, `navigator.modelContext`). Permissions are per-origin and revocable. The agent doesn't free-roam the DOM — websites delegate via a scoped API, which keeps the prompt-injection surface manageable.

```javascript
// Any website can use AI — no API keys, no backend, no vendor lock-in
const session = await window.ai.createTextSession();
const response = await session.prompt("Summarize this page");
```

With the Web Agent API:
- **Users** control their own AI — run local models, choose providers, manage permissions per-origin.
- **Websites** get AI capabilities without managing infrastructure, holding credentials, or picking a vendor.
- **Privacy** is preserved because the data path is the user's choice (local models never leave the machine).

→ **[Read the full explainer](spec/README.md)** · **[The 2026 landscape and where Harbor fits](docs/POSITIONING.md)** · **[Public site (`whitepaper/`)](whitepaper/README.md)**

---

## Quick Start

**Get Harbor running in 10 minutes.**

Follow **[QUICKSTART.md](QUICKSTART.md)** for the canonical setup: build both extensions and the bridge, load Firefox, add a default model under **LLM Providers → Configured Models**, test it, and run the demos.

The guide also covers the Getting Started demo's **Agentic Tool Use** setting and site permissions. A detected Ollama provider alone does not mean a model is configured.

For browser-specific details, use the [Chrome](docs/QUICKSTART_CHROME.md) or experimental [Safari](docs/QUICKSTART_SAFARI.md) supplement as directed by the quickstart.

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
| **[Building on the Web Agents API](docs/BUILDING_ON_WEB_AGENTS_API.md)** | Portable guide for other projects — copy into your repo for examples, API, capabilities |
| **[Testing your app](docs/TESTING_YOUR_APP.md)** | Unit tests (mock) and E2E (Playwright + Harbor) — generate harness from `scripts/generate-test-harness.mjs` |
| **[JS API Reference](docs/JS_AI_PROVIDER_API.md)** | Detailed `window.ai` and `window.agent` reference |
| **[LLMS.txt](docs/LLMS.txt)** | AI-optimized reference for Claude, Cursor, Copilot |
| **[Working Examples](spec/examples/)** | Copy-paste ready code |
| **[Demo Source Code](demo/)** | Full demo implementations |

> **Using an AI coding assistant?** Point it to **[docs/LLMS.txt](docs/LLMS.txt)** — it's designed for AI tools to quickly understand and build with the Web Agents API. **Building from another project?** Copy **[docs/BUILDING_ON_WEB_AGENTS_API.md](docs/BUILDING_ON_WEB_AGENTS_API.md)** into your repo (e.g. `docs/` or `.cursor/`) so the API, examples, and capabilities are in context.

### Create Custom Tools (MCP Servers)

Want your AI to do more? Create MCP servers that give it new capabilities:

```bash
# Copy the template and start building
cp -r mcp-servers/templates/javascript my-tool
cd my-tool && edit server.js
```

| Document | Description |
|----------|-------------|
| **[Tool Creation Quickstart](QUICKSTART.md#create-your-own-tools)** | Build your first tool in 15 minutes |
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
│              WEB AGENTS API EXTENSION                            │
│  • Implements Web Agent API spec  • Permission prompts          │
│  • Injects window.ai/agent        • Delegates to Harbor         │
└───────────────────────────────┬─────────────────────────────────┘
                                │ Cross-extension messaging
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   HARBOR EXTENSION                               │
│  • LLM provider selection      • In-browser WASM/JS MCP         │
│  • MCP server management       • Chat sidebar UI                │
└───────────────────────────────┬─────────────────────────────────┘
                                │ Native Messaging
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RUST BRIDGE                                 │
│  • LLM provider connections    • Native MCP servers             │
│  • Ollama/OpenAI/Anthropic     • OAuth flows                    │
└─────────────────────────────────────────────────────────────────┘
```

### Contributor Documentation

| Document | Description |
|----------|-------------|
| **[Architecture](ARCHITECTURE.md)** | System design and component details |
| **[Contributing Guide](CONTRIBUTING.md)** | Build, test, and submit changes |
| **[MCP Host](docs/MCP_HOST.md)** | MCP execution environment internals |
| **[Test Suite](tests/README.md)** | Run and write Harbor's unit and E2E tests |

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

The Web Agents API extension implements the Web Agent API specification. The specification itself is browser-agnostic and could be implemented by browsers natively or by other extensions.

| Document | Description |
|----------|-------------|
| **[Whitepaper](whitepaper/)** | The vision: user-controlled AI on the web |
| **[Specification Overview](spec/README.md)** | What the Web Agent API is and why it matters |
| **[Full Explainer](spec/explainer.md)** | Complete spec with Web IDL and security model |
| **[Security & Privacy](spec/security-privacy.md)** | Threat model and mitigations |

---

## Project Structure

```
harbor/
├── whitepaper/         # Public whitepaper (GitHub Pages)
├── spec/               # Web Agent API specification (browser-agnostic)
├── extension/          # Harbor extension (LLM connections, MCP hosting, sidebar)
├── web-agents-api/     # Web Agents API extension (implements window.ai/window.agent)
├── bridge-rs/          # Rust native messaging bridge
├── demo/               # Working examples
├── docs/               # Implementation documentation
├── mcp-servers/        # Built-in MCP servers (WASM, JS)
└── installer/          # Safari Xcode project (experimental)
```

---

## Known Limitations

This is version 0.1.0, released as a conversation starter. Some features are still in development:

- **Streaming abort**: Canceling streaming requests is not yet fully implemented
- **Address bar parsing**: LLM-based argument parsing for omnibox commands is placeholder
- **Permission granularity**: Origin-level permission checks are basic; more fine-grained controls planned
- **Safari support**: Experimental; code is in the repo but not fully tested
- **Function calling**: Native tool/function calling in the bridge uses response parsing (proper function calling planned)

See individual TODO comments in the source for specific implementation notes.

---

## Getting Help

- **[GitHub Issues](https://github.com/r/harbor/issues)** — Bug reports and feature requests
- **[Documentation](docs/)** — Guides and API references
- **[LLMS.txt](docs/LLMS.txt)** — AI-optimized reference for coding assistants

---

## License

MIT — See [LICENSE](LICENSE) for details.
