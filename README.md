# Harbor

<p align="center">
  <strong>An implementation of the Web Agent API</strong>
</p>

Harbor is a browser extension (Firefox and Chrome) that implements the **[Web Agent API](spec/)** — a proposed standard for bringing AI agent capabilities to web applications.

## What is the Web Agent API?

The **Web Agent API** is a specification that defines how web pages can access AI capabilities:

- **`window.ai`** — Text generation (Chrome Prompt API compatible)
- **`window.agent`** — Tool calling, browser access, and autonomous agent tasks via [MCP](https://modelcontextprotocol.io/)

**Harbor** implements this specification with two execution modes:
1. **In-Browser** — MCP servers run as WASM or JavaScript directly in the extension
2. **Native Bridge** — LLM inference via a Rust native messaging bridge

```
┌──────────────────────────────────────────────────────────────────┐
│                     Browser Extension                             │
│                                                                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐ │
│  │ Web Agent API   │    │ In-Browser MCP  │    │ Native Bridge│ │
│  │ window.ai/agent │    │ WASM + JS       │    │ (Rust)       │ │
│  └────────┬────────┘    └────────┬────────┘    └──────┬───────┘ │
└───────────┼─────────────────────┼─────────────────────┼─────────┘
            │                     │                     │
            ▼                     ▼                     ▼
    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
    │  Web Pages    │    │  MCP Servers  │    │  LLM Providers│
    │  (permission  │    │  (time, echo) │    │  (Ollama,     │
    │   required)   │    │               │    │   OpenAI...)  │
    └───────────────┘    └───────────────┘    └───────────────┘
```

## ✨ Features

- **Local LLM Integration** — Use Ollama, llamafile, or other local models
- **MCP Server Management** — Install, run, and manage MCP servers from a curated directory
- **JS AI Provider** — Exposes `window.ai` and `window.agent` APIs to web pages
- **Permission System** — Per-origin capability grants with user consent
- **Process Isolation** — Optional crash isolation for MCP servers (forked processes)
- **Docker Isolation** — Optional containerized execution for MCP servers

---

## 📚 Documentation

### Web Agent API Specification

| Document | Description |
|----------|-------------|
| **[Web Agent API Spec](spec/)** | The API specification (`window.ai`, `window.agent`) |
| [Explainer](spec/explainer.md) | Full specification with Web IDL and examples |
| [Security & Privacy](spec/security-privacy.md) | Security model and privacy considerations |

### Harbor Implementation

#### For Users

| Document | Description |
|----------|-------------|
| **[User Guide](docs/USER_GUIDE.md)** | Install Harbor, set up LLMs, manage MCP servers |

#### For Web Developers

| Document | Description |
|----------|-------------|
| **[Developer Guide](docs/DEVELOPER_GUIDE.md)** | Build apps using the Web Agent API |
| [JS API Reference](docs/JS_AI_PROVIDER_API.md) | Detailed API with examples and TypeScript types |
| [Demo Code](demo/) | Working examples |

#### For AI Agents

| Document | Description |
|----------|-------------|
| **[LLMS.txt](docs/LLMS.txt)** | Compact, token-efficient reference for AI coding assistants |

#### For Contributors

| Document | Description |
|----------|-------------|
| **[Contributing Guide](CONTRIBUTING.md)** | Build, test, and contribute to Harbor |
| [Architecture](ARCHITECTURE.md) | System design and component overview |
| [MCP Host](docs/MCP_HOST.md) | MCP execution environment internals |
| [Testing Plan](docs/TESTING_PLAN.md) | Test coverage and QA procedures |

---

## 🚀 Quick Start

### Prerequisites

- **Firefox** 109+ or **Chrome** 120+
- **Rust** (for building the bridge)
- **Node.js** 18+ (for building the extension)
- **Ollama** or **llamafile** (for LLM - optional, needed for AI features)

### Installation

**Option 1: macOS Installer**
```bash
# Download and run Harbor-x.x.x.pkg
# Restart your browser after installation
```

**Option 2: Build from Source**
```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/anthropics/harbor.git
cd harbor

# Build extension
cd extension && npm install && npm run build && cd ..

# Build Rust bridge
cd bridge-rs && cargo build --release && cd ..

# Install native messaging manifest
cd bridge-rs && ./install.sh && cd ..

# Load extension in browser
# Firefox: about:debugging#/runtime/this-firefox → Load Temporary Add-on → extension/dist/manifest.json
# Chrome: chrome://extensions → Developer mode → Load unpacked → extension/dist/
```

### Verify Installation

1. Click the Harbor sidebar icon in Firefox
2. You should see "Connected" status
3. Click "Detect" under LLM settings to find your local model

---

## 🎯 How It Works

**Web Page Integration (Web Agent API):**
```javascript
// Check if Web Agent API is available
if (window.agent) {
  // Request permissions
  await window.agent.requestPermissions({
    scopes: ['model:prompt', 'mcp:tools.list', 'mcp:tools.call'],
    reason: 'Enable AI features'
  });

  // Use AI text generation
  const session = await window.ai.createTextSession();
  const response = await session.prompt('Hello!');

  // Run agent tasks with tools
  for await (const event of window.agent.run({ task: 'Search my files' })) {
    console.log(event);
  }
}
```

**Permission Scopes:**

| Scope | Description |
|-------|-------------|
| `model:prompt` | Basic text generation |
| `model:tools` | AI with tool calling |
| `mcp:tools.list` | List available MCP tools |
| `mcp:tools.call` | Execute MCP tools |
| `browser:activeTab.read` | Read active tab content |

---

## 🗂 Project Structure

```
harbor/
├── extension/          # Browser Extension (TypeScript, esbuild)
│   └── src/
│       ├── agents/     # Web Agent API (injected.ts, orchestrator.ts)
│       ├── js-runtime/ # In-browser JS MCP runtime
│       ├── wasm/       # In-browser WASM MCP runtime
│       ├── llm/        # Native bridge client
│       ├── mcp/        # MCP protocol & host
│       └── policy/     # Permission system
├── bridge-rs/          # Rust Native Messaging Bridge
│   ├── src/
│   │   ├── js/         # QuickJS runtime for JS MCP servers
│   │   ├── llm/        # LLM provider configuration
│   │   └── rpc/        # RPC method handlers
│   └── any-llm-rust/   # Multi-provider LLM library (submodule)
├── demo/               # Example web pages
├── docs/               # Documentation
├── spec/               # Web Agent API specification
└── installer/          # Distributable packages
```

---

## 🛠 Development

```bash
# Watch mode (extension)
cd extension && npm run dev

# Build Rust bridge (release)
cd bridge-rs && cargo build --release

# Run Rust tests
cd bridge-rs && cargo test

# TypeScript type check
cd extension && npx tsc --noEmit
```

See [Contributing Guide](CONTRIBUTING.md) for detailed development instructions.

---

## 📊 Roadmap

- [x] Native messaging bridge
- [x] MCP server management
- [x] LLM integration (Ollama, llamafile)
- [x] Chat orchestration with tool calling
- [x] JS AI Provider (window.ai, window.agent)
- [x] Permission system
- [ ] v1.0 Production release
- [ ] Windows/Linux installers
- [ ] Chrome extension support

---

## 📄 License

MIT
