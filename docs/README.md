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
| [Quickstart](../QUICKSTART.md) | Install, run demos, build first app |

### For Developers (Building ON the API)

| Document | Description |
|----------|-------------|
| **[Web Agents API Reference](WEB_AGENTS_API.md)** | Complete `window.ai` and `window.agent` docs |
| **[JS API Reference](JS_AI_PROVIDER_API.md)** | Detailed API with TypeScript types |
| [Sessions Guide](SESSIONS_GUIDE.md) | When to use `window.ai` vs `agent.sessions` |
| [Working Examples](../spec/examples/) | Copy-paste ready code |
| [Demo Source](../demo/) | Full demo implementations |

### For AI Coding Assistants

| Document | Description |
|----------|-------------|
| [LLMS.txt](LLMS.txt) | Token-efficient reference for AI tools |

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
| [Testing Plan](TESTING_PLAN.md) | Test coverage and QA procedures |

### Reference

| Document | Description |
|----------|-------------|
| [User Guide](USER_GUIDE.md) | End-user installation and configuration |
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
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
           ▼                           ▼                           ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│   Build with API    │   │   Read the Spec     │   │  Contribute/Hack    │
│                     │   │                     │   │                     │
│ QUICKSTART (Part 2) │   │ spec/explainer.md   │   │ CONTRIBUTING.md     │
│ WEB_AGENTS_API.md   │   │ security-privacy.md │   │ ARCHITECTURE.md     │
│ JS_AI_PROVIDER_API  │   │                     │   │ MCP_HOST.md         │
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
| Read the permission model | [Explainer](../spec/explainer.md#permission-model) |
| Build from source | [Contributing](../CONTRIBUTING.md#getting-started) |
| Write MCP servers | [MCP Authoring Guide](../mcp-servers/AUTHORING_GUIDE.md) |
