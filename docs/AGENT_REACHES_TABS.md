# Your agent reaches into the browser: design

Status: proposed, for maintainer review before it's built.

## Problem

The person talks to their own agent (goose, Claude Code, Codex) outside the
browser. Often they reached a page *from* that agent, so the conversation is
already under way. The agent should be able to open a page and use the tools
that page offers (`document.modelContext`), without the page hosting a chat or
an Ask button.

Example: goose finds a passage through a book site's MCP server and opens it
in the browser. The person presses play. Later they ask goose to pause, and
goose calls the page's `pause` tool.

[PAGE_TOOLS_FOR_AGENTS.md](PAGE_TOOLS_FOR_AGENTS.md) already gives a page's
tools to the agent work *that page* starts. This design covers agent work that
starts *outside* the browser. It reuses the page-tool registry, the policy gate
and the call relay from that design.

Browser control (clicking and filling) is out of scope. It stays the stopgap.
This is the page's own tools only.

## Overview

```
your agent (goose)                 harbor-mcp (stdio)        bridge                     extension             tab
──────────────────                 ──────────────────        ──────                     ─────────             ───
MCP over stdio ───────────────────▶ relays to the bridge's ──▶ agent session  ──host_request──▶ agent tabs ──▶ page tools
  open_page(url)                     Unix socket (0600)        (holds no tool state)            registry       (HBR-148 relay)
  list_pages()
  list_page_tools(page)
  call_page_tool(page, tool, input)
```

## 1. How the agent connects (decision)

**Proposed: a stdio MCP server, `harbor-mcp`, installed with the bridge.**

- The person adds Harbor to their agent the way they add any MCP server, with
  a command. Every MCP client supports stdio servers.
- `harbor-mcp` relays MCP messages to the running bridge over a Unix socket at
  `~/.harbor/agent.sock`. The socket is created with mode `0600` in a `0700`
  directory, so only the person's own user account can connect. That's the
  authentication: no port, no token, nothing to copy.
- When Firefox isn't running, the bridge isn't either. `harbor-mcp` then
  answers every call with a clear error ("Firefox with Harbor isn't running").
  It doesn't fail to start, so the agent's config stays valid.
- The sidebar's Agent panel shows the snippet to paste into each agent's
  config: goose, Claude Code and Codex.

Alternatives:

- **A fixed localhost HTTP port with a bearer token** (like HBR-148's
  endpoint, but standing). Any local process can reach the port, so it needs a
  token stored somewhere the agent's config can read. More to set up and more
  to leak.
- **Harbor starts the agent over ACP**, as HBR-148 does. That's the reverse of
  this case: here the person's agent is already running and the conversation
  lives there.

Unix sockets cover macOS and Linux. Windows (a named pipe) is left for later.

## 2. What the agent sees (decision)

**Proposed: four general tools, plus the page tools behind them.**

| Tool | What it does |
| --- | --- |
| `open_page(url)` | Opens `url` in a new tab, brought to the front so the person can see it and press play. Returns a `page` handle. |
| `list_pages()` | The pages this agent may use, with handle, URL, title and whether they offer tools. |
| `list_page_tools(page)` | The page's tools: name, description and input schema. |
| `call_page_tool(page, tool, input)` | Runs the tool in the page and returns its result as untrusted output. |

Why general tools, rather than each page tool as its own MCP tool:

- Page tools come and go as the person navigates. Listing them as first-class
  MCP tools needs `notifications/tools/list_changed`, and agents handle that
  unevenly. Many cache the list for the whole session.
- With general tools, the agent asks what a page offers whenever it needs to,
  so the answer is always current.

Each page tool becoming a first-class MCP tool can come later, for agents that
handle `list_changed` well.

## 3. Which tabs (decision)

**Proposed: tabs the agent opened, plus tabs the person shares.**

- **Opened by the agent:** a tab the agent opened with `open_page` is the
  agent's for as long as it stays on the same site. It stays usable after
  same-site navigation, but not once the tab moves to another origin. The
  person asked the agent to go there, so no prompt is needed.
- **Shared by the person:** a "Share this tab with your agent" action in the
  sidebar adds a tab the person opened. Sharing lasts until the tab closes or
  moves to another origin.
- **Not visible:** any other tab. `list_pages` doesn't show it, and a handle
  can't be guessed.

Alternative: **the active tab, always.** It's convenient ("pause the one I'm
on"), but anything the person has open in front could be reached by any agent
they've connected. That's too broad as a default.

## 4. Consent (decision)

**Proposed:**

- **Connecting is the consent to use the browser at all.** Adding `harbor-mcp`
  to an agent's config is the person's act, and the sidebar shows connected
  agents. A setting, "Let agents outside the browser open pages", is off until
  the person turns it on in the Agent panel. Until then every call gets a clear
  error saying where to turn it on.
- **Per tab:** opened by the agent, or shared by the person (§3).
- **Per site:** the page offered its tools. They get the same gate as page
  tools and site tools (HBR-156): no grant of their own, a policy check on
  `tool.call` for `page:<host>` on every call, the audit log, and output
  treated as untrusted. A policy rule can turn a site off for outside agents.
- **Budget:** there's no run to bound calls, so a per-connection rate limit
  (for example 60 calls a minute) keeps a runaway agent from hammering a page.

## 5. Lifetime

- A `page` handle is scoped to the agent's connection. A new connection sees
  the agent's own still-open tabs again: it can list them, so it can recover
  after a restart.
- A handle stops working when its tab closes or moves to another origin.
  Calls then fail with a clear error.
- Page tools keep HBR-148's lifetime. A reload ends the old document's tools.
  The new document's tools appear when it registers them, so the agent calls
  `list_page_tools` again.
- Closing the connection doesn't close the agent's tabs. They're the person's
  tabs now.

## 6. Build units

1. **Bridge:** the `~/.harbor/agent.sock` listener (Unix-only) and the
   `harbor-mcp` stdio binary that relays to it. Cargo tests cover the socket
   permissions, refusal when the setting is off, the "Harbor isn't running"
   errors, and the relay.
2. **Extension, the agent tabs registry:** open and share, origin pinning,
   handles, list and call through HBR-148's registry and gate, and the rate
   limit. Unit tests.
3. **Extension, settings and UI:** the setting, the connect snippet, the list
   of connected agents, and "Share this tab". Following the calm design rules.
4. **e2e and a real goose check:** goose opens the Page Tools demo, the person
   presses play, goose pauses it. Plus docs: WEB_AGENTS_API, PERMISSIONS,
   LLMS.txt and the changelog.

## Out of scope

Clicking and filling pages; the person's installed MCP servers (unchanged);
site MCP servers through this route (HBR-156 can add them to
`list_page_tools` later); Windows.
