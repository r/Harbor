# Firefox Setup Guide

**Get Harbor running in Firefox — the primary supported browser.**

Firefox offers the best developer experience for Harbor with sidebar support and straightforward native messaging setup.

---

## Prerequisites

| Tool | Install |
|------|---------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **Rust** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Firefox 109+** | Already have it |
| **Ollama** | [ollama.com](https://ollama.com) or `brew install ollama` |

---

## Step 1: Clone the Repository

```bash
git clone --recurse-submodules https://github.com/r/Harbor.git
cd harbor
```

> **Already cloned without `--recurse-submodules`?** Run:
> ```bash
> git submodule update --init --recursive
> ```

---

## Step 2: Start Ollama

Ollama provides the local LLM backend. Start the server and pull a model:

```bash
ollama serve &
ollama pull llama3.2
```

You can use other models like `mistral`, `codellama`, or `phi3` if you prefer.

**Verify Ollama is running:**

```bash
curl http://localhost:11434/api/tags
```

You should see a JSON response listing your downloaded models.

---

## Step 3: Build Both Extensions

Harbor consists of two extensions that work together:

| Extension | Purpose |
|-----------|---------|
| **Harbor** | Core platform — MCP servers, native bridge, chat sidebar |
| **Web Agents API** | Injects `window.ai` and `window.agent` into web pages |

### Build Harbor Extension

```bash
cd extension
npm install
npm run build
cd ..
```

This creates `extension/dist-firefox/` containing the built extension.

### Build Web Agents API Extension

```bash
cd web-agents-api
npm install
npm run build
cd ..
```

This creates `web-agents-api/dist-firefox/` containing the built extension.

---

## Step 4: Build and Install the Native Bridge

The bridge connects the extensions to Ollama and local resources:

```bash
cd bridge-rs
cargo build --release
./install.sh
cd ..
```

The install script:
- Copies the `harbor-bridge` binary to a standard location
- Installs the native messaging manifest for Firefox at:
  - **macOS:** `~/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json`
  - **Linux:** `~/.mozilla/native-messaging-hosts/harbor_bridge.json`

---

## Step 5: Load Both Extensions in Firefox

1. Open Firefox
2. Navigate to `about:debugging#/runtime/this-firefox`

3. **Load Harbor:**
   - Click **"Load Temporary Add-on..."**
   - Navigate to `extension/dist-firefox/`
   - Select **`manifest.json`**

4. **Load Web Agents API:**
   - Click **"Load Temporary Add-on..."** again
   - Navigate to `web-agents-api/dist-firefox/`
   - Select **`manifest.json`**

Both extensions should appear in your extensions list.

---

## Step 6: Verify the Installation

1. **Open the Harbor sidebar:**
   - Press `Ctrl+B` (Windows/Linux) or `Cmd+B` (macOS) to open the sidebar
   - Click the Harbor icon to switch to the Harbor panel
   - Or click the Harbor icon in the toolbar

2. **Check the bridge connection:**
   - The sidebar should show **"Bridge: Connected"** (green indicator)
   - If it shows "Bridge: Disconnected", see [Troubleshooting](#troubleshooting)

3. **Check the LLM provider:**
   - The sidebar should show **"LLM: Ollama"** or similar
   - If no LLM is found, make sure `ollama serve` is running

---

## Step 7: Run the Demos

Start the demo server:

```bash
cd demo
npm install
npm start
```

Open http://localhost:8000 in Firefox.

---

## Step 8: Try Your First Demo

Navigate to **[Getting Started](http://localhost:8000/web-agents/getting-started/)** to walk through the basics:

1. **Detect the API** — Confirms both extensions are loaded
2. **Request Permission** — Learn how permissions work
3. **Check Tools** — See what MCP tools are available
4. **Run an Agent** — Ask "What time is it?" and watch the AI use tools
5. **See the Response** — View the final answer

The demo walks you through each step interactively.

---

## Other Demos to Try

| Demo | URL | What It Shows |
|------|-----|---------------|
| **Chat Demo** | http://localhost:8000/web-agents/chat-poc/ | Full chat interface with tool calling |
| **Page Summarizer** | http://localhost:8000/web-agents/summarizer/ | AI-powered page summaries |
| **Time Agent** | http://localhost:8000/web-agents/time-agent/ | Simple tool usage example |

---

## Troubleshooting

### "Web Agent API not detected"

- Are **both** extensions loaded? Check `about:debugging#/runtime/this-firefox`
  - You need both Harbor AND Web Agents API
- Refresh the page after loading the extensions
- Make sure you loaded from `dist-firefox/manifest.json`, not the source `manifest.json`

### "Bridge Disconnected" in sidebar

```bash
cd bridge-rs && ./install.sh
```

Then restart Firefox completely (not just the tab).

**Check the manifest exists:**
```bash
# macOS
cat ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge.json

# Linux
cat ~/.mozilla/native-messaging-hosts/harbor_bridge.json
```

### "No LLM Provider Found"

```bash
ollama serve
curl http://localhost:11434/api/tags  # Should return models
```

### "No tools available"

The built-in `time-wasm` server should be available by default. If not:

1. Open the Harbor sidebar
2. Go to "MCP Servers"
3. Check if any servers are listed
4. Try reloading both extensions

### Extensions disappear after restart

Temporary add-ons in Firefox don't persist across browser restarts. You'll need to reload the extensions each time via `about:debugging`.

For persistent installation during development, consider using [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/).

---

## Development Workflow

For active development, use watch mode in separate terminals:

```bash
# Terminal 1: Harbor extension
cd extension
npm run dev

# Terminal 2: Web Agents API extension
cd web-agents-api
npm run dev

# Terminal 3: Demo server
cd demo
npm start
```

After each rebuild, reload the extensions in `about:debugging` by clicking the **"Reload"** button.

---

## Next Steps

| What You Want | Where to Go |
|---------------|-------------|
| Build your own AI app | [QUICKSTART.md](../QUICKSTART.md#build-your-first-app) |
| Create custom MCP tools | [QUICKSTART.md](../QUICKSTART.md#create-your-own-tools) |
| Full API reference | [WEB_AGENTS_API.md](WEB_AGENTS_API.md) |
| Understand the architecture | [ARCHITECTURE.md](../ARCHITECTURE.md) |

---

## Why Firefox is Recommended

| Feature | Firefox | Chrome |
|---------|---------|--------|
| **Sidebar support** | ✅ Native sidebar panel | ❌ Popup only |
| **Native messaging** | ✅ Just works | ⚠️ Requires extension ID config |
| **Developer experience** | ✅ Simpler setup | ⚠️ Extra steps |
| **Extension persistence** | ❌ Temporary only | ❌ Temporary only |

Firefox's native sidebar makes Harbor feel like a built-in browser feature rather than a popup.
