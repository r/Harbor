# Quickstart

**Get Harbor running and build your first AI-powered web app.**

This guide covers:
1. [Try the Demos](#part-1-try-the-demos) — See Harbor in action (5 min)
2. [Build Your First App](#part-2-build-your-first-app) — Write code using the API (10 min)
3. [Create Your Own Tools](#part-3-create-your-own-tools) — Build MCP servers (15 min)

> **Using an AI coding assistant?** Point it to **[docs/LLMS.txt](docs/LLMS.txt)** — a compact reference designed for Claude, Cursor, Copilot, and other AI tools to quickly understand and build with the API.

---

# Part 1: Try the Demos

## Prerequisites

| Tool | Install |
|------|---------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **Rust** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Firefox 109+** or **Chrome 120+** | Already have it |
| **Ollama** | [ollama.com](https://ollama.com) or `brew install ollama` |

## Step 1: Start Ollama

```bash
ollama serve &
ollama pull llama3.2    # or: mistral, codellama, etc.
```

## Step 2: Build Harbor

```bash
git clone --recurse-submodules https://github.com/anthropics/harbor.git
cd harbor

# Build extension
cd extension && npm install && npm run build && cd ..

# Build bridge
cd bridge-rs && cargo build --release && ./install.sh && cd ..
```

## Step 3: Load the Extension

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select `extension/dist/manifest.json`

**Chrome:**
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/dist/`

## Step 4: Run Demos

```bash
cd demo && npm install && npm start
```

Open http://localhost:8000 and try:

| Demo | What It Shows |
|------|---------------|
| **[Getting Started](http://localhost:8000/web-agents/getting-started/)** | Step-by-step API tutorial |
| **[Chat Demo](http://localhost:8000/web-agents/chat-poc/)** | Full chat with tools |
| **[Page Summarizer](http://localhost:8000/web-agents/summarizer/)** | AI-powered page summaries |

---

# Part 2: Build Your First App

## The Basics

Harbor exposes two JavaScript APIs to web pages:

```javascript
window.ai      // Text generation
window.agent   // Tools, permissions, autonomous agents
```

## Minimal Example

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

## Core API Patterns

### Pattern 1: Simple Chat

```javascript
// Request permission
await window.agent.requestPermissions({
  scopes: ['model:prompt'],
  reason: 'Chat feature'
});

// Create session with system prompt
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7
});

// Get response
const response = await session.prompt('What is JavaScript?');
console.log(response);

// Streaming response
for await (const event of session.promptStreaming('Explain React hooks')) {
  if (event.type === 'token') {
    document.getElementById('output').textContent += event.token;
  }
}

// Clean up
session.destroy();
```

### Pattern 2: List and Call Tools

```javascript
// Request tool permissions
await window.agent.requestPermissions({
  scopes: ['mcp:tools.list', 'mcp:tools.call'],
  reason: 'To use AI tools'
});

// List available tools
const tools = await window.agent.tools.list();
console.log('Available tools:', tools.map(t => t.name));

// Call a specific tool
const result = await window.agent.tools.call({
  tool: 'time-wasm/time.now',
  args: { timezone: 'America/New_York' }
});
console.log('Time:', result);
```

### Pattern 3: Autonomous Agent

```javascript
// Request all permissions for agent
await window.agent.requestPermissions({
  scopes: ['model:tools', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'Run autonomous tasks'
});

// Run an agent task
for await (const event of window.agent.run({
  task: 'What is the current time in Tokyo?',
  maxToolCalls: 5
})) {
  switch (event.type) {
    case 'tool_call':
      console.log('Calling:', event.tool, event.args);
      break;
    case 'tool_result':
      console.log('Result:', event.result);
      break;
    case 'token':
      document.getElementById('output').textContent += event.token;
      break;
    case 'final':
      console.log('Final answer:', event.output);
      break;
    case 'error':
      console.error('Error:', event.error);
      break;
  }
}
```

### Pattern 4: Read the Current Page

```javascript
await window.agent.requestPermissions({
  scopes: ['model:prompt', 'browser:activeTab.read'],
  reason: 'To analyze this page'
});

// Get page content
const page = await window.agent.browser.activeTab.readability();
console.log('Title:', page.title);
console.log('URL:', page.url);
console.log('Content:', page.text.slice(0, 500));

// Summarize it
const session = await window.ai.createTextSession({
  systemPrompt: 'Summarize text in 2-3 sentences.'
});
const summary = await session.prompt(page.text);
console.log('Summary:', summary);
```

---

## Permission Scopes

| Scope | Risk | What It Does |
|-------|------|--------------|
| `model:prompt` | 🟢 Low | Generate text with AI |
| `model:tools` | 🟡 Medium | Let AI call tools autonomously |
| `mcp:tools.list` | 🟢 Low | List available tools |
| `mcp:tools.call` | 🟡 Medium | Execute tools |
| `browser:activeTab.read` | 🟡 Medium | Read page content |

---

## Feature Flags

Some features are disabled by default. Enable them in the Harbor sidebar:

| Flag | Default | What It Enables |
|------|---------|-----------------|
| `toolCalling` | ❌ Off | `agent.run()` for autonomous tasks |
| `browserInteraction` | ❌ Off | Click, fill, scroll on pages |
| `browserControl` | ❌ Off | Navigate, create tabs |
| `multiAgent` | ❌ Off | Agent-to-agent communication |

---

## Error Handling

```javascript
try {
  const tools = await window.agent.tools.list();
} catch (err) {
  switch (err.code) {
    case 'ERR_SCOPE_REQUIRED':
      // Need to request permission first
      await window.agent.requestPermissions({ scopes: ['mcp:tools.list'] });
      break;
    case 'ERR_PERMISSION_DENIED':
      console.log('User denied permission');
      break;
    case 'ERR_FEATURE_DISABLED':
      console.log('Enable this feature in Harbor settings');
      break;
    default:
      console.error('Error:', err.message);
  }
}
```

---

## Troubleshooting

**"Web Agent API not detected"**
- Is Harbor loaded? Check `about:debugging` (Firefox) or `chrome://extensions`
- Refresh the page after loading the extension

**"Bridge Disconnected" in sidebar**
```bash
cd bridge-rs && ./install.sh
```

**"No LLM Provider Found"**
```bash
ollama serve
curl http://localhost:11434/api/tags  # Should return models
```

**"No tools available"**
- Start an MCP server in the Harbor sidebar first
- Check the "Curated Servers" section and install one

---

## Next Steps

| What You Want | Where to Go |
|---------------|-------------|
| Full API reference | [docs/WEB_AGENTS_API.md](docs/WEB_AGENTS_API.md) |
| More examples | [spec/examples/](spec/examples/) |
| Demo source code | [demo/](demo/) |
| Understand the spec | [spec/explainer.md](spec/explainer.md) |
| Create custom tools | [Part 3: Create Your Own Tools](#part-3-create-your-own-tools) |
| Contribute to Harbor | [CONTRIBUTING.md](CONTRIBUTING.md) |

---

# Part 3: Create Your Own Tools

**Want your AI to do more than chat? Create MCP servers that give it new capabilities.**

MCP (Model Context Protocol) servers are tools that AI agents can use. Examples:
- **Search** — Query APIs, databases, or the web
- **File access** — Read/write local files
- **Integrations** — Connect to GitHub, Gmail, Slack, etc.

## Quick Start: JavaScript MCP Server (5 min)

### 1. Copy the Template

```bash
cp -r mcp-servers/templates/javascript my-tool
cd my-tool
```

### 2. Edit `server.js`

```javascript
// Define your tools
const TOOLS = [
  {
    name: 'my_tool',
    description: 'Does something useful',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The input to process' }
      },
      required: ['input']
    }
  }
];

// Handle tool calls
async function handleToolCall(toolName, args) {
  if (toolName === 'my_tool') {
    // Your logic here
    return `Processed: ${args.input}`;
  }
  throw new Error(`Unknown tool: ${toolName}`);
}
```

### 3. Edit `manifest.json`

```json
{
  "manifestVersion": "1.0.0",
  "name": "my-tool",
  "version": "1.0.0",
  "description": "My custom MCP tool",
  "runtime": "js",
  "scriptUrl": "server.js",
  "tools": [
    {
      "name": "my_tool",
      "description": "Does something useful"
    }
  ]
}
```

### 4. Load in Harbor

1. Open Harbor sidebar → "MCP Servers"
2. Click "Add Server"  
3. Select your `manifest.json` file
4. Your tool is now available!

### 5. Use Your Tool

```javascript
// From any web page
const result = await window.agent.tools.call({
  tool: 'my-tool/my_tool',
  args: { input: 'hello world' }
});
console.log(result); // "Processed: hello world"
```

---

## Example: Weather API Tool

Here's a complete example that fetches weather data:

**manifest.json:**
```json
{
  "manifestVersion": "1.0.0",
  "name": "weather",
  "version": "1.0.0",
  "runtime": "js",
  "scriptUrl": "server.js",
  "capabilities": {
    "network": {
      "required": true,
      "hosts": ["api.openweathermap.org"]
    }
  },
  "secrets": [
    {
      "name": "OPENWEATHER_API_KEY",
      "description": "OpenWeatherMap API key",
      "helpUrl": "https://openweathermap.org/api"
    }
  ],
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather for a city"
    }
  ]
}
```

**server.js:**
```javascript
const TOOLS = [{
  name: 'get_weather',
  description: 'Get current weather for a city',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' }
    },
    required: ['city']
  }
}];

async function handleToolCall(toolName, args) {
  if (toolName === 'get_weather') {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${args.city}&appid=${apiKey}&units=metric`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    return `Weather in ${args.city}: ${data.weather[0].description}, ${data.main.temp}°C`;
  }
}

// ... rest of MCP boilerplate (see template)
```

---

## JavaScript vs WASM

| | JavaScript | WASM (Rust) |
|---|---|---|
| **Speed to build** | Fast — no compilation | Slower — needs `cargo build` |
| **Best for** | API wrappers, prototypes | Production, security-critical |
| **Ecosystem** | npm packages | Cargo crates |
| **Security** | Good (Web Worker sandbox) | Excellent (WASI sandbox) |

**Use JavaScript when:**
- You're prototyping or at a hackathon
- You're wrapping an HTTP API
- You want to iterate quickly

**Use WASM when:**
- You need maximum security
- You're building for production
- Performance is critical

---

## MCP Server Capabilities

Your server can request these capabilities in `manifest.json`:

| Capability | Use Case |
|------------|----------|
| `network.hosts` | Make HTTP requests to specific domains |
| `secrets` | Store API keys securely |
| `environment` | Non-secret configuration |
| `oauth` | Google, GitHub, etc. authentication |

All capabilities require user approval when the server is installed.

---

## Full Documentation

| Document | Description |
|----------|-------------|
| **[MCP Authoring Guide](mcp-servers/AUTHORING_GUIDE.md)** | Complete guide with all options |
| **[JS Template](mcp-servers/templates/javascript/)** | Full working JavaScript template |
| **[Rust Template](mcp-servers/templates/wasm-rust/)** | Full working WASM template |
| **[Manifest Spec](docs/MCP_MANIFEST_SPEC.md)** | All manifest fields |
| **[Example: Gmail](mcp-servers/examples/gmail/)** | Real-world OAuth example |

---

## Quick Reference

```javascript
// Check availability
if (window.agent) { /* Harbor installed */ }

// Request permissions
await window.agent.requestPermissions({
  scopes: ['model:prompt', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'Why you need it'
});

// Text generation
const session = await window.ai.createTextSession({ systemPrompt: '...' });
const response = await session.prompt('...');
session.destroy();

// Streaming
for await (const event of session.promptStreaming('...')) {
  if (event.type === 'token') { /* event.token */ }
}

// List tools
const tools = await window.agent.tools.list();

// Call tool
const result = await window.agent.tools.call({ tool: 'server/tool', args: {} });

// Agent run
for await (const event of window.agent.run({ task: '...', maxToolCalls: 5 })) {
  // event.type: 'tool_call' | 'tool_result' | 'token' | 'final' | 'error'
}

// Read page
const page = await window.agent.browser.activeTab.readability();
// { url, title, text }
```
