# Changelog

All notable changes to Harbor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/POSITIONING.md` says how Harbor sounds: the trusted captain of a dolphin-spotting tour. Calm, plain about safety, "your agent" by name, and consent text without metaphor.
- **Bring your own agent.** The sidebar's new **Agent** panel lets sites run on an agent you already use instead of Harbor's built-in model. Presets for goose, Claude Code and Codex fill in how to start each one, finding the command through your login shell so agents installed with nvm or Homebrew work when Firefox starts from the Dock; you can also add any agent by its command. **Check** starts the agent and says whether it's ready or what's wrong. A preset sets no approval mode or environment: Harbor starts agents without your shell environment, and each preset links to its agent's settings docs for giving its tools their keys. With an agent selected, everything a site asks of a model goes to it: `window.ai` text sessions, `agent.run`, `agent.sessions` prompts and a site's own chat (`agent.chat.open`, as in the [Bring Your Own Chatbot](demo/web-agents/bring-your-chatbot/) demo). A page chat gets one agent session, opened on its first message and reused for the rest. `window.ai.providers` reports the agent, and the LLM Providers panel is hidden, since nothing uses the built-in model then.
- When a site uses your agent, Harbor tells it once, at the start, that it's working for you: it should use what it knows or remembers about you, and treat the site's instructions as the site's request. The site's instructions are still passed on, labelled as the site's.
- Page chat replies render markdown, with `marked`, sanitized by `DOMPurify` before they reach the site's page. Raw HTML in a reply shows as text, only http(s) links survive, and links open in a new tab with `noopener`.
- A policy action for prompts sent to your own agent, `model.prompt.agent`, so rules and the audit log see them. `Prompt(*)` covers it, and `Prompt(agent)` names it alone.
- **A site's own MCP server reaches your agent.** `window.agent.mcp.register()` used to record the server and do nothing else. Now Harbor asks you first (`mcp:servers.register`), then connects over SSE, WebSocket or streamable HTTP and offers the server's tools to that page's `agent.run`. On Harbor's own agent they're named `site:<host>:<name>/<tool>` and still need the site's tool grants. Your own ACP agent gets the server in its session and connects to it directly, when it supports the transport and the site holds the tool-list and tool-call permissions. A site may register only a server on its own origin; only a loopback page (`localhost`, `127.0.0.1`, `[::1]`) may register a loopback server. Other sites, other tabs and the sidebar never see these tools. Harbor disconnects when the tab closes or leaves the site, and registering is off with Tool Access off.
- The bridge methods behind the Agent panel: `acp.get_agents`, `acp.save_agents` (validates each agent and writes `acp.json` atomically, mode 0600) and `acp.resolve_command`. Like the rest of `acp.*`, they're refused over HTTP and WebSocket.

- **Public site redesign** — implemented the design produced in Claude Design. The site is now hand-written static HTML (`whitepaper/index.html`, `whitepaper/landscape.html`, `whitepaper/spec.html`, `whitepaper/build.html`, `whitepaper/styles.css`) with a Fraunces / Instrument Serif + Inter + JetBrains Mono type system, a single rust-clay accent, and a compare-and-contrast comparison table that re-stacks into cards on phones.
- **Internal positioning doc** at `docs/POSITIONING.md` captures the May 2026 landscape, the differentiation table, talking points by audience, and a source list. Source of truth for messaging.
- **Design paper trail** preserved in `whitepaper/DESIGN_NOTES.md`, `whitepaper/CLAUDE_DESIGN_PROMPT.md`, and `whitepaper/design-bundle/`.
- **`whitepaper/README.md`** documents the new site structure.

### Changed

- The sidebar, permission prompt, agent-question popup and MCP directory now use the public site's brand: green-tinted ink and rules, report green for links and focus, bright green for the main action, Helvetica Neue headings, soft corners and sentence-case labels. They follow your system's light or dark setting; the sidebar and directory no longer have their own theme switch. Icons come from Lucide, bundled as SVG, instead of emoji, in these pages and in a site's chat panel; a test keeps emoji icons out of the UI sources. `extension/src/design-tokens.css` takes its palette from `whitepaper/styles.css` and writes each color once with `light-dark()`. It was a duplicated copy of itself with 32 unused tokens and 64 unused classes; those are gone. The Safari build now needs Safari 17.5, the first with `light-dark()`.
- A site's `model:prompt` and `model:tools` allows are kept per backend. After you switch between the built-in model and an agent, or between agents, the site has to ask again, and the prompt names where its requests will go; switching back restores the earlier allow. A deny applies whichever backend is selected. Switching also ends the site's open text sessions and its `agent.sessions` sessions that use a model, whichever backend they ran on, and cancels its running `agent.run`.
- With an agent selected, the permission prompt says "This site's AI requests go to <agent>, your own agent", shows prompts and tools as one row, and rates it medium risk, since the site gets an agent that can use its tools.
- `agent.requestPermissions()` waits up to 5 minutes for an answer, up from 30 seconds. If the page stops waiting first, its answer is discarded, so a late Allow grants nothing.
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

- Styles in the sidebar and directory that pointed at tokens Harbor never defined (`--color-surface-tertiary`, `--color-success-bg`, `--border` and six others) now use defined ones, so those backgrounds and rules render.
- The directory's "installed, stopped" badge was filled with the muted text color, so its label was nearly unreadable.
- Scrollbars in Harbor's pages follow the theme in Firefox. They were styled only with `-webkit-` rules, which Firefox ignores.
- `window.agent.agents.list()` now returns the calling origin's registered agents instead of `undefined`. Its public types and test mock match the returned `id`, `name` and `status` entries.
- Running a site's task on your own agent no longer asks about listing Harbor's installed tools, which that agent doesn't use. The built-in model still lists tools under the site's existing permissions and policy.

- `agent.mcp.discover()` works again. It always failed with "No tab context for discovery" because the page's tab wasn't passed on.
- Harbor's SSE connection to a remote MCP server now follows the MCP SDK's handshake: it reads the server's `endpoint` event as a URL, waits for it before sending, and refuses an endpoint on another origin. It used to post to the wrong address. An SSE or WebSocket connection Harbor closes on purpose no longer reconnects.
- The Bring Your Own Chatbot demo's MCP server sends posted messages to their session instead of opening a new SSE stream for each.
- The examples in `spec/examples/` (basic chat, provider selection, page analyzer, agent with tools) wait for Harbor's `agent-ready` event instead of checking for `window.agent` once at load, so they no longer report the API as unavailable when Harbor injects it a moment later.
- A page chat (`agent.chat.open`) no longer stays registered after its tab closes or navigates to another document; a message for it is then refused the same as one for a chat that was never opened. A same-document change (a hash or `pushState`) no longer ends it by mistake.
- A page can no longer close another site's chat. `agent.chat.close(chatId)` now checks that the chat belongs to the calling origin (and tab, when known) before closing it; a mismatch is refused the same as a chat id that doesn't exist. Chat ids are also no longer predictable.
- Page chat's "tools used" line is built as text. It was inserted as HTML from tool names.
- The permission prompt shows each scope's title and description as text. Before, the known-scope rows were inserted as HTML, so markup in a name could render.
- Harbor's settings messages for agents answer only Harbor's own extension pages. A content script, which carries Harbor's extension ID but a site's URL, is refused.
- When a page stops reading a `promptStreaming()` partway through (it breaks out of its loop, aborts, or its tab closes), Harbor now stops the model instead of letting it generate the rest of the response. This needs the updated native bridge, which adds an `llm.cancel_stream` request.
- If Harbor asks before a page's call (because of a policy rule or the watchdog) and the person allows it after the page has given up waiting, the call is no longer performed. Before, a late Allow still ran it: a browser action, a model prompt, a tool call, a new session, an agent registration or invocation, or opening the chat could happen after the page had already seen `ERR_TIMEOUT` and possibly retried.
- `agent.browser.activeTab.readability()` now resolves to `{ url, title, text }`, as the spec says. Before, it returned `content` and `length`, so `text` was undefined, and its TypeScript types promised `textContent`, `excerpt`, `byline` and `siteName`, which never existed. `agent.browser.tab.readability(tabId)` returns the same shape and no longer includes `content`, `html` or `length`; use `tab.getHtml()` for markup. Both calls, and Harbor's browser capture for MCP servers, now read pages with one extractor, which keeps line breaks in the text.
- Parallel `session.callTool()` calls near the end of a session's `maxToolCalls` no longer each prompt for the last slot. A call now holds a budget slot while Harbor's policy engine checks it, gives it back if the engine refuses the call, and is refused without a prompt when every slot is used or held.
- A session's `maxToolCalls` budget is no longer spent on `session.callTool()` calls that Harbor's policy engine refuses, such as a call a deny rule blocks or one whose prompt the person declines. Harbor counts a call only once its policy check allows it. A call made after the budget is spent is refused without a prompt.
- A page call refused by Harbor's policy engine now fails with the engine's code, as `docs/PERMISSIONS.md` describes: `ERR_QUARANTINED` for a quarantined origin, `ERR_BLOCKED_BY_POLICY` for a deny rule, `ERR_PERMISSION_DENIED` for a declined prompt. This covers `agent.tools.call()`, a text session's `prompt()` and `promptStreaming()`, and `agent.run()`; prompts answered by your own agent go through the policy engine as `model.prompt.agent`, and a refusal reaches the page as `ERR_PERMISSION_DENIED`. Before, they reached the page as `ERR_TOOL_FAILED`, `ERR_MODEL_FAILED` or `ERR_AGENT_FAILED`. The error-code tables in the API docs and the explainer now list these codes. The bring-your-chatbot demo shows its own message for each of them.
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
