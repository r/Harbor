# Harbor User Guide

Welcome to Harbor! This guide will help you install, configure, and start using Harbor to bring AI capabilities to your browser.

## What is Harbor?

Harbor is a Firefox browser extension that implements the **Web Agent API** — a proposed standard for bringing AI agent capabilities to web applications.

**The Web Agent API** lets websites use AI models and tools (with your permission). Harbor is an implementation that makes it work in Firefox.

**With Harbor, you can:**
- Use AI-powered features on websites that support the Web Agent API
- Run local AI models (like Ollama or llamafile) without sending data to the cloud
- Connect MCP servers to extend AI capabilities with tools (file access, GitHub, databases, etc.)
- Control exactly which sites can access which capabilities

---

## Requirements

Before installing Harbor, make sure you have:

| Requirement | Details |
|-------------|---------|
| **Firefox or Chrome** | Firefox 109+ or Chrome 120+ |
| **LLM Provider** | Ollama or llamafile (optional, for AI features) |
| **Rust** | For building from source (not needed for pkg install) |
| **Node.js** | Version 18+ (for development/manual install only) |

### Setting up an LLM Provider

Harbor needs a local LLM to generate AI responses. Choose one:

**Option A: Ollama (Recommended)**
```bash
# Install Ollama (macOS)
brew install ollama

# Start Ollama
ollama serve

# Pull a model (e.g., llama2, mistral, or any model you prefer)
ollama pull llama2
```

**Option B: llamafile**
```bash
# Download a llamafile from https://github.com/Mozilla-Ocho/llamafile
# Make it executable and run:
chmod +x ./your-model.llamafile
./your-model.llamafile --server
```

---

## Installation

### Option 1: macOS Installer (Recommended)

1. **Download** the Harbor installer package (`Harbor-x.x.x.pkg`)
2. **Double-click** the package to run the installer
3. **Follow the prompts** — the installer will:
   - Check that Firefox is installed
   - Install the Harbor bridge to `/Library/Application Support/Harbor/`
   - Configure Firefox to load the extension
4. **Restart Firefox** after installation completes
5. **Look for the Harbor icon** in the Firefox sidebar

### Option 2: Manual Installation (Developers)

If you're building from source:

```bash
# 1. Clone the repository with submodules
git clone --recurse-submodules https://github.com/anthropics/harbor.git
cd harbor

# 2. Build the extension
cd extension
npm install
npm run build
cd ..

# 3. Build the Rust bridge
cd bridge-rs
cargo build --release
cd ..

# 4. Install the native messaging manifest
cd bridge-rs
./install.sh
cd ..

# 5. Load the extension in your browser
# Firefox: about:debugging#/runtime/this-firefox → Load Temporary Add-on → extension/dist/manifest.json
# Chrome: chrome://extensions → Developer mode → Load unpacked → extension/dist/
```

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

1. **Check the bridge is installed**:
   ```bash
   ls -la "/Library/Application Support/Harbor/"
   # Should show harbor-bridge binary
   ```

2. **Check the native messaging manifest**:
   ```bash
   # Firefox
   cat "/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json"
   # Chrome
   cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json
   ```

3. **Rebuild the bridge** (if manual install):
   ```bash
   cd bridge-rs
   cargo build --release
   ./install.sh
   ```

4. **Check Browser Console** (`Cmd+Shift+J` in Firefox, `Cmd+Option+J` in Chrome) for errors

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

### macOS (Installer)

```bash
# Remove Harbor files
sudo rm -rf "/Library/Application Support/Harbor"
sudo rm "/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json"
sudo rm "/Library/Application Support/Mozilla/policies/policies.json"

# Remove user data
rm -rf ~/.harbor
```

### Manual Installation

1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Remove" next to the Harbor extension
3. Delete the harbor directory

---

## Getting Help

- **GitHub Issues**: Report bugs or request features
- **Developer Guide**: [docs/DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for technical details
- **Browser Console**: `Cmd+Shift+J` for debugging

---

## Next Steps

- Try the [Chat POC Demo](../demo/chat-poc/) to see the full API in action
- Read the [Developer Guide](DEVELOPER_GUIDE.md) to build apps with Harbor
- Explore more MCP servers in the [Curated Directory](../bridge-ts/src/directory/curated-servers.ts)


