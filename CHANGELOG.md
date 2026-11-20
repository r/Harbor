# Changelog

All notable changes to Harbor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Public site redesign** — implemented the design produced in Claude Design. The site is now hand-written static HTML (`whitepaper/index.html`, `whitepaper/landscape.html`, `whitepaper/spec.html`, `whitepaper/build.html`, `whitepaper/styles.css`) with a Fraunces / Instrument Serif + Inter + JetBrains Mono type system, a single rust-clay accent, and a compare-and-contrast comparison table that re-stacks into cards on phones.
- **Internal positioning doc** at `docs/POSITIONING.md` captures the May 2026 landscape, the differentiation table, talking points by audience, and a source list. Source of truth for messaging.
- **Design paper trail** preserved in `whitepaper/DESIGN_NOTES.md`, `whitepaper/CLAUDE_DESIGN_PROMPT.md`, and `whitepaper/design-bundle/`.
- **`whitepaper/README.md`** documents the new site structure.

### Changed

- A page's browser and tab calls (clicking, filling and reading the page, screenshots, `navigate`, `fetch`, and opening, listing and closing tabs) now go through Harbor's policy engine after the site's grant check, like its model and tool calls. They appear in the sidebar's Activity panel, a policy rule can deny them or ask first, and the watchdog's restrictions apply. With no rule, there's no new prompt. Destination hosts are recorded and can be matched by rules, but aren't classified as sensitive, so opening or fetching a bank or document site isn't refused. A page's own `fetch` doesn't count toward the watchdog's cross-origin limit, and a `fetch` redirected to another origin is checked again at its final URL.
- The test harness for third-party apps (`spec/testing/`) mocks the multi-agent API: `agent.agents.register`, `discover`, `invoke`, `send` and their handlers, with the agent scopes and real TypeScript types, plus an example multi-agent test. Its `requestPermissions()` now grants only the scopes it names, as Harbor does, and `grantAll()` means the user allows each request rather than granting every scope up front.
- Harbor's icon is now the lighthouse from the site's favicon, in the toolbar, the add-ons page and Harbor's own UI (sidebar, permission prompt, directory, in-page chat), replacing the "H". `npm run favicon` in `extension/` rebuilds `whitepaper/favicon.ico` from `extension/assets/icon.svg`.
- Harbor is now a single browser extension: it injects and serves `window.ai`, `window.agent` and `navigator.modelContext` itself (`extension/src/page-api/`). The separate Web Agents API extension is retired.
- Site, `README.md` and `spec/README.md` follow the updated positioning: homepage example 02 shows the airline's page handing the trip to your agent, which asks before holding a seat; the spec page says Harbor implements the Web Agent API; both READMEs mention agent-to-company protocols; browser-control APIs are described as a stopgap.
- `docs/POSITIONING.md` — describes Harbor as an implementation of the Web Agent API: an API for how a web surface and the person's agent talk, wherever the surface is rendered, with browser control as a stopgap. Adds agent-to-company protocols (remote MCP, A2A, Personal Agent Protocol, UCP, Web Bot Auth) as a fifth camp, a standards row, talking points for agent builders, and sources. "Not an agent" now explains what "your agent" means.
- The public homepage introduces Harbor as a way to bring your own agent to the web, illustrates it with an archive search, directs readers to the Page Summarizer demo and Firefox setup, and links to the landscape essay for the full comparison.

- `README.md` — "Why This Exists" rewritten to reference the May 2026 landscape (Atlas, Comet, Gemini in Chrome, Brave Leo, Firefox AI Window, WebMCP, Chrome Prompt API) and to clarify Harbor's lane.
- `spec/README.md` — "The Problem" extended with a fourth bad option ("just use the user's AI browser") and a paragraph framing the gap left by WebMCP and the Chrome Prompt API.
- Contributors and agents now fix small flaws they notice in the same PR, rather than leaving them for a separate one. Each fix is listed under an **Also fixed** heading in the PR description and, if users would notice it, gets its own changelog entry. Larger changes still get their own issue. See `CONTRIBUTING.md` and `docs/agent-workflow.md`.
- `AGENTS.md` — `whitepaper/` description updated to reflect the static-HTML structure and `docs/POSITIONING.md` flagged as the messaging source-of-truth.

### Fixed

- When a page stops reading a `promptStreaming()` partway through (it breaks out of its loop, aborts, or its tab closes), Harbor now stops the model instead of letting it generate the rest of the response. This needs the updated native bridge, which adds an `llm.cancel_stream` request.
- If Harbor asks before a page's call (because of a policy rule or the watchdog) and the person allows it after the page has given up waiting, the call is no longer performed. Before, a late Allow still ran it: a browser action, a model prompt, a tool call, a new session, an agent registration or invocation, or opening the chat could happen after the page had already seen `ERR_TIMEOUT` and possibly retried.
- `agent.browser.activeTab.readability()` now resolves to `{ url, title, text }`, as the spec says. Before, it returned `content` and `length`, so `text` was undefined, and its TypeScript types promised `textContent`, `excerpt`, `byline` and `siteName`, which never existed. `agent.browser.tab.readability(tabId)` returns the same shape and no longer includes `content`, `html` or `length`; use `tab.getHtml()` for markup. Both calls, and Harbor's browser capture for MCP servers, now read pages with one extractor, which keeps line breaks in the text.
- Parallel `session.callTool()` calls near the end of a session's `maxToolCalls` no longer each prompt for the last slot. A call now holds a budget slot while Harbor's policy engine checks it, gives it back if the engine refuses the call, and is refused without a prompt when every slot is used or held.
- A session's `maxToolCalls` budget is no longer spent on `session.callTool()` calls that Harbor's policy engine refuses, such as a call a deny rule blocks or one whose prompt the person declines. Harbor counts a call only once its policy check allows it. A call made after the budget is spent is refused without a prompt.
- A page call refused by Harbor's policy engine now fails with the engine's code, as `docs/PERMISSIONS.md` describes: `ERR_QUARANTINED` for a quarantined origin, `ERR_BLOCKED_BY_POLICY` for a deny rule, `ERR_PERMISSION_DENIED` for a declined prompt. This covers `agent.tools.call()`, a text session's `prompt()` and `promptStreaming()`, and `agent.run()`; prompts answered by an ACP agent don't pass through the policy engine and keep the ACP codes. Before, they reached the page as `ERR_TOOL_FAILED`, `ERR_MODEL_FAILED` or `ERR_AGENT_FAILED`. The error-code tables in the API docs and the explainer now list these codes. The bring-your-chatbot demo shows its own message for each of them.
- Harbor no longer writes what a page sends to the browser console: prompts, system prompts, `agent.run` tasks, tasks passed between agents, URLs a page opens or registers, a page's reason for a permission request, and model replies. Logs keep the request type, IDs, origin and sizes. The debug listener that logged every message reaching Harbor's background is gone.
- `agent.requestPermissions()` asks for exactly the scopes the page names. A request for `model:prompt`, `mcp:tools.call` or `browser:tabs.create` no longer also asks for `agents:register` and `agents:invoke`. Pages that register or invoke agents must request those scopes themselves; if they don't, Harbor asks when they call the agent API.
- A site that has been granted `agents:invoke` or `agents:message` is no longer asked again on every `agent.agents.invoke()` or message call. The grant now covers later calls. Calling another agent on this device changes nothing by itself, and that agent's own actions are still checked.
- An "Allow once" grant now covers only the tab where it was given, in Harbor's policy checks as well as in the page API. Before, another tab on the same site could use it, for example to register an agent.
- `agent.agents.orchestrate.pipeline()` and `orchestrate.route()` work from a page. Before, both always failed after the permission check, because Harbor expected a different payload than the page API sends. A pipeline now returns its last step's output as `result`, and a route returns the chosen agent's response (`success`, `result`, `error`) with `selectedAgentId` alongside.
- When Harbor refuses a page's `agent.chat.open()`, the page now gets the policy engine's code (`ERR_BLOCKED_BY_POLICY`, `ERR_PERMISSION_DENIED`, `ERR_QUARANTINED`) instead of `ERR_CHAT_OPEN`, so it can tell a refusal from a failure. `agent.mcp.register()` and `unregister()` report their refusal of another origin's server as `ERR_PERMISSION_DENIED` instead of `ERR_MCP_REGISTER` / `ERR_MCP_UNREGISTER`. Other failures keep their codes.
- `window.ai.providers.getActive()` now needs the site's `model:list` grant, as the spec says, like the other `window.ai.providers` calls. Before, any page could read which model the person uses. All four `window.ai.providers` calls now go through Harbor's policy engine: they appear in the Activity panel, and a policy rule can deny them.
- A page's prompt to an LM Studio or llamafile model, or to a provider instance the person named (such as `my-ollama:llama3`), is now checked and audited as a local prompt, since it runs on this machine. Before, Harbor judged by the model's name and logged these as remote, so rules written for local models didn't match them. The native bridge decides, through a new `llm.model_locality` request; with an older bridge, Harbor still judges by the name.

### Removed

- The sidebar's **Open Chat** button and the chat page bundled inside the extension. That page ran its own copy of `window.agent` with every permission treated as granted, so it skipped the permission checks and loop fixes that web pages get. To chat with tools, use the demo-site chat (`demo/web-agents/chat-poc/`), which goes through the same `agent.run` as any site. The extension also no longer exposes `demo/*` or `demo-bootstrap.js` to web pages.
- The old Jekyll scaffolding under `whitepaper/` (`_config.yml`, `_layouts/`, `Gemfile`, `index.md`, `landscape.md`) — replaced by static HTML. `.nojekyll` added so GitHub Pages serves the files as authored.

## [0.1.0] - 2026-02-04

### Added

- Initial open source release
- **Harbor Extension**: Core infrastructure for browser-based AI
  - LLM provider connections (Ollama, OpenAI, Anthropic)
  - MCP server hosting (JavaScript and WASM)
  - Native messaging bridge (Rust)
  - Chat sidebar UI
  - OAuth flow support
- **Web Agents API Extension**: Page-facing AI capabilities
  - `window.ai` API for text generation
  - `window.agent` API for tools, browser control, and autonomous agents
  - Permission system with user consent prompts
  - Feature flags for advanced capabilities
- **Native Bridge** (Rust): Connects browser to local LLMs and services
- **MCP Server Support**: Host Model Context Protocol servers in the browser
  - JavaScript runtime for MCP servers
  - WASM runtime for compiled MCP servers
  - Built-in echo and time servers
  - Gmail example with OAuth
- **Browser Support**: Firefox (primary), Chrome, Safari (experimental)
- **Documentation**: Comprehensive guides for users and developers
- **Demo Pages**: Interactive examples showcasing the APIs

### Known Limitations

- Streaming abort not fully implemented
- Address bar LLM parsing is placeholder
- Permission granularity is basic (origin-level)
- Safari support is experimental
- Function calling uses response parsing (proper tool calling planned)

[0.1.0]: https://github.com/r/harbor/releases/tag/v0.1.0
