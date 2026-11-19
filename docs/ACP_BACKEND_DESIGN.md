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

- **`createTextSession`** opens the agent process and one ACP session in the same per-origin working directory, and keeps both for the session's life: one `session/prompt` per `prompt()`/`promptStreaming()` call, not a fresh session each time. A `systemPrompt` option is sent labelled as coming from the site, as for `agent.run`, but only with the *first* prompt the page actually sends — not at creation time, since the agent hasn't been asked anything yet. `model:prompt` is re-checked (by the existing `resolveTextSession` path, unchanged) before every prompt, not just at creation. Reaching the per-site agent cap (below) fails this with `ERR_AGENT_BUSY` before `acp.open` is ever called.
- **`prompt` and `promptStreaming`** send one `session/prompt` each, with `_meta`'s `harbor/provenance` on every one. Only `agent_message_chunk` text reaches the page, path-scrubbed exactly as `agent.run`'s output is; `window.ai` has no events for thinking or tool calls, so those are dropped rather than relayed — but `tool_call`/`tool_call_update` still re-check the site's `model:prompt` grant mid-turn and cancel on a revoked one, exactly as `agent.run` does, since a turn can run for minutes while the agent uses its own tools. The agent's own `session/request_permission` questions still go through the same dialog as `agent.run`. Multi-turn history lives in the ACP session, not in Harbor. Each prompt has the same 10-minute cap as an `agent.run` turn, and the page's own request for it is given a matching timeout (not the generic 30 seconds) so it doesn't give up first; a page-side timeout cancels the turn in the background too, the same as an explicit abort. A second `prompt`/`promptStreaming` call made before the first one's turn finishes is queued and sent after, in order, rather than run concurrently or rejected — the same as the built-in backend looks from the page's side, since it never rejects a concurrent call either.
- **`destroy`** cancels any turn in progress (the page sees `ERR_ABORTED` for an in-flight `promptStreaming`) and kills the agent process. A tab closing, or the page's port disconnecting (a navigation or reload starts a new port on the same tab, without a `tabs.onRemoved` event), does the same — including for a session whose agent is still starting when either happens.
- **Options the agent controls.** The built-in stack passes a session's `temperature` to the model (it already ignores `topK`). An ACP agent picks its own model and sampling, so on this backend Harbor ignores `temperature` too. A page can't tell from the API which backend it got; whether it should is a decision at the end.
- **`clone`** isn't part of Harbor's text sessions today. If it's added later, an ACP session can't be forked, so the ACP backend would need its own answer.
- **The agent's tools** are the agent's own, as in an `agent.run` (section 3). A site with only `model:prompt` reaches an agent that may have tools; the consent prompt says so.

**The per-site agent cap.** A site may have at most 2 live ACP agents at once, counting `agent.run` runs and `window.ai` text sessions together — a maintainer decision, to bound what one site can hold open regardless of how many times it asks. A `createTextSession` or `agent.run` past the cap fails with `ERR_AGENT_BUSY` ("This site already has 2 agents running") before the bridge's `acp.open` is ever called. A slot is held from just before that call until the agent ends, on every path: `destroy()`, a tab closing, a port disconnecting, `open()` itself failing, and a run or turn's own timeout. The bridge has its own separate, global cap across every site (`MAX_LIVE_AGENTS`, 8; see bridge-rs/README.md); hitting that maps to the same `ERR_AGENT_BUSY`, worded for the bridge's limit instead of the site's, from the `"code": "agent_cap"` field on `acp.open`'s fatal error — Harbor matches that code, not the error's human-readable message. A per-site limit tighter than the maintainer's own tiered-grants plans (section 3, "still open") may need revisiting once those exist.

### 3. What Harbor decides, and what the agent decides

Harbor decides whether a site may use the person's agent. It doesn't decide how the agent does the work. The agent's sandbox, its approvals, its tools and what it may touch belong to the agent's own harness, which the person already configured. Harbor passes the site's request to that agent honestly and passes the answer back.

**Harbor's part:**

- **The site's permission.** A site needs the same grants as on the built-in stack (section 4), and Harbor re-checks them as a run goes: a revoked grant cancels the run.
- **Provenance.** Harbor tells the agent the request came from a site, and which one, through the labelled instructions block and the `harbor/provenance` `_meta` key (section 2). A Harbor-aware agent can apply its own per-site policy with it.
- **Relaying permission requests.** When the agent's harness asks the client for approval (`session/request_permission`), Harbor opens a popup window showing the agent's own question — its tool call's title, kind, raw input and locations, worded so it's clear the agent is asking, not Harbor — and passes the person's choice back unchanged, including an "always" option if the agent offers one. Harbor adds no options of its own. The buttons show the agent's option names; a name that's only a code, such as goose's `allow_always`, is shown as "Allow always". Closing the window or pressing Escape or a liveness timeout answer with the agent's own reject option (`reject_once`, then `reject_always`, or `cancelled` if the agent offered neither), the same as an explicit rejection. The run being cancelled, or simply ending, while the window is still open answers `cancelled` instead and closes the window — nothing asked the person in that case, so nothing is approved or rejected on their behalf. Harbor doesn't add its own rules about which calls need approval.
- **Not leaking Harbor's own state.** Each site gets its own working directory under Harbor's data directory, so the agent doesn't start in the person's home or a project. The bridge starts the agent with a clean environment: `INHERITED_ENV` in `bridge-rs/src/acp/mod.rs` (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, and the XDG base directories other than `XDG_RUNTIME_DIR`), plus the agent's `env` from `acp.json`. That keeps Harbor's own environment, such as terminal-session handles, away from an agent a site can steer. It doesn't limit what the agent's harness gives the agent. Before passing the agent's text and tool events to the site, Harbor replaces the site's working-directory path with `.` and the person's home path with `~`; agents tend to echo those, and they reveal the person's username.
- **A run that never ends** is cancelled after 10 minutes.
- **How many agents a site may hold open at once.** 2, counting `agent.run` runs and `window.ai` text sessions together — section 2 has the details (`ERR_AGENT_BUSY`, the slot's lifetime, and the bridge's own separate global cap).

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
- The consent prompt says plainly that the site gets the person's agent with whatever powers its harness gives it, including its tools — and names which calls actually reach it, since `model:prompt`/`model:tools` cover more than the ACP path (section 2's mapping table): `agent.sessions` and a direct `llm.chat` still run on Harbor's own model even with an agent selected. With an ACP agent selected, the two scopes' wording is: title "Text prompts and agent runs go to \<agent name\>, your own agent"; description "When this site uses window.ai text sessions or agent.run, \<agent name\> answers, with whatever it can do in your setup, including its tools. Other features still use Harbor's built-in model." With no agent selected, the built-in wording is unchanged. The wording never names the protocol — a person reading the prompt doesn't need to know Harbor talks to the agent over ACP; this document, and other developer-facing docs, can still say ACP (maintainer decision).
- When a request carries both `model:prompt` and `model:tools` and an agent is selected, the prompt shows **one row**, not two identical ones — same title/description either way — at the **MEDIUM** risk level, the higher of the two scopes' own built-in tiers. A single-scope request for `model:prompt` alone, with an agent selected, also shows MEDIUM rather than its own built-in `low`: the site gets an agent with tools either way. This is display only; the grant itself still covers each requested scope exactly as before. Built-in wording and risk levels (no agent selected) are unchanged.
- The consent prompt names where requests go: for example "goose, your own agent" instead of a model name or the protocol it's reached over. The site's request reaches whatever model the user configured inside goose, which Harbor can't see. Harbor's data-flow promise, that data goes only to the provider the user configured, holds because the user configured goose.
- Prompts to an external agent have their own policy classification, `model.prompt.agent` (section below) — a prompt now counts as going to the person's own agent, not as a first-party remote model, so a rule can treat the two differently.
- `model.prompt.agent` is required, through the same typed-action gate (`requireAction`) a page's own `llm.chat`/`session.create` calls go through, before every `session/prompt` on either ACP path (`agent.run` and a `window.ai` text session's own prompt loop) — in addition to, not instead of, the existing `model:prompt` origin-grant check both already made. That means a denial reaches the rule engine and the audit log, not just Harbor's consent store. A site that already holds the `model:prompt` grant isn't asked a second time (the same "origin-grant" upstream-consent deal a page's own prompt gets); a policy rule can still deny or ask about it on its own.
- A denial of `model.prompt.agent` ends the run or turn with `ERR_PERMISSION_DENIED` — the same code the pre-existing origin-grant check already used, regardless of which policy tier actually produced the denial.
- Revoking a site's grant during a run cancels the run.
- **An *allow* for `model:prompt`/`model:tools` is scoped to the backend it was given for** (`policy/backend-grant.ts`): recorded as `builtin` or `acp:<agentId>`, and counted only while that's still selected. Switching backends doesn't revoke an allow, it just stops it from counting until the person switches back; allows for different backends are stored side by side, so granting under a second agent doesn't overwrite the first's own allow. A **deny**, though, is universal (maintainer decision): it applies whatever backend is selected, including one that never had an allow of its own, until the person grants again. A grant made before this existed has no recorded backend and counts as `builtin`. Enforced in both `permissions.ts` (what `hasPermission` reads) and `origin-grants.ts` (the engine's Tier 8, which `requireAgentPromptAction` also goes through).
- A mismatch fails the call with `ERR_PERMISSION_DENIED`; Harbor never silently re-prompts on the site's behalf. The site must call `agent.requestPermissions()` again, which shows the prompt naming whatever backend is selected right then. The prompt is stamped with the backend it named when shown, not whatever's selected when it's answered — if the selection changes mid-prompt, the resulting grant is for the backend the prompt asked about, so it can still mismatch a different new live selection, and the site is correctly asked again rather than granted against the wrong backend.
- **Switching backends also ends work already running on the one being left**, not just changes what a later call uses: every live ACP-backed `window.ai` text session is destroyed (`page-api/acp-text-session.ts`'s `destroyAllAcpTextSessions`, triggered by a `storage.onChanged` listener in `background.ts`) — a later prompt on one gets the same `ERR_SESSION_NOT_FOUND` an explicit `session.destroy` already produces — and an in-flight ACP `agent.run` is cancelled with `ERR_AGENT_FAILED` / "The agent was changed." (`page-api/acp-backend-generation.ts`, combined into every ACP-backed run's own cancel signal). As defence in depth, a text session's own per-turn check also judges the grant against the backend it actually runs on, not a live read of the current selection.

### 5. Choosing the backend

- The sidebar gets an **Agent** panel, next to LLM Providers: a choice of *Harbor (built-in model)* or one of the configured ACP agents. Selecting an agent writes `harbor_agent_backend`; selecting the built-in choice clears it.
- Three presets ship together: goose (`goose acp`), Claude Code (`npx -y @agentclientprotocol/claude-agent-acp@0.108.1`) and Codex (`npx -y @agentclientprotocol/codex-acp@2.7.0`). Each uses the user's own install and account. A user can also add any other ACP agent as a custom entry (name, command, arguments).
- A preset — like a custom entry — is a start command only. It sets no approval mode and no environment; those stay the person's own, configured in the agent's own harness (section 3).
- When a preset is added, its bare command is resolved with the bridge's `acp.resolve_command`, and the absolute path is stored when the bridge found one; otherwise the bare command is kept, exactly as the preset ships. That keeps the saved record from depending on the person's shell `PATH` at `acp.open` time.
- **The environment line.** The Agent panel says: "Harbor starts agents without your shell environment. Give your agent's tools their keys in the agent's own settings." Each preset links its own settings docs for that: [goose](https://goose-docs.ai/docs/guides/config-files), [Claude Code](https://docs.anthropic.com/en/docs/claude-code/settings), [Codex](https://github.com/openai/codex/blob/main/docs/config.md).
- **The check.** Selecting an agent, or pressing "Check" next to a saved one, starts it the same way a real run would — `acp.open` with a fixed, non-site workspace, then `initialize` — and stops there: never `session/new`, since checking isn't running a turn. It shows "Ready (\<configured agent name\> vN)" on success — the name the person gave this agent in the sidebar, never the package name the agent itself reports in `agentInfo.name` (e.g. "Ready (Claude Code v0.108.1)", not the npm package the Claude Code ACP adapter happens to report) — or a plain error: "Command not found: \<command\>. Set the full path." for a spawn failure, or the protocol error unchanged for a failed handshake. The check never counts against any site's per-site agent cap (section 2): it isn't a site's agent, so it skips that accounting entirely rather than being exempted from it case by case.
- Every handler behind this panel (`acp_get_agents`, `acp_save_agents`, `acp_check_agent`, `acp_resolve_command`, `agent_backend_get`, `agent_backend_set`) refuses any sender that isn't one of Harbor's own extension pages — never a page, and never a content script, which reports the site's own URL even though its `sender.id` is Harbor's own. `acp_save_agents` controls what program the bridge runs next, so this matters more than an ordinary permission check.
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
5. **Per-site agent cap.** A site may have at most 2 live ACP agents at once (`agent.run` and `window.ai` text sessions counted together); over the cap fails with `ERR_AGENT_BUSY` before `acp.open`. A per-site limit tighter than this, or tiered by grant, is part of the still-open "what a site may ask the agent for" below, not decided here. The sidebar's own agent check (section 5) is exempt from this cap entirely — it isn't a site's agent.
6. **Policy classification.** A prompt sent to the person's own ACP agent is its own action, `model.prompt.agent`, modeled on `model.prompt.remote.firstParty` (the same effect and the same default): it's the user's own configured destination, just reached over ACP instead of a model call Harbor makes directly. It's no longer counted as a first-party remote model, so a rule can treat the two differently, and it's required before every `session/prompt` on either ACP path, through the same typed-action gate (`requireAction`) a page's own prompt and session calls already go through — reaching the rule engine and the audit log, not just Harbor's own consent store.
7. **Presets are start commands only.** goose, Claude Code and Codex each ship a command line (section 5) and nothing else: no approval mode, no environment. The agent's own harness decides how it works, same as a custom entry someone adds themselves.
8. **No environment-variable picker.** Harbor starts every agent with a clean environment (section 3's `INHERITED_ENV`) and says so plainly in the Agent panel, with a link to each preset's own settings docs for giving its tools their keys. There's no UI for setting environment variables on an agent from Harbor's side.
9. **`acp.resolve_command`.** A preset's bare command is resolved to an absolute path when the bridge can find one, and stored that way, so the saved agent doesn't depend on the person's shell `PATH` at `acp.open` time.
10. **An *allow* for `model:prompt`/`model:tools` does not carry over when the backend changes; a *deny* does** (decided 2026-11-19). An allow is scoped to the backend it was given for (`builtin` or `acp:<agentId>`) and only counts while that's still selected; switching backends doesn't erase it, it just stops counting, and allows for different backends are kept side by side rather than overwriting each other. A deny applies to the scope under every backend, with no per-backend exception, until the person grants again. Either way, a mismatch fails the call with `ERR_PERMISSION_DENIED` rather than Harbor silently asking again on the site's behalf; the site has to call `requestPermissions()` itself, which then shows the prompt naming the backend selected at that point. A grant made before this existed has no recorded backend and counts as `builtin`. Switching backends also destroys every live ACP text session and cancels any in-flight ACP `agent.run` on the backend being left (section 4).

Open by the maintainer's choice: **what a site may ask the agent for.** Protection from malicious sites, tiered grants and consent friction are deliberately undecided for now.

Proposed, and open to the maintainer's review on this proposal:

11. **Tools in the first release.** No Harbor or page tools are offered to the agent; it uses only its own.
12. **Backend choice.** One global setting in the sidebar, not per site.
13. **Working directory.** An empty directory per origin.
14. **`window.ai` on the ACP backend ignores `temperature`.** A page gets no signal that its option was dropped. The alternative is to report the backend, or which options apply, to the page, which would change the page-API contract.
15. **Positioning.** Once each agent works end to end, `docs/POSITIONING.md` can name it as tested. Today it names goose as the first target only. That copy change waits until the end-to-end unit is done.
