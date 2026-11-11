# Contributing to Harbor

This guide is for developers who want to contribute to Harbor itself. If you're looking to build applications using Harbor, see [Developer Guide](docs/DEVELOPER_GUIDE.md) instead.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Project Structure](#project-structure)
3. [Development Workflow](#development-workflow)
4. [Testing](#testing)
5. [Code Style](#code-style)
6. [How We Track Work](#how-we-track-work)
7. [Pull Request Process](#pull-request-process)

---

## Getting Started

### Prerequisites

- **Rust** (latest stable, for the native bridge)
- **Node.js** 18+ (with npm, for the extension)
- **Firefox** 109+ or **Chrome** 120+ (for testing the extension)
- **Python 3.9+** with uvx (for Python MCP servers)
- **Docker** (optional, for isolated server execution)
- **Git** (with submodule support)

### Initial Setup

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/r/harbor.git
cd harbor

# If you already cloned without submodules:
git submodule update --init --recursive
```

### Full Build

Harbor is **two extensions plus a native bridge**. You need to build all three.

```bash
# 1. Build the Rust bridge
cd bridge-rs
cargo build --release
./install.sh        # installs the native messaging manifest
cd ..

# 2. Build the Harbor extension (LLM/MCP infrastructure)
cd extension
npm install
npm run build       # outputs to dist-firefox/ (default); also: build:chrome, build:safari
cd ..

# 3. Build the Web Agents API extension (window.ai / window.agent)
cd web-agents-api
npm install
npm run build       # outputs to dist-firefox/
cd ..
```

> Firefox is the primary target. Use `npm run build:chrome` (or `build:all`) when you need Chrome builds. See `AGENTS.md`.

### Load Extensions for Testing (Firefox)

Both extensions must be loaded together:

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `extension/dist-firefox/manifest.json` (the Harbor extension).
3. Click **Load Temporary Add-on…** again and select `web-agents-api/dist-firefox/manifest.json` (the Web Agents API extension).
4. The Harbor sidebar icon should appear. Open it and confirm "Bridge: Connected".

For Chrome, use `dist-chrome/` instead and follow `docs/QUICKSTART_CHROME.md` (Chrome requires updating the native messaging manifest with the extension ID).

---

## Project Structure

```
harbor/
├── extension/              # Harbor Extension - Infrastructure (TypeScript + esbuild)
│   ├── src/
│   │   ├── background.ts   # Native messaging, server management
│   │   ├── sidebar.ts      # Main sidebar UI
│   │   ├── js-runtime/     # In-browser JS MCP runtime
│   │   ├── wasm/           # In-browser WASM MCP runtime
│   │   ├── llm/            # LLM provider abstraction
│   │   ├── mcp/            # MCP protocol & host
│   │   └── policy/         # Feature flags
│   ├── dist-firefox/       # Built output (Firefox, default)
│   └── dist-chrome/        # Built output (Chrome)
│
├── web-agents-api/         # Web Agents API Extension - Implements window.ai/agent
│   ├── src/
│   │   ├── background.ts   # Cross-extension messaging to Harbor
│   │   ├── injected.ts     # window.ai / window.agent / navigator.modelContext
│   │   ├── content-script.ts  # Script injection bridge
│   │   ├── handlers/       # Message routing (ai.*, agent.*)
│   │   └── policy/         # Feature flags
│   ├── dist-firefox/       # Built output (Firefox, default)
│   └── dist-chrome/        # Built output (Chrome)
│
├── bridge-rs/              # Rust Native Messaging Bridge
│   ├── src/
│   │   ├── main.rs         # Entry point
│   │   ├── native_messaging.rs  # Stdin/stdout JSON framing
│   │   ├── rpc/            # RPC method handlers
│   │   ├── llm/            # LLM provider configuration
│   │   ├── js/             # QuickJS runtime for JS MCP servers
│   │   ├── oauth/          # OAuth flow handling
│   │   └── fs/             # Filesystem utilities
│   └── any-llm-rust/       # Multi-provider LLM library (submodule)
│
├── demo/                   # Demo web pages
│   ├── web-agents/         # Web Agent API demos
│   └── web-agent-control/  # Browser interaction demos
│
├── mcp-servers/            # MCP server examples and templates
│   ├── builtin/            # Built-in servers (echo, time)
│   ├── examples/           # Example implementations
│   └── templates/          # Starter templates
│
├── docs/                   # Documentation
│   ├── USER_GUIDE.md       # End-user guide
│   ├── DEVELOPER_GUIDE.md  # API reference for app developers
│   ├── LLMS.txt            # AI agent reference
│   ├── JS_AI_PROVIDER_API.md
│   ├── MCP_HOST.md
│   └── TESTING_YOUR_APP.md # Testing apps that use the API
│
├── installer/              # Distributable packages
│   └── macos/              # macOS .pkg builder
│
├── ARCHITECTURE.md         # System architecture
├── CONTRIBUTING.md         # This file
└── README.md               # Project overview
```

### Key Components

| Component | Path | Description |
|-----------|------|-------------|
| **Web Agent API** | `web-agents-api/src/injected.ts` | window.ai/window.agent implementation |
| **Permission System** | `web-agents-api/src/policy/` | Origin permission grants |
| **Harbor Client** | `web-agents-api/src/harbor-client.ts` | Cross-extension messaging to Harbor |
| **Native Messaging** | `bridge-rs/src/native_messaging.rs` | Stdin/stdout JSON framing |
| **RPC Handlers** | `bridge-rs/src/rpc/` | All bridge message types |
| **LLM Config** | `bridge-rs/src/llm/` | LLM provider configuration |
| **QuickJS Runtime** | `bridge-rs/src/js/` | Sandboxed JS MCP server execution |
| **OAuth** | `bridge-rs/src/oauth/` | OAuth flow handling |
| **MCP Host** | `extension/src/mcp/` | MCP server management |

---

## Development Workflow

### Watch Mode

For active development:

```bash
# Terminal 1: Build bridge (rerun after changes)
cd bridge-rs
cargo build --release

# Terminal 2: Watch extension
cd extension
npm run dev
```

After each rebuild:
- Bridge: Changes take effect on next extension reload
- Extension: Go to `about:debugging` and click "Reload" on the Harbor extension

### Debugging

**Extension (Browser Console):**
```
Cmd+Shift+J (Mac) or Ctrl+Shift+J
```

**Bridge (Logs):**
The bridge logs to a file. Check:
- macOS: `~/Library/Caches/harbor-bridge.log`
- Linux: `~/.cache/harbor-bridge.log`

For development, you can run the bridge manually:

```bash
cd bridge-rs
echo '{"type":"hello","request_id":"1"}' | cargo run
```

**MCP Server Logs:**
```bash
# View logs for a running server
# In the sidebar, click server name → "Logs"
```

### Data Locations

During development, Harbor stores data in `~/.harbor/`:

| File | Purpose |
|------|---------|
| `harbor.db` | Server configurations (SQLite) |
| `catalog.db` | Catalog cache (SQLite) |
| `installed_servers.json` | Installed servers |
| `secrets/credentials.json` | API keys |
| `sessions/*.json` | Chat sessions |

To reset all state:
```bash
rm -rf ~/.harbor
```

---

## Testing

### Test Suites

| Package | Command | Coverage |
|---------|---------|----------|
| Bridge | `cd bridge-rs && cargo test` | RPC, LLM, JS runtime |
| Extension | `cd extension && npm test` | Provider injection |

### Running Tests

```bash
# Run Rust bridge tests
cd bridge-rs
cargo test

# Run extension tests
cd extension
npm test
```

### Manual QA

Run through key flows as needed: server installation and connection, permission prompts, tool invocation, rate limiting. See [tests/README.md](tests/README.md) for E2E and manual test setup.

---

## Code Style

### Rust

- Follow standard Rust conventions
- Use `cargo fmt` for formatting
- Use `cargo clippy` for linting
- Document public APIs with doc comments

### TypeScript

- Use strict TypeScript (`strict: true` in tsconfig)
- Prefer `interface` over `type` for object shapes
- Use explicit return types on exported functions
- Document public APIs with JSDoc comments

### Logging and Debug Statements

The codebase contains `console.log` statements used for debugging during development. For production releases:

- **Debug flags**: Files with `const DEBUG = true/false` should have DEBUG set to `false` before release
- **Console logging**: Console statements are intentionally left in place for debugging. They appear in the browser's extension console and don't affect end users
- **Bridge logging**: The Rust bridge uses the `tracing` crate and logs to `~/.cache/harbor-bridge.log`

When adding new debugging output, prefer using the existing DEBUG flag pattern:
```typescript
const DEBUG = false;  // Set to true for development
if (DEBUG) console.log('Debug info:', data);
```

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Rust files | `snake_case.rs` | `native_messaging.rs` |
| TS files | `kebab-case.ts` | `tool-registry.ts` |
| Rust structs | `PascalCase` | `LlmConfig` |
| TS classes | `PascalCase` | `McpHost` |
| Functions | `snake_case` (Rust) / `camelCase` (TS) | `list_tools()` / `listTools()` |

### Commit Messages

Start the subject line with a short prefix, then say what changed. Most commits use a [conventional commit](https://www.conventionalcommits.org/) type, optionally with a scope:

```
feat: add tool router for intelligent server selection
fix(extension): handle server crash during tool call
docs: update developer guide with new APIs
chore: upgrade dependencies
```

Naming the area you changed works too, especially for a series of commits in one area:

```
bridge: honor configured default model
permissions: sidebar Activity panel surfaces every policy decision
```

Use the body to explain why the change was needed and how you tested it.

---

## How We Track Work

The maintainers plan and track work in an internal tracker (Linear). Its tickets have IDs like `HBR-123`, and you'll see those IDs in PR descriptions and commits. You don't need access to that tracker to contribute, and nothing in this repo should depend on it.

- **GitHub Issues are open.** Bug reports and feature requests from anyone are welcome there.
- **Ticket IDs go in the PR body, not the title.** Put a line like `Fixes HBR-123` in the description. This links the PR to the ticket without cluttering the title. Outside contributors can skip it.
- **Everything a reviewer needs lives in the PR.** A ticket link supplements the description; it never replaces it. See [Writing the Description](#writing-the-description).

---

## Pull Request Process

### Writing the Description

A PR should make sense to someone who can't see any ticket, chat thread, or meeting notes. Write the description for that reader:

- **The problem.** What was broken or missing, and how it showed up. Include the error message or the steps that reproduce it.
- **The change.** What you changed and why you chose that approach. If the change touches several areas, group the explanation by file or component.
- **The testing.** What you actually ran and what happened, for example "`cargo test` passes" or "tried it in Firefox with llama3.2: 1 tool call instead of 5". Also say what you didn't test.
- **What's left.** Known limits and follow-ups that this PR doesn't fix.

If you mention another internal ticket, describe it in a few words, for example "(the Ollama provider drops `tool_calls`, HBR-10)", so the reference still means something to readers who can't open it.

### Keeping PRs Independent

- Base each PR on `main` and keep it to one change, so PRs can be reviewed and merged in any order.
- If a PR has to build on another one, say so at the top of the description and target that PR's branch.
- Don't mix unrelated cleanups into a fix. Open a separate PR for them.

### AI-Assisted Contributions

AI-assisted contributions are welcome. [AGENTS.md](AGENTS.md) gives instructions to coding agents working in this repo.

The bar is the same as for any other PR. You're responsible for what you submit, so make sure you understand the change and have actually tested it. A `Co-Authored-By` trailer naming the tool is a welcome way to say a commit was AI-assisted.

### Before Submitting

1. **Run tests**:
   ```bash
   cd bridge-rs && cargo test
   cd extension && npm test
   ```

2. **Format and lint**:
   ```bash
   cd bridge-rs && cargo fmt && cargo clippy
   ```

3. **Test manually**:
   - Load the extension in Firefox
   - Verify your changes work as expected
   - Check the Browser Console for errors

4. **Update documentation** if you're changing:
   - APIs → Update `DEVELOPER_GUIDE.md` and `LLMS.txt`
   - Architecture → Update `ARCHITECTURE.md`
   - User-facing features → Update `USER_GUIDE.md`

### PR Template

```markdown
## Description
<!-- What was wrong or missing, and what this PR changes. It should make sense without any linked ticket. -->

<!-- Maintainers: add "Fixes HBR-123" here if there's a ticket. -->

## Testing
<!-- What you ran and what happened. Also note what you didn't test. -->

## Checklist
- [ ] Tests pass (`cargo test`, `npm test`)
- [ ] Code formatted (`cargo fmt`)
- [ ] Extension loads without errors
- [ ] Documentation updated (if applicable)
```

### Review Process

1. Open a PR against `main`
2. Wait for CI checks to pass
3. Request review
4. Address feedback
5. Merge when approved

---

## Common Tasks

### Adding a New RPC Message Type

1. Define the message type in `bridge-rs/src/rpc/mod.rs`
2. Add handler function
3. Add response handling in `extension/src/background.ts`
4. Update documentation in `README.md` or `DEVELOPER_GUIDE.md`

### Adding a New LLM Provider

1. Add provider implementation in `bridge-rs/any-llm-rust/src/providers/`
2. Register in the provider registry
3. Update detection logic in `bridge-rs/src/llm/`

---

## Release Checklist

Before a release:

- [ ] All tests pass
- [ ] Manual QA completed (see [tests/README.md](tests/README.md))
- [ ] Version bumped
- [ ] CHANGELOG updated
- [ ] Documentation reviewed and up-to-date
- [ ] Extension signed (for production)
- [ ] Installer built and tested

---

## Getting Help

- **Architecture questions**: Check `ARCHITECTURE.md` first
- **API questions**: Check `DEVELOPER_GUIDE.md`
- **Test questions**: Check [tests/README.md](tests/README.md); for testing your own app that uses the API, see [docs/TESTING_YOUR_APP.md](docs/TESTING_YOUR_APP.md)
- **File issues**: For bugs or feature requests


