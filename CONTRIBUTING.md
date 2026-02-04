# Contributing to Harbor

This guide is for developers who want to contribute to Harbor itself. If you're looking to build applications using Harbor, see [Developer Guide](docs/DEVELOPER_GUIDE.md) instead.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Project Structure](#project-structure)
3. [Development Workflow](#development-workflow)
4. [Testing](#testing)
5. [Code Style](#code-style)
6. [Pull Request Process](#pull-request-process)

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
git clone --recurse-submodules https://github.com/r/Harbor.git
cd harbor

# If you already cloned without submodules:
git submodule update --init --recursive
```

### Full Build

```bash
# Build the Rust bridge
cd bridge-rs
cargo build --release
cd ..

# Build the extension
cd extension
npm install
npm run build
cd ..

# Install native messaging manifest
cd bridge-rs
./install.sh
cd ..
```

### Load Extension for Testing

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select `extension/dist/manifest.json`
4. The Harbor sidebar icon should appear

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
│   └── dist/               # Built output
│
├── web-agents-api/         # Web Agents API Extension - Implements window.ai/agent
│   ├── src/
│   │   ├── background.ts   # Cross-extension messaging to Harbor
│   │   ├── injected.ts     # window.ai and window.agent implementation
│   │   ├── content-script.ts  # Script injection
│   │   └── policy/         # Permission system
│   └── dist/               # Built output
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
│   └── TESTING_PLAN.md
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

See [TESTING_PLAN.md](docs/TESTING_PLAN.md) for comprehensive manual QA scenarios including:
- Server installation and connection
- Permission flows
- Tool invocation
- Rate limiting
- JSON configuration import

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

Use conventional commits:

```
feat: add tool router for intelligent server selection
fix: handle server crash during tool call
docs: update developer guide with new APIs
test: add integration tests for permissions
chore: upgrade dependencies
```

---

## Pull Request Process

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
<!-- What does this PR do? -->

## Testing
<!-- How did you test this? -->

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
- [ ] Manual QA completed (see TESTING_PLAN.md)
- [ ] Version bumped
- [ ] CHANGELOG updated
- [ ] Documentation reviewed and up-to-date
- [ ] Extension signed (for production)
- [ ] Installer built and tested

---

## Getting Help

- **Architecture questions**: Check `ARCHITECTURE.md` first
- **API questions**: Check `DEVELOPER_GUIDE.md`
- **Test questions**: Check `TESTING_PLAN.md`
- **File issues**: For bugs or feature requests


