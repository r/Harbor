# Harbor

A Firefox extension with a native TypeScript/Node.js bridge for MCP (Model Context Protocol) server communication.

## How It Works

Harbor uses Firefox's [Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) to communicate with a local Node.js process:

```
┌──────────────────┐                              ┌──────────────────┐
│ Firefox Extension│  ◄── stdin/stdout JSON ──►  │ Node.js Bridge   │
│   (sidebar UI)   │                              │  (auto-started)  │
└──────────────────┘                              └──────────────────┘
```

**Key point: You don't manually start the bridge.** Firefox automatically launches it when the extension connects. Here's what happens:

1. You install a "native messaging manifest" that tells Firefox where the bridge launcher script is
2. When the extension loads, it calls `browser.runtime.connectNative("harbor_bridge_host")`
3. Firefox reads the manifest, finds the launcher script, and spawns the Node.js process
4. The extension and bridge communicate via JSON messages over stdin/stdout

So setup is: build extension → build bridge → install manifest → load extension in Firefox. That's it!

## Prerequisites

- **Node.js** 18+ and npm
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
├── bridge-ts/                   # TypeScript/Node.js Native Messaging Bridge
│   ├── src/
│   │   ├── main.ts              # Bridge entry point
│   │   ├── native-messaging.ts  # Length-prefixed framing
│   │   ├── handlers.ts          # Message handlers
│   │   ├── server-store.ts      # Server persistence (SQLite)
│   │   ├── mcp-client.ts        # MCP client interface
│   │   ├── catalog/             # Directory/catalog system
│   │   └── installer/           # MCP server installer (app store)
│   ├── scripts/
│   │   ├── install_native_manifest_macos.sh
│   │   └── install_native_manifest_linux.sh
│   └── dist/                    # Built output
└── bridge/                      # (Legacy) Python Native Messaging Bridge
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

### 2. Build the TypeScript Bridge

```bash
cd bridge-ts
npm install
npm run build
```

This produces `dist/main.js` which is the bridge entry point.

### 3. Install Native Messaging Host Manifest

The native messaging manifest is a JSON file that tells Firefox:
- The name of the native app (`harbor_bridge_host`)
- The path to the launcher script
- Which extension IDs are allowed to connect

**This is the critical step** — without it, Firefox won't know how to start the bridge.

#### macOS

```bash
cd bridge-ts/scripts
chmod +x install_native_manifest_macos.sh
./install_native_manifest_macos.sh
```

This installs to: `~/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json`

#### Linux

```bash
cd bridge-ts/scripts
chmod +x install_native_manifest_linux.sh
./install_native_manifest_linux.sh
```

This installs to: `~/.mozilla/native-messaging-hosts/harbor_bridge_host.json`

#### Notes on Extension ID

- For temporary extensions (loaded via `about:debugging`), Firefox assigns a temporary ID
- Use `harbor@example.com` (the ID in manifest.json) for development
- The install scripts are idempotent — safe to run multiple times
- If you change the extension ID, re-run the install script

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
   - A `pong` response with `bridge_version: "0.1.0"`

If you see "Disconnected":
- Check the Firefox Browser Console (`Ctrl+Shift+J`) for errors
- Verify the native manifest is installed correctly
- Ensure the bridge is built: `cd bridge-ts && npm run build`

## Protocol Reference

### Bridge Messages

All messages use JSON with a `type` field and `request_id` for correlation.

#### Server Management

- `add_server` - Add a new remote MCP server
- `remove_server` - Remove a server
- `list_servers` - List all servers
- `connect_server` - Connect to a server
- `disconnect_server` - Disconnect from a server

#### MCP Protocol

- `list_tools` - List tools from connected server
- `list_resources` - List resources
- `list_prompts` - List prompts
- `call_tool` - Invoke a tool

#### Catalog (Directory)

- `catalog_get` - Get catalog (from cache or refresh)
- `catalog_refresh` - Force refresh catalog
- `catalog_search` - Search catalog

#### Installer (App Store)

- `check_runtimes` - Check available runtimes (Node.js, Python, Docker)
- `install_server` - Install a server from catalog
- `uninstall_server` - Uninstall a server
- `list_installed` - List installed servers
- `start_installed` - Start an installed server
- `stop_installed` - Stop a running server
- `set_server_secrets` - Set API keys for a server
- `get_server_status` - Get server status

#### MCP Stdio (Local Servers)

Connect to installed MCP servers via stdio (spawns child process):

- `mcp_connect` - Connect to an installed server via stdio
- `mcp_disconnect` - Disconnect from a server
- `mcp_list_connections` - List all active connections
- `mcp_list_tools` - List tools from connected server
- `mcp_list_resources` - List resources from connected server
- `mcp_list_prompts` - List prompts from connected server
- `mcp_call_tool` - Call a tool with arguments
- `mcp_read_resource` - Read a resource by URI
- `mcp_get_prompt` - Get a prompt with arguments
- `mcp_get_logs` - Get stderr logs from server process

#### Credentials

Manage API keys and authentication for MCP servers:

- `set_credential` - Set a credential (API key, password, etc.)
- `get_credential_status` - Get status of all credentials for a server
- `validate_credentials` - Validate credentials against requirements
- `delete_credential` - Delete a credential
- `list_credentials` - List credentials (metadata only, no values)

Credential types:
- `api_key` - Single token/key value (e.g., OPENAI_API_KEY)
- `password` - Username + password pair
- `oauth` - OAuth 2.0 tokens (future)
- `header` - Custom header values

#### LLM Integration

Interact with local LLMs (llamafile, etc.):

- `llm_detect` - Detect available LLM providers
- `llm_list_providers` - List all providers and status
- `llm_set_active` - Set the active provider
- `llm_list_models` - List models from active provider
- `llm_chat` - Send a chat completion request
- `llm_get_active` - Get active provider status

Supported providers:
- `llamafile` - Mozilla llamafile (localhost:8080)
- Future: `ollama`, `openai`, `anthropic`

#### Chat Orchestration

Full agent loop that connects LLM to MCP tools:

- `chat_create_session` - Create a new chat session with enabled servers
- `chat_send_message` - Send a message and run the orchestration loop
- `chat_get_session` - Get a chat session by ID
- `chat_list_sessions` - List all chat sessions
- `chat_delete_session` - Delete a chat session
- `chat_update_session` - Update session settings
- `chat_clear_messages` - Clear messages from a session

The orchestration loop:
1. Collects tools from enabled MCP servers
2. Sends user message to LLM with tool definitions
3. If LLM requests tool calls, executes them via MCP
4. Feeds tool results back to LLM
5. Repeats until LLM produces a final response

### Error Responses

All errors follow this format:
```json
{
  "type": "error",
  "request_id": "...",
  "error": {
    "code": "error_code",
    "message": "Human readable message",
    "details": { ... }
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
│  Firefox Extension  │ ◄──── (stdio JSON) ────► │   Node.js Bridge    │
│                     │                          │                     │
│  - background.ts    │                          │  - native-messaging │
│  - sidebar UI       │                          │  - handlers         │
│                     │                          │  - server-store     │
└─────────────────────┘                          │  - mcp-client       │
                                                 │  - catalog          │
                                                 │  - installer        │
                                                 └─────────────────────┘
                                                           │
                                                           │ HTTP / stdio
                                                           ▼
                                                 ┌─────────────────────┐
                                                 │   MCP Servers       │
                                                 │ (remote or local)   │
                                                 └─────────────────────┘
```

## Data Storage

All data is stored in `~/.harbor/`:
- `harbor.db` - Server configurations (SQLite)
- `catalog.db` - Catalog cache (SQLite)
- `installed_servers.json` - Installed server configs
- `secrets/credentials.json` - API keys (restricted permissions)
- `sessions/*.json` - Chat session history

## Directory (Catalog) Dev Notes

The Harbor Directory provides a browsable catalog of MCP servers from multiple sources.

### Data Sources

1. **Official Registry** (`official_registry`) - Primary source of truth
   - API: `https://registry.modelcontextprotocol.io/v0/servers`
   - Supports pagination and search

2. **GitHub Awesome List** (`github_awesome`) - Community curated
   - Source: `https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md`
   - Best-effort markdown parsing

### Caching

- **TTL**: 1 hour
- **Storage**: SQLite database (`~/.harbor/catalog.db`)
- **Force refresh**: Click the ↻ button or use `catalog_refresh` message

### App Store (Installer)

The bridge can install and run local MCP servers:

1. **Runtime Detection** - Checks for Node.js (npx), Python (uvx), Docker
2. **Package Installation** - Uses `npx -y package` or `uvx package`
3. **Process Management** - Start/stop servers, capture logs
4. **Secret Management** - Store API keys securely

## Roadmap

- [x] v0: Native messaging hello/pong
- [x] v0.1: Server management (add/remove/connect/disconnect)
- [x] v0.2: Directory with catalog providers
- [x] v0.3: TypeScript bridge with SQLite caching
- [x] v0.4: App Store for local MCP servers
- [x] v0.5: MCP stdio client with SDK integration
- [x] v0.6: Credential management (API keys, passwords)
- [x] v0.7: LLM integration (llamafile provider)
- [x] v0.8: Chat orchestration (agent loop)
- [ ] v0.9: Extension UI for chat and installed servers
- [ ] v1.0: Production-ready release

## License

MIT
