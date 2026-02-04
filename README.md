# Harbor

**Browser infrastructure for AI-powered web applications.**

> **Note**: Harbor + Web Agents is an invitation to explore what user-controlled AI on the web could look like. This is meant to start a conversation—not announce a product. Nothing here is a commitment that these ideas will appear in Firefox or any Mozilla product. But if we're going to shape how AI works on the web, it helps to have something concrete to talk about.

This repository contains two browser extensions that work together:

- **Harbor** — Infrastructure extension that provides LLM connections (Ollama, OpenAI, Anthropic), hosts MCP servers, and manages the native bridge
- **Web Agents API** — Implements the **[Web Agent API](spec/)** specification, exposing `window.ai` and `window.agent` to web pages (requires Harbor for LLM/MCP infrastructure)

---

## Browser Support

| Browser | Status | Notes |
|---------|--------|-------|
| **Firefox** | ✅ Primary | Best supported, recommended for development |
| **Chrome** | ✅ Supported | Also works with Edge, Brave, Arc, Vivaldi |
| **Safari** | ⚠️ Experimental | macOS only, code in repo but not fully supported |

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

## Quick Start

**Get Harbor running in 10 minutes.**

### Prerequisites

| Tool | Install |
|------|---------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **Rust** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Ollama** | [ollama.com](https://ollama.com) or `brew install ollama` |
| **Firefox 109+** or **Chrome 120+** | Firefox recommended |

### 1. Clone and Build

```bash
git clone --recurse-submodules https://github.com/anthropics/harbor.git
cd harbor

# If you already cloned without --recurse-submodules:
git submodule update --init --recursive
```

```bash
# Build the Harbor extension
cd extension && npm install && npm run build && cd ..

# Build the Web Agents API extension
cd web-agents-api && npm install && npm run build && cd ..

# Build and install the native bridge
cd bridge-rs && cargo build --release && ./install.sh && cd ..
```

### 2. Start Ollama

```bash
ollama serve &
ollama pull llama3.2
```

### 3. Load Extensions

The system requires **two extensions** working together:
- **Harbor** — Infrastructure layer (LLM provider connections, MCP server hosting, native bridge, chat sidebar)
- **Web Agents API** — Web Agent API implementation (injects `window.ai` / `window.agent` into web pages, delegates to Harbor for LLM/MCP)

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select `extension/dist-firefox/manifest.json` (Harbor)
4. Click "Load Temporary Add-on..." again
5. Select `web-agents-api/dist-firefox/manifest.json` (Web Agents API)

**Chrome:**
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/dist-chrome/`
4. Click "Load unpacked" → select `web-agents-api/dist-chrome/`
5. **Important:** Note the Harbor extension ID and update native messaging — see [Chrome Quickstart](docs/QUICKSTART_CHROME.md#step-5-configure-native-messaging)

### 4. Verify Setup

1. Open the Harbor sidebar (Firefox: `Cmd+B`, Chrome: click toolbar icon)
2. Check for "Bridge: Connected" (green indicator)
3. Check for "LLM: Ollama" 

### 5. Run the Demos

```bash
cd demo && npm install && npm start
```

Open http://localhost:8000 and try the interactive demos.

→ **[Detailed Firefox Setup](docs/QUICKSTART_FIREFOX.md)** | **[Detailed Chrome Setup](docs/QUICKSTART_CHROME.md)**

> **Safari (Experimental):** Safari support is checked into the repo under `installer/safari/Harbor/` but is not fully supported. See [Safari Setup](docs/QUICKSTART_SAFARI.md) if you want to experiment.

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

## License

MIT — See [LICENSE](LICENSE) for details.
