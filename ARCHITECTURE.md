# Harbor Architecture

This document describes the architecture of Harbor and the Web Agents API extension.

This repository contains two browser extensions that work together to bring AI and MCP (Model Context Protocol) capabilities to web applications:

- **Harbor** — Infrastructure extension providing LLM connections, MCP server hosting, and the native bridge
- **Web Agents API** — Implements the **[Web Agent API](spec/)** specification, exposing `window.ai` and `window.agent` to web pages

> **Related Documentation:**
> - [Web Agent API Spec](spec/) — The API specification that Web Agents API implements
> - [User Guide](docs/USER_GUIDE.md) — Installation and usage
> - [Developer Guide](docs/DEVELOPER_GUIDE.md) — Building apps with the Web Agent API
> - [Contributing](CONTRIBUTING.md) — Development setup
> - [MCP Host](docs/MCP_HOST.md) — Execution environment details

---

## Overview

The two extensions together provide:

| Capability | Provided By | Description |
|------------|-------------|-------------|
| **Web Agent API** | Web Agents API | `window.ai` and `window.agent` APIs for web pages |
| **Permission System** | Web Agents API | Per-origin capability grants with user consent |
| **MCP Server Management** | Harbor | Install, run, and connect to MCP servers |
| **In-Browser MCP Execution** | Harbor | Run MCP servers as WASM or JavaScript directly in the browser |
| **LLM Integration** | Harbor | Local model support (Ollama, llamafile) + cloud providers |
| **Chat Sidebar** | Harbor | Built-in chat UI with tool calling |
| **Address Bar Integration** | Harbor | Omnibox suggestions and tool shortcuts |
| **Bring Your Own Chatbot** | Both | Websites can integrate with the user's AI via `agent.mcp.*` and `agent.chat.*` |

---

## How It Works

The system exposes AI capabilities to web pages through a layered architecture involving five key components:

1. **Web Agents API Extension** — Injects JavaScript APIs into web pages and manages permissions
2. **Harbor Extension** — Manages LLM provider selection, MCP servers, and provides the chat sidebar
3. **Native Bridge (Rust)** — Handles LLM inference and native MCP server communication
4. **WASM Runtime** — Runs MCP servers compiled to WebAssembly in the browser
5. **JavaScript Runtime** — Runs JS MCP servers in sandboxed Web Workers

### The Web Agent API

When a web page loads with both extensions installed, the Web Agents API extension injects a script that exposes two global JavaScript objects:

```javascript
// window.ai — Text generation (Chrome Prompt API compatible)
const session = await window.ai.createTextSession({
  systemPrompt: 'You are helpful.'
});
const response = await session.prompt('Hello!');

// window.agent — Tools, browser access, autonomous agents
await window.agent.requestPermissions({
  scopes: ['model:prompt', 'mcp:tools.list', 'mcp:tools.call'],
  reason: 'Enable AI features'
});

const tools = await window.agent.tools.list();
for await (const event of window.agent.run({ task: 'Search for news' })) {
  console.log(event);
}
```

These APIs are **permission-gated** — web pages must request explicit user consent before accessing AI capabilities.

### Message Flow: Web Page → Web Agents API → Harbor → Bridge

```
Web Page           Web Agents API            Harbor Extension           Bridge
   │                    │                         │                        │
   │ window.ai.prompt() │                         │                        │
   ├───────────────────►│                         │                        │
   │    postMessage     │ Cross-ext messaging     │                        │
   │                    ├────────────────────────►│                        │
   │                    │                         │ Native Messaging       │
   │                    │                         ├───────────────────────►│
   │                    │                         │                        │ LLM call
   │                    │                         │◄───────────────────────┤
   │                    │◄────────────────────────┤                        │
   │◄───────────────────┤                         │                        │
   │ "Hello! How can.." │                         │                        │
```

### Execution Paths

The system supports two execution paths for different capabilities:

#### Path 1: In-Browser Execution (No Bridge Required)

MCP servers can run entirely in the browser using:

- **WASM Runtime** — Servers compiled to WebAssembly (e.g., `mcp-time.wasm`)
- **JavaScript Runtime** — Servers written in JavaScript running in Web Workers

This path is ideal for:
- Privacy-sensitive operations (data never leaves the browser)
- Offline functionality
- Simple tools that don't need external resources

#### Path 2: Native Bridge Execution

For LLM inference and native MCP servers, Harbor uses a Rust native messaging bridge:

- **LLM Communication** — Connects to Ollama, OpenAI, Anthropic, and other providers
- **Native MCP Servers** — Runs stdio-based MCP servers as child processes
- **OAuth Flows** — Handles authentication with external services

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WEB PAGE                                        │
│                                                                              │
│  window.ai                           window.agent                            │
│  ├── createTextSession()             ├── requestPermissions()                │
│  ├── languageModel.create()          ├── capabilities()                      │
│  ├── providers.list()                ├── tools.list() / tools.call()        │
│  └── runtime.getBest()               ├── browser.activeTab.*                 │
│                                      ├── run({ task })                       │
│                                      ├── sessions.create()                   │
│                                      ├── addressBar.registerProvider()      │
│                                      ├── mcp.discover/register() [BYOC]     │
│                                      ├── chat.open/close() [BYOC]           │
│                                      └── agents.* [Multi-Agent]             │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │ postMessage (harbor_web_agent channel)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       BROWSER EXTENSION (Chrome/Firefox)                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐   │
│  │  Content Script   │  │   Background      │  │      Sidebar          │   │
│  │  (injected.ts)    │  │   (background.ts) │  │      (sidebar.ts)     │   │
│  │                   │  │                   │  │                       │   │
│  │  • Inject APIs    │  │  • Message router │  │  • Server management  │   │
│  │  • Route messages │  │  • Permissions    │  │  • LLM configuration  │   │
│  │  • Feature flags  │  │  • Orchestration  │  │  • Feature flags      │   │
│  └─────────┬─────────┘  └─────────┬─────────┘  └───────────┬───────────┘   │
│            │                      │                        │                │
│            └──────────────────────┼────────────────────────┘                │
│                                   │                                          │
│  ┌────────────────────────────────┴──────────────────────────────────────┐  │
│  │                     IN-BROWSER MCP EXECUTION                           │  │
│  │                                                                        │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐    │  │
│  │  │   WASM Runtime   │  │   JS Runtime     │  │   Address Bar    │    │  │
│  │  │   (runtime.ts)   │  │   (sandbox.ts)   │  │   (addressbar.ts)│    │  │
│  │  │                  │  │                  │  │                  │    │  │
│  │  │  • WASI support  │  │  • Web Workers   │  │  • Omnibox API   │    │  │
│  │  │  • Isolated mem  │  │  • Fetch proxy   │  │  • Suggestions   │    │  │
│  │  │  • MCP protocol  │  │  • MCP protocol  │  │  • Tool shortcuts│    │  │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                   │                                          │
└───────────────────────────────────┼──────────────────────────────────────────┘
                                    │ Native Messaging (stdin/stdout JSON)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            RUST BRIDGE (bridge-rs)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         NATIVE MESSAGING                              │   │
│  │                        (native_messaging.rs)                          │   │
│  │         Length-prefixed JSON frames over stdin/stdout                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐      │
│  │    RPC Handler  │  │   LLM Manager   │  │   QuickJS Runtime      │      │
│  │    (rpc/)       │  │   (llm/)        │  │   (js/)                 │      │
│  │                 │  │                 │  │                         │      │
│  │  • Method       │  │  • any-llm lib  │  │  • JS MCP servers      │      │
│  │    dispatch     │  │  • Ollama       │  │  • Sandboxed execution │      │
│  │  • Request/     │  │  • OpenAI       │  │  • Capability-based    │      │
│  │    response     │  │  • Anthropic    │  │    permissions         │      │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘      │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────────────────────────────────────┐   │
│  │  OAuth Manager  │  │           File System Access (fs/)              │   │
│  │  (oauth/)       │  │                                                 │   │
│  │                 │  │  • Configuration storage (~/.harbor/)           │   │
│  │  • OAuth flows  │  │  • Credential management                        │   │
│  │  • Token cache  │  │  • Session persistence                          │   │
│  │  • Providers    │  │                                                 │   │
│  └─────────────────┘  └─────────────────────────────────────────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP (OpenAI-compatible API)
                                    ▼
                        ┌─────────────────────────┐
                        │     LLM Providers       │
                        │  Ollama, OpenAI,        │
                        │  Anthropic, llamafile   │
                        └─────────────────────────┘
```

---

## Web Agents API Extension

The **web-agents-api** (`web-agents-api/`) is a companion extension that provides a streamlined way to access Harbor's capabilities. It can operate in two modes:

### Standalone Mode
When Harbor is not installed, the Web Agents API extension provides a simplified API surface with configurable feature flags.

### Bridge Mode
When Harbor is installed, the Web Agents API connects to Harbor via `chrome.runtime.sendMessage` to access the full Harbor backend:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WEB PAGE                                        │
│                        window.ai / window.agent                              │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │ postMessage
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     WEB AGENTS API EXTENSION                                 │
│                                                                              │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐   │
│  │  Content Script   │  │   Background      │  │   Harbor Client       │   │
│  │  (injected.ts)    │  │   (background.ts) │  │   (harbor-client.ts)  │   │
│  │                   │  │                   │  │                       │   │
│  │  • Inject APIs    │  │  • Feature flags  │  │  • Discover Harbor    │   │
│  │  • Route messages │  │  • Local handling │  │  • Forward requests   │   │
│  │  • Feature gates  │  │  • Harbor proxy   │  │  • Stream responses   │   │
│  └───────────────────┘  └─────────┬─────────┘  └───────────┬───────────┘   │
│                                   │                        │                │
│                                   └────────────────────────┘                │
└───────────────────────────────────────────────────────────────────────────────┘
                                    │ chrome.runtime.sendMessage
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        HARBOR EXTENSION                                      │
│                   (Full implementation as above)                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Feature Flags

The Web Agents API extension uses feature flags to control which capabilities are exposed:

| Flag | Description | Default |
|------|-------------|---------|
| `textGeneration` | Enable `window.ai` for text generation | `true` |
| `toolCalling` | Enable `agent.run()` for autonomous tasks | `false` |
| `toolAccess` | Enable `agent.tools.list()` and `call()` | `true` |
| `browserInteraction` | Enable click/fill/scroll on pages | `false` |
| `browserControl` | Enable navigation and tab management | `false` |
| `multiAgent` | Enable multi-agent orchestration | `false` |

---

## Runtimes in Detail

### Native Bridge (Rust)

The native bridge (`bridge-rs/`) is a Rust binary that communicates with the browser extension via **native messaging** — a protocol where the browser spawns the binary and communicates over stdin/stdout with length-prefixed JSON frames.

**Key responsibilities:**

1. **LLM Provider Abstraction** — Unified interface to multiple LLM backends:
   - **Ollama** — Local models via HTTP API
   - **OpenAI** — GPT models via OpenAI API
   - **Anthropic** — Claude models via Anthropic API
   - **llamafile** — Single-file local models

2. **Configuration Management** — Stores settings in `~/.harbor/`:
   ```
   ~/.harbor/
   ├── harbor.db         # SQLite database for server configs
   ├── catalog.db        # Cached MCP server catalog
   ├── installed_servers.json
   ├── secrets/
   │   └── credentials.json  # API keys (mode 600)
   └── sessions/         # Chat session history
   ```

3. **OAuth Handling** — Browser-based OAuth flows for services requiring authentication

4. **RPC Dispatch** — Routes incoming requests to appropriate handlers:
   ```rust
   // Example RPC message
   { "type": "llm_chat", "request_id": "abc123", "messages": [...] }
   ```

### WASM Runtime

The WASM runtime (`extension/src/wasm/`) executes MCP servers compiled to WebAssembly directly in the browser using **WASI** (WebAssembly System Interface).

**How it works:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    WASM MCP Server                               │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ .wasm file   │───►│ WASI Runtime │───►│  MCP Protocol    │  │
│  │ (compiled)   │    │ (jco/wasmer) │    │  (JSON-RPC)      │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                  │
│  Features:                                                       │
│  • Isolated memory (no access to host memory)                   │
│  • Sandboxed execution (limited syscalls)                       │
│  • Controlled I/O through WASI interface                        │
│  • MCP stdio transport emulation                                │
└─────────────────────────────────────────────────────────────────┘
```

**Example WASM server lifecycle:**

```typescript
// 1. Register the server
const handle = registerMcpServer({
  id: 'time-wasm',
  wasmUrl: 'mcp-time.wasm',
  tools: [{ name: 'time.now', description: 'Get current time' }]
});

// 2. Start the server (loads WASM, creates session)
await startMcpServer('time-wasm');

// 3. Call tools via MCP protocol
const result = await callMcpTool('time-wasm', 'time.now', {});
// { ok: true, result: { iso: "2026-01-27T10:30:00Z" } }
```

### JavaScript Runtime

The JS runtime (`extension/src/js-runtime/`) executes JavaScript MCP servers in **sandboxed Web Workers**.

**How it works:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    JS MCP Server (Web Worker)                    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   SANDBOX PREAMBLE                        │  │
│  │                                                           │  │
│  │  • Removes dangerous globals (fetch, XMLHttpRequest,      │  │
│  │    WebSocket, importScripts)                              │  │
│  │  • Provides controlled fetch via postMessage proxy        │  │
│  │  • Provides MCP.readLine() / MCP.writeLine() for stdio    │  │
│  │  • Provides process.env for secrets injection             │  │
│  │  • Forwards console.* to host for logging                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────▼──────────────────────────────┐  │
│  │                   SERVER CODE                             │  │
│  │                                                           │  │
│  │  // MCP server implementation                             │  │
│  │  while (true) {                                           │  │
│  │    const request = JSON.parse(await MCP.readLine());      │  │
│  │    const response = handleRequest(request);               │  │
│  │    MCP.writeLine(JSON.stringify(response));               │  │
│  │  }                                                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
            │                               ▲
            │ stdout (MCP responses)        │ stdin (MCP requests)
            ▼                               │
┌─────────────────────────────────────────────────────────────────┐
│                    HOST (Extension Background)                   │
│                                                                  │
│  • Routes fetch requests through allowlist                      │
│  • Injects environment variables (API keys)                     │
│  • Manages server lifecycle                                      │
│  • Translates MCP protocol                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Security features of the JS sandbox:**

1. **Network isolation** — `fetch`, `XMLHttpRequest`, and `WebSocket` are removed; network access is only available through a controlled proxy
2. **No dynamic imports** — `importScripts` is removed
3. **Environment injection** — Secrets are passed via `process.env`, not hardcoded
4. **Console forwarding** — All console output is captured for debugging

---

## Data Flow

### 1. Web Page to AI Response

```
Web Page                    Extension                    Bridge                    LLM
   │                           │                           │                        │
   │ session.prompt("Hi")      │                           │                        │
   ├──────────────────────────►│                           │                        │
   │                           │ llm_chat                  │                        │
   │                           ├──────────────────────────►│                        │
   │                           │                           │ POST /v1/chat/...      │
   │                           │                           ├───────────────────────►│
   │                           │                           │◄───────────────────────┤
   │                           │◄──────────────────────────┤                        │
   │◄──────────────────────────┤                           │                        │
   │ "Hello! How can I help?"  │                           │                        │
```

### 2. Tool Call Flow

```
Web Page                    Extension                    Bridge                 MCP Server
   │                           │                           │                        │
   │ agent.tools.call(...)     │                           │                        │
   ├──────────────────────────►│                           │                        │
   │                           │ ① Check permission        │                        │
   │                           │ ② host_call_tool          │                        │
   │                           ├──────────────────────────►│                        │
   │                           │                           │ ③ Check rate limit     │
   │                           │                           │ ④ Resolve tool         │
   │                           │                           │ ⑤ MCP call             │
   │                           │                           ├───────────────────────►│
   │                           │                           │◄───────────────────────┤
   │                           │◄──────────────────────────┤                        │
   │◄──────────────────────────┤                           │                        │
   │ { result: ... }           │                           │                        │
```

### 3. Agent Run (Autonomous Task)

```
User: "Find my recent GitHub PRs and summarize them"
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Chat Orchestrator                           │
│                                                                  │
│  1. Tool Router analyzes task → selects "github" server         │
│  2. Collect tools from github server only                       │
│  3. Send to LLM with tool definitions                           │
│  4. LLM returns: call github/list_prs                           │
│  5. Execute tool → get results                                  │
│  6. Send results back to LLM                                    │
│  7. LLM returns: call github/get_pr_details                     │
│  8. Execute tool → get results                                  │
│  9. Send results back to LLM                                    │
│  10. LLM generates final summary                                │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
"You have 3 open PRs: #123 fixes auth bug, #124 adds dark mode..."
```

### 4. In-Browser Tool Call (WASM/JS)

```
Web Page                    Extension                   WASM/JS Runtime
   │                           │                              │
   │ tools.call('time/now')    │                              │
   ├──────────────────────────►│                              │
   │                           │ ① Check permission           │
   │                           │ ② Route to runtime           │
   │                           ├─────────────────────────────►│
   │                           │                              │ ③ Execute tool
   │                           │                              │    (no network)
   │                           │◄─────────────────────────────┤
   │◄──────────────────────────┤                              │
   │ { iso: "2026-01-27T..." } │                              │
```

Note: In-browser tools execute entirely within the extension — no native bridge communication is required, making them faster and available offline.

---

## Injected API Architecture

The `injected.ts` script is the heart of the Web Agent API. It's injected into every web page and creates the `window.ai` and `window.agent` objects.

### How Injection Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         CONTENT SCRIPT                           │
│                                                                  │
│  1. Create <script> element with injected.ts code               │
│  2. Inject feature flags via <script id="harbor-feature-flags"> │
│  3. Insert script at document_start (before page scripts)       │
│  4. Set up postMessage listener for bidirectional communication │
└───────────────────────────────────────────────────────────────────┘
         │                                           ▲
         │ Injects script                            │ postMessage
         ▼                                           │
┌─────────────────────────────────────────────────────────────────┐
│                         WEB PAGE CONTEXT                         │
│                                                                  │
│  window.ai = {                                                   │
│    canCreateTextSession(),                                       │
│    createTextSession(options),                                   │
│    languageModel: { capabilities(), create() },                  │
│    providers: { list(), getActive() },                           │
│    runtime: { harbor, firefox, chrome, getBest() }               │
│  }                                                               │
│                                                                  │
│  window.agent = {                                                │
│    capabilities(),                                               │
│    requestPermissions(options),                                  │
│    permissions: { list() },                                      │
│    tools: { list(), call() },                                    │
│    browser: { activeTab: { readability(), click(), ... } },      │
│    run(options),  // Returns AsyncIterable<RunEvent>             │
│    sessions: { create(), list(), terminate() },                  │
│    mcp: { discover(), register() },     // BYOC                  │
│    chat: { canOpen(), open(), close() } // BYOC                  │
│    addressBar: { ... },                 // Omnibox integration   │
│    agents: { ... }                      // Multi-agent           │
│  }                                                               │
│                                                                  │
│  window.harbor = { ai, agent, version, chromeAiDetected }        │
└─────────────────────────────────────────────────────────────────┘
```

### Transport Protocol

Communication between the injected script and content script uses `postMessage` with a dedicated channel:

```javascript
// Injected script → Content script (request)
window.postMessage({
  channel: 'harbor_web_agent',
  request: {
    id: 'uuid-here',
    type: 'ai.createTextSession',
    payload: { systemPrompt: 'Be helpful', temperature: 0.7 }
  }
}, '*');

// Content script → Injected script (response)
window.postMessage({
  channel: 'harbor_web_agent',
  response: {
    id: 'uuid-here',
    ok: true,
    result: 'session-id-here'
  }
}, '*');

// Streaming events (for promptStreaming, agent.run)
window.postMessage({
  channel: 'harbor_web_agent',
  streamEvent: {
    id: 'uuid-here',
    event: { type: 'token', token: 'Hello' },
    done: false
  }
}, '*');
```

### Streaming with AsyncIterables

The `agent.run()` and `session.promptStreaming()` methods return `AsyncIterable` objects that yield events as they arrive:

```javascript
// Implementation pattern
function createStreamIterable(type, payload) {
  const id = crypto.randomUUID();
  
  return {
    [Symbol.asyncIterator]() {
      const queue = [];
      let resolveNext = null;
      let done = false;
      
      // Register listener BEFORE sending request
      streamListeners.set(id, (event, isDone) => {
        if (isDone) done = true;
        if (resolveNext) {
          resolveNext({ done: false, value: event });
          resolveNext = null;
        } else {
          queue.push(event);
        }
      });
      
      // Send the request
      window.postMessage({ channel, request: { id, type, payload } }, '*');
      
      return {
        async next() {
          if (queue.length > 0) return { done: false, value: queue.shift() };
          if (done) return { done: true, value: undefined };
          return new Promise(resolve => { resolveNext = resolve; });
        },
        async return() {
          window.postMessage({ channel, abort: { id } }, '*');
          return { done: true, value: undefined };
        }
      };
    }
  };
}
```

---

## Components

### Extension Layer (`extension/src/`)

| Directory/File | Purpose |
|----------------|---------|
| `agents/` | Web Agent API implementation |
| `agents/injected.ts` | `window.ai` and `window.agent` API injection |
| `agents/transport.ts` | Message passing between page and background |
| `agents/orchestrator.ts` | Agent run loop with tool calling |
| `agents/addressbar.ts` | Omnibox/address bar integration |
| `agents/types.ts` | TypeScript type definitions |
| `js-runtime/` | JavaScript MCP server sandbox |
| `js-runtime/sandbox.ts` | Web Worker-based JS execution |
| `js-runtime/session.ts` | JS server session management |
| `wasm/` | WebAssembly MCP server runtime |
| `wasm/runtime.ts` | WASI-compatible WASM execution |
| `wasm/session.ts` | WASM server session management |
| `llm/` | LLM communication |
| `llm/native-bridge.ts` | Native messaging to Rust bridge |
| `llm/bridge-client.ts` | RPC client for bridge |
| `mcp/` | MCP protocol implementation |
| `mcp/host.ts` | In-browser MCP host |
| `policy/` | Permission system |
| `policy/permissions.ts` | Permission checking and prompts |
| `storage/` | Extension storage utilities |
| `background.ts` | Service worker / background script |
| `sidebar.ts` | Sidebar UI for server management |
| `directory.ts` | MCP server directory/catalog UI |

### Rust Bridge Layer (`bridge-rs/src/`)

| Directory/File | Purpose |
|----------------|---------|
| `main.rs` | Entry point, native messaging loop |
| `native_messaging.rs` | Length-prefixed JSON protocol |
| `rpc/` | RPC method dispatch |
| `llm/` | LLM provider management |
| `llm/config.rs` | LLM configuration and model aliases |
| `js/` | QuickJS JavaScript runtime |
| `js/runtime.rs` | JS execution environment |
| `js/sandbox.rs` | Capability-based sandboxing |
| `fs/` | Filesystem utilities |
| `any-llm-rust/` | Multi-provider LLM library (submodule) |

---

## Process Isolation Architecture

Harbor uses a multi-process architecture for crash isolation and security when running third-party MCP servers.

### Why Process Isolation?

MCP servers are third-party code downloaded from npm, PyPI, or GitHub. Without isolation:
- A buggy server could crash the entire bridge
- Memory leaks in one server affect all servers
- A malicious server could potentially access data from other servers

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     MAIN BRIDGE PROCESS                           │
│  - Native messaging (Firefox communication)                      │
│  - Permission enforcement                                        │
│  - Rate limiting                                                 │
│  - Tool registry                                                 │
│  - LLM communication                                             │
└──────────────────┬────────────────────────────────┬──────────────┘
                   │ IPC (fork)                     │ IPC (fork)
                   ▼                                ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│       MCP RUNNER PROCESS     │  │       MCP RUNNER PROCESS     │
│       (one per server)       │  │       (one per server)       │
│                              │  │                              │
│  - Manages single server     │  │  - Manages single server     │
│  - Crash isolated            │  │  - Crash isolated            │
│  - Communicates via IPC      │  │  - Communicates via IPC      │
│                              │  │                              │
│  ┌────────────────────────┐  │  │  ┌────────────────────────┐  │
│  │ stdio subprocess       │  │  │  │ stdio subprocess       │  │
│  │ (npx, uvx, binary)     │  │  │  │ (npx, uvx, binary)     │  │
│  └────────────────────────┘  │  │  └────────────────────────┘  │
└──────────────────────────────┘  └──────────────────────────────┘
```

### Enabling Process Isolation

Process isolation is opt-in. Enable it via environment variable:

```bash
export HARBOR_MCP_ISOLATION=1
```

### How It Works

1. **Process Spawning**: When connecting to a server, the Rust bridge spawns the MCP server as a child process
2. **Stdio Communication**: The bridge communicates with servers via stdin/stdout using JSON-RPC
3. **Crash Recovery**: If a server crashes, only that server is affected; the bridge survives and can restart it

### Server Commands

The bridge manages servers via stdio JSON-RPC:

| Command | Description |
|---------|-------------|
| `connect` | Spawn the MCP server and establish connection |
| `disconnect` | Stop the server process |
| `list_tools` | Get tools from the server |
| `call_tool` | Execute a tool |
| `list_resources` | Get resources from the server |
| `read_resource` | Read a resource |
| `get_prompt` | Get a prompt |
| `shutdown` | Terminate the runner |

### Catalog Worker

A similar isolation pattern is used for the catalog system:

- **Main bridge**: Only reads from the catalog database
- **Catalog worker**: Separate process that handles network fetches and database writes
- **Enabled via**: `HARBOR_CATALOG_WORKER=1`

```bash
# Enable catalog worker isolation
export HARBOR_CATALOG_WORKER=1
```

---

## Permission System

Permissions are scoped per-origin with capability-based grants.

### Scopes

| Scope | Description | Grants Access To |
|-------|-------------|------------------|
| `model:prompt` | Basic text generation | `ai.createTextSession()` |
| `model:tools` | AI with tool calling | `agent.run()` |
| `mcp:tools.list` | List available tools | `agent.tools.list()` |
| `mcp:tools.call` | Execute tools | `agent.tools.call()` |
| `mcp:servers.register` | Register website MCP servers | `agent.mcp.register()` |
| `browser:activeTab.read` | Read active tab | `agent.browser.activeTab.readability()` |
| `chat:open` | Open browser chat UI | `agent.chat.open()` |

### Grant Types

| Type | Behavior | Storage |
|------|----------|---------|
| `ALLOW_ONCE` | Expires after 10 min or tab close | Memory |
| `ALLOW_ALWAYS` | Persists across sessions | `browser.storage.local` |
| `DENY` | Explicitly denied (no re-prompt) | `browser.storage.local` |

### Enforcement Flow

```
Request arrives with origin "https://example.com"
        │
        ▼
┌───────────────────────────┐
│ Check DENY grants         │─────► Denied? Return ERR_PERMISSION_DENIED
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│ Check ALLOW_ALWAYS grants │─────► Found? Proceed
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│ Check ALLOW_ONCE grants   │─────► Found & not expired? Proceed
│ (check expiry & tab)      │─────► Expired? Remove & continue
└───────────────────────────┘
        │
        ▼
Return ERR_SCOPE_REQUIRED
```

---

## Tool Registry

Tools from MCP servers are namespaced to prevent collisions.

**Format:** `{serverId}/{toolName}`

**Examples:**
- `filesystem/read_file`
- `github/search_issues`
- `memory-server/save_memory`

### Registration

```
MCP Server connects
        │
        ▼
┌───────────────────────────┐
│ Call tools/list           │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│ Register tools with       │
│ namespace prefix          │
│                           │
│ read_file → filesystem/   │
│             read_file     │
└───────────────────────────┘
        │
        ▼
Tools available for invocation
```

---

## Rate Limiting

| Limit | Default | Purpose |
|-------|---------|---------|
| `maxCallsPerRun` | 5 | Prevent runaway agent loops |
| `maxConcurrentPerOrigin` | 2 | Fair resource sharing |
| `defaultTimeoutMs` | 30,000 | Prevent hanging calls |

### Budget Tracking

```typescript
// Create a run with budget
const run = rateLimiter.createRun(origin, 5);

// Each tool call decrements budget
await rateLimiter.acquireCallSlot(origin, run.runId);
// → Budget: 5 → 4

// Exceeding budget returns error
await rateLimiter.acquireCallSlot(origin, run.runId);
// → ERR_BUDGET_EXCEEDED
```

---

## Server Lifecycle

```
         ┌──────────────────┐
         │    INSTALLING    │ Package download/build
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │     STOPPED      │ Installed but not running
         └────────┬─────────┘
                  │ start
                  ▼
         ┌──────────────────┐
         │    STARTING      │ Process spawning
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
    ┌───►│     RUNNING      │ Connected and operational
    │    └────────┬─────────┘
    │             │ crash
    │             ▼
    │    ┌──────────────────┐
    │    │     CRASHED      │ Unexpected exit
    │    └────────┬─────────┘
    │             │ auto-restart (up to 3 times)
    └─────────────┘
```

---

## Data Storage

All persistent data is stored in `~/.harbor/`:

| File | Format | Contents |
|------|--------|----------|
| `harbor.db` | SQLite | Server configurations |
| `catalog.db` | SQLite | Cached server catalog |
| `installed_servers.json` | JSON | Installed server metadata |
| `secrets/credentials.json` | JSON | API keys (file permissions: 600) |
| `sessions/*.json` | JSON | Chat session history |

---

## Error Codes

| Code | Description |
|------|-------------|
| `ERR_PERMISSION_DENIED` | Caller lacks required permission |
| `ERR_SCOPE_REQUIRED` | Permission scope not granted |
| `ERR_SERVER_UNAVAILABLE` | MCP server not connected |
| `ERR_TOOL_NOT_FOUND` | Tool does not exist |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist |
| `ERR_TOOL_TIMEOUT` | Tool call timed out |
| `ERR_TOOL_FAILED` | Tool execution error |
| `ERR_RATE_LIMITED` | Concurrent limit exceeded |
| `ERR_BUDGET_EXCEEDED` | Run budget exhausted |

---

## Security Model

| Layer | Protection |
|-------|------------|
| **Origin Isolation** | Permissions scoped to origin |
| **User Consent** | Explicit grants required |
| **No Payload Logging** | Tool args/results not logged |
| **Rate Limiting** | Prevents abuse |
| **Tool Allowlisting** | Origins can be restricted to specific tools |
| **Tab-Scoped Grants** | ALLOW_ONCE can be tied to a tab |
| **Secret Storage** | Credentials stored with restricted file permissions |

---

## Message Protocol

The bridge uses native messaging with length-prefixed JSON frames.

### Frame Format

```
┌─────────────────┬────────────────────────────────────────┐
│ Length (4 bytes)│ JSON Payload (UTF-8)                   │
│ Little-endian   │ { "type": "...", "request_id": "..." } │
└─────────────────┴────────────────────────────────────────┘
```

### Message Categories

**Server Management:** `add_server`, `remove_server`, `list_servers`, `connect_server`, `disconnect_server`

**MCP Operations:** `mcp_connect`, `mcp_list_tools`, `mcp_call_tool`, `mcp_read_resource`

**BYOC:** `connect_remote_mcp`, `disconnect_remote_mcp`, `page_chat_message`

**LLM:** `llm_detect`, `llm_chat`, `llm_set_active`

**Chat:** `chat_create_session`, `chat_send_message`, `chat_list_sessions`

**Host:** `host_list_tools`, `host_call_tool`, `host_grant_permission`

See [Developer Guide](docs/DEVELOPER_GUIDE.md) for complete message reference.
