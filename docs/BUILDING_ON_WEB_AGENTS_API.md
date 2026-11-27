# Building on the Web Agent API

**Use this document in another project** when you want to build on the Web Agent API. Copy it into your repo (e.g. `docs/` or `.cursor/`) and point your AI assistant at it so it has clear examples, API surface, and capabilities.

The Web Agent API is provided by **Harbor**: a single browser extension that injects `window.ai`, `window.agent`, and `document.modelContext` into web pages. Your app runs in the browser and calls these APIs; you do **not** need to clone or build Harbor itself. For the full vision and proposal, see the [whitepaper (PDF)](../whitepaper.pdf).

**The core idea: you choose everything.** Choose the LLM (Ollama, llamafile, OpenAI, Anthropic — whatever the user has configured). Choose the MCP servers (Brave Search, GitHub, filesystem, or your own). Choose the integration style (manual tool calls, autonomous agents, or page-registered tools). The API gives you building blocks, not opinions.

**Standards-aligned.** Harbor implements `document.modelContext` from the [W3C WebMCP proposal](https://github.com/webmachinelearning/webmcp) — the emerging standard (incubating at the W3C Web Machine Learning CG, published by engineers at Google and Microsoft) for pages to register client-side JavaScript tools that AI agents can call. Same API shape the standards track is converging on, available today.

---

## Prerequisites (end users)

- **Harbor Extension** — provides LLM backends, MCP servers, native bridge, and injects `window.ai` and `window.agent` into pages.

Must be installed (e.g. load unpacked from Harbor’s `extension/dist-firefox/`). Your project is just a normal web app that assumes these globals exist.

---

## What the API can do

| Capability | APIs | You choose... |
|------------|------|---------------|
| **Text generation** | `window.ai.createTextSession()`, `session.prompt()`, `session.promptStreaming()` | The LLM provider and model, or use the user's default |
| **List/call MCP tools** | `agent.tools.list()`, `agent.tools.call()` | Which MCP servers and tools to integrate (search, files, your own) |
| **Page tools** | `document.modelContext.registerTool()` | What JS functions your page exposes as tools to the AI |
| **Autonomous agent** | `agent.run({ task })` | Whether the LLM drives tool calls, or you call tools manually |
| **Sessions** | `agent.sessions.create()`, `session.prompt()`, `session.callTool()` | Scoped sessions with specific tools, limits, and providers |
| **Browser: read active tab** | `agent.browser.activeTab.readability()` | How to analyze the current page |
| **Browser: interact** | `agent.browser.activeTab.click()`, `fill()`, `scroll()`, `screenshot()` | How the AI interacts with the page |
| **Browser: tabs & fetch** | `agent.browser.navigate()`, `tabs.list/create/close`, `agent.browser.fetch()` | Multi-tab workflows and CORS-bypass fetch |
| **Multi-agent** | `agent.agents.register()`, `discover()`, `invoke()`, `orchestrate.*` | Agent topology: pipelines, parallel, routing |
| **BYOC (site MCP)** | `agent.mcp.discover()`, `agent.mcp.register()`, `agent.chat.open()` | How your site provides tools to the user's AI |

All of the above are gated by **permissions** (user must grant per origin) and some by **feature flags** in the extension (e.g. `toolCalling`, `browserControl`, `multiAgent`).

---

## Quick start (minimal working example)

```html
<!DOCTYPE html>
<html>
<head><title>Web Agent API</title></head>
<body>
  <button id="ask">Ask AI</button>
  <pre id="out"></pre>
  <script>
    document.getElementById('ask').onclick = async () => {
      const out = document.getElementById('out');
      if (!window.ai || !window.agent) {
        out.textContent = 'Web Agent API not available. Install the Harbor extension.';
        return;
      }

      const { granted } = await window.agent.requestPermissions({
        scopes: ['model:prompt'],
        reason: 'To answer your question'
      });
      if (!granted) {
        out.textContent = 'Permission denied';
        return;
      }

      const session = await window.ai.createTextSession();
      try {
        const response = await session.prompt('What is 2 + 2?');
        out.textContent = response;
      } finally {
        session.destroy();
      }
    };
  </script>
</body>
</html>
```

---

## Detection and feature flags

```javascript
// Check availability
if (!window.ai || !window.agent) {
  console.log('Web Agents API not available');
  return;
}

// Optional: wait for ready event
window.addEventListener('agent-ready', (e) => {
  console.log('Version:', e.detail.version);
  console.log('Features:', e.detail.features);
  // e.detail.features: { textGeneration, toolAccess, toolCalling, browserInteraction, browserControl, multiAgent }
});

// Before using agent.run(), ensure toolCalling is enabled
// Before using browser APIs, ensure browserInteraction / browserControl are enabled
```

---

## Permissions (required before use)

Every origin must declare what it intends to do before any tool, model,
or browser API is reachable. There are two ways to do this — pick the
one that fits your codebase.

### Recommended: `agent.requestCapabilities()` (typed actions)

`requestCapabilities` creates a session for the typed actions you ask
for, in the same vocabulary the policy engine uses
internally, with a per-session budget. See
[`docs/PERMISSIONS.md`](./PERMISSIONS.md) for the full design.

```javascript
const session = await window.agent.requestCapabilities({
  name: 'Article assistant',
  reason: 'Read the page and propose follow-ups.',
  require: [
    { action: 'model.prompt.local' },
    { action: 'browser.read.activeTab' },
    { action: 'tool.call', server: 'time-wasm', toolNames: ['time.now'] },
  ],
  optional: [
    { action: 'browser.write.interact' },
  ],
  budget: { maxToolCalls: 30, ttlMinutes: 15 },
});

await session.callTool('time-wasm/time.now', {});
if (session.capabilities.browser.interact) {
  // The site holds the grant to click and fill on the page.
}
```

Need more later — e.g. write access once the user clicks "Run"? Ask
for it with `agent.requestPermissions()`, which shows the prompt, then
call `agent.requestCapabilities()` again for a new session.
`requestCapabilities()` doesn't ask for grants itself. A required capability the site hasn't been granted fails the request with `ERR_PERMISSION_DENIED`; an optional one is left out of the session, so check `session.capabilities` before using it.

### Legacy: `agent.requestPermissions()` (origin-level scopes)

Still supported and internally mapped to typed actions. Use this if
you only need a single origin-level grant and don't need
session budgets.

```javascript
const result = await window.agent.requestPermissions({
  scopes: [
    'model:prompt',       // text generation
    'model:tools',        // agent.run()
    'mcp:tools.list',     // agent.tools.list()
    'mcp:tools.call',     // agent.tools.call()
    'browser:activeTab.read',
    'browser:activeTab.interact',
    'browser:tabs.read',
    'browser:tabs.create',
    'web:fetch'
  ],
  reason: 'To power AI features on this page',
  tools: ['time-wasm/time.now', 'web-search/search']  // optional allowlist
});

if (!result.granted) {
  // result.scopes has per-scope status: 'granted-always' | 'granted-once' | 'denied' | 'not-granted'
  return;
}
```

**Check current permissions:** `const status = await window.agent.permissions.list();`

---

## window.ai — text generation

```javascript
// Create session (optionally with provider/model/systemPrompt/temperature)
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
  provider: 'ollama',
  model: 'llama3.2'
});

// Single prompt (conversation context kept)
const reply = await session.prompt('Hello!');
const followUp = await session.prompt('Tell me more.');

// Streaming
for await (const event of session.promptStreaming('Write a short poem')) {
  if (event.type === 'token') process.stdout.write(event.token);
  if (event.type === 'done') break;
  if (event.type === 'error') throw new Error(event.error?.message);
}

// Always destroy when done
session.destroy();
```

**Availability:** `const availability = await window.ai.canCreateTextSession();` — `'readily' | 'after-download' | 'no'`  
**Providers:** `const providers = await window.ai.providers.list();`  
**Active:** `const { provider, model } = await window.ai.providers.getActive();`

---

## window.agent — tools

```javascript
// List tools
const tools = await window.agent.tools.list();
// [{ name: 'serverId/toolName', description, inputSchema, serverId }, ...]

// Call a tool
const result = await window.agent.tools.call({
  tool: 'time-wasm/time.now',
  args: { timezone: 'America/New_York' }
});
```

---

## document.modelContext — page tools (WebMCP)

Register your own JavaScript functions as tools the AI can call. This implements `registerTool()` from the [W3C WebMCP draft](https://webmachinelearning.github.io/webmcp/). The draft puts `modelContext` on `document`. `navigator.modelContext` is the same object, kept as Harbor's older name; `addTool`/`removeTool` are older aliases of `registerTool` and of aborting its signal. Both keep working.

```javascript
// Register a page tool. It runs in page context, so no server is needed.
const registration = new AbortController();
await document.modelContext.registerTool({
  name: 'search_products',
  description: 'Search the product catalog by query',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results' }
    },
    required: ['query']
  },
  execute: async ({ query, limit = 10 }) => {
    return await searchCatalog(query, limit);
  },
}, { signal: registration.signal });

// Page tools appear in agent.tools.list() with serverId: 'page'
const tools = await window.agent.tools.list();
// → [...mcpTools, { name: 'page/search_products', serverId: 'page', ... }]

// Call a page tool yourself. It runs here, in the page.
const results = await window.agent.tools.call({
  tool: 'page/search_products',
  args: { query: 'red shoes', limit: 5 },
});

// Unregister when no longer needed
registration.abort();
```

To support browsers both with and without a native implementation, feature-detect: `const mc = document.modelContext ?? navigator.modelContext;`. Harbor adds the API shortly after the page starts, so a script that checks once at load can miss it: if `mc` is missing, register on the `agent-ready` event instead (`window.addEventListener('agent-ready', register, { once: true })`).

Page tools run in your page's JavaScript context, with no network or MCP server needed. The person's agent can call them too, during the `agent.run()` or `agent.chat.open()` your page starts. In `agent.run()`, Harbor's built-in agent sees them as `page:<host>/<tool>`. The person's own ACP agent (goose, Claude Code, Codex) gets them in both, as an MCP server named `page:<host>`. Page chat on Harbor's built-in model has no tools, so a page chat reaches your tools only when the person has chosen their own agent. Only the name, description and input schema leave the page, plus a `title`, `outputSchema` and `annotations` if you set them. Annotations such as `readOnlyHint` help the person's agent decide how to treat a tool; Harbor's own checks don't rely on them. They need no permission beyond the one that starts the run or chat. They last as long as the document: a reload drops them, and a hash or `pushState` change doesn't. Treat what your tools return as something an agent will read: return data, not instructions. The person's agent can also reach your page from outside the browser: if they open your page through their agent, or share the tab with it, the agent can list and call the same tools. So a page needs no "Ask" button of its own. Register your tools, and the person's agent can use them. See [WEB_AGENTS_API.md](WEB_AGENTS_API.md#page-tools-and-the-persons-agent).

---

## window.agent — autonomous agent (agent.run)

The model can call tools to complete a task. Requires `toolCalling` feature flag and `model:tools` + tool scopes.

```javascript
for await (const event of window.agent.run({
  task: 'What is the current time in Tokyo?',
  maxToolCalls: 5,
  tools: ['time-wasm/*'],   // optional filter
  useAllTools: false,       // true = disable smart tool routing
  provider: 'openai',
  systemPrompt: 'You are a helpful assistant.'
})) {
  switch (event.type) {
    case 'thinking':     console.log('[Thinking]', event.content); break;
    case 'tool_call':    console.log('[Tool]', event.tool, event.args); break;
    case 'tool_result':  console.log('[Result]', event.tool, event.result); break;
    case 'token':        process.stdout.write(event.token); break;
    case 'final':        console.log('[Answer]', event.output); break;
    case 'error':        throw new Error(event.error?.message);
  }
}
```

---

## window.agent — sessions (bounded capabilities)

Create a session with specific tools and limits; good for “research assistant” or “support agent” flows.

```javascript
const session = await window.agent.sessions.create({
  name: 'Research Assistant',
  reason: 'To help research this topic',
  capabilities: {
    llm: { provider: 'ollama', model: 'llama3.2' },
    tools: ['web-search/search', 'memory/save'],
    browser: ['read', 'screenshot']
  },
  limits: { maxToolCalls: 20, ttlMinutes: 30 },
  options: { systemPrompt: 'You are a research assistant.', temperature: 0.3 }
});

const response = await session.prompt('Find recent AI news');
const toolResult = await session.callTool('web-search/search', { query: 'AI safety' });

for await (const token of session.promptStreaming('Summarize findings')) {
  process.stdout.write(token);
}

await session.terminate();
```

---

## window.agent — browser APIs

**Read active tab** (requires `browserInteraction` and `browser:activeTab.read`):

```javascript
const { url, title, text } = await window.agent.browser.activeTab.readability();
```

**Interact with active tab** (requires `browser:activeTab.interact`):

```javascript
const elements = await window.agent.browser.activeTab.getElements();
await window.agent.browser.activeTab.click('ref-123');
await window.agent.browser.activeTab.fill('ref-456', 'Hello');
await window.agent.browser.activeTab.select('ref-789', 'option-value');
await window.agent.browser.activeTab.scroll('down', 500);
const { dataUrl } = await window.agent.browser.activeTab.screenshot();
```

**Navigate and tabs** (requires `browserControl` and tabs/fetch scopes):

```javascript
await window.agent.browser.navigate('https://example.com');
const tabs = await window.agent.browser.tabs.list();
// Tabs you open are readable only while they show your own origin's pages.
const newTab = await window.agent.browser.tabs.create({ url: `${location.origin}/report`, active: false });
await window.agent.browser.tab.waitForLoad(newTab.id);
const { html } = await window.agent.browser.tab.getHtml(newTab.id, 'main');
await window.agent.browser.tabs.close(newTab.id);
const response = await window.agent.browser.fetch('https://api.example.com/data');
```

---

## Example: chat UI with streaming

```javascript
let session = null;

async function ensureSession() {
  if (!session) {
    const { granted } = await window.agent.requestPermissions({
      scopes: ['model:prompt'],
      reason: 'Chat'
    });
    if (!granted) throw new Error('Permission denied');
    session = await window.ai.createTextSession({ systemPrompt: 'You are helpful.' });
  }
  return session;
}

async function sendMessage(userText, onToken) {
  const s = await ensureSession();
  if (!onToken) {
    return await s.prompt(userText);
  }
  let full = '';
  for await (const e of s.promptStreaming(userText)) {
    if (e.type === 'token') {
      full += e.token;
      onToken(e.token);
    }
  }
  return full;
}

// When leaving the app or closing chat, call session.destroy()
```

---

## Example: page summarizer

```javascript
async function summarizeCurrentPage() {
  const { granted } = await window.agent.requestPermissions({
    scopes: ['model:prompt', 'browser:activeTab.read'],
    reason: 'Summarize this page'
  });
  if (!granted) throw new Error('Permission denied');

  const { title, text } = await window.agent.browser.activeTab.readability();
  const session = await window.ai.createTextSession({
    systemPrompt: 'Summarize in 2–3 sentences.'
  });
  try {
    return await session.prompt(text.slice(0, 10000));
  } finally {
    session.destroy();
  }
}
```

---

## Example: agent task with tool calls

```javascript
async function runTask(taskDescription) {
  const { granted } = await window.agent.requestPermissions({
    scopes: ['model:tools', 'mcp:tools.list', 'mcp:tools.call'],
    reason: 'Run AI task with tools'
  });
  if (!granted) throw new Error('Permission denied');

  let finalOutput = null;
  for await (const event of window.agent.run({
    task: taskDescription,
    maxToolCalls: 5
  })) {
    if (event.type === 'final') finalOutput = event.output;
    if (event.type === 'error') throw new Error(event.error?.message);
  }
  return finalOutput;
}
```

---

## Error handling

APIs throw errors with a `code` property. Handle the main cases:

```javascript
try {
  await window.agent.tools.list();
} catch (err) {
  switch (err.code) {
    case 'ERR_FEATURE_DISABLED':
      // User must enable the feature in the extension
      break;
    case 'ERR_PERMISSION_DENIED':
      // User denied, or a required scope was missing and they declined; show fallback or re-request
      break;
    case 'ERR_TOOL_NOT_FOUND':
    case 'ERR_TOOL_NOT_ALLOWED':
      // Tool missing or not in allowlist
      break;
    case 'ERR_HARBOR_NOT_FOUND':
      // Harbor extension not installed
      break;
    case 'ERR_TIMEOUT':
      // Request timed out
      break;
    default:
      console.error(err.code, err.message);
  }
}
```

**Common codes:** `ERR_FEATURE_DISABLED`, `ERR_PERMISSION_DENIED`, `ERR_BLOCKED_BY_POLICY`, `ERR_QUARANTINED`, `ERR_TOOL_NOT_FOUND`, `ERR_TOOL_NOT_ALLOWED`, `ERR_TOOL_FAILED`, `ERR_MODEL_FAILED`, `ERR_SESSION_NOT_FOUND`, `ERR_BUDGET_EXCEEDED`, `ERR_HARBOR_NOT_FOUND`, `ERR_AGENT_NOT_FOUND`, `ERR_TIMEOUT`, `ERR_INTERNAL`. See [WEB_AGENTS_API.md#error-handling](WEB_AGENTS_API.md#error-handling) for the full list.

---

## Feature flags (extension sidebar)

| Flag | Default | Enables |
|------|---------|--------|
| `textGeneration` | On | `window.ai.*` |
| `toolAccess` | On | `agent.tools.list()`, `agent.tools.call()` |
| `toolCalling` | On | `agent.run()` |
| `browserInteraction` | Off | `agent.browser.activeTab.*` (click, fill, scroll, screenshot) |
| `browserControl` | Off | `agent.browser.navigate()`, `tabs.*`, `fetch()` |
| `multiAgent` | Off | `agent.agents.*` |

If a feature is off, its APIs throw `ERR_FEATURE_DISABLED`.

---

## Multi-agent (high level)

Requires `multiAgent` flag and `agents:register` / `agents:invoke` (or similar) scopes.

- **Register:** `agent.agents.register({ name, capabilities, acceptsInvocations, acceptsMessages })`
- **Handle invocations:** `agent.agents.onInvoke(async (req) => { ... })`
- **Discover:** `agent.agents.discover({ capabilities, tags })`
- **Invoke:** `agent.agents.invoke(agentId, { task, input, timeout })`
- **Orchestration:** `agent.agents.orchestrate.pipeline()`, `.parallel()`, `.route()`

---

## BYOC (Bring Your Own Chatbot)

Sites can declare an MCP server and open a chat that uses the user’s model plus site tools.

- **HTML:** `<link rel="mcp-server" href="https://site.example/mcp" title="Site" data-tools="tool1,tool2">` (`rel="mcp"` works too; add `data-transport="sse"` or `"websocket"` if the server doesn't speak streamable HTTP)
- **Discover:** `agent.mcp.discover()`
- **Register:** `agent.mcp.register({ url, name, tools })`
- **Open chat:** `agent.chat.open({ systemPrompt, tools, style })`
- **Unregister:** `agent.mcp.unregister(serverId)`

Your server's tools reach the person's agent the same way your page's tools do: no `mcp:tools.*` permission to ask for, a policy check on every call, and Harbor makes the calls itself, so the person's agent never gets your server's URL.

---

## Testing your app

To **test** your Web Agent API app (unit tests with mocks, E2E with the real extension):

- **[Testing your Harbor app](TESTING_YOUR_APP.md)** – step-by-step: generate the harness, run unit tests with the mock, run E2E with Playwright and the Harbor extension.
- **Generate the harness** from the Harbor repo:  
  `node scripts/generate-test-harness.mjs /path/to/your/project`  
  This creates a `harbor-test/` folder with mock, Playwright config, example tests, and types.
- **Or point Cursor at Harbor** and ask for help testing your app; the AI can run the generator or copy the harness into your project.
- Full plan: [THIRD_PARTY_TESTING_PLAN.md](./THIRD_PARTY_TESTING_PLAN.md).

---

## Where to get more

- **This guide on the web:** If you're reading this on the published site, the same doc is at e.g. `https://r.github.io/Harbor/docs/BUILDING_ON_WEB_AGENTS_API.md` — share that link so others can build with AI tools.
- **Full API reference and more examples:** [Harbor docs — Web Agent API](https://github.com/r/harbor/blob/main/docs/WEB_AGENTS_API.md) (or same repo path in your clone).
- **Spec and security:** [Web Agent API spec](https://github.com/r/harbor/tree/main/spec) in Harbor repo.
- **Demos:** Harbor `demo/web-agents/` and `spec/examples/` (e.g. basic-chat, agent-with-tools, page-analyzer).
- **AI-oriented short reference:** Harbor `docs/LLMS.txt` — compact reference for AI coding assistants.

---

**Version:** Web Agent API (Harbor) v1.x. This guide is intended to be copied into projects that build on the API; for the canonical source see the Harbor repository.
