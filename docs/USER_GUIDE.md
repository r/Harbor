# Harbor User Guide

Welcome to Harbor! This guide will help you install, configure, and start using Harbor to bring AI capabilities to your browser.

## What is Harbor?

Harbor is a browser extension that implements the **Web Agent API** — a proposed standard for bringing AI agent capabilities to web applications.

**The Web Agent API** lets websites use AI models and tools (with your permission).

**Browser Support:**
| Browser | Status |
|---------|--------|
| **Firefox** | ✅ Primary — recommended for development |
| **Chrome** | ✅ Supported — also works with Edge, Brave, Arc |
| **Safari** | ⚠️ Experimental — macOS only |

**With Harbor, you can:**
- Use AI-powered features on websites that support the Web Agent API
- Run local AI models (like Ollama) without sending data to the cloud
- Connect MCP servers to extend AI capabilities with tools (file access, GitHub, databases, etc.)
- Control exactly which sites can access which capabilities

---

## Requirements

| Requirement | Details |
|-------------|---------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) — for building extensions |
| **Rust** | [rustup.rs](https://rustup.rs) — for building the native bridge |
| **Browser** | Firefox 109+ (recommended), Chrome 120+, or Safari 16+ (macOS) |
| **Ollama** | [ollama.com](https://ollama.com) — local LLM provider |
| **Xcode** | Required for Safari only (macOS) |

### Setting up Ollama

Harbor uses Ollama to run local AI models:

```bash
# Install Ollama (macOS)
brew install ollama

# Start Ollama
ollama serve

# Pull a model
ollama pull llama3.2
```

---

## Installation

Harbor consists of **two browser extensions** that work together:
- **Harbor** — Core platform (MCP servers, native bridge, chat sidebar)
- **Web Agents API** — Injects `window.ai` and `window.agent` into web pages

### Build from Source

```bash
# 1. Clone the repository
git clone --recurse-submodules https://github.com/r/harbor.git
cd harbor

# 2. Build Harbor extension
cd extension
npm install
npm run build          # Firefox
npm run build:chrome   # Chrome
cd ..

# 3. Build Web Agents API extension
cd web-agents-api
npm install
npm run build          # Firefox
npm run build:chrome   # Chrome
cd ..

# 4. Build the native bridge
cd bridge-rs
cargo build --release
./install.sh
cd ..
```

### Load Extensions in Your Browser

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select `extension/dist-firefox/manifest.json`
4. Repeat for `web-agents-api/dist-firefox/manifest.json`

**Chrome:**
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/dist-chrome/`
4. Repeat for `web-agents-api/dist-chrome/`
5. **Important:** Update native messaging manifest with your extension ID — see [Chrome Setup](QUICKSTART_CHROME.md#step-5-configure-native-messaging)

**Safari (Experimental):**
See [Safari Setup](QUICKSTART_SAFARI.md) — requires Xcode and building a macOS app.

### Detailed Setup Guides

→ **[Firefox Setup](QUICKSTART_FIREFOX.md)** — Primary browser, recommended  
→ **[Chrome Setup](QUICKSTART_CHROME.md)** — Requires extension ID configuration  
→ **[Safari Setup](QUICKSTART_SAFARI.md)** — Experimental, macOS only

---

## First-Time Setup

After installation, let's make sure everything is working:

### 1. Open the Harbor Sidebar

Click the **Harbor icon** in your Firefox sidebar (or press the sidebar shortcut).

You should see:
- Connection status indicator
- "Curated Servers" section with recommended MCP servers
- "My Servers" section (empty at first)

### 2. Verify Bridge Connection

The sidebar should show **"Connected"** in green. If you see "Disconnected":
- Make sure the bridge is installed correctly
- Check the Firefox Browser Console (`Cmd+Shift+J` on Mac) for errors
- Try rebuilding the bridge if you installed manually

### 3. Set Up Your LLM

1. Click the **Settings** (gear icon) in the sidebar
2. Under "LLM Provider", click **"Detect"**
3. Harbor will find available LLM providers:
   - **Ollama** at `localhost:11434`
   - **llamafile** at `localhost:8080`
4. Select your preferred provider

### 4. Install Your First MCP Server

MCP servers give the AI tools like file access, memory, or web search.

1. In "Curated Servers", find **"Memory"** (a good starter)
2. Click **"Install"**
3. Wait for installation to complete
4. Click **"Start"** to run the server
5. The server should show a green "Running" status

---

## Using Harbor

### On Websites

When you visit a website that uses the Web Agent API, it may request permissions:

1. **Permission Prompt**: A Harbor popup appears asking for access
2. **Review Scopes**: See what capabilities the site is requesting:
   - `model:prompt` — Generate text with AI
   - `model:tools` — Use AI with tool calling
   - `mcp:tools.list` — List available tools
   - `mcp:tools.call` — Execute tools
   - `browser:activeTab.read` — Read the current page
3. **Grant or Deny**:
   - **Allow Once** — Temporary permission (expires when you close the tab)
   - **Always Allow** — Persistent permission for this site
   - **Deny** — Block the request

### In the Sidebar

The Harbor sidebar lets you:

- **Chat** — Send messages to the AI directly
- **Manage Servers** — Install, start, stop MCP servers
- **View Tools** — See all available tools from connected servers
- **Configure Settings** — LLM provider, debug options

### Demo

Try the included demos to see Harbor in action:

1. Make sure you have MCP servers running
2. Open a new tab and go to: `http://localhost:8000` (if demo server is running)
3. Or open the demo from the sidebar by clicking **"API Demo"**

---

## Managing MCP Servers

### Installing Servers

**From Curated List:**
1. Find a server in "Curated Servers"
2. Click "Install"
3. Wait for download/installation

**From GitHub URL:**
1. Click "Install from URL"
2. Paste the GitHub repository URL
3. Harbor detects the package type and installs

**Import from Claude/Cursor:**
1. Click "Import JSON"
2. Paste your Claude Desktop or Cursor MCP configuration
3. Servers are added to "My Servers"

### Server Status

| Status | Meaning |
|--------|---------|
| 🟢 Running | Server is connected and operational |
| ⚪ Stopped | Installed but not running |
| 🟡 Starting | Server is starting up |
| 🔴 Crashed | Server exited unexpectedly |

### API Keys

Some MCP servers require API keys (e.g., GitHub, Brave Search):

1. Click the **key icon** next to the server
2. Enter the required credentials
3. Click "Save"
4. Restart the server

---

## Troubleshooting

### "Bridge Disconnected"

**Firefox:**

1. **Check the native messaging manifest exists**:
   ```bash
   cat ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge.json
   ```

2. **Reinstall the bridge**:
   ```bash
   cd bridge-rs
   ./install.sh
   ```

3. **Restart Firefox completely** (quit and reopen)

4. **Check Browser Console** (`Cmd+Shift+J`) for errors

**Chrome:**

1. **Check the native messaging manifest**:
   ```bash
   cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json
   ```

2. **Verify the extension ID** in `allowed_origins` matches your Harbor extension ID from `chrome://extensions`

3. **Reinstall the bridge** and update the manifest:
   ```bash
   cd bridge-rs
   ./install.sh
   # Then edit the manifest to add your extension ID
   ```

4. **Restart Chrome completely**

→ See [Chrome Setup](QUICKSTART_CHROME.md#step-5-configure-native-messaging) for detailed extension ID instructions.

**Safari:**

1. **Make sure Harbor.app is running** (check the Dock)

2. **Rebuild the app in Xcode** — the bridge is bundled inside

→ See [Safari Setup](QUICKSTART_SAFARI.md) for details.

### Safari: "Extension not enabled"

1. Open **Safari → Settings → Extensions**
2. Make sure both are checked:
   - ☑️ Harbor
   - ☑️ Web Agents API
3. For unsigned extensions, first enable: **Safari → Develop → Allow Unsigned Extensions**
   - If Develop menu is missing: **Safari → Settings → Advanced → Show Develop menu**

### "No LLM Provider Found"

1. Make sure Ollama or llamafile is running:
   ```bash
   # Check Ollama
   curl http://localhost:11434/api/tags
   
   # Check llamafile
   curl http://localhost:8080/v1/models
   ```

2. Click **"Detect"** again in Harbor settings

### "Server Won't Start"

1. **Check for missing dependencies**:
   - Some servers need API keys configured first
   - Click the key icon to see required credentials

2. **Check runtime availability**:
   - npm servers need Node.js
   - Python servers need Python + uvx
   - Check sidebar "Runtimes" section

3. **View server logs**:
   - Click the server name → "Logs"
   - Look for error messages

### "Permission Denied" on Websites

1. You may have previously denied permission
2. Go to Harbor sidebar → Settings → Permissions
3. Find the site and remove the denial
4. Refresh the page and try again

---

## Data Storage

Harbor stores data in `~/.harbor/`:

| File | Contents |
|------|----------|
| `harbor.db` | Server configurations |
| `catalog.db` | Cached server catalog |
| `installed_servers.json` | Installed server metadata |
| `secrets/credentials.json` | API keys (encrypted) |
| `sessions/*.json` | Chat history |

To completely reset Harbor:
```bash
rm -rf ~/.harbor
```

---

## Uninstalling

### Firefox/Chrome

1. **Remove extensions:**
   - Firefox: Go to `about:debugging#/runtime/this-firefox` → click "Remove" on each extension
   - Chrome: Go to `chrome://extensions` → click "Remove" on each extension

2. **Remove native messaging:**
   ```bash
   # Firefox
   rm ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge.json
   
   # Chrome
   rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json
   ```

3. **Remove user data:**
   ```bash
   rm -rf ~/.harbor
   ```

### Safari

1. Delete the `installer/safari/build/` directory
2. The extensions are automatically unregistered when the app is deleted
3. Remove user data:
   ```bash
   rm -rf ~/.harbor
   ```

---

## Getting Help

- **GitHub Issues**: Report bugs or request features
- **Developer Guide**: [docs/DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for technical details
- **Browser Console**: `Cmd+Shift+J` for debugging

---

## Next Steps

- Try the [Chat POC Demo](../demo/web-agents/chat-poc/) to see the full API in action
- Read the [Developer Guide](DEVELOPER_GUIDE.md) to build apps with Harbor
- Explore the [MCP Servers](../mcp-servers/) for examples and templates


