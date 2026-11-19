# Design: running page requests on the user's own agent over ACP

Status: **being built.** The bridge relay and the backend interface are on `main`; see the build plan.

Harbor implements the Web Agent API. Today every request a page makes runs on Harbor's own stack: a model reached through the native bridge, plus the MCP servers connected to Harbor. This document proposes a second backend. Harbor would act as a client of the [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) (ACP) and pass a page's `agent.run` requests and `window.ai` text sessions to an agent the user already runs. The first targets are [goose](https://goose-docs.ai/docs/gdk/acp/), Claude Code and Codex, each demonstrated end to end.

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

The alternative is for the extension to connect to `goose serve` over WebSocket. That needs no native code, but it has three costs. The user has to run and secure a server. The secret ends up in the extension's storage and in URLs. And it only works for agents that ship a server, which Claude Code's and Codex's adapters don't. So the spike doesn't use it. It uses a small development-only relay that runs any stdio agent and serves it over WebSocket on loopback, with a token, as Thunderbolt's CLI does. That reaches all three agents before the bridge module exists. The SDK takes any stream, so the extension-side client carries over unchanged to the bridge.

Safari reaches the bridge over HTTP without streaming. The ACP backend is Firefox-first and Chrome-second. Safari is out of scope until it has a streaming transport.

### 2. Mapping: which calls go to the ACP agent

| Web Agent API call | Backend |
| --- | --- |
| `window.agent.run` | **The ACP agent, when the user picks one.** One `session/new` per run, then one `session/prompt`. |
| `window.ai` text sessions | **The ACP agent, when the user picks one.** One ACP session per text session, one `session/prompt` per `prompt()` call. |
| `agent.tools.list` / `agent.tools.call`, `navigator.modelContext` | Harbor. These are about the page's and Harbor's tools, not about who runs the loop. |
| Browser-control APIs | Harbor. Unchanged. |

How a run maps onto ACP:

- **Session:** a fresh session per run. Its `cwd` is an empty working directory for that origin, under Harbor's data directory, canonicalized before use, so the agent doesn't start in the user's home or a project. Sessions aren't resumed across runs at first. Pages can't name a session.
- **Prompt:** the page's `task` becomes the user message. A page's `systemPrompt` is sent as part of the prompt and labelled as coming from the site, never as the agent's own instructions. The prompt also carries `_meta: {"harbor/provenance": {"source": "website", "origin": "<site origin>"}}`, so an agent that understands it can tell the request came from a site, and which one. ACP has no standard field for this yet.
- **Updates to page events:** `agent_message_chunk` becomes streamed tokens, `agent_thought_chunk` becomes thinking, and `tool_call` / `tool_call_update` become tool-call and tool-result events. Plans and usage are dropped at first. The prompt's `stopReason` becomes the final event, or an error for `refusal`, `max_tokens` or `max_turn_requests`. `cancelled` arrives both when Harbor cancels the run and, from Codex, when the user rejects a single tool call, so Harbor tells the two apart from its own state, not from the stop reason.
- **Cancellation:** the page's abort, a revoked grant and a tab closing all send `session/cancel`, and Harbor answers any pending permission request with `cancelled`. Harbor re-checks the site's `model:prompt` grant before the prompt and as the run goes. The built-in loop needs the same cancellation; that's part of the shared backend interface below.
- **`maxToolCalls`** is ignored on this backend. How many tools the agent uses is up to the agent.
- **Timeouts:** an agent turn can take minutes, so ACP runs don't use the 30-second default request timeout. A run has its own overall limit.
- **Protocol version:** v1. Move to v2 when it's stable and goose supports it.

How a `window.ai` text session maps onto ACP:

- **`createTextSession`** opens the agent process and one ACP session in the same per-origin working directory, and keeps both for the session's life: one `session/prompt` per `prompt()`/`promptStreaming()` call, not a fresh session each time. A `systemPrompt` option is sent labelled as coming from the site, as for `agent.run`, but only with the *first* prompt the page actually sends — not at creation time, since the agent hasn't been asked anything yet. `model:prompt` is re-checked (by the existing `resolveTextSession` path, unchanged) before every prompt, not just at creation.
- **`prompt` and `promptStreaming`** send one `session/prompt` each, with `_meta`'s `harbor/provenance` on every one. Only `agent_message_chunk` text reaches the page, path-scrubbed exactly as `agent.run`'s output is; `window.ai` has no events for thinking or tool calls, so those are dropped rather than relayed (unlike `agent.run`, nothing here re-checks the site's grant mid-turn against a tool call — the per-prompt check above is this backend's only one). The agent's own `session/request_permission` questions still go through the same dialog as `agent.run`. Multi-turn history lives in the ACP session, not in Harbor. Each prompt has the same 10-minute cap as an `agent.run` turn. A second `prompt`/`promptStreaming` call made before the first one's turn finishes is queued and sent after, in order, rather than run concurrently or rejected — the same as the built-in backend looks from the page's side, since it never rejects a concurrent call either.
- **`destroy`** cancels any turn in progress (the page sees `ERR_ABORTED` for an in-flight `promptStreaming`) and kills the agent process. A tab closing does the same.
- **Options the agent controls.** The built-in stack passes a session's `temperature` to the model (it already ignores `topK`). An ACP agent picks its own model and sampling, so on this backend Harbor ignores `temperature` too. A page can't tell from the API which backend it got; whether it should is a decision at the end.
- **`clone`** isn't part of Harbor's text sessions today. If it's added later, an ACP session can't be forked, so the ACP backend would need its own answer.
- **The agent's tools** are the agent's own, as in an `agent.run` (section 3). A site with only `model:prompt` reaches an agent that may have tools; the consent prompt says so.

### 3. What Harbor decides, and what the agent decides

Harbor decides whether a site may use the person's agent. It doesn't decide how the agent does the work. The agent's sandbox, its approvals, its tools and what it may touch belong to the agent's own harness, which the person already configured. Harbor passes the site's request to that agent honestly and passes the answer back.

**Harbor's part:**

- **The site's permission.** A site needs the same grants as on the built-in stack (section 4), and Harbor re-checks them as a run goes: a revoked grant cancels the run.
- **Provenance.** Harbor tells the agent the request came from a site, and which one, through the labelled instructions block and the `harbor/provenance` `_meta` key (section 2). A Harbor-aware agent can apply its own per-site policy with it.
- **Relaying permission requests.** When the agent's harness asks the client for approval (`session/request_permission`), Harbor opens a popup window showing the agent's own question — its tool call's title, kind, raw input and locations, worded so it's clear the agent is asking, not Harbor — and passes the person's choice back unchanged, including an "always" option if the agent offers one. Harbor adds no options of its own. The buttons show the agent's option names; a name that's only a code, such as goose's `allow_always`, is shown as "Allow always". Closing the window or pressing Escape or a liveness timeout answer with the agent's own reject option (`reject_once`, then `reject_always`, or `cancelled` if the agent offered neither), the same as an explicit rejection. The run being cancelled, or simply ending, while the window is still open answers `cancelled` instead and closes the window — nothing asked the person in that case, so nothing is approved or rejected on their behalf. Harbor doesn't add its own rules about which calls need approval.
- **Not leaking Harbor's own state.** Each site gets its own working directory under Harbor's data directory, so the agent doesn't start in the person's home or a project. The bridge starts the agent with a clean environment: `INHERITED_ENV` in `bridge-rs/src/acp/mod.rs` (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, and the XDG base directories other than `XDG_RUNTIME_DIR`), plus the agent's `env` from `acp.json`. That keeps Harbor's own environment, such as terminal-session handles, away from an agent a site can steer. It doesn't limit what the agent's harness gives the agent. Before passing the agent's text and tool events to the site, Harbor replaces the site's working-directory path with `.` and the person's home path with `~`; agents tend to echo those, and they reveal the person's username.
- **A run that never ends** is cancelled after 10 minutes.

**The agent's part:** which tools it has, whether it asks before using them, what files and network it can reach, and what keys its tools get. Harbor doesn't force an approval mode, confine paths, or cancel a run over what the agent does. A person who wants a stricter agent for sites configures its harness that way. For example, from testing:

- goose asks before every tool call in `approve` mode (`GOOSE_MODE=approve`).
- Claude Code's strictest built-in mode ("Manual") asks before file changes but runs reads and read-only shell commands without asking. A `permissions.ask: ["Bash"]` setting makes every shell command ask.
- Codex's built-in modes don't ask before reads. A custom permission profile with `approval_policy = "on-request"` and file access limited to one directory makes shell commands ask and blocks reads outside it.

**Still open:** what a site may ask the agent for: protection from malicious sites, tiered grants, friction in the consent prompt. That's deliberately undecided for now. One direction is a Harbor-aware agent that reads the provenance and applies per-site policy itself.

**Harbor's MCP servers and the page's tools** aren't offered to the ACP agent at first. The agent works with its own tools. Later, there are two ways to offer them:

- The bridge serves a loopback HTTP MCP endpoint for each session, protected by a per-session token. It lists only the tools the run is allowed to use. Each call goes back to the extension, which gates it exactly as `mcp.callTool` is gated today. Page tools would go back to the page's tab. This works with any agent that supports HTTP MCP servers.
- MCP-over-ACP serves the tools over the ACP connection, with no listening port. This is the better design once it's out of draft and agents support it.

**`fs/*` and `terminal/*` client methods** aren't advertised. Harbor has no business reading the user's files or running commands on an agent's behalf, and v2 removes these methods anyway.

### 4. Consent

- A site still needs the same grants: `model:prompt` for a text session, plus `model:tools` for `agent.run`. The backend changes which agent runs the request, not what the site may ask for.
- The consent prompt says plainly that the site gets the person's agent with whatever powers its harness gives it, including its tools.
- The consent prompt names where requests go: for example "goose (via ACP)" instead of a model name. The site's request reaches whatever model the user configured inside goose, which Harbor can't see. Harbor's data-flow promise, that data goes only to the provider the user configured, holds because the user configured goose.
- Prompts to an external agent need their own policy classification. Today any model name without a known local prefix counts as a first-party remote model. An ACP agent is neither. It needs a new action, so that rules can treat it separately.
- Revoking a site's grant during a run cancels the run.

### 5. Choosing the backend

- The sidebar's model panel gets an **Agent** setting: *Harbor (built-in)* or a configured ACP agent.
- Three presets ship together: goose (`goose acp`), Claude Code (`claude-agent-acp`) and Codex (`codex-acp`). Each uses the user's own install and account. A user can also add any other ACP agent by command line.
- A preset only says how to start the agent. It doesn't set the agent's approval mode or other settings; those stay the person's (section 3).
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
| 0 | Spike: the extension-side client runs one `agent.run` against goose, Claude Code and Codex through a development relay, behind a developer flag. For each agent, confirms the approval mode, the permission requests and the update stream. Not merged. | Extension, dev script | A recorded run per agent |
| 1 | Backend interface around today's loop, with cancellation wired through. No behaviour change. | Extension | vitest; the existing `agent.run` e2e tests pass |
| 2 | Bridge `acp` module: spawn configured agents, relay, kill on close or disconnect, cap, validate. | bridge-rs | cargo tests against a fake stdio agent |
| 3 | Extension ACP backend over the bridge for `agent.run`: session, prompt, update mapping, cancel, limits. | Extension | vitest against a fake agent |
| 3b | `window.ai` text sessions on the ACP backend: create, prompt, stream, destroy, ignored sampling options. | Extension | vitest against a fake agent |
| 4 | Permission requests: show the agent's own question to the person and pass the answer back unchanged. | Extension | vitest; manual check in Firefox |
| 5 | Sidebar Agent setting, the three presets (start commands only), consent prompt names the agent and says it gets the agent's powers. | Extension | Firefox, with each of the three agents |
| 6 | End-to-end demos: a demo page's `agent.run` and a `window.ai` text session run on goose, on Claude Code and on Codex in Firefox. The demo page shows which agent answered. | tests/e2e, demo | e2e per agent, each skipped when that agent isn't installed, and recorded as skipped; a recorded demo with each |

Later, as separate work: Harbor and page tools offered to the agent; session reuse; v2.

## Decisions

Settled by the maintainer:

1. **Transport.** The bridge spawns the configured agent and relays messages. The ACP client runs in the extension. (The spike uses a development-only WebSocket relay instead.)
2. **Mapping.** Both `agent.run` and `window.ai` text sessions go to the ACP agent when the user picks one.
3. **Harbor doesn't constrain the agent.** Harbor gates whether a site may use the agent, tells the agent where the request came from, relays the agent's own permission questions and passes the answer back. How the agent works is up to its harness (section 3). This replaces an earlier plan in which Harbor forced approval modes, prompted for each tool call, confined paths and cancelled runs over unasked commands.
4. **First-order agents.** goose, Claude Code and Codex are all first-order: each gets a preset and an end-to-end demo in the first release.

Open by the maintainer's choice: **what a site may ask the agent for.** Protection from malicious sites, tiered grants and consent friction are deliberately undecided for now.

Proposed, and open to the maintainer's review on this proposal:

5. **Policy classification.** Add a new action for prompts sent to an external agent, so they're no longer counted as going to a first-party remote model.
6. **Tools in the first release.** No Harbor or page tools are offered to the agent; it uses only its own.
7. **Backend choice.** One global setting in the sidebar, not per site.
8. **Working directory.** An empty directory per origin.
9. **`window.ai` on the ACP backend ignores `temperature`.** A page gets no signal that its option was dropped. The alternative is to report the backend, or which options apply, to the page, which would change the page-API contract.
10. **Positioning.** Once each agent works end to end, `docs/POSITIONING.md` can name it as tested. Today it names goose as the first target only. That copy change waits until the end-to-end unit is done.
