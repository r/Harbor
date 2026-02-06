# Quickstart

**Get Harbor running and build your first AI-powered web app.**

This guide covers:
1. [Prerequisites](#prerequisites)
2. [Build Everything](#build-everything)
3. [Set Up Firefox](#set-up-firefox-recommended) (recommended)
4. [Set Up Chrome](#set-up-chrome)
5. [Set Up Safari](#set-up-safari-experimental) (experimental)
6. [Verify Your Setup](#verify-your-setup)
7. [Run the Demos](#run-the-demos)
8. [Build Your First App](#build-your-first-app)
9. [Create Your Own Tools](#create-your-own-tools)

> **Using an AI coding assistant?** Point it to **[docs/LLMS.txt](docs/LLMS.txt)** — a compact reference designed for Claude, Cursor, Copilot, and other AI tools to quickly understand and build with the API.

---

## Prerequisites

| Tool | Install | Why |
|------|---------|-----|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) | Build the extensions |
| **Rust** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | Build the native bridge |
| **Ollama** | [ollama.com](https://ollama.com) or `brew install ollama` | Local LLM provider |
| **Browser** | Firefox 109+ (recommended) or Chrome 120+ | Run the extensions |

---

## Build Everything

### 1. Clone the Repository

```bash
git clone --recurse-submodules https://github.com/r/harbor.git
cd harbor
```

> **Already cloned without `--recurse-submodules`?** Run this to fetch the submodules:
> ```bash
> git submodule update --init --recursive
> ```

Harbor uses git submodules for shared libraries (like `bridge-rs/any-llm-rust`). The build will fail if submodules are missing.

### 2. Build the Harbor Extension

This is the core extension that provides the chat sidebar, MCP server management, and native bridge connection.

```bash
cd extension
npm install
npm run build          # Firefox (default)
npm run build:chrome   # Chrome/Edge/Brave/Arc
cd ..
```

**Output:**
- Firefox: `extension/dist-firefox/`
- Chrome: `extension/dist-chrome/`

### 3. Build the Web Agents API Extension

This extension injects `window.ai` and `window.agent` into web pages. It communicates with the Harbor extension to provide AI capabilities to websites.

```bash
cd web-agents-api
npm install
npm run build          # Firefox (default)
npm run build:chrome   # Chrome
cd ..
```

**Output:**
- Firefox: `web-agents-api/dist-firefox/`
- Chrome: `web-agents-api/dist-chrome/`

### 4. Build the Native Bridge

The bridge connects the browser extension to local resources (Ollama, MCP servers, filesystem).

```bash
cd bridge-rs
cargo build --release
cd ..
```

### 5. Start Ollama

```bash
ollama serve &
ollama pull llama3.2    # or: mistral, codellama, phi3
```

Verify it's running:

```bash
curl http://localhost:11434/api/tags
```

---

## Set Up Firefox (Recommended)

Firefox is the primary supported browser with the best developer experience.

### Install the Native Bridge

```bash
cd bridge-rs
./install.sh
cd ..
```

This installs the native messaging manifest to:
- **macOS:** `~/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json`
- **Linux:** `~/.mozilla/native-messaging-hosts/harbor_bridge.json`

### Load Both Extensions

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`

2. **Load Harbor:**
   - Click "Load Temporary Add-on..."
   - Navigate to `extension/dist-firefox/`
   - Select `manifest.json`

3. **Load Web Agents API:**
   - Click "Load Temporary Add-on..." again
   - Navigate to `web-agents-api/dist-firefox/`
   - Select `manifest.json`

Both extensions should now appear in the list.

> **Note:** Temporary add-ons don't persist across Firefox restarts. You'll need to reload them each time. For development, use `npm run dev` in watch mode.

→ **[Detailed Firefox guide with troubleshooting](docs/QUICKSTART_FIREFOX.md)**

---

## Set Up Chrome

Chrome requires an extra step to configure native messaging with your extension ID.

### Load Both Extensions

1. Open Chrome and go to `chrome://extensions`
2. Enable **"Developer mode"** (toggle in top right)

3. **Load Harbor:**
   - Click "Load unpacked"
   - Select `extension/dist-chrome/`
   - **Copy the extension ID** (32-character string like `abcdefgh...`)

4. **Load Web Agents API:**
   - Click "Load unpacked"
   - Select `web-agents-api/dist-chrome/`

### Install and Configure the Native Bridge

```bash
cd bridge-rs
./install.sh
cd ..
```

**Important:** Chrome's native messaging requires your specific extension ID. Edit the manifest:

**macOS:**
```bash
nano ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json
```

**Linux:**
```bash
nano ~/.config/google-chrome/NativeMessagingHosts/harbor_bridge_host.json
```

Update the `allowed_origins` with your Harbor extension ID:

```json
{
  "name": "harbor_bridge_host",
  "description": "Harbor Bridge",
  "path": "/path/to/harbor-bridge",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID_HERE/"]
}
```

**Restart Chrome** for changes to take effect.

→ **[Detailed Chrome guide with troubleshooting](docs/QUICKSTART_CHROME.md)**

---

## Set Up Safari (Experimental)

> ⚠️ **Safari support is experimental.** The code is checked into the repository but is not fully supported.

Safari requires building a native macOS app that contains the extensions.

### Build the Safari App

The Safari project is an Xcode project located at `installer/safari/Harbor/`.

```bash
cd installer/safari/Harbor
open Harbor.xcodeproj
```

In Xcode:
1. Select the "Harbor" scheme
2. Build and run (⌘R)

### Enable the Extensions

1. Open Safari
2. Go to **Safari → Settings → Extensions**
3. Enable both **Harbor** and **Web Agents API**
4. For unsigned builds: **Safari → Develop → Allow Unsigned Extensions**

> **Note:** The Safari app bundles the native bridge inside the app itself, so you don't need to run `install.sh` separately.

---

## Verify Your Setup

After loading both extensions:

1. **Open the Harbor sidebar:**
   - Firefox: Press `Cmd+B` (macOS) or `Ctrl+B` (Linux/Windows), then click the Harbor icon
   - Chrome: Click the Harbor icon in the toolbar (or puzzle piece menu → Harbor)

2. **Check the status indicators:**
   - **Bridge: Connected** (green) — Native bridge is working
   - **LLM: Ollama** — AI provider is detected

3. **If "Bridge: Disconnected":**
   - Re-run `./install.sh` in `bridge-rs/`
   - Restart your browser
   - For Chrome: verify the extension ID in the native messaging manifest

4. **If "No LLM Provider":**
   - Make sure Ollama is running: `ollama serve`
   - Verify with: `curl http://localhost:11434/api/tags`

---

## Run the Demos

Start the demo server:

```bash
cd demo
npm install
npm start
```

Open http://localhost:8000 in your browser.

### Recommended Demo Path

| Demo | URL | What It Shows |
|------|-----|---------------|
| **Getting Started** | http://localhost:8000/web-agents/getting-started/ | Step-by-step API tutorial |
| **Chat Demo** | http://localhost:8000/web-agents/chat-poc/ | Full chat with tool calling |
| **Page Summarizer** | http://localhost:8000/web-agents/summarizer/ | AI-powered page summaries |

---

## Build Your First App

Harbor exposes two JavaScript APIs to web pages:

```javascript
window.ai      // Text generation (Chrome Prompt API compatible)
window.agent   // Tools, permissions, browser access, sessions
```

### Minimal Example

Create an HTML file and open it in your browser:

```html
<!DOCTYPE html>
<html>
<head>
  <title>My AI App</title>
</head>
<body>
  <h1>AI Chat</h1>
  <input id="input" placeholder="Ask something..." style="width: 300px">
  <button id="ask">Ask</button>
  <pre id="output">Waiting...</pre>

  <script>
    document.getElementById('ask').onclick = async () => {
      const input = document.getElementById('input').value;
      const output = document.getElementById('output');
      
      // Check if Harbor is installed
      if (!window.agent) {
        output.textContent = 'Harbor not installed!';
        return;
      }
      
      // Request permission
      const { granted } = await window.agent.requestPermissions({
        scopes: ['model:prompt'],
        reason: 'To answer your question'
      });
      
      if (!granted) {
        output.textContent = 'Permission denied';
        return;
      }
      
      // Create session and prompt
      output.textContent = 'Thinking...';
      const session = await window.ai.createTextSession();
      const response = await session.prompt(input);
      output.textContent = response;
      
      session.destroy();
    };
  </script>
</body>
</html>
```

### Core API Patterns

**Simple Chat:**
```javascript
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7
});
const response = await session.prompt('What is JavaScript?');
session.destroy();
```

**List and Call Tools:**
```javascript
await window.agent.requestPermissions({
  scopes: ['mcp:tools.list', 'mcp:tools.call']
});

const tools = await window.agent.tools.list();
const result = await window.agent.tools.call({
  tool: 'time-wasm/time.now',
  args: { timezone: 'America/New_York' }
});
```

**Autonomous Agent:**
```javascript
for await (const event of window.agent.run({
  task: 'What is the current time in Tokyo?',
  maxToolCalls: 5
})) {
  if (event.type === 'final') {
    console.log(event.output);
  }
}
```

→ **[Full API Reference](docs/WEB_AGENTS_API.md)**

**Testing your app?** Generate a test harness (unit tests with a mock, E2E with Playwright) from the Harbor repo: `node scripts/generate-test-harness.mjs /path/to/your/project`. See [Testing your app](docs/TESTING_YOUR_APP.md).

---

## Create Your Own Tools

MCP servers give your AI new capabilities. Create one in 5 minutes:

### 1. Copy the Template

```bash
cp -r mcp-servers/templates/javascript my-tool
cd my-tool
```

### 2. Edit `server.js`

```javascript
const TOOLS = [{
  name: 'my_tool',
  description: 'Does something useful',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input to process' }
    },
    required: ['input']
  }
}];

async function handleToolCall(toolName, args) {
  if (toolName === 'my_tool') {
    return `Processed: ${args.input}`;
  }
  throw new Error(`Unknown tool: ${toolName}`);
}
```

### 3. Load in Harbor

1. Open Harbor sidebar → "MCP Servers"
2. Click "Add Server"
3. Select your `manifest.json` file

### 4. Use Your Tool

```javascript
const result = await window.agent.tools.call({
  tool: 'my-tool/my_tool',
  args: { input: 'hello world' }
});
```

→ **[MCP Authoring Guide](mcp-servers/AUTHORING_GUIDE.md)**

---

## Troubleshooting

### "Web Agent API not detected"

- Are both extensions loaded? Check `about:debugging` (Firefox) or `chrome://extensions` (Chrome)
- Refresh the page after loading extensions
- Make sure you loaded from `dist-firefox/` or `dist-chrome/`, not the source folder

### "Bridge Disconnected"

```bash
cd bridge-rs && ./install.sh
```
Then restart your browser.

For Chrome: verify the extension ID in the native messaging manifest matches your actual extension ID.

### "No LLM Provider Found"

```bash
ollama serve
curl http://localhost:11434/api/tags  # Should return models
```

### "No tools available"

The built-in `time-wasm` server should be available by default. Check the MCP Servers section in the Harbor sidebar.

---

## Next Steps

| What You Want | Where to Go |
|---------------|-------------|
| Full API reference | [docs/WEB_AGENTS_API.md](docs/WEB_AGENTS_API.md) |
| More examples | [spec/examples/](spec/examples/) |
| Understand the architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Create MCP servers | [mcp-servers/AUTHORING_GUIDE.md](mcp-servers/AUTHORING_GUIDE.md) |
| Contribute to Harbor | [CONTRIBUTING.md](CONTRIBUTING.md) |

---

## Development Workflow

For active development, use watch mode:

```bash
# Terminal 1: Harbor extension
cd extension && npm run dev

# Terminal 2: Web Agents API extension  
cd web-agents-api && npm run dev

# Terminal 3: Demo server
cd demo && npm start
```

After changes, reload the extensions:
- Firefox: Click "Reload" in `about:debugging`
- Chrome: Click the reload icon in `chrome://extensions`
