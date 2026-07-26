# Chrome Setup Guide

**Get Harbor running in Chrome, Edge, Brave, Arc, or Vivaldi.**

> **Note:** Firefox is the primary supported browser with a simpler setup experience. Consider [Firefox Setup](QUICKSTART_FIREFOX.md) if you're flexible on browser choice.

Chrome requires an extra configuration step: you must add your extension ID to the native messaging manifest.

---

## Prerequisites

| Tool | Install |
|------|---------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **Rust** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Chrome 120+** | Already have it (or Edge, Brave, Arc, Vivaldi) |
| **Ollama** | [ollama.com](https://ollama.com) or `brew install ollama` |

---

## Step 1: Clone the Repository

```bash
git clone --recurse-submodules https://github.com/r/harbor.git
cd harbor
```

> **Already cloned without `--recurse-submodules`?** Run:
> ```bash
> git submodule update --init --recursive
> ```

---

## Step 2: Start Ollama

```bash
ollama serve &
ollama pull llama3.2
```

**Verify Ollama is running:**

```bash
curl http://localhost:11434/api/tags
```

---

## Step 3: Build Both Extensions for Chrome

Harbor consists of two extensions that work together:

| Extension | Purpose |
|-----------|---------|
| **Harbor** | Core platform — MCP servers, native bridge, chat panel |
| **Web Agents API** | Injects `window.ai` and `window.agent` into web pages |

### Build Harbor Extension

```bash
cd extension
npm install
npm run build:chrome
cd ..
```

This creates `extension/dist-chrome/`.

### Build Web Agents API Extension

```bash
cd web-agents-api
npm install
npm run build:chrome
cd ..
```

This creates `web-agents-api/dist-chrome/`.

---

## Step 4: Load Both Extensions in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **"Developer mode"** (toggle in the top right)

3. **Load Harbor:**
   - Click **"Load unpacked"**
   - Select the `extension/dist-chrome/` folder
   - **⚠️ Copy the extension ID** — you'll need it in Step 5

4. **Load Web Agents API:**
   - Click **"Load unpacked"** again
   - Select the `web-agents-api/dist-chrome/` folder

Both extensions should appear in your extensions list.

### Finding Your Extension ID

The extension ID is a 32-character string that looks like:
```
abcdefghijklmnopabcdefghijklmnop
```

You can find it:
- Displayed under the extension name in `chrome://extensions`
- In the URL when you click "Details" on the extension

**Write down the Harbor extension ID** — you need it for native messaging.

---

## Step 5: Configure Native Messaging

This is the critical step that differs from Firefox. Chrome's native messaging requires the exact extension ID.

### Build and Install the Bridge

```bash
cd bridge-rs
cargo build --release
./install.sh --chrome-extension-id YOUR_32_CHARACTER_EXTENSION_ID
cd ..
```

The installer validates the ID and refuses to create a Chrome manifest with a
wildcard origin.

### Verify the Native Messaging Manifest

- **macOS:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json`
- **Linux:** `~/.config/google-chrome/NativeMessagingHosts/harbor_bridge.json`
- **Windows:** Native installation is not provided by `install.sh`

The generated manifest must contain your exact Harbor extension ID:

```json
{
  "name": "harbor_bridge",
  "description": "Harbor Bridge - Local LLM and MCP server for Harbor extension",
  "path": "<path-to-harbor-bridge-native>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID_HERE/"]
}
```

### Restart Chrome

**Completely quit and restart Chrome** for the native messaging changes to take effect. Just closing tabs is not enough.

---

## Step 6: Verify the Installation

1. **Open the Harbor panel:**
   - Click the Harbor icon (⚓) in the Chrome toolbar
   - If you don't see it, click the puzzle piece → find Harbor → pin it

2. **Check the bridge connection:**
   - The panel should show **"Bridge: Connected"** (green indicator)
   - If it shows "Bridge: Disconnected", see [Troubleshooting](#troubleshooting)

3. **Check the LLM provider:**
   - The panel should show **"LLM: Ollama"**
   - If no LLM is found, make sure `ollama serve` is running

### Optional: Pair a local MCP client

Firefox remains the primary Agent Gateway target. After the Chrome bridge is
connected, the same read-only gateway can be used as the secondary browser
implementation.

1. Open **Agent Gateway** in Harbor.
2. Enable the gateway and choose **Pair client**.
3. Approve the read-only scopes and copy the client ID and one-time secret.
4. Approve a tab-bound session before the client calls a browser read tool.

Register the installed gateway with the client's normal MCP stdio
configuration. The outer format varies by client, but the registration is
equivalent to:

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

Keep the secret in a protected environment or secret store. Never pass it as a
command argument or write it to logs or committed configuration.

Harbor stores an RFC 9807 OPAQUE server setup and per-client OPAQUE registration
record, not the raw one-time credential. OPAQUE uses fresh client and server
protocol randomness for every login, and the client verifies a server
confirmation bound to its client ID and browser instance. The raw credential is
not sent over gateway IPC. The fixed gateway socket remains an untrusted
discovery point until authentication finishes.

The gateway exposes exactly `harbor.gateway.health`, `harbor.tabs.list`, and
`harbor.page.observe`. The two browser tools require the `sessionId` from an
active Harbor approval. Revoke the paired client in Harbor to end its sessions
and invalidate its credential. Disabling Agent Gateway ends all sessions and
returns it to its deny-all state.

---

## Step 7: Run the Demos

```bash
cd demo
npm install
npm start
```

Open http://localhost:8000 in Chrome.

### Try the Getting Started Demo

Navigate to http://localhost:8000/web-agents/getting-started/ and work through:

1. **Detect the API** — Confirms both extensions are loaded
2. **Request Permission** — Learn how permissions work
3. **Check Tools** — See what MCP tools are available
4. **Run an Agent** — Ask "What time is it?" and watch the AI use tools

---

## Troubleshooting

### "Bridge Disconnected" — Most Common Issue

This is almost always an extension ID mismatch. Verify:

1. **Get your current extension ID** from `chrome://extensions`
2. **Check the manifest** matches exactly:
   ```bash
   # macOS
   cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json
   ```
3. **Ensure the ID in `allowed_origins` matches** your extension ID
4. **Restart Chrome completely** (Quit → Reopen, not just close tabs)

**Check Chrome's native messaging logs:**
```bash
# macOS
cat ~/Library/Caches/harbor-bridge.log

# Linux  
cat ~/.cache/harbor-bridge.log
```

### "Web Agent API not detected"

- Are **both** extensions loaded? Check `chrome://extensions`
  - You need both Harbor AND Web Agents API
- Refresh the page after loading the extensions
- Make sure you loaded from `dist-chrome/`, not `dist-firefox/` or the source folder

### Agent Gateway reports `BROWSER_DISCONNECTED`

Keep Chrome open with Harbor loaded and confirm that the panel reports the
native bridge as connected. The MCP process cannot create the browser
connection. After a Chrome or extension restart, reconnect Harbor and approve a
new session.

### Agent Gateway reports `GATEWAY_SOCKET_OCCUPIED`

The fixed socket path has a reachable but unverified listener. Close the expected
Harbor browser instance or profile cleanly before opening the profile you want
to use. If the error remains, inspect the listening process. Do not trust it as
Harbor or delete the socket while it is active.

### Agent Gateway reports `GATEWAY_CONFIGURATION_MIGRATION_REQUIRED`

Close every Harbor browser instance and gateway MCP client. In the OS user-local
configuration directory, move `harbor/agent_gateway.json` to
`harbor/agent_gateway.v1.backup.json`, then restart Harbor. The replacement
version 2 configuration starts disabled. Enable Agent Gateway, pair every client
again, and replace its environment values. Keep the backup until the new pairing
works. Legacy version 1 hashes cannot be converted into OPAQUE registration
records.

### Extension ID Changed

The extension ID can change if you:
- Remove and re-add the extension
- Load from a different directory
- Clear Chrome's extension data

If this happens, update the native messaging manifest with the new ID and restart Chrome.

### "No LLM Provider Found"

```bash
ollama serve
curl http://localhost:11434/api/tags  # Should return models
```

### "No tools available"

1. Open the Harbor panel
2. Go to "MCP Servers"
3. Check if `time-wasm` is listed
4. Try reloading both extensions from `chrome://extensions`

---

## Other Chromium Browsers

The same setup works for:
- **Microsoft Edge** — Use `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` on macOS
- **Brave** — Use `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` on macOS
- **Arc** — Uses Chrome's native messaging location
- **Vivaldi** — Use `~/Library/Application Support/Vivaldi/NativeMessagingHosts/` on macOS

`install.sh` writes only the Google Chrome manifest. For another Chromium
browser, install the same exact-origin manifest in that browser's native
messaging directory.

---

## Development Workflow

For active development, use watch mode:

```bash
# Terminal 1: Harbor extension
cd extension
npm run dev:chrome

# Terminal 2: Web Agents API extension
cd web-agents-api
npm run dev:chrome

# Terminal 3: Demo server
cd demo
npm start
```

After each rebuild, reload the extensions in `chrome://extensions` by clicking the reload icon (circular arrow) on each extension card.

---

## Chrome vs Firefox Differences

| Feature | Chrome | Firefox |
|---------|--------|---------|
| **UI location** | Toolbar popup | Sidebar panel |
| **Native messaging** | ⚠️ Requires extension ID | ✅ Works automatically |
| **Background** | Service worker | Background script |
| **Build command** | `npm run build:chrome` | `npm run build` |
| **Output folder** | `dist-chrome/` | `dist-firefox/` |

---

## Next Steps

| What You Want | Where to Go |
|---------------|-------------|
| Build your own AI app | [QUICKSTART.md](../QUICKSTART.md#build-your-first-app) |
| Create custom MCP tools | [QUICKSTART.md](../QUICKSTART.md#create-your-own-tools) |
| Full API reference | [WEB_AGENTS_API.md](WEB_AGENTS_API.md) |
| Understand the architecture | [ARCHITECTURE.md](../ARCHITECTURE.md) |
