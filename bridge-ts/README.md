# Harbor Bridge (TypeScript)

Native messaging bridge for the Harbor Firefox extension, written in TypeScript.

## Requirements

- Node.js 18+ (for ES modules and native fetch)
- npm

## Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Install native messaging manifest (macOS)
./scripts/install_native_manifest_macos.sh

# Install native messaging manifest (Linux)
./scripts/install_native_manifest_linux.sh
```

## Development

```bash
# Build and watch for changes
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Architecture

The bridge communicates with the Firefox extension via stdin/stdout using Mozilla's native messaging protocol:
- Messages are framed with a 4-byte little-endian length prefix
- Payloads are JSON-encoded UTF-8 text

### Core Modules

| Module | Description |
|--------|-------------|
| `native-messaging.ts` | Native messaging protocol (stdin/stdout framing) |
| `server-store.ts` | SQLite storage for MCP server configurations |
| `mcp-client.ts` | MCP client for connecting to remote servers |
| `handlers.ts` | Message handlers for all bridge operations |
| `types.ts` | Shared TypeScript types |

### Directory System (`/directory`)

Curated list of recommended MCP servers for easy installation:
- `curated-servers.ts` - Static server definitions with install metadata
- `index.ts` - Directory exports

### MCP System (`/mcp`)

MCP protocol implementation using the official SDK:
- `manager.ts` - Connection lifecycle and tool management
- `stdio-client.ts` - Stdio transport for local servers

### Host System (`/host`)

Execution environment with security and observability:
- `host.ts` - Main host coordinator
- `permissions.ts` - Capability-based permission system
- `tool-registry.ts` - Namespaced tool registration
- `rate-limiter.ts` - Rate limiting and budgets
- `observability.ts` - Metrics and logging

### Installer System (`/installer`)

Package installation and runtime management:
- `manager.ts` - Installed server management
- `runtime.ts` - Runtime detection (Node.js, Python, Docker)
- `runner.ts` - Package runner (npx, uvx, docker)
- `secrets.ts` - Secure credential storage

### LLM System (`/llm`)

Local LLM integration:
- `manager.ts` - Provider detection and management
- `llamafile.ts` - Mozilla llamafile provider
- `ollama.ts` - Ollama provider
- `provider.ts` - Provider interface

### Chat System (`/chat`)

Chat orchestration with tool calling:
- `orchestrator.ts` - Agent loop implementation
- `session.ts` - Session management
- `store.ts` - Session persistence
- `tool-router.ts` - Intelligent tool selection

### Auth System (`/auth`)

OAuth and credential management:
- `auth-manager.ts` - Credential lifecycle
- `oauth-provider.ts` - OAuth flow handling
- `oauth-server.ts` - Local callback server

## Message Types

### Server Management
- `add_server` - Add a new remote MCP server
- `remove_server` - Remove a server
- `list_servers` - List all servers
- `connect_server` - Connect to a server
- `disconnect_server` - Disconnect from a server

### MCP Protocol (Stdio)
- `mcp_connect` - Connect to an installed server via stdio
- `mcp_disconnect` - Disconnect from a server
- `mcp_list_connections` - List active connections
- `mcp_list_tools` - List tools from connected server
- `mcp_call_tool` - Call a tool with arguments

### Directory
- `get_curated_servers` - Get curated server list
- `install_curated` - Install from curated list

### Installer
- `check_runtimes` - Check available runtimes
- `install_server` - Install a server
- `uninstall_server` - Uninstall a server
- `list_installed` - List installed servers
- `start_installed` - Start an installed server
- `stop_installed` - Stop a running server

### Host
- `host_list_tools` - List tools with permission check
- `host_call_tool` - Call tool with permission/rate limit enforcement
- `host_grant_permission` - Grant permission to origin
- `host_check_permission` - Check permission status

### LLM
- `llm_detect` - Detect available LLM providers
- `llm_list_providers` - List all providers
- `llm_set_active` - Set active provider
- `llm_chat` - Send chat completion

### Chat
- `chat_create_session` - Create chat session
- `chat_send_message` - Send message (runs agent loop)
- `chat_get_session` - Get session history
- `chat_delete_session` - Delete session

### Credentials
- `set_credential` - Set a credential
- `get_credential_status` - Check credential status
- `delete_credential` - Delete a credential

## Data Storage

All data is stored in `~/.harbor/`:
- `harbor.db` - Server configurations (SQLite)
- `installed_servers.json` - Installed server configs
- `secrets/credentials.json` - API keys (restricted permissions)
- `sessions/*.json` - Chat session history

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test
npm test -- src/host/__tests__/permissions.test.ts
```
