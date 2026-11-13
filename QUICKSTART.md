# Quickstart

**The canonical guide to installing Harbor, configuring a model, and running your first demo.**

Start here for every browser. Firefox is the primary target; the Chrome and Safari guides cover only their browser-specific steps.

This guide covers:
1. [Prerequisites](#prerequisites)
2. [Build Everything](#build-everything)
3. [Set Up Firefox](#set-up-firefox-recommended) (recommended)
4. [Set Up Chrome](#set-up-chrome)
5. [Set Up Safari](#set-up-safari-experimental) (experimental)
6. [Verify Your Setup](#verify-your-setup)
7. [Configure a Model](#configure-a-model)
8. [Run the Demos](#run-the-demos)
9. [Build Your First App](#build-your-first-app)
10. [Create Your Own Tools](#create-your-own-tools)

> **Using an AI coding assistant?** Point it to **[docs/LLMS.txt](docs/LLMS.txt)** — a compact reference designed for Claude, Cursor, Copilot, and other AI tools to quickly understand and build with the API.

---

## Prerequisites

| Tool | Install | Why |
|------|---------|-----|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) | Build the extensions |
| **Rust** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | Build the native bridge |
| **Ollama** | [ollama.com](https://ollama.com) or `brew install ollama` | Optional local LLM provider |
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

### 2. Build Both Extensions

Harbor provides the models, tools and native bridge connection. Web Agents API exposes `window.ai` and `window.agent` to pages. You need both extensions.

```bash
npm install --prefix extension
npm install --prefix web-agents-api
npm run build
```

This produces `extension/dist-firefox/` and `web-agents-api/dist-firefox/`.
For Chrome, run `npm run build:chrome` instead; for Safari, `npm run build:safari`.
The outputs are the corresponding `dist-chrome/` or `dist-safari/` directories.

On macOS with Homebrew's libvips installed, sharp may try to build from source
and fail with `Please add node-addon-api to your dependencies`. Retry the
extension installs using sharp's prebuilt binaries:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --prefix extension
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --prefix web-agents-api
```

Run these from the repository root, then retry `npm run build`.
See [sharp's installation guide](https://sharp.pixelplumbing.com/install/#building-from-source).

### 3. Build the Native Bridge

```bash
cargo build --release --manifest-path bridge-rs/Cargo.toml
```

### 4. Choose a Local Model

On Apple silicon with macOS 26 or later, Harbor uses Apple Intelligence automatically when the system model is ready. Source builds need the macOS 26 SDK or later for this option. If you use Apple Intelligence, continue to browser setup.

#### Using Ollama

If Ollama is not already running, start it in a separate terminal:

```bash
ollama serve
```

In another terminal, download a model and verify that Ollama lists it:

```bash
ollama pull llama3.2
curl http://localhost:11434/api/tags
```

Downloading a model makes it available to Ollama. You must also [add it to Harbor's Configured Models](#configure-a-model) before running an agent.

---

## Set Up Firefox (Recommended)

Firefox is the primary supported browser with the best developer experience.

### Install the Native Bridge

```bash
cd bridge-rs
./install.sh --firefox-only --skip-build
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

After [building everything](#build-everything) with `npm run build:chrome`, follow the [Chrome-specific loading and native messaging steps](docs/QUICKSTART_CHROME.md). Then return to [Verify Your Setup](#verify-your-setup) below.

---

## Set Up Safari (Experimental)

After [building everything](#build-everything) with `npm run build:safari`, follow the [Safari app and extension steps](docs/QUICKSTART_SAFARI.md). Then return to [Verify Your Setup](#verify-your-setup) below. Safari support is experimental.

---

## Verify Your Setup

Open the **Harbor** sidebar using its toolbar icon or Firefox's sidebar selector. Confirm **Bridge: Connected**. If disconnected, see [Troubleshooting](#troubleshooting).

### Configure a Model

When Apple Intelligence is available, you can use it immediately. To use another model, configure it below. Harbor honors your saved default.

1. In the Harbor sidebar, expand **LLM Providers** and find **Configured Models**.
2. In **Select a model to add...**, select the Ollama model you downloaded (for example, `llama3.2`). If it is missing, click the refresh button next to **Add** and check that Ollama is running.
3. Click **Add**. Confirm the model now appears under **Configured Models**. The header should show a model count rather than **No models configured**.
4. Confirm the model has the **Default** badge. If necessary, click its star button (**Set as default**); the demos use the default when no model is specified.
5. Click the lightning button (**Test connection**) next to the model and confirm the **Model works!** message before opening the demo.

### Check Tools and Agentic Tool Use

The Getting Started demo ends with `agent.run()`, which needs all of the following:

- A working [default model](#configure-a-model).
- The built-in **Time Server**, which starts automatically when first installed. Existing saved server settings are preserved; if you previously stopped it, click **Start** under **MCP Servers**. See [Troubleshooting](#no-tools-available) if no tools are available.
- **Agentic Tool Use** enabled in the **Web Agents API** sidebar, under **Browser Agent Capabilities**. Manual **Tool Access** allows listing and calling tools directly; it does not enable `agent.run()`. Agentic Tool Use is on by default for new installs. Existing saved choices are preserved: if yours is off, turn it on for this demo, then reload the demo page so it picks up the setting.
- Permission granted to the demo's origin when it asks for `model:prompt`, `model:tools`, `mcp:tools.list` and `mcp:tools.call`. Enabling an API does not grant websites permission to use it.

Detection, permissions and tool listing can succeed without a model or Agentic Tool Use. Check these prerequisites before **Run Agent** so the final step is ready too.

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
2. Click **+ File**
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
cd bridge-rs && ./install.sh --firefox-only --skip-build
```
For Firefox, restart the browser and reload both temporary add-ons. For Chrome, follow the [native messaging instructions](docs/QUICKSTART_CHROME.md#step-5-configure-native-messaging).

For Chrome: verify the extension ID in the native messaging manifest matches your actual extension ID.

### "No LLM Provider Found"

```bash
ollama serve
curl http://localhost:11434/api/tags  # Should return models
```

### "No models configured"

A running Ollama provider is not a configured model. Follow [Configure a Model](#configure-a-model), including the default selection and connection test.

### "Feature disabled: toolCalling"

Enable **Agentic Tool Use** in the Web Agents API sidebar and reload the demo page. This is separate from manual Tool Access and from granting site permissions.

### "No tools available"

The built-in **Time Server** provides `time.now` and starts automatically when first installed. Existing saved stop choices are preserved, so a listed server may still be stopped. In the Harbor sidebar under **MCP Servers**, click **Start** on Time Server, then retry **Check Available Tools** in the demo.

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
