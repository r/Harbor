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

The binary is created at `target/release/harbor-bridge`. On Apple silicon, building with the macOS 26 SDK or later also produces `harbor-apple-model`. Keep the two executables together. The companion uses Apple’s Foundation Models framework on-device. Apple's model reads only part of JSON Schema, so the bridge rewrites each tool's input schema first (`src/llm/apple.rs`). It keeps only the keywords in `APPLE_KEYWORDS` and drops every other one, at any depth. Local `$ref`s are inlined, and nullable types and `oneOf` become `anyOf`. The companion leaves out a tool whose schema it still can't read, names it on stderr, and the bridge logs that as a warning. `apple/test_adapter.py <path to harbor-apple-model>` exercises the companion against the real model, including one tool schema that uses every kept keyword. Run it after a macOS update; if it fails, take the keyword the model now rejects off the list.

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

No manual ID edits are needed for repository builds. The native host is `harbor_bridge`, and its manifest points to this checkout's `target/release/harbor-bridge-native` wrapper, which passes `--native-messaging` to the binary. Keep the checkout in place or rerun the installer after moving it. See the [Chrome setup guide](../docs/QUICKSTART_CHROME.md) for loading the extension and verifying the connection.

The installer registers Firefox and Google Chrome on macOS and Linux. Other Chromium browsers require separate registration:

**Manifest locations for other Chromium browsers:**
- **Edge:** `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`
- **Brave:** `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
- **Vivaldi:** `~/Library/Application Support/Vivaldi/NativeMessagingHosts/`

### Safari

Safari doesn't use native messaging. The extension reaches the bridge over HTTP at `127.0.0.1:8766`, so run the bridge yourself in HTTP mode:

```bash
./target/release/harbor-bridge --http-server
```

You don't need to run `install.sh` for Safari. See [Safari Setup](../docs/QUICKSTART_SAFARI.md) to build and load the Safari app.

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
│   ├── acp/                  # Starts ACP agents and relays their messages
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

### ACP agents

The bridge can start an agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) (ACP) and relay its messages to the extension. The bridge only starts the process and passes messages; the ACP client runs in the extension. See [the ACP backend design](../docs/ACP_BACKEND_DESIGN.md).

Agents are configured in `acp.json`, next to the LLM config (`~/Library/Application Support/harbor/acp.json` on macOS). A missing file means no agents.

```json
{
  "agents": [
    { "id": "goose", "name": "goose", "command": "goose", "args": ["acp"], "env": {} }
  ]
}
```

| Method | What it does |
|--------|--------------|
| `acp.list_agents` | Lists configured agents by `id` and `name`. Commands and environment aren't returned. |
| `acp.get_agents` | Lists configured agents in full, including `command`, `args` and `env`. Only Harbor's own extension pages call this - the extension enforces that; the bridge's own enforcement is that this, like every `acp.*` method, is never reachable outside native messaging at all. |
| `acp.save_agents { agents }` | Validates `agents` (see below) and replaces `acp.json` with it, as a whole list - there's no partial update. Writes atomically (a temp file in the same directory, fsynced, then renamed over the real one; mode `0600`; the directory is fsynced too, after the rename). A symlink at `acp.json` is replaced by a regular file - the rename lands on the link itself, never through it to whatever it pointed at. An agent that's already open keeps running on its old config; only a later `acp.open` sees the new one. Handled inline in the native-messaging read loop (the same treatment as `acp.send`), so a burst of saves lands on disk in the order they were actually sent, not the order their handlers happened to finish. |
| `acp.resolve_command { name }` | Resolves a bare command name to an absolute path by asking the user's login shell, the way a terminal would - useful because Firefox started from the Dock doesn't inherit the user's shell `PATH`, so an `npx`-based preset can't be found from the bridge's own environment either. Returns `{ "path": string \| null }`, unix only (`null` elsewhere). |
| `acp.open { agentId, workspace }` | Starts the agent and streams its output: an `open` event with a `channel` and the agent's working directory (`cwd`), a `message` event per line the agent prints, and an `exit` event when it stops. |
| `acp.send { channel, message }` | Writes one JSON object to the agent's stdin, in the order received. |
| `acp.close { channel }` | Kills the agent and everything it started. |

- The bridge only runs commands from `acp.json`, never one named in a message, and never through a shell.
- `workspace` is required alongside `agentId`: a non-empty string of at most 2048 bytes, normally the site's origin (e.g. `https://example.com`). The bridge never uses it as a path - only its lowercase hex SHA-256 - so `../`, slashes, a NUL byte, etc. in it can't escape the directory it names. Each agent gets `<harbor data dir>/acp/workspaces/<hash of workspace>` as its working directory (`current_dir`), created (mode `0700` on unix) the first time that site opens an agent and reused - not wiped - on every open after that. The canonical path is returned as `cwd` on the `open` event.
- Each agent runs in its own process group, so closing it also stops anything it started (for example `npx` and the `node` process under it).
- When the extension disconnects, the bridge stops every agent it started and exits.
- Limits: 8 agents at once; 4 MiB per `acp.send`; 64 queued messages or 16 MiB per agent, after which `acp.send` is rejected rather than waiting; output lines over 900 KiB are dropped with an error event. Output lines that aren't valid JSON or UTF-8 are dropped and logged. Hitting the 8-agent cap is a fatal `acp.open` error carrying `"code": "agent_cap"` alongside the usual human-readable `message`, so the extension maps it without matching on wording (it maps this to its own per-site-cap error, `ERR_AGENT_BUSY`; see [the ACP backend design](../docs/ACP_BACKEND_DESIGN.md)). No other fatal `acp.open` error carries a `code` today.
- `acp.save_agents` validation, each rule a `-32602` error naming the field: `id` matches `^[a-z0-9][a-z0-9-]{0,31}$` and is unique; `name` is a non-empty string of at most 64 characters; `command` is a non-empty string of at most 1024 bytes; `args` has at most 64 entries, each at most 4096 bytes; `env` has at most 64 key/value pairs, keys matching `^[A-Za-z_][A-Za-z0-9_]*$`, values at most 4096 bytes; at most 32 agents in all. `name`, `command`, each `args` entry and each `env` value are additionally rejected if they contain a NUL byte (env keys can't, since their character class already excludes it).
- `acp.resolve_command` never runs a shell on the name itself: it runs `$SHELL -l -c 'command -v -- "$1"' _ <name>` with the name passed as an argument, never interpolated into the script string. `$SHELL` is the bridge's own environment variable if it's an existing absolute executable, falling back to `/bin/zsh` then `/bin/sh` if it isn't. The shell runs in its own process group, which is killed (not just the direct child) once an answer is read or the deadline passes - covering a background job a login shell's startup files left running. The child runs with a clean environment (just `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`), a 5 second timeout, and its stdout capped at 4096 bytes; the last non-empty output line is used, so a startup banner printed before the real answer doesn't break it. `name` must match `^[A-Za-z0-9._+-]{1,64}$` (no path separators); a name that fails that check, isn't found, or times out all resolve to `null`, never an error - this is a lookup, not something to reject.
- `acp.*` (including `acp.get_agents`, `acp.save_agents` and `acp.resolve_command`) isn't available in the HTTP server mode that Safari uses.

---

## See Also

- [Main Quickstart](../QUICKSTART.md) — Full setup guide
- [Firefox Setup](../docs/QUICKSTART_FIREFOX.md) — Firefox-specific instructions
- [Chrome Setup](../docs/QUICKSTART_CHROME.md) — Chrome-specific loading and native messaging
- [Architecture](../ARCHITECTURE.md) — System design overview
