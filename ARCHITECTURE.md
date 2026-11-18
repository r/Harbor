# Harbor Architecture

This document describes the architecture of Harbor, a single browser extension.

Harbor brings AI and MCP (Model Context Protocol) capabilities to web applications:

- **Infrastructure** — LLM connections, MCP server hosting, and the native bridge
- **Page API** (`extension/src/page-api/`) — Implements the **[Web Agent API](spec/)** specification, exposing `window.ai`, `window.agent` and `navigator.modelContext` to web pages

> **Related Documentation:**
> - [Web Agent API Spec](spec/) — The API specification Harbor's page API implements
> - [User Guide](docs/USER_GUIDE.md) — Installation and usage
> - [Developer Guide](docs/DEVELOPER_GUIDE.md) — Building apps with the Web Agent API
> - [Contributing](CONTRIBUTING.md) — Development setup
> - [MCP Host](docs/MCP_HOST.md) — Execution environment details

---

## Overview

Harbor provides:

| Capability | Provided By | Description |
|------------|-------------|-------------|
| **Web Agent API** | Page API | `window.ai`, `window.agent` and `navigator.modelContext` for web pages |
| **Permission System** | Harbor | Per-origin capability grants with user consent; Harbor's page API checks them before every page call |
| **MCP Server Management** | Harbor | Install, run, and connect to MCP servers |
| **In-Browser MCP Execution** | Harbor | Run MCP servers as WASM or JavaScript directly in the browser |
| **LLM Integration** | Harbor | Local model support (Ollama, llamafile) + cloud providers |
| **Chat Sidebar** | Harbor | Built-in chat UI with tool calling |
| **Bring Your Own Chatbot** | Harbor | Websites can integrate with the user's AI via `agent.mcp.*` and `agent.chat.*` |

---

## How It Works

The system exposes AI capabilities to web pages through a layered architecture involving four key components:

1. **Page API** (`extension/src/page-api/`) — Injects the JavaScript APIs into web pages and routes their calls to the rest of Harbor
2. **Harbor Extension** — Manages LLM provider selection, MCP servers, and provides the chat sidebar
3. **Native Bridge (Rust)** — Handles LLM inference and native MCP server communication
4. **WASM and JavaScript Runtimes** — Run MCP servers compiled to WebAssembly, or written in JavaScript, directly in the browser

### The Web Agent API

When a web page loads, Harbor's content script injects a script that exposes two global JavaScript objects:

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

### Message Flow: Web Page → Harbor → Bridge

```
Web Page                              Harbor Extension           Bridge
   │                                       │                        │
   │ window.ai.prompt()                    │                        │
   ├──────────────────────────────────────►│                        │
   │    postMessage to page-api/           │                        │
   │    content-script.ts, which forwards  │ Native Messaging       │
   │    over a port to background.ts       ├───────────────────────►│
   │                                       │                        │ LLM call
   │                                       │◄───────────────────────┤
   │◄──────────────────────────────────────┤                        │
   │ "Hello! How can.."                    │                        │
```

### Execution Paths

The system supports two execution paths for different capabilities:

#### Path 1: In-Browser Execution (No Bridge Required)

MCP servers can run entirely in the browser using:

- **WASM Runtime** — Servers compiled to WebAssembly (e.g., `mcp-time.wasm`)
- **JavaScript Runtime** — Built-in JavaScript servers running in Web Workers (other JavaScript servers run in the bridge's QuickJS runtime)

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
                                        │ postMessage (harbor_page_api channel)
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
│  │  ┌──────────────────┐  ┌──────────────────┐                          │  │
│  │  │   WASM Runtime   │  │   JS Runtime     │                          │  │
│  │  │   (runtime.ts)   │  │   (session.ts)   │                          │  │
│  │  │                  │  │                  │                          │  │
│  │  │  • WASI support  │  │  • QuickJS/bridge│                          │  │
│  │  │  • Isolated mem  │  │  • Web Workers   │                          │  │
│  │  │  • MCP protocol  │  │  • MCP protocol  │                          │  │
│  │  └──────────────────┘  └──────────────────┘                          │  │
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

## Page API

The **page API** (`extension/src/page-api/`) is the part of Harbor that talks to web pages. It has its own content script and background wiring, but runs in Harbor's own background process — there is no separate extension and no cross-extension messaging:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WEB PAGE                                        │
│                        window.ai / window.agent                              │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │ postMessage
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     HARBOR EXTENSION — PAGE API                              │
│                                                                              │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐   │
│  │  Content Script   │  │   Background      │  │   harbor-core.ts      │   │
│  │  (injected.ts)    │  │   (background.ts) │  │                       │   │
│  │                   │  │                   │  │                       │   │
│  │  • Inject APIs    │  │  • Feature flags  │  │  • In-process call    │   │
│  │  • Route messages │  │  • Origin from    │  │    into Harbor's      │   │
│  │  • Feature gates  │  │    port.sender     │  │    extension-api and │   │
│  │                   │  │                   │  │    agent router       │   │
│  └───────────────────┘  └─────────┬─────────┘  └───────────┬───────────┘   │
│                                   │                        │                │
│                                   └────────────────────────┘                │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ in-process function call
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  HARBOR EXTENSION — THE REST OF HARBOR                       │
│          (extension-api.ts, agents/background-router.ts, and below)          │
└─────────────────────────────────────────────────────────────────────────────┘
```

`harbor-core.ts` is the seam: it's the only file under `page-api/` allowed to import from outside `page-api/`, so the rest of the page API stays swappable if the agent side changes shape later. The page's origin always comes from the connecting port's `sender` (its URL in Firefox, its `origin` in Chrome) — never from the message itself, which a page or a compromised content script could otherwise forge.

### Feature Flags

Harbor's page API uses feature flags to control which capabilities are exposed to pages. They're managed from the sidebar's "Browser Agent Capabilities" panel:

| Flag | Description | Default |
|------|-------------|---------|
| `textGeneration` | Enable `window.ai` for text generation | `true` |
| `toolCalling` | Enable `agent.run()` for autonomous tasks | `true` |
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

The JS runtime (`extension/src/js-runtime/session.ts`) runs JavaScript MCP servers in one of two places:

- **The bridge's QuickJS runtime.** This is the normal path, and the only one for servers that aren't built in. The extension sends the server's code to the bridge and speaks MCP to it over the bridge connection.
- **A Web Worker, for built-in servers only.** When the bridge isn't connected, a built-in server (today, `echo-js`) runs from a pre-bundled worker file such as `js-runtime/builtin-echo-worker.js`. That file carries its own preamble: it deletes `fetch`, `XMLHttpRequest`, `WebSocket` and `importScripts`, and provides `MCP.readLine()` / `MCP.writeLine()` for stdio.

Third-party JavaScript never runs in an extension Web Worker.

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

The `injected.ts` script (`extension/src/page-api/injected.ts`) is the heart of the Web Agent API. It's injected into every web page and creates the `window.ai` and `window.agent` objects.

### How Injection Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         CONTENT SCRIPT                           │
│                                                                  │
│  1. Create <script> element with injected.ts code               │
│  2. Inject feature flags via <script id="harbor-page-api-flags">│
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
└─────────────────────────────────────────────────────────────────┘
```

### Transport Protocol

Communication between the injected script and content script uses `postMessage` with a dedicated channel:

```javascript
// Injected script → Content script (request)
window.postMessage({
  channel: 'harbor_page_api',
  request: {
    id: 'uuid-here',
    type: 'ai.createTextSession',
    payload: { systemPrompt: 'Be helpful', temperature: 0.7 }
  }
}, '*');

// Content script → Injected script (response)
window.postMessage({
  channel: 'harbor_page_api',
  response: {
    id: 'uuid-here',
    ok: true,
    result: 'session-id-here'
  }
}, '*');

// Streaming events (for promptStreaming, agent.run)
window.postMessage({
  channel: 'harbor_page_api',
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

### Harbor Extension (`extension/src/`)

| Directory/File | Purpose |
|----------------|---------|
| **`page-api/`** | **The Web Agent API: injects and serves `window.ai`, `window.agent` and `navigator.modelContext`** |
| `page-api/injected.ts` | `window.ai` / `window.agent` / `navigator.modelContext` creation, in the page |
| `page-api/content-script.ts` | Content script bridge between the injected script and `background.ts` |
| `page-api/background.ts` | Port listener; derives the page's origin from `port.sender`, wires streaming (`session.promptStreaming`, `agent.run`) |
| `page-api/harbor-core.ts` | The seam: in-process call into `extension-api.ts` and `agents/background-router.ts` — the only file under `page-api/` allowed to import from outside it |
| `page-api/handlers/` | Map-based handler registry (`index.ts`'s `routeMessage()`) for `ai.*`, `agent.*`, `session.*` and tab/browser handlers |
| `page-api/policy/feature-flags.ts` | The feature flags shown in the sidebar's "Browser Agent Capabilities" panel |
| **`handlers/`** | **Modular message handler architecture for Harbor's own background** |
| `handlers/index.ts` | Handler registry initialization |
| `handlers/types.ts` | Shared handler types and utilities |
| `handlers/server-handlers.ts` | MCP server management handlers |
| `handlers/bridge-handlers.ts` | Native bridge status handlers |
| `handlers/llm-handlers.ts` | LLM configuration handlers |
| `handlers/oauth-handlers.ts` | OAuth flow handlers |
| `handlers/permission-handlers.ts` | Permission management handlers |
| `handlers/session-handlers.ts` | Session management handlers |
| `handlers/remote-server-handlers.ts` | Remote MCP server handlers |
| `handlers/page-chat-handlers.ts` | Page chat feature handlers |
| `agents/background-router.ts` | Routes `agent.chat.*`, `agent.mcp.*` and `agents.*` calls to their handlers |
| `agents/handlers/` | Chat, MCP-website and multi-agent handler implementations |
| `agents/types.ts` | TypeScript type definitions |
| `js-runtime/` | JavaScript MCP server sandbox |
| `js-runtime/worker-loader.ts` | Generic Web Worker loader for JS server code |
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
| `background.ts` | Service worker entry point (initializes handlers and the page API) |
| `extension-api.ts` | Harbor's typed internal API for LLM, MCP, session, permissions and system operations; called in-process by `page-api/harbor-core.ts` |
| `sidebar.ts` | Sidebar UI for server management and feature flags |
| `directory.ts` | MCP server directory/catalog UI |

### Rust Bridge (`bridge-rs/src/`)

| Directory/File | Purpose |
|----------------|---------|
| `main.rs` | Entry point, native messaging loop |
| `native_messaging.rs` | Length-prefixed JSON protocol |
| **`rpc/mod.rs`** | **Handler registry pattern** with domain registration |
| `llm/` | LLM provider management |
| `llm/config.rs` | LLM configuration and model aliases |
| `js/` | QuickJS JavaScript runtime |
| `js/runtime.rs` | JS execution environment |
| `js/sandbox.rs` | Capability-based sandboxing |
| `oauth/` | OAuth flow management |
| `mcp/` | MCP tool registry (Safari compatibility) |
| `fs/` | Filesystem utilities |
| `http_server.rs` | HTTP server mode (Safari) |
| `any-llm-rust/` | Multi-provider LLM library (submodule) |

---

## Handler Architecture

Harbor's extension and the Rust bridge use a **handler registry pattern** for message routing. This provides:

- **Modularity** — Each domain (LLM, MCP, permissions, etc.) has its own handler module
- **Testability** — Handlers can be unit tested in isolation
- **Extensibility** — New message types can be added without modifying core routing logic
- **Type Safety** — Shared types ensure consistent request/response formats

### TypeScript Handler Pattern (Extension)

```typescript
// handlers/types.ts - Shared handler infrastructure
export interface RequestContext {
  id: string;
  type: string;
  payload: unknown;
  sender: chrome.runtime.MessageSender;
  origin: string;
  tabId?: number;
}

export type HandlerResponse = Promise<TransportResponse | null>;
export type MessageHandler = (ctx: RequestContext) => HandlerResponse;

// handlers/index.ts - Central registry
const handlers = new Map<string, MessageHandler>();

export function routeMessage(ctx: RequestContext): HandlerResponse {
  const handler = handlers.get(ctx.type);
  if (handler) return handler(ctx);
  return Promise.resolve(errorResponse(ctx.id, 'ERR_INTERNAL', `Unknown: ${ctx.type}`));
}

// handlers/ai-handlers.ts - Domain-specific handlers
handlers.set('create_session', handleCreateSession);
handlers.set('session_prompt', handleSessionPrompt);
handlers.set('get_capabilities', handleGetCapabilities);
```

### Rust Handler Pattern (Bridge)

```rust
// rpc/mod.rs - Handler registry with lazy initialization
pub type RpcHandler = fn(serde_json::Value) 
  -> Pin<Box<dyn Future<Output = Result<serde_json::Value, RpcError>> + Send>>;

static HANDLERS: OnceLock<HashMap<&'static str, RpcHandler>> = OnceLock::new();

fn get_handlers() -> &'static HashMap<&'static str, RpcHandler> {
  HANDLERS.get_or_init(|| {
    let mut handlers = HashMap::new();
    register_llm_handlers(&mut handlers);
    register_fs_handlers(&mut handlers);
    register_oauth_handlers(&mut handlers);
    // ...
    handlers
  })
}

pub async fn handle(request: RpcRequest) -> RpcResponse {
  match get_handlers().get(request.method.as_str()) {
    Some(handler) => {
      match handler(request.params).await {
        Ok(value) => RpcResponse::success(request.id, value),
        Err(error) => RpcResponse::error(request.id, error),
      }
    }
    None => RpcResponse::error(request.id, RpcError::method_not_found(&request.method)),
  }
}
```

### Handler Organization

| Layer | Pattern | Registration |
|-------|---------|--------------|
| **Page API** (`page-api/handlers/`) | Map-based registry | `handlers.set(type, fn)` |
| **Harbor Extension** (`handlers/`) | `registerHandler()` utility | `registerAsyncHandler(type, fn)` |
| **Rust Bridge** | HashMap with lazy init | `handlers.insert(method, fn)` |

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

Permissions are scoped per-origin with capability-based grants. Harbor holds the only grant store and the only consent prompt; Harbor's page API checks it (`permissions.check`, `permissions.request`) before every page call. A site with no tool allowlist may call no tools.

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

Error codes are standardized in `shared/protocol.ts` and used across all layers:

### Connection & Discovery
| Code | Description |
|------|-------------|
| `ERR_HARBOR_NOT_FOUND` | Harbor extension not found or not connected |
| `ERR_BRIDGE_NOT_CONNECTED` | Native bridge not connected |
| `ERR_NOT_INSTALLED` | Extension not installed |

### Request Errors
| Code | Description |
|------|-------------|
| `ERR_TIMEOUT` | Request timed out |
| `ERR_INVALID_REQUEST` | Invalid request format |
| `ERR_NOT_SUPPORTED` | Method not supported (e.g., Safari limitations) |

### Permission Errors
| Code | Description |
|------|-------------|
| `ERR_PERMISSION_DENIED` | Permission denied by user or policy |
| `ERR_SCOPE_REQUIRED` | Required scope not granted |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist |
| `ERR_ORIGIN_DENIED` | Origin not allowed |

### Resource Errors
| Code | Description |
|------|-------------|
| `ERR_NOT_FOUND` | Resource not found |
| `ERR_SESSION_NOT_FOUND` | Session not found |
| `ERR_AGENT_NOT_FOUND` | Agent not found |
| `ERR_SERVER_NOT_FOUND` | Server not found |

### Operation Errors
| Code | Description |
|------|-------------|
| `ERR_TOOL_FAILED` | Tool execution failed |
| `ERR_MODEL_FAILED` | Model/LLM execution failed |
| `ERR_AGENT_NOT_ACCEPTING` | Agent not accepting requests |
| `ERR_BUDGET_EXCEEDED` | Budget exceeded (tool calls, tokens, etc.) |

### Internal Errors
| Code | Description |
|------|-------------|
| `ERR_INTERNAL` | Internal error |

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
