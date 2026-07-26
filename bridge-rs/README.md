# Harbor Native Bridge

**The native messaging bridge that connects Harbor browser extensions to local resources.**

The bridge is a Rust binary that runs locally and communicates with the browser extension via [Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging). It provides:

- **LLM Provider Access** — Connects to Ollama, OpenAI, Anthropic, and other providers
- **MCP Server Execution** — Runs native MCP servers outside the browser sandbox
- **OAuth Flows** — Handles OAuth authentication for MCP servers
- **Filesystem Access** — Scoped file read/write for MCP servers

---

## Quick Start

### Build

```bash
cargo build --release
```

The binaries are created at `target/release/harbor-bridge` and
`target/release/harbor-agent-gateway`.

### Install (Firefox and Chrome)

```bash
./install.sh
```

This script:
1. Copies `harbor-bridge` and `harbor-agent-gateway` to `~/.harbor/bin/`
2. Creates the Firefox native messaging manifest
3. Creates a Chrome manifest only when `--chrome-extension-id` supplies the
   exact Harbor extension ID

### Verify Installation

**Firefox:**
```bash
cat ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge.json
```

**Chrome:**
```bash
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json
```

---

## Harbor Agent Gateway

`harbor-agent-gateway` is a vendor-neutral MCP stdio server that lets a paired
local coding agent use a small, policy-controlled view of the browser. It is
installed with the native bridge but remains disabled until you explicitly
enable it in Harbor.

Firefox is the primary target. Load both Firefox extensions, install the native
components, and confirm that the Harbor sidebar reports the bridge as connected
before pairing an agent client. Chrome is supported secondarily and still
requires the exact Harbor extension ID in its native messaging manifest.

### Pair a client

1. Open the **Agent Gateway** panel in the Harbor sidebar.
2. Enable the gateway.
3. Choose **Pair client**, enter a recognizable client name, and approve the
   read-only scopes.
4. Copy the client ID and one-time secret into the local agent's MCP
   configuration. Harbor persists an RFC 9807 OPAQUE server setup and a
   per-client OPAQUE registration record, not the raw credential, and does not
   show the credential again.
5. Approve a tab-bound session in Harbor before calling a browser read tool.

The client receives only these MCP tools:

- `harbor.gateway.health`, checks authenticated gateway and browser status
- `harbor.tabs.list`, lists safe metadata for tabs approved by the session
- `harbor.page.observe`, returns a bounded, sanitized observation of the
  session's bound document

### Vendor-neutral MCP stdio configuration

The exact outer configuration shape depends on the MCP client. Register a stdio
server using the installed executable and environment variables equivalent to:

```json
{
  "mcpServers": {
    "harbor": {
      "command": "<path-to-harbor-agent-gateway>",
      "env": {
        "HARBOR_AGENT_GATEWAY_CLIENT_ID": "<client-id-from-harbor>",
        "HARBOR_AGENT_GATEWAY_SECRET": "<one-time-secret-from-harbor>"
      }
    }
  }
}
```

Keep the secret in the client's protected environment or secret store. Do not
put it in command arguments, shell history, logs, or a committed configuration
file. `harbor.tabs.list` and `harbor.page.observe` also require the approved
`sessionId` shown by Harbor.

Gateway IPC uses RFC 9807 OPAQUE mutual authentication. The raw pairing
credential is never sent over the socket. Each login uses fresh client and
server protocol randomness to derive a new session key, and the client verifies
a server confirmation bound to its client ID and browser instance. Captured
login messages cannot be replayed as a later authenticated connection.

The fixed socket path is a discovery location, not a trusted identity. The MCP
client treats any listener there as untrusted until its server proof verifies,
and the native host does not replace a reachable listener merely because it
occupies the expected path.

To revoke access, use **Revoke** for the paired client in the Agent Gateway
panel. Revocation ends its active sessions and invalidates the credential. You
can also disable the gateway to end all sessions and reject every client.

## Browser-Specific Setup

### Firefox

Firefox native messaging works automatically after running `install.sh`. The manifest identifies the extension by its ID in the manifest.json.

**Manifest location:**
- macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json`
- Linux: `~/.mozilla/native-messaging-hosts/harbor_bridge.json`

### Chrome / Chromium Browsers

Chrome requires your specific extension ID in the native messaging manifest. After loading the extension:

1. Get your extension ID from `chrome://extensions`
2. Install the exact native messaging origin:
   ```bash
   ./install.sh --chrome-extension-id YOUR_32_CHARACTER_EXTENSION_ID
   ```
3. Verify `allowed_origins` contains only your extension ID:
   ```json
   "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID_HERE/"]
   ```
4. Restart Chrome completely

**Manifest locations for other Chromium browsers:**
- **Edge:** `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`
- **Brave:** `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
- **Vivaldi:** `~/Library/Application Support/Vivaldi/NativeMessagingHosts/`

### Safari

Safari is different — the bridge is **bundled inside the Harbor.app** and doesn't use native messaging manifests. The app handles communication internally.

You don't need to run `install.sh` for Safari; just build and run the Xcode project.

---

## Development

### Run Directly (for testing)

```bash
cargo run
```

### Watch Mode

```bash
cargo watch -x run
```

### Run Tests

```bash
cargo test
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BROWSER EXTENSION                        │
│  • Sends JSON-RPC requests via native messaging             │
└───────────────────────────────┬─────────────────────────────┘
                                │ stdin/stdout (JSON)
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                     HARBOR BRIDGE                           │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  LLM Layer  │  │  MCP Host   │  │ OAuth/Auth  │         │
│  │             │  │             │  │             │         │
│  │ • Ollama    │  │ • JS runtime│  │ • Google    │         │
│  │ • OpenAI    │  │ • WASM host │  │ • GitHub    │         │
│  │ • Anthropic │  │ • Native    │  │ • Custom    │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    Local Resources (Ollama, files, etc.)
```

---

## Troubleshooting

### "Bridge Disconnected" in the extension

1. **Verify the binary exists:**
   ```bash
   ls -la ~/.harbor/bin/harbor-bridge
   ```

2. **Verify the manifest exists:**
   ```bash
   # Firefox
   cat ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge.json
   
   # Chrome
   cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json
   ```

3. **Check the path in the manifest** points to the correct binary location

4. **Re-run the install script:**
   ```bash
   ./install.sh
   ```

5. **Restart the browser completely** (quit and reopen, not just close tabs)

### Agent Gateway reports `BROWSER_DISCONNECTED`

The MCP process does not launch or impersonate a browser extension. Keep a
Firefox window open with Harbor loaded and confirm that the sidebar reports the
native bridge as connected. If the browser or extension restarts, reconnect it
and approve a new session before retrying browser tools.

### Agent Gateway reports `GATEWAY_SOCKET_OCCUPIED`

The fixed gateway socket has a reachable listener, but Harbor has not verified
that listener's identity. Another Harbor browser instance or profile may be
connected, or an unrelated local process may occupy the path. Close the expected
Harbor instance cleanly, then reopen the intended browser. If the error remains,
inspect the listening process. Do not trust the listener as Harbor and do not
delete the socket while it is active. Harbor removes the socket only when no
process is listening.

### Agent Gateway is disabled or not paired

The default state is disabled. Open Harbor's Agent Gateway panel, enable the
gateway, pair the MCP client, and update both gateway environment variables. If
the client was revoked, create a new pairing rather than reusing its old secret.

### Agent Gateway reports `GATEWAY_CONFIGURATION_MIGRATION_REQUIRED`

Harbor found a legacy version 1 gateway configuration. Its old credential
hashes cannot be converted into RFC 9807 OPAQUE registration records, so the
gateway fails closed.

1. Close every Harbor browser instance and gateway MCP client.
2. In the OS user-local configuration directory, move
   `harbor/agent_gateway.json` to
   `harbor/agent_gateway.v1.backup.json`. Keep the backup until recovery is
   verified.
3. Restart Harbor. It creates a version 2 configuration with the gateway
   disabled.
4. Enable Agent Gateway and explicitly pair every client again.
5. Replace each client's ID and one-time credential environment values.
6. Verify the new pairing, then remove the backup when it is no longer needed.

Do not copy version 1 hashes into the new file or try to edit them into OPAQUE
records.

### Chrome: Extension ID Mismatch

The most common Chrome issue. The extension ID in the manifest must exactly match your loaded extension's ID.

```bash
# Check what ID is in the manifest
grep allowed_origins ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json

# Compare with your extension ID from chrome://extensions
```

### Check Bridge Logs

```bash
# macOS
cat ~/.harbor/logs/bridge.log

# Or check the cache location
cat ~/Library/Caches/harbor-bridge.log
```

---

## Project Structure

```
bridge-rs/
├── src/
│   ├── main.rs              # Entry point, native messaging loop
│   ├── native_messaging.rs  # Native messaging protocol
│   ├── llm/                  # LLM provider integrations
│   ├── mcp/                  # MCP server host
│   ├── oauth/                # OAuth flow handling
│   ├── fs/                   # Filesystem access
│   └── rpc/                  # JSON-RPC handlers
├── any-llm-rust/            # LLM abstraction layer (submodule)
├── native-messaging/         # Manifest templates
├── install.sh               # Installation script
└── Cargo.toml
```

---

## Configuration

The bridge reads configuration from:
- `~/.harbor/config.toml` — User configuration
- Environment variables — For API keys and secrets

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OLLAMA_HOST` | Ollama server URL (default: `http://localhost:11434`) |

---

## See Also

- [Main Quickstart](../QUICKSTART.md) — Full setup guide
- [Firefox Setup](../docs/QUICKSTART_FIREFOX.md) — Firefox-specific instructions
- [Chrome Setup](../docs/QUICKSTART_CHROME.md) — Chrome-specific instructions (extension ID config)
- [Architecture](../ARCHITECTURE.md) — System design overview
