# Design: running page requests on the user's own agent over ACP

Status: **proposal, awaiting the maintainer's approval.** Nothing here is built yet.

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
- **Prompt:** the page's `task` becomes the user message. A page's `systemPrompt` is sent as part of the prompt and labelled as coming from the site, never as the agent's own instructions.
- **Updates to page events:** `agent_message_chunk` becomes streamed tokens, `agent_thought_chunk` becomes thinking, and `tool_call` / `tool_call_update` become tool-call and tool-result events. Plans and usage are dropped at first. The prompt's `stopReason` becomes the final event, or an error for `refusal`, `max_tokens` or `max_turn_requests`. `cancelled` arrives both when Harbor cancels the run and, from Codex, when the user rejects a single tool call, so Harbor tells the two apart from its own state, not from the stop reason.
- **Cancellation:** the page's abort, a revoked grant and a tab closing all send `session/cancel`, and Harbor answers any pending permission request with `cancelled`. The built-in loop needs the same cancellation; that's part of the shared backend interface below.
- **`maxToolCalls`:** counted from `tool_call` updates. When the limit is reached, Harbor cancels the session.
- **Timeouts:** an agent turn can take minutes, so ACP runs don't use the 30-second default request timeout. A run has its own overall limit.
- **Protocol version:** v1. Move to v2 when it's stable and goose supports it.

How a `window.ai` text session maps onto ACP:

- **`createTextSession`** opens an ACP session in the same per-origin working directory. A `systemPrompt` option is sent with the first prompt and labelled as coming from the site, as for `agent.run`.
- **`prompt` and `promptStreaming`** send one `session/prompt` each. Only `agent_message_chunk` text reaches the page; `window.ai` has no events for thinking or tool calls, so those stay inside Harbor (in the permission prompt and the audit log). Multi-turn history lives in the ACP session, not in Harbor.
- **`destroy`** cancels any turn in progress and drops the session. A tab closing does the same.
- **Options the agent controls.** The built-in stack passes a session's `temperature` to the model (it already ignores `topK`). An ACP agent picks its own model and sampling, so on this backend Harbor ignores `temperature` too. A page can't tell from the API which backend it got; whether it should is a decision at the end.
- **`clone`** isn't part of Harbor's text sessions today. If it's added later, an ACP session can't be forked, so the ACP backend would need its own answer.
- **The agent's tools** follow the same rules as in an `agent.run` (section 3). A site with only `model:prompt` can now start an agent that may ask to use its tools, so every such call needs the user's approval in Harbor.

### 3. Tools and permissions

There are three kinds of tool, handled differently.

**The agent's own tools** (goose's shell and file editing, for example) are the new risk. A page's request now runs on an agent that can read the user's files and run commands, and the page's text reaches that agent. Content on a page could steer the agent into reading a secret and returning it in the run's final answer to the page.

Rules:

1. **Every action that changes something needs Harbor's approval while the agent works on a page's request.** When the session starts, Harbor sets the agent's strictest approval mode (see section 5). That mode must ask before the agent changes files. Reads may go unasked, because Claude Code's and Codex's strictest modes don't ask before a read; rule 6 confines them. Anything else that runs without asking is handled by rule 8. If an agent has no mode that asks before changes, Harbor refuses to start a page's request on it, and the user sees why.
2. **Harbor shows the request in its own prompt**, naming the site, the agent and the action: the tool call's title, kind, input and file locations.
3. **Harbor never passes "always" through to the agent.** The agent's own "always allow" isn't tied to a site, so it would carry over to the next site's run. Harbor answers `allow_once` or `reject_once`, and keeps any "always" in its own store, keyed by origin, agent and tool kind. Shell commands (kind `execute`) are never remembered: each one is approved on its own.
4. **Each approval goes through the policy engine** as a new action, so it reaches rules and the audit log. Its effect comes from the tool call's kind: `read`, `search`, `think` and `fetch` are reads; `edit`, `delete`, `move` and `execute` are writes; anything else counts as a write. goose reports every tool call as `other`, so every goose call is treated as a write. The site's grant to use the agent doesn't count as consent for these calls.
5. **An unanswered prompt times out** and is answered `reject_once`.
6. **Harbor confines the agent to the site's working directory itself.** It doesn't trust the agent's own framing. Every path the agent reports, in a permission request or in a `tool_call` / `tool_call_update` (its `locations` and path-like fields of its input), is checked against the working directory after both are canonicalized (symlinks resolved; on macOS the temporary directory is a symlink). A path outside it gets `reject_once` if the agent asked. If the agent didn't ask, as with an unasked read, Harbor cancels the run and nothing more reaches the page. This depends on agents reporting the paths they touch. A shell command's paths are in a free-form command string, so it can't be confined this way; see rule 8.
7. **The agent gets a clean environment.** The bridge starts it with the environment variables from its config plus what it needs to run (such as `PATH` and `HOME`), not the variables that identify the user's terminal or session. In testing, an agent that was allowed to run commands used such a variable to act on the terminal session it was started from. The list it keeps is `INHERITED_ENV` in `bridge-rs/src/acp/mod.rs`: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*` and the XDG base directories other than `XDG_RUNTIME_DIR`, which holds the login session's sockets. API keys aren't inherited; a user who wants one passed puts it in the agent's `env` in `acp.json`.
8. **Anything that runs without asking must be a read Harbor can confine.** A `tool_call` Harbor wasn't asked about is allowed only if its kind is `read`, `search` or `think`, it reports at least one path when it first appears, and every path it reports, then or in any later update, is inside the working directory (rule 6). Anything else that runs unasked cancels the run: a shell command, a call labelled `other`, a read that reports no path, or one whose later update reveals a path outside. Harbor checks each `tool_call` and `tool_call_update` before forwarding any of it to the page, so the update that fails the check, and everything after it, never reaches the page. In testing, Claude Code's and Codex's strictest modes still ran read-only shell commands such as `ls` and `cat` without a permission request, and a command string can't be confined. Each preset should also use the agent's own settings, where they exist, to make every shell command ask, so this rarely happens.

**Harbor's MCP servers and the page's tools** aren't offered to the ACP agent at first. The agent works with its own tools. Later, there are two ways to offer them:

- The bridge serves a loopback HTTP MCP endpoint for each session, protected by a per-session token. It lists only the tools the run is allowed to use. Each call goes back to the extension, which gates it exactly as `mcp.callTool` is gated today. Page tools would go back to the page's tab. This works with any agent that supports HTTP MCP servers.
- MCP-over-ACP serves the tools over the ACP connection, with no listening port. This is the better design once it's out of draft and agents support it.

**`fs/*` and `terminal/*` client methods** aren't advertised. Harbor has no business reading the user's files or running commands on an agent's behalf, and v2 removes these methods anyway.

### 4. Consent

- A site still needs the same grants: `model:prompt` for a text session, plus `model:tools` for `agent.run`. The backend changes which agent runs the request, not what the site may ask for. What the agent then does with its own tools is approved call by call (section 3), whichever grant started the request.
- The consent prompt names where requests go: for example "goose (via ACP)" instead of a model name. The site's request reaches whatever model the user configured inside goose, which Harbor can't see. Harbor's data-flow promise, that data goes only to the provider the user configured, holds because the user configured goose.
- Prompts to an external agent need their own policy classification. Today any model name without a known local prefix counts as a first-party remote model. An ACP agent is neither. It needs a new action, so that rules can treat it separately.
- Revoking a site's grant during a run cancels the run.

### 5. Choosing the backend

- The sidebar's model panel gets an **Agent** setting: *Harbor (built-in)* or a configured ACP agent.
- Three presets ship together: goose (`goose acp`), Claude Code (`claude-agent-acp`) and Codex (`codex-acp`). Each uses the user's own install and account. A user can also add any other ACP agent by command line.
- Each preset records how Harbor puts that agent in its strictest approval mode. These were checked by hand, because a mode's description doesn't reliably say what it gates:

  | Agent | How Harbor sets it | Asks before |
  | --- | --- | --- |
  | goose | `GOOSE_MODE=approve` in the agent's environment at start | every tool call |
  | Claude Code | `session/set_mode` to `default` ("Manual"), plus `_meta.claudeCode.options.settings.permissions.ask: ["Bash"]` on `session/new` | file changes and every shell command; not reads through its file tools |
  | Codex | A custom permission profile in a Codex config directory Harbor provides: `approval_policy = "on-request"`, file access limited to the working directory, selected with `INITIAL_AGENT_MODE=permission-profile:<id>` | every shell command; its own file-read tool fails everywhere, so reads go through shell commands, which ask |

  Without these settings, Claude Code's and Codex's strictest modes ran read-only shell commands such as `ls` and `cat` without asking. Claude Code also reads the user's own settings, which can start it in `auto` mode, so Harbor sets the mode and the override on every session. Under the Codex profile, Codex's own file-read tool fails even inside the directory, so it falls back to shell commands, and each one asks; that's safe but means more prompts. Codex no longer accepts the `untrusted` approval policy, and its built-in modes override session settings.

  Testing covered reads, file edits and shell commands. Deletes, moves and network access weren't exercised. Recheck the table when an adapter's version changes.
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
| 4 | Permission requests: Harbor's prompt, the policy action, per-origin "always", timeout, refusal without an approval mode. | Extension | vitest; manual check in Firefox |
| 5 | Sidebar Agent setting, the three presets, consent prompt names the agent. | Extension | Firefox, with each of the three agents |
| 6 | End-to-end demos: a demo page's `agent.run` and a `window.ai` text session run on goose, on Claude Code and on Codex in Firefox. The demo page shows which agent answered. | tests/e2e, demo | e2e per agent, each skipped when that agent isn't installed, and recorded as skipped; a recorded demo with each |

Later, as separate work: Harbor and page tools offered to the agent; session reuse; v2.

## Decisions

Settled by the maintainer:

1. **Transport.** The bridge spawns the configured agent and relays messages. The ACP client runs in the extension. (The spike uses a development-only WebSocket relay instead.)
2. **Mapping.** Both `agent.run` and `window.ai` text sessions go to the ACP agent when the user picks one.
3. **Agent-native tools on a page's behalf.** Every action that changes something needs Harbor's approval. Harbor keeps "always" per origin, never for shell commands, and refuses agents with no mode that asks before changes. Reads may go unasked, and Harbor confines them to the site's working directory. A shell command that runs without asking cancels the run (section 3, rules 1, 3, 6 and 8).
4. **First-order agents.** goose, Claude Code and Codex are all first-order: each gets a preset and an end-to-end demo in the first release.

Proposed, and open to the maintainer's review on this proposal:

5. **Policy classification.** Add a new action for prompts sent to an external agent, so they're no longer counted as going to a first-party remote model.
6. **Tools in the first release.** No Harbor or page tools are offered to the agent; it uses only its own.
7. **Backend choice.** One global setting in the sidebar, not per site.
8. **Working directory.** An empty directory per origin.
9. **`window.ai` on the ACP backend ignores `temperature`.** A page gets no signal that its option was dropped. The alternative is to report the backend, or which options apply, to the page, which would change the page-API contract.
10. **Positioning.** Once each agent works end to end, `docs/POSITIONING.md` can name it as tested. Today it names goose as the first target only. That copy change waits until the end-to-end unit is done.
