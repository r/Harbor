# Building on the Web Agents API

**Use this document in another project** when you want to build on the Web Agents API. Copy it into your repo (e.g. `docs/` or `.cursor/`) and point your AI assistant at it so it has clear examples, API surface, and capabilities.

The Web Agents API is provided by the **Harbor** ecosystem: two browser extensions inject `window.ai` and `window.agent` into web pages. Your app runs in the browser and calls these APIs; you do **not** need to clone or build Harbor itself. For the full vision and proposal, see the [whitepaper (PDF)](../whitepaper.pdf).

---

## Prerequisites (end users)

- **Harbor Extension** — provides LLM backends, MCP servers, native bridge.
- **Web Agents API Extension** — injects `window.ai` and `window.agent` into pages.

Both must be installed (e.g. load unpacked from Harbor’s `extension/dist-firefox/` and `web-agents-api/dist-firefox/`). Your project is just a normal web app that assumes these globals exist.

---

## What the API can do

| Capability | APIs | Typical use |
|------------|------|-------------|
| **Text generation** | `window.ai.createTextSession()`, `session.prompt()`, `session.promptStreaming()` | Chat, completions, summarization |
| **List/call MCP tools** | `agent.tools.list()`, `agent.tools.call()` | Use tools (e.g. time, search, files) from connected MCP servers |
| **Autonomous agent** | `agent.run({ task })` | Let the model decide when to call tools to complete a task |
| **Sessions** | `agent.sessions.create()`, `session.prompt()`, `session.callTool()` | Bounded sessions with specific tools and limits |
| **Browser: read active tab** | `agent.browser.activeTab.readability()` | Summarize or analyze the current page |
| **Browser: interact** | `agent.browser.activeTab.click()`, `fill()`, `scroll()`, `screenshot()` | Automate the current tab |
| **Browser: tabs & fetch** | `agent.browser.navigate()`, `tabs.list/create/close`, `agent.browser.fetch()` | Multi-tab and CORS-bypass fetch |
| **Multi-agent** | `agent.agents.register()`, `discover()`, `invoke()`, `orchestrate.*` | Register as an agent, discover and call others, pipelines/parallel/route |
| **BYOC (site MCP)** | `agent.mcp.discover()`, `agent.mcp.register()`, `agent.chat.open()` | Let sites declare MCP servers and open a chat UI |

All of the above are gated by **permissions** (user must grant per origin) and some by **feature flags** in the extension (e.g. `toolCalling`, `browserControl`, `multiAgent`).

---

## Quick start (minimal working example)

```html
<!DOCTYPE html>
<html>
<head><title>Web Agents API</title></head>
<body>
  <button id="ask">Ask AI</button>
  <pre id="out"></pre>
  <script>
    document.getElementById('ask').onclick = async () => {
      const out = document.getElementById('out');
      if (!window.ai || !window.agent) {
        out.textContent = 'Web Agents API not available. Install Harbor + Web Agents API extension.';
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

Every origin must request permission. Request once per page/session.

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
const newTab = await window.agent.browser.tabs.create({ url: 'https://example.com', active: false });
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
      // User denied; show fallback or re-request
      break;
    case 'ERR_SCOPE_REQUIRED':
      await window.agent.requestPermissions({ scopes: ['mcp:tools.list'], reason: '...' });
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

**Common codes:** `ERR_FEATURE_DISABLED`, `ERR_PERMISSION_DENIED`, `ERR_SCOPE_REQUIRED`, `ERR_TOOL_NOT_FOUND`, `ERR_TOOL_NOT_ALLOWED`, `ERR_TOOL_FAILED`, `ERR_MODEL_FAILED`, `ERR_SESSION_NOT_FOUND`, `ERR_HARBOR_NOT_FOUND`, `ERR_AGENT_NOT_FOUND`, `ERR_TIMEOUT`, `ERR_INTERNAL`.

---

## Feature flags (extension sidebar)

| Flag | Default | Enables |
|------|---------|--------|
| `textGeneration` | On | `window.ai.*` |
| `toolAccess` | On | `agent.tools.list()`, `agent.tools.call()` |
| `toolCalling` | Off | `agent.run()` |
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

- **HTML:** `<link rel="mcp-server" href="https://site.example/mcp" title="Site" data-tools="tool1,tool2">`
- **Discover:** `agent.mcp.discover()`
- **Register:** `agent.mcp.register({ url, name, tools })`
- **Open chat:** `agent.chat.open({ systemPrompt, tools, style })`
- **Unregister:** `agent.mcp.unregister(serverId)`

---

## Testing your app

To **test** your Web Agents API app (unit tests with mocks, E2E with real extensions):

- **[Testing your Harbor app](TESTING_YOUR_APP.md)** – step-by-step: generate the harness, run unit tests with the mock, run E2E with Playwright and Harbor extensions.
- **Generate the harness** from the Harbor repo:  
  `node scripts/generate-test-harness.mjs /path/to/your/project`  
  This creates a `harbor-test/` folder with mock, Playwright config, example tests, and types.
- **Or point Cursor at Harbor** and ask for help testing your app; the AI can run the generator or copy the harness into your project.
- Full plan: [THIRD_PARTY_TESTING_PLAN.md](./THIRD_PARTY_TESTING_PLAN.md).

---

## Where to get more

- **This guide on the web:** If you're reading this on the published site, the same doc is at e.g. `https://r.github.io/Harbor/docs/BUILDING_ON_WEB_AGENTS_API.md` — share that link so others can build with AI tools.
- **Full API reference and more examples:** [Harbor docs — Web Agents API](https://github.com/r/harbor/blob/main/docs/WEB_AGENTS_API.md) (or same repo path in your clone).
- **Spec and security:** [Web Agent API spec](https://github.com/r/harbor/tree/main/spec) in Harbor repo.
- **Demos:** Harbor `demo/web-agents/` and `spec/examples/` (e.g. basic-chat, agent-with-tools, page-analyzer).
- **AI-oriented short reference:** Harbor `docs/LLMS.txt` — compact reference for AI coding assistants.

---

**Version:** Web Agents API (Harbor) v1.x. This guide is intended to be copied into projects that build on the API; for the canonical source see the Harbor repository.
