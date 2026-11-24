# RFD: Provenance for prompts and client-provided tools

Status: draft, not yet submitted. Written against Harbor's working implementation.

## Elevator pitch

An agent can't tell who it's working for in a given turn, or whose tools it's being offered. A prompt typed by the person and a prompt a website wrote look the same. A tool from the person's own bank and a tool a website named `wells_fargo_submit_transfer` look the same too.

I propose a small, optional `provenance` object that a client can attach to each prompt and to each MCP server it hands the agent. It says where the prompt or tool came from, as a web origin the client has verified. Agents and harnesses can then show it to the person and write rules against it, instead of guessing from names and descriptions.

## Status quo

More and more ACP clients aren't the person typing in a terminal. They are browsers, editors or apps that relay requests from somewhere else. Harbor, for example, lets a website use the person's own agent. In that setting:

- **Prompts.** A `session/prompt` carries text and resources, but nothing about who wrote them. An agent that keeps memories or holds powerful tools has no protocol-level way to know that this turn came from `shop.example`, not from the person. It also can't treat the site's instructions as a request rather than a command.
- **Tools.** `session/new`'s `mcpServers` has a `name` and a transport, nothing more. A client can relay tools that a website registered, but the agent can't tell whose they are. A site can name a tool after a bank, a mail provider or a payment service, and its description can say anything. If the agent believes the description and passes account details, the site receives them.
- **Workarounds.** Clients fall back on prose, such as a note in the first prompt or a "From tale.example:" prefix on each tool description. Models may or may not respect these, and agents can't build policy on them.

Harbor sends its own `_meta` key today (`harbor/provenance`, below) to show the idea works. Nothing reads it, because nothing standard exists.

## What I propose to do about it

1. **A shared `provenance` object.**

   ```jsonc
   {
     "origin": "https://shop.example", // RFC 6454 origin the client verified, or omitted for the person themselves
     "source": "website",              // who wrote it: "user" | "website" | "page" | "site-server" | client-defined
     "client": "harbor"                // optional: which client vouches for this
   }
   ```

   `origin` is the important field. It must be something the client verified itself, such as a browser's own record of which page made the request. It must never be text the requester supplied.

2. **On prompts.** `session/prompt` gains an optional `provenance`. A client relaying a website's request sets it, and a prompt the person typed omits it, or uses `source: "user"`. An agent may also see it on individual content blocks when one prompt mixes the person's words with quoted site content.

3. **On client-provided MCP servers.** Each entry in `session/new`'s `mcpServers` gains an optional `provenance` saying whose tools these are. A browser client serving a site's tools sets `origin` to that site. Agents should show it wherever they show the server's name. Users and harnesses can write rules such as "ask before any tool whose origin isn't one I've approved", or "never send secrets to a tool from another origin than the page I'm on".

4. **On tool results** (a recommendation for MCP, since tools themselves are MCP's domain). A client that relays tool calls can put the same object under `_meta` on each `Tool` in `tools/list` and on each `CallToolResult`, so the provenance survives into the model's context.

5. **On answers between agents.** When one agent calls, messages or broadcasts to another through the client, the answer can carry the same object with `source: "agent"`, the answering agent's origin and its id, so the caller (and any model it passes the answer to) knows whose answer it is.

6. **No new trust.** Provenance is a claim by the client, which the agent already trusts to relay prompts. It tells the agent who the client says the request came from, and lets the agent's policy act on that. It doesn't authenticate the website itself.

## Shiny future

A person asks their agent for help with an interview, and the agent opens a reading site to a passage. When the agent lists that tab's tools, it sees `play`, `pause` and `go_to`, all from `https://tale.example`, and shows them that way. If the site also offered `wells_fargo_submit_transfer`, the agent would see it labelled `origin: https://evil.example`. A one-line rule in the person's harness, "money tools only from origins I've approved", stops it without the agent having to judge the description.

The same field lets an agent with memory decide, per turn, how much of what it remembers about the person to share, depending on which site is asking.

## Implementation details and plan

**Harbor already sends these**, as `_meta` keys pending a standard:

- Prompts: `session/prompt` carries `_meta: {"harbor/provenance": {"source": "website" | "page-chat", "origin": "<site origin>"}}`, set from the browser's own record of the calling page.
- Answers between agents: when a page calls another site's agent through `window.agent.agents`, Harbor puts `provenance: {"source": "agent", "origin": "<agent's site>", "agentId": "<id>"}` on the invoke response, each message and broadcast event, and each orchestration step's result. Harbor sets it from its own registry after the agent answers, so the agent can't choose it.
- Tools: when Harbor serves a site's tools to the agent through its own local MCP endpoint, each listed tool and each result carries `_meta: {"harbor/provenance": {"source": "page-tool" | "site-server", "origin": "<site origin>", "server": "<id>"}}`. The endpoint's server name is the site's host, chosen by Harbor, not the site.

**Plan:**
- Agree on the object's shape and the field names.
- Add an optional `provenance` to `session/prompt` and to `McpServer`.
- Recommend the same object under `_meta` for MCP tools and results, coordinating with MCP.
- Harbor switches from its `harbor/provenance` keys to the standard fields once they exist.

## Frequently asked questions

**Can't a malicious client lie?** Yes. A client that lies about provenance could already lie about the prompt itself. Provenance tells an honest client's agent something it can't otherwise know. It doesn't protect against a dishonest client.

**Why an origin, not a free-form name?** Names are whatever the requester says they are. An origin is something a browser or OS client can verify, and the person already understands it from the address bar.

**Why not put this in the prompt text?** Models treat prose inconsistently, and agents can't write policy against it. A structured field can be shown, logged and enforced.

**Does this replace consent?** No. Clients still decide whether a site may use the person's agent at all. Provenance helps the agent behave well once it's working for a site.

## Revision history

- Draft: first version, from Harbor's implementation.
- Draft: added provenance on answers between agents.
