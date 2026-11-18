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

> Given this **principal** (origin + session + capability token), this typed **action** (`model.prompt.remote`, `tool.call`, `network.egress.cross_origin`, …), this **resource** (a tool, a URL, an element, a data label set), and this **context** (session mode, watchdog state, time, user gesture) — should this action be allowed, denied, previewed, or asked about?

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
   │   Tier 5  Capability token check ──────────► deny (token doesn't grant this action)
   │   Tier 6  Policy allow rule ───────────────► allow
   │   Tier 7  Policy ask rule ─────────────────► ask
   │   Tier 8  Per-origin grant ────────────────► allow / deny / ask
   │   Tier 9  Default for action's effect ─────► ask (read) / preview (write)
   └────────────────────────────────────────────┘
            │
            ▼
   audit  +  watchdog  +  execute
```

One important property of this ladder: **Sensitivity, info-flow, watchdog, and capability tokens always run.** They are above policy rules deliberately — a generous `allow` rule cannot defeat a label-aware egress check or a destructive-tool gate. This is the safety floor; nothing in the policy file or per-origin grants can disable it.

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
| `agent.delegate.crossOrigin` | Invoke an agent in a different origin | Authority crossing trust boundaries |
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
      "context": { "session_mode": ["plan", "execute"], "ttl": "30d" }
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

## Sessions, capability tokens, and modes

A **session** is the agent context for a particular task. Each session is bound to:

- An origin (the requesting site)
- A **capability token** — an opaque identifier that the engine maps to a specific allowed-action set, label-acceptance set, budget, TTL, and parent token (if delegated)
- A **mode**: `plan`, `execute`, or `watch`

The capability token is the unit of authority. It's how Harbor implements the review's recommendation that authority be **attenuated**, not ambient: every agent action checks the token, and a session in Plan mode literally has a token whose `allowedActions` excludes every `effect: 'write'` action — there is nothing for the engine to "force deny," because the authority isn't there to begin with.

### What's in a token

```ts
type CapabilityToken = {
  tokenId: string;
  origin: string;
  parentTokenId?: string;        // for delegated subagents
  allowedActions: TypedAction[]; // strict subset of parent if delegated
  acceptedLabels: DataLabel[];   // labels this token can carry across egress
  budgets: { toolCalls?: number; navigations?: number; remotePromptUsd?: number };
  ttl: number;                   // expires at this timestamp
  mode: 'plan' | 'execute' | 'watch';
};
```

### The three modes

| Mode | What the token allows | When it's used |
|---|---|---|
| **Plan** | Reads, prompts, summarization. Token's `allowedActions` excludes all `write` and `egress` actions. | Default for unknown origins. The agent can explore and propose, but cannot modify or transmit. |
| **Execute** | Normal evaluation per the tier ladder. Token has the requested action set. | Default for trusted origins, or after the user moves a session out of Plan. |
| **Watch** | Like Execute, but every `write`-effect or labeled-`egress` action returns **preview** and pauses for explicit user confirmation. | Auto-engaged on sensitive domains; user can engage manually. |

Mode transitions don't just change a flag — they **mint a new token** with a different `allowedActions` set. Old tokens, if cached anywhere, become invalid; new ones are bound to the new mode.

### Delegation: subagents inherit a strict subset

When a session calls `agent.delegate` to invoke a subagent, the parent must mint a child token. The engine enforces:

- Child `allowedActions` ⊆ parent `allowedActions`
- Child `acceptedLabels` ⊆ parent `acceptedLabels`
- Child `budgets` ≤ parent `budgets` (and consume from the parent's pool)
- Child `ttl` ≤ parent `ttl`
- Child can have a tighter `mode` than the parent (parent in Execute can spawn a child in Plan), but never broader

This is capability attenuation in the OCAP sense: the parent passes a strict subset of its authority to the child, and the child cannot accumulate authority by recursion. Sanity check: if you revoke the parent token, every descendant token is revoked.

The Watchdog can downgrade modes automatically (Execute → Watch → Plan) in response to bad behavior; this is implemented as re-minting the token with a tighter `allowedActions` set. The user can always re-upgrade them from the sidebar.

## The Watchdog

A background monitor that subscribes to the SessionRegistry and the PolicyEngine audit stream and maintains rolling statistics per `(origin, sessionId)`:

- Tool-call rate (1m, 5m, 1h windows)
- Navigation rate
- Denial count and consecutive denials
- Budget consumption
- Unique cross-origin egress targets
- **Label-flow events** (data with label `X` was about to flow to destination class `Y`)

The Watchdog is a complement to the structural defenses (info-flow labels, sensitivity gates, capability tokens), not a replacement. The structural defenses prevent the action; the Watchdog notices the *attempt* and adjusts the envelope so the next attempt is harder.

| Rule | Trigger | Default response |
|---|---|---|
| **Velocity spike** | rate > 3× rolling average | Toast notification in sidebar |
| **Repeated denials** | ≥ 3 consecutive denials | Re-mint session token in Plan mode |
| **Budget overspend** | > 90% of budget consumed in a single burst | Suspend; ask to extend |
| **Repeated label-egress attempts** | 2+ blocked egress attempts carrying `credentials`/`payments`/`identity` in a single session | Quarantine session |
| **Scope escalation** | Origin requests an action outside its current token's `allowedActions` twice in a row | Terminate session; mark origin "needs review" |
| **New resource class** | navigation/tool category never used in last 50 actions, then used 3+ times | Notify only |

When a rule triggers, the Watchdog walks a **graduated containment ladder**, never jumping straight to a kill switch:

```
normal
  └─ restricted-write    (write tier denied; reads continue)
       └─ sandbox        (no remote fetch, no nav; read-only on current tab)
            └─ quarantined   (every action requires explicit allow)
                 └─ killed   (session terminated; origin in cooldown)
```

Every transition is reversible by the user from the sidebar in one click.

## Audit, activity feed, and the decision simulator

Every PolicyEngine decision — whether it prompted, auto-allowed, denied, or downgraded — writes a record to a ring buffer (most recent ~5,000):

```ts
{
  ts: 1699999999000,
  origin: "https://example.com",
  sessionId: "sess_abc",
  tokenId: "tok_def",
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

Harbor holds the only store of per-origin grants and the only consent prompt. The page API checks Harbor's store (`permissions.check`) before each page call, and `agent.requestPermissions()` goes to Harbor's prompt (`permissions.request`). So a site revoked in Harbor's sidebar is refused on its next call. Harbor's Safari build doesn't inject the page API yet.

The older, separate Web Agents API extension no longer injects anything, and Harbor no longer accepts a message or connection from it, or from any other extension: there is no cross-extension entry point left to reach.

For page calls, Harbor enforces `deny` (safety floor, policy rules, a denied origin grant, the watchdog). When the only thing left to settle is the origin grant (Tier 8 or the Tier 9 default), Harbor proceeds without prompting again, because the page API has just checked that grant in Harbor's store; the audit record carries `consent: "origin-grant"`. A watchdog restriction (Tier 4) or a policy rule that asks, previews or attenuates (Tier 7) still shows Harbor's prompt.

A site's tool allowlist is deny-by-default: a site with no allowlist may call no tools.

If you're building a page, open Harbor's sidebar and pick the **Activity** tab to see every decision for your origin and the reason for it.

### Activity feed

The sidebar's **Activity** tab shows these records grouped by origin, filterable by decision and by time range. From any row the user can:

- Revoke the current grant for that action on that origin.
- Add an `allow`, `ask`, or `deny` rule to the policy file (with a generated typed rule).
- Drill into the full request payload for debugging.

This is also what makes silent decisions visible. If the engine auto-allowed a tool call because of a policy rule, the user sees that in the feed; nothing is hidden.

### Decision simulator

Each audit row has a **"Why?"** affordance and a **"What if?"** affordance.

**Why?** explains the decision in full: which tier of the ladder fired, which rule matched (with its `id`), which sensitivity classifier triggered (if any), what labels were on the input, and what the resulting effect was. This is the answer to the legitimate user question "why did Harbor block this?" — and it's the answer to the developer's question "why is my site getting `ERR_BLOCKED_BY_POLICY`?"

**What if?** is the simulator. It lets the user (or a developer in dev tools) replay the same decision against:

- A modified action set (what if the origin had asked for `model.prompt.local` instead of `.remote`?)
- A modified policy (what if I added this allow rule?)
- A modified session mode (what if this had been in Execute instead of Plan?)
- A modified label set (what if the input wasn't tainted with `credentials`?)

The simulator does not affect live state — it's a pure replay against the engine. Output is a side-by-side: actual decision vs simulated decision, with the same Why? trace for both. This is how a user debugs a policy without having to think in JSON, and how a developer authors capability requests against actual production traces.

## Telemetry goals

Once the system is deployed we want to track, in aggregate and locally:

- **Prompt rate** per origin and per action, so we know when a site is creating prompt fatigue.
- **Sensitivity false-positive rate** — how often a sensitivity gate fires on something the user immediately allows. Tells us where to tighten the classifier.
- **Label-egress block rate** — how often the info-flow tracker prevents a labeled-data exfiltration attempt. Tells us whether the label set covers reality.
- **Containment trigger frequency** — how often the watchdog re-mints a token at lower authority, by rule.
- **Token attenuation depth** — how often agents delegate to subagents and how many levels deep delegation goes in practice.

This data is local-first; nothing is exported by default. The user can opt in to anonymized aggregates in the sidebar.

---

# Part 2: For site authors

This is what you, as an author of a website using `window.ai` and `window.agent`, need to know.

## The short version

```ts
const session = await agent.requestCapabilities({
  mode: 'plan',                     // start narrow
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

// session.token is your capability token. The engine uses it to enforce.
// session.granted lists what was granted (may be a subset of `require + optional`).
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

### 3. Default to Plan mode; mint fresh authority after a user gesture

Create your sessions in Plan mode and only request Execute (or specific write actions) when the user explicitly takes an action that requires writes. This is the same shape Cursor and Claude Code use, and it gives the user a natural moment to grant write authority.

Capability tokens are intentionally one-way: `agent.upgradeSession()` can **narrow** a session (Execute → Watch → Plan) but cannot widen it. To widen, you mint a fresh capability token by calling `agent.requestCapabilities()` again. The user gets a new prompt that names the additional authority — that's the "natural moment" for a re-grant, and it keeps the audit log honest about which token was acting when.

```ts
const planSession = await agent.requestCapabilities({
  name: 'Article assistant',
  mode: 'plan',
  require: [
    { action: 'model.prompt.local' },
    { action: 'browser.read.activeTab' },
    { action: 'browser.read.screenshot' },
  ],
});

// Later, when the user clicks "Apply suggested edit", request a new
// session with write authority. The user sees a fresh prompt scoped
// to exactly the new actions.
const writeSession = await agent.requestCapabilities({
  name: 'Apply suggested edit',
  mode: 'execute',
  require: [
    { action: 'browser.write.interact' },
  ],
  reason: 'Apply the changes you approved',
});
```

The user gets two prompts, but each is small and scoped to a real moment of intent. That's much cheaper to grant than one giant upfront prompt. The two sessions hold separate capability tokens; the original Plan session keeps working for further reads, and the new Execute session covers the write you just authorized. When the write is done, terminate it.

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
    case 'ERR_SESSION_CONTAINED':
      // The Watchdog has restricted this session.
      // err.details.containmentLevel = 'restricted-write' | 'sandbox' | ...
      break;
    case 'ERR_LABEL_FLOW_BLOCKED':
      // The action's input carries a data label (credentials, payments, identity)
      // that the policy does not allow to flow to this destination.
      // err.details.labels = ['credentials']
      // err.details.destination = 'api.openai.com'
      // Don't retry blindly — strip the label or use a local model.
      break;
    case 'ERR_TOKEN_EXPIRED':
      // Capability token has expired or been revoked. Re-request.
      break;
  }
}
```

Treat `ERR_BLOCKED_BY_POLICY`, `ERR_LABEL_FLOW_BLOCKED`, and `ERR_SESSION_CONTAINED` as terminal: the user has already been told, and retrying just generates noise in their activity feed.

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

// Inject Watchdog state
mock.permissions.setSessionContainment(sessionId, 'sandbox');

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
  tokens.ts           # Capability token mint / validate / attenuate
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
                                              ├─►  policy/tokens (capability check)
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

## Adding a Watchdog rule

A rule is a pure function from `WatchdogState` to a (possibly empty) signal:

```ts
// extension/src/policy/watchdog.ts
export const rules: WatchdogRule[] = [
  // existing rules...

  {
    name: 'unusual_navigation_burst',
    evaluate(state) {
      if (state.navigationsLastMinute > 30) {
        return {
          severity: 'warn',
          message: `${state.origin} navigated ${state.navigationsLastMinute}x in 1 min`,
          response: { kind: 'downgrade', to: 'restricted-write' },
        };
      }
      return null;
    },
  },
];
```

Rules are evaluated on every audit-log append. Test them with mocked `Date.now` and an injected stat history (`watchdog.spec.ts`).

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
| **Sessions** | Every active agent session, its origin, its mode (Plan/Execute/Watch), its containment level, its budget. One-click Stop, Pause, Mode change, Revoke. |
| **Policy** | Your `harbor-policy.json` editor. JSON, with schema validation and rule helpers. |
| **Origins** | Per-site grants — what you've said "Allow always" or "Allow once" to, on which sites. |
| **Activity** | Audit feed: every decision the engine has made, with the reason. Filter by site, by decision, by time. |

A small Harbor icon also lives in the browser toolbar with a single state indicator: green (idle), blue (an agent is acting), yellow (an agent is waiting on you), red (a containment has fired).

## Plan, Execute, Watch — what these modes feel like

When a session starts, it's in one of three modes. Think of these as how much rope you're giving the agent.

### Plan mode (default for new sites)

The agent can read the page, see your tabs (with permission), summarize, search, and propose. **It can't click anything, fill anything, navigate anywhere, or call any tool that changes the world.** Use this mode whenever you want to know what the agent thinks, before letting it act.

You'll see a pale green border on the sidebar in this mode. The agent's responses might look like:

> *I'd suggest filing this bug as a GitHub issue with title "X" and body "Y". Want me to actually create it? You'd need to switch this session to Execute first.*

### Execute mode (default for trusted sites)

Normal operation. The agent reads, prompts, calls tools, fills forms, clicks buttons. Things you've previously said yes to keep working without prompts. New sensitive things still confirm.

You'll see a yellow border on the sidebar. The Stop button in the sidebar header is your single point of control — pressing it terminates every active session immediately.

### Watch mode (auto-engages on sensitive sites)

Like Execute, but every write-tier action **previews and pauses**. You see exactly what the agent is about to click, fill, or navigate to, and approve each step. Slow, but the right mode for banking, government services, healthcare, and anything you marked as sensitive.

You'll see a red border on the sidebar and a "Step / Skip / Stop" control next to each pending action.

You can change a session's mode at any time. The agent doesn't get to refuse.

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

### Containment notice

Not a prompt — a notification. Looks like:

```
┌────────────────────────────────────────────────┐
│  Session restricted                            │
│                                                │
│  example.com tried to send data tagged         │
│  `credentials` to an external service.         │
│  This session is now read-only.                │
│                                                │
│  [Show in activity]  [Restore]  [Stop session] │
└────────────────────────────────────────────────┘
```

You don't have to do anything. The agent has been quietly restricted, and you can choose to look closer or move on. The "Restore" button puts the session back into Execute mode if you trust the agent's intent; "Stop session" terminates it cleanly.

### The decision simulator

Every row in the Activity feed has a **"Why?"** link. Clicking it opens a panel that walks through the decision: which tier of the ladder fired, which rule matched, what labels were on the input, what the resulting effect was. Below that is a **"What if?"** panel that lets you replay the decision under different conditions:

- What if this had been a local prompt instead of remote?
- What if this rule was changed to allow?
- What if the input wasn't tainted with `confidential`?
- What if the session was in Execute instead of Plan?

The simulator is read-only — replaying doesn't change anything. It's how you investigate "why did Harbor block this?" without having to read JSON. It's also how you pre-check a policy change before saving it.

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
4. **Is the site in Plan mode by default?** If it's a new origin and you haven't moved it to Execute, every write-tier call will fail with `ERR_PERMISSION_DENIED`. The Sessions tab shows the mode.

If a site is hammering you with prompts, that's almost always a sign the site is asking poorly — broad scopes with vague reasons, or asking for one scope at a time when it should batch. Use the activity feed to identify which scope is coming up most often, then either grant it always (if you trust the site) or write a deny rule (if you don't).

## What you control, summarized

| You can... | Where |
|---|---|
| See every active agent session | Sidebar → Sessions |
| Change a session's mode (Plan / Execute / Watch) | Sidebar → Sessions → Mode dropdown |
| Stop a session immediately | Sidebar → Sessions → Stop, or sidebar header Stop All |
| Restore a contained session | Sidebar → Sessions → Restore, or directly from the containment notice |
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
- **Capability token.** An opaque handle bound to an `(origin, allowedActions, acceptedLabels, budgets, ttl, parentToken)` tuple. The unit of authority a session holds.
- **Containment.** A graduated reduction of a session's authority — implemented as re-minting the capability token with a tighter `allowedActions` set.
- **Data label.** A tag (`credentials`, `payments`, `identity`, `confidential`, `regulated`) attached to data flowing through the agent. Tracked through reads, prompts, and tool calls; checked at egress.
- **Decision simulator.** A read-only replay tool in the activity feed for investigating why a decision was made and what would change under different conditions.
- **Effect.** One of `metadata`, `read`, `egress`, `write`, `identity`, `destructive`. Drives default UX.
- **Locality.** One of `local`, `same-origin`, `cross-origin`, `remote`. Drives egress treatment.
- **Manifest provenance.** Whether an MCP manifest is trusted (bundled, locally installed, signed, or pinned in policy) — determines whether the engine honors its self-attested sensitivity claims.
- **Origin grant.** A per-site allow/once/deny remembered from a prompt. Lowest-precedence layer; the policy file overrides it.
- **PolicyEngine.** The single function that decides whether to allow, deny, ask, or preview each API call.
- **Policy file.** `harbor-policy.json` v2 — the user's declarative typed rules, merged with managed-storage policies.
- **Sensitivity.** Structural classification (safe / sensitive / destructive) independent of policy. Cannot be lowered by an `allow` rule.
- **Session mode.** `plan`, `execute`, or `watch` — the per-session stance, implemented as a property of the capability token.
- **Sidebar.** Harbor's primary UI surface, where sessions, policy, origins, and activity live.
- **Watchdog.** The background monitor that maintains rolling statistics and label-flow events; triggers containment by re-minting tokens.

---

## FAQ

**Q: I've been using Harbor's older permission API — what do I need to change?**

The internal change is large, but the user-facing API is similar in shape. The biggest concrete differences for site authors:

- `agent.requestPermissions({ scopes: [...] })` is replaced by `agent.requestCapabilities({ require: [...], optional: [...] })` with typed actions.
- `model:prompt` becomes `model.prompt.local` or `model.prompt.remote.thirdParty` — pick the right one for your use case.
- `web:fetch` becomes `network.egress.same_origin` or `network.egress.cross_origin`, with destination-aware policy.
- New error codes (`ERR_BLOCKED_BY_POLICY`, `ERR_LABEL_FLOW_BLOCKED`, `ERR_TOKEN_EXPIRED`) need to be handled in your error path.

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

**Q: How does multi-agent delegation work?**

Each session has a capability token. When the session calls `agent.delegate` to invoke a subagent, it must mint a child token, and the engine enforces strict attenuation: the child's `allowedActions` is a subset of the parent's, the child's `acceptedLabels` is a subset of the parent's, the child's budgets and TTL are bounded by the parent's. A subagent cannot accumulate authority by recursion, and revoking the parent token transitively revokes every descendant.

**Q: Can my organization centrally manage this?**

Yes. Ship a `harbor-managed-policy.json` via Firefox's `policies.json`, Chrome enterprise policies, or your MDM. It loads at the highest precedence and cannot be overridden by user policy or per-origin grants. Use this for company-wide deny rules, trusted-origin allowlists, label-egress restrictions, signed-publisher allowlists, and budget caps.

**Q: Does the LLM-classifier "auto mode" exist for Harbor?**

Not in the initial rollout. Anthropic-style classifier-as-approver is a candidate v2 feature, optionally backed by a local model so it doesn't leak data. For now, the equivalent is a well-tuned typed policy plus the SensitivityEngine plus label-aware egress checks plus the Watchdog. We expect those to be sufficient for most cases without needing a model in the authorization path.

**Q: Where's the empirical evidence?**

Honest answer: not yet. The architecture is grounded by analogy to comparable systems (Cedar / XACML for typed policy, OCAP for capability attenuation, CaMeL for information-flow tracking, Anthropic Auto Mode for graduated containment), but Harbor's specific tier ladder, label set, and watchdog rules need to run on real traffic before we can publish meaningful numbers. The telemetry section above lists what we plan to measure; we expect to publish summary statistics — sensitivity false-positive rate, label-egress block rate, attacker success on a public benchmark before/after containment — once we have a representative window of real-world usage.

---

## See also

- [Security & Privacy spec](../spec/security-privacy.md) — threat model and mitigations.
- [Web Agents API reference](WEB_AGENTS_API.md) — full API surface.
- [Sessions guide](SESSIONS_GUIDE.md) — when to use `window.ai` vs `agent.sessions`.
- [Testing your app](TESTING_YOUR_APP.md) — how the mock harness exposes policy state.
