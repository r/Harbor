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
# Run with tsx (development mode)
npm run dev
```

## Architecture

The bridge communicates with the Firefox extension via stdin/stdout using Mozilla's native messaging protocol:
- Messages are framed with a 4-byte little-endian length prefix
- Payloads are JSON-encoded UTF-8 text

### Core Modules

- **native-messaging.ts** - Native messaging protocol (stdin/stdout framing)
- **server-store.ts** - SQLite storage for MCP server configurations  
- **mcp-client.ts** - MCP client for connecting to remote servers

### Catalog System (`/catalog`)

- **base.ts** - Provider base class and types
- **official-registry.ts** - Official MCP Registry provider
- **github-awesome.ts** - GitHub Awesome list provider
- **database.ts** - SQLite catalog cache with priority scoring
- **manager.ts** - Catalog orchestration and caching

### Installer System (`/installer`)

- **runtime.ts** - Runtime detection (Node.js, Python, Docker)
- **runner.ts** - Package runner (npx, uvx, docker)
- **secrets.ts** - Secure storage for API keys
- **manager.ts** - Installed server management

## Message Types

### Server Management
- `add_server` - Add a new remote MCP server
- `remove_server` - Remove a server
- `list_servers` - List all servers
- `connect_server` - Connect to a server
- `disconnect_server` - Disconnect from a server

### MCP Protocol
- `list_tools` - List tools from connected server
- `list_resources` - List resources
- `list_prompts` - List prompts
- `call_tool` - Invoke a tool

### Catalog
- `catalog_get` - Get catalog (from cache or refresh)
- `catalog_refresh` - Force refresh catalog
- `catalog_search` - Search catalog

### Installer (App Store)
- `check_runtimes` - Check available runtimes
- `install_server` - Install a server from catalog
- `uninstall_server` - Uninstall a server
- `list_installed` - List installed servers
- `start_installed` - Start an installed server
- `stop_installed` - Stop a running server
- `set_server_secrets` - Set API keys for a server
- `get_server_status` - Get server status

## Data Storage

All data is stored in `~/.harbor/`:
- `harbor.db` - Server configurations
- `catalog.db` - Catalog cache
- `installed_servers.json` - Installed server configs
- `secrets/credentials.json` - API keys (restricted permissions)





