# CLAUDE.md - Harbor Project Reference

## Project Overview

Harbor is a Firefox browser extension with a native Node.js bridge that brings AI models and MCP (Model Context Protocol) tools to web applications. It enables web pages to access AI capabilities via `window.ai` and `window.agent` APIs while maintaining strict origin-based permissions and local-first privacy.

## Tech Stack

- **Extension**: TypeScript, Vite, Web Extensions API (Firefox MV3)
- **Bridge**: Node.js 18+, TypeScript, MCP SDK, better-sqlite3, drizzle-orm
- **LLM Providers**: Ollama, llamafile, custom providers via any-llm-ts submodule
- **Testing**: Vitest
- **Packaging**: esbuild, pkg (binary), macOS PKG installer

## Project Structure

```
harbor/
├── extension/           # Firefox Extension
│   ├── src/
│   │   ├── background.ts       # Native messaging, permissions
│   │   ├── sidebar.ts          # Main UI (servers, chat, settings)
│   │   ├── directory.ts        # Server catalog UI
│   │   └── provider/           # window.ai/window.agent injection
│   └── manifest.json
├── bridge-ts/           # Node.js Native Messaging Bridge
│   └── src/
│       ├── main.ts             # Entry point, message loop
│       ├── handlers.ts         # 50+ message type dispatch
│       ├── types.ts            # Shared interfaces
│       ├── host/               # MCP host, permissions, rate limiting
│       ├── mcp/                # MCP protocol clients
│       ├── llm/                # LLM provider abstraction
│       ├── chat/               # Agent loop, tool routing
│       ├── installer/          # Server installation, Docker
│       ├── catalog/            # Server directory, database
│       └── any-llm-ts/         # Git submodule - unified LLM interface
├── demo/                # Example web pages
├── installer/macos/     # macOS .pkg builder
└── docs/                # Documentation
```

## Build & Run

### Prerequisites
- Node.js 18+, Firefox 109+
- Ollama or llamafile (for LLM)
- Optional: Python 3.9+ with uvx, Docker

### Build from Source

```bash
# Clone with submodules
git clone --recurse-submodules <repo-url>
cd harbor

# Build any-llm-ts submodule first
cd bridge-ts/src/any-llm-ts && npm install && npm run build && cd ../../..

# Build bridge
cd bridge-ts && npm install && npm run build && cd ..

# Build extension
cd extension && npm install && npm run build && cd ..

# Install native messaging manifest (macOS)
./bridge-ts/scripts/install_native_manifest_macos.sh

# Load in Firefox: about:debugging → Load Temporary Add-on → extension/dist/manifest.json
```

### Development

```bash
# Watch mode
cd bridge-ts && npm run dev
cd extension && npm run dev
```

### Testing

```bash
cd bridge-ts && npm test
cd extension && npm test

# With coverage
npm run test:coverage
```

## Key Architectural Concepts

### Message Flow
```
Web Page (window.ai) → Extension (background.ts) → Native Messaging → Bridge (handlers.ts) → MCP/LLM
```

### Permission System
- **Scopes**: `model:prompt`, `model:tools`, `mcp:tools.list`, `mcp:tools.call`, `browser:activeTab.read`
- **Grants**: `ALLOW_ONCE` (10min), `ALLOW_ALWAYS` (persistent), `DENY`
- Stored in browser storage (persistent) and memory (ephemeral)

### Tool Registry
- Tools namespaced as `{serverId}/{toolName}` (e.g., `filesystem/read_file`)
- Automatic registration on MCP server connection

### Server Lifecycle
```
INSTALLING → STOPPED → STARTING → RUNNING ↔ CRASHED (auto-restart 3x)
```

### Data Storage
All data in `~/.harbor/`:
- `harbor.db` - Server configs (SQLite)
- `catalog.db` - Cached catalog
- `secrets/credentials.json` - API keys (mode 600)
- `sessions/*.json` - Chat history

## Common Development Tasks

### Add New Message Type
1. Define in `bridge-ts/src/types.ts`
2. Add handler in `bridge-ts/src/handlers.ts`
3. Add response handling in `extension/src/background.ts`

### Add Curated MCP Server
Edit `bridge-ts/src/directory/curated-servers.ts`

### Add New LLM Provider
1. Create `bridge-ts/src/llm/newprovider.ts` implementing `LLMProvider`
2. Register in `bridge-ts/src/llm/manager.ts`

## Code Conventions

- **Files**: `kebab-case.ts`
- **Classes/Interfaces**: `PascalCase`
- **Functions**: `camelCase`
- **Constants**: `SCREAMING_SNAKE`
- **Commits**: Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- **TypeScript**: Strict mode, explicit return types on exports
- **Formatting**: 2-space indent, LF line endings (see `.editorconfig`)

## Key Files

| File | Purpose |
|------|---------|
| `extension/src/background.ts` | Extension entry, native messaging |
| `extension/src/sidebar.ts` | Main UI (3150 lines) |
| `bridge-ts/src/handlers.ts` | Message dispatch (3430 lines) |
| `bridge-ts/src/host/host.ts` | MCP host orchestration |
| `bridge-ts/src/chat/orchestrator.ts` | Agent loop implementation |

## Documentation

- `ARCHITECTURE.md` - System design, security model
- `docs/USER_GUIDE.md` - Installation and usage
- `docs/DEVELOPER_GUIDE.md` - API reference
- `docs/JS_AI_PROVIDER_API.md` - window.ai/window.agent API
- `docs/MCP_HOST.md` - MCP execution internals
- `CONTRIBUTING.md` - Development setup
