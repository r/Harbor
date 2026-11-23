# Page tools for the person's agent: design

Status: proposed, for maintainer review before it's built.

## Problem

A page registers tools with `document.modelContext.registerTool()` (or the
older `navigator.modelContext.addTool()`). Their handlers are JavaScript
functions in the page. Today only that page's own `window.agent.tools.list`
and `tools.call` can reach them. Harbor's background never hears about them,
so neither Harbor's built-in agent nor the person's own ACP agent can call
them.

Site-hosted MCP servers (`agent.mcp.register()`) already reach the agent: the
background connects to them for the built-in agent, and an ACP agent gets the
server's URL in `session/new` and connects to it directly. Page tools have no
URL. Their handlers can only run in the page.

## Decisions already made

- **Surface.** The calling page's tools go to the agent work that page starts:
  `agent.run()` and `agent.chat.open()`. `window.ai` text sessions stay
  tool-less. This is a deliberate v1 cut. Harbor has no chat the person
  starts: the sidebar's Agent panel only picks and configures the agent.
  Building one is its own subsystem (UI, session lifetime, consent copy) and
  is tracked separately. A site that wants a reader to ask about the page
  feature-detects Harbor and offers its own control that calls
  `agent.chat.open()`. Without Harbor, it shows nothing.
- **Which tab.** The tab that started the run or chat. It stays fixed when the
  person switches tabs. Tools from other tabs are never offered.
- **ACP transport.** The bridge hosts a per-session MCP endpoint on
  `127.0.0.1`, behind an unguessable token. Calls relay from the bridge to the
  extension and then to the tab's handler.
- **Spec shape.** `registerTool` follows the WebMCP draft (shipped in unit 1).

## Overview

```
page (injected.ts)         content script        background                   bridge (Rust)              ACP agent
──────────────────         ──────────────        ──────────                   ─────────────              ─────────
registerTool / abort ──sync──────────────────▶  page-tool registry
                                                 (tabId → origin, tools)
                                                         │
agent.run / chat.open ──────────────────────▶   gate: grants + policy
                                                 open endpoint ───────────▶  127.0.0.1:<port>/mcp/<token>
                                                 session/new { mcpServers: [page:<host> url] } ──────────────────────▶
                                                                                                         ◀── tools/list, tools/call
                                                 ◀── host_request page_tools.list / .call ──
                                                 gate: grant, allowlist, policy, budget, audit
handler(input,{signal}) ◀──call──── relay ◀──── call to tab
        └──result──────────────────────────────▶ result (untrusted) ──────▶  MCP result ─────────────▶
```

For Harbor's built-in agent, the same registry and gate feed the background's
tool loop directly. No bridge endpoint is involved.

## 1. Page to background: the registry

**Sync.** On each `registerTool`, `addTool`, `removeTool` or signal abort,
`injected.ts` sends `page_tools.sync` with the full current list:
`[{ name, description, inputSchema }]`. Sends are debounced to one per
microtask, so a page that registers ten tools at load sends one message.
Handlers never leave the page. A page with no tools sends nothing, so its
behavior is unchanged.

**Receiver validation.** The page is untrusted, so the background checks:

- only the top-level frame (`frameId === 0`) counts; subframe syncs are
  ignored;
- the origin comes from `sender`, never from the payload;
- at most 64 tools;
- names match the registerTool pattern (`[A-Za-z0-9_.-]{1,128}`);
- a description is at most 4 KB, and an `inputSchema` at most 64 KB
  serialized and must be a plain object.

A sync that fails validation is dropped as a whole, with a log line that
names no page-supplied content (`no-payload-logs.test.ts`).

**Registry.** `extension/src/mcp/page-tools.ts` keeps, per tab: the origin,
a document generation number, and the tool descriptors. A sync replaces the
tab's list.

**Lifetime.** A tab's entry is dropped when:

- the tab closes (`tabs.onRemoved`);
- the document goes away (a reload, a real navigation, same-origin included),
  because the handlers die with it. This is detected by the page's port
  disconnecting, the signal page chats use (`handlers/page-chat-handlers.ts`),
  **not** `tabs.onUpdated`'s `url` field, which site servers use. That field
  also fires for same-document hash and `pushState`/`replaceState` changes,
  which aren't navigations. A site that updates its address as the person
  reads would otherwise lose its tools mid-session. Tests cover a hash change
  and a `pushState` keeping the tools.

Each drop bumps the generation number. Calls carry the generation they
started under, so a result from an old document is never delivered as one
from a new document.

## 2. Gate

Page tools need **no grant of their own**. Site servers need
`mcp:tools.list` and `mcp:tools.call`, but those grants also let a page list
and call the person's installed MCP servers. Asking for them just so a page
can offer its own functions would over-ask, and the prompt would describe the
wrong thing. A page offering its own tools gains no reach it didn't already
have: it already writes the task text, and tool output is treated as untrusted
(§4). So page tools ride on the grant the page already needs to start
`agent.run` or `agent.chat.open()`.

At session start (list), the policy engine must allow `tool.list` for the
`page:<host>` server. If it doesn't, no page tools are offered (for ACP, no
endpoint is opened), and the refusal is written to the audit log.

At each call:

1. The site's tool allowlist names the tool, when the site has one.
2. The policy engine allows `tool.call` for `page:<host>`.
3. The session's tool budget has room. A refused call spends no budget,
   which matches the existing rule.
4. The audit log records the call and its outcome.

**Names.** The person sees where a tool came from:

- On the built-in agent, a page tool is named `page:<host>/<tool>`, beside the
  existing `site:<host>:<name>/<tool>`.
- On ACP, the MCP server is named `page:<host>`, and its tools keep their bare
  names. Each agent shows server and tool together in its own way.

`<host>` includes a non-default port, as site server names do.

## 3. Calling into the tab

The background sends `page_tools.call { callId, generation, name, input }` to
the tab's top frame. The content script relays it to `injected.ts` with
`postMessage`, using the same channel and checks the page API uses today.
`injected.ts`:

- looks the tool up by name, with no `page/` prefix rules;
- runs `execute(input, { signal })`, where `signal` aborts when the agent
  cancels, the session ends, or the call times out;
- replies with `{ callId, ok, result | error }`.

A result must survive structured cloning and is capped at 1 MB serialized.
Anything larger fails with `ERR_TOOL_FAILED`.

A call fails with `ERR_TOOL_FAILED` and is never retried when:

- the tab closes or navigates while the call is in flight;
- the handler throws (the message is passed on, truncated to 1 KB);
- no reply arrives within 60 seconds. The call then aborts the page's signal.

The page doesn't see that the agent called a tool, except through its own
handler running. That matches how `tools.call` works today.

## 4. Untrusted output

A tool result is page content, like a browser capture:

- the built-in agent gets it as a tool-result message, never as system or
  developer content, with no extra framing that would raise its authority;
- an ACP agent gets it as MCP `content: [{ type: 'text', text }]`; non-string
  results are JSON-stringified into `text` and also sent as
  `structuredContent` when the result is a plain object;
- Harbor never puts page-tool output into the "working for you" preamble or
  any other Harbor-authored text.

## 5. The bridge endpoint (ACP only)

**Lifetime.** The endpoint is per ACP session:

- the background asks the bridge to open one (`page_tools.open`) just before
  `session/new`. A page-started run first waits for any `page_tools.sync` the
  page has already queued, so tools registered just before the call aren't
  missed. The page flushes its debounced sync before sending `agent.run` or
  `chat.open`.
  The endpoint is opened only if the gate passed, the tab has at least one tool,
  and the agent's `initialize` reply declares `mcpCapabilities.http`;
- it closes the endpoint when the session ends, the run is cancelled, or the
  page chat closes. Dropping the tab's tools closes it too.

Closing is idempotent. If the bridge exits, every endpoint goes with it, as
do the ACP agents it started.

**Server.** It is a minimal MCP *streamable HTTP* server, written with the
`axum` the bridge already uses. It listens on one listener the bridge opens
lazily, bound to `127.0.0.1:0` (an OS-chosen port). It is separate from the
Safari `--http-server` mode, which binds a fixed port.

- Its URL is `http://127.0.0.1:<port>/mcp/<token>`. The token is 32 random
  bytes, base64url-encoded, and the bridge keeps a map from token to
  endpoint ID.
- It handles `POST` with JSON-RPC: `initialize`, `notifications/initialized`,
  `ping`, `tools/list` and `tools/call`. Responses are plain
  `application/json`; the spec allows that, so no SSE is needed.
- `GET` returns 405, so no server-initiated stream exists in v1. `DELETE`
  ends the MCP session.
- The bridge holds no tool state. `tools/list` and `tools/call` become
  `host_request`s to the extension (`page_tools.list` and
  `page_tools.call`, keyed by endpoint ID). This uses the channel JS MCP
  servers already use to ask the host for something. The extension's answer
  is the response.

**Checks the bridge makes on every request:**

- the path token matches a live endpoint, compared in constant time;
  otherwise 404;
- `Host` is `127.0.0.1:<port>` exactly. That blocks DNS rebinding.
- a request with any `Origin` header gets 403. No web page can call it, even
  cross-origin with a simple request.
- `Content-Type` is `application/json`, and the body is at most 1 MB;
- the token never appears in a log line.

**Extension side.** `host_request` handling accepts `page_tools.*` only from
the bridge's own context, and only for an endpoint ID the background opened
and still holds. It maps that ID to `{ origin, tabId, generation, session }`.
A request for an ID that has gone away gets an MCP error result.

**Who else can reach it.** Any local process that learns the token. The
token goes only into the agent's `session/new`, so the exposure is the
agent's own: a process that can read the agent's memory or traffic could
already act as the agent. Other local users can't guess the token.

## 6. Known limits

- **Tools registered after the session starts.** Without a server-initiated
  stream there's no `notifications/tools/list_changed`, so an agent that
  caches `tools/list` won't see the new tools until its next session. Calls
  to tools removed since the list was taken fail cleanly. Adding a `GET`
  stream for `list_changed` is a follow-up if a real agent needs it.
- **Agents without HTTP MCP.** An agent whose `initialize` reply doesn't
  declare `mcpCapabilities.http` gets no page tools, and a log line names the
  agent. A stdio shim is the fallback if goose or Claude Code turn out to
  lack it; this is checked with a real agent during the build.
- **Page chat sessions.** A chat keeps one agent session. Page tools reach it
  through the endpoint, which lists the tab's tools at call time, so tools
  registered later reach that session for agents that re-list. Site MCP
  servers in page chat remain a separate open question.

## 7. Build units

1. ~~Spec method names~~ (done).
2. Registry and sync: `injected.ts` sync, `mcp/page-tools.ts`, lifetime
   hooks, and receiver validation. Unit tests: validation, replace, tab close,
   navigation, generation.
3. Gate and the built-in agent: page tools in the built-in `agent.run` loop
   as `page:<host>/<tool>`, with call relay to the tab, timeouts and
   in-flight failure. Unit tests for gating and audit, and an e2e round trip
   in Firefox.
4. Bridge endpoint: an axum listener, the token map, `page_tools.open` and
   `page_tools.close` RPCs, and the host_request relay. Cargo tests for each
   check in §5.
5. ACP wiring: open the endpoint before `session/new` in `agent.run` and page
   chat, and close it on every end path. Unit tests, then a check with Claude
   Code in Firefox.
6. Demo and docs: a `demo/` page that registers with both `registerTool` and
   `addTool`; `WEB_AGENTS_API.md`, `LLMS.txt`, `BUILDING_ON_WEB_AGENTS_API.md`
   ("page tools never leave the page" stops being true) and `PERMISSIONS.md`.

The estimate is 1,500–2,500 changed lines, about half of them tests.
