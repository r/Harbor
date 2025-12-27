# Harbor

A Firefox extension with a native Python bridge for MCP (Model Context Protocol) server communication.

## How It Works

Harbor uses Firefox's [Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) to communicate with a local Python process:

```
┌──────────────────┐                              ┌──────────────────┐
│ Firefox Extension│  ◄── stdin/stdout JSON ──►  │  Python Bridge   │
│   (sidebar UI)   │                              │  (auto-started)  │
└──────────────────┘                              └──────────────────┘
```

**Key point: You don't manually start the bridge.** Firefox automatically launches it when the extension connects. Here's what happens:

1. You install a "native messaging manifest" that tells Firefox where the bridge launcher script is
2. When the extension loads, it calls `browser.runtime.connectNative("com.harbor.bridge")`
3. Firefox reads the manifest, finds the launcher script, and spawns the Python process
4. The extension and bridge communicate via JSON messages over stdin/stdout

So setup is: build extension → sync Python deps → install manifest → load extension in Firefox. That's it!

## Prerequisites

- **Node.js** 18+ and npm
- **uv** — Install with `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **Firefox** 109+

## Project Structure

```
harbor/
├── extension/                    # Firefox Extension (TypeScript, MV3)
│   ├── src/
│   │   ├── background.ts        # Native messaging, server management
│   │   ├── sidebar.ts           # Sidebar UI logic
│   │   └── sidebar.html         # Sidebar UI
│   └── dist/                    # Built output
└── bridge/                      # Python Native Messaging Bridge
    ├── src/harbor_bridge/
    │   ├── main.py              # Bridge entry point
    │   ├── native_messaging.py  # Length-prefixed framing
    │   ├── handlers.py          # Message handlers
    │   ├── server_store.py      # Server persistence
    │   └── mcp_client.py        # MCP client interface
    ├── scripts/
    │   ├── harbor_bridge_launcher.sh
    │   ├── install_native_manifest_macos.sh
    │   ├── install_native_manifest_linux.sh
    │   └── run_demo_server.py   # Demo MCP server for testing
    └── .data/                   # Persistent data (servers.json)
```

## Local Development

### 1. Build the Extension

```bash
cd extension
npm install
npm run build
```

This produces `dist/` with:
- `background.js` — Native messaging + server management
- `sidebar.js` + `sidebar.html` — UI
- `manifest.json` — Firefox MV3 manifest

For development with watch mode:
```bash
npm run dev
```

### 2. Set Up the Python Bridge

The bridge is automatically started by Firefox — you just need to install dependencies:

```bash
cd bridge

# Sync dependencies (creates venv automatically)
uv sync
```

#### Run Tests, Linting, and Type Checking (optional)

```bash
# Format and lint
uv run ruff format .
uv run ruff check --fix .

# Type check (strict mode)
uv run mypy .

# Run tests
uv run pytest

# All together
uv run ruff format . && uv run ruff check --fix . && uv run mypy . && uv run pytest
```

### 3. Install Native Messaging Host Manifest

The native messaging manifest is a JSON file that tells Firefox:
- The name of the native app (`com.harbor.bridge`)
- The path to the launcher script
- Which extension IDs are allowed to connect

**This is the critical step** — without it, Firefox won't know how to start the bridge.

#### macOS

```bash
cd bridge/scripts
chmod +x harbor_bridge_launcher.sh install_native_manifest_macos.sh
./install_native_manifest_macos.sh harbor@example.com
```

This installs to: `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.harbor.bridge.json`

#### Linux

```bash
cd bridge/scripts
chmod +x harbor_bridge_launcher.sh install_native_manifest_linux.sh
./install_native_manifest_linux.sh harbor@example.com
```

This installs to: `~/.mozilla/native-messaging-hosts/com.harbor.bridge.json`

#### Notes on Extension ID

- For temporary extensions (loaded via `about:debugging`), Firefox assigns a temporary ID
- Use `harbor@example.com` (the ID in manifest.json) for development
- The install scripts are idempotent — safe to run multiple times
- If you change the extension ID, re-run the install script with the new ID

### 4. Load the Extension in Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on..."**
3. Navigate to `extension/dist/` and select `manifest.json`
4. The Harbor sidebar icon should appear in your browser

#### Finding the Extension ID

After loading:
1. In `about:debugging`, find Harbor in the list
2. The **Extension ID** is shown (e.g., `harbor@example.com` or a UUID for temporary addons)
3. If using a different ID, update the native manifest

### 5. Verify the Connection

1. Click the Harbor sidebar icon to open the sidebar
2. Click **"Send Hello"**
3. You should see:
   - "Bridge Connection: Connected" (green indicator)
   - A `pong` response with `bridge_version: "0.0.1"`

If you see "Disconnected":
- Check the Firefox Browser Console (`Ctrl+Shift+J`) for errors
- Verify the native manifest is installed correctly
- Ensure dependencies are synced: `cd bridge && uv sync`

### 6. Test with Demo MCP Server (Optional)

The demo server is a simple HTTP server for testing the "Add Server" / "Connect" flow without needing a real MCP server.

In one terminal, start the demo server:

```bash
cd bridge
uv run python scripts/run_demo_server.py --port 8765
```

Then in the Harbor sidebar:
1. Enter label: `Demo Server`
2. Enter URL: `http://localhost:8765`
3. Click **"Add Server"**
4. Click **"Connect"** on the server card
5. Should show "Connected" status

> **Note:** This demo server is just for testing connectivity. It doesn't implement the full MCP protocol yet.

## Protocol Reference

### Bridge Messages

All messages use JSON with a `type` field and `request_id` for correlation.

#### hello → pong
```json
// Request
{ "type": "hello", "request_id": "..." }

// Response
{ "type": "pong", "request_id": "...", "bridge_version": "0.0.1" }
```

#### add_server → add_server_result
```json
// Request
{ "type": "add_server", "request_id": "...", "label": "My Server", "base_url": "https://..." }

// Response
{ "type": "add_server_result", "request_id": "...", "server": { ... } }
```

#### list_servers → list_servers_result
```json
// Request
{ "type": "list_servers", "request_id": "..." }

// Response
{ "type": "list_servers_result", "request_id": "...", "servers": [...] }
```

#### connect_server → connect_server_result
```json
// Request
{ "type": "connect_server", "request_id": "...", "server_id": "..." }

// Response (success)
{ "type": "connect_server_result", "request_id": "...", "server": { ... } }

// Response (error)
{ "type": "error", "request_id": "...", "error": { "code": "...", "message": "..." } }
```

#### disconnect_server → disconnect_server_result
```json
// Request
{ "type": "disconnect_server", "request_id": "...", "server_id": "..." }

// Response
{ "type": "disconnect_server_result", "request_id": "...", "server": { ... } }
```

#### list_tools → list_tools_result
```json
// Request
{ "type": "list_tools", "request_id": "...", "server_id": "..." }

// Response
{ "type": "list_tools_result", "request_id": "...", "tools": [], "_todo": "..." }
```

### Error Responses

All errors follow this format:
```json
{
  "type": "error",
  "request_id": "...",
  "error": {
    "code": "error_code",
    "message": "Human readable message",
    "details": { ... }  // optional
  }
}
```

Error codes:
- `invalid_params` — Missing or invalid parameters
- `not_found` — Server not found
- `not_connected` — Server not connected
- `connection_failed` — Failed to connect to server
- `unknown_message_type` — Unknown message type

## Architecture

```
┌─────────────────────┐     Native Messaging     ┌─────────────────────┐
│  Firefox Extension  │ ◄──── (stdio JSON) ────► │   Python Bridge     │
│                     │                          │                     │
│  - background.ts    │                          │  - native_messaging │
│  - sidebar UI       │                          │  - handlers         │
│                     │                          │  - server_store     │
└─────────────────────┘                          │  - mcp_client       │
                                                 └─────────────────────┘
                                                           │
                                                           │ HTTP
                                                           ▼
                                                 ┌─────────────────────┐
                                                 │   MCP Servers       │
                                                 │   (remote HTTP)     │
                                                 └─────────────────────┘
```

## Directory (Catalog) Dev Notes

The Harbor Directory provides a browsable catalog of MCP servers from multiple sources.

### Data Sources

1. **Official Registry** (`official_registry`) - Primary source of truth
   - API: `https://registry.modelcontextprotocol.io/v0/servers`
   - Supports pagination and search

2. **GitHub Awesome List** (`github_awesome`) - Community curated
   - Source: `https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md`
   - Best-effort markdown parsing

3. **mcpservers.org** - Not implemented (no stable API)

### Caching

- **TTL**: 10 minutes
- **Storage keys**:
  - `catalog.cache.official_registry.v1`
  - `catalog.cache.github_awesome.v1`
- **Force refresh**: Click the ↻ button or use `catalog_refresh` message

### Background Messages

```typescript
// Get catalog (uses cache if fresh)
{ type: 'catalog_get', force?: boolean }

// Force refresh all providers
{ type: 'catalog_refresh' }

// Search with query
{ type: 'catalog_search', query: string, force?: boolean }
```

### Quick Smoke Test

1. Load the extension
2. Click "Open Directory" in the sidebar
3. Verify provider status shows counts (e.g., "Registry: 55")
4. Toggle "Remote Only" to filter connectable servers
5. Click "Add to Harbor" on a remote server
6. Verify it appears in the sidebar server list

## Roadmap

- [x] v0: Native messaging hello/pong
- [x] v0.1: Server management (add/remove/connect/disconnect)
- [x] v0.2: Directory with catalog providers
- [ ] v0.3: Full MCP protocol implementation
- [ ] v0.4: Tool invocation UI
- [ ] v1.0: Production-ready release

## License

MIT
