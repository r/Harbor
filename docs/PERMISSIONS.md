# Permissions in Harbor

**The model, the developer surface, and the user experience.**

This document describes Harbor's permission system: how it decides whether an agent action is allowed, how site authors and extension contributors work with it, and what the human at the keyboard actually sees.

---

## Who this is for

| If you are... | Read |
|---|---|
| Curious about the design | [Part 1: How it works](#part-1-how-it-works) |
| Building a website that uses `window.ai` / `window.agent` | [Part 2: For site authors](#part-2-for-site-authors) |
| Hacking on Harbor itself | [Part 3: For extension contributors](#part-3-for-extension-contributors) |
| Using Harbor as your browser AI | [Part 4: For users](#part-4-for-users) |

---

## Why this exists

Every browser AI system eventually runs into the same wall: prompts. The first time a site asks to talk to your AI, you read carefully and click "allow." The hundredth time, you've already moved on. Anthropic reported that Claude Code users approve 93% of permission prompts — at that point the prompt is friction without protection.

Harbor's permission system is built around a different assumption: **most decisions should be made without a prompt, but the consequences of being wrong should be small.** That requires four things working together:

1. A **typed, declarative policy** so the user (or their org) can decide once, in advance, what's fine — and so a tool can statically reason about what a policy will do.
2. **Asymmetric defaults** so reading is cheap, persisting reads is opt-in, and writing is expensive.
3. **Information-flow labels** so sensitive data can't be sent somewhere that shouldn't receive it. Today a label comes from the call itself; carrying a label from one call's output to the next call's input is designed but not built (see [Information-flow labels](#information-flow-labels)).
4. A **safety net** — sensitivity gates, watchdog containment, and a non-bypassable enforcement chokepoint — that catches misbehavior automatically before a human has to react.

This guide describes what Harbor does today. Where the design goes further than the code, the text says so.

The system is **provider-agnostic**: permissions are expressed in terms of *effect* (local prompt vs remote prompt, same-origin egress vs cross-origin egress, reversible vs irreversible) rather than vendor brand. Whether you're using Firefox-ML, Chrome's on-device Gemini Nano, Ollama, OpenAI, or Anthropic, the same policy applies; the provider is metadata, not part of the permission name.

---

# Part 1: How it works

## The mental model

Nearly every API call from a website that reaches a model, a tool, the browser or another agent goes through a single chokepoint: the **PolicyEngine** (the exceptions are listed under [Page calls](#page-calls)). The engine answers one question per call:

> Given this **principal** (origin, and whether the caller is a subagent, though no caller sets that yet), this typed **action** (`model.prompt.remote.thirdParty`, `tool.call`, `network.egress.cross_origin`, …), this **resource** (a tool, a host, the labels the input carries), and this **context** (watchdog state, destination locality, reversibility) — should this action be allowed, denied, previewed, or asked about?

It answers by walking a **tier ladder**, top to bottom, returning the first decisive answer.

```
Page calls window.ai or window.agent
            │
            ▼
   ┌────────────────────────────────────────────┐
   │   PolicyEngine                             │
   │                                            │
   │   Tier 0  Known action ────────────────────► deny  (an action Harbor doesn't define)
   │   Tier 1  Managed deny ────────────────────► deny  (org policy)
   │   Tier 2  Sensitivity gate ────────────────► attach labels; irreversible writes need at least a preview
   │   Tier 3  Information-flow check ──────────► deny  (input carries a label the action doesn't accept)
   │   Tier 4  Watchdog containment ────────────► ask / deny
   │   Tier 6  Most cautious matching policy rule ─► allow
   │   Tier 7    (same lookup, any other effect) ──► ask / preview / deny
   │   Tier 8  Per-origin grant ────────────────► allow / deny / ask / preview
   │   Tier 9  Default for action's effect ─────► allow (metadata) / ask (read, egress) / preview (write)
   └────────────────────────────────────────────┘
            │
            ▼
   audit  +  watchdog  +  execute
```

One important property of this ladder: **the managed deny, information-flow and watchdog checks always run, above policy rules.** A deny from Tier 1, 3 or 4 can't be overridden by an `allow` rule or a grant. Tier 2's preview for irreversible writes is weaker: on a page call, the site's origin grant or a matching `allow` rule answers it without a prompt (see [Page calls](#page-calls)).

Tiers 6 and 7 are one step: within one source's rules (managed, then user — see Precedence below), the engine finds every rule that matches and takes the most cautious effect, deny > preview > ask > allow; the first source with any matching rule decides. It numbers the decision 6 if that effect is `allow` and 7 otherwise (an `allow` rule that Tier 2 raises to a preview is 7). Tier 5 was a capability-token check that nothing used; it was removed and the other numbers kept.

## Typed actions and effects

Every call is described by a **typed action** of the form `verb.noun.qualifier`. Internally, the engine works only in this form, and that's also what site authors and policy authors should use.

The typed namespace is organized by what the action actually does. These are all the actions in `extension/src/policy/actions.ts`:

| Action | What it does | Effect |
|---|---|---|
| `model.list` | Enumerate available providers and models | metadata |
| `model.prompt.local` | Prompt a model on this device (Firefox-ML, Chrome AI, Ollama, llamafile, Apple's on-device model) | read |
| `model.prompt.remote.firstParty` | Prompt a remote provider the person configured | egress |
| `model.prompt.remote.thirdParty` | Prompt a remote provider the person doesn't control | egress |
| `model.prompt.agent` | Prompt the person's own agent over ACP, instead of a model Harbor calls directly | egress |
| `tool.list` | Enumerate MCP tools | metadata |
| `tool.call` | Invoke an MCP tool | write, irreversible |
| `mcp.server.register` | Connect a site's own MCP server | write |
| `browser.read.activeTab` | Read the active tab's text | read |
| `browser.read.element` | Read specific elements of the active tab | read |
| `browser.read.screenshot` | Capture a screenshot of the active tab | read |
| `browser.read.tabs` | List open tabs | read |
| `browser.write.interact` | Click, fill, select or scroll on the active tab | write, irreversible |
| `browser.write.navigate` | Navigate the active tab | write |
| `browser.write.tabsCreate` | Open, read or close a tab the site opened | write |
| `network.egress.same_origin` | Fetch from the requesting site's own origin | egress |
| `network.egress.cross_origin` | Fetch from another origin | egress |
| `agent.register` | Register the site's agent | write |
| `agent.discover` | List agents the site can reach | metadata |
| `agent.invoke` | Invoke another agent on this device | write |
| `agent.message` | Message another agent on this device | write |
| `agent.delegate.crossOrigin` | Invoke or message an agent from a different site; granted per target site | egress, irreversible |
| `agent.delegate.remote` | Invoke a remote A2A agent | egress, irreversible |
| `agent.run` | A built-in agent run. Nothing checks the run itself; its tool listing, prompts and tool calls are checked one by one | metadata |
| `chat.open` | Open Harbor's chat on the page | write |

Every action carries metadata:

```ts
type ActionMeta = {
  title: string;
  description: string;
  effect: 'metadata' | 'read' | 'egress' | 'write' | 'identity' | 'destructive';
  locality: 'local' | 'same_origin' | 'cross_origin' | 'network_first_party' | 'network_third_party';
  reversible: boolean | null;       // null: not a write
  defaultDataLabels: DataLabel[];   // labels this action's *output* carries
  acceptsLabels: DataLabel[];       // labels this action's *input* may carry
  defaultTTL: 'one_call' | 'session' | 'until_origin_unloads' | 'until_user_revokes';
};
```

`defaultDataLabels` and `acceptsLabels` are how information-flow tracking plugs in (next section). `defaultTTL` records how long a grant for the action is meant to last, but nothing reads it yet: a grant lasts as long as the person chose in the prompt (see [Grants](#grants)).

### Effect tiers and the asymmetry of defaults

| Effect | Examples | Default (Tier 9) |
|---|---|---|
| **metadata** | `model.list`, `tool.list`, `agent.discover`, `agent.run` | Allow. A rule, a denied grant or the watchdog can still refuse it or make it ask, since the default comes last. |
| **read** | `model.prompt.local`, `browser.read.activeTab`, `browser.read.screenshot` | Ask |
| **egress** | `network.egress.cross_origin`, `model.prompt.remote.thirdParty`, `model.prompt.agent` | Ask |
| **write** | `browser.write.interact`, `browser.write.navigate`, `tool.call` | Preview |
| **destructive**, **identity** | None yet | Preview |

A write the action metadata marks irreversible (`tool.call`, `browser.write.interact`) needs at least a preview even when a rule or grant would allow it (Tier 2). Both are only checked on page calls, where the origin grant or a matching `allow` rule answers that preview; see [Page calls](#page-calls).

The `destructive` and `identity` effects exist in the type, and rules can name them, but no action uses them yet. A tool call is `write` whatever the tool does.

### Grants

When the engine asks, the person answers in Harbor's permission prompt, which offers **This time only** (the default) or **Always allow**, then **Allow** or **Deny**:

- *This time only* lasts ten minutes, in the tab that asked. Another tab on the same site is asked again.
- *Always allow* lasts until the person revokes the site in the sidebar.
- *Deny* is remembered until revoked when the prompt came from `agent.requestPermissions()`. A prompt the engine raises on its own (an `ask` rule, a watchdog restriction, a page's chat) stores only a grant; denying it refuses that one call and stores nothing.

Persisting a grant only after repeated trusted use, and a separate session-length grant, are designed but not built.

## Information-flow labels

The design's central idea is **labels that follow data**: when the engine sees a read of sensitive content, it tags the result with a label, and when that data is later about to leave the machine, the engine checks the labels against the destination.

The label set, in order of severity:

| Label | Meaning |
|---|---|
| `credentials` | Passwords, tokens, API keys |
| `payments` | Card numbers, bank details, payment pages |
| `identity` | Sign-in and account pages, identity documents |
| `regulated` | Health and other regulated data |
| `confidential` | Content the person or their organization treats as private |

**What's built.** The engine works out a call's labels at Tier 2 from the call itself:

- **A host**, through a built-in list in `sensitivity.ts`: sign-in providers (Google, Microsoft, Apple, Okta) carry `credentials` and `identity`; Stripe and PayPal carry `payments`, and bank-like names carry `payments` and `identity`; Gmail, Outlook, Slack, Notion and Google Docs carry `confidential`; patient-portal names carry `regulated` and `identity`. There's no setting to extend the list. Page browser calls record their host without classifying it (see [Page calls](#page-calls)). The one call that does classify its host, a remote A2A agent (`agent.delegate.remote`), has no page entry point, so in practice no call's host is classified today.
- **A tool's manifest**, from its `riskTags` (`credentials`, `payments`, `identity`, `regulated`, `confidential` and a few synonyms), or, with no tags, from a tool name that suggests secrets or payments. No caller passes a tool manifest to the engine yet.
- **The input's own labels**, when the caller supplies them. No caller does yet.

At Tier 3, the engine compares those labels with the action's `acceptsLabels` and denies the call with `ERR_LABEL_FLOW_BLOCKED` if it carries any label the action doesn't accept. There's no "ask" outcome here. What each action accepts is fixed in `actions.ts`: `model.prompt.local` accepts every label, `browser.write.interact` accepts `credentials` and `payments` (so a page can be filled in), `model.prompt.remote.firstParty`, `model.prompt.agent` and `network.egress.same_origin` accept `confidential`, and every other action accepts none.

**Not built yet.**

- Carrying a label from one call's output to a later call's input, across a session or an agent run. The engine computes an output label set for each decision, but nothing passes it on.
- Labelling page content as it's read (a password field in the page text, a `<meta name="harbor:confidential">` tag). The element classifier in `sensitivity.ts` exists but the engine doesn't call it.
- Per-destination exceptions in the policy file, such as letting `confidential` data reach one company's API.

So Tier 3 never fires today, and a site can't yet be stopped from reading a sensitive page and sending what it read somewhere else, unless a rule, a grant or the watchdog stops it. A page's calls never see `ERR_LABEL_FLOW_BLOCKED`.

## The policy file

`harbor-policy.json` is a declarative document the user (or an organization) writes once. The engine reads two copies: a **managed** policy from the browser's managed storage under the key `policy` (Firefox `policies.json` or MDM; Chrome needs a `storage.managed_schema` in the extension's manifest, which Harbor doesn't declare yet), and a **user** policy from the extension's local storage, under `harbor_policy_v2`. Nothing in Harbor writes the user policy yet: there's no editor, import or export.

The schema is **typed**: every rule is `{id, effect, principal, action, resource, context}` (`extension/src/policy/rules.ts`).

- `effect` is `allow`, `ask`, `preview` or `deny`.
- `principal` is `{ origin }`, with `*` and suffix wildcards such as `*.github.com`.
- `action` is one typed action, an array of them, a glob such as `browser.read.*`, or an effect class such as `{ "effect": "egress" }`.
- `resource` matches `server`, `tool`, `host` and `path`, with wildcards. It also accepts `toolTags` (a tool manifest's `riskTags`), but no caller passes a manifest yet, so a `toolTags` rule never matches.
- `context` matches `hasAnyLabel`, `hasAllLabels`, `destinationLocality`, `reversible` and `trustedManifest`.

```jsonc
{
  "version": 2,
  "rules": [
    {
      "id": "reader-default",
      "effect": "allow",
      "principal": { "origin": "https://docs.example.com" },
      "action": ["model.prompt.local", "browser.read.activeTab"]
    },
    {
      "id": "block-labelled-egress",
      "effect": "deny",
      "principal": { "origin": "*" },
      "action": { "effect": "egress" },
      "context": { "hasAnyLabel": ["credentials", "payments", "identity"] }
    },
    {
      "id": "ask-before-github-tools",
      "effect": "ask",
      "principal": { "origin": "https://app.example.com" },
      "action": "tool.call",
      "resource": { "server": "github" }
    },
    {
      "id": "no-fetch-to-tracker",
      "effect": "deny",
      "principal": { "origin": "*" },
      "action": "network.egress.cross_origin",
      "resource": { "host": "*.tracker.example" }
    }
  ]
}
```

The document type also declares `pinnedManifests` and `trustedPublishers`, but nothing reads them yet (see [Trusted vs untrusted manifests](#trusted-vs-untrusted-manifests)). Settings the design describes — `trustedOrigins`, `sensitiveDomains` and per-session or per-origin `budgets` — don't exist.

**Short string forms.** `allow`, `ask`, `preview` and `deny` arrays accept short strings, compiled to typed rules at load time:

| String form | Compiles to |
|---|---|
| `Tool(*)` | `{action: "tool.call"}` |
| `Tool(github.create_issue)` | `{action: "tool.call", resource: {server: "github", tool: "create_issue"}}` |
| `Tool(github.*)` | `{action: "tool.call", resource: {server: "github", tool: "*"}}` |
| `Tool(github)` | `{action: "tool.call", resource: {server: "github"}}` |
| `Tool(*:remote_write)` | `{action: "tool.call", resource: {server: "*", toolTags: ["remote_write"]}}` (never matches yet; see `toolTags` above) |
| `Read(*.example.com)` | `{action: {effect: "read"}, resource: {host: "*.example.com"}}` |
| `Egress(third_party)` | `{action: {effect: "egress"}, context: {destinationLocality: ["network_third_party"]}}` |
| `Browser.Write(*)` | `{action: "browser.write.interact"}` (clicks and fills only) |
| `Browser.Write(*.example.com)` | `{action: ["browser.write.interact", "browser.write.navigate", "browser.write.tabsCreate"], resource: {host: "*.example.com"}}` |

`Egress` takes `local`, `same_origin`, `cross_origin`, `first_party` or `third_party`. Short strings apply to every origin; write a typed rule to scope one to a site.

One more short form, `Prompt(local|first_party|third_party|agent)`, targets one kind of prompt by name. `Prompt(*)`, or any other argument, compiles to all four actions together — including `model.prompt.agent` — so a person's "deny every prompt" rule covers a prompt sent to their own ACP agent too, not just Harbor's own model calls.

**Precedence.** Sources merge in this order, with later sources unable to override earlier ones:

1. Managed (org policy via MDM / browser admin)
2. User policy file (`harbor-policy.json`)
3. Per-origin grants ("Allow always" / "Allow once" decisions remembered from prompts)

Within a single document, the engine considers every rule that matches the request — short-form arrays and typed `rules` alike — and the most cautious effect wins: **deny > preview > ask > allow**. A narrow `allow` can't carve an exception out of a broader `deny` in the same document, whichever order they're written in. Order only breaks a tie between two matching rules of the *same* effect: it picks the first in the document (short-form `deny`, then `ask`, then `preview`, then `allow`, then typed `rules` in the order written), so a rule's id stays stable across loads. Only *across* sources does order matter: the first source with any matching rule decides — managed before user, user before origin grants — and only within that source does the most-cautious rule apply. A managed deny (Tier 1) is still guaranteed to win over anything in the user document or an origin grant.

## Sensitivity gates and tool manifest provenance

Tier 2 does two things on every call: it attaches the labels described under [Information-flow labels](#information-flow-labels), and it requires at least a **preview** for a write whose action is irreversible (`tool.call`, `browser.write.interact`), for a `destructive` action, and for a write that carries an untrusted tool manifest. A rule or grant that allows such a call still gets a preview. Page calls are the exception described under [Page calls](#page-calls).

The classifiers in `extension/src/policy/sensitivity.ts`:

| Classifier | What it looks at | Wired in? |
|---|---|---|
| **Domain** | The call's host, against a built-in list (sign-in providers, payment sites and bank-like names, mail and document sites, patient portals) | Yes, where the host is classified |
| **Tool** | A tool manifest's `riskTags`, or with no tags a name suggesting secrets or payments | Yes, but no caller supplies a manifest yet |
| **Element** | Password, card-number and identity form fields | No: the engine doesn't call it yet |

They attach labels. They don't make the engine ask by themselves.

### Trusted vs untrusted manifests

The MCP spec says tool descriptions and annotations are untrusted unless the server is trusted. Harbor's `trustManifest` (`manifest-trust.ts`) decides that from where the manifest came from:

1. **Bundled** with Harbor.
2. **Installed locally** by the person.
3. **Signed** by a publisher in the `Publishers` registry.
4. **Pinned** in the `Pins` registry, by server id and exact manifest hash.

Anything else, including a manifest a page declares or Harbor fetched, is untrusted. The verdict feeds Tier 2 (an untrusted manifest on a write forces a preview) and a rule's `trustedManifest` context.

**Not built yet:** nothing fills the `Publishers` or `Pins` registries (only tests do), and the policy file's `trustedPublishers` and `pinnedManifests` aren't read. A "signed" manifest isn't checked against its signature: a registered publisher key is trusted as is. And since no caller passes a tool manifest to the engine, none of this affects a call today.

A manifest's risk tags would count from any source, since they only make a tool look more dangerous. `sensitivity.ts` also has the opposite helper, honouring a trusted manifest's `reversible: true`, but nothing calls it: `tool.call` is irreversible in the action metadata, so every tool call needs at least a preview whatever its manifest says.

**Not built yet:** a separate prompt for sensitive actions, and a sidebar decision to waive a sensitivity category for a site.

## Sessions

A **session** is origin-bound state for a task: the capabilities it requested, its limits (`maxToolCalls`, TTL), its history, and its usage so far. Each session is bound to:

- An origin (the requesting site)
- The capabilities it asked for: model access, a list of tools, browser access

Authority comes from the origin's grants — the permission prompt, `agent.requestPermissions`, per-tool allowlists — checked against the policy engine's tiers on every call. The engine sees the origin and the action, not the session. Harbor's background also refuses a prompt on a session that didn't ask for model access. The session's tool list and browser access are kept only by Harbor's page script, so a page can always use what its origin was granted. Treat the origin's grants as the boundary.

Session tool budgets are enforced in the background, against the session's `maxToolCalls`; calls past the budget fail with `ERR_BUDGET_EXCEEDED` without running the tool. Before the policy engine checks a `callTool()`, the call holds one of the session's slots (`SessionRegistry.reserveToolCall`). If the engine allows it, the slot is counted (`commitToolCall`); if the engine refuses it (a deny rule, a quarantined origin, a declined prompt), the slot is given back. A call refused by the page-side permission or allowlist check never holds a slot. So refused calls don't count against the budget, and a call whose tool runs and fails does. A call that finds every slot counted or held is refused before the policy engine, so it never prompts, and parallel calls can't each be prompted for the last slot. While one call's prompt is open, its slot stays held: another call that needs it is refused, even if the person then declines the first.

### Getting more authority later

There's no in-place upgrade: when a site needs more than its current session asked for — say, write access — it gets the origin grant it needs (`agent.requestPermissions()` shows the prompt) and calls `agent.requestCapabilities()` again for a new session. `requestCapabilities()` doesn't ask for grants: a required capability without its grant fails the request, and an optional one is left out. (It can still prompt when the watchdog has restricted the origin, or a policy rule says `ask` or `preview` for a requested capability.) The original session keeps working with what it already had. Terminate a session when you're done with it.

## The Watchdog

A background monitor that reads every engine decision from the audit log and keeps rolling counts per origin over a one-minute window:

- Tool calls
- Cross-origin egress, including prompts to third-party remote models
- Distinct sensitive labels the origin's outputs carried (`credentials`, `payments`, `identity`, `regulated`, `confidential`)
- Label-flow blocks (Tier 3 denies)
- Consecutive denials

The Watchdog is a complement to the structural defenses (info-flow labels, sensitivity gates), not a replacement. The structural defenses prevent the action; the Watchdog notices a pattern of attempts and tightens what the origin can do next.

Each origin is in one of four states. The engine consults the state at Tier 4 on every gated call:

```
normal
  └─ flagged       (nothing changes yet)
       └─ restricted    (every action that would be allowed asks first)
            └─ quarantined   (every action is denied with ERR_QUARANTINED)
```

| Trigger (within one minute unless noted) | Moves the origin to |
|---|---|
| 20 tool calls | flagged |
| 60 tool calls | restricted |
| 5 cross-origin egresses (a page's own `fetch` isn't counted) | restricted (can't fire yet) |
| 3 distinct sensitive labels (no window) | restricted (can't fire yet) |
| 3 label-flow blocks | quarantined (can't fire yet) |
| 5 consecutive denials (no window) | quarantined |

Only the tool-call and consecutive-denial triggers can fire today. The egress count takes only non-page fetches and third-party prompts, and Harbor produces neither; reads only ever carry `confidential`, so three distinct labels can't appear; and Tier 3 never denies (see [Information-flow labels](#information-flow-labels)).

The state only tightens: an origin never steps back down on its own. It clears when the extension restarts, since the counts live in memory. A `watchdog.resetOrigin` message exists, but nothing in Harbor sends it, and nothing shows an origin's state. The thresholds are `DEFAULT_THRESHOLDS` in `extension/src/policy/watchdog.ts`.

## Audit, activity feed, and the decision simulator

Every PolicyEngine decision — whether it prompted, auto-allowed, denied, or downgraded — writes a record to a ring buffer (most recent ~5,000):

```ts
{
  id: "…",
  timestamp: 1699999999000,
  origin: "https://example.com",
  action: "tool.call",
  resource: { server: "github", tool: "create_issue" },
  effect: "preview",
  tier: 9,
  source: "default",
  reason: "…",
  labelsIn: [],
  labelsOut: [],
  consent: "origin-grant",   // the page's grant answered the preview
  trace: [/* one step per tier */]
}
```

The full shape is `AuditRecord` in `extension/src/policy/audit.ts`. It records ids (server, tool, host, path), never a call's arguments or a prompt's text.

### Page calls

Harbor injects the page API (`window.ai`, `window.agent`, `navigator.modelContext`) itself, from `extension/src/page-api/`. A page's calls arrive over a port from Harbor's own content script, and Harbor takes the page's origin and tab from the browser's record of that port (`port.sender`), never from the message. The page API calls the rest of Harbor in-process through `page-api/harbor-core.ts`. Harbor runs each model and tool call through the PolicyEngine under that origin: `llm.chat`, `llm.chatStream`, `mcp.listTools`, `mcp.callTool`, `session.create` (one check per requested capability), and the model listings behind `window.ai.providers.*` (as `model.list`, after the site's `model:list` grant). A built-in `agent.run` therefore appears in the audit log as its tool listing (when the site holds `mcp:tools.list`), each model prompt and each tool call, in order. An ACP run skips listing Harbor’s installed tools and its `tool.list` policy check, since that backend does not use them; its prompts are checked as described below. A prompt is classified as local or remote by the model it will run on, as the native bridge reports it: a model is local when its provider runs on this machine (Ollama, llamafile, LM Studio, Apple's on-device model), including a provider instance the person named, such as `my-ollama:llama3`. Harbor's in-browser models (`local:`, `firefox-ml:`, `chrome-ai:`) are always local. A prompt that names no model, as every `agent.run` prompt does, runs on the bridge's default model and is classified by that model. If the bridge can't say, or the default model is unknown, the prompt counts as remote. With an older bridge that can't answer the question, Harbor classifies by the model's name instead, so a named instance counts as remote. A call without an origin is rejected.

When the person has selected an ACP agent (`harbor_agent_backend`; docs/ACP_BACKEND_DESIGN.md), a prompt runs on that agent instead of Harbor's own model, and is classified as `model.prompt.agent` rather than any `model.prompt.remote.*` action — `page-api/harbor-core.ts`'s `requireAgentPromptAction` runs the same `requireAction` gate right before every `session/prompt`, on both `agent.run` and a `window.ai` text session's own prompt loop, in addition to the pre-existing `model:prompt` origin-grant check. A denial there ends the run or turn with `ERR_PERMISSION_DENIED`, and is still recorded in the audit log under `model.prompt.agent` like any other decision.

A page's own chat (`agent.chat.open`, `handlers/page-chat-handlers.ts`) joins the same two calls on this backend: each message is gated as `model.prompt.agent`, through the same `requireAction` chokepoint — this is also where the scope's own ask/preview surfaces the consent prompt, since page chat (unlike `window.ai`/`agent.run`) has no separate `requestPermissions()` step of its own. The message then runs on the chat's own agent session, one `AcpTextSession` per open chat (`handlers/page-chat-agent-sessions.ts`), reusing the `window.ai` text-session implementation rather than a second one — so the same per-turn `requireAgentPromptAction` check, the per-site agent cap, and the backend-scoped grant matching all apply to page chat exactly as they do to a `window.ai` session. With no agent selected, page chat is unchanged: each message is still classified as `model.prompt.local`/`model.prompt.remote.firstParty` and answered by Harbor's own `llm.chat`.

Browser and tab calls go through the same check, after the page API has checked the site's grant:

| Page call | Typed action | Resource host |
| --- | --- | --- |
| `activeTab.click`, `fill`, `select`, `scroll` | `browser.write.interact` | the calling page |
| `activeTab.screenshot` | `browser.read.screenshot` | the calling page |
| `activeTab.getElements` | `browser.read.element` | the calling page |
| `activeTab.readability` | `browser.read.activeTab` | the calling page |
| `navigate` | `browser.write.navigate` | the destination |
| `fetch` | `network.egress.same_origin` or `network.egress.cross_origin` | the destination |
| `tabs.list` | `browser.read.tabs` | the calling page |
| `tabs.create` | `browser.write.tabsCreate` | the new tab's URL |
| `tabs.close`, and reading a tab the site opened (`readability`, `getHtml`) | `browser.write.tabsCreate` | the calling page |

`waitForLoad` on a tab the site opened isn't audited: it only reports load status. A `fetch` to this device or a private network is refused before the check, so it isn't audited either.

The host is recorded in the audit log, and a policy rule can match it (for example, deny `network.egress.cross_origin` to one host). Harbor doesn't classify these hosts as sensitive, though: a page opening, navigating to or fetching a bank or a document site isn't moving data there that it didn't already have, so these calls are never refused at the information-flow tier. A page's own `fetch` also doesn't count toward the watchdog's cross-origin egress limit, because a site can already call `fetch` freely from its page. A `fetch` redirected to another origin is checked again at its final URL: if that's refused, the page gets the refusal instead of the response (the request itself has already been sent).

If a rule or the watchdog makes Harbor ask before a page call (a browser call, a model prompt, a tool call, creating a session, a call to or from another agent, or opening the chat), and the page gives up waiting (its request times out: after 30 seconds by default, 2 minutes for creating a text session, 5 minutes for `agent.requestPermissions()` and 10½ minutes for a session prompt; or it cancels an `agent.run` or a stream), the call isn't performed even if the person then allows it.

A few page calls aren't checked by the PolicyEngine, on purpose. `agent.sessions.get()`, `list()` and `terminate()` only see or end the calling site's own sessions, which it created after the person allowed it; Harbor scopes them to the origin, so they reach nothing new. Harbor's usage bookkeeping after a prompt (`session.recordUsage`) follows a prompt that was already checked, and the readiness probe behind `window.ai.canCreateTextSession()` and `ai.languageModel.capabilities()` (`system.getCapabilities`) only reports whether Harbor is ready. Creating a `window.ai` text session checks only the site's `model:prompt` grant; each of its prompts is then checked by the engine. Several agent and chat calls are also unchecked: `agent.agents.getInfo()`, `list()` and `unsubscribe()`, registering an invocation or message handler, `agent.chat.canOpen()` and `close()`, and `agent.mcp.discover()`. Apart from these and the permission checks themselves (`permissions.check` and `permissions.request`), a page can't reach any other message type in Harbor's router.

Harbor holds the only store of per-origin grants and the only consent prompt. The page API checks Harbor's store (`permissions.check`) before each page call, and `agent.requestPermissions()` goes to Harbor's prompt (`permissions.request`). So a site revoked in Harbor's sidebar is refused on its next call. That includes work the site started while it still held the grant: every prompt on an open text session (`window.ai` or `agent.sessions.create`), and every model turn of a running `agent.run`, re-checks `model:prompt`. Revoking the site, or a one-time grant expiring, stops the next one. This holds in Safari too: its build injects the same page API.

**Grants for `model:prompt`/`model:tools` are backend-scoped, but only the *allow* half is** (`policy/backend-grant.ts`). An **allow** records which backend — `builtin`, or `acp:<agentId>` — it was given for, and counts only while that's still the selected backend (`harbor_agent_backend`); switching to a different ACP agent, or back to the built-in model, doesn't erase an allow, it stops (or resumes) it counting. Allows for different backends are stored side by side (keyed by backend), so granting under one agent doesn't overwrite another backend's own allow, and switching back restores it. A **deny**, by contrast, is universal (maintainer decision): once denied, the scope is denied under every backend, including one that never had an allow of its own, until the person grants it again. A grant made before any of this existed has no recorded backend and counts as `builtin`. This is enforced at both grant-lookup paths page calls use — `checkPermissions`/`getPermissionStatus` (what `hasPermission` reads for `window.ai` and `agent.run`'s own pre-check) and `lookupOriginGrant` (the typed-action engine's Tier 8, which `requireAgentPromptAction` goes through too) — so all three see the same answer. Every other scope is unaffected. The sidebar's per-site permission list (`listAllPermissions`) shows every backend's own allow as its own badge, labelled by backend (e.g. "Prompt (goose)", "Prompt (built-in)") — the flat `scopes` field alone would miss these the moment any backend-scoped allow exists, which would make a site holding only one disappear from the list, with no "Revoke" button to find it under. "Revoke" still wipes the whole origin's stored record, including every backend's allow, in one step.

A mismatch — the live backend's allow doesn't cover the current backend, or a universal deny is in force — fails the call with `ERR_PERMISSION_DENIED`; Harbor does **not** silently re-prompt on the site's behalf. The site has to call `agent.requestPermissions()` again, which shows Harbor's prompt naming whichever backend is selected at that moment. The prompt itself is stamped with the backend it named when it was shown, not whatever happens to be selected when the person answers it: if the selection changes while the prompt is still open, the grant records the backend the prompt asked about, so it can end up not matching the (now different) live selection, and the site's next call is asked again, correctly, rather than silently granted for the wrong backend.

**Switching `harbor_agent_backend` also ends work already running on the backend being left**, not just changes what a later call uses: every live ACP-backed `window.ai` text session is destroyed (a later `session.prompt` on one gets the same `ERR_SESSION_NOT_FOUND` an explicit `session.destroy` already produces), and an in-flight ACP `agent.run` is cancelled with `ERR_AGENT_FAILED` / "The agent was changed." (`page-api/acp-backend-generation.ts`). As defence in depth, an ACP text session's own per-turn check also judges its grant against the backend it was actually created on, not a live read of the current selection — in case one somehow outlives the switch.

The older, separate Web Agents API extension no longer injects anything, and Harbor no longer accepts a message or connection from it, or from any other extension: there is no cross-extension entry point left to reach.

For page calls, Harbor enforces `deny` (safety floor, policy rules, a denied origin grant, the watchdog). When the only thing left to settle is the origin grant (Tier 8 or the Tier 9 default), or an `allow` rule that Tier 2 raised to a preview, Harbor proceeds without prompting again, and the audit record carries `consent: "origin-grant"`. For most page calls that's because the page API has just checked the grant in Harbor's store. Creating a session is the exception: `session.create` checks only `model:prompt` and `mcp:tools.call`, so a session's browser capabilities are recorded as consented without a browser grant. Each browser call still checks its own grant when it's made. A watchdog restriction (Tier 4) or a policy rule that asks or previews (Tier 7) still shows Harbor's prompt.

The engine treats a write that can't be undone as needing a preview even when the origin holds a grant. Calling or messaging another agent on this device (`agent.invoke`, `agent.message`) doesn't count as one: the call itself changes nothing, and the other agent's own actions are checked separately. So once a site holds `agents:invoke` or `agents:message`, later calls go through without another prompt. An "Allow once" grant covers only the tab that granted it, for ten minutes; another tab on the same site is asked again.

A site's tool allowlist is deny-by-default: a site with no allowlist may call no tools.

If you're building a page, open Harbor's sidebar's **Activity** section to see every decision for your origin and the reason for it.

### Activity feed

The sidebar's **Activity** section lists these records, newest first, with a summary at the top, filterable by outcome (allowed, prompted, previewed, denied). Each row has a **Why?** link that shows the reason, the resource ids, the labels in and out, any error code, and the trace through the tiers.

This is also what makes silent decisions visible. If the engine auto-allowed a tool call because of a policy rule, the person sees that in the feed.

**Not built yet:** filtering by time or site, and acting on a row (revoking that grant, or adding a rule from it). The **Site permissions** section's **Revoke** clears all of a site's grants.

### Decision simulator

Each audit row in the sidebar has a **"Why?"** affordance. The **"What if?"** simulator runs behind the `policy.simulate` and `policy.replay` messages; the sidebar doesn't expose it yet.

**Why?** explains the decision: which tier of the ladder fired, which rule matched (with its `id`), what labels were on the input and output, and what the resulting effect was. This is the answer to the legitimate user question "why did Harbor block this?" — and it's the answer to the developer's question "why is my site getting `ERR_BLOCKED_BY_POLICY`?"

**What if?** is the simulator. It lets a developer replay the same decision against:

- A modified action set (what if the origin had asked for `model.prompt.local` instead of `.remote`?)
- A modified policy (what if I added this allow rule?)
- A modified label set (what if the input wasn't tainted with `credentials`?)

The simulator replays a decision against the engine and returns the simulated decision with its own trace. It swaps the live rules and resolvers while it runs, so a live decision made at the same moment could see the simulated ones; nothing calls it yet (`policy.simulate` and `policy.replay` have no sender).

## Telemetry goals

None of this is built; today there is only the audit log. The plan is to track, locally:

- **Prompt rate** per origin and per action, to spot sites that create prompt fatigue.
- **Sensitivity false-positive rate** — how often a gate fires on something the person immediately allows.
- **Label-egress block rate** — how often the information-flow check stops labelled data.
- **Containment trigger frequency** — how often the watchdog tightens an origin, by trigger.

Nothing would be exported by default.

---

# Part 2: For site authors

This is what you, as an author of a website using `window.ai` and `window.agent`, need to know.

## The short version

```ts
// 1. Get the origin grants. This is what shows Harbor's prompt.
await agent.requestPermissions({
  scopes: ['model:prompt', 'browser:activeTab.read'],
  reason: 'Read this page and draft a fix.',
});

// 2. Make a session from them.
const session = await agent.requestCapabilities({
  require: [
    { action: 'model.prompt.local' },
    { action: 'browser.read.activeTab' },
  ],
  budget: { maxToolCalls: 10, ttlMinutes: 30 },
  reason: 'Read this page and draft a fix.',
});
```

`requestCapabilities()` takes `require` and `optional` lists of `{ action, server?, toolNames? }`, an optional `budget` of `maxToolCalls` and `ttlMinutes`, and a `name` and `reason`. It turns three kinds of action into a session's capabilities: any `model.prompt.*` becomes model access, `tool.call` with a `server` becomes tools, and `browser.*` becomes browser access. Anything else (`network.egress.*`, `agent.*`, `chat.open`, a `tool.call` without a `server`) is ignored. It doesn't prompt for grants itself:

- A **required** capability whose grant the site lacks fails the request with `ERR_PERMISSION_DENIED`. Harbor checks `model:prompt` for model access and `mcp:tools.call` for tools. Browser access isn't checked against a grant when the session is created, unless the site has *denied* it, which fails the request; each browser call checks its own grant when it's made.
- An **optional** capability whose grant the site lacks is left out of the session quietly.
- **Tools** are narrowed to the site's tool allowlist (the tools named when it was granted `mcp:tools.call`). A tool outside it is left out quietly, even if required. Name the tools: a `tool.call` with a `server` and no `toolNames` asks for `server/*`, which matches only if the allowlist holds that exact entry.
- A policy refusal (a deny rule, a quarantine, a declined prompt) fails the request with the policy engine's code.

`session.capabilities` describes what the session can use: `{ llm, tools, browser, limits }`.

A few things worth knowing up front:

- The person can say "this time only" or "always allow" without you needing different code paths.
- The person, their organization and the watchdog can restrict you without a prompt (policy rules, containment) — handle structured errors gracefully.
- Which `model.prompt.*` action you request doesn't choose a model: every one becomes the same model access, and Harbor classifies each prompt by the model it actually runs on.

## Designing your capability requests

### 1. Ask for the narrowest typed action, with a real reason

```ts
// Good
await agent.requestCapabilities({
  require: [
    { action: 'tool.call', server: 'memory', toolNames: ['save_memory', 'search_memories'] },
  ],
  reason: 'Save and search your notes across sessions',
});

// Bad — broad, unjustified, dishonest
await agent.requestCapabilities({
  require: [
    { action: 'model.prompt.remote.thirdParty' },
    { action: 'tool.call' },
    { action: 'browser.read.activeTab' },
    { action: 'browser.write.interact' },
    { action: 'browser.write.navigate' },
    { action: 'network.egress.cross_origin' },
  ],
  reason: 'AI features',
});
```

The `reason` string you pass to `agent.requestPermissions()` appears in the prompt. A vague reason makes it more likely your request gets denied.

### 1a. Prefer local prompts when you can

A prompt that runs on a model on this device is checked as `model.prompt.local`, a read; one that runs on a remote provider is checked as `model.prompt.remote.firstParty`, an egress; and one on the person's own agent is `model.prompt.agent`. Harbor decides which from the model the prompt actually runs on (see [Page calls](#page-calls)). The person picks that model, not your request: asking for `model.prompt.local` in `requestCapabilities()` gives the same model access as any other `model.prompt.*`. (`model.prompt.remote.thirdParty` exists for rules, but no prompt is classified that way yet.)

What you can do is say in your `reason` why you need a model at all. (`window.ai.createTextSession()` and `agent.sessions.create()` can name a model; `requestCapabilities()` can't.)

### 2. Ask for scopes that belong together at once

`agent.requestPermissions()` shows one prompt for all the scopes it names, so asking for the scopes a task needs together, instead of one at a time as you discover them, gets the person to a single decision.

### 3. Start narrow; request more when the user gives you a reason to

Create your session with only the actions you need right away, and request a new, additionally-scoped session when the user explicitly takes an action that needs more — for example, clicking "Apply." It gives the person a natural moment to grant write authority.

A session doesn't widen in place. Ask for the new grant with `agent.requestPermissions()` — the user gets a prompt that names the additional authority, at a natural moment — then call `agent.requestCapabilities()` again for a new session.

```ts
const readSession = await agent.requestCapabilities({
  name: 'Article assistant',
  require: [
    { action: 'model.prompt.local' },
    { action: 'browser.read.activeTab' },
    { action: 'browser.read.screenshot' },
  ],
});

// Later, when the user clicks "Apply suggested edit", ask for write
// authority (the user sees a prompt for just this), then request a
// new session.
await agent.requestPermissions({ scopes: ['browser:activeTab.interact'] });
const writeSession = await agent.requestCapabilities({
  name: 'Apply suggested edit',
  require: [
    { action: 'browser.write.interact' },
  ],
  reason: 'Apply the changes you approved',
});
```

The user gets two prompts, but each is small and scoped to a real moment of intent. That's much cheaper to grant than one giant upfront prompt. The two sessions are independent; the original read-only session keeps working for further reads, and the new session covers the write you just authorized. When the write is done, terminate it.

### 4. Annotate risky tools in your MCP manifests

If you publish an MCP server, declare what your tools touch:

```jsonc
{
  "server": "github",
  "tools": [
    { "name": "read_issue", "sideEffect": false },
    {
      "name": "create_issue",
      "sideEffect": true,
      "reversible": true,
      "dataEgressDomains": ["api.github.com"],
      "riskTags": ["remote_write"]
    },
    {
      "name": "delete_repo",
      "sideEffect": true,
      "reversible": false,
      "riskTags": ["destructive"]
    }
  ]
}
```

How Harbor uses this today:

Not much yet. No caller passes a tool manifest to Harbor's policy engine, so today your annotations don't affect any decision: a `toolTags` rule never matches, risk tags don't label a call, and `reversible: true` counts from no source. Every tool call is an irreversible write in Harbor's action metadata, so it needs at least a preview, which the site's origin grant answers.

The design: risk tags that name a data label (`credentials`, `payments`, `identity`, `regulated`, `confidential`) would count from any source, since they only make a tool look more dangerous; a claim that makes a tool look *safer* would count only from a trusted manifest. Declaring them now costs nothing.

### 5. Handle the new error shapes

Errors carry a `code` and a `message`. The codes to expect:

```ts
try {
  await agent.tools.call({ tool: 'filesystem/delete_file', args: { path } });
} catch (err) {
  switch (err.code) {
    case 'ERR_PERMISSION_DENIED':
      // No grant, or the person declined the prompt.
      break;
    case 'ERR_BLOCKED_BY_POLICY':
      // A user or organization policy rule denied this. Don't retry.
      break;
    case 'ERR_QUARANTINED':
      // The watchdog has quarantined this origin. Every policy-checked
      // call is denied until the browser restarts the extension.
      break;
    case 'ERR_LABEL_FLOW_BLOCKED':
      // The input carries a data label this action doesn't accept.
      // Reserved: a page's calls don't carry labels yet.
      break;
    case 'ERR_BUDGET_EXCEEDED':
      // The session used up its maxToolCalls.
      break;
    case 'ERR_FEATURE_DISABLED':
      // The person switched this family of the API off in the sidebar.
      break;
    case 'ERR_SESSION_NOT_FOUND':
      // The session was terminated, destroyed, or expired. Re-request.
      break;
  }
}
```

Treat `ERR_BLOCKED_BY_POLICY`, `ERR_LABEL_FLOW_BLOCKED`, and `ERR_QUARANTINED` as terminal: the user has already been told, and retrying just generates noise in their activity feed.

These are the policy engine's codes, and Harbor reports them as is wherever its policy check refuses a page's call:

- `agent.tools.call()` and a session's `callTool()` throw them.
- `agent.sessions.create()` and `agent.requestCapabilities()` throw them when creating the session is refused.
- A `window.ai` text session's `prompt()` throws them, and `promptStreaming()` ends with them, when the session runs on Harbor's own model.
- `agent.run()` on Harbor's own model ends with them as its `error` event when its tool list or a model call is refused.
- `agent.browser.*` calls (page interaction, screenshots, reading the page, navigation, `fetch` and the tab calls) throw them.
- `agent.agents.*` calls (registering, discovering, invoking and messaging agents, and orchestration) and `agent.chat.open()` throw them.
- `agent.mcp.register()` throws them. It's checked as `mcp.server.register` and needs the `mcp:servers.register` grant, which asks by default, before Harbor connects to the site's server. It refuses a server that isn't on the page's origin (or, from a loopback page such as `localhost`, on a loopback host) with `ERR_PERMISSION_DENIED`, before asking. `agent.mcp.unregister()` isn't checked, since it only drops a connection; it can only drop a server the same page registered in the same tab. An unknown server id, or one registered in another tab, fails with `ERR_MCP_UNREGISTER`.

When the person has chosen an ACP agent to answer, each prompt is still checked by the policy engine, as `model.prompt.agent`; a refusal there is `ERR_PERMISSION_DENIED`. Failures from the agent itself use the ACP codes (`ERR_AGENT_FAILED`, `ERR_AGENT_BUSY`, `ERR_AGENT_REFUSED`, `ERR_AGENT_LIMIT`). An `agent.run()` on an ACP agent doesn't list Harbor's tools, so the tool-list refusal above applies on Harbor's own model only. On an ACP agent, the site's own registered MCP servers are passed to the agent only if the site holds `mcp:tools.list` and `mcp:tools.call` and the policy engine allows listing and calling tools; the site's per-tool grants don't apply there.

**The page's own tools** (`document.modelContext`) work differently from site servers. They need no grant of their own, because `mcp:tools.list` and `mcp:tools.call` would also open the person's installed MCP servers. The grant that lets the page start `agent.run()` or `agent.chat.open()` covers them. The policy engine still checks `tool.list` on the `page:<host>` server when the run or chat starts, and `tool.call` with the tool's name on every call. It never prompts for them: a rule that asks refuses. A rule like `{ action: 'tool.call', resource: { server: 'page:*' } }` turns them off everywhere. Every check is in the audit log, and the site's per-tool grants don't apply. See [PAGE_TOOLS_FOR_AGENTS.md](PAGE_TOOLS_FOR_AGENTS.md).

**Your agent outside the browser** reaches pages through `harbor-mcp`, a command the person adds to their agent. It's off until the person turns on "Let your agent open and use pages" in the Agent panel. The agent sees only tabs it opened (while they stay on the site they first loaded) and tabs the person shares. It can call only those pages' own tools, under the same `page:<host>` policy checks and audit, and at most 60 calls a minute per agent (120 across all agents, `open_page` included). Only the person's own user account can connect: `harbor-mcp` reaches the bridge over `~/.harbor/agent.sock` (mode 0600). See [AGENT_REACHES_TABS.md](AGENT_REACHES_TABS.md).

A declined Harbor prompt is `ERR_PERMISSION_DENIED`. Any other failure keeps the call's own code (`ERR_TOOL_FAILED`, `ERR_MODEL_FAILED`, `ERR_AGENT_FAILED`), even when a tool or model returns text that looks like one of these codes.

`ERR_LABEL_FLOW_BLOCKED` can't occur on a page's call yet: Harbor doesn't attach data labels to page tool calls or prompts. Handle it anyway; it's reserved for when it does.

### 6. Pre-action previews

When the engine decides a write needs a preview, a page call goes through on the origin's grant (see [Page calls](#page-calls)); Harbor doesn't yet show a separate preview of the action. Letting a site describe its action for a preview (a `preview` option on `agent.tools.call()`) is designed but not built: `agent.tools.call()` takes a single `{ tool, args }` object.

### 7. Test against the harness

`scripts/generate-test-harness.mjs` gives your app a mock of `window.ai` and `window.agent`. Its permission controls are `mock.permissions.grantAll()`, `denyAll()` and `grantScopes([...])`, which drive what `agent.requestPermissions()` returns:

```js
import { installWebAgentsMock } from './harbor-test/mock.js';
const mock = installWebAgentsMock(globalThis);

mock.permissions.grantScopes(['model:prompt', 'mcp:tools.list']);
// …exercise your app…
mock.permissions.denyAll();
```

The mock implements `agent.requestCapabilities()`'s grant handling (an ungranted optional capability is left out; a required model or tool capability it lacks fails with `ERR_PERMISSION_DENIED`), though it doesn't narrow tools to the site's allowlist or fail on a denied browser grant. `mock.policy.refuse('ERR_BLOCKED_BY_POLICY')` (or `'ERR_QUARANTINED'`) makes model, tool, session and agent calls fail as Harbor's policy engine would, until `mock.policy.reset()`. It doesn't model the engine itself: there's no typed policy, sensitivity, label or simulator control. To see real decisions, run against Harbor in Firefox and read the sidebar's **Activity** section. See [TESTING_YOUR_APP.md](TESTING_YOUR_APP.md) for everything the mock does.

---

# Part 3: For extension contributors

This is what you need to know to add a new scope, a new sensitivity rule, or a new anomaly check.

## Where things live

```
extension/src/policy/
  actions.ts          # Typed action registry (verb.noun.qualifier)
  labels.ts           # DataLabel registry and propagation helpers
  engine.ts           # PolicyEngine.evaluate (the chokepoint)
  rules.ts            # Typed rule matcher; string DSL parser
  store.ts            # Loads and merges managed + user policy documents
  origin-grants.ts    # Per-origin "Allow always / once / deny" remembered from prompts
  sensitivity.ts      # Domain, element, and tool classifiers
  manifest-trust.ts   # trustManifest; Publishers and Pins registries
  watchdog.ts         # Rolling stats, anomaly rules, containment
  audit.ts            # Ring-buffer audit log
  simulator.ts        # Decision replay against modified context
  permissions.ts      # Origin grants and the permission prompt (showPermissionPrompt)
  backend-grant.ts    # Which backend a model grant was given for
```

The flow through the system is:

```
agents/handlers/*, extension-api.ts  ─[requireAction]─►  policy/engine.evaluate
                                              │
                                              ├─►  policy/sensitivity
                                              ├─►  policy/labels (input/output flow)
                                              ├─►  policy/store (typed rules)
                                              ├─►  policy/watchdog (state)
                                              └─►  policy/manifest-trust (for tool meta)

requireAction then writes the audit record (policy/audit), and when the
decision is ask or preview, shows the permission prompt
(permission-prompt.ts) through policy/permissions.
```

## Adding a new typed action

1. **Add the action** to `actions.ts`:
   ```ts
   export const TYPED_ACTIONS = {
     // ...
     'browser.write.tabsMove': {
       title: 'Reorder open tabs',
       description: 'Change the position of tabs in the tab strip.',
       effect: 'write',
       locality: 'local',
       reversible: true,
       defaultDataLabels: [],
       acceptsLabels: [],
       defaultTTL: 'session',
     },
   } as const;
   ```
2. **Map it to a grant.** Reusing an existing permission scope is simplest. A new scope goes in `PermissionScope` in `agents/types.ts`, in the three `Record<PermissionScope, …>` literals in `policy/permissions.ts` (two grant-status maps and `SCOPE_DESCRIPTIONS`), and in the page's own copies in `page-api/types.ts` and `page-api/injected.ts` so pages can request it. Then add the scope to `primaryLegacyScope` in `agents/handlers/helpers.ts` (TypeScript requires a case for every action) and the action to `TYPED_TO_LEGACY` in `policy/origin-grants.ts`. Without that entry, an origin grant never satisfies Tier 8 for the action.
3. **Gate the handler** with `requireAction(ctx, sender, 'browser.write.tabsMove', { resource })` (`agents/handlers/helpers.ts`). For a page call that goes through `extension-api.ts`, add the action to that message type's page checks there.
4. **Add unit tests** in `policy/__tests__/engine.test.ts` covering at least one allow path and one ask/deny path.

## Adding a data label

Add the name to the `DataLabel` union in `labels.ts`, then an entry to `DATA_LABELS`, with a `title`, a `description` and a `severity` (`low`, `medium`, `high` or `critical`; nothing reads severity yet):

```ts
// extension/src/policy/labels.ts
export const DATA_LABELS = {
  // ...
  authToken: {
    title: 'Authentication token',
    description: 'A bearer token or session cookie.',
    severity: 'critical',
  },
};
```

Then have a classifier in `sensitivity.ts` add it to the `labels` of the `SensitivityVerdict` it returns, and decide which actions may receive it by adding it to their `acceptsLabels` in `actions.ts`. There's no per-label egress setting: Tier 3 denies any action whose input carries a label missing from that action's `acceptsLabels`. The watchdog counts distinct labels from a fixed list in `watchdog.ts`; add the new one there too.

## Adding a sensitivity rule

The classifiers are `classifyDomain(host)`, `classifyElement(el)` and `classifyTool(manifest, manifestTrusted)` in `sensitivity.ts`. Each returns a `SensitivityVerdict`: `{ labels, confidence, reason }`. To flag more hosts, add to `DOMAIN_RULES` (though no reachable call classifies its host today; see [Information-flow labels](#information-flow-labels)); to flag more tools, extend `classifyTool`:

```ts
// extension/src/policy/sensitivity.ts, inside classifyTool
if (manifest.server === 'stripe' && /^(charge|refund|void)/.test(manifest.tool)) {
  labels.add('payments');
  reasons.push('Stripe money movement');
  confidence = 'high';
}
```

The engine runs the domain and tool classifiers at Tier 2, before any policy rule or grant, so an `allow` rule can't remove a label they add. `classifyElement` isn't called by the engine yet, and no caller passes a tool manifest yet, so a new tool rule only takes effect once one does.

## Adding a trusted-manifest source

`trustManifest(provenance)` in `manifest-trust.ts` decides trust from `provenance.source`: `bundled`, `localInstall`, `signed` (checked against the `Publishers` registry) and `policyPinned` (checked against `Pins`, by server id and manifest hash) are trusted; `pageDeclared`, `fetched` and `unknown` aren't. Add a publisher with `Publishers.add({ name, publicKey, algorithm: 'ed25519', addedAt: Date.now(), allowedServerGlob })` and pin a manifest with `Pins.pin(serverId, hash)`. Only tests call these today, and the policy file's `trustedPublishers` and `pinnedManifests` aren't read, so loading them from policy is part of the work.

The engine calls `trustManifest` before Tier 2; an untrusted manifest on a write forces a preview.

## What you should never do

- **Don't bypass `requireAction`.** Every API boundary uses it. If you're tempted to skip the check, you almost certainly want to register an action with `effect: 'metadata'` instead.
- **Don't auto-allow a write-effect or egress-effect action from inside a handler.** The effect is the contract; if you've decided a particular write should be auto-allowed, that's a policy `allow` rule and belongs in the user's `harbor-policy.json`.
- **Don't trust a remote-discovered manifest.** Always go through `trustManifest` before honoring a manifest's claim that a tool is safer than it looks.
- **Don't store secret data in audit records.** Records hold ids (server, tool, host, path), never arguments or prompt text; keep it that way. The person can read them in the sidebar.
- **Don't add a sensitivity false positive without an override path.** The person can't edit policy in the sidebar yet, so a new gate that fires wrongly has no fix but a new build.

## Changing a Watchdog trigger

The Watchdog's triggers are fixed checks in `maybeEscalate` in `extension/src/policy/watchdog.ts`, with their limits in `DEFAULT_THRESHOLDS`. To add one, count the new signal in `observe` (it runs on every audit-log append), add a threshold, and escalate in `maybeEscalate`. Keep the ratchet one-way. Test it by feeding audit records to `observe` with chosen timestamps (`extension/src/policy/__tests__/watchdog.test.ts`).

## Wiring a new prompt UI surface

There is one prompt surface today: the popup window from `showPermissionPrompt` in `policy/permissions.ts`, rendered by `extension/src/permission-prompt.ts`. Its answer is stored by `grantPermissions` or `denyPermissions`. A shared consent channel that several surfaces could subscribe to (an in-page chip, a sidebar panel) is designed but not built; a new surface today means another caller of the same permission store.

---

# Part 4: For users

This is what the system looks like from the user's chair today, and what you can do with it. Parts 1–3 describe the engine underneath, some of which has no controls in the sidebar yet; those are listed under [Not built yet](#not-built-yet).

## What you'll see in normal use

For most sites, most of the time, you won't see anything. A site that never asks for anything never prompts. When one does:

1. The first time a site asks for a capability (prompting your model, using your tools, reading the page, and so on), Harbor asks you once.
2. If you allow it, the site goes on using it within what you allowed.
3. Everything Harbor decided, allowed or not, shows up in the sidebar's **Activity** section.

## The sidebar at a glance

Harbor's sidebar opens on a welcome card that names the agent sites run on: Harbor's built-in model, or an agent of your own. Below it:

| Section | What's there |
|---|---|
| **Agent sessions** | Shown only while a site has a session open. Each lists its site and what it can do, with a **Terminate** button. |
| **Activity** | Every decision the policy engine made, newest first, with a summary at the top. Filter by outcome (allowed, prompted, previewed, denied). Each row has a **Why?** link. |
| **Site permissions** | What you've allowed or denied, site by site. **Revoke** clears a site's grants, so it asks again. |
| **Browser agent capabilities** | Switches for whole families of the page API (text generation, tool access, agentic tool use, browser interaction, browser control, multi-agent). Off means no site can use it, whatever its grants. Reload pages after changing one. |

Your agent, the built-in model's settings and developer tools are under **Settings**, at the foot of the sidebar.

## The permission prompt

When a site asks for something you haven't decided on, Harbor opens a prompt that shows:

- the site asking, and its **reason** in its own words (treat it as the site's claim, not Harbor's);
- each capability it wants, with what it means and how risky it is;
- for tools, which tools; for an agent, which sites it covers;
- whether it should hold **This time only** (the default) or **Always allow**.

**Allow** with *This time only* lasts about ten minutes, in the tab that asked. *Always allow* lasts until you revoke it in **Site permissions**. **Deny** is remembered, so the site doesn't keep asking; revoke it to be asked again.

## Why did Harbor decide that?

Open **Activity** and click **Why?** on the row. It shows the reason, the resource involved, any data labels, the error code a site saw, and the trace through the policy engine's tiers, including the rule that matched.

## When something feels wrong

A few things to check first, in order:

1. **Did you deny it, or did a grant run out?** Look the site up in **Site permissions**. A *This time only* grant ends after about ten minutes; the next call asks again.
2. **Is a whole capability switched off?** Check **Browser agent capabilities**.
3. **What did the engine say?** Find the call in **Activity** and open **Why?**. It names the tier and rule that fired.
4. **Does the session hold what the site is using?** A session only has what it asked for and you granted. Anything else fails with `ERR_PERMISSION_DENIED`. **Agent sessions** shows what each session can do.

If a site keeps prompting, it is usually asking poorly: broad scopes with vague reasons, or one scope at a time. **Activity** shows which request comes up most. Allow it always if you trust the site, or deny it.

## What you control, summarized

| You can... | Where |
|---|---|
| See every active agent session | Sidebar → Agent sessions (shown while there are any) |
| Stop a session immediately | Sidebar → Agent sessions → Terminate |
| See what an agent did and why | Sidebar → Activity → Why? |
| Revoke a site's grants | Sidebar → Site permissions → Revoke |
| Turn a family of the API off for every site | Sidebar → Browser agent capabilities |
| Choose who answers sites: the built-in model or your own agent | Sidebar → Settings → Your agent |
| Set rules for a whole organization | A managed policy (see the FAQ) |
| Reset a quarantined site | Not in the sidebar yet; the `watchdog.resetOrigin` message clears it |

## Not built yet

The engine in Parts 1–3 supports more than the sidebar shows. These are designed but have no controls yet:

- **Editing your own policy.** The engine reads a user policy (`harbor_policy_v2` in the extension's local storage) below any managed policy, but nothing in Harbor writes it: there is no editor, import, export, or preset (Conservative, Balanced, Permissive and so on).
- **Rules from a prompt or from Activity.** No "Always allow if it matches a rule…" in the prompt, no "Make this automatic" or "Always deny" in Activity, and no promoting a site's grant to a global rule.
- **Destination-aware and sensitive-action prompts.** Egress and sensitive actions go through the same permission prompt above, without the dedicated layouts the design describes.
- **Session-length grants.** The prompt offers *This time only* and *Always allow*; there is no *Allow for this session*, and it doesn't offer to pin a grant after a few uses.
- **Sensitive domains, budgets, containment badges, Pause, and a toolbar icon that shows state.**

---

## Glossary

- **Action (typed).** A `verb.noun.qualifier` identifier (`model.prompt.local`, `network.egress.cross_origin`) that describes one effect the engine can authorize.
- **Action metadata.** Each action's declared `effect`, `locality`, `reversible`, `defaultDataLabels`, and `acceptsLabels`.
- **Ambient.** An action whose `effect` is `metadata` — auto-allowed, never prompts.
- **Audit record.** A single decision logged by the PolicyEngine, with full trace including matched rule, source, and labels.
- **Containment.** A graduated reduction of a session's authority, walked by the Watchdog in response to bad behavior; see [The Watchdog](#the-watchdog).
- **Data label.** A tag (`credentials`, `payments`, `identity`, `confidential`, `regulated`) attached to data flowing through the agent. Tracked through reads, prompts, and tool calls; checked at egress.
- **Decision simulator.** A read-only replay of a recorded decision under different rules or labels, reached through the `policy.simulate` and `policy.replay` messages. The sidebar's **Why?** link shows the recorded trace, not a replay.
- **Effect.** One of `metadata`, `read`, `egress`, `write`, `identity`, `destructive`. Drives default UX.
- **Locality.** One of `local`, `same-origin`, `cross-origin`, `remote`. Drives egress treatment.
- **Manifest provenance.** Whether an MCP manifest is trusted (bundled, locally installed, signed, or pinned in policy) — determines whether the engine honors its self-attested sensitivity claims.
- **Origin grant.** A per-site allow/once/deny remembered from a prompt. Lowest-precedence layer; the policy file overrides it.
- **PolicyEngine.** The single function that decides whether to allow, deny, ask, or preview each API call.
- **Policy file.** `harbor-policy.json` v2 — declarative typed rules. A managed policy comes from enterprise storage; a user policy is read from the extension's local storage (`harbor_policy_v2`), though nothing in Harbor writes one yet.
- **Sensitivity.** Structural classification (safe / sensitive / destructive) independent of policy. Cannot be lowered by an `allow` rule.
- **Sidebar.** Harbor's primary UI surface: your agent, agent sessions, activity, site permissions and capability switches, with settings behind them.
- **Watchdog.** The background monitor that maintains rolling statistics and label-flow events; tightens an origin's containment state in response.

---

## FAQ

**Q: I've been using Harbor's older permission API — what do I need to change?**

The internal change is large, but the user-facing API is similar in shape. The biggest concrete differences for site authors:

- `agent.requestPermissions({ scopes: [...] })` is replaced by `agent.requestCapabilities({ require: [...], optional: [...] })` with typed actions.
- `model:prompt` becomes `model.prompt.local` or `model.prompt.remote.thirdParty` — pick the right one for your use case.
- `web:fetch` becomes `network.egress.same_origin` or `network.egress.cross_origin`, with destination-aware policy.
- New error codes (`ERR_BLOCKED_BY_POLICY`, `ERR_QUARANTINED`, `ERR_LABEL_FLOW_BLOCKED`) need to be handled in your error path.

The sample apps and the demo site demonstrate the new shape.

**Q: Why is `model.prompt.local` separate from `model.prompt.remote`?**

Because they're not the same thing, even though v1 treated them as one. A local model (Firefox-ML, Chrome AI, Ollama) keeps your data on your machine; a remote model sends it to a cloud provider. A user (or a policy) might be totally fine with the first and not the second. Splitting them means the user can write `allow model.prompt.local` broadly while keeping `model.prompt.remote.thirdParty` on a tight leash, and means a site that only needs a local model never triggers an egress concern.

**Q: Why doesn't the prompt default to "Always allow"?**

Because reads can feed exfiltration. Reading a tab is harmless on its own; reading a tab and then sending the contents to a remote LLM is exfiltration. The prompt defaults to *This time only*, which lasts about ten minutes in that tab; you choose *Always allow* yourself.

**Q: Why isn't there a single "Auto-approve everything safe" toggle?**

Because "safe" depends on what your trusted infrastructure looks like. The design answers this with policy presets (a Permissive one among them), but those aren't built yet; see [Not built yet](#not-built-yet). Today, *Always allow* on a site you trust is the closest thing.

**Q: Can a malicious site spoof a `reason` or a manifest to look harmless?**

The `reason` string is always site-supplied, so trust the structural information (action, locality, destination, labels), not the prose. MCP manifests can also be untrusted — Harbor only honors *downgrade* claims (a tool calling itself reversible) when the manifest comes from a trusted source: bundled, locally installed, signed by a trusted publisher, or explicitly pinned in your policy. *Upgrade* claims (a tool calling itself destructive) are honored from any source because that direction is safe.

**Q: How does this interact with prompt injection?**

The PolicyEngine is the structural defense: even if the agent is convinced by injected instructions to do something dangerous, the engine evaluates the action against your policy and the SensitivityEngine and the data-label flow tracker, all of which are blind to the agent's reasoning. Sensitive actions still confirm; deny rules still deny; tainted data still can't reach a remote model without your consent. None of this prevents the agent from being misled, but it bounds what a misled agent can do.

One limit applies to requests from web pages. The engine gates their calls to the model and to tools, but those calls don't carry data labels yet, so the label check described above doesn't cover them. See [Against Prompt Injection](../spec/security-privacy.md#against-prompt-injection) for what limits a page's session today and what is planned.

**Q: Can my organization centrally manage this?**

Yes. Ship a `harbor-managed-policy.json` via Firefox's `policies.json`, Chrome enterprise policies, or your MDM. It loads at the highest precedence and cannot be overridden by user policy or per-origin grants. Use this for company-wide deny rules, trusted-origin allowlists, label-egress restrictions, signed-publisher allowlists, and budget caps.

**Q: Does the LLM-classifier "auto mode" exist for Harbor?**

Not in the initial rollout. Anthropic-style classifier-as-approver is a candidate v2 feature, optionally backed by a local model so it doesn't leak data. For now, the equivalent is a well-tuned typed policy plus the SensitivityEngine plus label-aware egress checks plus the Watchdog. We expect those to be sufficient for most cases without needing a model in the authorization path.

**Q: Where's the empirical evidence?**

Honest answer: not yet. The architecture is grounded by analogy to comparable systems (Cedar / XACML for typed policy, CaMeL for information-flow tracking, Anthropic Auto Mode for graduated containment), but Harbor's specific tier ladder, label set, and watchdog rules need to run on real traffic before we can publish meaningful numbers. The telemetry section above lists what we plan to measure; we expect to publish summary statistics — sensitivity false-positive rate, label-egress block rate, attacker success on a public benchmark before/after containment — once we have a representative window of real-world usage.

---

## See also

- [Security & Privacy spec](../spec/security-privacy.md) — threat model and mitigations.
- [Web Agents API reference](WEB_AGENTS_API.md) — full API surface.
- [Sessions guide](SESSIONS_GUIDE.md) — when to use `window.ai` vs `agent.sessions`.
- [Testing your app](TESTING_YOUR_APP.md) — how the mock harness exposes policy state.
