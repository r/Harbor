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

The binary is created at `target/release/harbor-bridge`. On Apple silicon, building with the macOS 26 SDK or later also produces `harbor-apple-model`. Keep the two executables together. The companion uses Apple’s Foundation Models framework on-device.

### Install (Firefox and Chrome)

```bash
./install.sh
```

This script:
1. Builds `target/release/harbor-bridge` and creates the executable `target/release/harbor-bridge-native` wrapper
2. Creates native messaging manifests for Firefox and Chrome

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

## Browser-Specific Setup

### Firefox

Firefox native messaging works automatically after running `install.sh`. The manifest identifies the extension by its ID in the manifest.json.

**Manifest location:**
- macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json`
- Linux: `~/.mozilla/native-messaging-hosts/harbor_bridge.json`

### Chrome / Chromium Browsers

The checked-in Chrome manifest key pins Harbor's ID to `ljnciidcajlichemnbohopnlaonhkpgm`. The installer automatically writes:

```json
"allowed_origins": ["chrome-extension://ljnciidcajlichemnbohopnlaonhkpgm/"]
```

No manual ID edits are needed for repository builds. The native host is `harbor_bridge`, and its manifest points to this checkout's `target/release/harbor-bridge-native` wrapper, which passes `--native-messaging` to the binary. Keep the checkout in place or rerun the installer after moving it. See the [Chrome setup guide](../docs/QUICKSTART_CHROME.md) for loading both extensions and verifying the connection.

The installer registers Firefox and Google Chrome on macOS and Linux. Other Chromium browsers require separate registration:

**Manifest locations for other Chromium browsers:**
- **Edge:** `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`
- **Brave:** `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
- **Vivaldi:** `~/Library/Application Support/Vivaldi/NativeMessagingHosts/`

### Safari

Safari is different — the bridge is **bundled inside the Harbor.app** and doesn't use native messaging manifests. The app handles communication internally.

You don't need to run `install.sh` for Safari; just build and run the Xcode project.

---

## Default model selection

Chat, streaming, and the `llm.get_config` response share the same default resolver. An explicit request
model wins, followed by the legacy `default_model` field, then a configured
model marked as default, then the first usable configured model. Configured
fallbacks require an enabled provider with credentials for remote providers;
local Ollama, Llamafile, and LM Studio can be auto-detected when no instance is
configured. This checks configuration, not whether the provider is online.

Removing a configured model clears a matching legacy default, so later requests
use the remaining default rather than the removed model. Removing the last model
restores the automatic Apple Intelligence default when the system model is ready, unless a different legacy default was configured. If no usable
default remains, a request without a model fails with "No model specified and no
default model configured".

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
   ls -la target/release/harbor-bridge target/release/harbor-bridge-native
   ```

2. **Verify the manifest exists:**
   ```bash
   # Firefox
   cat ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge.json
   
   # Chrome
   cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json
   ```

3. **Check the path in the manifest** points to this checkout’s executable `target/release/harbor-bridge-native` wrapper

4. **Re-run the install script:**
   ```bash
   ./install.sh
   ```

5. **Restart the browser completely** (quit and reopen, not just close tabs)

### Chrome: Extension ID Mismatch

The origin must match the loaded Harbor extension. Repository builds use `ljnciidcajlichemnbohopnlaonhkpgm`; rerun `./install.sh --skip-build` to refresh an older registration. Custom builds that change the manifest key need their own matching explicit origin.

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
- [Chrome Setup](../docs/QUICKSTART_CHROME.md) — Chrome-specific loading and native messaging
- [Architecture](../ARCHITECTURE.md) — System design overview
