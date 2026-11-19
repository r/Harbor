# Agentic Browser Roadmap

**Status**: Living design document
**Author**: Raffi Krikorian
**Last Updated**: May 2026

---

This document is the design conversation about what gets built **on top of** the Web Agent API: full browser agency, multi-agent systems, always-on background agents (Hermes-style), and agentic browsers. It's a roadmap, not a spec. The spec lives in [`spec/explainer.md`](../spec/explainer.md); the implementation reference is [`docs/WEB_AGENTS_API.md`](./WEB_AGENTS_API.md).

If you're trying to build something on top of Harbor today, start with [`BUILDING_ON_HARBOR.md`](./BUILDING_ON_HARBOR.md).

---

## Where we are (May 2026)

The Web Agent API ships as one browser extension (Harbor) plus a Rust bridge. The page-facing surface is more capable than this document used to claim. Most of what early drafts marked "🔮 Planned" already exists — gated behind feature flags so the user can disable whole capability classes globally.

### What ships

| Capability | API | Permission | Feature flag | Status |
|---|---|---|---|---|
| Text generation | `window.ai.createTextSession()` | `model:prompt` | `textGeneration` (ON) | ✅ |
| Multi-provider LLM | `ai.providers.list()`, `getActive()` | `model:list` | — | ✅ |
| MCP tool listing | `agent.tools.list()` | `mcp:tools.list` | `toolAccess` (ON) | ✅ |
| MCP tool call | `agent.tools.call({tool, args})` | `mcp:tools.call` (+ allowlist) | `toolAccess` (ON) | ✅ |
| Page-declared tools (W3C WebMCP) | `navigator.modelContext.addTool()` | — | — | ✅ |
| Autonomous tool-using loop | `agent.run({task})` (typed event stream) | `model:tools` | `toolCalling` (OFF) | ✅ |
| Read active tab | `agent.browser.activeTab.readability()` | `browser:activeTab.read` | — | ✅ |
| Same-tab interaction | `activeTab.click/fill/scroll/select/getElements` | `browser:activeTab.interact` | `browserInteraction` (OFF) | ✅ |
| Same-tab screenshot | `activeTab.screenshot()` | `browser:activeTab.screenshot` | `browserInteraction` (OFF) | ✅ |
| Navigate | `agent.browser.navigate(url)` | `browser:navigate` | `browserControl` (OFF) | ✅ |
| Tab list / spawn / close | `agent.browser.tabs.{list, create, close}` | `browser:tabs.read` / `browser:tabs.create` | `browserControl` (OFF) | ✅ |
| Spawned-tab read (own origin only) | `agent.browser.tab.{readability, getHtml, waitForLoad}` | `browser:tabs.create` | `browserControl` (OFF) | ✅ |
| CORS-bypass fetch | `agent.browser.fetch(url, opts)` | `web:fetch` | `browserControl` (OFF) | ✅ |
| Capability-bounded sessions | `agent.sessions.create({capabilities, limits})` | (per declared capabilities) | — | ✅ |
| Site-provided MCP servers (BYOC) | `agent.mcp.{discover, register, unregister}` | `mcp:servers.register` | — | ✅ |
| Open user's chat with config (BYOC) | `agent.chat.{canOpen, open, close}` | `chat:open`, and `model:prompt` for each message | — | ✅ |
| Multi-agent registration | `agent.agents.{register, discover, list, getInfo, unregister}` | `agents:register` / `agents:discover` | `multiAgent` (OFF) | ✅ |
| Multi-agent invocation + messaging | `agent.agents.{invoke, send, onMessage, onInvoke}` | `agents:invoke` / `agents:message` | `multiAgent` (OFF) | ✅ |
| Multi-agent events | `agent.agents.{subscribe, unsubscribe, broadcast}` | `agents:message` | `multiAgent` (OFF) | ✅ |
| Multi-agent orchestration | `agent.agents.orchestrate.{pipeline, parallel, route}` | `agents:invoke` | `multiAgent` (OFF) | ✅ |

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          WEB PAGE                                │
│  window.ai · window.agent · navigator.modelContext              │
└──────────────────────────────┬──────────────────────────────────┘
                               │ postMessage (CHANNEL: harbor_page_api)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    HARBOR EXTENSION                             │
│  • Implements the page-facing API (extension/src/page-api/)    │
│  • Permission prompts, scope storage                           │
│  • Same-tab + spawned-tab automation                           │
│  • Multi-agent registry (page-bound agents)                    │
│  • LLM provider selection (Ollama, OpenAI, Anthropic, native)  │
│  • MCP server hosting (WASM/JS in-browser, native via bridge)  │
│  • Chat sidebar UI                                             │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Native Messaging (length-prefixed JSON)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                       RUST BRIDGE                                │
│  • Provider connections (Ollama, OpenAI, Anthropic, …)         │
│  • Native MCP servers (subprocess isolation)                   │
│  • OAuth flows                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Real gaps (May 2026)

The four gaps that *actually* block the next class of products:

1. **Persistent (always-on) agent runtime.** Today every `agent.agents` instance is bound to an open page. Close the tab, the agent dies. A "Hermes-style" assistant — one that watches your browsing, runs on a schedule, or reacts to system events — needs an agent host that lives in the Harbor extension's service worker, owns its own LLM session and memory, and exposes a UI surface that isn't a page.
2. **Visual context.** Computer-use models depend on screenshots paired with element bounding boxes / accessibility trees. We have `screenshot()` and `getElements()`; we don't have a unified `captureForVision()` that fuses them.
3. **A non-page consumer surface.** `bridge-rs` is a clean local broker for LLMs and MCP, but there's no public local-socket / WebSocket / HTTP surface that lets a Node program, a CLI, or another extension talk to Harbor without going through a page. `bridge-ts` is the right place; finish it.
4. **Cross-tab privileged automation.** The same-tab and spawned-tab models are correct for untrusted pages. They are wrong for an agent the user has explicitly designated as their *driver*. We need a third trust tier (extension-side automation) so an agentic browser product can drive any tab the user is watching, with the user watching, without forking Harbor.

Items 1 and 4 are the ones that unblock Hermes-style agents and agentic browsers respectively. Items 2 and 3 are accelerants for both.

---

## Five things people are likely to build on top

Use these as concrete design forcing functions. Each one stresses a different part of the surface.

### 1. Hermes — an always-on personal assistant

**Shape.** A persistent agent that runs in the Harbor extension itself (not in a page). It has its own LLM session, its own memory, its own subset of MCP tools. It surfaces in the Harbor sidebar (and optionally a system tray / popover). It can react to scheduled triggers, tab events, and explicit user prompts.

**What today's surface gives you.**
- The Harbor extension already has long-lived LLM connections via `bridge-rs`.
- `agent.sessions.create({capabilities, limits})` is the right *shape* for an agent's permissioned session.
- The `multi-agent/` directory inside the Harbor extension already has registry primitives.
- `agent.chat.open()` lets an agent surface a chat UI back to the user.

**What's missing.**
- A `harbor.background-agent` API on the **extension side** (not page-side) for registering agents that run inside the Harbor service worker.
- An event bus (`onTabUpdated`, `onSchedule`, `onSpoken`, `onCustomEvent`) that an extension-side agent can subscribe to.
- A persistent memory store with retention policy and per-agent ACLs.
- A trust contract UI: "this agent runs continuously and may take these actions on your behalf — review weekly."

**See [`BUILDING_ON_HARBOR.md`](./BUILDING_ON_HARBOR.md) for the concrete prototype path.**

### 2. An agentic browser (computer-use style)

**Shape.** A browser experience built on top of Firefox/Chrome where the address bar and a sidebar are dominated by an agent that drives any tab the user is watching. Atlas/Comet, but with the user's own model.

**What today's surface gives you.**
- `agent.browser.navigate`, `tabs.{create, list, close}`, `tab.{readability, getHtml}` — all there, behind `browserControl`.
- `agent.browser.activeTab.{click, fill, scroll, screenshot, getElements}` — there, behind `browserInteraction`.
- The `agent.run` autonomous loop with MCP tool calling.
- Spawn-and-control trust model: an origin can close the tabs it spawned, and read them only while they show a page on its own origin.

**What's missing.**
- **Cross-tab privileged automation.** Spawn-and-control is the right model for untrusted pages but blocks an agent the user has explicitly elevated. Add a third trust tier: **extension-side automation** with a one-time user grant ("this is my agent browser; let it drive any tab while it's the active extension").
- **Vision-fused capture.** A single `agent.browser.activeTab.captureForVision({format})` that returns a screenshot, a flat element list with bounding boxes and stable refs, and an accessibility-tree snapshot. Today you'd `screenshot()` and `getElements()` and stitch them yourself.
- **Robust selectors.** `getElements()` builds CSS-selector-like strings as `ref`. They survive small DOM changes only sometimes. We need ref handles that map to a deterministic, idempotent locator (XPath + role + accessible-name).
- **Planning loop with checkpoints.** `agent.run` is a single tool-using loop. Agentic browsers want longer plans with explicit `pause / replay / undo` semantics. `agent.sessions` is the right container; expose `session.runStep()` and `session.replay()`.

### 3. A site-specific assistant (BYOC)

**Shape.** Acme.com hosts an MCP server with `search_products`, `add_to_cart`. The site renders a button: "talk to your assistant about this." User clicks, Harbor opens the user's configured chat with Acme's tools loaded.

**What today's surface gives you.** `agent.mcp.register({url, name, tools})` and `agent.chat.open({systemPrompt, tools, style})` ship today. See `demo/web-agents/bring-your-chatbot/` for a working example. Messages sent from the chat are the page's prompts, so they need `model:prompt` and are checked and audited under the page's origin. Remaining work: Harbor's chat doesn't call the site's `tools` yet, sends each message without the earlier ones, and runs on the bridge's default model rather than the person's own agent. Discovery also needs work (the `<link rel="mcp-server">` declarative pattern is plumbed but not widely used).

### 4. A multi-agent research workflow

**Shape.** A research orchestrator page registers as one agent, finds a writer agent on a different origin via `agent.agents.discover`, pipes them together. Each agent has its own LLM, its own tools, its own permissions.

**What today's surface gives you.**
- `agent.agents.{register, discover, list, invoke}` and `agent.agents.orchestrate.{pipeline, parallel, route}`. Behind the `multiAgent` flag.

**What's missing.**
- Agents are page-bound (see Hermes section). To run a real workflow, both pages have to stay open the whole time. Lifting at least the long-running orchestrator side into the extension would solve this.
- Permission inheritance is unspecified: when agent A invokes agent B, whose permissions apply? Today: each agent uses its own origin's grants. Document this; consider a request-time intersection model.

### 5. A local AI broker for non-browser apps

**Shape.** A Node script, a desktop app, a CLI. They want to talk to "the user's local LLM" without each app reimplementing provider selection, key management, and tool routing. Harbor is the natural broker — the Rust bridge already does the work.

**What today's surface gives you.**
- `bridge-rs` exists, runs locally, manages providers and MCP servers, and speaks length-prefixed JSON over native messaging.
- `bridge-ts/` has a TypeScript scaffold for the same.

**What's missing.**
- A documented, stable local socket / WebSocket / HTTP surface for non-browser consumers. Native messaging is browser-extension-only. Adding a localhost WebSocket on the bridge (with a one-time pairing UI in the Harbor sidebar) makes Harbor immediately useful to every local AI tool.
- An npm package (`@harbor/client`) that wraps it.

---

## Phasing the work

A pragmatic order, optimized for unlocking the most ambitious products first.

### Phase A — Polish what ships (now)

The surface is bigger than the docs claim. Close the gap.

- Fix doc drift between `spec/explainer.md`, `docs/LLMS.txt`, and `docs/WEB_AGENTS_API.md` (this PR starts that).
- Reconcile `PermissionScope` definitions across `injected.ts`, `types.ts`, `permission-prompt.ts`, and the spec WebIDL.
- Wire missing handlers (`agent.browser.navigate`, `agent.browser.fetch`) so the documented `browserControl` surface actually works.
- Ship a thin `agent.capabilities()` so consumers can ask the API what's available without trial-and-error.
- Quiet the extension's debug logging on every web page load.

### Phase B — Visual context + selector hardening (next)

Unblock agentic-browser-class consumers without changing the trust model.

- `agent.browser.activeTab.captureForVision()` — single call returning screenshot + element list + accessibility tree.
- Stable ref handles (XPath + role + accessible-name).
- `waitForSelector(ref, {timeout, visible})` — already in the spec; add the implementation.
- `boundingBox(ref)`.

### Phase C — Persistent agent runtime (the Hermes lane)

This is the biggest design and security lift. Don't conflate it with anything else.

- New extension-side surface: `harbor.backgroundAgents.register({name, systemPrompt, tools, schedule, triggers, memory})`.
- An event bus inside the Harbor extension: tab events, schedule, custom events.
- Persistent memory store with retention policy.
- Trust contract UI: an "Agents" tab in the Harbor sidebar that shows what each agent has done and lets the user pause/revoke.
- A small page-side surface (`agent.backgroundAgents.list()` etc.) so pages can ask which background agents the user has, and route requests to them, without being able to register one themselves.

### Phase D — Privileged extension automation (the agentic-browser lane)

- Third trust tier: an "agent browser mode" the user explicitly enables (one-time grant, plus a clear sidebar indicator while it's on).
- A separate API surface (`harbor.driver.*`) that can drive any tab while the mode is active.
- This is best built as a **separate extension** that depends on Harbor, so the regular Harbor extension's security boundary stays narrow.

### Phase E — Non-browser consumers (the SDK lane)

- Local WebSocket on `bridge-rs` with a pairing handshake.
- `@harbor/client` npm package with the same shape as the page-facing API where it makes sense.
- A small "Apps" tab in the Harbor sidebar showing connected non-browser clients, with revoke.

---

## Security model recap (unchanged)

Three trust tiers, two existing and one proposed:

| Tier | Who | What they can drive | Status |
|---|---|---|---|
| Same-tab | Any web page (with permission) | Their own DOM | ✅ Implemented |
| Spawn-and-control | Any web page (with permission) | Tabs they spawned (read only while on their own origin) | ✅ Implemented |
| Extension-driver | A user-elevated agent extension | Any tab while elevated | 🔮 Phase D |

The page-facing security model **does not change** when we add Phases B/C/E. Phase D adds a new tier, behind a one-time user grant and a persistent UI indicator.

---

## Open questions

1. **Permission inheritance across agents.** When agent A on origin X invokes agent B on origin Y: whose permissions apply? Today each origin's grants apply independently. A more conservative model would be the intersection.
2. **Agent costs.** Different agents may use different (paid) providers. Background agents make this material. Surface usage in the sidebar; consider per-agent quotas.
3. **Data retention for background agents.** What does Harbor remember on the user's behalf? With what retention? With what ACL toward other agents?
4. **Where does Hermes live?** Inside Harbor (`extension/src/agents/`) or as a separate extension that depends on Harbor's APIs? Building it as a separate extension is the cleaner path — it forces us to publish a stable extension-to-extension contract, which is how the agentic-browser tier will work too.

---

*This document is a living roadmap. The shipped surface is in [`docs/WEB_AGENTS_API.md`](./WEB_AGENTS_API.md). The standardization track is in [`spec/explainer.md`](../spec/explainer.md).*
