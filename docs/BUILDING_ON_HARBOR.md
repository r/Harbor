# Building On Harbor

**Concrete patterns for the things people are most likely to build on top of the Web Agent API.**

This is the practical companion to [`AGENTIC_BROWSER_ROADMAP.md`](./AGENTIC_BROWSER_ROADMAP.md). The roadmap describes what's missing; this doc tells you how to build the thing today, with what's there.

If you're just looking for the API reference, read [`WEB_AGENTS_API.md`](./WEB_AGENTS_API.md). If you're orienting on the broader pitch, read [`POSITIONING.md`](./POSITIONING.md).

---

## Quick map: what to read for what you're building

| If you're building… | Start with | Then read |
|---|---|---|
| An AI feature inside a single web app | `WEB_AGENTS_API.md` § *window.ai* and § *Tools* | `BUILDING_ON_WEB_AGENTS_API.md` |
| A site-specific assistant ("BYOC") | `WEB_AGENTS_API.md` § *MCP* and § *Chat* | `demo/web-agents/bring-your-chatbot/` |
| An autonomous agent that uses tools | `WEB_AGENTS_API.md` § *Autonomous Agent* and § *Sessions* | `demo/web-agents/chat-poc/` |
| A multi-agent workflow (page-bound, today) | `WEB_AGENTS_API.md` § *Multi-Agent* | `demo/multi-web-agent/research-writer/` |
| A page that can drive itself or a spawned tab | `WEB_AGENTS_API.md` § *Browser APIs* | `demo/web-agent-control/` |
| A background "Hermes-style" assistant | This doc, § *Hermes pattern* | `AGENTIC_BROWSER_ROADMAP.md` Phase C |
| An agentic browser product | This doc, § *Agentic browser pattern* | `AGENTIC_BROWSER_ROADMAP.md` Phase D |
| A non-browser local AI app | This doc, § *Non-browser consumers* | `bridge-rs/` and `bridge-ts/` |

---

## What Harbor gives you, in five lines

1. A **page-facing API** that brokers AI to any website: `window.ai`, `window.agent`, `navigator.modelContext`. The page never sees your keys.
2. A **layered permission system** (see [`PERMISSIONS.md`](./PERMISSIONS.md)) — typed actions, declarative policy rules, information-flow labels, watchdog containment, and an audit log every decision lands in. Per-origin grants and per-tool allowlists still exist; they're now Tier 8 of the engine ladder.
3. A **broker** (the Harbor extension + Rust bridge) that holds your provider configs, hosts MCP servers, and routes calls.
4. **Cross-origin agent communication** via a registry, with orchestration primitives (pipeline, parallel, route).
5. A **trust ladder**: same-tab → spawn-and-control → (proposed) extension-driver. Each tier requires explicit user opt-in.

Everything else is a composition of those primitives.

---

## Pattern 1 — Hermes: an always-on personal assistant

> A persistent agent that watches the user's browsing, reacts to triggers, and surfaces actions in the Harbor sidebar.

### What you can build today (page-bound prototype)

The shortest working sketch: a tab the user keeps open in the background, registered as an agent. Other pages can discover it and invoke it. It can `agent.run()` against MCP tools.

```javascript
// hermes.html — kept open as a pinned tab
await window.agent.requestPermissions({
  scopes: [
    'model:prompt', 'model:tools',
    'mcp:tools.list', 'mcp:tools.call',
    'agents:register', 'agents:invoke', 'agents:message',
    'browser:activeTab.read'
  ],
  reason: 'Hermes needs to act on your behalf'
});

const me = await window.agent.agents.register({
  name: 'Hermes',
  description: 'Personal assistant',
  capabilities: ['research', 'summarize', 'remember'],
  acceptsInvocations: true,
  acceptsMessages: true
});

window.agent.agents.onInvoke(async (req) => {
  // Use a long-lived session for memory
  const session = await window.agent.sessions.create({
    name: `Hermes:${req.task}`,
    capabilities: {
      llm: { provider: 'ollama' },
      tools: ['memory/save', 'memory/search', 'brave-search/search']
    },
    limits: { maxToolCalls: 20, ttlMinutes: 30 }
  });

  let answer = '';
  for await (const ev of window.agent.run({ task: req.task, maxToolCalls: 20 })) {
    if (ev.type === 'final') answer = ev.output;
  }
  await session.terminate();
  return { result: answer };
});
```

Other pages discover and call Hermes:

```javascript
const { agents } = await window.agent.agents.discover({ capabilities: ['research'] });
const hermes = agents.find(a => a.name === 'Hermes');
const { result } = await window.agent.agents.invoke(hermes.id, {
  task: 'What did I look at this morning that mentioned the new chip launch?'
});
```

### What this prototype can't do (and the limits to know about)

- **The Hermes tab must stay open.** Close it, the agent disappears.
- **No system-level wake-on-event.** Hermes can't react to scheduled time, tab navigation, or external triggers.
- **Cross-origin invocation requires the `multiAgent` flag** in Harbor's sidebar.
- **No persistent memory.** The MCP `memory/` server is per-server; Hermes itself has no Harbor-managed long-term store today.

### To build the real Hermes, we need (Phase C of the roadmap):

1. **An extension-side `harbor.backgroundAgents.register()`** API that runs in the Harbor service worker, not a tab.
2. **An event bus**: `onTabUpdated`, `onSchedule`, `onCustomEvent`.
3. **Per-agent persistent memory** with retention policy.
4. **A trust contract UI** in the Harbor sidebar so the user can see what Hermes has done and revoke.

These are real engineering. Build the page-bound prototype today; lift it into the extension when Phase C lands. The page-bound API and the extension-side API will share `agent.sessions` shape, so the prompt/tool/memory code carries over.

---

## Pattern 2 — Agentic browser: a Comet/Atlas-style product on Harbor

> A separate extension (or a privileged page) that drives the user's tabs on their behalf, with the user watching, using whichever model the user has configured in Harbor.

### What you can build today

Two viable shapes, depending on how much trust you want from the user.

#### 2a. A "spawn-and-control" agent browser (works today)

Build a single-page app at `agentbrowser.example`. The page spawns the tabs it needs to drive, controls them, and reports back.

```javascript
// requires browserControl + browserInteraction flags ON
await window.agent.requestPermissions({
  scopes: [
    'model:prompt', 'model:tools',
    'mcp:tools.list', 'mcp:tools.call',
    'browser:tabs.read', 'browser:tabs.create',
    'browser:activeTab.interact', 'browser:activeTab.screenshot',
    'web:fetch'
  ],
  reason: 'Agent browser drives tabs to complete tasks for you'
});

// Spawn the target site as our owned tab
// Open a page on our own origin; tabs on other origins can't be read.
const tab = await window.agent.browser.tabs.create({
  url: `${location.origin}/search`,
  active: true
});
await window.agent.browser.tab.waitForLoad(tab.id);

// Read its DOM. Allowed because we opened it and it's on our own origin;
// a tab we opened on another origin can't be read.
const { html } = await window.agent.browser.tab.getHtml(tab.id, 'main');

// Plan with the user's model
const session = await window.ai.createTextSession({
  systemPrompt: 'You drive web flights search. Output a list of {ref, action, value} steps.'
});
const plan = await session.prompt(`HTML:\n${html}\n\nTask: PDX → SFO Friday after 5pm`);

// Execute the plan in the spawned tab using ref handles from getElements()
// (The agentbrowser app is the active tab when it issues these calls; the
// spawned tab is driven via the spawned-tab APIs.)
session.destroy();
```

This works **right now**, with no Harbor changes. The price: every site you want to drive must be opened by your agent-browser app.

#### 2b. A privileged "active-tab driver" extension (proposed — Phase D)

What you actually want is to drive whatever tab the user is reading, the way Atlas/Comet do. That requires a third trust tier — an extension Harbor explicitly recognizes as the user's designated agent.

The shape we want:

```javascript
// Inside the agent-browser extension's own background script
import { harborDriver } from '@harbor/driver';   // a future package

await harborDriver.requestElevation({
  productName: 'Acme Agent Browser',
  reason: 'Drive any tab while you watch'
});

// While elevated, can act on any tab the user is viewing
const tab = await harborDriver.activeTab.get();
const shot = await harborDriver.activeTab.captureForVision();
const plan = await harborDriver.session.runStep({
  prompt: 'Click the cheapest non-stop after 5pm',
  context: shot
});
```

This is **not built**. The roadmap Phase D describes the missing pieces:

- A new trust tier with an explicit elevation UI in the Harbor sidebar (one-time grant, persistent indicator while active).
- A `harbor.driver.*` extension-to-extension API surface, separate from the page-facing `window.agent.*`.
- A vision-fused `captureForVision()` (Phase B).

If you want to ship an agent browser today, do 2a as the demo, and lobby for Phase D to ship 2b.

### Two things to fix before building either

- **`agent.browser.navigate` / `agent.browser.fetch` handlers**: today these are exposed in `injected.ts` but not all wired in `handlers/index.ts`. Building 2a hits this.
- **Vision-fused capture**: today `screenshot()` and `getElements()` are separate, with no shared coordinate space. For computer-use models this is a nuisance. Phase B fixes it.

---

## Pattern 3 — A site-specific assistant (BYOC, ships today)

This one is *complete*. See `demo/web-agents/bring-your-chatbot/` for the working example.

```javascript
// On shop.example
await window.agent.requestPermissions({
  scopes: ['mcp:servers.register', 'chat:open'],
  reason: 'Connect our shop tools to your assistant'
});

const reg = await window.agent.mcp.register({
  url: 'https://shop.example/mcp',
  name: 'Acme Shop',
  description: 'Search products, manage cart',
  tools: ['search_products', 'add_to_cart']
});

document.getElementById('ask').onclick = () =>
  window.agent.chat.open({
    systemPrompt: 'You help users shop on Acme. Use the tools provided.',
    tools: [`${reg.serverId}/search_products`, `${reg.serverId}/add_to_cart`],
    style: { theme: 'auto', accentColor: '#ff9900' }
  });
```

---

## Pattern 4 — A multi-agent workflow

Multiple specialized agents (research, write, review) that hand off to each other. Today this is **page-bound** — every agent is a tab the user keeps open.

```javascript
// orchestrator.html
await window.agent.requestPermissions({
  scopes: ['agents:invoke', 'agents:discover', 'agents:message']
});

const result = await window.agent.agents.orchestrate.pipeline({
  steps: [
    { agentId: researcherId, task: 'research' },
    { agentId: writerId,     task: 'write'    },
    { agentId: reviewerId,   task: 'review'   }
  ]
}, { topic: 'AI safety in 2026' });

console.log(result.result);
```

Useful demo of the primitives. Not yet a production pattern — see Phase C for what's needed to lift orchestrators into the extension.

---

## Pattern 5 — A non-browser local AI app

> A Node script, a desktop app, a CLI that wants to talk to the user's local LLM through Harbor instead of reimplementing provider/key/tool routing.

### What ships today

`bridge-rs` is a working local broker. It speaks length-prefixed JSON over native messaging to the Harbor extension. It connects to providers, hosts native MCP servers, manages OAuth.

`bridge-ts/` is a TypeScript scaffold that knows the message protocol.

### What's missing

A documented, stable **local socket / WebSocket / HTTP** surface so non-extension clients can connect. Native messaging is browser-extension-only.

### What we want (Phase E)

```js
// future @harbor/client package
import { harbor } from '@harbor/client';

await harbor.pair();   // one-time UI handshake in the Harbor sidebar
const session = await harbor.ai.createTextSession();
const out = await session.prompt('Hello');
```

The shape mirrors the page-facing API where possible, so code ports between contexts.

---

## Composing patterns

Real products mix these. Examples:

- **Hermes + agentic browser**: Hermes is the always-on assistant; when the user asks it to do something that needs to drive a tab, it delegates to the agent-browser extension (Phase D extension-to-extension contract).
- **BYOC + multi-agent**: a shopping site registers an MCP server (BYOC) AND registers as an agent (multi-agent), so a research workflow can ask "did this site have what we wanted?"
- **Site-specific assistant + spawned-tab driver**: an assistant that lives on `bank.example` and, with permission, opens and drives a transfer page on `bank.example/transfer` to complete a multi-step task.

---

## What to push back on if you're building

- **"Just give me cross-origin DOM access."** No. The same-tab and spawn-and-control models are deliberate. The escape hatch is Phase D (designated extension-driver), not loosening the page model.
- **"Just put my keys in Harbor and let my page use them."** Permissions are per-origin. If you want a key only your site uses, the user adds it to Harbor and grants your origin `model:prompt`. The key never leaves the bridge.
- **"Make `agent.run` accept any tool list."** It already does (the `tools` option). The router is a default; pass an explicit list and it's bypassed.
- **"Why can't my page register a background agent?"** Because then any page could install a persistent process on the user's behalf. Background agents are an extension-side concept, with extension-grade trust.

---

## Where to file feedback

If your use case maps to one of these patterns and you're hitting a missing primitive, open an issue with the pattern name and the specific call you wished worked. That's how the roadmap moves.

- [GitHub issues](https://github.com/r/harbor/issues)
- For spec-shaped feedback: see `spec/explainer.md` and `spec/security-privacy.md`.
