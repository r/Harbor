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
git clone --recurse-submodules https://github.com/anthropics/harbor.git
cd harbor
```

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
./install.sh
cd ..
```

### Update the Native Messaging Manifest

**macOS:**
```bash
nano ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json
```

**Linux:**
```bash
nano ~/.config/google-chrome/NativeMessagingHosts/harbor_bridge_host.json
```

**Windows:**
The manifest is at `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\harbor_bridge_host.json`

### Edit the Manifest

Find the `allowed_origins` line and replace `YOUR_EXTENSION_ID_HERE` with your actual Harbor extension ID:

```json
{
  "name": "harbor_bridge_host",
  "description": "Harbor Bridge - Local LLM and MCP server for Harbor extension",
  "path": "/Users/you/.harbor/bin/harbor-bridge",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID_HERE/"]
}
```

**Example:** If your extension ID is `abcdefghijklmnopabcdefghijklmnop`:

```json
"allowed_origins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
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
   cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json
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

The `install.sh` script may create manifests for multiple browsers. Check which one matches your browser.

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
