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
3. **Information-flow tracking** so sensitive data carries a label that follows it through the agent, and any attempt to send it to a remote model, a remote tool, or a network egress point requires explicit consent.
4. A **safety net** — sensitivity gates, watchdog containment, and a non-bypassable enforcement chokepoint — that catches misbehavior automatically before a human has to react.

The system is **provider-agnostic**: permissions are expressed in terms of *effect* (local prompt vs remote prompt, same-origin egress vs cross-origin egress, reversible vs irreversible) rather than vendor brand. Whether you're using Firefox-ML, Chrome's on-device Gemini Nano, Ollama, OpenAI, or Anthropic, the same policy applies; the provider is metadata, not part of the permission name.

---

# Part 1: How it works

## The mental model

Every API call from a website goes through a single chokepoint: the **PolicyEngine**. The engine answers one question per call:

> Given this **principal** (origin, and whether the caller is a subagent), this typed **action** (`model.prompt.remote`, `tool.call`, `network.egress.cross_origin`, …), this **resource** (a tool, a URL, an element, a data label set), and this **context** (watchdog state, time, user gesture) — should this action be allowed, denied, previewed, or asked about?

It answers by walking a **tier ladder**, top to bottom, returning the first decisive answer.

```
Page calls window.ai or window.agent
            │
            ▼
   ┌────────────────────────────────────────────┐
   │   PolicyEngine                             │
   │                                            │
   │   Tier 0  Ambient ─────────────────────────► allow (no prompt, ever)
   │   Tier 1  Managed deny ────────────────────► deny  (org policy)
   │   Tier 2  Sensitivity gate ────────────────► ask   (sensitive site/element/tool)
   │   Tier 3  Information-flow check ──────────► ask / deny  (label-tainted egress)
   │   Tier 4  Watchdog containment ────────────► downgrade / deny
   │   Tier 6  Policy allow rule ───────────────► allow
   │   Tier 7  Policy ask rule ─────────────────► ask
   │   Tier 8  Per-origin grant ────────────────► allow / deny / ask
   │   Tier 9  Default for action's effect ─────► ask (read) / preview (write)
   └────────────────────────────────────────────┘
            │
            ▼
   audit  +  watchdog  +  execute
```

One important property of this ladder: **Sensitivity, info-flow, and watchdog checks always run.** They are above policy rules deliberately — a generous `allow` rule cannot defeat a label-aware egress check or a destructive-tool gate. This is the safety floor; nothing in the policy file or per-origin grants can disable it.

## Typed actions and effects

Every call is described by a **typed action** of the form `verb.noun.qualifier`. Internally, the engine works only in this form, and that's also what site authors and policy authors should use.

The typed namespace is organized by what the action actually does:

| Family | Action | What it does |
|---|---|---|
| `model.prompt.local` | LLM prompt against an on-device model (Firefox-ML, Chrome AI, Ollama loopback) | Data does not leave the machine |
| `model.prompt.remote.firstParty` | LLM prompt against a provider configured by *this* origin's account | Data leaves to a known third-party endpoint |
| `model.prompt.remote.thirdParty` | LLM prompt against the user's globally configured provider | Data leaves; user-controlled destination |
| `model.list` | Enumerate available providers/models | Metadata only |
| `tool.list` | Enumerate MCP tools | Metadata only |
| `tool.call` | Invoke an MCP tool | Effect depends on tool manifest |
| `tool.register` | Register a website-provided MCP server | Adds to the user's tool surface |
| `browser.read.activeTab` | Read DOM/text from the active tab | Reads page contents |
| `browser.read.screenshot` | Capture a screenshot of the active tab | Reads page visuals |
| `browser.read.tabs` | List metadata of open tabs | Reads tab titles/URLs |
| `browser.write.interact` | Click, fill, scroll on the active tab | Mutates page state |
| `browser.write.navigate` | Navigate the active tab | Mutates browsing context |
| `browser.write.tabsCreate` | Open a new tab | Mutates browsing context |
| `network.egress.same_origin` | HTTP(S) fetch to the same origin as the requester | Bounded data flow |
| `network.egress.cross_origin` | HTTP(S) fetch to a different origin | Possible exfiltration channel |
| `agent.delegate` | Invoke another registered agent | Capability passing |
| `agent.delegate.crossOrigin` | Invoke or message an agent in a different origin; granted per target site | Authority crossing trust boundaries |
| `agent.delegate.remote` | Invoke a remote A2A agent | Authority leaving the machine |

Every action carries metadata:

```ts
type ActionMeta = {
  effect: 'metadata' | 'read' | 'egress' | 'write' | 'identity' | 'destructive';
  locality: 'local' | 'same-origin' | 'cross-origin' | 'remote';
  reversible: boolean;
  defaultDataLabels: DataLabel[];   // labels this action's *output* carries
  acceptsLabels: DataLabel[];       // labels this action's *input* may carry
  defaultTTL: 'session' | 'tab' | 'task' | number;
};
```

`defaultDataLabels` and `acceptsLabels` are how information-flow tracking plugs in (next section).

### Effect tiers and the asymmetry of defaults

| Effect | Examples | Default behavior |
|---|---|---|
| **metadata** | `model.list`, `tool.list`, `agent.discover` | Auto-allowed; never prompts |
| **read** | `model.prompt.local`, `browser.read.activeTab`, `browser.read.screenshot` | Prompt once; TTL = **session-bound by default**; promotion to persistent requires either an explicit policy rule or a "pin after repeated trusted use" flow |
| **egress** | `network.egress.cross_origin`, `model.prompt.remote.thirdParty` | Prompt with destination shown; TTL = task-bound; previewed when carrying labeled data |
| **write** | `browser.write.interact`, `browser.write.navigate`, `tool.call` (writes) | Previewed before each commit |
| **destructive** | `tool.call` flagged destructive, `tool.register` of unknown servers | Always confirmed; cannot be auto-allowed via "always" |
| **identity** | password fields, payment forms, OAuth prompts (detected by SensitivityEngine) | Always confirmed; no "always" option |

This is the core fix to a real defect in the v1 sketch: previously, `model:prompt` lumped local on-device LLMs with remote cloud calls, and `browser:activeTab.read` was a "long-lived read" by default — both of which are exfiltration channels in a remote-LLM setup. The new model splits them, makes egress its own effect, and makes read TTL session-bound by default.

## Information-flow labels

The single most important upgrade over the v1 sketch is **labels that follow data**. When the engine intercepts a read of sensitive content, it tags the result with a label. When the same data is later about to leave the machine — through a remote LLM, a remote tool, a `network.egress.cross_origin`, an outbound email, or a file upload — the engine checks the labels and gates accordingly.

The label set, in order of severity:

| Label | Sources |
|---|---|
| `credentials` | Password fields, OAuth bearer tokens, API keys read from page |
| `payments` | Credit-card forms, bank-account fields, payment processor pages |
| `identity` | OAuth profile pages, account settings, government-ID-shaped strings |
| `regulated` | Healthcare portals, legal/financial regulated services |
| `confidential` | Pages tagged by the site (`<meta name="harbor:confidential">`) or by the user's policy |

Labels propagate through three boundaries:

1. **Page → agent context.** When `browser.read.activeTab` returns text containing a password input or a marked-confidential meta tag, the result is annotated with the label set in the audit log and in the session's working memory.
2. **Tool input → tool output.** A tool call whose arguments carry labels produces output that inherits those labels (conservative approximation; we cannot read the tool's internal logic).
3. **LLM input → LLM output.** A prompt whose user-or-tool messages carry labels produces output that inherits the union of those labels.

A label-aware egress check (Tier 3 in the ladder) fires when:

- An action with `locality: 'remote'` or `'cross-origin'` is invoked
- *and* its inputs carry one or more labels
- *and* the active policy does not explicitly permit that label to flow to that destination class

The default policy is to **deny** `credentials`, `payments`, and `identity` flowing to any remote destination, and to **ask** for `confidential` and `regulated`. Sites can override this for specific known destinations (`network.egress.cross_origin(domain:api.mycompany.com, accept_labels:[confidential])`).

This is a strictly stronger version of the v1 "exfil chain" timing heuristic. Instead of "did a sensitive read happen within 5 seconds of an outbound fetch," it asks "is this outbound fetch *carrying* labeled data?" — which doesn't require timing, doesn't have the false-positive rate of a sequence detector, and works even when the agent reasons across many steps.

Labels are pessimistic: a tainted input always taints the output. They are not a complete information-flow analysis (we are not running an interpreter over the agent's internal reasoning, the way CaMeL does for its custom Python). But they catch the obvious shapes of exfiltration — read a credential, summarize it, send the summary — that pure timing analysis cannot.

## The policy file

`harbor-policy.json` is a declarative document the user (or an organization) writes once. It lives in browser storage, can be edited from the sidebar, and can be shipped via managed-storage policies (Firefox `policies.json`, Chrome enterprise policies, MDM).

The schema is **typed**: every rule is `{id, effect, principal, action, resource, context}`. A short string form (`Tool(specifier)`) is also accepted for convenience and compiles to the same typed shape.

```jsonc
{
  "version": 2,
  "trustedOrigins": ["https://harbor.mycompany.com"],
  "sensitiveDomains": ["*.bank.com", "accounts.google.com", "*.gov"],

  "rules": [
    {
      "id": "reader-default",
      "effect": "allow",
      "principal": { "origin": "https://docs.example.com" },
      "actions": ["model.prompt.local", "browser.read.activeTab"],
      "resource": { "kind": "active_tab" },
      "context": { "ttl": "30d" }
    },
    {
      "id": "block-cross-origin-egress-of-credentials",
      "effect": "deny",
      "principal": { "origin": "*" },
      "actions": ["network.egress.cross_origin", "model.prompt.remote.thirdParty"],
      "resource": { "data_labels": ["credentials", "payments", "identity"] }
    },
    {
      "id": "preview-github-writes",
      "effect": "preview",
      "principal": { "origin": "https://app.example.com" },
      "actions": ["tool.call"],
      "resource": { "tool_server": "github", "tool_tags": ["remote_write"] }
    },
    {
      "id": "allow-known-llm-destinations",
      "effect": "allow",
      "principal": { "origin": "*" },
      "actions": ["network.egress.cross_origin"],
      "resource": {
        "domain": ["api.openai.com", "api.anthropic.com"],
        "accept_labels": []
      }
    }
  ],

  "budgets": {
    "perSession": { "maxToolCalls": 25, "maxNavigations": 10, "remotePromptUsd": 0.50 },
    "perOrigin":  { "rateToolCallsPerMin": 60 }
  }
}
```

**String DSL as sugar.** A shorter Claude-Code-style form is accepted in `allow`/`ask`/`deny` arrays for convenience and compiled to typed rules at load time:

| String form | Compiles to |
|---|---|
| `tool.call(github/create_issue)` | `{actions: ["tool.call"], resource: {tool_server: "github", tool_name: "create_issue"}}` |
| `tool.call(github/*)` | `{actions: ["tool.call"], resource: {tool_server: "github"}}` |
| `network.egress.cross_origin(domain:api.openai.com)` | `{actions: ["network.egress.cross_origin"], resource: {domain: "api.openai.com"}}` |

The sidebar editor lets users author either form and shows the typed compiled output.

**Precedence.** Sources merge in this order, with later sources unable to override earlier ones:

1. Managed (org policy via MDM / browser admin)
2. User policy file (`harbor-policy.json`)
3. Per-origin grants ("Allow always" / "Allow once" decisions remembered from prompts)

Within a single document, evaluation order is **deny → ask → preview → allow**, so a deny rule always wins over an allow rule.

## Sensitivity gates and tool manifest provenance

Even with broad allow rules, the SensitivityEngine forces a confirmation when the action is **structurally dangerous**, regardless of policy. Four classifiers:

| Classifier | Triggers on |
|---|---|
| **Domain** | URL matches `sensitiveDomains` (banks, gov, healthcare, identity providers, anything in the user's list) |
| **Element** | Click/fill targets a form containing `<input type="password">`, `<input autocomplete="cc-number">`, an OAuth submit, or a destructive-button class (`btn-delete`, `btn-danger`); also emits the corresponding `credentials`/`payments`/`identity` data label |
| **Tool (heuristic)** | Tool name matches a destructive verb (`delete`, `remove`, `purge`, `destroy`, `revoke`, `drop`, `wipe`) |
| **Tool (manifest)** | MCP manifest declares `sideEffect: "destructive"`, `reversible: false`, or has `riskTags` indicating elevated risk — **only honored if the manifest is from a trusted source** |

### Trusted vs untrusted manifests

The MCP spec is explicit that tool descriptions and annotations should be treated as untrusted unless the server is itself trusted. Harbor honors this: a self-attested `sideEffect: "reversible"` in a manifest **does not lower** the prompt threshold unless the manifest comes from a trusted source. Trusted sources are:

1. **Bundled servers** shipped with Harbor (signed by the build).
2. **Locally installed servers** (the user copied/installed them; their manifest sits in local storage and is treated like local config).
3. **Servers signed** by a trusted publisher key configured in policy.
4. **Servers explicitly trusted** via a policy rule pinning their identity (`trustedManifestServers: ["github.com/example/server@v1.2.3"]`).

For everything else — including auto-discovered MCP servers offered by the open web — manifest claims are advisory. The SensitivityEngine still uses them as a *signal* (a tool claiming to be destructive is treated as destructive even from an untrusted manifest, because that direction is safe to trust), but it never *lowers* the gate based on untrusted self-attestation.

When any classifier says "sensitive," PolicyEngine returns **ask** with `promptKind: 'sensitive'`. The user sees the action preview with extra context (what URL, what element, what tool, what arguments, what destination domain) and a "stop" button always available.

Sensitivity gates cannot be turned off site-by-site through ordinary "Allow always" — they require an explicit "I understand, always allow this category" decision in the sidebar that records exactly what was waived.

## Sessions

A **session** is origin-bound state for a task: the capabilities it requested, its limits (`maxToolCalls`, TTL), its history, and its usage so far. Each session is bound to:

- An origin (the requesting site)
- The capabilities it asked for: model access, a list of tools, browser access

Authority comes from the origin's grants — the permission prompt, `agent.requestPermissions`, per-tool allowlists — checked against the policy engine's tiers on every call. The engine sees the origin and the action, not the session. Harbor's background also refuses a prompt on a session that didn't ask for model access. The session's tool list and browser access are kept only by Harbor's page script, so a page can always use what its origin was granted. Treat the origin's grants as the boundary.

Session tool budgets are enforced in the background, against the session's `maxToolCalls`; calls past the budget fail with `ERR_BUDGET_EXCEEDED` without running the tool. Before the policy engine checks a `callTool()`, the call holds one of the session's slots (`SessionRegistry.reserveToolCall`). If the engine allows it, the slot is counted (`commitToolCall`); if the engine refuses it (a deny rule, a quarantined origin, a declined prompt), the slot is given back. A call refused by the page-side permission or allowlist check never holds a slot. So refused calls don't count against the budget, and a call whose tool runs and fails does. A call that finds every slot counted or held is refused before the policy engine, so it never prompts, and parallel calls can't each be prompted for the last slot. While one call's prompt is open, its slot stays held: another call that needs it is refused, even if the person then declines the first.

### Getting more authority later

There's no in-place upgrade: when a site needs more than its current session asked for — say, write access — it gets the origin grant it needs (`agent.requestPermissions()` shows the prompt) and calls `agent.requestCapabilities()` again for a new session. `requestCapabilities()` doesn't ask for grants: without one it fails. (It can still prompt when the watchdog has restricted the origin, or a policy rule says `ask` or `preview` for a requested capability.) The original session keeps working with what it already had. Terminate a session when you're done with it.

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
  └─ flagged       (nothing changes yet; the activity feed marks the origin)
       └─ restricted    (every action that would be allowed asks first)
            └─ quarantined   (every action is denied with ERR_QUARANTINED)
```

| Trigger (within one minute unless noted) | Moves the origin to |
|---|---|
| 20 tool calls | flagged |
| 60 tool calls | restricted |
| 5 cross-origin egresses (a page's own `fetch` isn't counted) | restricted |
| 3 distinct sensitive labels (no window) | restricted |
| 3 label-flow blocks | quarantined |
| 5 consecutive denials (no window) | quarantined |

The state only tightens: an origin never steps back down on its own. It clears when the origin is reset (the `watchdog.resetOrigin` message) or the extension restarts, since the counts live in memory. The thresholds are `DEFAULT_THRESHOLDS` in `extension/src/policy/watchdog.ts`.

## Audit, activity feed, and the decision simulator

Every PolicyEngine decision — whether it prompted, auto-allowed, denied, or downgraded — writes a record to a ring buffer (most recent ~5,000):

```ts
{
  ts: 1699999999000,
  origin: "https://example.com",
  action: "tool.call",
  resource: { tool_server: "github", tool_name: "create_issue" },
  inputLabels: ["confidential"],
  decision: "allow",
  source: "policy-allow",
  matchedRuleId: "preview-github-writes",
  reason: "matched rule preview-github-writes (preview), then allowed by user",
  correlationId: "req_xyz"
}
```

### Page calls

Harbor injects the page API (`window.ai`, `window.agent`, `navigator.modelContext`) itself, from `extension/src/page-api/`. A page's calls arrive over a port from Harbor's own content script, and Harbor takes the page's origin and tab from the browser's record of that port (`port.sender`), never from the message. The page API calls the rest of Harbor in-process through `page-api/harbor-core.ts`. Harbor runs each model and tool call through the PolicyEngine under that origin: `llm.chat`, `llm.chatStream`, `mcp.listTools`, `mcp.callTool`, and `session.create` (one check per requested capability). An `agent.run` therefore appears in the audit log as its tool listing, each model prompt and each tool call, in order. A prompt is classified as local or remote by the model it will run on. A prompt that names no model, as every `agent.run` prompt does, runs on the bridge's default model and is classified by that model. If the default model is unknown, the prompt counts as remote. A call without an origin is rejected.

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

If a rule or the watchdog makes Harbor ask before a page call (a browser call, a model prompt, a tool call, creating a session, a call to or from another agent, or opening the chat), and the page gives up waiting (its request times out after 30 seconds, or it cancels an `agent.run` or a stream), the call isn't performed even if the person then allows it.

Harbor holds the only store of per-origin grants and the only consent prompt. The page API checks Harbor's store (`permissions.check`) before each page call, and `agent.requestPermissions()` goes to Harbor's prompt (`permissions.request`). So a site revoked in Harbor's sidebar is refused on its next call. That includes work the site started while it still held the grant: every prompt on an open text session (`window.ai` or `agent.sessions.create`), and every model turn of a running `agent.run`, re-checks `model:prompt`. Revoking the site, or a one-time grant expiring, stops the next one. This holds in Safari too: its build injects the same page API.

The older, separate Web Agents API extension no longer injects anything, and Harbor no longer accepts a message or connection from it, or from any other extension: there is no cross-extension entry point left to reach.

For page calls, Harbor enforces `deny` (safety floor, policy rules, a denied origin grant, the watchdog). When the only thing left to settle is the origin grant (Tier 8 or the Tier 9 default), Harbor proceeds without prompting again, because the page API has just checked that grant in Harbor's store; the audit record carries `consent: "origin-grant"`. A watchdog restriction (Tier 4) or a policy rule that asks or previews (Tier 7) still shows Harbor's prompt.

The engine treats a write that can't be undone as needing a preview even when the origin holds a grant. Calling or messaging another agent on this device (`agent.invoke`, `agent.message`) doesn't count as one: the call itself changes nothing, and the other agent's own actions are checked separately. So once a site holds `agents:invoke` or `agents:message`, later calls go through without another prompt. An "Allow once" grant covers only the tab that granted it, for ten minutes; another tab on the same site is asked again.

A site's tool allowlist is deny-by-default: a site with no allowlist may call no tools.

If you're building a page, open Harbor's sidebar and pick the **Activity** tab to see every decision for your origin and the reason for it.

### Activity feed

The sidebar's **Activity** tab shows these records grouped by origin, filterable by decision and by time range. From any row the user can:

- Revoke the current grant for that action on that origin.
- Add an `allow`, `ask`, or `deny` rule to the policy file (with a generated typed rule).
- Drill into the full request payload for debugging.

This is also what makes silent decisions visible. If the engine auto-allowed a tool call because of a policy rule, the user sees that in the feed; nothing is hidden.

### Decision simulator

Each audit row in the sidebar has a **"Why?"** affordance. The **"What if?"** simulator runs behind the `policy.simulate` and `policy.replay` messages; the sidebar doesn't expose it yet.

**Why?** explains the decision in full: which tier of the ladder fired, which rule matched (with its `id`), which sensitivity classifier triggered (if any), what labels were on the input, and what the resulting effect was. This is the answer to the legitimate user question "why did Harbor block this?" — and it's the answer to the developer's question "why is my site getting `ERR_BLOCKED_BY_POLICY`?"

**What if?** is the simulator. It lets a developer replay the same decision against:

- A modified action set (what if the origin had asked for `model.prompt.local` instead of `.remote`?)
- A modified policy (what if I added this allow rule?)
- A modified label set (what if the input wasn't tainted with `credentials`?)

The simulator does not affect live state — it's a pure replay against the engine. Output is a side-by-side: actual decision vs simulated decision, with the same Why? trace for both. This is how a developer debugs a policy and authors capability requests against actual production traces.

## Telemetry goals

Once the system is deployed we want to track, in aggregate and locally:

- **Prompt rate** per origin and per action, so we know when a site is creating prompt fatigue.
- **Sensitivity false-positive rate** — how often a sensitivity gate fires on something the user immediately allows. Tells us where to tighten the classifier.
- **Label-egress block rate** — how often the info-flow tracker prevents a labeled-data exfiltration attempt. Tells us whether the label set covers reality.
- **Containment trigger frequency** — how often the watchdog tightens an origin's containment state, by rule.

This data is local-first; nothing is exported by default. The user can opt in to anonymized aggregates in the sidebar.

---

# Part 2: For site authors

This is what you, as an author of a website using `window.ai` and `window.agent`, need to know.

## The short version

```ts
const session = await agent.requestCapabilities({
  require: [
    { action: 'model.prompt.local' },
    { action: 'browser.read.activeTab' },
  ],
  optional: [
    { action: 'browser.write.interact' },
    { action: 'tool.call', server: 'github', toolTags: ['remote_write'] },
  ],
  budget: {
    navigations: 5,
    remotePromptUsd: 0.10,
  },
  reason: 'Read this page, draft a fix, and optionally apply it if you approve.',
});

// session.capabilities lists what the session got (may be a subset of `require + optional`).
// The session object only exposes those; the engine checks the origin's grants.
```

A few things worth knowing up front:

- The user has many ways to say "yes once" or "yes forever" without you needing different code paths.
- The user has many ways to silently restrict you (policy rules, watchdog containment, label-egress denial) — your code needs to handle structured errors gracefully.
- Asking for `model.prompt.local` instead of `model.prompt.remote.thirdParty` is dramatically cheaper to grant. Prefer local when you can.

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

The `reason` string appears prominently in the prompt. Users who write good `harbor-policy.json` rules use the reason as a signal of trustworthiness; vague reasons make it more likely your request gets denied or downgraded.

### 1a. Prefer local prompts when you can

`model.prompt.local` (Firefox-ML, Chrome AI, Ollama loopback) keeps the user's data on the machine. `model.prompt.remote.thirdParty` sends data to a cloud provider. The engine treats them very differently:

```ts
// Good if you don't need a frontier model — easier to grant, no egress concerns
{ action: 'model.prompt.local' }

// Required if you need a remote model. Be explicit; the user sees this.
{ action: 'model.prompt.remote.thirdParty' }
```

If your task can be done with a local model, ask for `model.prompt.local` only. The user's policy is much more likely to auto-allow it, and any data labels carried into the prompt won't trigger egress confirmations.

### 2. Pair scopes that belong together

Some scope combinations are common enough that the prompt batches them as a single decision (e.g. `model:prompt + browser:activeTab.read + browser:activeTab.screenshot` is a "Reader assistant" preset). Asking for them together — instead of one at a time as you discover you need them — gets the user to a single decision faster.

### 3. Start narrow; request more when the user gives you a reason to

Create your session with only the actions you need right away, and request a new, additionally-scoped session when the user explicitly takes an action that needs more — for example, clicking "Apply." This is the same shape Cursor and Claude Code use, and it gives the user a natural moment to grant write authority.

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

### 4. Annotate destructive tools in your MCP manifests, but don't expect them to be trusted

If you publish an MCP server, declare side effects:

```jsonc
{
  "server": "github",
  "tools": [
    { "name": "read_issue", "sideEffect": "none", "reversible": true },
    {
      "name": "create_issue",
      "sideEffect": "remote",
      "reversible": true,
      "idempotent": false,
      "dryRun": true,
      "dataEgressDomains": ["api.github.com"],
      "riskTags": ["remote_write"]
    },
    {
      "name": "delete_repo",
      "sideEffect": "destructive",
      "reversible": false,
      "riskTags": ["destructive", "irreversible"]
    }
  ]
}
```

The SensitivityEngine uses these to enrich its decisions. **Two important caveats**:

- Manifest claims that *increase* sensitivity (declaring something destructive) are honored from any source — that direction is safe to trust.
- Manifest claims that *decrease* sensitivity (declaring a destructive-looking tool to be reversible) are only honored from a **trusted manifest source** (bundled, locally installed, signed by a trusted publisher, or pinned in policy). For everything else, Harbor falls back to its heuristic — including a regex over the tool name (`/(delete|destroy|remove|purge|revoke|drop|wipe)/i`).

If you want users to grant your tools generously, get your server signed or installed locally. The trust path is what unlocks fast-path decisions.

### 5. Handle the new error shapes

Existing code already handles `ERR_PERMISSION_DENIED`. New shapes you should expect:

```ts
try {
  await agent.tools.call('filesystem/delete_file', { path });
} catch (err) {
  switch (err.code) {
    case 'ERR_PERMISSION_DENIED':
      // Standard denial — same as before
      break;
    case 'ERR_BLOCKED_BY_POLICY':
      // A user/org policy rule denied this. Don't retry.
      // err.details.policyRule tells you which rule.
      break;
    case 'ERR_QUARANTINED':
      // The Watchdog has quarantined this origin. Every call is denied
      // until the user resets it.
      break;
    case 'ERR_LABEL_FLOW_BLOCKED':
      // The action's input carries a data label (credentials, payments, identity)
      // that the policy does not allow to flow to this destination.
      // err.details.labels = ['credentials']
      // err.details.destination = 'api.openai.com'
      // Don't retry blindly — strip the label or use a local model.
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
- A `window.ai` text session's `prompt()` throws them, and `promptStreaming()` ends with them, when the session runs on Harbor's own model.
- `agent.run()` ends with them as its `error` event when its tool list is refused, or, on Harbor's own model, a model call.
- `agent.browser.*` calls (page interaction, screenshots, reading the page, navigation, `fetch` and the tab calls) throw them.
- `agent.agents.*` calls (registering, discovering, invoking and messaging agents, and orchestration) and `agent.chat.open()` throw them.

When the person has chosen an ACP agent to answer, prompts go to that agent rather than through Harbor's policy engine, so its failures use the ACP codes (`ERR_AGENT_FAILED`, `ERR_AGENT_BUSY`, `ERR_AGENT_REFUSED`, `ERR_AGENT_LIMIT`). `agent.run()`'s tool list is still checked by the policy engine on either backend.

A declined Harbor prompt is `ERR_PERMISSION_DENIED`. Any other failure keeps the call's own code (`ERR_TOOL_FAILED`, `ERR_MODEL_FAILED`, `ERR_AGENT_FAILED`), even when a tool or model returns text that looks like one of these codes.

`ERR_LABEL_FLOW_BLOCKED` can't occur on a page's call yet: Harbor doesn't attach data labels to page tool calls or prompts. Handle it anyway; it's reserved for when it does.

### 6. Make pre-action reviews readable

When a write-tier action triggers a preview, the user sees an `ActionPreview` rendered by Harbor. You can help that render well:

```ts
await agent.tools.call('email/send', {
  to: 'alice@example.com',
  subject: 'Your weekly summary',
  body: '...',
}, {
  preview: {
    title: 'Send weekly summary email',
    description: 'To Alice, with this week\'s reading list',
  },
});
```

If you don't supply `preview`, Harbor synthesizes one from the tool name and an arguments digest. Your version is almost always more useful to the user.

### 7. Test against the harness

The mock harness exposes the new surfaces so your tests can drive them:

```js
import { installWebAgentsMock } from './harbor-test/mock.js';
const mock = installWebAgentsMock(globalThis);

// Apply a typed policy
mock.permissions.applyPolicy({
  rules: [
    { id: 'r1', effect: 'allow', actions: ['model.prompt.local', 'browser.read.activeTab'] },
    { id: 'r2', effect: 'deny',  actions: ['tool.call'], resource: { tool_server: 'filesystem' } },
  ],
});

// Force a sensitivity classification for an arbitrary URL
mock.permissions.markSensitive('https://example.com/payment');

// Inject data labels onto a read result, so you can test egress paths
mock.permissions.tagWithLabels({
  origin: 'https://example.com',
  action: 'browser.read.activeTab',
  labels: ['credentials'],
});

// Drive the simulator
const sim = mock.permissions.simulate({
  origin: 'https://example.com',
  action: 'model.prompt.remote.thirdParty',
  inputLabels: ['credentials'],
});
console.log(sim.decision); // 'deny', source: 'infoflow-deny'
```

See [TESTING_YOUR_APP.md](TESTING_YOUR_APP.md) for the full list.

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
  manifest-trust.ts   # Trusted manifest registry; signature verification
  watchdog.ts         # Rolling stats, anomaly rules, containment
  consent-bus.ts      # Pending-consent broadcaster (sidebar + popup)
  audit.ts            # Ring-buffer audit log
  simulator.ts        # Decision replay against modified context
```

The flow through the system is:

```
agents/handlers/*  ─[requireAction]─►  policy/engine.evaluate
                                              │
                                              ├─►  policy/sensitivity
                                              ├─►  policy/labels (input/output flow)
                                              ├─►  policy/store (typed rules)
                                              ├─►  policy/watchdog (state)
                                              ├─►  policy/manifest-trust (for tool meta)
                                              ├─►  consent-bus (when ask/preview)
                                              └─►  policy/audit
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
2. **Wire the message type** to that action in `REQUIRED_ACTIONS` at the bottom of `agents/types.ts`.
3. **Gate the handler** with `requireAction(ctx, sender, 'browser.write.tabsMove', { resource })`.
4. **Add unit tests** in `policy/__tests__/engine.test.ts` covering at least one allow path and one ask/deny path.

## Adding a data label

```ts
// extension/src/policy/labels.ts
export const DATA_LABELS = {
  // ...
  'authToken': {
    title: 'Authentication token',
    severity: 'critical',
    defaultEgressPolicy: 'deny',  // never egress without explicit allow
  },
} as const;
```

Then teach the SensitivityEngine to emit it:

```ts
// extension/src/policy/sensitivity.ts
export function classifyElement(info: ElementInfo): SensitivityResult {
  // ...
  if (/Bearer\s+[A-Za-z0-9._-]+/.test(info.nearbyText)) {
    return { sensitivity: 'sensitive', labels: ['authToken'] };
  }
}
```

The engine automatically applies the egress policy at Tier 3.

## Adding a sensitivity rule

(Same as before — sensitivity classifiers live in `sensitivity.ts`. New rule:)

```ts
// extension/src/policy/sensitivity.ts
export function classifyTool(server: string, name: string): SensitivityLabel {
  // existing rules...
  if (server === 'stripe' && /^(charge|refund|void)/.test(name)) {
    return 'destructive';
  }
  return 'safe';
}
```

The engine consults `classifyTool` at Tier 2 before any policy or grant is checked, so this is non-bypassable by `allow` rules.

## Adding a trusted-manifest source

```ts
// extension/src/policy/manifest-trust.ts
export const TRUSTED_PUBLISHERS = {
  'mozilla': { publicKey: '...', name: 'Mozilla' },
  'anthropic': { publicKey: '...', name: 'Anthropic' },
};

export function isTrustedManifest(manifest: ToolManifest): boolean {
  if (manifest.source === 'bundled') return true;
  if (manifest.source === 'local-install') return true;
  if (manifest.signedBy && verifySignature(manifest)) return true;
  if (policyConfig.trustedManifestServers?.includes(manifest.serverId)) return true;
  return false;
}
```

The engine asks `isTrustedManifest` before lowering a sensitivity gate based on a manifest claim. It never asks before raising one.

## What you should never do

- **Don't bypass `requireAction`.** Every API boundary uses it. If you're tempted to skip the check, you almost certainly want to register an action with `effect: 'metadata'` instead.
- **Don't auto-allow a write-effect or egress-effect action from inside a handler.** The effect is the contract; if you've decided a particular write should be auto-allowed, that's a policy `allow` rule and belongs in the user's `harbor-policy.json`.
- **Don't trust a remote-discovered manifest.** Always go through `isTrustedManifest` before honoring a manifest's *downgrade* of sensitivity.
- **Don't store secret data in audit records.** Use a digest. Audit records are user-readable and exportable.
- **Don't add a sensitivity false positive without an override path.** Every "always confirm" rule needs a corresponding "always allow this on this origin" surface in the sidebar, or you've created an unfixable annoyance.

## Changing a Watchdog trigger

The Watchdog's triggers are fixed checks in `maybeEscalate` in `extension/src/policy/watchdog.ts`, with their limits in `DEFAULT_THRESHOLDS`. To add one, count the new signal in `observe` (it runs on every audit-log append), add a threshold, and escalate in `maybeEscalate`. Keep the ratchet one-way. Test it by feeding audit records to `observe` with chosen timestamps (`extension/src/policy/__tests__/watchdog.test.ts`).

## Wiring a new prompt UI surface

The ConsentBus is a fanout that any number of UIs can subscribe to. Today there are two consumers: the sidebar inline panel (`extension/src/sidebar/pending-consent.ts`) and the popup window (`extension/src/permission-prompt.ts`). To add a third (e.g. an in-page chip rendered by the content script):

```ts
// extension/src/agents/content-script.ts
import { ConsentBus } from '../policy/consent-bus';

ConsentBus.subscribe((req) => {
  if (req.preview.kind !== 'click' && req.preview.kind !== 'fill') return;
  // Render a small in-page chip near the target element.
  const chip = renderChip(req.preview);
  chip.onAllow = () => ConsentBus.resolve(req.id, { decision: 'allow', ttl: 'session' });
  chip.onDeny  = () => ConsentBus.resolve(req.id, { decision: 'deny' });
});
```

Multiple UIs may surface the same request; `ConsentBus.resolve` is idempotent (first response wins) and broadcasts a `permissions_resolved` event so the others dismiss themselves.

---

# Part 4: For users

This is what the system looks like from the user's chair, and what you can do with it.

## What you'll see in normal use

For most sites, most of the time, you won't see anything. Harbor's whole goal is to *not* interrupt you. The pattern looks like this:

1. You install Harbor and either accept the default policy or write your own.
2. You visit a site. The site's agent quietly does what it's allowed to do.
3. You go on with your life.

You become aware of Harbor in three moments:

- **The first time** a new site asks for a meaningful capability — a one-time prompt with a clear description.
- **When something dangerous is about to happen** — a payment, a destructive action, a navigation to your bank — you'll be asked even if you've previously said "always allow."
- **When something has gone wrong** — a site is misbehaving, your budget is hitting its cap, an automated containment fired — Harbor surfaces it in the sidebar.

## The sidebar at a glance

Harbor's sidebar is the home for everything in this document. It has four tabs:

| Tab | What's there |
|---|---|
| **Sessions** | Every active agent session, its origin, its budget. One-click Stop, Pause, Revoke. |
| **Policy** | Your `harbor-policy.json` editor. JSON, with schema validation and rule helpers. |
| **Origins** | Per-site grants — what you've said "Allow always" or "Allow once" to, on which sites. |
| **Activity** | Audit feed: every decision the engine has made, with the reason. Filter by site, by decision, by time. |

A small Harbor icon also lives in the browser toolbar with a single state indicator: green (idle), blue (an agent is acting), yellow (an agent is waiting on you), red (a containment has fired).

## How prompts feel different now

When Harbor does ask, the prompt itself is more informative than before. Four kinds:

### First-use prompt

The traditional "this site wants permission to X" dialog, but with several new things:

- A clear **effect badge** (read / write / egress / destructive).
- The action's **locality** (`local` for on-device, `remote` for cloud).
- The site's **`reason`** in plain language, not a generic "AI features."
- A **default focused button** that matches the effect — read effects default to **Allow for this session**, write effects default to **Allow once**, persistent grants are never the default.
- A third option: **"Always allow if it matches a rule…"** which generates a `harbor-policy.json` rule from this grant and adds it to your policy file. That's how you build up a policy over time without ever opening the editor.

The change from v1: persistent grants ("Allow always") used to be the default for reads. They aren't anymore. Reads default to session-bound, and you have to actively pin a grant after using it a few times — usually after one trusted use, the prompt itself offers "I've used this site three times, always allow."

### Egress prompt

When a write or read crosses out of your machine — a remote-model prompt, a cross-origin fetch, a tool that talks to a third-party API — you see a destination-aware prompt:

```
┌────────────────────────────────────────────────┐
│  example.com wants to send data outside your   │
│  machine                                       │
│                                                │
│  Action: model.prompt.remote.thirdParty        │
│  Destination: api.openai.com                   │
│  Data carries label: confidential              │
│                                                │
│  Allow once   |   Allow for this session       │
│  [Block this destination]                      │
└────────────────────────────────────────────────┘
```

If the data carries a `credentials`, `payments`, or `identity` label, there's no "Allow" path — only "Block." Those labels are configured to never leave the machine without an explicit policy rule the user wrote in the sidebar.

### Sensitive-action prompt

When the SensitivityEngine catches something — you're about to delete a repo, navigate to a bank, click submit on a payment form — you see a different kind of dialog:

```
┌────────────────────────────────────────────────┐
│  Sensitive action                              │
│                                                │
│  example.com wants to:                         │
│  ▸ Delete repository alice/old-project         │
│                                                │
│  This action is irreversible.                  │
│                                                │
│  [Cancel]   [Confirm once]                     │
└────────────────────────────────────────────────┘
```

There's no "always allow" option for sensitive actions, because that would defeat the purpose. You can move the rule to your sensitive-domains list later if you want to suppress this category of prompt for a specific origin, but it's a deliberate decision in the sidebar, not a one-click waiver.

### The decision simulator

Every row in the Activity feed has a **"Why?"** link. Clicking it opens a panel that walks through the decision: which tier of the ladder fired, which rule matched, what labels were on the input, what the resulting effect was. It's how you investigate "why did Harbor block this?" without having to read JSON.

## Building a policy without ever editing JSON

You don't have to write a policy file by hand. The sidebar offers four flows that produce one for you:

1. **From a prompt.** When a first-use prompt appears, the "Always allow if it matches a rule…" button asks you what scope of rule you want — *exactly this tool*, *all tools from this server*, *all read-prefixed tools* — and adds it.
2. **From the activity feed.** Any allowed action has a "Make this automatic" link that creates a matching `allow` rule. Any denied or contained action has a "Always deny" link that creates a `deny` rule.
3. **From the origins tab.** Any per-origin grant can be promoted to a global rule with one click ("Allow this on every site that asks for it").
4. **From a preset.** Harbor ships a small set of canned policies (Conservative, Balanced, Permissive, Developer, Researcher) you can use as a starting point and customize from there.

The JSON is always the source of truth, and you can always open the editor if you want to write rules directly. But you can run Harbor for a year without ever touching it.

## When something feels wrong

A few things to check first, in order:

1. **Is the session containment level above "normal"?** Sidebar → Sessions → look for a yellow or red badge. If yes, the Watchdog restricted it for a reason; the Activity tab will tell you what.
2. **Is there a deny rule matching what the site is trying to do?** Sidebar → Policy. Look for a `deny` rule that mentions the scope or tool the site is asking about. The Activity tab also shows the rule that fired.
3. **Did you grant "Allow once"?** Sidebar → Origins → look for the origin. If the grant has expired (10 minutes after grant, or when the tab closed), the next call will re-prompt.
4. **Does the session hold the capability the site is trying to use?** A session only has the actions it was granted; a write it never asked for (or that you never granted) fails with `ERR_PERMISSION_DENIED`. The Sessions tab shows what each session can do.

If a site is hammering you with prompts, that's almost always a sign the site is asking poorly — broad scopes with vague reasons, or asking for one scope at a time when it should batch. Use the activity feed to identify which scope is coming up most often, then either grant it always (if you trust the site) or write a deny rule (if you don't).

## What you control, summarized

| You can... | Where |
|---|---|
| See every active agent session | Sidebar → Sessions |
| Stop a session immediately | Sidebar → Sessions → Stop, or sidebar header Stop All |
| Reset a quarantined site | Not in the sidebar yet; the `watchdog.resetOrigin` message clears it |
| Edit your policy file | Sidebar → Policy |
| Add a rule from a recent action | Sidebar → Activity → "Make this automatic" |
| See exactly what an agent did and why | Sidebar → Activity |
| Revoke a per-origin grant | Sidebar → Origins → Revoke |
| Mark a domain as sensitive | Sidebar → Policy → `sensitiveDomains` array |
| Set per-session budgets | Sidebar → Policy → `budgets` block |
| Export your policy / activity for support | Sidebar → Policy → Export, Activity → Export |

---

## Glossary

- **Action (typed).** A `verb.noun.qualifier` identifier (`model.prompt.local`, `network.egress.cross_origin`) that describes one effect the engine can authorize.
- **Action metadata.** Each action's declared `effect`, `locality`, `reversible`, `defaultDataLabels`, and `acceptsLabels`.
- **Ambient.** An action whose `effect` is `metadata` — auto-allowed, never prompts.
- **Audit record.** A single decision logged by the PolicyEngine, with full trace including matched rule, source, and labels.
- **Containment.** A graduated reduction of a session's authority, walked by the Watchdog in response to bad behavior; see [The Watchdog](#the-watchdog).
- **Data label.** A tag (`credentials`, `payments`, `identity`, `confidential`, `regulated`) attached to data flowing through the agent. Tracked through reads, prompts, and tool calls; checked at egress.
- **Decision simulator.** A read-only replay of a recorded decision under different rules or labels, reached through the `policy.simulate` and `policy.replay` messages.
- **Effect.** One of `metadata`, `read`, `egress`, `write`, `identity`, `destructive`. Drives default UX.
- **Locality.** One of `local`, `same-origin`, `cross-origin`, `remote`. Drives egress treatment.
- **Manifest provenance.** Whether an MCP manifest is trusted (bundled, locally installed, signed, or pinned in policy) — determines whether the engine honors its self-attested sensitivity claims.
- **Origin grant.** A per-site allow/once/deny remembered from a prompt. Lowest-precedence layer; the policy file overrides it.
- **PolicyEngine.** The single function that decides whether to allow, deny, ask, or preview each API call.
- **Policy file.** `harbor-policy.json` v2 — the user's declarative typed rules, merged with managed-storage policies.
- **Sensitivity.** Structural classification (safe / sensitive / destructive) independent of policy. Cannot be lowered by an `allow` rule.
- **Sidebar.** Harbor's primary UI surface, where sessions, policy, origins, and activity live.
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

**Q: Why aren't reads "Allow always" by default anymore?**

Because reads can feed exfiltration. Reading a tab is harmless on its own; reading a tab and then sending the contents to a remote LLM is exfiltration. The new default is that reads stick around for the session but expire when the session ends; you have to actively pin them to make them persistent. After three trusted uses on the same site the prompt offers to do that for you in one click.

**Q: Why isn't there a single "Auto-approve everything safe" toggle?**

There is, sort of — install one of the bundled presets (Permissive) and you'll get exactly that behavior. We don't expose it as a single toggle because "safe" depends on what your trusted infrastructure looks like. The Permissive preset trusts a generous set of allow rules; if you have a stricter environment, edit them.

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
