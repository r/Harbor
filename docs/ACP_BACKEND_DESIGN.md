# Design: running page requests on the user's own agent over ACP

Status: **proposal, awaiting the maintainer's approval.** Nothing here is built yet.

Harbor implements the Web Agent API. Today every request a page makes runs on Harbor's own stack: a model reached through the native bridge, plus the MCP servers connected to Harbor. This document proposes a second backend. Harbor would act as a client of the [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) (ACP) and pass a page's `agent.run` request to an agent the user already runs. The first target is [goose](https://goose-docs.ai/docs/gdk/acp/).

The built-in stack stays the default. The ACP backend is designed as a first-class backend, not a side option, so the default can change later without rework.

Harbor's job doesn't change with the backend. Harbor decides whether a site may use the person's agent. The agent does the work.

## Facts this design rests on

These were checked in November 2026. Recheck them before building.

| Fact | Source |
| --- | --- |
| `goose acp` serves ACP over stdio. The client spawns it and owns its lifetime. | [goose: ACP](https://goose-docs.ai/docs/gdk/acp/) |
| `goose serve` serves ACP over HTTP or WebSocket at `127.0.0.1:3284/acp`. A secret (`GOOSE_SERVER__SECRET_KEY`) is required, sent as `X-Secret-Key` or as a `token` query parameter. Origin checks aren't documented. | [goose CLI commands](https://goose-docs.ai/docs/guides/goose-cli-commands) |
| goose decides when to ask for approval from its mode: `auto`, `approve`, `smart_approve` or `chat`. | [goose: ACP](https://goose-docs.ai/docs/gdk/acp/) |
| ACP v1 is stable. v2 is a draft. v2 removes the `fs/*` and `terminal/*` client methods and `session/set_mode`, and adds a required `title` to `session/request_permission`. | [v2 migration](https://agentclientprotocol.com/protocol/v2/migration) |
| `session/request_permission` offers options of kind `allow_once`, `allow_always`, `reject_once` or `reject_always`. The client answers `selected` with an option ID, or `cancelled`. | [Tool calls](https://agentclientprotocol.com/protocol/tool-calls) |
| `session/new` takes `cwd` and `mcpServers` (stdio always; `http` and `sse` if the agent advertises them). | [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup) |
| MCP-over-ACP is a draft RFD. It lets the client serve tools to the agent over the ACP connection itself. No agent is listed as supporting it. | [RFD: MCP over ACP](https://agentclientprotocol.com/rfds/mcp-over-acp) |
| Claude Code speaks ACP through the official adapter `@agentclientprotocol/claude-agent-acp`. | [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) |
| Codex has no native ACP. The `codex-acp` adapter starts `codex app-server` and translates. | [codex-acp](https://github.com/agentclientprotocol/codex-acp) |

All three agents run as a stdio process. So one transport covers goose, Claude Code and Codex, with only the command line differing.

Prior art: [Thunderbolt](https://github.com/thunderbird/thunderbolt) (MPL-2.0) is a browser-side ACP client. It bridges a stdio agent to a WebSocket. It runs one process per connection, sends one JSON-RPC message per frame, and checks a token and the Origin. It shows permission requests in a dialog with "allow this kind" and "allow this agent" shortcuts, and it tries `session/resume`, then `session/load`, then `session/new`. It passes no MCP servers and implements no `fs` or `terminal` methods. Its permission prompts never time out, and its allowances aren't saved.

## How Harbor runs `agent.run` today

- A page's `window.agent.run` reaches one loop, in the extension's background (`extension/src/page-api/background.ts`, `handleAgentRun`).
- The loop checks the `model:prompt` and `model:tools` grants once. It lists Harbor's MCP tools and filters them to the site's `allowedTools`. Each turn it calls the bridge's non-streaming `llm.chat`. Each tool call goes through `mcp.callTool`, which is gated per call.
- Events reach the page as a stream over the content script's port: thinking, tool calls, tool results, the final answer.
- Tools that pages register through `navigator.modelContext` live in the page, and aren't offered to `agent.run`.
- The bridge speaks length-prefixed JSON over native messaging. It streams only `llm.chat_stream`. It starts no long-lived child process today.

## Proposal

### 1. Transport: the bridge starts the agent and relays bytes

The bridge spawns the configured agent (`goose acp`) and relays ACP messages between it and the extension. The ACP client itself, which handles sessions, prompts, permission requests and the mapping to page events, runs in the extension. It uses the official TypeScript SDK (`@agentclientprotocol/sdk`).

Why the client runs in the extension, not in Rust:

- Everything an ACP client has to consult lives in the extension: per-origin grants, the policy engine, the consent prompt, the audit log, Harbor's MCP host and the page's tools.
- The official SDK is TypeScript, and Thunderbolt shows the pattern working.
- The bridge stays small. It manages processes and frames messages, and holds no protocol state.

Bridge work, as a new `bridge-rs/src/acp/` module:

- `acp.open { agentId }` spawns the agent named by `agentId` and returns a channel ID. The command, arguments and environment come from the bridge's own config, never from the message. A message can choose among configured agents, but it can't name a program to run.
- `acp.send { channel, message }` writes one newline-delimited JSON-RPC message to the agent's stdin.
- The agent's stdout comes back as stream events on the channel, one JSON-RPC message per event. stderr goes to the bridge log.
- `acp.close { channel }` kills the process. The bridge also kills every agent process it started when the extension disconnects. It caps the number of live agents.
- The bridge validates every message from the extension: the channel exists, the message is one JSON object, and the size is under the limit.

The alternative is for the extension to connect to `goose serve` over WebSocket. That needs no native code, but it has three costs. The user has to run and secure a server. The secret ends up in the extension's storage and in URLs. And it only works for agents that ship a server, which Claude Code's and Codex's adapters don't. **Recommendation:** use it only for the first spike, to test the extension-side client against a real agent before the bridge module exists. The SDK takes any stream, so the client code carries over unchanged.

Safari reaches the bridge over HTTP without streaming. The ACP backend is Firefox-first and Chrome-second. Safari is out of scope until it has a streaming transport.

### 2. Mapping: which calls go to the ACP agent

| Web Agent API call | Backend |
| --- | --- |
| `window.agent.run` | **The ACP agent, when the user picks one.** One `session/new` per run, then one `session/prompt`. |
| `window.ai` text sessions | Built-in stack. `window.ai` is a model API with no tools. An agent with its own tools and memory would change what a site gets for the same grant. |
| `agent.tools.list` / `agent.tools.call`, `navigator.modelContext` | Harbor. These are about the page's and Harbor's tools, not about who runs the loop. |
| Browser-control APIs | Harbor. Unchanged. |

How a run maps onto ACP:

- **Session:** a fresh session per run. Its `cwd` is an empty working directory for that origin, under Harbor's data directory, so the agent doesn't start in the user's home or a project. Sessions aren't resumed across runs at first. Pages can't name a session.
- **Prompt:** the page's `task` becomes the user message. A page's `systemPrompt` is sent as part of the prompt and labelled as coming from the site, never as the agent's own instructions.
- **Updates to page events:** `agent_message_chunk` becomes streamed tokens, `agent_thought_chunk` becomes thinking, and `tool_call` / `tool_call_update` become tool-call and tool-result events. Plans and usage are dropped at first. The prompt's `stopReason` becomes the final event, or an error for `refusal`, `max_tokens` or `max_turn_requests`.
- **Cancellation:** the page's abort, a revoked grant and a tab closing all send `session/cancel`, and Harbor answers any pending permission request with `cancelled`. The built-in loop needs the same cancellation; that's part of the shared backend interface below.
- **`maxToolCalls`:** counted from `tool_call` updates. When the limit is reached, Harbor cancels the session.
- **Timeouts:** an agent turn can take minutes, so ACP runs don't use the 30-second default request timeout. A run has its own overall limit.
- **Protocol version:** v1. Move to v2 when it's stable and goose supports it.

### 3. Tools and permissions

There are three kinds of tool, handled differently.

**The agent's own tools** (goose's shell and file editing, for example) are the new risk. A page's request now runs on an agent that can read the user's files and run commands, and the page's text reaches that agent. Content on a page could steer the agent into reading a secret and returning it in the run's final answer to the page.

Proposed rules:

1. **Every agent tool call needs Harbor's approval during a page's run.** Harbor sets the agent to an approval mode when the session starts (`session/set_mode` in v1; goose's `approve` mode). If the agent can't be put in a mode that asks before acting, Harbor refuses to start a run for a page. The user sees why.
2. **Harbor shows the request in its own prompt**, naming the site, the agent and the action: the tool call's title, kind, input and file locations.
3. **Harbor never passes "always" through to the agent.** The agent's own "always allow" isn't tied to a site, so it would carry over to the next site's run. Harbor answers `allow_once` or `reject_once`, and keeps any "always" in its own store, keyed by origin, agent and tool kind.
4. **Each approval goes through the policy engine** as a new action, so it reaches rules and the audit log. Its effect comes from the tool call's kind: `read`, `search`, `think` and `fetch` are reads; `edit`, `delete`, `move` and `execute` are writes; anything else counts as a write. The site's grant to use the agent doesn't count as consent for these calls.
5. **An unanswered prompt times out** and is answered `reject_once`.

**Harbor's MCP servers and the page's tools** aren't offered to the ACP agent at first. The agent works with its own tools. Later, there are two ways to offer them:

- The bridge serves a loopback HTTP MCP endpoint for each session, protected by a per-session token. It lists only the tools the run is allowed to use. Each call goes back to the extension, which gates it exactly as `mcp.callTool` is gated today. Page tools would go back to the page's tab. This works with any agent that supports HTTP MCP servers.
- MCP-over-ACP serves the tools over the ACP connection, with no listening port. This is the better design once it's out of draft and agents support it.

**`fs/*` and `terminal/*` client methods** aren't advertised. Harbor has no business reading the user's files or running commands on an agent's behalf, and v2 removes these methods anyway.

### 4. Consent

- A site still needs the same grants for `agent.run`: `model:prompt` and `model:tools`. The backend changes which agent runs the request, not what the site may ask for.
- The consent prompt names where requests go: for example "goose (via ACP)" instead of a model name. The site's request reaches whatever model the user configured inside goose, which Harbor can't see. Harbor's data-flow promise, that data goes only to the provider the user configured, holds because the user configured goose.
- Prompts to an external agent need their own policy classification. Today any model name without a known local prefix counts as a first-party remote model. An ACP agent is neither. It needs a new action, so that rules can treat it separately.
- Revoking a site's grant during a run cancels the run.

### 5. Choosing the backend

- The sidebar's model panel gets an **Agent** setting: *Harbor (built-in)* or a configured ACP agent.
- goose ships as a preset with command `goose acp`. Claude Code (`claude-agent-acp`) and Codex (`codex-acp`) can follow as presets, once each has been tested.
- The bridge checks that the agent's command exists, and runs `initialize` when the user selects the agent, so setup errors appear in the sidebar, not on a page.
- The setting is global at first. A per-site choice can come later.

### 6. Fit with other agent-side work

- **One loop, two backends.** Harbor has more than one `agent.run` implementation today, and consolidating them is planned. The consolidated loop should sit behind a backend interface: run a task with this origin's allowed tools, stream events, honour a cancel signal. The built-in model loop is one backend, and ACP is the second. The grant checks, the feature flag and event delivery to the page stay outside both backends, so they apply to every run.
- **The Harbor SDK** doesn't change. Pages see the same Web Agent API whichever backend runs.
- **Agent-to-company protocols** such as the Personal Agent Protocol are a different layer: how the user's agent reaches a company. ACP is how Harbor reaches the user's agent. Nothing here depends on them.

## Build plan, after approval

Each unit ends with tests and a working check. Red tests come first, at the real boundary.

| # | Unit | Area | Proof |
| --- | --- | --- | --- |
| 0 | Spike: the extension-side client runs one `agent.run` against `goose serve` over WebSocket, behind a developer flag. Confirms goose's modes, its permission requests and its update stream. Not merged. | Extension | A recorded run with a local model |
| 1 | Backend interface around today's loop, with cancellation wired through. No behaviour change. | Extension | vitest; the existing `agent.run` e2e tests pass |
| 2 | Bridge `acp` module: spawn configured agents, relay, kill on close or disconnect, cap, validate. | bridge-rs | cargo tests against a fake stdio agent |
| 3 | Extension ACP backend over the bridge: session, prompt, update mapping, cancel, limits. | Extension | vitest against a fake agent |
| 4 | Permission requests: Harbor's prompt, the policy action, per-origin "always", timeout, refusal without an approval mode. | Extension | vitest; manual check in Firefox |
| 5 | Sidebar Agent setting, goose preset, consent prompt names the agent. | Extension | Firefox, with goose and a local model |
| 6 | End-to-end: a demo page's `agent.run` runs on goose in Firefox. | tests/e2e, demo | e2e with goose installed, skipped when it isn't, and recorded as skipped |

Later, as separate work: Harbor and page tools offered to the agent; Claude Code and Codex presets; session reuse; v2.

## Decisions for the maintainer

1. **Transport.** The bridge spawns the agent and relays, with the ACP client in the extension (recommended). The alternatives are WebSocket to `goose serve`, or an ACP client in Rust.
2. **Mapping.** Only `agent.run` goes to the ACP agent, and `window.ai` stays on the built-in stack (recommended).
3. **Agent-native tools on a page's behalf** (a permission-model change). Each call needs Harbor's approval. Harbor keeps "always" per origin and refuses agents it can't put in an approval mode (recommended).
4. **Policy classification.** Add a new action for prompts sent to an external agent, so it's no longer counted as a first-party remote model (recommended).
5. **Tools in the first release.** No Harbor or page tools are offered to the agent, and the agent uses only its own (recommended).
6. **Backend choice.** One global setting in the sidebar (recommended), or per site.
7. **Working directory.** An empty directory per origin (recommended), or something the user picks.
8. **Positioning.** Once goose works, `docs/POSITIONING.md` can name goose as tested. That copy change is the maintainer's call, after unit 6.
