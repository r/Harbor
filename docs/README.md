# Harbor Documentation

**Find the right docs for what you're trying to do.**

---

## I want to...

### Understand what this is
→ **[Web Agent API Overview](../spec/README.md)** — Why this exists, the problem it solves, and how it works

### Try the demos
→ **[Quickstart](../QUICKSTART.md)** — Install Harbor and run demos in 5 minutes

### Build an app using the API
→ **[Quickstart Part 2](../QUICKSTART.md#part-2-build-your-first-app)** — Write your first AI-powered web app

→ **[Web Agents API Reference](WEB_AGENTS_API.md)** — Complete API documentation

→ **[Building on the Web Agents API](BUILDING_ON_WEB_AGENTS_API.md)** — Portable guide for other projects (copy into your repo; examples, API summary, capabilities)

### Test my app that uses the API
→ **[Testing your app](TESTING_YOUR_APP.md)** — Generate a test harness (mock + Playwright E2E) with `node scripts/generate-test-harness.mjs <target-dir>` from the Harbor repo

### Create custom tools (MCP servers)
→ **[Quickstart Part 3](../QUICKSTART.md#part-3-create-your-own-tools)** — Build your first MCP server in 15 minutes

→ **[MCP Authoring Guide](../mcp-servers/AUTHORING_GUIDE.md)** — Complete guide to writing MCP servers

### Understand the full specification
→ **[Explainer](../spec/explainer.md)** — Full spec with Web IDL and security model

### Contribute to Harbor
→ **[Contributing Guide](../CONTRIBUTING.md)** — Build, test, and submit changes

---

## Documentation Index

### For Everyone

| Document | Description |
|----------|-------------|
| [README](../README.md) | Project overview and quick links |
| [Quickstart](../QUICKSTART.md) | Build, install, run demos, create your first app |
| [Firefox Setup](QUICKSTART_FIREFOX.md) | Detailed Firefox setup (primary browser) |
| [Chrome Setup](QUICKSTART_CHROME.md) | Detailed Chrome/Chromium setup |
| [Safari Setup](QUICKSTART_SAFARI.md) | Safari setup (experimental) |

### For Developers (Building ON the API)

| Document | Description |
|----------|-------------|
| **[Web Agents API Reference](WEB_AGENTS_API.md)** | Complete `window.ai` and `window.agent` docs |
| **[Building on the Web Agents API](BUILDING_ON_WEB_AGENTS_API.md)** | Portable guide for other projects — copy into your repo for examples, API summary, capabilities |
| **[Testing your app](TESTING_YOUR_APP.md)** | Unit tests with mock, E2E with Playwright + Harbor extensions — generate harness via `scripts/generate-test-harness.mjs` |
| **[JS API Reference](JS_AI_PROVIDER_API.md)** | Detailed API with TypeScript types |
| [Sessions Guide](SESSIONS_GUIDE.md) | When to use `window.ai` vs `agent.sessions` |
| [Working Examples](../spec/examples/) | Copy-paste ready code |
| [Demo Source](../demo/) | Full demo implementations |

### For Tool Creators (Building MCP Servers)

| Document | Description |
|----------|-------------|
| **[Quickstart Part 3](../QUICKSTART.md#part-3-create-your-own-tools)** | Create your first tool in 15 minutes |
| **[MCP Authoring Guide](../mcp-servers/AUTHORING_GUIDE.md)** | Complete guide (JS and WASM) |
| **[OAuth Guide](OAUTH_GUIDE.md)** | OAuth setup, integration, and troubleshooting |
| [JS Template](../mcp-servers/templates/javascript/) | Copy-paste JavaScript starter |
| [Rust/WASM Template](../mcp-servers/templates/wasm-rust/) | Copy-paste Rust starter |
| [MCP Manifest Spec](MCP_MANIFEST_SPEC.md) | Full manifest reference |
| [Example: Gmail](../mcp-servers/examples/gmail/) | Real-world OAuth integration |

### For AI Coding Assistants

> **Building with Claude, Cursor, Copilot, or another AI assistant?** Point your AI to **[LLMS.txt](LLMS.txt)** — it's specifically designed for AI tools to quickly understand and build with the Web Agents API.

| Document | Description |
|----------|-------------|
| **[LLMS.txt](LLMS.txt)** | Compact, token-efficient API reference for AI coding assistants |

### The Specification

| Document | Description |
|----------|-------------|
| [Specification Overview](../spec/README.md) | What and why |
| [Full Explainer](../spec/explainer.md) | Complete spec with Web IDL |
| [Security & Privacy](../spec/security-privacy.md) | Threat model and mitigations |

### For Contributors (Building Harbor Itself)

| Document | Description |
|----------|-------------|
| [Architecture](../ARCHITECTURE.md) | System design and components |
| [Contributing Guide](../CONTRIBUTING.md) | Development setup and workflow |
| [MCP Host](MCP_HOST.md) | MCP execution environment internals |
| [Test Suite](../tests/README.md) | Run and write Harbor's unit and E2E tests |
| [Testing your app](TESTING_YOUR_APP.md) | Test your Web Agents API app (mock + E2E harness) |

### Reference

| Document | Description |
|----------|-------------|
| [User Guide](USER_GUIDE.md) | End-user installation and configuration |
| [OAuth Guide](OAUTH_GUIDE.md) | OAuth setup, configuration, and troubleshooting |
| [MCP Manifest Spec](MCP_MANIFEST_SPEC.md) | MCP server manifest format |
| [MCP WASM Manifest](MCP_WASM_MANIFEST_SPEC.md) | WASM server manifest format |

---

## Document Audience

```
                         ┌─────────────────────────────┐
                         │    Understand the Vision    │
                         │  spec/README.md             │
                         └─────────────┬───────────────┘
                                       │
                         ┌─────────────▼───────────────┐
                         │       Try the Demos         │
                         │  QUICKSTART.md (Part 1)     │
                         └─────────────┬───────────────┘
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       │                               │                               │
       ▼                               ▼                               ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│   Build with API    │   │  Create MCP Tools   │   │  Contribute/Hack    │
│                     │   │                     │   │                     │
│ QUICKSTART (Part 2) │   │ QUICKSTART (Part 3) │   │ CONTRIBUTING.md     │
│ WEB_AGENTS_API.md   │   │ AUTHORING_GUIDE.md  │   │ ARCHITECTURE.md     │
│ JS_AI_PROVIDER_API  │   │ templates/          │   │ MCP_HOST.md         │
└─────────────────────┘   └─────────────────────┘   └─────────────────────┘
```

---

## Quick Links by Task

| Task | Document |
|------|----------|
| Install Harbor | [User Guide](USER_GUIDE.md#installation) |
| Set up Ollama | [User Guide](USER_GUIDE.md#setting-up-an-llm-provider) |
| Request permissions | [Web Agents API](WEB_AGENTS_API.md#permissions) |
| Create a chat session | [Web Agents API](WEB_AGENTS_API.md#windowai-api) |
| Call MCP tools | [Web Agents API](WEB_AGENTS_API.md#tools) |
| Run autonomous agents | [Web Agents API](WEB_AGENTS_API.md#autonomous-agent) |
| Understand feature flags | [Web Agents API](WEB_AGENTS_API.md#feature-flags) |
| **Test your app** (mock + E2E) | [Testing your app](TESTING_YOUR_APP.md) |
| **Create a JS MCP server** | [Quickstart Part 3](../QUICKSTART.md#part-3-create-your-own-tools) |
| **Create a WASM MCP server** | [MCP Authoring Guide](../mcp-servers/AUTHORING_GUIDE.md#wasm-servers-rust) |
| **Add OAuth to MCP server** | [OAuth Guide](OAUTH_GUIDE.md#for-mcp-server-authors) |
| **Set up OAuth credentials** | [OAuth Guide](OAUTH_GUIDE.md#for-developers-setting-up-harbor) |
| Read the permission model | [Explainer](../spec/explainer.md#permission-model) |
| Build from source | [Contributing](../CONTRIBUTING.md#getting-started) |
